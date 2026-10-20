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

## Intermediate verification is not final DONE

**Track the original authorized user goal, not merely the current review round.**
A passing read-only check, a successful replay, or ChatGPT accepting a test
result verifies that stage; it does **not** automatically complete a wider goal.

Use the existing bridge-compatible controls:
- **PLAN (accepted, continue)**: review passed and the original authorized
  goal still has concrete steps. ChatGPT gives its findings and precise next
  action; Codex records PLAN_RECEIVED and continues. PLAN need not mean a bug.
- **PLAN (repair)**: review found a specific defect; state evidence and fix.
- **DONE (final)**: only if the *entire* user-authorized goal is complete,
  all required acceptance checks pass, and no approved action remains.
- **BLOCKED**: a real blocker, missing permission or required user input.

Do not ask ChatGPT to **"只回复 DONE"** after every review. Ask for
independent evidence-based findings and next steps. Do not limit ChatGPT to a
single-word reply except for explicit one-off identity handshakes. If review
passes but implementation or analysis remains, keep the task active.

This policy deliberately preserves the current CLI protocol. Do **not**
write new checkpoint states (VERIFIED/CONTINUE/COMPLETE) to
`chat-session.mjs`; intermediate acceptance uses PLAN_RECEIVED. Respect
the user's authorization: if proceeding requires a newly authorized write,
report the result and ask rather than silently expanding scope. Never
promise autonomous background continuation without an active Codex turn.

## Capabilities and gate

All ChatGPT Web work goes through **ego-browser** (the ego lite browser, where
the user is already signed in to ChatGPT). Do **not** use Codex's in-app
browser, Chrome, Computer Use or any other browser for this workflow.

Before touching a ChatGPT tab, run `ego-browser skill` once in this session and
follow the guide it prints (the installed ego-browser Skill says the same). On
Windows, if `ego-browser` is not on PATH, use
`%USERPROFILE%\.local\share\ego\active_version_dir\ego-browser.exe`. In
PowerShell, write each round as a new UTF-8 `.mjs` file and run it with
`ego-browser nodejs -e "await import('file:///C:/.../round-01.mjs')"`, as the
guide describes; keep Chinese text inside the file.

- Use exactly **one TaskSpace** named `magpie-codex-collab <PROJECT>` and
  resume it every round with `await taskSpace("magpie-codex-collab <PROJECT>")`
  (names are unique, so this resumes rather than duplicates). Print its
  `spaceId` once.
- Use exactly **one Page, `p1`**, for the ChatGPT conversation. Navigate only
  `p1` with `goto()`; never open a second ChatGPT page. After a transient
  timeout, recover inside the same space and page; never open a new space.
- Read the conversation with `snapshot()`; type into the ChatGPT composer
  with `fill()` (or `keyboard.insertText()` for the rich editor) and press its
  Send button once. Check `await page.url()` before every send.
- Do **not** call `task.finish()` while waiting for ChatGPT or after an
  accepted **intermediate** stage. Only after **final goal DONE** or a genuine
  BLOCKED state call `await task.finish({ keep: ["p1"] })` so the user keeps
  the conversation.
- If ChatGPT asks for sign-in, a captcha or any browser-owned prompt, call
  `await task.handOff()`, set waiting-for USER, and tell the user what to do.
  If the user takes control or the space becomes inactive, stop and wait;
  resume afterwards with `takeOverTaskSpace(<spaceId>)`.

Never call undocumented private ChatGPT APIs, read cookies/tokens, clear
browser state, or impersonate a native assistant reply. If ego-browser is
unavailable (command missing, ego lite not running, or the space cannot be
created), report **browser-unavailable** and leave pending work saved locally.
Do not claim that a notification was sent, and never fall back to another
browser.

The Skill's bundled local CLI is the file named chat-session.mjs **beside this
SKILL.md** in the installed skill directory. Use an absolute path to it when
running node. Node 20+ is required. This file has no external dependencies,
network requests, or browser automation. It uses the same per-user session
directory as the Magpie plugin, not any project files.

## Automatic project selection from native Desktop

**Do not ask the user to select a Magpie project when already working inside
a Codex Desktop workspace.** Native session operations use
`chat-session.mjs status` / `prepare` / `activate` / `link-thread`
without `--project`: the local CLI identifies the currently registered
Codex Desktop workspace from the native process working directory.

