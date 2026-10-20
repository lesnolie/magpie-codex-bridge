/**
 * Windows-only remote MCP lifecycle. Only enabled by a local Magpie page option.
 * This module does not expose any runtime control over the remote MCP tools.
 *
 * The Magpie page can only call options.set. The plugin writes an opt-in HKCU
 * Windows logon autostart value (no administrator rights or task scheduler),
 * then starts a supervisor from LocalAppData. The manager runs independently
 * of Magpie's lazily loaded Bun plugin host.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const STARTUP_NAME = 'Magpie Local Review MCP';
export const STARTUP_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const MANAGED_TASK_NAME = 'Magpie Local Review MCP (Managed)';
const MAX_DIAGNOSTIC_LENGTH = 800;
const BOOTSTRAP_FILENAME = 'service-bootstrap.json';
export async function writeBootstrapStatus(stage, reason = null, env = process.env) {
  // Setup status is local-only and contains neither JWTs nor Cloudflare
  // configuration values. The iframe cannot access files, so users can
  // inspect this file in Explorer if task installation fails.
  try {
    const { base } = remotePaths(env);
    await mkdir(base, { recursive: true });
    const payload = {
      stage,
      at: new Date().toISOString(),
      ...(reason ? { reason: String(reason).slice(0, MAX_DIAGNOSTIC_LENGTH) } : {}),
    };
    await writeFile(path.join(base, BOOTSTRAP_FILENAME), JSON.stringify(payload, null, 2));
  } catch { /* Preserve review-tool availability even if diagnostics cannot be written. */ }
}

