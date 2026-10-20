# Magpie Local Project Review (v0.4.28 alpha)

## Harness-neutral ChatGPT Web collaboration (preview)

The reusable [`magpie-web-collab` Skill](skills/magpie-web-collab/SKILL.md)
is **not tied to Codex or Claude**. It describes the same minimal
`ego-browser skill` + authenticated ChatGPT Web conversation workflow for
any **local agent harness** that can run the ego-browser executable
(Desktop, CLI, IDE or app-server). The agent keeps its own execution
engine, context, approvals and tools. ChatGPT Web remains the reviewer.

One transport, not one execution engine:

- **Codex Desktop:** continue to launch using `codex_collab_start` and
  `magpie-codex-collab`. They preserve Desktop launch ticket state, native
  thread pairing and project/chat verification. The Web messages already
  travel via ego-browser.
- **Codex CLI / TUI:** invoke the generic `magpie-web-collab` Skill from an
  ordinary interactive Codex session with access to ego-browser.
- **Codex app-server:** `codex_submit_task` still starts the existing
  isolated Codex app-server process. Optionally supply **`chatUrl`** to
  request ego-browser communication from the same turn using
  `magpie-web-collab`; omitting `chatUrl` preserves the current result-only
  MCP workflow. A sandbox or missing Skill may prevent browser access, but
  MCP result retrieval still works.
- **Claude Code or another agent:** install this shared Skill in that
  harness using its native Skill import and ensure the running agent has
  local ego-browser execution permissions. Claude Code's Desktop/CLI
  surfaces can use one protocol if they expose those capabilities. Other
  desktop chat apps without local shell/browser tools cannot automatically
  do so simply by uploading the Skill.

**Important boundaries:** This branch does **not** add a Claude launch
adapter or a general remote process manager. Web-to-local-startup remains
Codex-specific; messages in an **already running** compatible agent session
are two-way via the normal browser conversation. The Magpie MCP
project allowlist still comes solely from **Codex Desktop registered
projects**. For a Claude-only workspace, the user must first register its
root there or a separately user-approved generic project-registry feature
must be built; installing a Skill does not grant filesystem access.

### Minimal web round

1. Read `ego-browser skill` once, reuse a single TaskSpace and ChatGPT
   page, and match its observed URL before every send.
2. Verify Magpie project + harmless file once on first pairing or chat/project
   switch, not on every stage.
3. Send compact `[MAGPIE] EXECUTED` with project, task ID, result/evidence,
   and the next review action; ChatGPT independently checks via Magpie MCP.
   Avoid redundant confirmation and ACK loops.
4. Keep the original authorized goal active across intermediate approvals;
   finish only when the full goal is complete.

`codex app-server` means the **programmatic stdio/JSON-RPC execution
interface**, not the Codex Desktop GUI and not a ChatGPT browser. `Codex CLI`
is the **terminal-facing interactive/batch command-line interface**.
They may use the same Codex model and workspace while exposing different
lifecycle/tooling. **Neither interface replaces ego-browser:** execution
and communication are separate concerns.


## v0.4.26 alpha: simplified plugin page, standalone CLI removed

The plugin page is reduced to what is used day to day: **Codex
collaboration** (allow ChatGPT to start Codex, execution permission with the
same local confirmation, Desktop auto-send) and **remote connection**
(auto-start). The app-server task settings (model, codex.exe path, provider)
moved into a collapsed **Advanced** section. Toggles save immediately;
permission and auto-send are disabled while Codex is off.

