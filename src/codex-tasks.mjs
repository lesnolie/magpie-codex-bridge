/**
 * Local Codex app-server client for Magpie. Disabled by default.
 * Each task starts a separate stdio-only process in an explicitly allowed project.
 * No HTTP listener, shell interpolation, remote executable selection or elevation.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { projectRoots } from './projects.mjs';

const MAX_PROMPT = 12000;
const MAX_OUTPUT = 12000;
const MAX_JOBS = 30;
const RUN_LIMIT_MS = 15 * 60_000;

// Diagnostics never return raw stderr: provider URLs, credentials or local paths
// can appear there. Only coarse, pre-defined failure categories are exposed.
export function classifyCodexStderr(stderr = '') {
  const s = String(stderr).toLowerCase();
  if (/unrecognized (subcommand|option)|unexpected argument|unknown (argument|option)/.test(s)) return 'Codex CLI arguments incompatible; verify installed Codex version and app-server support';
  if (/not logged in|authentication|unauthorized|invalid api key|401 /.test(s)) return 'Codex provider authentication failed; verify local Codex credentials';
  if (/provider|model|config\.toml/.test(s)) return 'Codex model/provider configuration failed; inspect local config.toml and Codex CLI';
  if (/permission denied|access is denied|eacces/.test(s)) return 'Codex executable or project access denied by Windows';
  if (/missing|not found|no such file/.test(s)) return 'Codex executable or dependency missing';
  return null;
}


function bounded(value, max = MAX_OUTPUT) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(-max) : text;
}

class RpcProcess {
  constructor(child, onNotification) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    this.closeReason = null;
    this.stderrTail = '';
    this.onNotification = onNotification;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', part => this.consume(part));
    child.stderr?.on('data', part => {
      this.stderrTail = (this.stderrTail + String(part)).slice(-2048);
    }); // Never expose potentially sensitive raw stderr.
    child.once('error', err => this.fail(err));
    child.once('exit', (code, signal) => this.fail(new Error('Codex exited (' + (code ?? signal ?? 'unknown') + ')')));
  }
  consume(part) {
    this.buffer += part;
    if (this.buffer.length > 1024 * 1024) return this.fail(new Error('Codex protocol output too large'));
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && !msg.method) {
        const request = this.pending.get(msg.id);
        if (!request) continue;
        this.pending.delete(msg.id);
        clearTimeout(request.timer);
        if (msg.error) request.reject(new Error(bounded(msg.error.message || 'Codex RPC rejected request', 500)));
        else request.resolve(msg.result);
      } else if (msg.method && msg.id != null) {
        // Never automatically approve escalation or other server-initiated requests.
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Remote approval unavailable; request denied' } });
      } else if (msg.method) this.onNotification(msg);
    }
  }
  send(payload) {
    if (this.closed || !this.child.stdin.writable) throw new Error(this.closeReason?.message || 'Codex connection closed before sending a request');
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }
  notify(method, params = {}) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex RPC timeout: ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
  fail(err) {
    if (this.closed) return;
    this.closed = true;
    const category = classifyCodexStderr(this.stderrTail);
    this.closeReason = category ? new Error(err.message + ': ' + category) : err;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.closeReason); }
    this.pending.clear();
  }
  stop() {
    this.fail(new Error('Codex process stopped'));
    if (!this.child.killed) this.child.kill();
  }
}

export function resolveCodexBinary(options = {}) {
  if (options.codexExecutable) {
    const exe = String(options.codexExecutable).trim();
    if (!isAbsolute(exe) || (process.platform === 'win32' && !/\.exe$/i.test(exe))) {
      throw new Error('Codex executable must be an absolute path to codex.exe');
    }
    return exe;
  }
  if (process.platform === 'win32') {
    const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const npmBinary = join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'vendor', target, 'codex', 'codex.exe');
    if (existsSync(npmBinary)) return npmBinary;
    return 'codex.exe'; // Prefer native binary; Node cannot spawn npm .cmd shims without a shell.
  }
  return 'codex';
}

export function createCodexTasks(options = {}, dependencies = {}) {
  const jobs = new Map();
  const lastThreads = new Map();
  const launch = dependencies.spawn || spawn;
  const roots = dependencies.projectRoots || (() => projectRoots(options));
  // Bad/missing Codex installation must not break the six review tools or
  // MCP tool discovery. Resolve the executable only after local opt-in and submit.
  const binary = () => dependencies.binary || resolveCodexBinary(options);
  const args = dependencies.args || ['app-server', '--listen', 'stdio://'];
  function allowed(project) {
    if (options.codexEnabled !== true) throw new Error('Codex is disabled in local Magpie settings');
    const p = roots().find(x => x.name === project);
    if (!p || !isAbsolute(p.root)) throw new Error('Project is not on the local allowlist');
    return p;
  }
  function lookup(project, taskId) {
    allowed(project);
    const task = jobs.get(taskId);
    if (!task || task.project !== project) throw new Error('Unknown task in this project');
    return task;
  }
  function view(task) {
    return {
      taskId: task.id, project: task.project, state: task.state,
      threadId: task.threadId || null, turnId: task.turnId || null,
      startedAt: task.startedAt, completedAt: task.completedAt || null,
      phase: task.phase || null,
      output: bounded(task.output), error: task.error || null,
    };
  }
  function addOutput(job, delta) {
    if (typeof delta === 'string') job.output = bounded(job.output + delta);
  }
  async function run(job, projectRoot, resumeThreadId) {
    let rpc;
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    const timeout = setTimeout(() => {
      job.error = 'Codex task exceeded the 15-minute safety limit';
      finish({ status: 'failed' });
      rpc?.stop();
    }, RUN_LIMIT_MS);
    try {
      job.phase = 'launch';
      const executable = binary();
      const child = launch(executable, args, {
        cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        windowsHide: true, env: process.env,
      });
      rpc = new RpcProcess(child, msg => {
        if (msg.method === 'item/agentMessage/delta') addOutput(job, msg.params?.delta);
        if (msg.method === 'turn/completed' && msg.params?.threadId === job.threadId &&
            (!job.turnId || msg.params?.turn?.id === job.turnId)) finish(msg.params.turn);
      });
      job.rpc = rpc;
      // An unexpected child exit must also settle the task, not leave it running.
      child.once('error', err => {
        if (job.state !== 'running') return;
        job.error = err.code === 'ENOENT'
          ? 'Codex executable not found by Magpie. Configure an absolute native codex.exe path in Codex settings.'
          : 'Codex startup failed (' + bounded(err.code || err.message, 120) + ')';
        finish({ status: 'failed' });
      });
      child.once('exit', (code, signal) => {
        if (job.state !== 'running') return;
        if (!job.error) job.error = 'Codex terminated (' + (code ?? signal ?? 'unknown') + ')';
        finish({ status: 'failed' });
      });
      job.phase = 'initialize';
      await rpc.request('initialize', {
        clientInfo: { name: 'magpie_codex_bridge', title: 'Magpie Local Agent', version: '0.4.0' },
        capabilities: { experimentalApi: false },
      });
      rpc.notify('initialized');
      const config = {
        cwd: projectRoot,
        approvalPolicy: 'never',
        sandbox: options.codexAllowWrites === true ? 'workspace-write' : 'read-only',
        developerInstructions: 'Work only in the approved project directory. Do not attempt privilege escalation, global configuration changes, secrets access, network publishing, or Git push.',
      };
      // Only local Magpie settings may pin a custom model/provider. Remote MCP
      // arguments cannot override provider, credentials, binary or sandbox.
      if (typeof options.codexModel === 'string' && options.codexModel.trim()) config.model = options.codexModel.trim();
      if (typeof options.codexModelProvider === 'string' && options.codexModelProvider.trim()) config.modelProvider = options.codexModelProvider.trim();
      job.phase = 'thread/start';
      const response = resumeThreadId
        ? await rpc.request('thread/resume', { threadId: resumeThreadId, ...config })
        : await rpc.request('thread/start', config);
      job.threadId = response?.thread?.id;
      if (!job.threadId) throw new Error('Codex did not return a thread ID');
      job.phase = 'turn/start';
      const started = await rpc.request('turn/start', {
        threadId: job.threadId,
        input: [{ type: 'text', text: job.prompt }],
      });
      job.turnId = started?.turn?.id || null;
      job.phase = 'running';
      const turn = await completed;
      job.state = turn?.status === 'completed' ? 'completed' : turn?.status === 'interrupted' ? 'cancelled' : 'failed';
      if (job.state === 'completed') lastThreads.set(job.project, job.threadId);
      if (job.state === 'failed' && !job.error) job.error = bounded(turn?.error?.message || 'Codex turn failed', 500);
    } catch (error) {
      job.state = job.cancelRequested ? 'cancelled' : 'failed';
      const diagnosis = classifyCodexStderr(rpc?.stderrTail);
      job.error = bounded('Codex failed during ' + (job.phase || 'startup') + ': ' +
        (diagnosis || job.error || error?.message || error), 500);
    } finally {
      clearTimeout(timeout);
      if (job.cancelRequested) job.state = 'cancelled';
      if (job.state === 'completed') job.phase = 'completed';
      job.completedAt = new Date().toISOString();
      rpc?.stop();
      job.rpc = null;
    }
  }
  return {
    submit({ project, prompt, continueThread = false } = {}) {
      const p = allowed(project);
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) throw new Error('Prompt must be 1-12000 characters');
      if (Array.from(jobs.values()).some(t => t.state === 'running')) throw new Error('A Codex task is already running');
      const id = randomUUID();
      const task = { id, project, prompt: prompt.trim(), state: 'running',
        startedAt: new Date().toISOString(), phase: 'queued', output: '', threadId: null,
        turnId: null, error: null, rpc: null, cancelRequested: false };
      jobs.set(id, task);
      if (jobs.size > MAX_JOBS) {
        const old = [...jobs.values()].find(x => x.state !== 'running' && x.id !== id);
        if (old) jobs.delete(old.id);
      }
      void run(task, p.root, continueThread === true ? lastThreads.get(project) : null);
      return JSON.stringify(view(task));
    },
    status({ project, taskId } = {}) { return JSON.stringify(view(lookup(project, taskId))); },
    result({ project, taskId } = {}) { return JSON.stringify(view(lookup(project, taskId))); },
    async cancel({ project, taskId } = {}) {
      const task = lookup(project, taskId);
      if (task.state !== 'running') return JSON.stringify(view(task));
      task.cancelRequested = true;
      task.state = 'cancelled';
      task.completedAt = new Date().toISOString();
      if (task.rpc && task.turnId && task.threadId) {
        try { await Promise.race([
          task.rpc.request('turn/interrupt', { threadId: task.threadId, turnId: task.turnId }, 2000),
          new Promise(resolve => setTimeout(resolve, 2100)),
        ]); } catch { /* Force process stop below. */ }
      }
      task.rpc?.stop();
      return JSON.stringify(view(task));
    },
  };
}
