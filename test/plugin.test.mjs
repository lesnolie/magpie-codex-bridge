import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProjectTools, codexDesktopProjectRoots, projectSource } from '../src/projects.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { MagpieProjectReview } from '../index.mjs';

const base = mkdtempSync(path.join(tmpdir(), 'review-'));
const root = path.join(base, 'project');
mkdirSync(root);
mkdirSync(path.join(root, 'src'));
writeFileSync(path.join(root, 'src', 'app.lua'), 'local hello = "world"\nprint(hello)\n');
writeFileSync(path.join(root, '.env'), 'SECRET=password');
writeFileSync(path.join(root, 'secret.key'), 'private');
writeFileSync(path.join(base, 'outside.lua'), 'OUTSIDE');
symlinkSync(path.join(base, 'outside.lua'), path.join(root, 'linked.lua'));
execFileSync('git', ['init', '-q', root]);
const tools = createProjectTools({roots:[{name:'TMN',path:root}]});

test('lists configured projects only', async () => {
  const r = JSON.parse(await tools.projects());
  assert.equal(r.projects[0].name, 'TMN');
  assert.equal(r.readOnly, true);
  assert.equal(JSON.stringify(r).includes(base), false);
});
test('lists filtered files', async () => {
  const r = JSON.parse(await tools.list_files({project:'TMN'}));
  assert.deepEqual(r.entries.map(e => e.name), ['src']);
});
test('reads line-numbered source', async () => {
  const r = JSON.parse(await tools.read_file({project:'TMN',file:'src/app.lua',startLine:2}));
  assert.match(r.text, /2: print\(hello\)/);
});
test('rejects traversal and secrets', async () => {
  await assert.rejects(tools.read_file({project:'TMN',file:'../outside.lua'}));
  await assert.rejects(tools.read_file({project:'TMN',file:'.env'}));
  await assert.rejects(tools.read_file({project:'TMN',file:'secret.key'}));
  await assert.rejects(tools.read_file({project:'TMN',file:'linked.lua'}));
});
test('searches content without exposing secrets', async () => {
  const r = JSON.parse(await tools.search_text({project:'TMN',query:'hello'}));
  assert.equal(r.matches.length, 2);
  assert.equal(r.matches[0].file, 'src/app.lua');
});
test('checks Git status read-only', async () => {
  const r = JSON.parse(await tools.git_status({project:'TMN'}));
  assert.equal(r.changes.some(x=>x.includes('.env') || x.includes('key')), false);
});
test('cannot configure filesystem root', async () => {
  await assert.rejects(createProjectTools({roots:[path.parse(root).root]}).projects(), /filesystem root/);
});
test('Magpie registers stable Codex tool schemas without enabling execution', async () => {
  const p = await MagpieProjectReview({}, {roots:[{name:'TMN',path:root}], codexExecutable:'invalid-program'});
  assert.deepEqual(Object.keys(p.tool).sort(), [
    'codex_cancel_task','codex_review_changes','codex_review_inbox','codex_submit_task',
    'codex_task_result','codex_task_status','codex_wait_task',
    'git_diff','git_status','list_files','projects','read_file','search_text',
  ]);
  const response = JSON.parse(await p.tool.codex_submit_task.execute({project:'TMN',prompt:'read only'}));
  assert.equal(response.ok, false);
  assert.match(response.error, /Codex is disabled/);
  const projects = JSON.parse(await p.tool.projects.execute({}));
  assert.equal(projects.projects[0].name, 'TMN');
  assert.equal(projects.codex.integrationVersion, '0.4.5-alpha.1');
  assert.equal(projects.codex.toolsRegistered, true);
  assert.equal(projects.codex.toolCount, 13);
  assert.equal(projects.codex.localEnabled, false);
  assert.equal(projects.codex.allowWrites, false);
  assert.equal(projects.codex.remoteAutoStart, false);
  assert.equal(JSON.stringify(projects).includes(base), false);
  assert.equal('auth' in p, false);
  assert.equal('config' in p, false);
});

