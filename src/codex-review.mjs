/**
 * Persistent, read-only Codex review handoff.
 * Task receipts live in the current user's profile, never in project trees.
 * These do NOT notify or wake ChatGPT: the client must request the inbox.
 */
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile as execute } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, rename, writeFile, lstat, realpath } from 'node:fs/promises';
import { isAllowedEntry } from './projects.mjs';

const execFile = promisify(execute);
const MAX_DIFF = 32000;
const MAX_RECORD = 20000;
const MAX_INBOX = 40;
const MAX_PATHS = 75;
const ID = /^[a-f0-9-]{36}$/i;
const trim = (s, n) => String(s || '').slice(0, n);

export function reviewFolder(env = process.env) {
  const base = process.platform === 'win32'
    ? env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'MagpieLocalReview', 'codex-reviews');
}

function safeRelative(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.includes('\0') || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file)) return false;
  const parts = file.split('/');
  return parts.length <= 18 && parts.every((s, i) => s && s !== '.' && s !== '..' && isAllowedEntry(s, i < parts.length - 1));
}

async function git(root, args, maxBuffer = 256 * 1024) {
  const { stdout } = await execFile('git', ['-C', root, ...args], {
    windowsHide: true, timeout: 5000, maxBuffer, shell: false,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return stdout;
}

export async function gitBaseline(root) {
  try {
    const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
    const status = await git(root, ['status', '--porcelain', '--untracked-files=no']);
    return { head: /^[a-f0-9]{40,64}$/i.test(head) ? head : null, dirty: Boolean(status.trim()) };
  } catch { return { head: null, dirty: null }; }
}

export async function saveReviewReceipt(folder, job) {
  if (!ID.test(job.id)) throw Error('Invalid task ID');
  // Do not save the user's prompt, project absolute path, tokens, or raw stderr.
  const record = {
    taskId: job.id, project: job.project, state: job.state,
    phase: job.phase, startedAt: job.startedAt,
    completedAt: job.completedAt, threadId: job.threadId || null,
    turnId: job.turnId || null, output: trim(job.output, 12000),
    error: trim(job.error, 500) || null,
    baselineHead: job.baselineHead || null, baselineDirty: job.baselineDirty ?? null,
    needsReview: true,
  };
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const tmp = path.join(folder, randomUUID() + '.tmp');
  const final = path.join(folder, job.id + '.json');
  await writeFile(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { await rename(tmp, final); }
  catch (error) { await import('node:fs/promises').then(x=>x.unlink(tmp).catch(()=>{})); throw error; }
  return record;
}

export async function readReviewReceipt(folder, id) {
  if (!ID.test(id)) throw Error('Invalid task ID');
  const file = path.join(folder, id + '.json');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD) throw Error('Invalid review receipt');
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (!record || record.taskId !== id || typeof record.project !== 'string') throw Error('Invalid review receipt');
  return record;
}

export async function acknowledgeReview(folder, id, decision, summary) {
  if (!['approved', 'changes_requested', 'no_changes'].includes(decision)) throw Error('Invalid review decision');
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 1500) throw Error('Review summary must be 1-1500 characters');
  const record = await readReviewReceipt(folder, id);
  const next = { ...record, needsReview: false, review: {
    decision, summary: summary.trim(), reviewedAt: new Date().toISOString(),
  } };
  const tmp = path.join(folder, randomUUID() + '.tmp');
  await writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { await rename(tmp, path.join(folder, id + '.json')); }
  catch (error) {
    await import('node:fs/promises').then(x => x.unlink(tmp).catch(() => {}));
    throw error;
  }
  return { taskId: id, project: record.project, ...next.review, needsReview: false };
}

export async function reviewInbox(folder, projects, currentJobs = []) {
  const permitted = new Set(projects);
  const records = [];
  let names = [];
  try { names = await readdir(folder); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/i.test(n)).slice(-250)) {
    try {
      const record = await readReviewReceipt(folder, name.slice(0, -5));
      if (permitted.has(record.project)) records.push(record);
    } catch { /* Ignore corrupted/removed receipt. */ }
  }
  const known = new Set(records.map(x => x.taskId));
  for (const task of currentJobs) {
    if (known.has(task.id) || !permitted.has(task.project) || task.state === 'running') continue;
    records.push({ taskId: task.id, project: task.project, state: task.state,
      phase: task.phase, startedAt: task.startedAt, completedAt: task.completedAt, needsReview: true,
      threadId: task.threadId || null, error: trim(task.error, 500) || null });
  }
  const pending = records.filter(x => x.needsReview !== false);
  pending.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  return { tasks: pending.slice(0, MAX_INBOX).map(x => ({
    taskId: x.taskId, project: x.project, state: x.state,
    phase: x.phase, completedAt: x.completedAt, needsReview: true,
  })), total: pending.length, truncated: pending.length > MAX_INBOX };
}

