---
name: magpie-web-collab
description: Harness-neutral ChatGPT Web collaboration using the installed ego-browser Skill and Magpie Local Review MCP. For any compatible local agent running in a desktop application, terminal CLI, IDE, or app-server that can actually invoke ego-browser.
---

# Magpie ↔ ChatGPT Web: Harness-neutral collaboration

**Goal:** Complete the **return communication leg** of a two-channel
collaboration system while preserving the agent's original harness, native
execution and permissions:

- **Inbound control:** `ChatGPT Web → Magpie MCP → locally authorized harness`.
  MCP dispatches starts/continuations, requests status/results and governs
  the adapter lifecycle. **This Skill does not implement the inbound MCP
  adapter.** Currently Magpie's remote task/launch tools target Codex only.
- **Outbound interaction:** `running harness → ego-browser → ChatGPT Web`.
  This Skill makes an already-running, capable agent send messages and read
  replies in the exact verified ChatGPT conversation.

Do not treat the browser return path as a replacement for MCP, imply that an
agent can be launched from Web because its Skill is installed, or build a new
MCP server/tunnel/agent process inside this Skill.

**Compatibility contract:** This is **capability-based**, not a product-name allowlist. Desktop, CLI, IDE and headless app-server agents are eligible ONLY if that specific running agent can (a) load this Skill or equivalent instructions, (b) invoke a local executable/shell tool reaching the **same** authenticated ego-browser runtime, and (c) access a ChatGPT conversation authorized by the user. A branded Desktop app that cannot execute tools, a remote/cloud container isolated from local ego, or a sandbox without browser access cannot be made compatible just by installing a SKILL.md file.

## A single browser transport for all harnesses

1. Run `ego-browser skill` **once per local agent session** and follow its live guide. The executable may be at `%USERPROFILE%\.local\share\ego\active_version_dir\ego-browser.exe` on Windows. Never assume that a CLI flag or skill path works in a different harness without checking.
2. Create/resume a **single** ego TaskSpace named `magpie-web-collab <PROJECT>` and a **single** page `p1` for ChatGPT Web. All participating harnesses targeting the same project should use the same space/page when supported; never create a fresh space for every round. If another agent owns an active turn, coordinate and don't concurrently send into its composer.
3. Use the **exact ChatGPT conversation URL** supplied by the user or **observed in this ego-browser page**. For ChatGPT-initiated MCP handoffs, the exact URL must be supplied by the user because MCP doesn't reveal the current conversation URL. Do not infer it from chat titles, another tab or an older binding. Before **every** send read `await page.url()` and require an exact match.
4. Read via `snapshot()`; compose via `fill()` or `keyboard.insertText()`; click the verified Send control ONCE. Wait for the web reply to finish rather than duplicating on a slow response. If ego asks for authentication/captcha/user control, hand off once and stop; do not bypass controls, scrape credentials or fall back to another browser.
5. **Automatically perform project pairing once per new project/chat identity**, with no separate human confirmation round: the first useful browser message asks ChatGPT Web to check the exact registered Magpie MCP `projects` entry and a harmless `read_file` while addressing the actual task. Once the matching project/chat is verified, continue directly; do not repeat the check every iteration or ask for an ACK. A mismatch is a blocker, not a reason to guess another project. Magpie currently exposes Codex Desktop registered projects; this Skill cannot extend its allowlist.
6. The local harness executes its work with **its own native tools and permissions**. Ask ChatGPT Web for independent planning/review only when useful, with Magpie MCP reading the actual source/diff. Never paste credentials, full source trees or private logs into chat.

## Automatic task-and-review loop (the default)

**Once the user has authorized a goal, KEEP GOING through the full goal.**
No HELLO/ACK/RECEIVED ping-pong; no repeating “may I continue?”;
no separate approval for each stage, code change or ChatGPT review inside
the already authorized project/permissions. This is an active agent-turn
workflow, NOT a persistent daemon or promise to run after the agent stops.

1. **Join once:** Read the live ego-browser Skill instructions, resume the
   same browser page and confirm its exact URL. Pair the project once when
   starting a different project/chat; do this as part of a useful task
   message, not a standalone ritual. Treat chat/project mismatch as BLOCKED.
2. **Execute autonomously:** The native harness plans, edits, tests and
   examines results under the user's original scope and existing local
   approval policy. Do not wait for ChatGPT to approve routine intermediate
   steps. Run safe, reversible steps before requesting a review.
