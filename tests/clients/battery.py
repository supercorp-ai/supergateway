"""The Python half of the cross-client conformance battery.

Runs the same scenarios as ``battery.mjs`` against the same peer, so the two
line up into a matrix. Where this disagrees with the Node driver, two
implementations disagree about the gateway's output — which is the only kind of
defect a single-language suite structurally cannot see.

Usage: python tests/clients/battery.py <url> <http|sse>
"""

from __future__ import annotations

import asyncio
import json
import sys

from mcp import ClientSession
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamable_http_client

SEPARATORS = "before\u2028middle\u2029after"
UNICODE = "a👩‍👩‍👧‍👦b عربى c éèê d 漢字 e 𝔘𝔫𝔦 f"
PLAIN = "plain-result"
import os
BIG_LENGTH = int(os.environ.get("BIG_LENGTH", 1024 * 1024))

WANT_TOOLS = [
    "echo", "large", "plain", "separators", "shadowedError",
    "slow", "throws", "toolError", "unicode",
]

results: list[dict] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append({"name": name, "ok": bool(ok), "detail": detail})


def text_of(res) -> str | None:
    for c in getattr(res, "content", []) or []:
        if getattr(c, "type", None) == "text":
            return c.text
    return None


async def main() -> None:
    url, kind = sys.argv[1], sys.argv[2]
    ctx = sse_client(url) if kind == "sse" else streamable_http_client(url)
    try:
        async with ctx as streams:
            read, write = streams[0], streams[1]
            async with ClientSession(read, write) as session:
                init = await session.initialize()
                info = getattr(init, "server_info", None) or getattr(init, "serverInfo", None)
                record("connect", True, getattr(info, "name", ""))

                try:
                    names = sorted(t.name for t in (await session.list_tools()).tools)
                    record("tools/list", names == WANT_TOOLS, ",".join(names))
                except Exception as e:
                    record("tools/list", False, f"{type(e).__name__}: {e}"[:60])

                for label, tool, expect in (
                    ("plain text", "plain", PLAIN),
                    ("line separators", "separators", SEPARATORS),
                    ("unicode", "unicode", UNICODE),
                ):
                    try:
                        got = text_of(await session.call_tool(tool, {}))
                        record(label, got == expect, "" if got == expect else repr(got)[:60])
                    except Exception as e:
                        record(label, False, f"{type(e).__name__}: {e}"[:60])

                try:
                    got = text_of(await session.call_tool("large", {}))
                    record("1 MB result", len(got or "") == BIG_LENGTH, f"length {len(got or '')}")
                except Exception as e:
                    record("1 MB result", False, f"{type(e).__name__}: {e}"[:60])

                try:
                    res = await session.call_tool("toolError", {})
                    record("tool error stays a result", getattr(res, "is_error", getattr(res, "isError", None)) is True,
                           f"isError={getattr(res, 'isError', None)}")
                except Exception as e:
                    record("tool error stays a result", False, f"threw {type(e).__name__}"[:50])

                try:
                    res = await session.call_tool("throws", {})
                    record("throwing tool reported",
                           getattr(res, "is_error", getattr(res, "isError", None)) is True or bool(text_of(res)),
                           f"isError={getattr(res, 'isError', None)}")
                except Exception as e:
                    record("throwing tool reported", True, f"rejected {type(e).__name__}"[:40])

                try:
                    args = {
                        "text": UNICODE,
                        "number": -0.5,
                        "flag": False,
                        "nested": {"a": [1, None, True], "b": {"c": SEPARATORS}},
                    }
                    got = json.loads(text_of(await session.call_tool("echo", args)) or "{}")
                    record("arguments round trip", got == args, json.dumps(got, ensure_ascii=False)[:70])
                except Exception as e:
                    record("arguments round trip", False, f"{type(e).__name__}: {e}"[:60])

                try:
                    loop = asyncio.get_running_loop()
                    started = loop.time()
                    got = text_of(await session.call_tool("slow", {}))
                    record("slow call completes", got == "slow-done",
                           f"{int((loop.time() - started) * 1000)}ms")
                except Exception as e:
                    record("slow call completes", False, f"{type(e).__name__}: {e}"[:60])

                try:
                    res = await session.call_tool("shadowedError", {})
                    record("result with an error field", text_of(res) == "ok", repr(text_of(res))[:50])
                except Exception as e:
                    record("result with an error field", False, f"{type(e).__name__}: {e}"[:60])

                try:
                    got = await asyncio.gather(
                        *[session.call_tool("plain", {}) for _ in range(5)]
                    )
                    record("5 concurrent calls", all(text_of(r) == PLAIN for r in got), f"{len(got)} replies")
                except Exception as e:
                    record("5 concurrent calls", False, f"{type(e).__name__}: {e}"[:60])

                try:
                    res = await session.call_tool("noSuchTool", {})
                    record("unknown tool errors", bool(getattr(res, "is_error", getattr(res, "isError", None))),
                           f"isError={getattr(res, 'isError', None)}")
                except Exception as e:
                    record("unknown tool errors", True, f"rejected {type(e).__name__}"[:40])
    except Exception as e:
        detail = f"{type(e).__name__}: {e}"
        subs = getattr(e, "exceptions", None) or []
        while subs:
            inner = subs[0]
            detail = f"{type(inner).__name__}: {inner}"
            subs = getattr(inner, "exceptions", None) or []
        record("connect", False, detail[:140])

    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