Before binding any thread, verify the current native workspace path matches
**exactly one** Codex Desktop registered workspace (or lies within its
verified tree). The local CLI rejects linking a different project's thread.
Never infer project identity from the thread UUID, an unrelated title, or a
previous ChatGPT conversation. For multiple workspaces, use the exact detected
workspace entry, not a guessed display label.

To inspect the current project: `node <skill-dir>/chat-session.mjs status`
(from the actual Codex workspace directory). The result supplies the exact
registered project name for MCP verification. The matching browser-observed
ChatGPT URL and task ID are still required before activation.

**Existing wrong bindings are not migrated automatically.** A historical
thread association without a validated workspace pin is ineligible for
automatic queue selection. If an operator explicitly identifies an erroneous
legacy association, the local CLI can clear only that exact UUID:
`node <skill-dir>/chat-session.mjs unlink-thread --project "<wrong project>" --thread-id "<exact old UUID>"`.
This does not change project source, Git, or the active chat record. Never
run it for a guessed UUID.

From ChatGPT Web, omitting the project works only when the exact supplied
chat URL already maps to ONE workspace-verified native thread. A brand-new
ChatGPT chat cannot reveal the focused Codex Desktop project to MCP and must
first be paired from native Desktop; never silently select the last project.

## Read-only Desktop URI preflight (v0.4.19)

Before explicitly retrying an existing native Desktop launch stuck at
`dispatch_failed`, call Magpie's `chat_session_status` for its exact
project. Read `desktopUriPreflight`, which reconstructs the saved goal's
Desktop URI **only locally** and returns safe character counts plus a
validation category. It never starts Codex, updates a ticket or changes
the conversation. If the URI is too long or invalid, fix the builder
before asking for another retry. If preflight is ready but the previous
record failed at `building-uri`, investigate runtime parity first.
Never copy the full URI or saved goal to a remote diagnostic.

## Windows startup diagnosis (v0.4.18)

If `codex_collab_start` returns `dispatch_failed`, read the current
`chat_session_status` before any further action. The sanitized
`failureStage` is either `building-uri` or `windows-launcher`;
`failureCode`, `exitStatus`, and `failureKind` may identify a spawn,
PowerShell or argument-length failure. Never display raw PowerShell
stderr/stdout or speculate that the native window executed. A working short
user PowerShell URL does not prove the full Magpie launch works.
Do not retry automatically.

## Explicit recovery from ChatGPT Web (v0.4.17)

After a **confirmed `dispatch_failed` native Desktop launch**, ChatGPT Web
can now retry at the user's explicit request by calling `codex_collab_start`
with the exact original `project`, `goal`, `taskId`, `chatUrl`,
`failedLaunchId` plus `retryFailed:true`. Never invent identifiers or
change the destination. The bridge rotates the nonce and performs exactly
one new Desktop dispatch. Ordinary retries and other launch states remain
strictly idempotent. This does NOT auto-press Send in Desktop: verify the
actual native message and browser handshake separately.

The local-only recovery CLI below remains available as a fallback if the
Web remote action is unavailable.

## Safely recovering a failed Desktop launch (local only)

A successful `codex://threads/new?path=...` experiment in interactive
PowerShell validates the Windows protocol registration, **not** the Magpie
host's ability to dispatch the full Skill launch. If a remote launch is
stuck or failed, query Magpie's `chat_session_status` and never assume
Desktop executed.

`dispatch_failed` is terminal for remote retries; use the local-only
`recover-launch` CLI after inspecting the original ticket. Run from the
currently intended Codex Desktop workspace (or pass the exact registered
project) and supply the original **launch ID**, **task ID**, and **ChatGPT
URL**, plus the explicit `--confirm true` flag:

```
node <skill-dir>/chat-session.mjs recover-launch --project "<project>" --launch-id "<original UUID>" --task-id "<original task ID>" --chat-url "https://chatgpt.com/c/<actual conversation>" --confirm true
```

Only a matching **failed Desktop transport** launch can be rearmed. The
command rotates the launch UUID and sets the ticket to `prepared`; it does
NOT start Desktop. The original remote goal and destination remain unchanged.
Afterwards request exactly the SAME project, task ID, chat URL and goal with
`codex_collab_start` ONE time. Remote retries alone cannot recover a
failed launch. Never rerun blindly when the state is still `dispatching`,
`opened_unconfirmed` or `queued_unconfirmed`.

Magpie stores and returns one fixed diagnostic category, never raw
PowerShell stderr or full process invocation. Categories are diagnostic
only; they do not prove the URL handler ran.

