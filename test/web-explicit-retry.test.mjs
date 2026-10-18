import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {createNativeCollab} from '../src/native-collab.mjs';

const dir=mkdtempSync(path.join(tmpdir(),'magpie-web-retry-'));
const root=path.join(dir,'TellMeNext');mkdirSync(root);
const project='tellmenext插件';
const chatUrl='https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';
const otherUrl='https://chatgpt.com/c/ab000000-aaaa-4444-8888-aaaaaaaaaaaa';
const goal='Read-only original task; no changes.';
const session=createChatSessions({projectRoots:()=>[{name:project,root,source:'codex'}],
  folder:path.join(dir,'sessions'),currentWorkspace:()=>root});
const opts={codexEnabled:true,codexPermissionMode:'codex-local'};
let requests=0;
const firstLauncher=createNativeCollab(opts,{chatSessions:session,platform:'win32',
  openDesktop:async()=>{requests++;throw Object.assign(new Error('Start-Process failed'),{code:1});}});
let first;
test('a normal remote first-launch fails and cannot silently re-launch',async()=>{
  first=await firstLauncher.start({project,goal,chatUrl});
  assert.equal(first.status,'dispatch_failed');
  assert.equal(first.transport,'desktop');
  assert.equal(first.confirmedExecution,false);
  assert.equal(requests,1);
  const again=await firstLauncher.start({project,goal,chatUrl,taskId:first.taskId});
  assert.equal(again.reused,true);
  assert.equal(again.status,'dispatch_failed');
  assert.equal(requests,1);
});
test('wrong failedLaunchId / original taskId / goal / ChatGPT URL refuse without state changes',async()=>{
  const launcher=createNativeCollab(opts,{chatSessions:session,platform:'win32',openDesktop:async()=>{requests++;}});
  const args={project,goal,chatUrl,taskId:first.taskId,retryFailed:true,failedLaunchId:first.launchId};
  await assert.rejects(launcher.start({...args,failedLaunchId:'99999999-9999-4999-8999-999999999999'}),/failedLaunchId/);
  await assert.rejects(launcher.start({...args,taskId:'wrong-task'}),/task|retry/i);
  await assert.rejects(launcher.start({...args,goal:'a different goal'}),/different native Codex launch/i);
  await assert.rejects(launcher.start({...args,chatUrl:otherUrl}),/different native Codex launch/i);
  const normal=await launcher.start({...args,retryFailed:false});
  assert.equal(normal.status,'dispatch_failed');
  assert.equal(normal.reused,true);
  assert.equal(session.status(project).launch.launchId,first.launchId);
  assert.equal(requests,1);
});
test('explicit Web retry rotates launch nonce and dispatches the same Desktop task only once',async()=>{
  const opened=[];
  const launcher=createNativeCollab(opts,{chatSessions:session,platform:'win32',
    openDesktop:async(url)=>{opened.push(new URL(url));requests++;}});
  const args={project,goal,chatUrl,taskId:first.taskId,retryFailed:true,failedLaunchId:first.launchId};
  const result=await launcher.start(args);
  assert.equal(result.status,'opened_unconfirmed');
  assert.equal(result.transport,'desktop');
  assert.notEqual(result.launchId,first.launchId);
  assert.equal(result.taskId,first.taskId);
  assert.equal(result.chatUrl,chatUrl);
  assert.equal(result.confirmedExecution,false);
  assert.equal(opened.length,1);
  assert.equal(opened[0].searchParams.get('path'),root);
  assert.match(opened[0].searchParams.get('prompt'),/START MODE: Native Codex Desktop/);
  assert.equal(requests,2);
  const repeat=await launcher.start(args);
  assert.equal(repeat.reused,true);
  assert.equal(repeat.status,'opened_unconfirmed');
  assert.equal(opened.length,1);
  const normal=await launcher.start({project,goal,chatUrl,taskId:first.taskId});
  assert.equal(normal.reused,true);
  assert.equal(opened.length,1);
  assert.equal(session.status(project).nativeThreadLinked,false);
});
test('in-progress ticket cannot be retried with newly observed launch id',async()=>{
  const launcher=createNativeCollab(opts,{chatSessions:session,platform:'win32',
    openDesktop:async()=>{requests++;}});
  const launch=session.status(project).launch;
  await assert.rejects(launcher.start({project,goal,chatUrl,taskId:first.taskId,
    retryFailed:true,failedLaunchId:launch.launchId}),/no matching failed native Desktop launch/i);
  assert.equal(requests,2);
});
test.after(()=>rmSync(dir,{recursive:true,force:true}));
