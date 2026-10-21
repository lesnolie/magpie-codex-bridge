/**
 * Optional DSH Desktop Host plugin. Opt-in only: this does not start the CLI,
 * address the Desktop's private HTTP API, or extract browser credentials.
 *
 * Magpie peers enqueue commands. This plugin polls the local Magpie MCP
 * endpoint and admits each command to ONE explicitly selected native DSH
 * Session through DSH's own sessionController.prompt API.
 *
 * An "acked" mailbox message means accepted by the DSH prompt queue,
 * NEVER that the DSH Agent executed it or replied to ChatGPT.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'magpie-dsh-desktop-inbox';

// Only the locally installed Magpie plugin writes this configuration.
// Never take an endpoint, command, or executable path from the remote chat.
export function managedConfigPath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'MagpieLocalReview', 'dsh-desktop-inbox.json');
}
function readManagedConfig() {
  try { return JSON.parse(fs.readFileSync(managedConfigPath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {enabled:false}; throw error; }
}

export const inject = ['sessionController'];

const ENDPOINT = 'http://127.0.0.1:3425/mcp/magpie/tools';
const CHAT_URL = /^https:\/\/chatgpt\.com\/(?:g\/g-p-[\w-]+\/)?c\/[\w-]{8,}\/?$/;
const SAFE_MESSAGE_ID = /^[A-Za-z0-9_.:-]{2,100}$/;

function required(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(label + ' is required');
  }
  return value.trim();
}

export function validateConfig(raw = {}) {
  if (raw.enabled !== true) return { enabled: false };
  const chatUrl = required(raw.chatUrl, 'Exact ChatGPT conversation URL', 600).replace(/\/$/, '');
  if (!CHAT_URL.test(chatUrl)) throw new Error('Invalid ChatGPT conversation URL');
  const nativeSessionId = required(raw.nativeSessionId, 'Native DSH Session ID', 160);
  if (/[\s<>]/.test(nativeSessionId)) throw new Error('Invalid native DSH Session ID');
  const project = required(raw.project, 'Project label', 100);
  if (/[\r\n<>]/.test(project)) throw new Error('Invalid project label');
  const pollIntervalMs = raw.pollIntervalMs === undefined ? 3000 : raw.pollIntervalMs;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000) {
    throw new Error('pollIntervalMs must be between 1000 and 60000');
  }
  return { enabled: true, chatUrl, nativeSessionId, project, pollIntervalMs };
}

export function createLocalMcpTransport({ fetchImpl = globalThis.fetch, endpoint = ENDPOINT } = {}) {
  // Prevent inadvertent remote authorization/credential egress.
  if (endpoint !== ENDPOINT) throw new Error('Only the fixed loopback Magpie MCP endpoint is supported');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  let seq = 0;
  return async (tool, args) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: '2.0', id: ++seq, method: 'tools/call',
          params: { name: 'magpie-codex-bridge_' + tool, arguments: args },
        }),
      });
      if (!response.ok) throw new Error('Local Magpie MCP returned HTTP ' + response.status);
      const envelope = await response.json();
      if (envelope?.error) throw new Error('Local Magpie MCP rejected ' + tool);
      if (envelope?.result?.isError === true) throw new Error('Local Magpie MCP tool failed: ' + tool);
      const block = envelope?.result?.content?.find(x => x?.type === 'text');
      if (!block || typeof block.text !== 'string') throw new Error('Missing Magpie MCP tool result');
      const result = JSON.parse(block.text);
      if (result?.ok === false) throw new Error(result.error || 'Local Magpie MCP tool failed');
      return result;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function createDesktopInbox(raw, {
  controller,
  call = createLocalMcpTransport(),
  schedule = (fn, ms) => setInterval(fn, ms),
  unschedule = handle => clearInterval(handle),
  report = () => {},
  authorized = () => true,
} = {}) {
  const config = validateConfig(raw);
  if (!config.enabled) return { start() {}, async tick() { return { state: 'disabled' }; }, stop() {} };
  if (!controller || typeof controller.prompt !== 'function') {
    throw new Error('DSH Host sessionController.prompt is required');
  }
  let localSessionId = null;
  let interval = null;
  let stopped = false;
  let busy = false;

  async function tick() {
    if (stopped) return { state: 'stopped' };
    if (!authorized()) return { state: 'authorization-revoked' };
    if (busy) return { state: 'busy' };
    busy = true;
    try {
      if (!localSessionId) {
        const session = await call('agent_register', {
          harness: 'dsh', mode: 'desktop', project: config.project,
          chatUrl: config.chatUrl, resumeExisting: true,
        });
        if (typeof session.sessionId !== 'string' || !session.sessionId) {
          throw new Error('Magpie registration returned no sessionId');
        }
        localSessionId = session.sessionId;
        report({ event: 'registered', sessionId: localSessionId });
      }
      const polled = await call('agent_poll', {
        sessionId: localSessionId, chatUrl: config.chatUrl,
      });
      if (!Array.isArray(polled?.messages)) throw new Error('Invalid Magpie poll result');
      let admitted = 0;
      for (const message of polled.messages) {
        if (stopped) break;
        if (!SAFE_MESSAGE_ID.test(message.messageId) || !['REQUEST','RESULT','UPDATE','BLOCKED','DONE'].includes(message.command)) {
          throw new Error('Invalid Magpie queued message');
        }
        // Stable requestId is essential: if Magpie ack fails, retry must not
        // append a duplicate prompt to the native DSH Session.
        const requestId = 'magpie-' + message.messageId;
        const prompt = [
          '[Magpie peer command: ' + message.command + ']',
          'Source: explicitly bound ChatGPT conversation ' + config.chatUrl,
          'Project label: ' + config.project,
          'Task ID: ' + message.taskId,
          'Message ID: ' + message.messageId,
          '',
          String(message.message),
          '',
          'Process this command under the existing DSH Desktop Session permissions.',
          'For meaningful replies, use the installed magpie-web-collab Skill and ego-browser',
          'to return to the exact bound ChatGPT conversation. Never silently switch Harnesses.',
        ].join('\n');
        const accepted = await controller.prompt({
          requestId, sessionId: config.nativeSessionId, mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        }, new AbortController().signal);
        if (accepted?.accepted !== true) throw new Error('DSH Session Controller did not accept prompt');
        await call('agent_ack', {
          sessionId: localSessionId, chatUrl: config.chatUrl, messageId: message.messageId,
        });
        admitted++;
        report({ event: 'admitted', messageId: message.messageId, executionConfirmed: false });
      }
      return { state: 'poll-complete', admitted, sessionId: localSessionId, executionConfirmed: false };
    } catch (error) {
      // On a broken/expired mailbox session, reconnect next tick without
      // acknowledging any unadmitted message. Native requestId deduplicates
      // a previously admitted prompt if the Magpie acknowledgment failed.
      if (/Unknown peer session|expired|chat conversation mismatch/i.test(String(error?.message))) {
        localSessionId = null;
      }
      report({ event: 'error', reason: String(error?.message || error).slice(0, 220) });
      return { state: 'error', reason: String(error?.message || error) };
    } finally {
      busy = false;
    }
  }
  function start() {
    if (interval !== null || stopped) return;
    interval = schedule(() => { void tick(); }, config.pollIntervalMs);
    void tick();
  }
  function stop() {
    stopped = true;
    if (interval !== null) unschedule(interval);
    interval = null;
  }
  return { start, stop, tick, get sessionId() { return localSessionId; } };
}

/** Called only inside DSH Desktop's opted-in Host plugin configuration. */
export function apply(ctx, config = {}) {
  // A bundle with no explicit config adopts the Magpie-managed settings.
  // That allows one local Magpie settings surface to own installation, binding,
  // and revocation without editing the DSH profile by hand.
  const managed = config.enabled === undefined;
  const settings = validateConfig(managed ? readManagedConfig() : config);
  if (!settings.enabled) return;
  const report = entry => {
    if (entry.event === 'error') console.warn('[magpie-dsh-inbox] ' + entry.reason);
  };
  const authorized = () => {
    if (!managed) return true;
    try {
      const live = validateConfig(readManagedConfig());
      return live.enabled && live.chatUrl === settings.chatUrl &&
        live.nativeSessionId === settings.nativeSessionId && live.project === settings.project;
    } catch { return false; }
  };
  const bridge = createDesktopInbox(settings, {
    controller: ctx.sessionController, report, authorized,
  });
  ctx.effect(() => {
    bridge.start();
    return () => bridge.stop();
  }, 'magpie-dsh-desktop-inbox');
}
