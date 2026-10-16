# Local Codex integration (v0.4.0 alpha)

Phase 2 adds **opt-in** delegation to a locally installed Codex CLI via the
official app-server protocol over **stdio JSON-RPC**. This is a test
implementation, not an unrestricted computer agent.

## Enable on Windows

1. Install Codex CLI and confirm it works locally with the intended model:
   run 'codex --version' and a simple project Codex session.
2. Update Magpie from this branch (once released). Open **Plugins → Project
   Review**, and add only the specific project directory to approve.
3. Optionally supply an absolute path to the native **codex.exe**. For standard
   npm installations the plugin tries a native Windows Codex executable under
   %APPDATA%\npm\node_modules\@openai\codex\vendor. It intentionally cannot
   spawn a .cmd shim through an unrestricted shell.
4. To use a non-OpenAI model, configure its provider locally in Codex
   config.toml. Optionally set **Model ID** and **Model Provider ID** in the
   Magpie page; these become thread/start.model and modelProvider.
   Never enter API credentials in the plugin page.
5. Turn on **Enable Codex** in the Magpie page. Default mode is a read-only
   sandbox. To modify project files, separately toggle **Allow project
   writes**, which uses workspace-write sandbox mode. The policy is
   approvalPolicy=never; escalation requests are denied.
6. Ensure Cloudflare Access, Magpie and the existing remote adapter work.
   The adapter exposes only six read-only review tools until the local
   Codex permission marker is enabled and recognized.
7. Refresh ChatGPT's tool discovery if the account/workspace can call
   execution-capable MCP tools. Magpie cannot override ChatGPT's own policy.

## Remote tools (local opt-in required)

- codex_submit_task(project, prompt, continueThread?): start a task and
  return a task ID without blocking on model output.
- codex_task_status(project, taskId): state and bounded output.
- codex_task_result(project, taskId): completion result and errors.
- codex_cancel_task(project, taskId): interrupt, then stop its Codex child.

A remote caller cannot choose the executable, model/provider, sandbox, or
working directory. Only one task runs at a time. Each task has a 15-minute
execution limit; agent output is capped at 12,000 characters. The same
project allowlist used by existing review tools applies.

## Protocol lifecycle

codex app-server --listen stdio://
→ initialize → initialized → thread/start (or thread/resume)
→ turn/start → item/agentMessage/delta → turn/completed

The worker starts one app-server process per task. It does NOT automatically
connect to an already-open Codex Desktop conversation. Third-party provider
compatibility depends on the installed Codex version and provider configuration.

## Security and scope

Three permissions matter: ChatGPT MCP policy, Cloudflare Access JWT, and
Magpie's own local opt-in. The Cloudflare gateway advertises execution tools
as non-read-only. They are not disguised as read-only to bypass platform limits.

Codex sandbox restrictions are a defense, not a guarantee that a model cannot
read files which are accessible to the operating system user. Run it using a
minimal-privilege Windows account and disposable test repositories first.

The worker stores a bounded in-memory task history. Job state and thread maps
are lost when the Magpie plugin host restarts, and active tasks may stop.
Remote approval requests are denied rather than automatically accepted.
Desktop mouse/keyboard control and unrestricted shell are out of scope.

## Acceptance tests

Run 'npm run check && npm test'. These tests mock a Codex app-server and the
Cloudflare adapter. They do NOT validate Codex on the user's Windows machine.

For the real Windows acceptance test, disable writes, submit a harmless task
in a disposable authorized project and verify task ID, status and answer.
Then enable writes and request creation of a harmless file in a disposable Git
repository; inspect the Git diff, then confirm that paths outside the
approved project cannot be submitted through Magpie's project selection.