test('Codex diagnostic reports local opt-in without leaking paths', async () => {
  const p = await MagpieProjectReview({}, {
    roots: [{name:'TMN',path:root}],
    codexEnabled:true, codexAllowWrites:true, remoteAutoStart:false,
  });
  const info=JSON.parse(await p.tool.projects.execute({}));
  assert.equal(info.codex.localEnabled,true);
  assert.equal(info.codex.allowWrites,true);
  assert.equal(info.codex.remoteAutoStart,false);
  assert.equal(typeof info.codex.remoteGateEnabled,'boolean');
  assert.equal(JSON.stringify(info).includes(base),false);
});
test('single file git diff of committed change', async () => {
  execFileSync('git', ['-C',root,'-c','user.email=test@example.com','-c','user.name=Test','add','src/app.lua']);
  execFileSync('git', ['-C',root,'-c','user.email=test@example.com','-c','user.name=Test','commit','-qm','test']);
  writeFileSync(path.join(root, 'src', 'app.lua'), 'local hello = "there"\n');
  const r=JSON.parse(await tools.git_diff({project:'TMN',file:'src/app.lua'}));
  assert.match(r.text, /there/);
});



test('Codex project source lists saved Desktop projects instead of Magpie manual roots', async () => {
  const codexHome = path.join(base, 'codex-fixture');
  const state = path.join(codexHome, '.codex-global-state.json');
  mkdirSync(codexHome, { recursive:true });
  const alpha = path.join(base, 'Codex-A');
  const beta = path.join(base, 'Codex-B');
  mkdirSync(alpha);
  mkdirSync(beta);
  writeFileSync(path.join(alpha,'app.lua'), 'print("from Codex project")\n');
  writeFileSync(path.join(beta,'README.md'), 'Second Codex project\n');
  writeFileSync(state, JSON.stringify({
    'local-projects': {
      first: { id:'first', name:'Alpha', rootPaths:[alpha] },
      second: { id:'second', name:'Multi', rootPaths:[beta, root] },
      unused: { id:'unused', name:'Missing', rootPaths:[path.join(base,'removed')] },
      dangerous: { id:'dangerous', name:'Drive', rootPaths:[path.parse(alpha).root] },
    },
  }));
  assert.equal(projectSource({projectSource:'codex'}), 'codex');
  const discovered = codexDesktopProjectRoots({codexStatePath:state});
  assert.deepEqual(discovered.map(x=>x.name), ['Alpha','Multi / Codex-B','Multi / project']);
  const codex = createProjectTools({projectSource:'codex', codexStatePath:state,
    rootsSource:'magpie-page',roots:[{name:'ManuallyAdded',path:root}]});
  const listing=JSON.parse(await codex.projects());
  assert.equal(listing.source,'codex');
  assert.deepEqual(listing.projects.map(x=>x.name), ['Alpha','Multi / Codex-B','Multi / project']);
  assert.equal(listing.projects.every(x=>x.codexProject), true);
  assert.match(JSON.parse(await codex.read_file({project:'Alpha',file:'app.lua'})).text,/from Codex project/);
  await assert.rejects(codex.read_file({project:'ManuallyAdded',file:'src/app.lua'}),/Unknown project/);
  assert.equal(JSON.stringify(listing).includes(alpha), false, 'never expose full root paths');
  // Updated Codex registry takes effect immediately without duplicating a
  // project authorization or restarting the Magpie tool host.
  writeFileSync(state,JSON.stringify({'local-projects':{first:{name:'Renamed',rootPaths:[alpha]}}}));
  assert.deepEqual(JSON.parse(await codex.projects()).projects.map(x=>x.name), ['Renamed']);
  await assert.rejects(codex.read_file({project:'Alpha',file:'app.lua'}),/Unknown project/);
});

