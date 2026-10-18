import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {createNativeCollab,categorizeDesktopLaunchFailure} from '../src/native-collab.mjs';

const base=mkdtempSync(path.join(tmpdir(),'magpie-native-recovery-'));
const root=path.join(base,'tellmenext');mkdirSync(root);
const project='tellmenext插件';
const chatUrl='https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';
const goal='Read-only Desktop communication test; do not edit files.';
const chat=createChatSessions({
  projectRoots:()=>[{name:project,root,source:'codex'}],
  currentWorkspace:()=>root,folder:path.join(base,'sessions')
});
const opts={codexEnabled:true,codexPermissionMode:'codex-local'};
let attempts=0;
const broken=createNativeCollab(opts,{
  chatSessions:chat,
  platform:'win32',
  openDesktop:async()=>{attempts++;const error=Error('Command failed');error.code=1;error.stderr='Start-Process failed; https://chatgpt.com/c/PRIVATE_URL';throw error;}
});

test('desktop dispatch failure is retained without leaking stderr, URL in diagnostic field or executable',async()=>{
 const first=await broken.start({project,goal,chatUrl});
 assert.equal(first.status,'dispatch_failed');
 assert.equal(first.failureCategory,'protocol-handler-error');
 assert.equal(first.confirmedExecution,false);
 assert.equal(attempts,1);
 const persisted=chat.status(project);
 assert.equal(persisted.launch.status,'dispatch_failed');
 assert.equal(persisted.launch.failureCategory,'protocol-handler-error');
 assert.equal(persisted.nativeThreadLinked,false);
 assert.ok(!JSON.stringify(first).includes('PRIVATE_URL'));
 const again=await broken.start({project,goal,chatUrl});
 assert.equal(again.reused,true);
 assert.equal(attempts,1,'Web retry must not automatically relaunch Desktop');
});
test('local recovery rejects missing confirmation and any mismatched identifiers',()=>{
 const launch=chat.status(project).launch;
 const p={project,launchId:launch.launchId,taskId:launch.taskId,chatUrl};
 assert.throws(()=>chat.recoverLaunch({...p}),/confirm/i);
 assert.throws(()=>chat.recoverLaunch({...p,confirm:'true',launchId:'11111111-1111-4111-8111-111111111111'}),/matching failed launch/i);
 assert.throws(()=>chat.recoverLaunch({...p,confirm:'true',taskId:'wrong-task'}),/matching failed launch/i);
 assert.throws(()=>chat.recoverLaunch({...p,confirm:'true',chatUrl:'https://chatgpt.com/c/different-1111-2222-3333-444444444444'}),/matching failed launch/i);
 assert.equal(chat.status(project).launch.launchId,launch.launchId);
});
test('only local explicit recovery rotates launch nonce and enables precisely one renewed dispatch',async()=>{
 const old=chat.status(project).launch;
 const renewed=chat.recoverLaunch({...old,project,chatUrl,confirm:'true'});
 assert.equal(renewed.recovered,true);
 assert.equal(renewed.launch.status,'prepared');
 assert.notEqual(renewed.launch.launchId,old.launchId);
 assert.equal(renewed.launch.taskId,old.taskId);
 assert.equal(renewed.launch.chatUrl,chatUrl);
 assert.equal(renewed.launch.failureCategory,null);
 assert.throws(()=>chat.recoverLaunch({...old,project,chatUrl,confirm:'true'}),/matching failed launch/i);
 let sent=0;
 const working=createNativeCollab(opts,{chatSessions:chat,platform:'win32',openDesktop:async()=>{sent++;}});
 const restarted=await working.start({project,goal,chatUrl,taskId:old.taskId});
 assert.equal(restarted.status,'opened_unconfirmed');
 assert.equal(restarted.confirmedExecution,false,'open request is not execution');
 assert.equal(restarted.launchId,renewed.launch.launchId);
 assert.equal(sent,1);
 const duplicate=await working.start({project,goal,chatUrl});
 assert.equal(duplicate.reused,true);
 assert.equal(sent,1);
 assert.equal(chat.status(project).launch.status,'opened_unconfirmed');
});
test('failed queue and nonfailed Desktop launch cannot be rearmed by local recovery',()=>{
 const launch=chat.status(project).launch;
 assert.throws(()=>chat.recoverLaunch({...launch,project,chatUrl,confirm:'true'}),/matching failed launch/i);
});
test('failure categorization does not echo full URL or executable paths',()=>{
 assert.equal(categorizeDesktopLaunchFailure({code:'ENOENT',message:'sensitive'}),'launcher-not-found');
 assert.equal(categorizeDesktopLaunchFailure({code:'EACCES'}),'access-denied');
 assert.equal(categorizeDesktopLaunchFailure({code:'ETIMEDOUT'}),'launcher-timeout');
 assert.equal(categorizeDesktopLaunchFailure({code:1,stderr:'Start-Process : invalid https://chatgpt.com/c/PRIVATE'}),'protocol-handler-error');
 assert.equal(categorizeDesktopLaunchFailure({message:'Desktop deep link exceeds safe length'}),'invalid-uri');
 assert.equal(categorizeDesktopLaunchFailure({code:17,stderr:'UNRECOGNIZED SECRET'}),'command-failed');
});
test.after(()=>rmSync(base,{recursive:true,force:true}));
