import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProjectTools, projectSource, projectRoots, codexDesktopProjectRoots } from '../src/projects.mjs';
import { MagpieProjectReview } from '../index.mjs';

const base = mkdtempSync(path.join(tmpdir(), 'magpie-codex-only-'));
const root = path.join(base, 'project');
const other = path.join(base, 'second-workspace');
const state = path.join(base, 'codex-state.json');
mkdirSync(path.join(root, 'src'), {recursive:true});
mkdirSync(other);
writeFileSync(path.join(root, 'src', 'app.lua'), 'local hello = "world"\nprint(hello)\n');
writeFileSync(path.join(root, '.env'), 'PRIVATE_API_KEY=secret');
writeFileSync(path.join(root, 'secret.key'), 'private');
writeFileSync(path.join(base, 'outside.lua'), 'OUTSIDE');
symlinkSync(path.join(base, 'outside.lua'), path.join(root, 'linked.lua'));
execFileSync('git', ['init', '-q', root]);
const register = projects => writeFileSync(state, JSON.stringify({ 'local-projects': projects }));
register({ tmn: {name:'TMN',rootPaths:[root]} });
const cfg = (extras={}) => ({ codexStatePath: state, ...extras });
const tools = createProjectTools(cfg());

test('always uses Codex Desktop even with legacy Magpie projectSource and roots', async () => {
  assert.equal(projectSource({projectSource:'manual'}), 'codex');
  const r = JSON.parse(await createProjectTools(cfg({
    projectSource:'manual', rootsSource:'magpie-page',
    roots:[{name:'OldAccess',path:base}]
  })).projects());
  assert.deepEqual(r.projects.map(p=>p.name), ['TMN']);
  assert.equal(r.source, 'codex');
  assert.equal(r.readOnly, true);
  assert.ok(!JSON.stringify(r).includes(base));
  await assert.rejects(createProjectTools(cfg({roots:[{name:'OldAccess',path:base}]}))
    .read_file({project:'OldAccess',file:'outside.lua'}), /Unknown project/);
});

test('reading and search are scoped to validated Codex paths; secrets and symlinks rejected', async () => {
  const files = JSON.parse(await tools.list_files({project:'TMN'}));
  assert.deepEqual(files.entries.map(e=>e.name), ['src']);
  assert.match(JSON.parse(await tools.read_file({project:'TMN',file:'src/app.lua',startLine:2})).text, /2: print\(hello\)/);
  assert.equal(JSON.parse(await tools.search_text({project:'TMN',query:'hello'})).matches.length,2);
  for (const file of ['.env','secret.key','linked.lua','../outside.lua']) {
    await assert.rejects(tools.read_file({project:'TMN',file}));
  }
  const status = JSON.parse(await tools.git_status({project:'TMN'}));
  assert.equal(status.changes.some(x=>/\.env|key/.test(x)),false);
});

test('Git diff remains restricted to source files', async () => {
  execFileSync('git', ['-C',root,'-c','user.name=Tester','-c','user.email=t@example.com','add','src/app.lua']);
  execFileSync('git', ['-C',root,'-c','user.name=Tester','-c','user.email=t@example.com','commit','-qm','baseline']);
  writeFileSync(path.join(root,'src','app.lua'), 'local hello = "there"\n');
  const diff = JSON.parse(await tools.git_diff({project:'TMN',file:'src/app.lua'}));
  assert.match(diff.text, /there/);
});

test('Codex registry changes revoke old project access without relying on stale manual grants', async () => {
  const alt = path.join(base,'second-project');
  mkdirSync(alt);
  register({ second:{name:'Next',rootPaths:[alt]} });
  assert.deepEqual(JSON.parse(await tools.projects()).projects.map(p=>p.name),['Next']);
  await assert.rejects(tools.list_files({project:'TMN'}),/Unknown project/);
  register({tmn:{name:'TMN',rootPaths:[root]}});
});

test('fail closed when Codex registry is missing, invalid or contains a drive root', async () => {
  const missing = createProjectTools({codexStatePath:path.join(base,'missing.json'),
    projectSource:'manual', roots:[{name:'Old',path:root}]});
  await assert.rejects(missing.projects(),/Codex Desktop project registry not found/);
  const broken=path.join(base,'broken.json');
  writeFileSync(broken,'{"unrelated":true}');
  await assert.rejects(createProjectTools({codexStatePath:broken}).projects(),/no local-projects data/);
  register({bad:{name:'Drive',rootPaths:[path.parse(root).root]}, tmn:{name:'TMN',rootPaths:[root]}});
  assert.deepEqual(projectRoots(cfg()).map(x=>x.name),['TMN']);
  register({tmn:{name:'TMN',rootPaths:[root]}});
});

