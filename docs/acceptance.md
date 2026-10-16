# Acceptance matrix

| Test | State |
| --- | --- |
| Tool registration with JSON Schema | Local unit test |
| Explicit directory allowlist | Local unit test |
| Prevent traversal, symlinks, secret filenames | Local unit test |
| Bounded source reads and literal text search | Local unit test |
| Git status/diff read-only | Local unit test |
| Magpie plugin loaded on user's Windows machine | Pending |
| Correct project path from Windows or WSL | Pending |
| OpenAI Secure MCP Tunnel with authenticated access | Pending (account permissions) |
| ChatGPT Web actual tool invocation | Pending (account permissions) |
| GitHub-only advisor/reviewer | Available via connected GitHub, separately validated in chat |
| Automatic Loop | Not implemented; out of MVP |

Pass criteria for release: read a harmless file and an uncommitted diff from a specifically allowed project in ChatGPT Web, with forbidden paths rejected, *if the account permits custom MCP*. If unavailable, ship as a tested local tool plugin and document GitHub-only mode without claiming full end-to-end success.