async function safeExisting(root, file) {
  if (!safeRelative(file)) return false;
  const segments = file.split('/');
  let at = root;
  try {
    for (const segment of segments) {
      at = path.join(at, segment);
      const info = await lstat(at);
      if (info.isSymbolicLink()) return false;
    }
    if (!(await lstat(at)).isFile()) return false;
    const actual = await realpath(at), base = await realpath(root);
    const relative = path.relative(base, actual);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  } catch { return false; }
}

export async function reviewChanges(root, record, requestedFile) {
  if (!record || record.state !== 'completed' && record.state !== 'failed' && record.state !== 'cancelled') {
    throw Error('Codex task has not finished');
  }
  const baseline = record.baselineHead;
  const current = await gitBaseline(root);
  if (!baseline || !current.head) {
    return { baselineHead: baseline || null, currentHead: current.head, reviewable: false,
      reason: 'Git baseline unavailable; inspect the project with the existing read-only tools.' };
  }
  let changed = [];
  try {
    // Diff from submission commit to the current working tree, including
    // committed + staged + unstaged tracked changes. Untracked files are
    // enumerated separately; never show their contents automatically.
    const raw = await git(root, ['diff', '--name-only', '-z', '--no-ext-diff', baseline, '--']);
    changed = raw.split('\0').filter(Boolean).filter(safeRelative);
  } catch {
    return { reviewable: false, reason: 'Unable to obtain a Git review diff.' };
  }
  let untracked = [];
  try {
    const raw = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
    untracked = raw.split('\0').filter(Boolean).filter(safeRelative).slice(0, MAX_PATHS);
  } catch { /* Still able to inspect tracked changes. */ }
  const eligible = [];
  for (const file of changed.slice(0, MAX_PATHS)) if (await safeExisting(root, file)) eligible.push(file);
  const selected = requestedFile ? [requestedFile] : eligible.slice(0, 12);
  if (requestedFile && !eligible.includes(requestedFile)) throw Error('File is not a reviewable changed source file');
  let diff = '';
  let truncated = false;
  if (selected.length) {
    const contents = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', baseline, '--', ...selected], 2 * 1024 * 1024);
    truncated = contents.length > MAX_DIFF;
    diff = contents.slice(0, MAX_DIFF);
  }
  return {
    reviewable: true, baselineHead: baseline, currentHead: current.head,
    baselineDirty: record.baselineDirty ?? null, currentDirty: current.dirty,
    // A dirty initial worktree or intervening user changes can produce a
    // non-Codex diff. Never claim exact attribution.
    attribution: record.baselineDirty ? 'worktree-was-dirty-before-task' : 'git-diff-since-task-start-may-include-other-changes',
    changedFiles: changed.slice(0, MAX_PATHS),
    reviewableFiles: eligible, untrackedFiles: untracked,
    file: requestedFile || null, diff, diffTruncated: truncated,
    filesTruncated: changed.length > MAX_PATHS || (!requestedFile && eligible.length > 12),
  };
}
