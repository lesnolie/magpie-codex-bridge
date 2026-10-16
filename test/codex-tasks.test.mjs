import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexTasks, classifyCodexStderr } from '../src/codex-tasks.mjs';
import { MagpieProjectReview } from '../index.mjs';

const mock = fileURLToPath(new URL('./mock-codex-app-server.mjs', import.meta.url));
const root = path.dirname(mock);
const config = (opts = {}) => createCodexTasks({ codexEnabled: true, ...opts }, {
  projectRoots: () => [{ name: 'Safe', root }],
  binary: process.execPath, args: [mock], reviewDir: false,
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Codex is opt-in and restricted to approved projects', async () => {
  const off = createCodexTasks({ codexEnabled: false }, { projectRoots: () => [{ name: 'Safe', root }] });
  assert.throws(() => off.submit({ project: 'Safe', prompt: 'hi' }), /disabled/);
  const on = config();
  assert.throws(() => on.submit({ project: 'Other', prompt: 'hi' }), /allowlist/);
  assert.throws(() => on.submit({ project: 'Safe', prompt: 'x'.repeat(12001) }), /12000/);
  const plugin = await MagpieProjectReview({}, {roots:[{name:'Safe',path:root}],rootsSource:'magpie-page',codexEnabled:true});
  assert.ok(plugin.tool.codex_submit_task);
  assert.ok(plugin.tool.codex_task_status);
  assert.ok(plugin.tool.codex_task_result);
  assert.ok(plugin.tool.codex_wait_task);
  assert.ok(plugin.tool.codex_review_inbox);
  assert.ok(plugin.tool.codex_review_changes);
  assert.ok(plugin.tool.codex_cancel_task);
  assert.ok(plugin.tool.projects);
});

test('mocked app-server handshake, turn and result over stdio', async () => {
  const jobs = config();
  const r = JSON.parse(jobs.submit({ project: 'Safe', prompt: 'mock' }));
  assert.equal(r.state, 'running');
  let result;
  for (let i = 0; i < 80; i++) {
    result = JSON.parse(jobs.result({ project: 'Safe', taskId: r.taskId }));
    if (result.state !== 'running') break;
    await pause(25);
  }
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.threadId, 'test-thread');
  assert.equal(result.turnId, 'test-turn');
  assert.match(result.output, /mock finished/);
  assert.throws(() => jobs.status({ project: 'Other', taskId: r.taskId }), /allowlist/);
  assert.throws(() => jobs.status({ project: 'Safe', taskId: 'invented' }), /Unknown task/);
});

test('startup diagnostics classify errors without echoing credentials or provider URL', () => {
  assert.match(classifyCodexStderr('error: unrecognized subcommand app-server'), /arguments incompatible/);
  assert.match(classifyCodexStderr('API_KEY=top-secret invalid api key'), /authentication failed/);
  assert.doesNotMatch(classifyCodexStderr('API_KEY=top-secret invalid api key'), /top-secret/);
  assert.match(classifyCodexStderr('invalid model_provider config.toml'), /model\/provider configuration/);
  assert.equal(classifyCodexStderr('http://secret.example/path'), null);
});

test('disabled Codex still fails before executable resolution', () => {
  const off = createCodexTasks({codexEnabled:false, codexExecutable:'X:/missing/codex.exe'},
    {projectRoots:()=>[{name:'Safe',root}]});
  assert.throws(()=>off.submit({project:'Safe',prompt:'check'}),/disabled/);
});

test('missing native executable yields helpful error and launch phase', async () => {
  const on=createCodexTasks({codexEnabled:true,codexExecutable:'/definitely/missing/codex.exe'},
    {projectRoots:()=>[{name:'Safe',root}],binary:'/definitely/missing/codex.exe'});
  const started=JSON.parse(on.submit({project:'Safe',prompt:'read only'}));
  let report;
  for(let i=0;i<60;i++){
    report=JSON.parse(on.result({project:'Safe',taskId:started.taskId}));
    if(report.state!=='running')break;
    await pause(20);
  }
  assert.equal(report.state,'failed');
  assert.equal(report.phase,'initialize');
  assert.match(report.error,/executable not found|ENOENT|Codex startup failed/i);
});
