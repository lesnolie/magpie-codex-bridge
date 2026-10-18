import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {createNativeCollab} from '../src/native-collab.mjs';

const base=mkdtempSync(path.join(tmpdir(),'magpie-stalled-dispatch-'));
const root=path.join(base,'TellMeNext');mkdirSync(root);
const project='tellmenext插件';
const chatUrl='https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';
const goal='Read-only original task. No source changes.';
const folder=path.join(base,'sessions');
const chat=createChatSessions({projectRoots:()=>[{name:project,root,source:'codex'}],
  currentWorkspace:()=>root,folder});
const opts={codexEnabled:true,codexPermissionMode:'codex-local'};
let count=0;
const native=createNativeCollab(opts,{chatSessions:chat,platform:'win32',
 dispatchDesktopWorker:async()=>{count++;}});
function aging(ms){
 const p=path.join(folder,readdirSync(folder).find(x=>x.endsWith('.json')));
 const s=JSON.parse(readFileSync(p,'utf8'));
 s.launch.updatedAt=new Date(Date.now()-ms).toISOString();
 writeFileSync(p,JSON.stringify(s));
}

test('stalled Desktop ticket is never implicitly retried',async()=>{
 const result=await native.start({project,goal,chatUrl});
 assert.equal(result.status,'dispatching');
 assert.equal(result.workerStarted,true);
 assert.equal(count,1);
 const args={project,goal,chatUrl,taskId:result.taskId,
   retryFailed:true,failedLaunchId:result.launchId};
 await assert.rejects(native.start(args),/no matching failed native Desktop launch/i);
 assert.equal(chat.status(project).dispatchStalled,false);
 aging(70000);
 assert.equal(chat.status(project).dispatchStalled,true);
 await assert.rejects(native.start({...args,confirmNoDesktop:true}),/recovery refused/i);
 assert.equal(count,1);
 aging(240000);
 assert.equal(chat.status(project).dispatchStalled,true);
 await assert.rejects(native.start(args),/no matching failed native Desktop launch/i);
 assert.equal(count,1);
});
test('explicit user-confirmed stale dispatch re-arms the same task exactly once',async()=>{
 const old=chat.status(project).launch;
 const args={project,goal,chatUrl,taskId:old.taskId,
   retryFailed:true,failedLaunchId:old.launchId,confirmNoDesktop:true};
 const accepted=await native.start(args);
 assert.equal(accepted.status,'dispatching');
 assert.equal(accepted.workerStarted,true);
 assert.notEqual(accepted.launchId,old.launchId);
 assert.equal(accepted.taskId,old.taskId);
 assert.equal(accepted.chatUrl,old.chatUrl);
 assert.equal(count,2);
 const state=chat.status(project);
 assert.equal(state.launch.recoveredFrom,old.launchId);
 assert.equal(state.launch.recoveredFromStatus,'dispatching');
 assert.equal(state.nativeThreadLinked,false);
 const replay=await native.start(args);
 assert.equal(replay.reused,true);
 assert.equal(replay.status,'dispatching');
 assert.equal(count,2);
 assert.equal(chat.status(project).launch.launchId,accepted.launchId);
});
test.after(()=>rmSync(base,{force:true,recursive:true}));
