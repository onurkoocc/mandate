# The compiler as an MCP server

`mandate mcp` serves the compiler to agents over the Model Context Protocol
on stdio (design doc 4, §14; `compiler/src/mcp/server.ts`). An agent checks
a program, reads what a diagnostic means, and changes the program with
structural patches, through tools, instead of through a shell.

## Tools

| Tool | Input | Result |
|---|---|---|
| `mandate.check` | `source` (`.mdt` text or JSON IR), `kind?`, `lock?` | `ok`, the program and definition hashes, and the diagnostics with their codes, facts and repair patches |
| `mandate.explain` | `code`, e.g. `E0320` | The code, its title and its explanation |
| `mandate.apply_patch` | `source`, `kind?`, `base` (the program hash the patch was written for), `ops` (RFC 6902 `add`, `remove`, `replace`) | The new program and hash, its diagnostics, the governance changes, and `requires_approval` |
| `mandate.caps_of` | `source`, `name` of an agent or workflow | Its authority, and each of its delegations' grants ([`views.md`](views.md)) |
| `mandate.project` | `source`, `view` (`architecture`, `authority`, `cost`, `diff`), `before?` | A human view; `diff` compares `before` with `source` |
| `mandate.spec` | `section?`, e.g. `4` or `7.2` | The core specification, or one numbered section |

The server only computes:

- It reads no file but the core specification, writes none, and runs
  nothing.
- It holds no credentials.
- A patch's result is returned, never saved.

A patch against a stale base is refused (`MDT-E0130`). A patch that widens
authority, raises a budget, removes a criterion or adds an irreversible
effect is reported as a governance change with `requires_approval: true`
(§13.2). The server cannot grant that approval.

A call a tool cannot serve, such as an unknown code or a program that does
not check, is a tool result with `isError: true`, which the model reads and
acts on. Only a malformed request is a protocol error.

## Protocol

Messages are newline-delimited JSON-RPC 2.0 on stdin and stdout. The server
is dual-era:

- **Modern (MCP `2026-07-28`).** Every request names its protocol version
  in `_meta["io.modelcontextprotocol/protocolVersion"]`.
  - `server/discover` advertises the supported versions, the `tools`
    capability and the server's identity.
  - Results carry `resultType: "complete"` and
    `_meta["io.modelcontextprotocol/serverInfo"]`. `tools/list` carries
    `ttlMs` and `cacheScope`.
  - A version the server does not speak gets `UnsupportedProtocolVersion`
    (`-32022`), with the supported versions.
- **Legacy (`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`).** An
  `initialize` request opens a session for the process, served by the
  negotiated revision.
