import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

const ERR = (message) => new Error(`Codex app-server: ${message}`);

/**
 * A narrowly scoped Codex app-server JSON-RPC client.
 * Does not change cwd, sandbox, approval policy, or model of an existing thread.
 * One app-server child per Magpie plugin host; Codex owns persisted thread state.
 */
export class CodexAppServer extends EventEmitter {
  constructor({ command = process.env.CODEX_BRIDGE_COMMAND || 'codex', args = ['app-server'], env = process.env, requestTimeoutMs = 12_000 } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.connected = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.jobs = new Map();
  }

  async start() {
    if (this.connected) return this.connected;
    this.connected = this.#launch().catch((e) => { this.connected = null; throw e; });
    return this.connected;
  }

  async #launch() {
    const child = spawn(this.command, this.args, { env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (part) => { stderr = (stderr + part).slice(-2000); });
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
      try { this.#receive(JSON.parse(line)); }
      catch (err) { this.emit('protocolError', ERR(`invalid JSON: ${err.message}`)); }
    });
    const onExit = (code, signal, error) => {
      this.child = null;
      this.connected = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timeout);
        p.reject(error || ERR(`process ended (exit ${code ?? signal}). ${stderr}`));
      }
      this.pending.clear();
      for (const job of this.jobs.values()) if (job.state === 'running') job.state = 'unknown';
    };
    child.once('error', (e) => onExit(null, null, e));
    child.once('exit', (code, signal) => onExit(code, signal));
    // The handshake MUST complete before any application calls.
    await this.#callRaw('initialize', { clientInfo: { name: 'magpie_codex_bridge', title: 'Magpie Codex Bridge', version: '0.1.0' } });
    this.#send({ method: 'initialized', params: {} });
  }

  #send(message) {
    if (!this.child || !this.child.stdin.writable) throw ERR('not running');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #callRaw(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(ERR(`${method} timed out after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.#send({ id, method, params }); }
      catch (err) { clearTimeout(timeout); this.pending.delete(id); reject(err); }
    });
  }

  async call(method, params = {}) {
    await this.start();
    return this.#callRaw(method, params);
  }

  #receive(message) {
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timeout);
      this.pending.delete(message.id);
      if (message.error) p.reject(ERR(`${message.error.message || 'RPC error'} (${message.error.code})`));
      else p.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // Intentionally NEVER auto-approve Codex actions requested by a remote client.
      this.notifications.push({ method: 'approval/blocked', params: { method: message.method } });
      this.#send({ id: message.id, error: { code: -32000, message: 'Interactive approval is not supported by this phase-1 bridge. Use the local Codex UI.' } });
      return;
    }
    if (!message.method) return;
    this.notifications.push(message);
    if (this.notifications.length > 100) this.notifications.shift();
    this.#track(message);
    this.emit('notification', message);
  }

  #track({ method, params = {} }) {
    const threadId = params.threadId;
    if (!threadId) return;
    const job = this.jobs.get(threadId);
    if (!job) return;
    if (method === 'item/completed' && params.item?.type === 'contextCompaction' && job.kind === 'compact') {
      job.compactionItemCompleted = true;
    }
    if (method === 'item/agentMessage/delta' && job.kind === 'turn') {
      job.preview = (job.preview + (params.delta || '')).slice(-3000);
    }
    if (method === 'item/completed' && job.kind === 'turn' && params.item?.type === 'agentMessage') {
      job.preview = String(params.item.text || job.preview).slice(-3000);
    }
    if (method === 'turn/completed') {
      const matched = !job.turnId || !params.turn?.id || job.turnId === params.turn.id;
      if (matched) {
        const status = params.turn?.status || 'unknown';
        job.state = status === 'completed'
          ? (job.kind === 'compact' && !job.compactionItemCompleted ? 'unknown' : 'completed')
          : status === 'interrupted' ? 'interrupted' : 'failed';
        job.turnStatus = status;
        job.updatedAt = new Date().toISOString();
      }
    }
    if (method === 'turn/started' && job.state === 'starting') job.state = 'running';
  }

  async listThreads(limit = 10) {
    const result = await this.call('thread/list', { limit, archived: false });
    return { threads: (result?.data || []).map((t) => ({ id: t.id, name: t.name || t.preview || '', cwd: t.cwd || null, status: t.status || null, updatedAt: t.updatedAt || null })), nextCursor: result?.nextCursor || null };
  }

  async resume(threadId) {
    const result = await this.call('thread/resume', { threadId, excludeTurns: true });
    if (result?.thread?.id !== threadId) throw ERR('resumed thread ID did not match requested thread');
    return { threadId, cwd: result.cwd || result.thread?.cwd || null, model: result.model || null, status: result.thread?.status || null, resumed: true };
  }

  #ensureIdle(threadId) {
    const job = this.jobs.get(threadId);
    if (job && (job.state === 'starting' || job.state === 'running')) throw ERR('this bridge already has an active operation on the thread');
  }

  async compact(threadId) {
    this.#ensureIdle(threadId);
    await this.resume(threadId);
    const job = { threadId, kind: 'compact', state: 'starting', preview: '', updatedAt: new Date().toISOString(), compactionItemCompleted: false };
    this.jobs.set(threadId, job);
    try {
      await this.call('thread/compact/start', { threadId });
      if (job.state === 'starting') job.state = 'running';
      return { threadId, accepted: true, state: job.state, note: 'Compaction is asynchronous. Poll codex_status for completion.' };
    } catch (e) { job.state = 'failed'; job.error = e.message; throw e; }
  }

  async continueThread(threadId, message) {
    this.#ensureIdle(threadId);
    await this.resume(threadId);
    const job = { threadId, kind: 'turn', state: 'starting', preview: '', updatedAt: new Date().toISOString(), turnId: null };
    this.jobs.set(threadId, job);
    try {
      const result = await this.call('turn/start', { threadId, input: [{ type: 'text', text: message }] });
      job.turnId = result?.turn?.id || null;
      if (job.state === 'starting') job.state = 'running';
      return { threadId, turnId: job.turnId, state: job.state, note: 'Codex owns this turn; poll codex_status. The bridge never changes the project directory.' };
    } catch (e) { job.state = 'failed'; job.error = e.message; throw e; }
  }

  async status(threadId) {
    const result = await this.call('thread/read', { threadId, includeTurns: false });
    return { threadId, codexStatus: result?.thread?.status || null, bridgeJob: this.jobs.get(threadId) || null,
      // Bounded agent-message preview and event names; not a complete transcript.
      recentEvents: this.notifications.filter((x) => x.params?.threadId === threadId).slice(-8).map((x) => x.method) };
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.kill();
    this.connected = null;
  }
}