3. **Send only meaningful checkpoints:** After a coherent change, decision
   needing independent judgment, or genuine blocker, send one short
   `EXECUTED` message to the already verified ChatGPT conversation through
   ego-browser. Give a task ID and evidence pointers; ChatGPT uses Magpie MCP
   to inspect actual source/diff. Do not dump files or whole logs in chat.
4. **Automatically read and act:** Wait for the ChatGPT response to finish
   using the documented ego page capabilities; read the *new response*, not
   the entire old thread again when the browser interface allows it.
   Interpret the message by meaning, not a compulsory magic keyword:
   - **Accepted + work remains:** proceed with the next already authorized
     step of the original goal, even if ChatGPT omitted the word PLAN.
   - **Specific defect or change request:** apply it using native harness
     tools, test, then send the next meaningful EXECUTED checkpoint.
   - **Final acceptance + original goal fully complete:** send at most one
     final DONE (only if useful), record final state and stop.
   - **Real missing permission, browser error, conflicting requirements or
     changed destination:** report BLOCKED with exactly the needed user
     action; don't claim autonomous continuation past the blocker.
5. **Repeat steps 2–4 within the same running agent turn** until the full
   authorized goal is complete or genuinely blocked. Intermediate passing
   tests and successful review are *not* final DONE if authorized steps
   remain. Do not impose an arbitrary “two rounds only” limit, but detect
   repeated identical replies/no-progress cycles and stop with a precise
   blocker rather than flooding the chat or burning tokens.
6. **Deduplicate and preserve context:** Track the active project, original
   goal, task ID, last processed reply, and completed checkpoint locally
   using the harness's existing state/checkpoint mechanism (for native
   Codex Desktop, continue using `chat-session.mjs`). One browser Send
   attempt must not become two due to a timeout. Never process old messages
   as new orders or send into the wrong chat. Continue existing work on an
   intermediate PASS; do not spawn an additional agent/thread to resume it.

### Brief browser message

```text
[MAGPIE] EXECUTED
PROJECT: <registered project>
TASK: <stable task ID>
RESULT: <what changed, what was tested, and where to review>
NEXT: <only an actionable question or next stage, if useful>
```

Use `PLAN` for an actionable review decision or next stage, `DONE` for
completion of the entire user goal, and `BLOCKED` for a real obstacle.
Structured tags are optional for ChatGPT replies: never demand a
one-word ACK, “approved, continue?” or mechanical handshakes. Avoid
unnecessary browser snapshots; reuse the same page, and focus on newly
returned messages when supported.

**Approval boundary:** No new confirmation for work already covered by the
user's goal and the harness's local permission mode. A new authorization
is still required when expanding to another project, escalating local
permissions, deploying/publishing without prior consent, handling login
or CAPTCHA, or changing the ChatGPT destination. The Skill never overrides
the harness's native approval prompts.

## Native harness adapters (examples, NOT separate protocols)

| Harness | How work executes | How Web communication happens |
| --- | --- | --- |
| Codex Desktop | Native Desktop thread | This ego-browser transport, plus existing `magpie-codex-collab` identity/launch rules |
| Codex CLI / TUI | Native terminal Codex turn | Same ego-browser transport |
| Codex app-server | Codex app-server thread from Magpie `codex_submit_task` | Same transport **when** explicitly configured with `chatUrl` and ego can run; otherwise existing MCP result |
| Claude Code Desktop or CLI | Local Claude Code tools and permissions | Same ego-browser transport if the running session can invoke it |
| Other terminal, IDE or desktop agent | Its existing agent harness | Same ego-browser transport if it can load instructions and invoke ego locally |

For `codex_collab_start`, do **not** replace the native Desktop launch ticket checks and local `chat-session.mjs` guard. They prevent cross-task/project/channel sends. For app-server `codex_submit_task`, the optional `chatUrl` only adds an opt-in browser instruction; it does not change execution transport or guarantee browser access.

## Failure mode

On browser-unavailable, missing capabilities, project mismatch, wrong URL, expired login, or unsupported harness environment: **do not fake a send**. Report one clear reason and preserve the existing task/result path. A successful browser click or queue receipt by itself does not prove ChatGPT read, accepted or responded. The agent must still be actively executing to continue interaction; installing this Skill alone does not create an always-on agent.
