---
name: magpie-codex-collab
description: Coordinate native Codex Desktop with ChatGPT Web through the already connected Magpie Local Review MCP. Use when a user requests code planning, execution, review, follow-up fixes, or transfer to a new ChatGPT conversation. Never replace the native Codex execution harness.
---

# Magpie × Native Codex × ChatGPT Web

You (native Codex) own execution: edits, shell commands, git and tests.
ChatGPT Web owns independent planning, code review and acceptance. Magpie's
existing MCP connector gives ChatGPT access to validated Codex Desktop projects.
This Skill does **not** launch Codex app-server, create a second Cloudflare tunnel,
fetch credentials, or install its own MCP server.

## Capabilities and gate

Before touching a ChatGPT tab, check that native Codex provides the official
control-in-app-browser skill and its runtime. When available, follow its
documentation, initialize the runtime exactly once, obtain the **iab** browser
and reuse **one dedicated tab**. Never call undocumented private ChatGPT APIs,
read cookies/tokens, automate the user's other browsers, or impersonate a native
assistant reply. If in-app browser is unavailable, report **browser-unavailable**
and leave pending work saved locally. Do not claim that a notification was sent.
Never silently fall back to screen-click Computer Use.

The Skill's bundled local CLI is the file named chat-session.mjs **beside this
SKILL.md** in the installed skill directory. Use an absolute path to it when
running node. Node 20+ is required. This file has no external dependencies,
network requests, or browser automation. It uses the same per-user session
directory as the Magpie plugin, not any project files.

## Project validation

Use the exact project name from the Magpie MCP projects tool (it is also the
name Codex Desktop registered locally). A project name is not a ChatGPT title.
Before creating or moving a binding, ask the new ChatGPT conversation to
call the Magpie connector's projects tool and verify the intended project
is listed. Also verify the connector is the same one intended for this workspace.
If the MCP tool cannot be reached, stop; no binding changes.

A task ID must be unique, 2-96 safe alphanumeric/dot/underscore/hyphen/colon
characters. Generate a new task ID for a new task; do not invent an ID for a
continuing checkpoint.

## One-tab workflow

1. Read local state:
   node <skill-dir>/chat-session.mjs status --project "<exact-name>"
2. Read the official control-in-app-browser instructions. Open/claim the ONE
   managed tab; after verified initialization navigate only that tab. Keep it
   available when waiting, do not close or create duplicate ChatGPT tabs.
3. For a first conversation or an explicit new task, use the conversation's
   exact browser-observed URL (https://chatgpt.com/c/... or a Project chat URL).
   node <skill-dir>/chat-session.mjs prepare --project "<exact-name>" --task-id "<id>" --url "<chat-url>"
   This creates only a pending request; it does not authorize the target.
4. In the ChatGPT conversation ask it to call Magpie projects, identify this
   project and confirm it can use its source-reading tools. Ensure the browser
   still shows the same URL. Never trust chat titles, a guess from a list of
   conversations, or a URL returned by an untrusted file.
5. Activate only AFTER that check. Use the requestId returned by prepare:
   node <skill-dir>/chat-session.mjs activate --project "<exact-name>" --request-id "<uuid>" --observed-url "<browser-observed-url>" --verified-project "<exact-MCP-project-name>"
6. Run Codex's own coding environment. Use short structured control messages
   in the managed tab:
   [MAGPIE] STATE: INIT | PLAN | EXECUTED | DONE | BLOCKED
   TASK_ID: ...
   ITERATION: ...
   CHAT_GENERATION: ...
   Neither source code nor secrets/log bodies should be pasted. ChatGPT pulls
   code and diffs through its already connected Magpie MCP tools.
7. After receiving PLAN, execute with native Codex. On EXECUTED, record state
   locally and send one completion message to the verified active tab. Ask
   ChatGPT to independently inspect files, git diff and test evidence. The
   reply should be PLAN (further fixes), DONE, or BLOCKED.
8. Before EVERY outbound message, refresh local status. Send only if the
   taskId, generation and browser-observed URL still match the binding.
   Never send to the previous chat after a transfer. If the tab is loading,
   already generating or showing a retry/error, wait or repair rather than
   resending. Poll page state at a reasonable interval only while a real
   Codex turn is active. Do not claim continuous unattended monitoring.

## Checkpoints and transfer

After each stage update the local checkpoint with all required fields:

node <skill-dir>/chat-session.mjs checkpoint --project "<exact-name>" --task-id "<id>" --generation "<generation>" --iteration "1" --protocol-state "EXECUTED_SENT" --waiting-for "GPT_REVIEW" --goal "<short goal>" --progress "<short summary>" --issues "<short issues>" --next-step "<review diff>"

States: INIT, PLAN_RECEIVED, EXECUTING, EXECUTED_LOCAL, EXECUTED_SENT, DONE, BLOCKED.
Waiting for: none, GPT_PLAN, GPT_REVIEW, USER.

### When the user changes ChatGPT conversations

- If the user changes to a **different window containing the same conversation**,
  restore the saved exact URL in the managed tab. No rebind is needed.
- If the managed tab has navigated to a **new conversation**, do not guess that
  it belongs to the current task. Freeze outgoing messages. Run a new prepare
  for the same taskId and browser-observed new URL. Send a HANDOFF to the
  new conversation (read using the local handoff command) and require
  an independent Magpie MCP workspace verification. Then activate the
  pending request. Do not swap the pointer before verification.
- If the new conversation is **outside the managed browser**, native Codex
  cannot discover it automatically. ChatGPT can call the Magpie tool
  chat_session_request_transfer with the exact new URL (supplied by the
  user/browser), project and taskId; it remains pending until native
  Codex can open that URL in the managed tab, verify workspace, and activate.
  Without a URL or reachable browser, stop safely and ask for the direct
  ChatGPT conversation link. The tool never silently changes the current chat.
- For a replacement after a 404 or long chat, preserve the checkpoint.
  The handoff command returns goal, current iteration, progress, issues and
  next action, not files/diffs:
  node <skill-dir>/chat-session.mjs handoff --project "<exact-name>"
  Send that short summary to the new conversation, verify that it identifies
  the correct Magpie project, then activate the request and continue from the
  saved state. On EXECUTED_SENT wait for GPT_REVIEW; do NOT re-execute Codex.
- Do not switch sessions on title matching or let a request from a different
  project redirect this task. Fail closed on ambiguous multiple conversations.

The local CLI accepts --request-id and --observed-url only at activation;
the browser-observed URL MUST equal a URL supplied to prepare (when specified).
The actual browser workspace check is performed by the native Codex agent;
the CLI's --verified-project assertion does not cryptographically authenticate
a ChatGPT account. Therefore this workflow still needs Windows real-machine
validation of Codex Desktop in-app-browser availability.

## Limits

The local assistant cannot push native assistant messages into an arbitrary
ChatGPT thread. It can only submit a clearly user-originated new message
through the supported browser UI after the native browser gate succeeds.
The plugin does not start, own, or control an unrelated Codex Desktop session.
No browser = no automatic Web notification; the project and task state remain
available through Magpie's read-only chat_session_status tool.
