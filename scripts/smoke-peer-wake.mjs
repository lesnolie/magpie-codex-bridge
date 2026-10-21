import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MagpieProjectReview } from '../index.mjs';

/**
 * Side-effect-free composition check against the real plugin object.
 *
 * This script never enables a real harness launch and never touches the user's
 * real mailbox: it only exercises discovery, queue-only routing, honest
 * refusal, and idempotency. The wake launch path is covered by
 * test/peer-wake.test.mjs and test/peer-wake-routing.test.mjs with stubbed
 * launchers, which is the only safe way to assert it in an automated run.
 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-smoke-'));
const project = path.join(work, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'readme.md'), '# smoke\n');
const codexState = path.join(work, 'codex-state.json');
fs.writeFileSync(codexState, JSON.stringify({ 'local-projects': {
  demo: { name: 'SMOKE', rootPaths: [project] } } }));
process.env.MAGPIE_CHAT_SESSION_DIR = path.join(work, 'chat-sessions');
process.env.MAGPIE_PEER_MAILBOX_DIR = path.join(work, 'peer-messages');

const chat = 'https://chatgpt.com/c/smoke-test-abcdefgh';
const base = { codexStatePath: codexState, codexEnabled: false, remoteAutoStart: false,
  peerMessagingEnabled: true, agentLaunchEnabled: false };

const report = {};
try {
  const off = await MagpieProjectReview({}, base);

  // 1. Wake capability and its harness list are discoverable up front.
  report.peerWake = JSON.parse(await off.tool.projects.execute({})).peerWake;

  // 2. Startup permission off: nothing is invented, and the error names the
  //    exact local switch that would allow a wake.
  const noSession = JSON.parse(await off.tool.agent_message_send.execute({
    harness: 'claude', project: 'SMOKE', chatUrl: chat,
    taskId: 'smoke-1', messageId: 'smoke-msg-1', command: 'REQUEST', message: 'Hello',
  }));
  report.withoutSession = { ok: noSession.ok, error: noSession.error };

  // 3. A harness this build cannot start is refused, never substituted.
  const refused = JSON.parse(await off.tool.agent_message_send.execute({
    harness: 'opencode', project: 'SMOKE', chatUrl: chat,
    taskId: 'smoke-2', messageId: 'smoke-msg-2', command: 'REQUEST', message: 'x',
  }));
  report.unsupported = { ok: refused.ok, error: refused.error };

  // 4. A non-ChatGPT destination is rejected before anything is queued.
  const badUrl = JSON.parse(await off.tool.agent_message_send.execute({
    harness: 'claude', project: 'SMOKE', chatUrl: 'https://evil.test/c/0123456789',
    taskId: 'smoke-3', messageId: 'smoke-msg-3', command: 'REQUEST', message: 'x',
  }));
  report.badUrl = { ok: badUrl.ok, error: badUrl.error };

  // 5. The MCP surface Magpie exposes documents wake control and the exact
  //    harness set, so ChatGPT can plan before promising a wake.
  const send = off.tool.agent_message_send;
  report.surface = {
    toolCount: Object.keys(off.tool).length,
    sendArgs: Object.keys(send.args),
    wakeArgType: send.args.wake.type,
    agentRunHarnesses: off.tool.agent_run.args.harness.description,
  };
} finally {
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(work, { recursive: true, force: true });
}
