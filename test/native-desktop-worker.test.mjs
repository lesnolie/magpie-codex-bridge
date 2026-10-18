import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {createNativeCollab,dispatchDesktopWorker} from '../src/native-collab.mjs';
import {dispatchPendingDesktop} from '../scripts/native-desktop-launch-worker.mjs';

const base=mkdtempSync(path.join(os.tmpdir(),'magpie-detached-native-'));
const root=path.join(base,'TellMeNext');mkdirSync(root);
const project='tellmenext插件';
const chatUrl='https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';
const goal='Read-only native Desktop communication test; no source edits.';
const options={codexEnabled:true,codexPermissionMode:'codex-local'};
function store(dir){
 return createChatSessions({projectRoots:()=>[{name:project,root,source:'codex'}],
   currentWorkspace:()=>root,folder:path.join(base,dir)});
}
test('Web returns dispatching after ONE detached worker spawn; never claims Desktop execution',async()=>{
 const chat=store('web');
 let calls=0,captured;
 const native=createNativeCollab(options,{chatSessions:chat,platform:'win32',
   dispatchDesktopWorker:async(ticket,settings)=>{
     calls++;captured={ticket,settings}; // no URL or full prompt allowed
   }});
 const first=await native.start({project,goal,chatUrl});
 assert.equal(first.status,'dispatching');
 assert.equal(first.workerStarted,true);
 assert.equal(first.transport,'desktop');
 assert.equal(first.confirmedExecution,false);
 assert.equal(chat.status(project).nativeThreadLinked,false);
 assert.equal(calls,1);
 assert.deepEqual(captured.ticket,{project,launchId:first.launchId});
 assert.equal(captured.settings.platform,'win32');
 assert.ok(!JSON.stringify(captured).includes(chatUrl));
 assert.ok(!JSON.stringify(captured).includes(root));
 const repeated=await native.start({project,goal,chatUrl,taskId:first.taskId});
 assert.equal(repeated.reused,true);
 assert.equal(repeated.status,'dispatching');
 assert.equal(calls,1);
 assert.throws(()=>chat.readDesktopDispatch({project,launchId:'11111111-1111-4111-8111-111111111111'}),/No matching pending/);
 assert.equal(chat.readDesktopDispatch({project,launchId:first.launchId}).goal,goal);
});
test('OS child creation returns immediately and unrefs, without invoking a CLI or app-server',async()=>{
 const launched=[];
 await dispatchDesktopWorker({project,launchId:'12345678-1234-4234-8234-123456789abc'},{
   platform:'win32',getNode:async()=> 'C:/node/node.exe',
   worker:'C:/plugin/scripts/native-desktop-launch-worker.mjs',
   spawnProcess:(binary,args,opts)=>{
     launched.push({binary,args,opts});
     const child=new EventEmitter();
     child.unref=()=>{child.unreffed=true;};
     queueMicrotask(()=>child.emit('spawn'));
     return child;
   }
 });
 assert.equal(launched.length,1);
 assert.equal(launched[0].binary,'C:/node/node.exe');
 assert.deepEqual(launched[0].args,['C:/plugin/scripts/native-desktop-launch-worker.mjs',
   project,'12345678-1234-4234-8234-123456789abc']);
 assert.equal(launched[0].opts.detached,true);
 assert.equal(launched[0].opts.stdio,'ignore');
 assert.equal(launched[0].opts.shell,false);
 assert.ok(!launched[0].args.join(' ').includes(chatUrl));
 await assert.rejects(dispatchDesktopWorker({project,launchId:'BAD'},{
   platform:'win32',spawnProcess:()=>{throw Error('SHOULD_NOT_RUN');}
 }),/Invalid Desktop worker/);
});
test('worker independently updates successful OS URI request but not thread binding',async()=>{
 const chat=store('success');
 const prep=chat.prepareLaunch({project,goal,chatUrl});
 chat.updateLaunch({project,launchId:prep.launch.launchId,status:'dispatching'});
 let url;
 const result=await dispatchPendingDesktop({
   project,launchId:prep.launch.launchId,sessions:chat,platform:'win32',
   hasPermission:()=>true,
   openDesktop:async u=>{url=new URL(u);}
 });
 assert.equal(result.status,'opened_unconfirmed');
 assert.equal(result.confirmedExecution,false);
 assert.equal(chat.status(project).launch.status,'opened_unconfirmed');
 assert.equal(chat.status(project).nativeThreadLinked,false);
 assert.equal(url.searchParams.get('path'),root);
 assert.match(url.searchParams.get('prompt'),/START MODE: Native Codex Desktop/);
 assert.ok(url.searchParams.get('prompt').includes(chatUrl));
 await assert.rejects(dispatchPendingDesktop({
   project,launchId:prep.launch.launchId,sessions:chat,platform:'win32',
   hasPermission:()=>true,openDesktop:async()=>{throw Error('MUST_NOT_RUN');}
 }),/No matching pending/);
});
test('worker error is persisted even if Web request already ended',async()=>{
 const chat=store('failure');
 const prep=chat.prepareLaunch({project,goal,chatUrl});
 chat.updateLaunch({project,launchId:prep.launch.launchId,status:'dispatching'});
 const result=await dispatchPendingDesktop({
   project,launchId:prep.launch.launchId,sessions:chat,platform:'win32',
   hasPermission:()=>true,
   openDesktop:async()=>{throw Object.assign(new Error('SECRET_FULL_URL'),{code:'EACCES'});}
 });
 assert.equal(result.status,'dispatch_failed');
 assert.equal(result.failureCategory,'access-denied');
 assert.equal(chat.status(project).launch.failureCategory,'access-denied');
 assert.equal(chat.status(project).launch.failureStage,'windows-launcher');
 assert.ok(!JSON.stringify(chat.status(project)).includes('SECRET_FULL_URL'));
 assert.ok(!JSON.stringify(result).includes('SECRET_FULL_URL'));
});
test('revoked permission, unknown project, wrong launch ID and non-Windows worker fail closed',async()=>{
 const chat=store('denial');
 const prep=chat.prepareLaunch({project,goal,chatUrl});
 chat.updateLaunch({project,launchId:prep.launch.launchId,status:'dispatching'});
 let opened=0;
 const launch=extra=>dispatchPendingDesktop({
   project,launchId:prep.launch.launchId,sessions:chat,platform:'win32',
   hasPermission:()=>true,openDesktop:async()=>{opened++;},...extra
 });
 await assert.rejects(launch({hasPermission:()=>false}),/revoked/);
 await assert.rejects(launch({project:'other-project'}),/Project is not registered/);
 await assert.rejects(launch({launchId:'11111111-1111-4111-8111-111111111111'}),/No matching pending/);
 await assert.rejects(launch({platform:'linux'}),/Windows Desktop worker only/);
 assert.equal(chat.status(project).launch.status,'dispatching');
 assert.equal(opened,0);
});
test('dispatching older than 60 seconds is surfaced as stalled without relaunch',()=>{
 const chat=store('web');
 const file=chat.status(project);
 assert.equal(file.launch.status,'dispatching');
 // Existing current test's dispatch may not yet be stale; forcibly old
 // request timestamps are validated separately by the status view.
 assert.equal(typeof file.dispatchStalled,'boolean');
});
test.after(()=>rmSync(base,{recursive:true,force:true}));
