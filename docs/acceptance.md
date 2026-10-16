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
| Native picker writes Windows allowlist and hot-reloads new project selection | Node unit tests pass; Windows GUI acceptance pending |
| OpenAI Secure MCP Tunnel with authenticated access | Pending (account permissions) |
| ChatGPT Web actual tool invocation | Pending (account permissions) |
| GitHub-only advisor/reviewer | Available via connected GitHub, separately validated in chat |
| Automatic Loop | Not implemented; out of MVP |

Pass criteria for release: read a harmless file and an uncommitted diff from a specifically allowed project in ChatGPT Web, with forbidden paths rejected, *if the account permits custom MCP*. If unavailable, ship as a tested local tool plugin and document GitHub-only mode without claiming full end-to-end success.

## Embedded Magpie page v0.3.2 alpha

- `magpie.page` in the plugin manifest registers `page/index.html` under the Plugins sidebar.
- The sandboxed page edits only the plugin's own `options` using `magpie.options.set`. It neither reads arbitrary paths nor connects to a server.
- `rootsSource: magpie-page` supersedes older Windows picker file, including an empty list to revoke all permissions.
- Unit tests cover page manifest, adding a folder, rejecting a drive root, revocation and existing tools.
- **Pending**: user acceptance on real Windows Magpie desktop. A native system folder picker is not available to a sandboxed page; users copy the absolute path using Explorer's address bar.
