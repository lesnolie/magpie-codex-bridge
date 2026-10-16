import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProjectTools } from '../src/projects.mjs';
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
test('cannot configure filesystem root', () => {
  assert.throws(()=>createProjectTools({roots:[path.parse(root).root]}));
});
test('Magpie plugin exposes six read-only tools, no provider', async () => {
  const p = await MagpieProjectReview({}, {roots:[{name:'TMN',path:root}]});
  assert.deepEqual(Object.keys(p.tool).sort(), ['git_diff','git_status','list_files','projects','read_file','search_text']);
  assert.equal('auth' in p, false);
  assert.equal('config' in p, false);
});
test('single file git diff of committed change', async () => {
  execFileSync('git', ['-C',root,'-c','user.email=test@example.com','-c','user.name=Test','add','src/app.lua']);
  execFileSync('git', ['-C',root,'-c','user.email=test@example.com','-c','user.name=Test','commit','-qm','test']);
  writeFileSync(path.join(root, 'src', 'app.lua'), 'local hello = "there"\n');
  const r=JSON.parse(await tools.git_diff({project:'TMN',file:'src/app.lua'}));
  assert.match(r.text, /there/);
});

test.after(()=>rmSync(base,{recursive:true,force:true}));
