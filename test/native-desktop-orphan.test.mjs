import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {createNativeCollab} from '../src/native-collab.mjs';

test('orphaned Desktop receipt permits a new explicit task but never replays the old task',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'magpie-orphan-'));
  try{
    const dir=path.join(base,'project'),folder=path.join(base,'state');
    fs.mkdirSync(dir);
    const roots=()=>[{name:'project',root:dir,source:'codex'}];
    const chat=createChatSessions({folder,projectRoots:roots,currentWorkspace:()=>dir});
    let opened=0;
    const collab=createNativeCollab({
      codexEnabled:true,codexPermissionMode:'codex-local',
      nativeDesktopAutoSendExperimental:true
    },{
      chatSessions:chat,projectRoots:roots,platform:'win32',
      openDesktop:async()=>{opened++;},
      desktopAutoSend:async()=> 'not-verified'
    });
    const url='https://chatgpt.com/c/abcdefab-1111-2222-3333-abcdefabcdef';
    const first=await collab.start({project:'project',goal:'Old test',chatUrl:url});
    assert.equal(first.status,'opened_unconfirmed');
    assert.equal(chat.status('project').launch.autoSubmit,'not-verified');
    assert.equal((await collab.start({project:'project',goal:'Old test',chatUrl:url})).reused,true);
    await assert.rejects(collab.start({project:'project',goal:'New explicit test',chatUrl:url}),/pending/);

    const state=path.join(folder,fs.readdirSync(folder).find(f=>f.endsWith('.json')));
    const json=JSON.parse(fs.readFileSync(state,'utf8'));
    json.launch.requestedAt='2020-01-01T00:00:00.000Z';
    json.launch.updatedAt='2020-01-01T00:00:00.000Z';
    fs.writeFileSync(state,JSON.stringify(json));

    assert.equal((await collab.start({project:'project',goal:'Old test',chatUrl:url})).reused,true);
    const fresh=await collab.start({project:'project',goal:'New explicit test',chatUrl:url});
    assert.notEqual(first.launchId,fresh.launchId);
    assert.notEqual(first.taskId,fresh.taskId);
    assert.equal(opened,2);
    assert.throws(()=>chat.request({project:'project',taskId:first.taskId,url}),/Stale Desktop launch/);
    assert.equal(chat.request({project:'project',taskId:fresh.taskId,url}).accepted,true);
    assert.equal(chat.status('project').nativeThreadLinked,false);
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('pending transfer prohibits superseding an old unbound Desktop ticket',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'magpie-orphan-pending-'));
  try{
    const root=path.join(dir,'project');fs.mkdirSync(root);
    const chat=createChatSessions({folder:path.join(dir,'state'),projectRoots:()=>[{name:'project',root,source:'codex'}],currentWorkspace:()=>root});
    const url='https://chatgpt.com/c/abcdefab-1111-2222-3333-abcdefabcdef';
    const first=chat.prepareLaunch({project:'project',goal:'First',chatUrl:url});
    chat.updateLaunch({project:'project',launchId:first.launch.launchId,status:'dispatching'});
    chat.updateLaunch({project:'project',launchId:first.launch.launchId,status:'opened_unconfirmed'});
    chat.request({project:'project',taskId:first.launch.taskId,url});
    const file=path.join(dir,'state',fs.readdirSync(path.join(dir,'state')).find(p=>p.endsWith('.json')));
    const record=JSON.parse(fs.readFileSync(file,'utf8'));
    record.launch.requestedAt='2020-01-01T00:00:00.000Z';
    fs.writeFileSync(file,JSON.stringify(record));
    assert.throws(()=>chat.prepareLaunch({project:'project',goal:'Other',chatUrl:url}),/pending/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