## Project validation

Resolve the exact project name from the current native workspace when available, then verify it exists in the Magpie MCP projects tool (it is also the
name Codex Desktop registered locally). A project name is not a ChatGPT title.
Before creating or moving a binding, ask the new ChatGPT conversation to
call the Magpie connector's projects tool and verify the intended project
is listed. Also verify the connector is the same one intended for this workspace.
If the MCP tool cannot be reached, stop; no binding changes.

A task ID must be unique, 2-96 safe alphanumeric/dot/underscore/hyphen/colon
characters. Generate a new task ID for a new task; do not invent an ID for a
continuing checkpoint.

## First launch initiated from ChatGPT Web (v0.4.9)

ChatGPT may now request a native start via **codex_collab_start** in the
connected Magpie Local Review MCP. This action is remotely gated by the same
local Codex enable/write-permission opt-in, and is distinct from
codex_submit_task (which launches app-server instead of the native Desktop).

ChatGPT's MCP tools cannot read the current conversation URL. NEVER infer a
URL from the chat title, old binding, or another open browser tab. The user
must supply the exact current https://chatgpt.com/c/... URL once per new
conversation. Without it, the tool returns needs_chat_url and does nothing.

With a URL, the MCP tool either:
- asks Windows to open **Codex Desktop's composer** via codex://threads/new,
  with a prefilled Skill prompt; the user must press Send ONCE. A successful
  URI handler request is not proof Codex accepted or executed it; or
- when a native Codex thread ID was previously verified and registered
  locally for the SAME project and SAME ChatGPT conversation URL, sends a
  message via codex queue. Successful queue means STORED, not delivered;
  do not retry automatically. A sleeping/unloaded thread may require the
  user to open it in Desktop. Do not fall back to creating a second thread.

When you (native Codex) receive a prompt containing START MODE, TASK_ID,
LAUNCH_ID and TARGET_CHAT:

