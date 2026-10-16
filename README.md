# Magpie ChatGPT Web Provider (experimental migration)

**This branch completely replaces the old Magpie → Codex app-server controller with a Magpie model provider.** The intended path is **official Codex → Magpie provider → authenticated ChatGPT Web-compatible adapter**. Codex itself owns workspace files, shell, Git, its computer-use MCP tools, approvals, and history. There are no `threads`, `resume`, `compact`, `continue` or `status` MCP tools in this version.

## What works now

- Registers provider `chatgpt-web`, model `chatgpt-web/web`, through Magpie's OpenCode-style `config` and `auth.loader` hooks, following [`magpie-muse-web`](https://github.com/JohnWangggg/magpie-muse-web).
- Forwards OpenAI Chat Completions requests **unchanged** to a configurable authenticated adapter, including image message parts, tool definitions and tool results.
- Preserves SSE streams and tool-call responses; provides a session header, only forwards the adapter key to the configured origin, and rejects off-origin/unknown paths.
- Includes test coverage for provider registration, tool-call relay, screenshot/image relay, SSE, unavailable backend and restrictions on HTTP endpoints.

## What does *not* work yet

**No ChatGPT Web browser connector is implemented or bundled.** This is not a working ChatGPT Web subscription model, and the presence of `chatgpt-web/web` in Codex does not mean chatgpt.com has been connected. The plugin intentionally fails closed if the adapter is absent. A compatible, permitted ChatGPT Web backend has not been verified. There is no automatic browser sign-in or cookie harvesting. We do not silently fall back to Codex OAuth or paid OpenAI API.

ChatGPT Web does not publish a general model-provider API. A browser-driven provider may be unreliable and OpenAI's terms restrict automated extraction of service output. Do not assume this plug-in makes all native ChatGPT Web UI, Intelligent UI, apps or cloud tools appear inside Codex.

## Developer test with an explicitly configured adapter

1. Use a separately authorized, locally running **OpenAI Chat Completions-compatible adapter** implementing [the adapter contract](docs/adapter-contract.md). The adapter must support `POST /v1/chat/completions`, regular JSON or streaming SSE, tool calls and actual image content (not `[image]` placeholders).
2. Set `CHATGPT_WEB_ADAPTER_URL=http://127.0.0.1:18721/v1` in the environment launching Magpie (or point it at an HTTPS adapter).
3. Install this branch in Magpie, and run `magpie plugin login chatgpt-web` to supply the **adapter access token** (not a ChatGPT password or cookie).
4. Run `magpie provider test chatgpt-web`, then `magpie codex chatgpt-web/web` after the adapter health and Chat Completions protocol pass.
5. From Codex, test read-only tools first, then a disposable project file change, then a screenshot return from its existing `cua_repl` tool. Do not assume computer use is supported until the real provider loop passes.

**Do not run `codex mcp add magpie-tools` for this architecture.** The agent uses a Magpie *model provider*, not a second Codex MCP client.

## Current acceptance status

| Test | Status |
| --- | --- |
| Provider registration | Automated test |
| JSON, tool-call and image relay | Automated test |
| Streaming responses | Automated test |
| Real Magpie → Codex app on Windows | Not tested |
| Real ChatGPT Web adapter/login | Not implemented |
| Real `cua_repl` screenshot/tool loop | Not tested |
| ChatGPT Web Intelligent UI in Codex | Not supported by this adapter contract |

Run `npm test` and `npm run check` on Node 20+. Previous v0.1 code remains in `main` until the migration is reviewed. This branch is **not a production release**.