const CONFIG_BASENAME = 'cloudflare-mcp.json';
const MANAGER_RUNTIME_VERSION = '0.4.2-alpha.1';
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
    manager: path.join(base, 'cloudflare-mcp-manager.mjs'),
    enabledFile: path.join(base, 'service-enabled.flag'),
    codexEnabledFile: path.join(base, 'codex-remote-enabled.flag'),
    peerEnabledFile: path.join(base, 'peer-remote-enabled.flag'),
    agentLaunchEnabledFile: path.join(base, 'agent-launch-enabled.flag') };
}
export function validAccessConfig(content) {
  let parsed;
  try { parsed = JSON.parse(content); } catch { return false; }
  const team = String(parsed?.teamDomain || '').replace(/^https:\/\//, '').replace(/\/$/, '');
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) &&
    typeof parsed?.audience === 'string' && /^[a-zA-Z0-9_-]{6,256}$/.test(parsed.audience);
}
/** Quote a command with fully qualified paths for HKCU Run, no shell involved. */
export function startupCommand(node, manager) {
  if (!path.win32.isAbsolute(node) || !path.win32.isAbsolute(manager)) {
    throw Error('Absolute Windows Node and manager paths are required');
  }
  if ([node, manager].some(v => /["\r\n]/.test(v))) throw Error('Unsafe startup path');
  return '"' + node + '" "' + manager + '"';
}
export function psLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
export function startupRegistryScript(action, command) {
  if (!['set', 'delete'].includes(action)) throw Error('Invalid autostart action');
  const opening = "$ErrorActionPreference='Stop';" +
    "$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(" +
    psLiteral(STARTUP_KEY) + ");if($null -eq $key){throw 'HKCU Run key unavailable'};" +
    "try{";
  const closing = "}finally{$key.Dispose()}";
  if (action === 'delete') {
    return opening + "$key.DeleteValue(" + psLiteral(STARTUP_NAME) + ",$false);" + closing;
  }
  return opening + "$key.SetValue(" + psLiteral(STARTUP_NAME) + "," + psLiteral(command) +
    ",[Microsoft.Win32.RegistryValueKind]::String);" +
    "if($key.GetValue(" + psLiteral(STARTUP_NAME) + ") -cne " +
    psLiteral(command) + "){throw 'HKCU Run value verification failed'};" + closing;
}
async function writeStartup(action, command = '') {
  // Base64 UTF-16LE avoids cmd.exe, argv quoting and schtasks /tr parsing.
  // .NET Registry.CurrentUser writes only our own HKCU Run value.
  const script = startupRegistryScript(action, command);
  try {
    await execute('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], { timeout: 12000, windowsHide: true, maxBuffer: 64 * 1024 });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || error.code || 'unknown')
      .replace(/\s+/g, ' ').trim().slice(0, 500);
    throw Error('Current-user Windows startup registration failed: ' + detail);
  }
}
async function launchManager(node, manager) {
  await new Promise((resolve, reject) => {
    const child = spawn(node, [manager], {
      cwd: path.dirname(manager), detached: true,
      stdio: 'ignore', windowsHide: true, shell: false,
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
/** Remove only the predecessor plugin-managed Task Scheduler entry, if any. */
async function cleanupOldTask() {
  try {
    await execute('schtasks.exe', ['/delete', '/tn', MANAGED_TASK_NAME, '/f'],
      { windowsHide: true, timeout: 4500 });
  } catch { /* No old task or task cleanup denied: never touch other tasks. */ }
}

export async function nodeBinary(env = process.env) {
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
/** Local Codex authorization is independent of whether service autostart is enabled. */
export function shouldEnableCodexRemotePermission(options = {}) {
  return options.codexEnabled === true;
}

/**
 * Replace a stale instance of THIS plugin's managed Windows supervisor.
 * Strictly match the complete managed script argv token, never processes
 * using the same TCP port or generic node.exe processes. Fail closed when
 * Windows cannot inspect processes; never kill another user's service.
 */
export function managedManagerReloadScript(manager) {
  if (!path.win32.isAbsolute(manager) || !manager.toLowerCase().endsWith('\\cloudflare-mcp-manager.mjs')) {
    throw Error('Reload requires the exact managed supervisor path');
  }
  const target = psLiteral(manager);
  return "$ErrorActionPreference='Stop';" +
    "$target=" + target + ";" +
    "$escaped=[regex]::Escape($target);" +
    "$pattern='(^|\\s)' + '\"?' + $escaped + '\"?' + '(\\s|$)';" +
    "$matches=@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | " +
    "Where-Object { $_.CommandLine -and ($_.CommandLine -match $pattern) });" +
    "if($matches.Count -gt 1){throw 'Multiple managed supervisors; refusing unsafe restart'};" +
    "if($matches.Count -eq 1){" +
    "Stop-Process -Id $matches[0].ProcessId -ErrorAction Stop;" +
    "Start-Sleep -Milliseconds 350;}";
}
async function reloadOldManager(manager) {
  const script = managedManagerReloadScript(manager);
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 12000, maxBuffer: 64 * 1024 });
}

export async function reconcileRemoteService(options = {}) {
  if (typeof options.remoteAutoStart !== 'boolean' && typeof options.codexEnabled !== 'boolean' && typeof options.peerMessagingEnabled !== 'boolean' && typeof options.agentLaunchEnabled !== 'boolean') return { state: 'unchanged' };
  if (process.platform !== 'win32') return { state: 'unsupported-platform' };
  // The remote adapter checks this local-only flag for EVERY request. Never let
  // remote calls grant themselves Codex access; local Magpie options are authoritative.
  const grant = remotePaths();
  await mkdir(grant.base, { recursive: true });
  if (shouldEnableCodexRemotePermission(options)) {
    await writeFile(grant.codexEnabledFile, 'enabled\n');
  } else {
    await unlink(grant.codexEnabledFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  // Peer messaging is a separate opt-in from Codex execution permission.
  // The public MCP adapter checks its own marker on every remote request.
  if (options.peerMessagingEnabled === true) {
    await writeFile(grant.peerEnabledFile, 'enabled\n');
  } else {
    await unlink(grant.peerEnabledFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  // Independent, local-only permission to launch an agent process via MCP.
  // Remote callers cannot set options or obtain this marker.
  if (options.agentLaunchEnabled === true) {
    await writeFile(grant.agentLaunchEnabledFile, 'enabled\n');
  } else {
    await unlink(grant.agentLaunchEnabledFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  if (typeof options.remoteAutoStart !== 'boolean') return { state: 'agent-permissions-synced' };
  await writeBootstrapStatus('initializing');
  // This is only called from the locally configured Magpie plugin hook,
  // never via the six remote MCP tools.
  const p = remotePaths();
  if (!options.remoteAutoStart) {
    // Drop the enabled marker first: the manager closes its listener on
    // its next tick, then exits. This does not kill unrelated Node processes.
    await unlink(p.enabledFile).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await writeBootstrapStatus('disabling-startup');
    await writeStartup('delete');
    await cleanupOldTask();
    await writeBootstrapStatus('disabled');
    return { state: 'disabled' };
  }
  let config;
  try { config = await readFile(p.config, 'utf8'); }
  catch { throw Error('Cloudflare Access settings are missing; keep the existing cloudflare-mcp.json configuration.'); }
  if (!validAccessConfig(config)) throw Error('Cloudflare Access settings are invalid; auto start was not installed.');
  await writeBootstrapStatus('checking-node');
  const node = await nodeBinary();
  await mkdir(p.base, { recursive: true });
  let changed = false;
  for (const [source, filename] of COPIES) {
    changed = (await copyStable(source, path.join(p.base, filename))) || changed;
  }
  await writeBootstrapStatus('registering-user-startup');
  await writeStartup('set', startupCommand(node, p.manager));
  await writeFile(p.enabledFile, 'enabled\n');
  await cleanupOldTask();
  // Previously running supervisors keep the OLD adapter module in memory.
  // Copying files and launching a second manager is insufficient because the
  // existing process holds the unique named-pipe lock. Stop ONLY our own
  // supervisor (exact script command line) before launching the upgraded code.
  const revisionFile = path.join(p.base, 'managed-runtime-version.txt');
  let priorRevision = '';
  try { priorRevision = (await readFile(revisionFile, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (changed || priorRevision !== MANAGER_RUNTIME_VERSION) {
    await writeBootstrapStatus('reloading-managed-adapter');
    await reloadOldManager(p.manager);
  }
  // Registry Run starts at next Windows sign-in; spawn detached now.
  // The supervisor owns its process singleton, not the Magpie plugin host.
  await writeBootstrapStatus('starting-manager');
  try {
    await launchManager(node, p.manager);
    await writeFile(path.join(p.base, 'managed-runtime-version.txt'), MANAGER_RUNTIME_VERSION + '\n');
  } catch (error) {
    throw Error('Could not start local background manager: ' + (error.code || error.message));
  }
  await writeBootstrapStatus('manager-launch-requested');
  return { state: 'installed', changed };
}
