import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { validAccessConfig, startupCommand, startupRegistryScript, psLiteral, remotePaths, writeBootstrapStatus, managedManagerReloadScript, shouldEnableCodexRemotePermission } from '../src/remote-service.mjs';
import { createSupervisor, acquireManagerSingleton } from '../scripts/cloudflare-mcp-manager.mjs';
import { execFileSync } from 'node:child_process';

test('only valid Cloudflare Access configs can enable the managed remote adapter', () => {
  assert.equal(validAccessConfig(JSON.stringify({
    teamDomain: 'lesnolie.cloudflareaccess.com',
    audience: 'test-audience-123456',
  })), true);
  for (const bad of [
    '{}', 'not json', '{"teamDomain":"evil.com","audience":"12345678"}',
    '{"teamDomain":"team.cloudflareaccess.com","audience":""}',
    '{"teamDomain":"team.cloudflareaccess.com","audience":12345678}',
  ]) assert.equal(validAccessConfig(bad), false);
});

test('current-user Run registry command quotes Windows paths safely', () => {
  const command = startupCommand('C:\\Program Files\\nodejs\\node.exe',
    'C:\\Users\\Alice Smith\\AppData\\Local\\MagpieLocalReview\\cloudflare-mcp-manager.mjs');
  assert.equal(command, '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Alice Smith\\AppData\\Local\\MagpieLocalReview\\cloudflare-mcp-manager.mjs"');
  assert.throws(() => startupCommand('node.exe','C:\\Program Files\\manager.mjs'));
  assert.throws(() => startupCommand('C:\\node.exe" && echo bad', 'C:\\manager.mjs'));
  assert.equal(psLiteral("a'b"), "'a''b'");
  const ps = startupRegistryScript('set', command);
  assert.match(ps, /Registry\]::CurrentUser/);
  assert.match(ps, /SetValue/);
  assert.match(ps, /Run/);
  assert.doesNotMatch(ps, /LocalMachine|SYSTEM|schtasks/);
  assert.match(startupRegistryScript('delete', ''), /DeleteValue/);
  assert.throws(() => startupRegistryScript('execute', 'x'));
});

test('Windows registry startup script registers and removes HKCU value without elevation', {
  skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true',
}, () => {
  const runPs = code => execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 12000, windowsHide: true }).trim();
  const set = startupRegistryScript('set', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Alice Smith\\test.mjs"');
  // This is the plugin's own test-only CI sandbox; clean up even on error.
  try {
    runPs(set);
    const query = "$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("+
      psLiteral('Software\\Microsoft\\Windows\\CurrentVersion\\Run')+");"+
      "$key.GetValue(" + psLiteral('Magpie Local Review MCP') + ")";
    assert.equal(runPs(query), '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Alice Smith\\test.mjs"');
  } finally {
    runPs(startupRegistryScript('delete', ''));
  }
});

test('Codex remote permission depends on local Codex opt-in, not autostart', () => {
  assert.equal(shouldEnableCodexRemotePermission({ codexEnabled: true, remoteAutoStart: false }), true);
  assert.equal(shouldEnableCodexRemotePermission({ codexEnabled: true, remoteAutoStart: true }), true);
  assert.equal(shouldEnableCodexRemotePermission({ codexEnabled: false, remoteAutoStart: true }), false);
  assert.equal(shouldEnableCodexRemotePermission({ remoteAutoStart: true }), false);
});

test('managed supervisor upgrade targets only exact approved manager script', () => {
  const manager = 'C:\\Users\\Alice Smith\\AppData\\Local\\MagpieLocalReview\\cloudflare-mcp-manager.mjs';
  const ps = managedManagerReloadScript(manager);
  assert.match(ps, /Get-CimInstance Win32_Process/);
  assert.match(ps, /Stop-Process/);
  assert.match(ps, /Multiple managed supervisors; refusing unsafe restart/);
  assert.match(ps, /cloudflare-mcp-manager.mjs/);
  assert.doesNotMatch(ps, /taskkill|killall|Get-NetTCPConnection|node_modules/);
  assert.throws(() => managedManagerReloadScript('C:\\temp\\another-program.mjs'));
  assert.throws(() => managedManagerReloadScript('cloudflare-mcp-manager.mjs'));
});

test('service copies live outside volatile Magpie plugin directories', () => {
  const p = remotePaths({LOCALAPPDATA:'C:\\Local',APPDATA:'C:\\Roaming'});
  assert.ok(p.manager.includes('MagpieLocalReview'));
  assert.ok(p.adapter.endsWith('cloudflare-mcp-adapter.mjs'));
  assert.ok(p.config.includes('magpie-local-review'));
});

