# A real Python MCP server for #85: Python servers reject any request that comes
# before the initialize handshake, and the stateless gateway gives every request
# a fresh one. Works with the `mcp` package 1.x (FastMCP) and 2.x (MCPServer).
try:
    from mcp.server.mcpserver import MCPServer as Server
except ImportError:
    from mcp.server.fastmcp import FastMCP as Server

server = Server("python-peer")


@server.tool()
def add(a: int, b: int) -> str:
    return f"The sum of {a} and {b} is {a + b}."


if __name__ == "__main__":
    server.run()
