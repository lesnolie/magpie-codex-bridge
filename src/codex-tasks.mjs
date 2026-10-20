/**
 * Local Codex app-server client for Magpie. Disabled by default.
 * Each task starts a separate stdio-only process in an explicitly allowed project.
 * No HTTP listener, shell interpolation, remote executable selection or elevation.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { resolveCodexBinary } from './codex-binary.mjs';
export { resolveCodexBinary };
import { projectRoots } from './projects.mjs';
import { normalizeChatUrl } from '../skills/magpie-codex-collab/chat-session.mjs';
import { gitBaseline, reviewFolder, saveReviewReceipt, readReviewReceipt, reviewInbox, reviewChanges, acknowledgeReview } from './codex-review.mjs';

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
    child.once('error', err => this.fail(new Error('Codex process spawn failed (' +
      (/^[A-Z0-9_]{2,36}$/.test(err?.code||'') ? err.code : 'unknown') + ')')));
    child.once('exit', (code, signal) => this.fail(new Error('Codex process exited (' +
      (Number.isInteger(code) ? 'code '+code : signal ? 'signal' : 'unknown') + ')')));
    child.stdin?.once('error', err => this.fail(new Error('Codex stdin closed (' +
      (/^[A-Z0-9_]{2,36}$/.test(err?.code||'') ? err.code : 'unknown') + ')')));
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
        if (msg.error) request.reject(new Error('Codex RPC rejected request (' + (Number.isInteger(msg.error.code) ? msg.error.code : 'unknown') + ')'));
        else request.resolve(msg.result);
      } else if (msg.method && msg.id != null) {
        // Never automatically approve escalation or other server-initiated requests.
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Remote approval unavailable; request denied' } });
      } else if (msg.method) this.onNotification(msg);
    }
  }
  send(payload) {
    if (this.closed) throw this.closeReason || new Error('Codex process already closed');
    if (!this.child.stdin.writable) throw new Error('Codex stdin unavailable before RPC request');
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

/**
 * Build task-scoped Codex execution permissions. Never trust a path from MCP
 * arguments: writable roots must come from the validated local project source.
 * Default stays sandboxed; broader Codex permissions require local opt-in.
 */
export function resolveCodexPermissionMode(options = {}) {
  if (['read-only', 'workspace-write', 'codex-local'].includes(options.codexPermissionMode)) {
    return options.codexPermissionMode;
  }
  // Migration support for existing local settings only; no old UI or manual
  // project grants remain. Unknown values fall back to read-only.
  return options.codexAllowWrites === true
    ? (options.codexInheritPermissions === true ? 'codex-local' : 'workspace-write')
    : 'read-only';
}

export function buildCodexThreadConfig(options = {}, project = {}) {
  const permission = resolveCodexPermissionMode(options);
  const writes = permission !== 'read-only';
  const codexSource = project.source === 'codex';
  const inherit = writes && codexSource && permission === 'codex-local';
  const extraRoots = codexSource && writes && Array.isArray(project.workspaceRoots)
    ? [...new Set(project.workspaceRoots.filter(root =>
        typeof root === 'string' && isAbsolute(root) && root !== project.root
      ))].slice(0, 7) : [];
  const config = {
    cwd: project.root,
    approvalPolicy: 'never',
    // Read-only must always remain explicit. The Codex-permission opt-in
    // deliberately omits sandbox; the native Codex configuration then decides.
    ...(!inherit ? { sandbox: writes ? 'workspace-write' : 'read-only' } : {}),
    developerInstructions: inherit
      ? 'Operate only on the project requested and other Codex Desktop projects explicitly referenced by the task. Do not access secrets or unrelated user files. No privilege escalation, unapproved network publishing or Git push. Report any missing permission rather than bypass it.'
      : 'Work only in this approved project and, when configured, other workspace roots of this SAME Codex Desktop project. Do not attempt privilege escalation, global configuration changes, secrets access, network publishing, or Git push.',
  };
  if (!inherit && writes && extraRoots.length) {
    config.config = { sandbox_workspace_write: {
      writable_roots: extraRoots, network_access: false,
    } };
  }
  if (typeof options.codexModel === 'string' && options.codexModel.trim()) config.model = options.codexModel.trim();
  if (typeof options.codexModelProvider === 'string' && options.codexModelProvider.trim()) config.modelProvider = options.codexModelProvider.trim();
  return { config, mode: inherit ? 'codex-local' : writes ? 'workspace-write' : 'read-only',
    additionalWorkspaceCount: extraRoots.length };
}

