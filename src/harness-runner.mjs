/**
 * A small, explicit native CLI launcher for the user's named harness.
 * Magpie itself configures providers/models; it does not expose universal
 * Desktop process control through its documented plugin API.
 *
 * We reuse the local project allowlist and existing Codex adapters.
 * Only documented Claude Code and DeepSeek Harness (dsh) CLI invocations are supported here.
 * Never accept an executable path or shell fragment from the remote caller.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoots } from './projects.mjs';
import { normalizeHarness, normalizePeerChatUrl } from './peer-messages.mjs';

const MAX_PROMPT = 12000;
const MAX_OUTPUT = 12000;
const RUN_LIMIT = 8 * 60 * 1000;
const JOB_LIMIT = 24;
const FORMATS = Object.freeze({
  claude: {
    readOnly: ['--print', '--permission-mode', 'plan', '--output-format', 'text'],
    native: ['--print', '--output-format', 'text'],
  },
  dsh: {
    // dsh headless reads the task from stdin and prints its answer to stdout.
    // Its current official CLI exposes no guaranteed read-only tool mode.
    native: ['headless'],
  },
});
function bounded(s) { return s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s; }
function actualCommand(harness, argv, platform, env) {
  if (platform !== 'win32') return { file: harness, args: argv };
  // npm-installed Claude/dsh often expose .cmd shims on Windows.
  // The shell sees only a FIXED, hard-coded CLI command/flags; prompts are
  // piped through stdin, never interpolated in shell command text.
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  if (!path.win32.isAbsolute(root) || /[\r\n\0"&|<>]/.test(root))
    throw Error('Invalid Windows system root');
  const cmd = path.win32.join(root, 'System32', 'cmd.exe');
  if (!['claude','dsh'].includes(harness) ||
      argv.some(a => !/^[a-zA-Z0-9-]+$/.test(a)))
    throw Error('Unsafe harness invocation rejected');
  return { file: cmd, args: ['/d', '/s', '/c', [harness, ...argv].join(' ')] };
}
export function createHarnessRunner(options = {}, deps = {}) {
  const spawn = deps.spawn || nodeSpawn;
  const roots = deps.projectRoots || (() => projectRoots(options));
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const jobs = new Map();
  const idFactory = deps.uuid || randomUUID;
  const now = deps.now || (() => Date.now());
  const timeLimit = deps.runLimitMs || RUN_LIMIT;
  const limit = deps.setTimeout || setTimeout;
  const unlimit = deps.clearTimeout || clearTimeout;
  function allowed(project) {
    if (typeof project !== 'string' || !project.trim()) throw Error('Exact authorized project name required');
    const match = roots().find(x => x.name === project);
    if (!match || !(platform === 'win32' ? path.win32.isAbsolute(match.root) : path.isAbsolute(match.root))) throw Error('Project is not in the local Magpie project allowlist');
    return match;
  }
  function view(j) {
    return { taskId:j.taskId, harness:j.harness, mode:'cli',
      project:j.project, state:j.state, startedAt:j.startedAt,
      completedAt:j.completedAt || null, exitCode:j.exitCode ?? null,
      output:bounded(j.output), error:j.error || null,
      processCompleted:j.state === 'completed',
      taskOutcomeVerified:false };
  }
  function lookup({taskId,harness,project}={}) {
    const j = jobs.get(taskId);
    if (!j) throw Error('Unknown or expired agent task');
    if (harness && normalizeHarness(harness) !== j.harness) throw Error('Task harness mismatch');
    if (project && project !== j.project) throw Error('Task project mismatch');
    return j;
  }
  function complete(j, state, code, error) {
    if (j.state !== 'running') return;
    j.state = state; j.exitCode = Number.isInteger(code) ? code : null;
    j.error = error || null;
    j.completedAt = new Date(now()).toISOString();
    unlimit(j.timer);
    j.child = null;
  }
  return {
    launch({ harness, project, prompt, chatUrl, peerMailbox }={}) {
      if (options.agentLaunchEnabled !== true)
        throw Error('Agent CLI launch is disabled in local Magpie settings');
      const selected = normalizeHarness(harness);
      const template = FORMATS[selected];
      if (!template) throw Error('Selected harness has no supported CLI launcher; no other harness used');
      const root = allowed(project);
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT)
        throw Error('Agent prompt must be 1-12000 characters');
      if ([...jobs.values()].some(j => j.state === 'running'))
        throw Error('Another agent CLI task is active; finish or cancel it first');
      const url = chatUrl ? normalizePeerChatUrl(chatUrl) : null;
      const nativePerms = options.agentLaunchPermission === 'native';
      // Unlike Claude Code's plan mode, dsh headless has no supported
      // read-only flag. Fail closed rather than mislabel it read-only.
      if (selected === 'dsh' && !nativePerms) {
        throw Error('DeepSeek Harness headless has no verified read-only mode; enable native Harness permissions locally for dsh');
      }
      const spec = actualCommand(selected, nativePerms ? template.native : template.readOnly, platform, env);
      const taskId = idFactory();
      const j = { taskId, harness:selected, project, output:'', state:'running',
        startedAt:new Date(now()).toISOString(), completedAt:null,
        exitCode:null, error:null, child:null, timer:null };
      jobs.set(taskId,j);
      if (jobs.size > JOB_LIMIT) {
        const old = [...jobs.values()].find(x=>x.state !== 'running' && x.taskId !== taskId);
        if (old) jobs.delete(old.taskId);
      }
      let child;
      try {
        child = spawn(spec.file, spec.args, {
          cwd:root.root, shell:false, windowsHide:true,
          stdio:['pipe','pipe','pipe'], env,
        });
      } catch (e) {
        complete(j,'failed',null,'Could not launch selected harness');
        return JSON.stringify(view(j));
      }
      j.child = child;
      child.stdout?.on('data', chunk=>{ j.output=bounded(j.output + chunk.toString('utf8')); });
      let stderrTail='';
      child.stderr?.on('data',chunk=>{stderrTail=bounded(stderrTail+chunk.toString('utf8'));});
      child.on('error', e => complete(j,'failed',null,
        'Harness CLI start failed (' + (/^[A-Z0-9_]{2,30}$/.test(e?.code||'') ? e.code : 'unknown') + ')'));
      child.on('close', code=>{
        if(j.state === 'running') complete(j, code === 0 ? 'completed':'failed',code,
          code === 0 ? null : 'Selected harness exited with a nonzero status');
      });
      j.timer = limit(()=>{
        if(j.state === 'running') { complete(j,'timeout',null,'Harness CLI exceeded the local safety time limit');child.kill(); }
      },timeLimit);
      j.timer.unref?.();
      // A woken harness must be able to read the very command that woke it and
      // answer in the same conversation. The exact mailbox identity is passed in
      // so the agent adopts that session instead of inventing a second one.
      const mailbox = peerMailbox && typeof peerMailbox.sessionId === 'string'
        ? ['PEER_MAILBOX_SESSION_ID: '+peerMailbox.sessionId,
           'PEER_MAILBOX_MODE: '+(peerMailbox.mode || 'cli'),
           'Adopt this EXACT sessionId with one agent_register call that ALSO passes',
           'mode: "'+(peerMailbox.mode || 'cli')+'" and resumeExisting: true. The mode is part of',
           'the mailbox identity; omitting it will create a second session and the waking',
           'command will be left unread in the first. Then agent_poll it for that command.',
           'Acknowledge each command with agent_ack only after you actually processed it, and reply',
           'in the SAME conversation through ego-browser. Never invent a second mailbox session.']
        : ['No Magpie mailbox session was provisioned. Register one with agent_register before polling.'];
      const instruction = [
        'Invoke the installed magpie-web-collab Skill when available; use ego-browser for all Harness-to-Web messages.',
        'You and ChatGPT Web are peers; follow the actual command, not a fixed reviewer/executor role.',
        'TASK_ID: '+taskId,
        'HARNESS: '+selected,
        'PROJECT: '+project,
        ...mailbox,
        'During this active agent turn, work on the task, send useful REQUEST/RESULT messages through ego-browser, read new Web replies and continue when actionable.',
        'Do not ask the user or ChatGPT to confirm each step; carry out permitted, in-scope work directly.',
        'No repeated HELLO/ACK messages, no assumed reviewer role, and no claims of execution based only on opening a window.',
        'Work only in the supplied project and obey your native local permission policy.',
        url ? 'ChatGPT Web conversation: '+url : 'No verified ChatGPT conversation was provided. Do not guess one.',
        'When ChatGPT Web offers a relevant file to download, use the installed ego-browser Skill',
        'and verify real local bytes; never pretend that clicking a link alone downloaded the file.',
        'If ego-browser or the Skill cannot run, report that limitation in your final CLI output.',
        'Do not claim success in ChatGPT Web unless its browser page actually shows the posted message.',
        '',
        'TASK:',
        prompt.trim(),
      ].join('\n');
      // No user text enters cmd.exe; on both platforms the task is passed only through stdin.
      try {child.stdin.end(instruction);}catch {complete(j,'failed',null,'Could not deliver task to harness input');child.kill();}
      return JSON.stringify({...view(j), executable:selected,
        permissionMode:nativePerms?'native':'read-only',
        dispatch:'started-process', completionUnverified:true,
        warning:'CLI process start is not proof the agent can use ego-browser; inspect status/result.'});
    },
    status(args={}) { return JSON.stringify(view(lookup(args))); },
    cancel(args={}) {
      const j=lookup(args);
      if(j.state!=='running') return JSON.stringify(view(j));
      const child=j.child;
      complete(j,'cancelled',null,'Cancelled by request');
      child?.kill();
      return JSON.stringify(view(j));
    },
  };
}