test('Codex source is fail-closed and never silently falls back to manual roots', async () => {
  const manual={name:'manual',path:root};
  const missing=createProjectTools({projectSource:'codex',codexStatePath:path.join(base,'missing.json'),roots:[manual]});
  await assert.rejects(missing.projects(),/Codex Desktop project registry not found/);
  const brokenState=path.join(base,'broken-codex.json');
  writeFileSync(brokenState,'{"otherSetting":true}');
  const broken=createProjectTools({projectSource:'codex',codexStatePath:brokenState,roots:[manual]});
  await assert.rejects(broken.projects(),/no local-projects data/);
});

test('native-picker config is applied live without restarting the plugin', async () => {
  const cfg = path.join(base, 'picker-projects.json');
  const dynamic = createProjectTools({ configPath: cfg });
  assert.deepEqual(JSON.parse(await dynamic.projects()).projects, []);
  writeFileSync(cfg, JSON.stringify({ roots: [{ name: 'Local', path: root }] }));
  assert.equal(JSON.parse(await dynamic.projects()).projects[0].name, 'Local');
  assert.equal(JSON.parse(await dynamic.read_file({ project: 'Local', file: 'src/app.lua' })).file, 'src/app.lua');
  writeFileSync(cfg, JSON.stringify({ roots: [] }));
  assert.deepEqual(JSON.parse(await dynamic.projects()).projects, []);
  await assert.rejects(dynamic.read_file({ project: 'Local', file: 'src/app.lua' }), /Unknown project/);
});

test('picker allowlist rejects arbitrary filesystem roots and invalid file content', async () => {
  const cfg = path.join(base, 'invalid-picker.json');
  const dynamic = createProjectTools({ configPath: cfg, roots: [{ name: 'Old', path: root }] });
  writeFileSync(cfg, JSON.stringify({ roots: [path.parse(root).root] }));
  await assert.rejects(dynamic.projects(), /filesystem root/);
  writeFileSync(cfg, JSON.stringify({ dangerous: true }));
  await assert.rejects(dynamic.projects(), /expected roots array/);
});

test('old inline options remain compatible before the picker is used', async () => {
  const cfg = path.join(base, 'not-created.json');
  const compat = createProjectTools({configPath: cfg, roots: [{ name: 'Old', path: root }]});
  assert.equal(JSON.parse(await compat.projects()).projects[0].name, 'Old');
});

test.after(()=>rmSync(base,{recursive:true,force:true}));


test('embedded Magpie page overrides a previously authorized Windows picker, including revoke all', async () => {
  const cfg = path.join(base, 'embedded-override.json');
  writeFileSync(cfg, JSON.stringify({ roots: [{ name: 'FromPicker', path: root }] }));
  const page = createProjectTools({ configPath: cfg, rootsSource: 'magpie-page', roots: [{ name: 'FromPage', path: root }] });
  assert.equal(JSON.parse(await page.projects()).projects[0].name, 'FromPage');
  await assert.rejects(page.read_file({ project: 'FromPicker', file: 'src/app.lua' }), /Unknown project/);
  const cleared = createProjectTools({ configPath: cfg, rootsSource: 'magpie-page', roots: [] });
  assert.deepEqual(JSON.parse(await cleared.projects()).projects, []);
  await assert.rejects(cleared.read_file({ project: 'FromPicker', file: 'src/app.lua' }), /Unknown project/);
});

test('embedded UI is bundled with the Magpie page bridge and options-only permissions', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.magpie.page.file, 'page/index.html');
  assert.deepEqual(pkg.magpie.permissions, ['models:list']);
  const html = readFileSync(path.join(root, 'page/index.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+bridge\\.js/);
  assert.ok(readFileSync(path.join(root, 'page/app.js'), 'utf8').includes("parentWindow.postMessage("));
  assert.match(html, /app\.js/);
  const js = readFileSync(path.join(root, 'page/app.js'), 'utf8');
  assert.match(js, /magpie\.options\.get/);
  assert.match(js, /magpie\.options\.set/);
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|shell|execFile\(/);
  assert.ok(existsSync(path.join(root, 'scripts/manage-projects.cmd')));
});
