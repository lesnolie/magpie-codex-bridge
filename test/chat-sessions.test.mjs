import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChatSessions, normalizeChatUrl, nativeCodexProjectRoots } from '../skills/magpie-codex-collab/chat-session.mjs';

const base=fs.mkdtempSync(path.join(os.tmpdir(),'magpie-chat-handoff-'));
const root=path.join(base,'TMN'),other=path.join(base,'Other');
fs.mkdirSync(root);fs.mkdirSync(other);
const entries=[{name:'TMN',root,source:'codex'},{name:'Other',root:other,source:'codex'}];
const stateDir=path.join(base,'sessions');
const api=createChatSessions({folder:stateDir,projectRoots:()=>entries,currentWorkspace:()=>root});
const chat1='https://chatgpt.com/c/abcdefab-1111-2222-3333-abcdefabcdef';
const chat2='https://chatgpt.com/c/abcdefab-aaaa-bbbb-cccc-abcdefabcdef';
const id='tmn.task_001';

test('normalizes supported ChatGPT chat URLs and rejects unsafe or ambiguous paths',()=>{
  assert.equal(normalizeChatUrl(chat1+'/'),chat1);
  assert.equal(normalizeChatUrl('https://chatgpt.com/g/g-p-abcdef123/c/abcdefab-1111-2222-3333-abcdefabcdef'),
    'https://chatgpt.com/g/g-p-abcdef123/c/abcdefab-1111-2222-3333-abcdefabcdef');
  for(const v of [
    'https://evil.chatgpt.com/c/abcdefab-1111-2222-3333-abcdefabcdef',
    'http://chatgpt.com/c/abcdefab-1111-2222-3333-abcdefabcdef',
    'https://chatgpt.com/c/abc?payload=1',
    'https://chatgpt.com/',
    'https://chatgpt.com/g/g-p-abcdef/project',
    'https://chatgpt.com/c/abcdefab-1111-2222-3333-abcdefabcdef#injected',
    'https://chatgpt.com@evil.com/c/abcdefab-1111-2222-3333-abcdefabcdef',
    'https://chatgpt.com/redirect?url='+encodeURIComponent(chat1),
  ])assert.throws(()=>normalizeChatUrl(v));
});

test('remote transfer request only stages: pending never replaces active chat',()=>{
  assert.equal(api.status('TMN').active,null);
  const q=api.request({project:'TMN',taskId:id,url:chat1});
  assert.ok(q.pending.requestId);
  assert.equal(q.active,null);
  assert.equal(api.status('TMN').active,null);
  assert.equal(api.request({project:'TMN',taskId:id,url:chat1}).pending.requestId,q.pending.requestId,
    'retry must not generate another request');
  assert.throws(()=>api.activate({project:'TMN',requestId:q.pending.requestId,
    observedUrl:chat2,verifiedProject:'TMN'}),/differs/);
  assert.throws(()=>api.activate({project:'TMN',requestId:q.pending.requestId,
    observedUrl:chat1,verifiedProject:'Other'}),/verify/);
  const verified=api.activate({project:'TMN',requestId:q.pending.requestId,
    observedUrl:chat1,verifiedProject:'TMN'});
  assert.equal(verified.active.url,chat1);
  assert.equal(verified.active.generation,1);
  assert.equal(verified.pending,null);
  assert.throws(()=>api.activate({project:'TMN',requestId:q.pending.requestId,
    observedUrl:chat1,verifiedProject:'TMN'}),/not found/);
});

