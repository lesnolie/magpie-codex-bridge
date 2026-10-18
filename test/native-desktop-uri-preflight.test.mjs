import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {createNativeCollab,desktopPrompt,desktopUrl,describeDesktopUri,
  categorizeDesktopLaunchFailure} from '../src/native-collab.mjs';

const dir=mkdtempSync(path.join(tmpdir(),'magpie-uri-preflight-'));
const root=path.join(dir,'TellMeNext');mkdirSync(root);
const name='tellmenext插件';
const chatUrl='https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';
const projectRoots=()=>[{name,root,source:'codex'}];
const chat=createChatSessions({projectRoots,currentWorkspace:()=>root,folder:path.join(dir,'state')});
const collab=createNativeCollab({codexEnabled:true,codexPermissionMode:'codex-local'},
  {chatSessions:chat,projectRoots,platform:'win32',openDesktop:async()=>{throw Error('MUST_NOT_LAUNCH');}});

test('preflight inspects saved original goal without launching, sending, or exposing secrets',()=>{
 const secret='PRIVATE_GOAL_NOT_FOR_REMOTE_PREVIEW';
 const ticket=chat.prepareLaunch({project:name,chatUrl,goal:'Read only '+secret,taskId:'preflight-001'});
 const before=JSON.stringify(chat.status(name));
 const check=collab.diagnose({project:name});
 assert.equal(check.transport,'desktop');
 assert.equal(check.reason,'ready');
 assert.equal(check.valid,true);
 assert.ok(check.uriLength>check.promptLength);
 assert.equal(check.limit,8500);
 assert.equal(JSON.stringify(chat.status(name)),before);
 assert.ok(!JSON.stringify(check).includes(secret));
 assert.ok(!JSON.stringify(check).includes(root));
 assert.ok(!JSON.stringify(check).includes(chatUrl));
 assert.ok(!('goal' in check));
 assert.equal(ticket.launch.status,'prepared');
});
test('preflight catches encoded-length overrun and yields the same URI builder error code',()=>{
 const goal='数据库连接只读调试说明'.repeat(110);
 const args={project:name,chatUrl,goal,taskId:'diagnostic-length-001',launchId:'00000000-0000-4000-8000-000000000000'};
 const prompt=desktopPrompt(args);
 const diagnosis=describeDesktopUri(root,prompt);
 assert.equal(diagnosis.valid,false);
 assert.equal(diagnosis.reason,'url-too-long');
 assert.ok(diagnosis.uriLength>8500);
 assert.throws(()=>desktopUrl(root,prompt),err=>
   err.code==='DESKTOP_URL_TOO_LONG'&&
   categorizeDesktopLaunchFailure(err)==='url-too-long');
 assert.ok(!JSON.stringify(diagnosis).includes(goal));
});
test('preflight safely distinguishes invalid root, invalid prompt and valid short URI',()=>{
 assert.deepEqual(describeDesktopUri(null,'hello').reason,'invalid-project-root');
 assert.deepEqual(describeDesktopUri(root,null).reason,'invalid-prompt');
 assert.equal(describeDesktopUri(root,'hello').valid,true);
 const built=desktopUrl(root,'hello');
 assert.equal(new URL(built).searchParams.get('path'),root);
 assert.equal(new URL(built).searchParams.get('prompt'),'hello');
});
test('preflight works on an old failed launch without changing its task or launch ID',()=>{
 chat.updateLaunch({project:name,launchId:chat.status(name).launch.launchId,status:'dispatching'});
 chat.updateLaunch({project:name,launchId:chat.status(name).launch.launchId,status:'dispatch_failed',
   failureCategory:'unexpected-error',failureStage:'building-uri'});
 const before=chat.status(name);
 const result=collab.diagnose({project:name});
 const after=chat.status(name);
 assert.equal(result.reason,'ready');
 assert.deepEqual(after,before);
 assert.equal(after.launch.status,'dispatch_failed');
 assert.equal(after.nativeThreadLinked,false);
});
test.after(()=>rmSync(dir,{recursive:true,force:true}));
