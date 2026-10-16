import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { validAccessConfig, taskCreateArguments, remotePaths, writeBootstrapStatus } from '../src/remote-service.mjs';
import { createSupervisor } from '../scripts/cloudflare-mcp-manager.mjs';

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

test('Windows scheduler action is confined to explicitly qualified Node and manager paths', () => {
  const args = taskCreateArguments('C:\\Program Files\\nodejs\\node.exe',
    'C:\\Users\\Alice Smith\\AppData\\Local\\MagpieLocalReview\\cloudflare-mcp-manager.mjs');
  assert.deepEqual(args.slice(0,4), ['/create','/tn','Magpie Local Review MCP (Managed)','/tr']);
  assert.equal(args[4], '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Alice Smith\\AppData\\Local\\MagpieLocalReview\\cloudflare-mcp-manager.mjs"');
  assert.equal(args.includes('/it'), true);
  assert.equal(args.includes('SYSTEM'), false);
  assert.throws(() => taskCreateArguments('node.exe','C:\\Program Files\\manager.mjs'));
  assert.throws(() => taskCreateArguments('C:\\node.exe" && echo bad', 'C:\\manager.mjs'));
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
    assert.ok(data.reason.length <= 240);
    assert.equal(data.reason.startsWith('scheduler rejected'), true);
  } finally { rmSync(temp, {recursive:true, force:true}); }
});
