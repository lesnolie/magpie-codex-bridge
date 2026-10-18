import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishNativeSessionPreview} from '../src/native-session-preview.mjs';

const base=mkdtempSync(path.join(tmpdir(),'magpie-preview-'));
const target=path.join(base,'native-session-preview.js');
const secretUrl='https://chatgpt.com/c/secret-desktop-conversation';
const secretPath='C:/work/TellMeNext';
const projects=[
 {name:'tellmenext插件',root:secretPath,source:'codex'},
 {name:'tmn-updater',root:'C:/work/tmn-updater',source:'codex'},
 {name:'unsafe<script>alert(1)</script>',root:'C:/work/third',source:'codex'}
];
function parsePublished(){
 const source=readFileSync(target,'utf8');
 assert.ok(source.startsWith('globalThis.__magpieNativeSessionPreview='));
 assert.ok(source.endsWith(';\n'));
 assert.ok(!source.includes(secretPath));
 assert.ok(!source.includes(secretUrl));
 assert.ok(!source.includes('<script>'));
 return JSON.parse(source.slice('globalThis.__magpieNativeSessionPreview='.length,-2));
}
test('preview shows only registered project names and verified binding booleans',async()=>{
 const state=await publishNativeSessionPreview({
  roots:()=>projects,
  sessions:{status:name=>{
    if(name==='tellmenext插件')
      return {nativeThreadLinked:true,active:{url:secretUrl},nativeThreadId:'secret-uuid',root:secretPath};
    if(name==='tmn-updater')
      return {nativeThreadLinked:false,active:{url:secretUrl}};
    return {nativeThreadLinked:false,active:null};
  }},
  target
 });
 assert.equal(state.available,true);
 const snap=parsePublished();
 assert.deepEqual(snap.projects.map(p=>[p.name,p.bound,p.hasChat]),[
  ['tellmenext插件',true,true],
  ['tmn-updater',false,true],
  ['unsafe<script>alert(1)</script>',false,false]
 ]);
 assert.deepEqual(Object.keys(snap.projects[0]).sort(),['bound','hasChat','name']);
});
test('unavailable registry never fabricates an active project',async()=>{
 const snap=await publishNativeSessionPreview({
  roots:()=>{throw Error('secret path');},sessions:{status:()=>{throw Error('should not happen');}},target
 });
 assert.equal(snap.available,false);
 assert.equal(snap.projects.length,0);
 assert.equal(parsePublished().available,false);
});
test('status errors never reveal details or mark a thread verified',async()=>{
 await publishNativeSessionPreview({
  roots:()=>projects.slice(0,1),
  sessions:{status:()=>{throw Error(secretUrl+' '+secretPath);}},target
 });
 assert.equal(parsePublished().projects[0].bound,false);
});
test('Project Review separates auto Desktop workflow from optional standalone CLI diagnostic',()=>{
 const dir=path.dirname(fileURLToPath(import.meta.url));
 const html=readFileSync(path.join(dir,'..','page','index.html'),'utf8');
 const app=readFileSync(path.join(dir,'..','page','app.js'),'utf8');
 assert.match(html,/id="collabProjectCount"/);
 assert.match(html,/id="collabBoundCount"/);
 assert.match(html,/id="advancedCliDiagnostics"/);
 assert.match(html,/<details id="advancedCliDiagnostics"/);
 assert.match(html,/native-session-preview\.js/);
 assert.match(html,/仅限独立 CLI 诊断：选择被测项目/);
 assert.doesNotMatch(app,/cliProjects\.includes\('tmn-updater'\)/);
 assert.match(app,/item\.textContent=p\.name/);
 assert.doesNotMatch(app,/innerHTML\s*=/);
});
test.after(()=>rmSync(base,{recursive:true,force:true}));