test('multi-root Codex projects stay grouped; missing roots and symlinks stay excluded', () => {
  register({first:{name:'Multi',rootPaths:[root,other,path.join(base,'missing')]}});
  const list=codexDesktopProjectRoots(cfg());
  assert.deepEqual(list.map(x=>x.name),['Multi / project','Multi / second-workspace']);
  assert.deepEqual(list[0].workspaceRoots,[root,other]);
  assert.deepEqual(list[1].workspaceRoots,[root,other]);
  register({tmn:{name:'TMN',rootPaths:[root]}});
});

test('Magpie MCP tools still register without granting Codex execution', async () => {
  const plugin=await MagpieProjectReview({},cfg({codexEnabled:false,remoteAutoStart:false}));
  assert.deepEqual(Object.keys(plugin.tool).sort(),[
    'chat_session_request_transfer','chat_session_status',
    'codex_ack_review','codex_cancel_task','codex_collab_start','codex_review_changes','codex_review_inbox',
    'codex_submit_task','codex_task_result','codex_task_status','codex_wait_task',
    'git_diff','git_status','list_files','projects','read_file','search_text',
  ]);
  const result=JSON.parse(await plugin.tool.codex_submit_task.execute({project:'TMN',prompt:'read only'}));
  const nativeResult=JSON.parse(await plugin.tool.codex_collab_start.execute({project:'TMN',goal:'Review'}));
  assert.equal(nativeResult.ok,false,'native starts remain separately permission gated');
  assert.match(nativeResult.error,/permission/i);
  assert.equal(result.ok,false);
  assert.match(result.error,/Codex is disabled/);
  const listing=JSON.parse(await plugin.tool.projects.execute({}));
  assert.equal(listing.codex.integrationVersion,'0.4.26-alpha.1');
  assert.equal(listing.codex.toolCount,17);
  assert.equal(listing.codex.allowWrites,false);
  assert.equal(listing.projects[0].name,'TMN');
  assert.ok(!JSON.stringify(listing).includes(base));
});

test('single permission selector is reflected in plugin diagnostics', async () => {
  const p=await MagpieProjectReview({},cfg({
    codexEnabled:true,codexPermissionMode:'codex-local',remoteAutoStart:false
  }));
  const data=JSON.parse(await p.tool.projects.execute({}));
  assert.equal(data.codex.allowWrites,true);
  assert.equal(data.codex.permissionMode,'codex-local');
  assert.equal(data.source,'codex');
});

test('MCP chat switch only stages a transfer even when Codex app-server is disabled', async () => {
  const before=process.env.MAGPIE_CHAT_SESSION_DIR;
  process.env.MAGPIE_CHAT_SESSION_DIR=path.join(base,'remote-chat-handoff');
  try {
    const plugin=await MagpieProjectReview({},cfg({codexEnabled:false,remoteAutoStart:false}));
    const url='https://chatgpt.com/c/12345678-1111-2222-3333-123456789012';
    const call=JSON.parse(await plugin.tool.chat_session_request_transfer.execute({
      project:'TMN',taskId:'tmn123',url,reason:'Switch chat'
    }));
    assert.equal(call.accepted,true);
    assert.equal(call.active,null,'ChatGPT cannot remotely activate a conversation');
    assert.equal(call.pending.url,url);
    const status=JSON.parse(await plugin.tool.chat_session_status.execute({project:'TMN'}));
    assert.equal(status.active,null);
    assert.equal(status.pending.requestId,call.pending.requestId);
    const refused=JSON.parse(await plugin.tool.chat_session_request_transfer.execute({
      project:'TMN',taskId:'other',url:'https://evil.example/c/12345678'
    }));
    assert.equal(refused.ok,false);
  } finally {
    if(before===undefined)delete process.env.MAGPIE_CHAT_SESSION_DIR;
    else process.env.MAGPIE_CHAT_SESSION_DIR=before;
  }
});

test('embedded page has no manual permission or directory picker', () => {
  const dir=path.dirname(fileURLToPath(import.meta.url));
  const html=readFileSync(path.join(dir,'..','page','index.html'),'utf8');
  const app=readFileSync(path.join(dir,'..','page','app.js'),'utf8');
  const pkg=JSON.parse(readFileSync(path.join(dir,'..','package.json'),'utf8'));
  assert.equal(pkg.magpie.page.file,'page/index.html');
  assert.doesNotMatch(html,/id="folder"|id="add"|id="revoke"|id="useCodexProjects"|id="codexAllowWrites"/);
  assert.match(html,/id="codexPermissionMode"/);
  assert.doesNotMatch(app,/fetch\(|XMLHttpRequest|child_process|execFile\(/);
  assert.match(app,/magpie\.options\.set/);
  assert.equal(existsSync(path.join(dir,'..','scripts','manage-projects.cmd')),false,'legacy picker executable was removed');
});
test.after(()=>rmSync(base,{recursive:true,force:true}));
