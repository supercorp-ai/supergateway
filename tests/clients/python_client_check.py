"""Drive supergateway with the real Python MCP client.

Every other test in this repository speaks to the gateway through the *Node* SDK
— the same implementation the gateway itself uses. That makes a whole class of
defect invisible: the gateway can emit bytes that are perfectly valid by its own
reader's rules and unreadable to somebody else's.

Issue #91 is the example. A tool result carrying U+2028 is legal JSON and a
legal SSE frame — the stream is split on CR and LF only — but a consumer that
splits lines by Unicode line-terminator semantics, as Python's ``splitlines``
does, cuts the JSON mid-string. No Node client can tell us whether that happens.

So this drives a real Python client end to end and asserts the values survive.
It is deliberately small: connect, list, call, compare. The point is the second
implementation, not the breadth of the checks.

Run:  python tests/clients/python_client_check.py <mode>
      mode: stateful | stateless | sse
"""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys

from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamable_http_client

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PEER = os.path.join("tests", "clients", "separator-peer.mjs")

SEPARATOR_TEXT = "before\u2028middle\u2029after"
PLAIN_TEXT = "before-middle-after"


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def gateway_args(mode: str, port: int) -> list[str]:
    common = ["node", "dist/index.js", "--stdio", f"node {PEER}", "--port", str(port)]
    if mode == "sse":
        return common + ["--outputTransport", "sse"]
    if mode == "stateful":
        return common + ["--outputTransport", "streamableHttp", "--stateful"]
    if mode == "stateless":
        return common + ["--outputTransport", "streamableHttp"]
    raise SystemExit(f"unknown mode {mode!r}")


async def wait_for_listening(proc: subprocess.Popen, deadline: float) -> str:
    """Read the gateway's own output until it says it is listening."""
    seen = ""
    loop = asyncio.get_running_loop()
    while loop.time() < deadline:
        line = await loop.run_in_executor(None, proc.stdout.readline)
        if not line:
            break
        seen += line.decode("utf-8", "replace")
        if "listening" in seen.lower():
            return seen
    raise SystemExit(f"gateway never reported listening:\n{seen}")


async def run(mode: str) -> None:
    port = free_port()
    proc = subprocess.Popen(
        gateway_args(mode, port),
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        await wait_for_listening(proc, asyncio.get_running_loop().time() + 30)
        # The listening line is written before the HTTP server accepts.
        await asyncio.sleep(0.5)

        if mode == "sse":
            ctx = sse_client(f"http://127.0.0.1:{port}/sse")
        else:
            ctx = streamable_http_client(f"http://127.0.0.1:{port}/mcp")

        async with ctx as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as session:
                await session.initialize()

                names = sorted(t.name for t in (await session.list_tools()).tools)
                assert names == ["plain", "separators"], names

                plain = await session.call_tool("plain", {})
                assert plain.content[0].text == PLAIN_TEXT, repr(plain.content[0].text)

                # The one that matters: a legal JSON string containing characters
                # that some line splitters treat as terminators. A truncating
                # consumer fails to parse the frame at all; a corrupting relay
                # delivers the escape as literal text.
                result = await session.call_tool("separators", {})
                got = result.content[0].text
                assert got == SEPARATOR_TEXT, (
                    "tool text altered in transit:\n"
                    f"  expected {SEPARATOR_TEXT!r}\n"
                    f"  received {got!r}"
                )
                assert "\\u2028" not in got, (
                    "separator arrived as literal escape text rather than the "
                    f"character: {got!r}"
                )
        print(f"{mode}: ok — tool values survive a non-Node client")
    finally:
        proc.kill()


if __name__ == "__main__":
    asyncio.run(run(sys.argv[1] if len(sys.argv) > 1 else "stateful"))