test('supervisor starts only with Magpie and config, stops listener on quit', async () => {
  let magpie = false;
  let configured = true;
  let occupied = false;
  let creations = 0;
  let closed = 0;
  const states = [];
  const fakeBridge = () => {
    creations++;
    const server = new EventEmitter();
    server.listening = true;
    server.close = (callback) => { closed++; server.listening = false; callback(); };
    return server;
  };
  const supervisor = createSupervisor({
    isMagpieReady: async () => magpie,
    isBridgeInUse: async () => occupied,
    hasConfig: () => configured,
    isEnabled: () => true,
    createBridge: fakeBridge,
    report: state => states.push(state),
  });
  await supervisor.tick();
  assert.equal(supervisor.state, 'waiting-for-magpie');
  assert.equal(creations, 0);
  magpie = true;
  occupied = true;
  await supervisor.tick();
  assert.equal(supervisor.state, 'external-listener-48765');
  assert.equal(creations, 0, 'never disrupt a manual listener');
  occupied = false;
  await supervisor.tick();
  assert.equal(creations, 1);
  await supervisor.tick();
  assert.equal(supervisor.state, 'online');
  magpie = false;
  await supervisor.tick();
  assert.equal(closed, 1);
  assert.equal(supervisor.state, 'waiting-for-magpie');
  configured = false;
  magpie = true;
  await supervisor.tick();
  assert.equal(supervisor.state, 'waiting-for-cloudflare-config');
  configured = true;
  await supervisor.tick();
  assert.equal(creations, 2);
  await supervisor.shutdown();
  assert.equal(closed, 2);
  assert.equal(supervisor.state, 'stopped');
  await supervisor.tick();
  assert.equal(creations, 2);
  assert.deepEqual(states, [
    'waiting-for-magpie', 'external-listener-48765',
    'starting', 'online', 'waiting-for-magpie',
    'waiting-for-cloudflare-config', 'starting', 'stopped',
  ]);
});

test('Magpie page still offers exactly six audit tools and only options-backed lifecycle controls', () => {
  const plugin = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../page/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../page/app.js', import.meta.url), 'utf8');
  assert.match(plugin, /reconcileRemoteService/);
  assert.match(html, /id="remoteAutoStart"/);
  assert.match(app, /magpie\.options\.set/);
  assert.doesNotMatch(app, /fetch\(|XMLHttpRequest|execFile\(|shell|node:child_process/);
});

test('bootstrap diagnostics create an independent status file without running manager', async () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'mcp-bootstrap-'));
  try {
    const env = { LOCALAPPDATA: temp, APPDATA: temp };
    await writeBootstrapStatus('checking-node', null, env);
    const file = path.join(temp, 'MagpieLocalReview', 'service-bootstrap.json');
    assert.ok(existsSync(file));
    let data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.stage, 'checking-node');
    assert.equal(data.reason, undefined);
    assert.ok(data.at);
    await writeBootstrapStatus('setup-failed', 'scheduler rejected'.repeat(100), env);
    data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.stage, 'setup-failed');
    assert.ok(data.reason.length <= 800);
    assert.equal(data.reason.startsWith('scheduler rejected'), true);
  } finally { rmSync(temp, {recursive:true, force:true}); }
});

test('disabled manager closes only its own listener and exits promptly', async () => {
  let enabled = true;
  let closes = 0;
  let startCount = 0;
  const states = [];
  const bridgeFactory = () => {
    const e = new EventEmitter();
    e.listening = true;
    e.close = (cb) => { e.listening = false; closes++; cb(); };
    startCount++;
    return e;
  };
  const manager = createSupervisor({
    isEnabled: () => enabled,
    isMagpieReady: async () => true,
    hasConfig: () => true,
    isBridgeInUse: async () => false,
    createBridge: bridgeFactory,
    report: state => states.push(state),
  });
  await manager.tick();
  enabled = false;
  await manager.tick();
  assert.equal(closes, 1);
  assert.equal(manager.stopped, true);
  await manager.tick();
  assert.equal(startCount, 1);
  assert.equal(states.at(-1), 'stopped');
});

test('Windows local named-pipe singleton refuses duplicate supervisor', {
  skip: process.platform !== 'win32',
}, async () => {
  const name = 'MagpieMCP-CI-' + process.pid;
  const first = await acquireManagerSingleton(name);
  assert.ok(first);
  const second = await acquireManagerSingleton(name);
  assert.equal(second, null);
  await first.close();
  const third = await acquireManagerSingleton(name);
  assert.ok(third);
  await third.close();
});
