import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {createNativeCollab,categorizeDesktopLaunchFailure,safeDesktopFailureDetails} from '../src/native-collab.mjs';

const base=mkdtempSync(path.join(tmpdir(),'magpie-desktop-diag-'));
const root=path.join(base,'TellMeNext');mkdirSync(root);
const project='tellmenext插件';
const chatUrl='https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';
const goal='Read-only original goal preserved';
const opts={codexEnabled:true,codexPermissionMode:'codex-local'};

test('process exit errors represented as numeric strings no longer collapse into unexpected-error',()=>{
  const error=Object.assign(new Error('Command failed with private sensitive tokens'),{
    code:'1',stderr:'SECRET_STDERR_PATH_PASSWORD',stdout:'SECRET_STDOUT'});
  assert.equal(categorizeDesktopLaunchFailure(error),'command-failed');
  assert.deepEqual(safeDesktopFailureDetails(error),{
    failureCategory:'command-failed',failureStage:'windows-launcher',
    failureCode:'1',exitStatus:null,failureKind:'Error'});
});
test('Node spawn and argument-length failures have distinct allowlisted categories',()=>{
  assert.equal(categorizeDesktopLaunchFailure({code:'E2BIG'}),'launcher-argument-too-long');
  assert.equal(categorizeDesktopLaunchFailure({code:'ENAMETOOLONG'}),'launcher-argument-too-long');
  assert.equal(categorizeDesktopLaunchFailure({code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}),'launcher-output-overflow');
  assert.equal(safeDesktopFailureDetails({code:'EACCES',name:'SystemError'}).failureCode,'EACCES');
  assert.equal(safeDesktopFailureDetails({code:1,name:'Error'}).exitStatus,1);
  assert.equal(safeDesktopFailureDetails({code:'BAD_BAD_SECRET',name:'SecretClass'}).failureCode,null);
  assert.equal(safeDesktopFailureDetails({code:'BAD_BAD_SECRET',name:'SecretClass'}).failureKind,'unknown');
});
test('failed remote Desktop startup records only code/stage/kind and does not retry without authorization',async()=>{
  const state=createChatSessions({projectRoots:()=>[{name:project,root,source:'codex'}],
    currentWorkspace:()=>root,folder:path.join(base,'sessions')});
  let attempts=0;
  const secret='UNIQUE_PRIVATE_WINDOWS_PATH_TEST';
  const codex=createNativeCollab(opts,{chatSessions:state,platform:'win32',
    openDesktop:async()=>{attempts++;const e=Error(secret);e.code='1';e.stderr=secret;throw e;}});
  const first=await codex.start({project,goal,chatUrl});
  assert.equal(first.status,'dispatch_failed');
  assert.equal(first.failureCategory,'command-failed');
  assert.equal(first.failureStage,'windows-launcher');
  assert.equal(first.failureCode,'1');
  assert.equal(first.confirmedExecution,false);
  const receipt=state.status(project);
  assert.equal(receipt.launch.failureCategory,'command-failed');
  assert.equal(receipt.launch.failureStage,'windows-launcher');
  assert.equal(receipt.launch.failureCode,'1');
  assert.equal(receipt.launch.failureKind,'Error');
  assert.ok(!JSON.stringify(first).includes(secret));
  assert.ok(!JSON.stringify(receipt).includes(secret));
  const repeated=await codex.start({project,goal,chatUrl,taskId:first.taskId});
  assert.equal(repeated.reused,true);
  assert.equal(repeated.failureStage,'windows-launcher');
  assert.equal(attempts,1);
});
test('explicit local recovery clears stale diagnosis without changing goal or URL',()=>{
 const state=createChatSessions({projectRoots:()=>[{name:project,root,source:'codex'}],
   currentWorkspace:()=>root,folder:path.join(base,'sessions')});
 const original=state.status(project).launch;
 const recovered=state.recoverLaunch({
   project,launchId:original.launchId,taskId:original.taskId,
   chatUrl,confirm:true});
 assert.equal(recovered.launch.status,'prepared');
 assert.equal(recovered.launch.failureCategory,null);
 assert.equal(recovered.launch.failureStage,null);
 assert.equal(recovered.launch.failureCode,null);
 assert.equal(recovered.launch.exitStatus,null);
 assert.equal(recovered.launch.recoveredFrom,original.launchId);
});
test.after(()=>rmSync(base,{recursive:true,force:true}));
