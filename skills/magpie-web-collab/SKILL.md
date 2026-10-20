---
name: magpie-web-collab
description: Harness-neutral ChatGPT Web collaboration using the installed ego-browser Skill and Magpie Local Review MCP. For any compatible local agent running in a desktop application, terminal CLI, IDE, or app-server that can actually invoke ego-browser.
---

# Magpie ↔ ChatGPT Web: Harness-neutral collaboration

**Goal:** Let ANY agent harness exchange useful messages with the user's exact ChatGPT Web conversation while keeping its **existing** tools, model, project environment, approvals and task lifecycle. The communication transport is **ego-browser**; this Skill is NOT an execution harness, agent launcher, model provider, replacement MCP server or ChatGPT private API client.

**Compatibility contract:** This is **capability-based**, not a product-name allowlist. Desktop, CLI, IDE and headless app-server agents are eligible ONLY if that specific running agent can (a) load this Skill or equivalent instructions, (b) invoke a local executable/shell tool reaching the **same** authenticated ego-browser runtime, and (c) access a ChatGPT conversation authorized by the user. A branded Desktop app that cannot execute tools, a remote/cloud container isolated from local ego, or a sandbox without browser access cannot be made compatible just by installing a SKILL.md file.

## A single browser transport for all harnesses

1. Run `ego-browser skill` **once per local agent session** and follow its live guide. The executable may be at `%USERPROFILE%\.local\share\ego\active_version_dir\ego-browser.exe` on Windows. Never assume that a CLI flag or skill path works in a different harness without checking.
2. Create/resume a **single** ego TaskSpace named `magpie-web-collab <PROJECT>` and a **single** page `p1` for ChatGPT Web. All participating harnesses targeting the same project should use the same space/page when supported; never create a fresh space for every round. If another agent owns an active turn, coordinate and don't concurrently send into its composer.
3. Use the **exact ChatGPT conversation URL** supplied by the user or **observed in this ego-browser page**. For ChatGPT-initiated MCP handoffs, the exact URL must be supplied by the user because MCP doesn't reveal the current conversation URL. Do not infer it from chat titles, another tab or an older binding. Before **every** send read `await page.url()` and require an exact match.
4. Read via `snapshot()`; compose via `fill()` or `keyboard.insertText()`; click the verified Send control ONCE. Wait for the web reply to finish rather than duplicating on a slow response. If ego asks for authentication/captcha/user control, hand off once and stop; do not bypass controls, scrape credentials or fall back to another browser.
5. **Project check only at initial pairing or when project/conversation identity changes:** ask ChatGPT to verify the intended project's presence with Magpie MCP `projects` and a harmless `read_file`. Then reuse that verified binding. Magpie currently exposes **Codex Desktop registered projects**, so other agents' files must live in an already registered and allowed project for Magpie to read them. This Skill does not extend Magpie's project allowlist.
6. The local harness executes its work with **its own native tools and permissions**. Ask ChatGPT Web for independent planning/review only when useful, with Magpie MCP reading the actual source/diff. Never paste credentials, full source trees or private logs into chat.

## Minimal messages, no confirmation ping-pong

Use a short envelope when crossing the browser:

```text
[MAGPIE] EXECUTED
PROJECT: <exact registered name>
TASK: <stable identifier>
RESULT: <work done + evidence, 1–3 sentences>
NEXT: <specific requested review/next action, if any>
```

`EXECUTED` means a stage is ready for review, not that the user's entire goal is finished. Other permitted statuses are `PLAN` (new instructions or repair), `DONE` (complete), and `BLOCKED` (genuine blocker). Don't send HELLO / ACK / RECEIVED sequences, repeated project checks, empty status messages, or repeated permission questions for already authorized work. Ask once **only** for a genuinely new authorization, such as modifying an unrelated project, changing the destination chat, publishing, escalating privileges or overcoming a real sign-in prompt. ChatGPT replies should include evidence or one actionable next step.

On an intermediate PASS, **continue the original authorized task**. Only declare DONE after the whole original goal is complete. Preserve existing local checkpoints if the harness already implements them; do not replace them with a new duplicate state store.

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
