# Cross-client drivers

Every test in `tests/` speaks to the gateway through the same Node MCP SDK the
gateway itself uses, so an assumption shared by both is invisible to all of
them. These drivers exist to break that symmetry: five independent
implementations, five JSON encoders, five SSE parsers.

They found GW-023 (four SDKs, four different limits on the size of a single SSE
event) on the first run, which no test in this repository could have seen.

| file          | client                                   | what it is                                                     |
| ------------- | ---------------------------------------- | -------------------------------------------------------------- |
| `battery.mjs` | `@modelcontextprotocol/sdk`              | the 13-scenario battery, Node                                  |
| `battery.py`  | `mcp` (Python)                           | the same 13 scenarios                                          |
| `battery.go`  | `github.com/modelcontextprotocol/go-sdk` | the same 13 scenarios                                          |
| `battery.rb`  | `ruby-mcp-client`                        | the same 13 scenarios; a community client, not an official SDK |
| `rust/`       | `rmcp`                                   | **not** the battery — a single-tool size probe, see below      |

`battery-peer.mjs` is the MCP server all of them talk to, through the gateway.
Its nine tools are chosen to be awkward rather than representative: line
separators the JSON spec and JavaScript disagree about (U+2028/U+2029), grapheme
clusters and astral-plane text, a result large enough to cross an SSE event
limit, a tool that reports an error as a result, a tool that throws, a slow tool,
and a result carrying its own `error` field.

`run-battery.mjs` launches the gateway once per output transport (stateful HTTP,
stateless HTTP, SSE), runs one driver against each, and fails if any scenario
fails. CI runs node, python, go and ruby this way.

## The Rust probe

`rust/` is deliberately not a battery driver. It was written to answer one
question behaviourally — whether `rmcp`'s `DEFAULT_MAX_SSE_EVENT_SIZE` applies
the way its source says — because reading a constant is not the same as watching
it apply. It calls one tool and prints the byte count it received:

```bash
cd tests/clients/rust && cargo run --quiet -- http://127.0.0.1:8000/mcp large
```

Promoting it to a fifth battery driver is worthwhile; it is honest to say it is
not one today.
