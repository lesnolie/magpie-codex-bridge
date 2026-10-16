/**
 * Windows-only remote MCP lifecycle. Only enabled by a local Magpie page option.
 * This module does not expose any runtime control over the remote MCP tools.
 *
 * The Magpie page can only call options.set: when the plugin host is next loaded,
 * this hook registers one least-privilege Windows logon task. That task runs a
 * stable, self-contained supervisor outside Magpie's replaceable plugin cache.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const TASK_NAME = 'Magpie Local Review MCP (Managed)';
const CONFIG_BASENAME = 'cloudflare-mcp.json';
const COPIES = Object.freeze([
  ['../scripts/cloudflare-mcp-adapter.mjs', 'cloudflare-mcp-adapter.mjs'],
  ['../scripts/cloudflare-mcp-manager.mjs', 'cloudflare-mcp-manager.mjs'],
]);

export function remotePaths(env = process.env) {
  const roaming = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base = path.join(local, 'MagpieLocalReview');
  return { base, config: path.join(roaming, 'magpie-local-review', CONFIG_BASENAME),
    adapter: path.join(base, 'cloudflare-mcp-adapter.mjs'),
    manager: path.join(base, 'cloudflare-mcp-manager.mjs') };
}
export function validAccessConfig(content) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return false; }
  const team = String(parsed?.teamDomain || '').replace(/^https:\/\//, '').replace(/\/$/, '');
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) &&
    typeof parsed?.audience === 'string' && /^[a-zA-Z0-9_-]{6,256}$/.test(parsed.audience);
}
export function taskCreateArguments(node, manager) {
  if (!path.win32.isAbsolute(node) || !path.win32.isAbsolute(manager)) throw Error('Absolute Windows Node and manager paths are required');
  // Arguments are supplied to schtasks.exe directly without a shell; quote
  // each path inside the task action (spaces in user profiles are common).
  if (node.includes('"') || manager.includes('"')) throw Error('Unsafe task action path');
  return ['/create', '/tn', TASK_NAME, '/tr', '"' + node + '" "' + manager + '"',
    '/sc', 'onlogon', '/it', '/rl', 'LIMITED', '/f'];
}
async function nodeBinary(env = process.env) {
  const candidate = [];
  if (env.MAGPIE_REVIEW_NODE_PATH) candidate.push(env.MAGPIE_REVIEW_NODE_PATH);
  if (path.basename(process.execPath).toLowerCase() === 'node.exe') candidate.push(process.execPath);
  try {
    const { stdout } = await execute('where.exe', ['node.exe'], { windowsHide: true, timeout: 3500 });
    candidate.push(...stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean));
  } catch { /* GUI applications may inherit a different PATH. */ }
  candidate.push(path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  if (env.APPDATA) candidate.push(path.join(env.APPDATA, 'npm', 'node.exe'));
  for (const item of new Set(candidate)) {
    if (!path.win32.isAbsolute(item) || item.includes('"')) continue;
    try {
      const { stdout } = await execute(item, ['--version'], { windowsHide: true, timeout: 3500 });
      if (Number(stdout.trim().match(/^v(\d+)/)?.[1]) >= 20) return item;
    } catch { /* Try next installation. */ }
  }
  throw Error('Node.js 20+ not found. Install Node.js, then reload this plugin.');
}
async function copyStable(source, target) {
  const bytes = await readFile(fileURLToPath(new URL(source, import.meta.url)));
  let old;
  try { old = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (old && bytes.equals(old)) return false;
  const tmp = target + '.' + process.pid + '.tmp';
  await writeFile(tmp, bytes, { mode: 0o600 });
  try {
    // Windows rename doesn't always replace an open existing file. The
    // adapter/manager load code at process start; deletion cannot stop it.
    try { await rename(tmp, target); }
    catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await unlink(target);
      await rename(tmp, target);
    }
  } finally { await unlink(tmp).catch(() => {}); }
  return true;
}
async function taskPresent() {
  try { await execute('schtasks.exe', ['/query', '/tn', TASK_NAME], { windowsHide: true, timeout: 7000 }); return true; }
  catch { return false; }
}
async function runTask(args, allowMissing = false) {
  try { await execute('schtasks.exe', args, { windowsHide: true, timeout: 12000, maxBuffer: 128 * 1024 }); }
  catch (err) { if (!allowMissing) throw Error('Windows Task Scheduler: ' + (err.message || 'failed')); }
}
export async function reconcileRemoteService(options = {}) {
  if (process.platform !== 'win32' || typeof options.remoteAutoStart !== 'boolean') return { state: 'unchanged' };
  // A web request can NEVER toggle this: only local Magpie options.set does.
  if (!options.remoteAutoStart) {
    if (await taskPresent()) {
      await runTask(['/end', '/tn', TASK_NAME], true);
      await runTask(['/delete', '/tn', TASK_NAME, '/f']);
    }
    return { state: 'disabled' };
  }
  const p = remotePaths();
  let config;
  try { config = await readFile(p.config, 'utf8'); }
  catch { throw Error('Cloudflare Access settings are missing; keep the existing cloudflare-mcp.json configuration.'); }
  if (!validAccessConfig(config)) throw Error('Cloudflare Access settings are invalid; auto start was not installed.');
  const node = await nodeBinary();
  await mkdir(p.base, { recursive: true });
  let changed = false;
  for (const [source, filename] of COPIES) changed = (await copyStable(source, path.join(p.base, filename))) || changed;
  const present = await taskPresent();
  if (!present || changed) {
    // Only touch the task with this plugin's unique managed name. No admin,
    // system, remote account or password; must run in the logged-on session.
    if (present) await runTask(['/end', '/tn', TASK_NAME], true);
    await runTask(taskCreateArguments(node, p.manager));
  }
  // Start right away if enabled, not only on the next Windows login.
  // If it is already running, Task Scheduler may reject /run; that is okay.
  await runTask(['/run', '/tn', TASK_NAME], true);
  return { state: 'installed', changed };
}