test('checkpoint is generation-gated; only a verified transfer can replace a chat',()=>{
  const initial=api.status('TMN');
  const c=api.checkpoint({project:'TMN',taskId:id,generation:1,iteration:4,
    protocolState:'EXECUTED_SENT',waitingFor:'GPT_REVIEW',goal:'Refactor core',
    progress:'Changed src/lib.ts and tests',issues:'Check test failures',
    nextStep:'Review latest diff'});
  assert.equal(c.checkpoint.iteration,4);
  assert.equal(api.handoff({project:'TMN'}).handoff.includes('Review latest diff'),true);
  const staged=api.request({project:'TMN',taskId:id,url:chat2,reason:'Long chat'});
  assert.equal(api.status('TMN').active.url,chat1);
  assert.equal(staged.pending.url,chat2);
  assert.throws(()=>api.request({project:'TMN',taskId:'other.task',url:chat2}),/Different active task/);
  assert.equal(api.status('TMN').active.url,chat1);
  const active=api.activate({project:'TMN',requestId:staged.pending.requestId,
    observedUrl:chat2,verifiedProject:'TMN'});
  assert.equal(active.previousUrl,chat1);
  assert.equal(active.active.generation,2);
  assert.equal(active.checkpoint.iteration,4,'switch should preserve current task');
  assert.throws(()=>api.checkpoint({project:'TMN',taskId:id,generation:1,iteration:5,
    protocolState:'DONE',waitingFor:'none'}),/Stale task/);
  assert.equal(api.status('TMN').checkpoint.protocolState,'EXECUTED_SENT');
  api.checkpoint({project:'TMN',taskId:id,generation:2,iteration:5,
    protocolState:'DONE',waitingFor:'none',goal:'Refactor core',progress:'Review passed'});
});

test('only a native local prepare can start a different task after DONE',()=>{
  assert.throws(()=>api.request({project:'TMN',taskId:'tmn.task_002',url:chat1}),
    /Different active task/);
  const prepared=api.request({project:'TMN',taskId:'tmn.task_002',url:chat1},true);
  assert.equal(prepared.active.taskId,id,'old task remains current until activation');
  assert.equal(prepared.pending.taskId,'tmn.task_002');
  const switched=api.activate({project:'TMN',requestId:prepared.pending.requestId,
    observedUrl:chat1,verifiedProject:'TMN'});
  assert.equal(switched.active.taskId,'tmn.task_002');
  assert.equal(switched.checkpoint.iteration,0,'new task must not inherit old progress');
  assert.equal(switched.checkpoint.protocolState,'INIT');
});

test('project scoping: same task IDs cannot cross projects or access stale roots',()=>{
  const otherBound=api.request({project:'Other',taskId:id,url:chat1});
  assert.equal(api.status('TMN').active.url,chat1);
  assert.equal(api.status('Other').active,null);
  assert.throws(()=>api.activate({project:'TMN',requestId:otherBound.pending.requestId,
    observedUrl:chat1,verifiedProject:'TMN'}),/not found/);
  assert.throws(()=>api.status('NoSuchProject'),/not registered/);
  assert.throws(()=>api.request({project:'NoSuchProject',taskId:id,url:chat1}),/not registered/);
});

test('session stored outside project and contains no control token or file body',()=>{
  const files=fs.readdirSync(stateDir).filter(x=>x.endsWith('.json'));
  assert.ok(files.length>=2);
  assert.equal(fs.readdirSync(root).length,0);
  const contents=files.map(x=>fs.readFileSync(path.join(stateDir,x),'utf8')).join('\n');
  assert.ok(!contents.includes(root),'absolute project paths never persisted');
  assert.ok(!contents.includes('sk-'));
  assert.ok(contents.includes(chat1));
});

test('native CLI sees same persisted state using Codex project registry',()=>{
  const codexHome=path.join(base,'codex-home');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome,'.codex-global-state.json'),JSON.stringify({
    'local-projects':{tmn:{name:'TMN',rootPaths:[root]},other:{name:'Other',rootPaths:[other]}}
  }));
  const exe=fileURLToPath(new URL('../skills/magpie-codex-collab/chat-session.mjs',import.meta.url));
  const proc=spawnSync(process.execPath,[exe,'status','--project','TMN'],{
    env:{...process.env,CODEX_HOME:codexHome,MAGPIE_CHAT_SESSION_DIR:stateDir},encoding:'utf8'
  });
  assert.equal(proc.status,0,proc.stderr);
  assert.equal(JSON.parse(proc.stdout).active.url,chat1);
  assert.equal(JSON.parse(proc.stdout).checkpoint.protocolState,'INIT');
});

test('without Codex Desktop project registration, no manual grant fallback',()=>{
  const unavailable=createChatSessions({folder:stateDir,projectRoots:()=>[]});
  assert.throws(()=>unavailable.status('TMN'),/not registered/);
  assert.throws(()=>unavailable.request({project:'TMN',taskId:id,url:chat1}),/not registered/);
});
test.after(()=>fs.rmSync(base,{recursive:true,force:true}));
