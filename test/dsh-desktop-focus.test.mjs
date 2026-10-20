import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDshDesktopFocus } from '../src/dsh-desktop-focus.mjs';

function fixture(platform='win32', options={agentLaunchEnabled:true}) {
  const calls=[];
  const focus=createDshDesktopFocus(options,{
    platform,
    spawn(file,args,opts) {
      calls.push({file,args,opts});
      const child=new EventEmitter();
      child.unref=()=>{};
      queueMicrotask(()=>child.emit('spawn'));
      return child;
    },
  });
  return {calls,focus};
}
test('Windows DSH Desktop focus passes only fixed official URI, no task data',async()=>{
  const {calls,focus}=fixture('win32');
  const r=JSON.parse(await focus({harness:'deepseekharness'}));
  assert.equal(r.state,'activation-requested');
  assert.equal(r.mode,'desktop');
  assert.equal(r.taskSubmitted,false);
  assert.equal(r.executionConfirmed,false);
  assert.deepEqual(calls[0].args,['dsh://open']);
  assert.equal(calls[0].file,'explorer.exe');
  assert.equal(calls[0].opts.shell,false);
});
test('macOS DSH Desktop focus uses OS open command',async()=>{
  const {calls,focus}=fixture('darwin');
  const r=JSON.parse(await focus({harness:'dsh'}));
  assert.equal(r.state,'activation-requested');
  assert.equal(calls[0].file,'open');
  assert.deepEqual(calls[0].args,['dsh://open']);
});
test('focus rejects other harness names and local-disabled launch without spawning',async()=>{
  const {calls,focus}=fixture('win32');
  await assert.rejects(focus({harness:'claude'}),/only available for DeepSeek/);
  assert.equal(calls.length,0);
  const inactive=fixture('win32',{agentLaunchEnabled:false});
  await assert.rejects(inactive.focus({harness:'dsh'}),/permission is disabled/);
  assert.equal(inactive.calls.length,0);
});
test('unsupported OS fails explicitly and cannot pretend to send a task',async()=>{
  const {calls,focus}=fixture('linux');
  await assert.rejects(focus({harness:'dsh'}),/Windows and macOS/);
  assert.equal(calls.length,0);
});
test('missing operating-system protocol handler is a non-success status',async()=>{
  const focus=createDshDesktopFocus({agentLaunchEnabled:true},{
    platform:'win32',
    spawn() {
      const child=new EventEmitter();
      queueMicrotask(()=>child.emit('error',Object.assign(new Error('not found'),{code:'ENOENT'})));
      return child;
    },
  });
  const r=JSON.parse(await focus({harness:'dsh'}));
  assert.equal(r.state,'activation-failed');
  assert.equal(r.taskSubmitted,false);
  assert.equal(r.executionConfirmed,false);
});
