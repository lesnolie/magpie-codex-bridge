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

## Codex Desktop 项目作为目录来源

项目固定来自 Codex Desktop 已登记的工作区，无需在 Magpie 页面开启。
此模式下，`projects`、`list_files`、`read_file`、`search_text`、
`git_status`、`git_diff` 以及 `codex_submit_task` 都使用相同的
Codex Desktop 已登记项目和目录，不要求在 Magpie 重复授权文件夹。

项目名称、工作目录读取自当前 Windows 用户的 Codex Desktop 状态文件：
`%USERPROFILE%\\.codex\\.codex-global-state.json`（若设置 `CODEX_HOME`
则以该目录为准）。只读取 `local-projects` 和各项目的 `rootPaths`，
不写入或修改 Codex 自身的状态文件；不存在、无效、移走的目录被拒绝或忽略。
一个 Codex 项目可以有多个工作目录，这时列表分别显示各目录。

这是 Codex Desktop 的内部状态格式，可能随其版本变化。目前用于
无需启动 app-server 的项目发现；后续可迁移到支持的 `project/list`
接口。若你的 Codex Desktop 项目记录丢失或格式不同，请切回
「Magpie 手动项目」模式，不要擅自修改 Codex 内部状态。

**权限分工：ChatGPT 不直接写文件。** 六个项目浏览工具始终只读。
ChatGPT 可以提交 Codex 任务，本地 Codex 才能实际执行修改、测试
或 Git 操作。只有在本地启用 Codex 并开启独立的写入权限后，
Codex 才会使用 `workspace-write` 沙盒。项目来源切换不会自动开启写入权限。

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