/**
 * Browser collaboration is strictly opt-in per submitted task: without a
 * user-supplied exact chat URL, the existing app-server behavior is unchanged.
 * Codex still runs via app-server; ego-browser is only the ChatGPT Web transport.
 */
export function buildBrowserCollaborationPrompt({ project, taskId, prompt, chatUrl }) {
  const url = normalizeChatUrl(chatUrl);
  return [
    'Use the installed magpie-web-collab Skill to communicate through ego-browser.',
    'EXECUTION: This is a Codex app-server task. Keep executing in this thread.',
    'TARGET_CHAT: ' + url,
    'PROJECT: ' + project,
    'TASK_ID: ' + taskId,
    'Open only TARGET_CHAT in one ego-browser TaskSpace/page. Verify the Magpie project once.',
    'Send brief useful progress/review messages, never ritual ACKs or repeated confirmations.',
    'Do not call undocumented ChatGPT APIs, read cookies or create another tunnel.',
    'If the Skill or ego-browser is unavailable, report browser-unavailable and continue',
    'returning the result through this existing MCP app-server task.',
    '',
    'USER GOAL:',
    prompt,
  ].join('\n');
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
  // Optional override for tests; real receipts belong to the local user, not the repository.
  const receiptDir = dependencies.reviewDir === false ? null : dependencies.reviewDir || reviewFolder();
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
      needsReview: task.state !== 'running',
      permissionMode: task.permissionMode || null,
      additionalWorkspaceCount: task.additionalWorkspaceCount ?? 0,
    };
  }
  function addOutput(job, delta) {
    if (typeof delta === 'string') job.output = bounded(job.output + delta);
  }
  async function run(job, selectedProject, resumeThreadId) {
    const projectRoot = selectedProject.root;
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
      // Record the initial revision before Codex can touch project files.
      const baseline = await gitBaseline(projectRoot);
      job.baselineHead = baseline.head;
      job.baselineDirty = baseline.dirty;
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
        job.error = 'Codex child process failed to start (' +
          (/^[A-Z0-9_]{2,36}$/.test(err?.code||'') ? err.code : 'unknown') + ')';
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
      const { config, mode, additionalWorkspaceCount } = buildCodexThreadConfig(options, selectedProject);
      job.permissionMode = mode;
      job.additionalWorkspaceCount = additionalWorkspaceCount;
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
      const resolution = error?.code === 'CODEX_BINARY_NOT_FOUND' ? 'native-executable-not-found'
        : error?.code === 'CODEX_BINARY_INVALID' ? 'invalid-executable-path' : null;
      const safeMessage = error?.message?.startsWith('Codex ') ? error.message
        : 'Codex startup or RPC failed';
      job.error = bounded('Codex failed during ' + (job.phase || 'startup') + ': ' +
        (resolution || diagnosis || job.error || rpc?.closeReason?.message || safeMessage), 500);
    } finally {
      clearTimeout(timeout);
      if (job.cancelRequested) job.state = 'cancelled';
      if (job.state === 'completed') job.phase = 'completed';
      job.completedAt = new Date().toISOString();
      rpc?.stop();
      job.rpc = null;
      if (receiptDir) {
        try { await saveReviewReceipt(receiptDir, job); }
        catch (err) { console.warn('[magpie-local-review] Review receipt not saved:', err?.code || 'error'); }
      }
      job.resolveDone?.();
    }
  }
  return {
    submit({ project, prompt, continueThread = false, chatUrl } = {}) {
      const p = allowed(project);
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) throw new Error('Prompt must be 1-12000 characters');
      if (Array.from(jobs.values()).some(t => t.state === 'running')) throw new Error('A Codex task is already running');
      const id = randomUUID();
      const taskPrompt = typeof chatUrl === 'string' && chatUrl.trim()
        ? buildBrowserCollaborationPrompt({ project, taskId: id, prompt: prompt.trim(), chatUrl })
        : prompt.trim();
      const task = { id, project, prompt: taskPrompt, state: 'running',
        startedAt: new Date().toISOString(), phase: 'queued', output: '', threadId: null,
        turnId: null, error: null, rpc: null, cancelRequested: false };
      task.done = new Promise(resolve => { task.resolveDone = resolve; });
      jobs.set(id, task);
      if (jobs.size > MAX_JOBS) {
        const old = [...jobs.values()].find(x => x.state !== 'running' && x.id !== id);
        if (old) jobs.delete(old.id);
      }
      void run(task, p, continueThread === true ? lastThreads.get(project) : null);
      return JSON.stringify(view(task));
    },
    status({ project, taskId } = {}) { return JSON.stringify(view(lookup(project, taskId))); },
    result({ project, taskId } = {}) { return JSON.stringify(view(lookup(project, taskId))); },
    async wait({ project, taskId, waitMs = 12000 } = {}) {
      allowed(project);
      const task = jobs.get(taskId);
      if (!task) {
        if (!receiptDir) throw Error('Unknown task in this project');
        const record = await readReviewReceipt(receiptDir, taskId).catch(() => null);
        if (!record || record.project !== project) throw Error('Unknown task in this project');
        return JSON.stringify({ ...record, needsReview: true });
      }
      if (task.project !== project) throw Error('Unknown task in this project');
      if (task.state === 'running') {
        const ms = Math.min(15000, Math.max(0, Number(waitMs) || 12000));
        let timer;
        try {
          await Promise.race([
            task.done,
            new Promise(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); }),
          ]);
        } finally { clearTimeout(timer); }
      }
      return JSON.stringify(view(task));
    },
    async inbox({ project } = {}) {
      if (options.codexEnabled !== true) throw Error('Codex is disabled in local Magpie settings');
      const list = roots();
      if (project && !list.some(p => p.name === project)) throw Error('Project is not on the local allowlist');
      const permitted = list.map(x => x.name).filter(name => !project || project === name);
      const entries = receiptDir ? await reviewInbox(receiptDir, permitted, [...jobs.values()])
        : await reviewInbox('/definitely/not-an-inbox', permitted, [...jobs.values()]);
      return JSON.stringify(entries);
    },
    async changes({ project, taskId, file } = {}) {
      const { root } = allowed(project);
      let task = jobs.get(taskId);
      if (task && task.project !== project) throw Error('Unknown task in this project');
      if (!task) {
        if (!receiptDir) throw Error('Unknown task in this project');
        task = await readReviewReceipt(receiptDir, taskId).catch(() => null);
      }
      if (!task || (task.project || '') !== project) throw Error('Unknown task in this project');
      if (task.state === 'running') throw Error('Task still running; call codex_wait_task');
      const report = await reviewChanges(root, task, file);
      return JSON.stringify({ taskId, project, state: task.state, output: bounded(task.output || ''),
        error: task.error || null, ...report });
    },
    async acknowledge({ project, taskId, decision, summary } = {}) {
      allowed(project);
      if (!receiptDir) throw Error('Persistent review receipts are disabled');
      // Only local receipt metadata is changed; project files remain untouched.
      const record = await readReviewReceipt(receiptDir, taskId).catch(() => null);
      if (!record || record.project !== project) throw Error('Unknown task in this project');
      return JSON.stringify(await acknowledgeReview(receiptDir, taskId, decision, summary));
    },
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
