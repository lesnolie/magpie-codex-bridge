import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexTasks, classifyCodexStderr, buildCodexThreadConfig } from '../src/codex-tasks.mjs';
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
  assert.ok(plugin.tool.codex_ack_review);
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

test('Codex Desktop multi-root project adds only sibling roots to the workspace sandbox', () => {
  const one=path.join(root,'one'), two=path.join(root,'two');
  const base = {root:one, name:'One', source:'codex',
    workspaceRoots:[one,two,two]};
  const {config,mode,additionalWorkspaceCount}=buildCodexThreadConfig(
    {projectSource:'codex',codexAllowWrites:true},base);
  assert.equal(mode,'workspace-write');
  assert.equal(config.sandbox,'workspace-write');
  assert.deepEqual(config.config.sandbox_workspace_write.writable_roots,[two]);
  assert.equal(config.config.sandbox_workspace_write.network_access,false);
  assert.equal(additionalWorkspaceCount,1);
  assert.doesNotMatch(config.developerInstructions,/danger-full-access/);
});

test('Codex Desktop inherited permission setting is local-only and never expands manual projects or read-only tasks', () => {
  const one=path.join(root,'one'),two=path.join(root,'two');
  const base={root:one,source:'codex',workspaceRoots:[one,two]};
  const yes=buildCodexThreadConfig({projectSource:'codex',codexAllowWrites:true,
    codexInheritPermissions:true},base);
  assert.equal(yes.mode,'codex-local');
  assert.equal('sandbox' in yes.config,false,'Codex CLI settings determine the actual sandbox');
  assert.equal(yes.config.approvalPolicy,'never','Never auto-approve escalation');
  assert.equal('config' in yes.config,false,'Do not silently override the native permission profile');

  const noWrite=buildCodexThreadConfig({projectSource:'codex',codexAllowWrites:false,
    codexInheritPermissions:true},base);
  assert.equal(noWrite.mode,'read-only');
  assert.equal(noWrite.config.sandbox,'read-only');
  assert.equal('config' in noWrite.config,false);

  const manual=buildCodexThreadConfig({projectSource:'manual',codexAllowWrites:true,
    codexInheritPermissions:true},{root:path.join(root,'manual'),source:'manual'});
  assert.equal(manual.mode,'workspace-write');
  assert.equal(manual.config.sandbox,'workspace-write');
  assert.equal('config' in manual.config,false);
});
