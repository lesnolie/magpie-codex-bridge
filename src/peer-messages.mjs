/**
 * Peer command mailbox: ChatGPT Web -> existing Magpie MCP -> active local agent.
 *
 * Local agents register and poll via Magpie's existing plugin MCP endpoint.
 * The remote Cloudflare MCP allowlist exposes list/status/send only.
 * This is a message handoff, NOT arbitrary process launching or filesystem access.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const MAX_BODY = 4000;
const MAX_MESSAGES = 40;
const MAX_SESSIONS = 50;
const MAX_FILE = 320 * 1024;
const AGE_MS = 24 * 60 * 60 * 1000;
const COMMANDS = new Set(['REQUEST', 'RESULT', 'UPDATE', 'BLOCKED', 'DONE']);
const safeId = (s, limit = 100) =>
  typeof s === 'string' && s.length >= 2 && s.length <= limit &&
  /^[a-zA-Z0-9_.:-]+$/.test(s);

export function normalizePeerChatUrl(value) {
  if (typeof value !== 'string' || value.length > 600) throw Error('Exact ChatGPT chat URL required');
  let u;
  try { u = new URL(value); } catch { throw Error('Invalid ChatGPT chat URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'chatgpt.com' || u.port ||
      u.username || u.password || u.search || u.hash ||
      !/^\/(?:g\/g-p-[\w-]+\/)?c\/[\w-]{8,}\/?$/.test(u.pathname))
    throw Error('Only an exact chatgpt.com conversation URL is allowed');
  return 'https://chatgpt.com' + u.pathname.replace(/\/$/, '');
}

export function peerMailboxDir(env = process.env) {
  const home = process.platform === 'win32'
    ? (env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'));
  return path.join(home, 'MagpieLocalReview', 'peer-messages');
}
function publicSession(s) {
  return {
    sessionId: s.sessionId, harness: s.harness, project: s.project,
    chatUrl: s.chatUrl, registeredAt: s.registeredAt, lastPollAt: s.lastPollAt || null,
    inboxPending: s.messages.filter(m => m.state !== 'acked').length,
    activeRecently: s.lastPollAt ? Date.now() - Date.parse(s.lastPollAt) < 120000 : false,
    note: 'Registered/activeRecently are observations, not proof an agent executed a command.',
  };
}
function validateText(value, field, max = MAX_BODY) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw Error(field + ' must be nonempty and at most ' + max + ' characters');
  return value.trim();
}
export function createPeerMessages({ directory = peerMailboxDir(), now = () => Date.now(),
  uuid = randomUUID } = {}) {
  const folder = path.resolve(directory);
  const index = path.join(folder, 'sessions.json');
  function safeRead() {
    try {
      const stat = fs.statSync(index);
      if (stat.size > MAX_FILE) throw Error('Peer mailbox state too large');
      const d = JSON.parse(fs.readFileSync(index, 'utf8'));
      if (d?.version !== 1 || !Array.isArray(d.sessions)) throw Error('Invalid peer mailbox version');
      return d;
    } catch (e) {
      if (e?.code === 'ENOENT') return { version: 1, sessions: [] };
      throw e;
    }
  }
  function save(state) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const tmp = index + '.' + uuid() + '.tmp';
    try {
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > MAX_FILE) throw Error('Peer mailbox capacity reached');
      fs.writeFileSync(tmp, serialized, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, index);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  function edit(fn) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const lock = index + '.lock';
    let got = false;
    for (let i = 0; i < 100; i++) {
      try { fs.mkdirSync(lock, { mode: 0o700 }); got = true; break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.rmdirSync(lock); } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
    if (!got) throw Error('Peer mailbox is busy');
    try {
      const state = safeRead();
      const output = fn(state);
      save(state);
      return output;
    } finally { fs.rmdirSync(lock); }
  }
  function find(sessions, sessionId, chatUrl) {
    if (!safeId(sessionId)) throw Error('Valid sessionId required');
    const s = sessions.find(x => x.sessionId === sessionId);
    if (!s) throw Error('Unknown peer session');
    if (chatUrl && s.chatUrl !== normalizePeerChatUrl(chatUrl)) throw Error('Chat conversation mismatch');
    return s;
  }
  return {
    register({ harness, project, chatUrl } = {}, agentIdentity = '') {
      const claimed = validateText(harness, 'Harness ID', 80);
      const proj = validateText(project, 'Project label', 100);
      if (!/^[a-zA-Z0-9_.:-]+$/.test(claimed) || /[\r\n<>]/.test(proj))
        throw Error('Invalid harness/project label');
      const url = normalizePeerChatUrl(chatUrl);
      return edit(d => {
        d.sessions = d.sessions.filter(s =>
          now() - Date.parse(s.registeredAt) < AGE_MS
        ).slice(-MAX_SESSIONS + 1);
        const s = { sessionId: uuid(), harness: claimed, project: proj, chatUrl: url,
          registeredAt: new Date(now()).toISOString(), lastPollAt: null,
          agentIdentity: typeof agentIdentity === 'string' ? agentIdentity.slice(0, 80) : '',
          messages: [] };
        d.sessions.push(s);
        return JSON.stringify({ ...publicSession(s), registration: 'local-agent',
          identityVerified: false, instruction: 'Call agent_poll while your harness turn is active.' });
      });
    },
    list() {
      const d = safeRead();
      return JSON.stringify({ sessions: d.sessions.filter(s =>
        now() - Date.parse(s.registeredAt) < AGE_MS
      ).map(publicSession), source: 'locally registered agent sessions',
        limitation: 'A session registration cannot start a stopped Desktop/CLI harness.' });
    },
    send({ sessionId, chatUrl, taskId, messageId, command, message } = {}) {
      if (!safeId(taskId, 96) || !safeId(messageId, 96)) throw Error('taskId and messageId required for safe idempotency');
      if (!COMMANDS.has(command)) throw Error('Unsupported peer command');
      const body = validateText(message, 'Message');
      return edit(d => {
        const s = find(d.sessions, sessionId, chatUrl);
        if (!chatUrl) throw Error('Exact chat URL must be supplied for safe routing');
        if (now() - Date.parse(s.registeredAt) >= AGE_MS) throw Error('Peer registration expired; re-register locally');
        const match = s.messages.find(m => m.messageId === messageId);
        if (match) {
          if (match.taskId !== taskId || match.command !== command || match.message !== body)
            throw Error('messageId already used for different content');
          return JSON.stringify({ sessionId, messageId, state: match.state, reused: true });
        }
        if (s.messages.filter(m => m.state !== 'acked').length >= MAX_MESSAGES)
          throw Error('Peer inbox full: local agent must poll and acknowledge');
        s.messages = s.messages.filter(m => m.state !== 'acked').slice(-MAX_MESSAGES + 1);
        s.messages.push({ messageId, taskId, command, message: body,
          state: 'queued', sentAt: new Date(now()).toISOString(), deliveredAt: null, ackedAt: null });
        return JSON.stringify({ sessionId, messageId, state: 'queued', reused: false,
          confirmedExecution: false });
      });
    },
    poll({ sessionId, chatUrl } = {}) {
      return edit(d => {
        const s = find(d.sessions, sessionId, chatUrl);
        if (!chatUrl) throw Error('Exact chat URL required');
        s.lastPollAt = new Date(now()).toISOString();
        const pending = s.messages.filter(m => m.state !== 'acked').slice(0, 10);
        for (const m of pending) if (m.state === 'queued') {
          m.state = 'delivered'; m.deliveredAt = s.lastPollAt;
        }
        return JSON.stringify({ sessionId, chatUrl: s.chatUrl, messages: pending,
          note: 'delivered means polled, not executed; acknowledge only after processing.' });
      });
    },
    acknowledge({ sessionId, chatUrl, messageId } = {}) {
      return edit(d => {
        const s = find(d.sessions, sessionId, chatUrl);
        if (!chatUrl) throw Error('Exact chat URL required');
        const m = s.messages.find(x => x.messageId === messageId);
        if (!m) throw Error('Unknown message ID');
        if (m.state === 'queued') throw Error('Must poll message before acknowledging');
        if (m.state !== 'acked') { m.state = 'acked'; m.ackedAt = new Date(now()).toISOString(); }
        return JSON.stringify({ sessionId, messageId, state: m.state });
      });
    },
    status({ sessionId, chatUrl, messageId } = {}) {
      const s = find(safeRead().sessions, sessionId, chatUrl);
      if (!chatUrl) throw Error('Exact chat URL required');
      const m = messageId ? s.messages.find(x => x.messageId === messageId) : null;
      return JSON.stringify({ ...publicSession(s),
        ...(messageId ? { message: m ? { messageId: m.messageId, taskId: m.taskId,
          command: m.command, state: m.state, sentAt: m.sentAt,
          deliveredAt: m.deliveredAt, ackedAt: m.ackedAt } : null } : {}),
        executionConfirmed: false });
    },
  };
}