1. Read local \`chat-session.mjs status --project "<PROJECT>"\`. Require the
   \`launch.taskId\`, \`launch.launchId\` and \`launch.chatUrl\` to match all
   three values in your prompt, and \`launch.status\` to be
   opened_unconfirmed or queued_unconfirmed. If mismatch STOP (it may be an
   outdated/duplicate launch).
2. In the ego-browser TaskSpace, open exactly TARGET_CHAT in page `p1`. Ask that ChatGPT chat to
   call the project list and harmless source read using the intended Magpie
   MCP connector and reply PROJECT_VERIFIED with the exact project name.
   Verify it is the browser-observed chat URL, not a guessed chat title.
3. Run local \`prepare --project ... --task-id ... --url ...\`. If the
   previous chat task completed/blocked and the launch is a new task, use
   \`--new-task true\`. Read its requestId. Activate with actual observed URL,
   requestId and verified project as usual. Do not start coding if the
   project/URL verification did not pass.
4. Once active, when native Codex reliably knows ITS OWN thread UUID
   (\`CODEX_THREAD_ID\`/\`CODEX_SESSION_ID\` or the current supported
   Codex session view), run:
   \`node <skill-dir>/chat-session.mjs link-thread --project "<PROJECT>" --task-id "<TASK_ID>" --generation "<GENERATION>" --thread-id "<NATIVE-CODEX-UUID>"\`
   Do NOT invent the UUID or reuse a different thread. This enables the
   queue fast path for a future ChatGPT-initiated task. If thread ID is
   unavailable, skip queue binding; later launches will open a Desktop composer.
5. Only AFTER pairing, execute the requested goal and run the normal
   ChatGPT Web PLAN / EXECUTED / REVIEW loop. Mark checkpoints and keep
   the single ego-browser page `p1`.

Never claim an unopened URI composer, a stored queue message or an MCP
receipt means a task was executed.

## One-tab workflow

1. Read local state:
   node <skill-dir>/chat-session.mjs status --project "<exact-name>"
2. Run `ego-browser skill` (once per session) and resume the one TaskSpace
   `magpie-codex-collab <PROJECT>`; navigate only page `p1`. Keep it open
   when waiting (no `finish()`), do not close or create duplicate ChatGPT pages.
3. For a first conversation or an explicit new task, use the conversation's
   exact browser-observed URL (https://chatgpt.com/c/... or a Project chat URL).
   node <skill-dir>/chat-session.mjs prepare --project "<exact-name>" --task-id "<id>" --url "<chat-url>"
   This creates only a pending request; it does not authorize the target.
   When starting a NEW task while the previous local task is DONE/BLOCKED,
   add --new-task true explicitly. This override exists only in the local
   CLI; ChatGPT cannot replace an active task remotely.
4. In the ChatGPT conversation ask it to call Magpie projects, identify this
   project and confirm it can use its source-reading tools. Ensure the browser
   still shows the same URL. Never trust chat titles, a guess from a list of
   conversations, or a URL returned by an untrusted file.
5. Activate only AFTER that check. Use the requestId returned by prepare:
   node <skill-dir>/chat-session.mjs activate --project "<exact-name>" --request-id "<uuid>" --observed-url "<browser-observed-url>" --verified-project "<exact-MCP-project-name>"
6. Run Codex's own coding environment. Use short structured control messages
   in ego-browser page `p1`:
   [MAGPIE] STATE: INIT | PLAN | EXECUTED | DONE | BLOCKED
   TASK_ID: ...
   ITERATION: ...
   CHAT_GENERATION: ...
   Neither source code nor secrets/log bodies should be pasted. ChatGPT pulls
   code and diffs through its already connected Magpie MCP tools.
7. After receiving PLAN, execute with native Codex. On EXECUTED, record
   state locally and send one **stage-review** message to verified page `p1`.
   Request independent review of files, diff, test evidence and progress
   against the original authorized user goal; do not demand "only DONE".
   The reply may be **PLAN with accepted findings plus the next step**,
   PLAN with concrete repairs, final DONE, or a specific BLOCKED. For
   accepted intermediate work, checkpoint PLAN_RECEIVED and implement the
   next authorized step. Never mark the whole task DONE just because a
   substep passed its review.
8. Before EVERY outbound message, refresh local status. Send only if the
   taskId, generation and browser-observed URL still match the binding.
   Never send to the previous chat after a transfer. If the tab is loading,
   already generating or showing a retry/error, wait or repair rather than
   resending. While ChatGPT is generating, wait in one round with
   `waitForFunction()` / `waitForSelector()` (the Stop button disappearing)
   instead of fixed sleeps, then read the reply with `snapshot()`. Poll only
   while a real Codex turn is active. Do not claim continuous unattended
   monitoring.

## Checkpoints and transfer

After each stage update the local checkpoint with all required fields:

node <skill-dir>/chat-session.mjs checkpoint --project "<exact-name>" --task-id "<id>" --generation "<generation>" --iteration "1" --protocol-state "EXECUTED_SENT" --waiting-for "GPT_REVIEW" --goal "<short goal>" --progress "<short summary>" --issues "<short issues>" --next-step "<review diff>"

States: INIT, PLAN_RECEIVED, EXECUTING, EXECUTED_LOCAL, EXECUTED_SENT, DONE, BLOCKED.
Waiting for: none, GPT_PLAN, GPT_REVIEW, USER.

Before writing DONE, check that the original authorized user goal is
finished—not merely the current round's verification. For a verified
intermediate step, keep the existing task active, record PLAN_RECEIVED and a
specific nextStep, and only continue during a real Codex turn.

### When the user changes ChatGPT conversations

- If the user changes to a **different window containing the same conversation**,
  restore the saved exact URL in page `p1`. No rebind is needed.
- If page `p1` has navigated to a **new conversation**, do not guess that
  it belongs to the current task. Freeze outgoing messages. Run a new prepare
  for the same taskId and browser-observed new URL. Send a HANDOFF to the
  new conversation (read using the local handoff command) and require
  an independent Magpie MCP workspace verification. Then activate the
  pending request. Do not swap the pointer before verification.
- If the new conversation is **outside page `p1`** (another tab, window or
  device), native Codex cannot discover it automatically. ChatGPT can call the
  Magpie tool chat_session_request_transfer with the exact new URL (supplied
  by the user/browser), project and taskId; it remains pending until native
  Codex can open that URL in page `p1`, verify workspace, and activate.
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
validation that ego lite is running and signed in to ChatGPT.

## Limits

The local assistant cannot push native assistant messages into an arbitrary
ChatGPT thread. It can only submit a clearly user-originated new message
through the supported browser UI after the native browser gate succeeds.
The plugin does not start, own, or control an unrelated Codex Desktop session.
No browser = no automatic Web notification; the project and task state remain
available through Magpie's read-only chat_session_status tool.
