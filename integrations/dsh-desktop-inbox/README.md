# Optional native DSH Desktop inbox (experimental)

This is an **opt-in Host plugin for DeepSeek Harness Desktop**, not a CLI
launcher and not a second ChatGPT/Magpie server. It uses only:

- the local Magpie MCP endpoint on `127.0.0.1:3425`;
- local-only `agent_register`, `agent_poll` and `agent_ack` tools;
- DSH's official Host `sessionController.prompt` service.

It NEVER accesses Desktop's private WebSocket/cookies, guesses a target DSH
Session, edits a project, or asserts that prompt admission proves execution.

## Prerequisites and deliberate limits

1. An installed Magpie Local Review bridge with `agent_register` supporting
   `resumeExisting` (this PR). The user enables peer messaging locally.
2. DSH Desktop has an active native Session and access to the installed
   `magpie-web-collab` Skill and `ego-browser` for replying to ChatGPT.
3. The user selects the exact **native DSH Session ID** (NOT the Magpie
   `agent_register` sessionId) and exact ChatGPT conversation URL locally.
   This adapter does not discover or select an arbitrary user's conversation.
4. Only one instance of this adapter should own each
   `harness+mode+project+chatUrl` binding. The bridge fails closed when
   multiple registrations match.

This package runs inside DSH Desktop, but Magpie now handles its local opt-in installation and binding. Merely updating Magpie without enabling the local option does not install it.

## Magpie-managed installation (Windows; experimental)

**Do not install this bundle manually.** Update the Magpie Local Review
plugin to v0.4.34-alpha.1 or later. In Magpie's existing settings page, under
**Agent 双向通信 → DSH Desktop 原生自动收件**:

1. Completely quit DSH Desktop (including the notification-area/tray app).
2. Enable the local receiver option, enter the **native DSH Session ID**,
   exact ChatGPT conversation URL and a project label, then save.
3. Magpie copies this bundle into its stable LocalAppData directory and uses
   the **official Desktop-installed** `dsh.cmd plugin --profile desktop add`
   CLI asynchronously; no second plugin configuration surface is required.
4. Check the `projects` tool response under `dshDesktop.install.state`
   for `installed`. If it says `install-failed`, inspect the reason. A
   first-time installation requires the Desktop-installed command from
   DSH Desktop's **Manage dsh Command…** menu; npm's ordinary dsh executable
   cannot manage the Desktop profile.
5. Reopen DSH Desktop after installation. Send a message from ChatGPT with
   `harness:"dsh", mode:"desktop"`, the approved project and chat URL.
   Verify queued → delivered → acked and the ego-browser response before
   assuming automatic collaboration is functioning.

Disabling the receiver in Magpie revokes its local binding; its next poll
stops admitting new prompts. The installed bundle remains inert until locally
re-enabled and Desktop restarted. No browser-session credential is read,
exported or bypassed.

The adapter's `cordis.patch.yml` declares the actual Host plugin row, and
the package manifest declares `dsh.bundle` so official Desktop installation
can activate it. Older v0.4.32/v0.4.33 experimental copies did not declare
these necessary bundle files.

## Delivery semantics and safety

1. Start: `agent_register(resumeExisting:true)`, preserving queued work
   across an ordinary Desktop restart when exactly one matching registration
   exists.
2. Every 3 seconds (configurable 1s–60s): call `agent_poll`.
3. For each message, call official `sessionController.prompt` for the
   **locally configured native DSH Session ID**, with a stable request ID
   derived from the Magpie message ID. Never execute the text in Node.
4. **Only after `prompt` returns `{accepted:true}`:** call `agent_ack`.
   Prompt acceptance means queued, not executed. A failed admission is never
   acknowledged; a failed ack is retried using the same native request ID.
5. The DSH Agent replies through its existing `magpie-web-collab` Skill and
   `ego-browser`. This adapter does not send a fake result to ChatGPT.

If `ctx.sessionController.prompt` is unavailable in the particular DSH
Desktop build, the plugin must remain disabled. No CLI fallback and no use
of Desktop internal browser-session credentials.

## Validation

```bash
node --test test/dsh-desktop-inbox.test.mjs test/peer-messages.test.mjs
```

**Real-machine acceptance still required:**
- verify the actual DSH profile loads this Host plugin;
- confirm the selected native Session receives exactly one prompt;
- verify message status moves queued → delivered → acked;
- verify an ego-browser reply arrives in the exact ChatGPT conversation;
- quit/restart Desktop and verify pending messages are not duplicated;
- revoke local authorization and confirm no further delivery.

This is a prototype, not yet a claim of unattended production support.
