import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAppServer } from '../src/app-server.mjs';

const fake = resolve('test/fixtures/mock-app-server.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitUntil = async (fn, timeout = 1500) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const val = await fn();
    if (val) return val;
    await sleep(15);
  }
  throw Error('Test did not reach expected state');
};

test('local thread -> native compact -> fresh independent app-server process -> resume and continue same thread ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magpie-codex-'));
  const env = { ...process.env, MOCK_CODEX_STORE: join(dir, 'threads.json') };
  const create = () => new CodexAppServer({ command: process.execPath, args: [fake], env, requestTimeoutMs: 1000 });
  const local = create();
  const remote = create();
  try {
    const started = await local.call('thread/start', {});
    const id = started.thread.id;
    assert.equal((await local.listThreads()).threads[0].cwd, 'D:\\TMN');
    assert.equal((await local.resume(id)).threadId, id);
    const compaction = await local.compact(id);
    assert.equal(compaction.accepted, true);
    await waitUntil(async () => (await local.status(id)).bridgeJob?.state === 'completed');
    assert.equal((await local.status(id)).bridgeJob.compactionItemCompleted, true);
    await local.close();

    // Different app-server process, same on-disk Codex home / thread identity.
    const resumed = await remote.resume(id);
    assert.equal(resumed.threadId, id);
    assert.equal(resumed.cwd, 'D:\\TMN');
    const continued = await remote.continueThread(id, 'Continue after compact; do not alter cwd.');
    assert.equal(continued.threadId, id);
    assert.equal(continued.turnId, 'turn-1');
    await waitUntil(async () => (await remote.status(id)).bridgeJob?.state === 'completed');
    const saved = JSON.parse(readFileSync(env.MOCK_CODEX_STORE, 'utf8')).threads[id];
    assert.equal(saved.compactCount, 1);
    assert.equal(saved.turns.length, 1);
    assert.equal(saved.cwd, 'D:\\TMN');
  } finally {
    await local.close();
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown thread must fail rather than silently start or switch project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magpie-codex-'));
  const c = new CodexAppServer({ command: process.execPath, args: [fake], env: { ...process.env, MOCK_CODEX_STORE: join(dir, 'threads.json') }, requestTimeoutMs: 1000 });
  try {
    await assert.rejects(() => c.resume('no-such-thread'), /Unknown thread/);
  } finally { await c.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('bridge rejects second operation on a busy thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magpie-codex-'));
  const c = new CodexAppServer({ command: process.execPath, args: [fake], env: { ...process.env, MOCK_CODEX_STORE: join(dir, 'threads.json') }, requestTimeoutMs: 1000 });
  try {
    const id = (await c.call('thread/start', {})).thread.id;
    await c.continueThread(id, 'A turn');
    await assert.rejects(() => c.compact(id), /active operation/);
  } finally { await c.close(); rmSync(dir, { recursive: true, force: true }); }
});
