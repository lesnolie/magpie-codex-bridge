# Adapter contract (not a ChatGPT Web API)

A provider adapter must be separately implemented and authorized. **Nothing in this repository connects directly to chatgpt.com.**

- URL: HTTPS (or `http://127.0.0.1` / `localhost` / `[::1]` for local adapters), ending in `/v1`.
- Authorization: `Bearer <local adapter token>` from Magpie plugin account configuration; never a ChatGPT session cookie.
- `POST /v1/chat/completions`: standard OpenAI-compatible Chat Completions. Forward `model`, `messages`, `tools`, `tool_choice`, `stream` and all multimodal content. Responses must use `choices[*].message.tool_calls` or SSE `choices[*].delta.tool_calls` with `finish_reason: tool_calls`, as appropriate.
- `GET /v1/models`: optional; no backend available by default.
- `x-chatgpt-web-session`: stable Codex/Magpie session ID for mapping upstream conversation state.
- Error handling: unavailable/incompatible upstream must return a non-2xx error; never return a fabricated successful model completion.
- Computer Use: tool execution remains in official Codex. The adapter must accept actual screenshot/image parts in tool messages and return subsequent structured tool calls. Text placeholders are not sufficient.
- Safety: adapter should require local authentication, enforce allowed tool schemas, respect user approvals and provider rate limits, and avoid forwarding secrets to unexpected origins.

Tests use a local fake adapter; they do not establish that any real ChatGPT Web browser session can satisfy this contract.