The standalone Codex CLI experiment and its local read-only CLI test were
removed entirely (page, `src/local-cli-test.mjs`, the runner script, the CLI
branch of `codex_collab_start` and the Skill's CLI section). Native Codex
Desktop is the only collaboration path. Saved `nativeCollabCliExperimental`
and `nativeCliLocalTestRequest` settings are dropped on the next save and are
ignored by the plugin.


## v0.4.25 alpha: Desktop auto-send matches the real Codex composer

v0.4.24 found the Codex window but always reported `composer-not-matched`.
Codex Desktop's composer is a ProseMirror editor, and Chromium's UI
Automation text for it is not byte-identical to the prefilled prompt:
empty paragraphs are dropped and a line's leading spaces surface as
trailing spaces of the previous line. The Magpie prompt always contains
blank lines, so the old exact comparison could never succeed.

The auto-sender now compares a canonical form on both sides (unified line
breaks, NBSP/zero-width as spaces, collapsed whitespace, trimmed lines,
no empty lines). The unique TASK_ID and LAUNCH_ID still make a different
launch, a placeholder or a partial prefill fail closed.

The Codex window also hosts ChatGPT web views with their own composers and
send buttons. The Send control is therefore searched only inside the
matched composer's own container (never past the web document), identified
by the composer's primary-action design token in any locale, and voice,
dictation and stop controls are never pressed. More than one matching
composer or control returns `ambiguous-target`.

The control is invoked exactly once. When the composer then clears, the
result is `sent-composer-cleared`; otherwise `invoked-unconfirmed`. Neither
confirms Codex execution or ChatGPT chat binding.

Windows regression tests reproduce the observed Chromium readback. An
opt-in live test (`MAGPIE_LIVE_CODEX_DESKTOP_ROOT=<project>`) submits one
harmless prompt to the real Codex Desktop; verified with OpenAI.Codex
26.1013.4894.0.


## v0.4.24 alpha: verified Windows Codex MSIX GUI host

The previous v0.4.23 window discovery correctly reported
`desktop-window-unavailable` even though the user saw the Codex Desktop
composer. Windows MSIX Codex builds may run the **GUI** as
`OpenAI.Codex_...\\app\\ChatGPT.exe`, while `Codex.exe` is a
different process. Matching only Codex.exe therefore misses the GUI.

The experimental Desktop auto-sender now allows `ChatGPT.exe` **only
when the executable path identifies the OpenAI.Codex MSIX package**.
It obtains installed package locations from the current Windows user's
OpenAI.Codex registration and can recognize the strict WindowsApps
OpenAI.Codex package path even when package registration lookup fails.
It never selects an unrelated standalone ChatGPT application.

For Windows app frame hosting, a visible ApplicationFrameHost window is
allowed only if it contains a child HWND belonging to an already approved
Codex process. The full prefilled prompt, single enabled Send control and
one-shot dispatch guards remain mandatory. No blind Enter or independent
CLI fallback. If the package path cannot be verified, the safe diagnostic
`codex-package-host-unverified` is returned.

Windows CI verifies both a legitimate Codex MSIX GUI path and rejection
of unrelated ChatGPT.exe paths. Actual sending and native chat binding still
need a real Codex Desktop read-only test after updating.



## v0.4.23 alpha: discover native Codex Desktop windows by process/HWND

The Windows experimental auto-sender no longer requires the Desktop's window
title to contain "Codex". It enumerates **visible top-level HWNDs**, matches
their owning Codex application process and the helper's Windows session,
then uses UI Automation to compare the **entire** prefilled prompt before
invoking one uniquely verified Send control.

When discovery fails, `autoSubmit` distinguishes:
- `codex-process-not-found`: no permitted Codex process was visible to the helper
- `desktop-session-mismatch`: Codex process exists, but not in the helper's Windows session
- `desktop-window-unavailable`: a Codex process exists in the session, but no visible matching HWND
- `desktop-window-inaccessible`: the HWND exists but UIA could not inspect it

Diagnostics reveal no window title, PID, process path, or private prompt.
The optional sender is still fail-closed and one-shot. A UIA click is **not**
proof of native Codex execution or verified ChatGPT pairing. Actual native
Windows Desktop auto-submit success is **not yet confirmed**.



## v0.4.22 alpha: distinguish native Desktop composer failures

The experimental Windows Desktop auto-send helper now:
- Checks ValuePattern, TextPattern and LegacyIAccessiblePattern for **exact matching** of the full prefilled prompt, including alternate Electron/Chromium accessibility nodes.
- Recognizes a strict allowlist of Send controls and uses UI Automation Invoke or the verified accessible default action (never blind Enter or screen-coordinate clicking).
- Reports fixed privacy-safe `autoSubmit` stages: `window-not-found`, `composer-not-readable`, `composer-not-matched`, `send-control-not-found`, `send-control-disabled`, `send-invoke-unavailable`, `ambiguous-target`, or `uia-error`.
- Never reports native execution or chat binding based on clicking. The local opt-in and one-dispatch-only guarantees remain.

A visible draft that does not send can also be caused by the native Codex app itself disabling the composer. No Windows Desktop behavior has been verified in the user's environment at publication time.



## v0.4.21 alpha: native Desktop launch lifecycle and Project Review cleanup

- A previous `opened_unconfirmed` Desktop launch is never automatically replayed. An explicitly requested **different** task can replace it only after 10 minutes without an active native thread or pending chat transfer. Repeated identical requests remain idempotent.
- A late pairing request for a superseded task is rejected.
- Experimental Desktop auto-submit observes the Windows UI accessibility tree for up to 12 seconds and only invokes a single verified Send button after the exact prompt matches. It supports ValuePattern and TextPattern; absence of a safe match leaves the prompt for manual submission. An invoked button is not proof of Codex execution.
- The per-launch `autoSubmit` diagnostic is persisted and available through `chat_session_status`.
- Removes the obsolete reload-only Project Review project/session-preview panel, generated preview asset and related tests. Native project and session MCP tools remain intact.

This release requires a real Windows Codex Desktop validation before claiming zero-click success. No CLI or app-server fallback is enabled by this change.


A **read-only Magpie MCP tool plugin** for reviewing code produced by a cheaper model in **official local Codex** with ChatGPT Web acting as **advisor/reviewer**. **No ChatGPT Web model provider; no second Codex agent; no browser scraping.** GitHub remains the common source of truth after pushes.



## v0.4.19 alpha: read-only Desktop URI preflight without another launch

`chat_session_status` now includes `desktopUriPreflight` for an existing
native Desktop launch. It reconstructs the EXACT `codex://threads/new`
URI from the launch's **locally saved original goal**, task ID, launch ID,
registered project root and ChatGPT URL, then returns only:

- `valid`, `reason` (`ready`, `url-too-long`, `invalid-project-root`,
  `invalid-prompt`, `uri-construction-error`)
- `uriLength`, `limit`, `promptLength`, and `rootLength`
- `transport` for non-Desktop tickets

Neither the URI, workspace path, ChatGPT URL, nor goal/prompt text is
returned in this added field. The preflight does **not** open Desktop, send a
queue message, change the session record, reset or retry a failed ticket.
The same validation reasons are now safely classified if the URI builder
fails during an explicitly approved future launch. No new MCP tool or
permission is introduced.

A passing preflight does NOT prove the Windows protocol handler ran.
A failed `building-uri` record that preflights successfully should be
investigated as a runtime/host discrepancy, not blindly retried.

## v0.4.18 alpha: diagnosable Windows Desktop dispatch failures

A short `Start-Process codex://threads/new` successfully opened native
Codex Desktop from interactive PowerShell, but the actual Magpie-triggered
full-prompt startup still ended in `dispatch_failed` with a generic
`unexpected-error`. This release does **not** claim that startup is fixed.

After the next **user-approved** failed Desktop launch, both the MCP launch
response and `chat_session_status` provide an allowlisted
`failureCategory`, `failureStage`, `failureCode`, `exitStatus` and
`failureKind`. Error diagnostics cannot disclose the full chat URL,
PowerShell command, local project path, prompt, stdout, or stderr. Windows
exit-code strings, oversize process arguments and output overflow now have
distinct classifications.

The same single explicit retry guard applies: no further launch occurs
without user authorization. `opened_unconfirmed` never means Codex
executed, and no CLI/app-server fallback is performed.

## v0.4.17 alpha: explicitly retry a failed native Desktop launch from ChatGPT Web

Users no longer need to enter Codex Desktop merely to rearm a recorded
`dispatch_failed` ticket. On an explicit user request to retry the SAME
failed startup, invoke `codex_collab_start` with the original
`project`, `goal`, `chatUrl`, `taskId`, and two new fields:
`retryFailed:true` plus `failedLaunchId:"<exact failed UUID>"`.

The backend compares the original task, goal, exact ChatGPT URL, project and
failed Desktop launch ID against the saved local ticket, rotates the launch
UUID under its existing local file lock, and dispatches exactly once.
A normal tool retry remains inert; in-flight, opened, queue and unrelated
tickets cannot be remotely rearmed. A repeated explicit call is idempotent
and does not open another Desktop composer.

This restores **Web control over a confirmed failed dispatch**; it still
does not bypass a native Desktop composer requiring a first manual Send, or
prove automatic GUI execution. Follow the browser-verified Skill handshake.

## v0.4.16 alpha: native Desktop launch failure diagnostics and local recovery

A passing Windows PowerShell `Start-Process codex://threads/new` test proves
only that the URI scheme is installed in the interactive user session.
Magpie now stores a **sanitized categorical failure reason** for native
Desktop dispatch and exposes that category in `chat_session_status`.
No private ChatGPT URL, CLI arguments, stderr or local filesystem path is
included in the diagnostic category.

A `dispatch_failed` ticket is never silently retried from ChatGPT Web.
The user can explicitly rearm **exactly that failed Desktop ticket** locally:

```
node <skill-dir>/chat-session.mjs recover-launch --project "<registered name>" --launch-id "<failed launch UUID>" --task-id "<original task ID>" --chat-url "<exact conversation URL>" --confirm true
```

This rotates the launch UUID, preserves the same task/goal/URL, resets status
to `prepared` and does NOT launch Codex. A single matching
`codex_collab_start` call can then dispatch it. Requests not in
`dispatch_failed`, queue tickets, stale tickets, and conflicting IDs/URL
are rejected. This remains a *recovery and diagnosability improvement*, not
proof that unattended Desktop launch is fixed on a specific host.

## v0.4.15 alpha: native Desktop collaboration overview

**Project Review UI follows v0.4.14's automatic workspace binding:**

- The main collaboration card shows a read-only snapshot of Codex Desktop
  registered projects and **workspace-verified** native-thread bindings.
  Reload Magpie to refresh it. This snapshot does not show the focused window,
  active ChatGPT URL, local paths or thread IDs.
- The standalone `codex exec` diagnostic is now under **Advanced diagnostics**.
  Its manual project picker is intentionally used **only** for that isolated
  one-click diagnostic, and no project is preselected.
- Native Codex Desktop starts from its actual registered workspace. ChatGPT Web
  can omit project only when the **exact supplied** conversation URL uniquely
  matches a previously workspace-verified thread; the web UI cannot infer the
  currently focused Desktop project.
- First pairing and switching ChatGPT conversations still require URL and
  browser-visible project verification. No new ChatGPT or Codex agent is created.

## v0.4.9 alpha: ChatGPT Web initiates native Codex collaboration

**New authenticated MCP tool:** \`codex_collab_start\` (17 tools total). It
opens a first-time **native Codex Desktop** conversation or, only when the
Skill has registered a verified native thread UUID for the same project and
ChatGPT conversation, queues a new instruction to that thread. It does
**not** require \`codex app-server\`; the old task tools are unchanged.

### The critical ChatGPT URL pairing rule

A custom MCP server **does not receive the current ChatGPT Web conversation
URL**. ChatGPT must ask you once for the exact URL of the chat that should
receive the response. The server will NEVER guess this from the ChatGPT title,
another tab, last-used chat URL, or previous project binding. If omitted,
\`codex_collab_start\` returns \`needs_chat_url\` without saving or launching
anything. Only an exact HTTPS \`chatgpt.com/c/...\` conversation URL (or the
supported Project-conversation form) is accepted.

On the FIRST task in a Codex Desktop workspace:

1. Make sure local Magpie → Project Review → **启用 Codex** is enabled and
   its native execution permission is **not read-only**. Cloudflare Access
   and the remote MCP manager must already be connected.
2. In ChatGPT Web, request: "Use Magpie's codex_collab_start for
   tmn-updater, goal: ..., chatUrl: <copy this exact chat link>." This tool
   never accepts a project root path from ChatGPT: only Codex Desktop's
   registered project name.
3. A **Windows** deep link opens Codex Desktop's new-thread composer with
   the installed \`$magpie-codex-collab\` Skill invocation prefilled.
   **Click Send once in Codex Desktop**. The deep link itself DOES NOT
   run the agent, nor does MCP claiming \`opened_unconfirmed\` mean it ran.
4. Native Codex opens exactly the supplied ChatGPT URL in its one ego-browser
   page; ChatGPT verifies the project over Magpie MCP (projects
   + read_file). Only after \`PROJECT_VERIFIED\` may native Codex locally
   activate the chat binding and execute the goal. The old chat is unchanged
   until that verified activation.
5. If native Codex exposes its own thread UUID, the Skill links it locally
   with \`chat-session.mjs link-thread\`. Later ChatGPT starts in the **same
   verified ChatGPT chat** may dispatch \`codex queue --thread ...\` instead
   of opening a new Desktop composer. A successful queue exit means queued,
   NOT received/executed; an unloaded/busy Desktop task might not consume it
   until manually opened. Never automatically retry and start a duplicate.

**Duplicate protection:** Every launch has a persisted local launchId,
taskId, matching ChatGPT URL, goal and state. A retry returns the existing
receipt, not another open/queue action. Different goals/chats cannot overwrite
an in-flight start. Failed dispatches are not retried automatically. Use
native Codex's existing Skill to inspect the pending status and resolve it.

**Limits:** Native Desktop deep-link opening currently targets Windows and
is only verified by mocked CI tests. Actual Codex and browser behavior
requires a Windows machine test. The CLI queue may return success even if
a thread is unloaded or busy; the response deliberately says
\`queued_unconfirmed\`. A fresh task in a different ChatGPT conversation must
first use the existing verified conversation-transfer protocol; a title or
URL guess is not safe. The feature does not automate ChatGPT's private APIs,
bypass Cloudflare Access, or elevate filesystem permissions.

## v0.4.8 alpha: native Codex Skill and verified ChatGPT chat transfer

Magpie Local Review now includes **`skills/magpie-codex-collab/`**, a
self-contained Codex Skill you can import from GitHub using **Magpie Skills**
and assign to **Codex**. This does not require the plugin's `codex app-server`
task runner. Native Codex executes code/tests with its own harness, while
ChatGPT Web plans and reviews using the **existing protected Magpie MCP**.

The Skill tells the native Codex Agent to use **ego-browser** (ego lite,
signed in to ChatGPT) to maintain one dedicated ChatGPT page in a single
TaskSpace; Codex's in-app browser is no longer used. It must stop safely if
ego-browser is not available.
The Skill is an agent workflow, not an independently running browser daemon.

### Stable conversation identity and switching

A standalone zero-dependency Node CLI lives beside the Skill:
`skills/magpie-codex-collab/chat-session.mjs`. It stores the active
ChatGPT **conversation URL**, Codex task ID, generation and bounded execution
checkpoint in `%LOCALAPPDATA%/MagpieLocalReview/chat-sessions` on Windows (the
OS user state directory on Linux). Files are private to the local user and
stored **outside the repository**. Chat URLs are restricted to exact
`https://chatgpt.com/c/...` or Project conversation routes.

The handoff protocol is **prepare → verify workspace + browser URL → activate**.
A pending request NEVER replaces the active chat. The native Codex Skill
verifies that ChatGPT called the correct Magpie MCP project and that the
actual ego-browser page URL matches, then locally activates it. A stale
generation cannot update the new chat's checkpoint. Completed/blocked tasks
can be replaced locally with `prepare --new-task true`. Remote clients
cannot start a different task under the same active binding.

Two additional MCP tools (16 total):
- `chat_session_status`: read active chat, checkpoint, and pending transfer;
- `chat_session_request_transfer`: **request only**, cannot activate a
  different conversation or grant filesystem permissions.

Both are available through the existing Cloudflare Access protected MCP even
when remote Codex execution is disabled. Transfer requests never require
ChatGPT access to your filesystem beyond its existing read-only project tools.

**Native CLI illustration** (the installed Skill supplies the actual path):

~~~shell
node chat-session.mjs status --project "TMN"
node chat-session.mjs prepare --project "TMN" --task-id "tmn.task001" --url "https://chatgpt.com/c/<real-chat-id>"
node chat-session.mjs activate --project "TMN" --request-id "<requestId>" --observed-url "https://chatgpt.com/c/<real-chat-id>" --verified-project "TMN"
node chat-session.mjs handoff --project "TMN"
~~~

The displayed URLs and request IDs above are placeholders; no identifiers
are assumed or invented when running. For a new native Codex task after
the previous task is DONE/BLOCKED, use `prepare --new-task true`.

**Limits:** The local Skill does not control a ChatGPT Web conversation
opened in some unrelated user browser without its direct URL or a new
user-approved binding. It sends a new **user message** through ego-browser,
not a forged assistant response. It cannot send after the
Codex agent has stopped running, and the presence of the Skill does not prove
that ego lite is running and signed in to ChatGPT.
Real-world Windows end-to-end validation is still required before calling
automated ChatGPT wake-up production-ready.

## v0.4.7 alpha: Codex-only projects, one permission selector

**Removed the old Magpie directory authorization system.** The plugin now
reads registered Codex Desktop projects exclusively, even when old saved
options still include manual `roots`, `projectSource: "manual"`, or a
legacy projects.json file. Old manual grants are never used; the bundled
native directory-picker scripts have been removed. Project authorization
fails closed if Codex Desktop's local project registry is absent.

The Magpie Project Review page has one execution-permission selector:
**只读 / 允许修改项目 / 跟随 Codex 本地权限**. The last two choices
require a separate explicit local confirmation. The saved value is the
single `codexPermissionMode` setting, and the backend uses the same
interpretation. Existing `codexAllowWrites` and
`codexInheritPermissions` settings are read for one-time migration, and
are stripped along with old manual directory grants on the next page save.

The Codex task enabled switch, model choice, Cloudflare remote switch and
read-only tool filters remain. Codex project roots are still validated: no
drive root, missing directory or symbolic link is automatically accepted.
For workspaces with multiple folders registered in **one** Codex Desktop
project, workspace-write permissions include the additional validated
folders only. The plugin never grants source-file writes directly to ChatGPT.

**Breaking change:** Users without a Codex Desktop registry must add their
projects in Codex Desktop. The legacy Magpie manual-folder mode is no longer
available. The separate `scripts/manage-projects.cmd` and
`scripts/manage-projects.ps1` helpers are no longer shipped.

## v0.4.6 alpha: Codex Desktop workspace permissions

Previously Local Review used `sandbox: "workspace-write"` or `read-only`
for every task, even when Codex Desktop had a broader local permission
configuration. This could prevent edits, local build/test operations and
multi-folder workspaces that worked from the Codex Desktop UI.

**Default (no new consent):** `使用 Codex 项目` plus `允许 Codex 修改项目文件`
continues to use workspace-write. When a single Codex Desktop project
has multiple validated `rootPaths`, all of that project's workspaces
are passed as additional workspace-write roots for the task. A sibling
project is **not** silently writable. No drive root, symlink or missing
directory is accepted.

**Advanced local opt-in:** `跟随 Codex 本地权限` requires Codex Desktop
project source, write enabled, and a separate explicit local confirmation.
Then Local Review stops forcing an app-server `sandbox` value and lets
the installed Codex CLI resolve its own permissions. The bridge still
uses `approvalPolicy: never` and does not approve escalation requests.
This may expose broader OS filesystem writes if the user's Codex
configuration grants them. It is not enabled automatically and is
revoked when write permission is disabled or manual projects are used.
The selected model and task project are unchanged.

**Limits:** Codex Desktop trust/permission UI and CLI app-server do not
always resolve the same effective policy, especially on Windows. This
does not bypass Windows ACLs, Codex tool restrictions, network sandbox,
project trust, or server-driven approval. For permission-denied errors,
inspect the task's `permissionMode`, `additionalWorkspaceCount`, Codex
CLI version and the affected file/operation. Do not assume that selecting
a project authorizes arbitrary folders or GitHub publishing.

## v0.4.5 alpha: Codex completion handoff and ChatGPT review

The plugin now supports a **review handoff** without giving ChatGPT project
write access. Once Codex has been asked to work, ChatGPT can call
`codex_wait_task` (up to 15 seconds per call) to receive completion **while
the same assistant turn is active**, then call `codex_review_changes` to
inspect the task output and a bounded Git diff against the commit recorded
when the task started. Diff paths use the same source-code/secret filters
as the six existing read-only file tools. Newly untracked files are listed,
not dumped, and can be examined using the existing secure file tools.

Every terminal task also writes a bounded review receipt under the local
current-user profile, outside the repository. A fresh Magpie plugin process
can read receipts through `codex_review_inbox` and
`codex_review_changes`; `projects` reports `pendingReviewCount`.
After **actually** reviewing, ChatGPT may call `codex_ack_review` with
the verdict (`approved`, `changes_requested`, or `no_changes`) and a
brief explanation. Acknowledgement only updates the local receipt and does
not write any project files.

**Important limitation:** An MCP server cannot independently wake ChatGPT,
send a new conversation message, or guarantee a turn stays active until
arbitrarily long Codex tasks complete. Long polling is available only while
the user has an active ChatGPT turn. After the turn ends, the task is
available for review when ChatGPT is used again. There is no silent
background review or unsolicited ChatGPT notification.

**Recommended workflow:** submit → wait repeatedly as appropriate →
review_changes → read_file / git_diff and tests → written review verdict →
ack_review. A review verdict is not proof the code was correct: inspect
actual evidence before approving. If Git was dirty at submission, review
diffs may include unrelated changes; the tool labels attribution as
uncertain. If the initial Git baseline is unavailable, it refuses to invent
one. The new review tools follow the same project allowlist and Codex local
permission switch as the task tools.

## v0.4.4 alpha: Select Magpie provider models without patching Magpie

This release reads **the real provider model catalog** Magpie already serves
to Codex at GET /v1/codex/models on http://127.0.0.1:3425 (default).
When that local Gateway is unavailable, it falls back to the Magpie-written
Codex model catalog in CODEX_HOME/magpie-models.json (~/.codex by default).

The plugin backend refreshes the catalog on startup and once a minute, and
writes only model ID, display name and available effort levels to a data-only
page/model-catalog.js file in its own plugin directory. The Magpie sandboxed
iframe may load its own JS assets but cannot fetch the network or provider
credentials. The **Refresh models** button reloads this snapshot.

**No upstream Magpie patch is required.** Updating Magpie does not remove
this plugin-side integration. It lists only Magpie models shown to the Codex
Agent, not every potentially available vendor model. Codex must have its
model_providers.magpie provider connected (connect it once in Magpie Agents)
for Magpie-hosted models to execute. Selecting a model affects only new Local
Review Codex tasks, not global Codex settings or other users.

If both catalog sources are unavailable, the UI clearly says so and keeps
the advanced manual override. A non-default Gateway port can still use the
Magpie-generated local Codex file. The older optional host patch remains
in docs/magpie-host-models-list.patch but is no longer required.

## v0.4.2: Use Codex Desktop projects directly

In **Magpie → Project Review → 项目来源**, switch on **使用 Codex 项目**.
Magpie then discovers your existing local Codex Desktop projects from the
current user's `CODEX_HOME/.codex-global-state.json` (`~/.codex` by default)
instead of requiring each project folder to be added to the Magpie allowlist.
Multiple folders within one Codex project are exposed separately; missing
folders, drive roots, and invalid/symlink paths are excluded.

The existing six browsing and review tools remain **read-only**. ChatGPT
can review files and issue tasks, but it has **no direct write-file tool**;
**local Codex is the only agent that edits project files**, and only when
you opt in to Codex task execution and project writes in the local Magpie UI.
Switching project sources does not grant write access. Manual project entries
remain stored as a fallback but do not supplement the Codex list when this
mode is selected. Codex Desktop's project registry is read but never modified.

Codex Desktop's JSON project state is not a stable public API. If it is
missing or its schema changes, add the project again in Codex Desktop.
The supported app-server `project/list` endpoint is a future migration path.

## v0.4.1: Codex discovery and managed gateway refresh

The plugin now **always registers the four Codex task tool schemas** in its
local MCP catalog, even before Codex is enabled. This does **not** grant
execution: invoking those tools while the local Codex toggle is off fails.
The Cloudflare gateway independently filters the four task tools unless
the local Codex permission marker exists. Its read-only project/Git tools
remain functional without Codex.

The existing **projects** read-only tool also reports a bounded
`codex` diagnostic object containing `integrationVersion`,
`toolsRegistered`, `localEnabled`, `allowWrites`,
`remoteAutoStart` and `remoteGateEnabled`. No absolute paths,
tokens or model credentials are included.

When updating a plugin-managed Cloudflare adapter, the plugin now reloads
only the known Windows Node manager using its exact script command-line
argument (never all Node processes, nor an unknown listener). This prevents
the old six-tool adapter from remaining in memory indefinitely after an
update. The auto-start toggle is *not* a prerequisite to locally grant
Codex permissions, although an active, authenticated remote listener is
still required for ChatGPT Web to reach it.

**Diagnose "six tools only":** Refresh the plugin and invoke `projects`.
If `codex.localEnabled` is false, enable Codex on your Windows Magpie page;
if `codex.remoteGateEnabled` is false, reload the plugin host to synchronize
the local marker; if both are true but ChatGPT still lists only six tools,
check whether the running gateway is an unmanaged/old instance and whether
your ChatGPT plan/workspace permits non-read-only custom MCP actions.
A GitHub update alone never overrides ChatGPT product permission limits.

## Phase 2: opt-in local Codex app-server tasks (v0.4.0-alpha.1)

Magpie can now submit local Codex tasks, report progress/results and cancel
tasks through the official Codex app-server stdio protocol. This feature is
**OFF BY DEFAULT** and requires enabling Codex on the Magpie plugin page.
Allowing Codex to write to approved projects is a separate local opt-in.
The original six read-only review tools remain available unchanged.

Remote execution also requires an authenticated Cloudflare Access connection
and a ChatGPT account/workspace permitted to call execution-capable custom
MCP tools. This repository cannot grant or bypass ChatGPT's tool permissions.
The local task manager does not control an already-open Codex Desktop window.

See [local Codex integration setup and limitations](docs/codex-integration.md).

## Automatically managed Windows remote MCP (v0.3.4-alpha.3)

For an **already configured Cloudflare Access MCP** connection, Magpie now
provides an opt-in **Project Review → ChatGPT 远程连接 → 自动启动** switch.

When enabled, the plugin host:

- checks for valid existing `%APPDATA%\magpie-local-review\cloudflare-mcp.json`;
- locates Node.js **20+**, installs versioned bundled adapter/manager scripts under
  `%LOCALAPPDATA%\MagpieLocalReview` (outside Magpie's updateable cache);
- registers a **current-user HKCU Run** login-start entry `Magpie Local Review MCP` instead of a Windows Scheduled Task (which failed to create on some user accounts), and launches the manager immediately without an administrator prompt.
- uses a supervisor to wait for Magpie's local gateway (`127.0.0.1:3425`),
  bind the JWT-protected six-tool adapter (`127.0.0.1:48765`) only while
  Magpie is available, avoid interrupting an existing listener, and release
  the bridge when Magpie quits. It does *not* restart Magpie or cloudflared.

One-time opt-in is done through the Magpie plugin UI, **not a PowerShell
command**. Turning the switch off removes only its own HKCU Run entry and an opt-in marker; the supervisor detects the marker change, closes its listener and exits. The supervisor uses a local named-pipe singleton to prevent duplicate managers on plugin reload. No other startup programs, Cloudflare Access settings, project permissions or unrelated tasks are changed. Service status is written to
`%LOCALAPPDATA%\MagpieLocalReview\service-status.json` (local only).

**Lifecycle limitation:** Magpie's community iframe can only save options,
not spawn processes; its Bun/Node plugin host may load lazily. The settings change requests a host reload, but if no host is active, actual HKCU startup registration is deferred until Magpie next loads the plugin tools. The
page therefore shows the *requested preference*, not a verified running
status. For your first real Windows acceptance test, keep the previously
running adapter alive while enabling the toggle and refreshing ChatGPT's
tools. Thereafter the manager should start automatically at the next Windows sign-in.
A successful CI run is not proof that Windows Task Scheduler accepted it.

**Important:** The custom ChatGPT Web MCP endpoint itself cannot remotely
start programs on an otherwise stopped PC. The Windows user must be signed in,
Magpie running, Cloudflare Tunnel connected, and this managed task installed.

## Existing Cloudflare Tunnel adapter (v0.3.3 alpha)

You can reuse a healthy Cloudflare Tunnel and fixed hostname, e.g. `c2c.ilxyz.xyz -> 127.0.0.1:48765`. This release **bundles** `scripts/cloudflare-mcp-adapter.mjs` plus a Windows setup launcher, and forwards only the six read-only project review tools to Magpie on `127.0.0.1:3425`. It rejects requests without a **cryptographically verified Cloudflare Access JWT**. Do **not** publish this without first protecting the entire hostname with a Cloudflare Access app limited to your own identity and enabling Managed OAuth.

**Configuration**: In the plugin's `scripts` folder double-click `setup-cloudflare-mcp.cmd`, provide the Access team domain and app audience, and keep the PowerShell console running for initial verification. It does not change Cloudflare Tunnel routes or resurrect the previous C2C program. See [full Cloudflare configuration, authentication, tests, autostart, and troubleshooting](docs/cloudflare-mcp.md). ChatGPT's HTTPS MCP URL is `https://c2c.ilxyz.xyz/mcp` (use **HTTPS URL**, not OpenAI Tunnel). Windows Magpie tool-host may start lazily; the new opt-in manager registers a persistent logon task once the host loads, rather than relying on tool calls to launch a server for every request.

## Architecture

```text
Local Codex (budget model) ── edits/tests ──> allowed project directory ── git push ──> GitHub
                                              │                                  │
                                       Magpie tool plugin                       │
                                              │                                  │
                                         Magpie MCP                            │
                                              │                                  │
                                       Secure MCP Tunnel*                      │
                                              │                                  │
                              ChatGPT Web (advisor/reviewer) <─────────────────┘
```

*The ChatGPT account/workspace must support connecting custom MCP servers. If not, **use the already-connected GitHub integration** to review committed/pushed branches and PRs. No custom MCP tunnel is required for the GitHub fallback.

## Features (read only)

- `projects`: configured project names; does not expose arbitrary directories.
- `list_files`: list source files and subdirectories.
- `read_file`: read source lines, capped at 64 KiB per source file and 200 lines per call.
- `search_text`: literal text search, bounded by 300 scanned files and 50 matches.
- `git_status`: read uncommitted state (does not stage or commit).
- `git_diff`: read **unstaged diff for a specific existing source file**. Staged changes are visible through GitHub after commit/push; use `git status` to identify them locally.

No arbitrary shell, direct code write, or Git push tools for ChatGPT. Codex task tools are separately permission-gated. The Magpie tools endpoint exposes **all enabled plugins' tools**, not just this one. Turn off unrelated sensitive tool plugins before granting remote access.

## Configure project access (Codex Desktop)

Open the project in Codex Desktop and add its working directory there.
Project Review reads the existing Codex Desktop project registry on the
same machine and shows only validated directories. This is now the **only**
source of project paths. There is no manual folder picker, supplemental
Magpie allowlist, or automatic access to unrelated files.

In Magpie → Plugins → Project Review, enable Codex tasks when needed, then
choose one execution permission:

- **只读:** the default, no project modifications.
- **允许修改项目:** sandboxed writes to the selected Codex Desktop project
  and its additional registered workspace folders.
- **跟随 Codex 本地权限:** delegates sandbox selection to Codex CLI, which
  can grant broader access if configured on the local machine.

Any change from read-only to a write mode requires explicit confirmation.
Disabling Codex clears the stored permission back to read-only. Legacy
option keys are removed on the next save but do not delete or change
your actual Codex Desktop projects. A Windows ACL or a Codex approval
requirement can still prevent an operation.

**Migration:** update the plugin, open its page and save any setting to
remove obsolete manual directory grants. If the older permission flags
are present, their effective mode is shown until you explicitly choose
another mode. There is no need to delete your old project folders.

## Connect ChatGPT Web

1. Check ChatGPT **Plugins** → **Add custom MCP server**. Availability depends on the user's plan/workspace; OpenAI currently documents full custom MCP for Business/Enterprise/Edu and read/fetch custom MCP for Pro, and does not promise access for every Plus account.
2. If this option is available, run Magpie with its tool plugin enabled. Magpie serves local **Streamable HTTP** MCP at `http://127.0.0.1:3425/mcp/magpie/tools` (or the configured Magpie port).
3. Use OpenAI **Secure MCP Tunnel** to connect the local MCP server; do **not** simply expose Magpie's unauthenticated loopback gateway on the public internet. Configure the tunnel's authenticated connection and Magpie gateway key according to official docs. In ChatGPT Plugins, choose Tunnel and the provisioned tunnel ID, or an authenticated HTTPS MCP endpoint.
4. Confirm ChatGPT can list the `magpie-codex-bridge_projects` tool (exact prefix shown in Magpie). First ask it to list projects, read a harmless test Lua file, then inspect an unstaged diff.

Connecting Codex *to* Magpie via `codex mcp add` is **not necessary** for ChatGPT Web to review the local project.

## GitHub fallback (recommended to start)

Have local Codex work on a branch, run tests, and push commits or open a PR. ChatGPT Web can use the already connected GitHub integration to inspect diffs and provide actionable review comments. This works independently of whether custom MCP connectivity is enabled for your ChatGPT account. GitHub does not contain local uncommitted changes; those require an active local MCP connection.

Sample reviewer prompt:

> Review branch/PR against main. Focus on Lua logic, UI regression, performance, correctness and automated-test coverage. Explain each finding with file paths and changed code. Do not edit files unless I explicitly ask. Provide a focused task list for my local Codex to implement.

## Safety and limitations

- Only configured project directories can be referenced. No runtime tool can add or change roots.
- File reads reject absolute and parent-traversal paths, symlinks, secret-looking filenames and binary or oversized files; source extensions only.
- All tool calls are read-only. **This is defense in depth, not a DLP system**: credentials embedded in an ordinary `.lua` or `.js` source file could still be returned; audit folders before enabling remote access.
- `git diff` is limited to unstaged changes of one existing file. No shell commands are accepted from the model.
- A remote ChatGPT Web session is *not* connected just because a plugin loads successfully in Magpie. You must connect the MCP service separately, if your plan/workspace supports it.
- No local Codex app-server integration in this branch. ChatGPT and Codex coordinate through files, Git commits, PRs and optional human-approved task handoffs. Optional web Loop is deferred until the read-only review path works.

## Development

```bash
npm run check
npm test
```

Tests are local Node mocks with a temporary Git repository, and **do not** prove that ChatGPT Web or Magpie on your Windows computer can reach the tools. Mainline publication is subject to real Windows acceptance testing.
