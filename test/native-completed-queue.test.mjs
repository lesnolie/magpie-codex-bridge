import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';

const url='https://chatgpt.com/c/abcdefab-1111-2222-3333-abcdefabcdef';
const threadId='7e65d563-4105-4d68-8e7a-767fd3c44326';

function fixture(){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'magpie-completed-launch-'));
  const root=path.join(base,'rotation');fs.mkdirSync(root);
  const folder=path.join(base,'sessions');
  const api=createChatSessions({
    folder,projectRoots:()=>[{name:'RotationLab',root,source:'codex'}],
    currentWorkspace:()=>root
  });
  function close(){fs.rmSync(base,{recursive:true,force:true});}
  function stateFile(){return path.join(folder,fs.readdirSync(folder).find(f=>f.endsWith('.json')));}
  function checkpoint(ticket,state){
    const a=api.status('RotationLab').active;
    return api.checkpoint({project:'RotationLab',taskId:ticket.taskId,
      generation:a.generation,iteration:1,protocolState:state,waitingFor:'none',
      goal:'test',progress:'done'});
  }
  function bindFirst(){
    const ticket=api.prepareLaunch({project:'RotationLab',goal:'Initial verification',chatUrl:url}).launch;
    api.updateLaunch({project:'RotationLab',launchId:ticket.launchId,status:'dispatching'});
    api.updateLaunch({project:'RotationLab',launchId:ticket.launchId,status:'opened_unconfirmed'});
    const pending=api.request({project:'RotationLab',taskId:ticket.taskId,url});
    api.activate({project:'RotationLab',requestId:pending.pending.requestId,observedUrl:url,verifiedProject:'RotationLab'});
    api.linkThread({project:'RotationLab',taskId:ticket.taskId,generation:1,threadId});
    checkpoint(ticket,'DONE');
    return ticket;
  }
  function queueTask(goal){
    const ticket=api.prepareLaunch({project:'RotationLab',goal,chatUrl:url}).launch;
    assert.equal(ticket.transport,'queue');
    api.updateLaunch({project:'RotationLab',launchId:ticket.launchId,status:'dispatching'});
    api.updateLaunch({project:'RotationLab',launchId:ticket.launchId,status:'queued_unconfirmed'});
    const pending=api.request({project:'RotationLab',taskId:ticket.taskId,url},true);
    api.activate({project:'RotationLab',requestId:pending.pending.requestId,observedUrl:url,verifiedProject:'RotationLab'});
    return ticket;
  }
  return {api,close,stateFile,checkpoint,bindFirst,queueTask};
}

test('checkpoint DONE reconciles only the matching queued native launch',()=>{
  const t=fixture();
  try{
    t.bindFirst();
    const ticket=t.queueTask('Video analysis');
    assert.equal(t.api.status('RotationLab').launch.status,'queued_unconfirmed');
    assert.throws(()=>t.api.prepareLaunch({project:'RotationLab',goal:'Next task',chatUrl:url}),/pending/);
    t.checkpoint(ticket,'DONE');
    assert.equal(t.api.status('RotationLab').launch.status,'acknowledged');
    const next=t.api.prepareLaunch({project:'RotationLab',goal:'Next task',chatUrl:url});
    assert.equal(next.reused,false);
    assert.notEqual(next.launch.launchId,ticket.launchId);
  }finally{t.close();}
});

test('legacy DONE with a stale queued receipt is reconciled on prepare',()=>{
  const t=fixture();
  try{
    t.bindFirst();
    const ticket=t.queueTask('Completed before fix');
    t.checkpoint(ticket,'DONE');
    const file=t.stateFile(),state=JSON.parse(fs.readFileSync(file,'utf8'));
    state.launch.status='queued_unconfirmed';
    fs.writeFileSync(file,JSON.stringify(state));
    const next=t.api.prepareLaunch({project:'RotationLab',goal:'New authorized goal',chatUrl:url});
    assert.equal(next.reused,false);
    assert.notEqual(next.launch.taskId,ticket.taskId);
    assert.equal(t.api.status('RotationLab').nativeThreadLinked,true);
  }finally{t.close();}
});

test('different-task DONE and unfinished checkpoints never clear a queued receipt',()=>{
  const t=fixture();
  try{
    t.bindFirst();
    const ticket=t.queueTask('Still executing');
    const file=t.stateFile(),state=JSON.parse(fs.readFileSync(file,'utf8'));
    state.checkpoint.protocolState='DONE';
    state.checkpoint.taskId='unrelated-task';
    fs.writeFileSync(file,JSON.stringify(state));
    assert.throws(()=>t.api.prepareLaunch({project:'RotationLab',goal:'Unsafe next goal',chatUrl:url}),/pending/);
    assert.equal(t.api.status('RotationLab').launch.status,'queued_unconfirmed');
    assert.equal(ticket.launchId,t.api.status('RotationLab').launch.launchId);
  }finally{t.close();}
});

test('BLOCKED also closes the matching receipt without impersonating execution',()=>{
  const t=fixture();
  try{
    t.bindFirst();
    const ticket=t.queueTask('Blocked task');
    t.checkpoint(ticket,'BLOCKED');
    assert.equal(t.api.status('RotationLab').launch.status,'blocked');
    assert.equal(t.api.prepareLaunch({project:'RotationLab',goal:'Allowed follow-up',chatUrl:url}).reused,false);
  }finally{t.close();}
});
