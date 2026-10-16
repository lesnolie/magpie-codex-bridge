import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createCodexTasks } from '../src/codex-tasks.mjs';
import { gitBaseline, reviewChanges, readReviewReceipt } from '../src/codex-review.mjs';

const mock = fileURLToPath(new URL('./mock-codex-app-server.mjs', import.meta.url));
const execute = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

async function project(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'magpie-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  const reviewDir = path.join(dir, 'receipts');
  await mkdir(path.join(root, 'src'), { recursive: true });
  execute(root, 'init', '-q');
  execute(root, 'config', 'user.name', 'Local Test');
  execute(root, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(root, 'src', 'main.lua'), 'return true\n');
  await writeFile(path.join(root, '.env'), 'PRIVATE_API_KEY=secret value\n');
  execute(root, 'add', '.');
  execute(root, 'commit', '-qm', 'baseline');
  return { root, reviewDir };
}
function worker(root, reviewDir) {
  return createCodexTasks({ codexEnabled: true }, {
    binary: process.execPath, args: [mock], reviewDir,
    projectRoots: () => [{ name: 'Safe', root }],
  });
}

test('same-chat wait automatically returns finished Codex result without repeated manual status commands', async t => {
  const { root, reviewDir } = await project(t);
  const jobs = worker(root, reviewDir);
  const submitted = JSON.parse(jobs.submit({ project: 'Safe', prompt: 'Read source only.' }));
  const result = JSON.parse(await jobs.wait({ project: 'Safe', taskId: submitted.taskId, waitMs: 5000 }));
  assert.equal(result.state, 'completed');
  assert.equal(result.needsReview, true);
  assert.match(result.output, /mock finished/);
  const receipt = await readReviewReceipt(reviewDir, submitted.taskId);
  assert.equal(receipt.project, 'Safe');
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.baselineHead, execute(root, 'rev-parse', 'HEAD'));
  assert.equal(receipt.prompt, undefined, 'never persist task prompt');
});

test('review inbox survives task runner restart, only lists approved project and returns bounded Git diff', async t => {
  const { root, reviewDir } = await project(t);
  const first = worker(root, reviewDir);
  const task = JSON.parse(first.submit({ project: 'Safe', prompt: 'Check architecture' }));
  await first.wait({ project: 'Safe', taskId: task.taskId, waitMs: 5000 });
  await writeFile(path.join(root, 'src', 'main.lua'), 'return false\n');
  await writeFile(path.join(root, '.env'), 'PRIVATE_API_KEY=DO_NOT_DISCLOSE\n');
  const restarted = worker(root, reviewDir);
  const inbox = JSON.parse(await restarted.inbox({ project: 'Safe' }));
  assert.equal(inbox.total, 1);
  assert.equal(inbox.tasks[0].taskId, task.taskId);
  assert.equal(inbox.tasks[0].needsReview, true);
  const fromHistory = JSON.parse(await restarted.wait({ project: 'Safe', taskId: task.taskId }));
  assert.equal(fromHistory.state, 'completed');
  const review = JSON.parse(await restarted.changes({ project: 'Safe', taskId: task.taskId }));
  assert.equal(review.reviewable, true);
  assert.ok(review.changedFiles.includes('src/main.lua'));
  assert.ok(review.reviewableFiles.includes('src/main.lua'));
  assert.doesNotMatch(review.diff, /DO_NOT_DISCLOSE|PRIVATE_API_KEY/);
  assert.match(review.diff, /return false/);
  assert.ok(!review.changedFiles.includes('.env'));
  await assert.rejects(restarted.changes({ project: 'Safe', taskId: task.taskId, file: '.env' }), /not a reviewable changed source file/);
  await assert.rejects(restarted.inbox({ project: 'Other' }), /allowlist/);
  await assert.rejects(restarted.wait({ project: 'Other', taskId: task.taskId }), /allowlist/);
});

test('review detects an initially dirty repository and warns about attribution', async t => {
  const { root } = await project(t);
  const baseline = await gitBaseline(root);
  await writeFile(path.join(root, 'src', 'main.lua'), 'return 42\n');
  const report = await reviewChanges(root, {
    state: 'completed', baselineHead: baseline.head, baselineDirty: true,
  });
  assert.equal(report.attribution, 'worktree-was-dirty-before-task');
  assert.match(report.diff, /return 42/);
});

test('working without an initial Git commit fails closed rather than inventing a diff', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'magpie-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await reviewChanges(dir, { state: 'completed', baselineHead: null });
  assert.equal(result.reviewable, false);
  assert.equal(result.baselineHead, null);
});
