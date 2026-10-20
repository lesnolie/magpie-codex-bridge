---
name: magpie-web-collab
description: Connect a running Claude Code or Codex agent to an existing ChatGPT Web conversation via the installed ego-browser Skill and the existing Magpie Local Review MCP. Use for brief two-way planning, code review and progress messages, not as a replacement for the agent's execution engine.
---

# Magpie Web Collaboration (Claude Code + Codex)

You are the **local executing agent**. ChatGPT Web is the external planner/reviewer. Keep the existing execution engine: Claude Code stays Claude Code; Codex Desktop, CLI and app-server stay Codex. **ego-browser is only the communication transport.** Do not add another browser bridge, tunnel, MCP server or AI execution process.

## Prerequisites

- The user has installed and authenticated ego (lite), installed its `ego-browser` Skill for this agent, and can open ChatGPT Web there.
- The target ChatGPT conversation URL is supplied by the user **or observed in the active ego-browser page**. Never guess a chat URL from a title, previous task, or another project.
- ChatGPT Web already has the **Magpie Local Review** MCP connector. Its project list currently comes from Codex Desktop's registered workspaces. A Claude-owned working directory must also be represented by the **same** registered project if Magpie is to read and review its files. The browser alone cannot grant Magpie extra filesystem access.
- A local agent must have permission to use ego-browser. If permissions or login are missing, stop and report one specific blocker. Do not recommend bypassing sandbox restrictions as a default.

## Minimal protocol — do not chat for the sake of chatting

1. Run `ego-browser skill` **once per agent session** and follow its printed instructions. On Windows, the executable may be `%USERPROFILE%\.local\share\ego\active_version_dir\ego-browser.exe`.
2. Reuse **one** ego TaskSpace named `magpie-web-collab <AGENT> <PROJECT>` and **one** ChatGPT page `p1`. Use `snapshot()` to read, and `fill()` or `keyboard.insertText()` then the page's verified Send button to post. Check `await page.url()` before **each** send.
3. When joining a **new chat or project**, send **one** short request to ChatGPT Web to verify the exact Magpie project with `projects` and a harmless `read_file`. Do not send source files, access tokens or full diffs through the chat; ChatGPT retrieves evidence from the existing MCP connector. Only continue after the project and target URL match. **Do not repeat this verification on each turn.**
4. Work normally in the local agent. Post to the verified ChatGPT chat **only when needed**: one useful initial goal/plan if necessary, one completed stage with test evidence, or one concrete blocker. ChatGPT's review response should be actionable; treat `PLAN` as continue/repair, `DONE` as final acceptance and `BLOCKED` as a genuine stop.
5. For each browser message use this compact envelope (no ritual acknowledgements):
   ```text
   [MAGPIE] <PLAN|EXECUTED|DONE|BLOCKED>
   PROJECT: <exact Magpie project>
   TASK: <stable task ID>
   RESULT: <one to three useful sentences>
   NEXT: <specific action, only if needed>
   ```
   Preserve the same task ID for a continuing goal. Never ask ChatGPT to reply with only an artificial ACK, and do not require the user to confirm steps that are already authorized.
6. When the tab is generating, loading or retrying, wait for completion and read the response. Do not blindly resend; avoid duplicates. If the observed URL changes, freeze outgoing messages and reverify before continuing. Do not `task.finish()` during a pending round; keep `p1` for the user.

## Which execution mode?

- **Claude Code:** use the Claude agent's native editing/testing tools, and this Skill only for browser messages. The current Magpie MCP does **not** remotely start Claude or collect Claude tasks through a Claude-native tool. It can review work in a registered, allowed project.
- **Codex CLI / TUI:** use native Codex execution plus this Skill and ego-browser for ChatGPT messages. No `codex app-server` is required to operate the browser.
- **Codex app-server:** a Magpie `codex_submit_task` task is an isolated Codex app-server turn, not a Codex Desktop GUI thread. If the submitting tool provides `chatUrl`, use this Skill from inside that turn to send updates via ego-browser. If ego cannot launch in the process sandbox, return `browser-unavailable`; the original MCP task result remains available to ChatGPT.
- **Native Codex Desktop launch from ChatGPT:** continue to use `magpie-codex-collab` and its bundled `chat-session.mjs` for the existing `codex_collab_start` launch ticket, project verification, URL transfer and native thread binding. This general Skill **does not replace** those anti-cross-chat checks.

## Safety and finish

The **same** project and browser-verified chat must be used across a round. Do not silently change authorization scope, push to GitHub, publish or modify an unrelated project. Only the specific user's approved goal grants write permission. Never read cookies/tokens or call undocumented ChatGPT APIs. A browser Send click is **not** proof ChatGPT processed the message; check the page, and report uncertainty truthfully. ChatGPT Web cannot be awakened after the agent's own turn has ended merely by this Skill.
