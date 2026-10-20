/**
 * Best-effort activation of the official DeepSeek Harness Desktop shell.
 * The documented dsh://open URI only requests window focus.
 * It does NOT identify a session, deliver a task, or verify task execution.
 * No task text, conversation URL or remote executable path reaches the OS.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { normalizeHarness } from './peer-messages.mjs';

export function createDshDesktopFocus(options={}, dependencies={}) {
  const spawn=dependencies.spawn || nodeSpawn;
  const platform=dependencies.platform || process.platform;
  return async function focus({harness='dsh'}={}) {
    if(options.agentLaunchEnabled !== true)
      throw Error('Local native Harness launch permission is disabled');
    if(normalizeHarness(harness) !== 'dsh')
      throw Error('Desktop focus adapter is only available for DeepSeek Harness');
    const target='dsh://open';
    const spec=platform==='win32'
      ? {file:'explorer.exe',args:[target]}
      : platform==='darwin'
        ? {file:'open',args:[target]}
        : null;
    if(!spec) throw Error('DSH Desktop focus is currently supported on Windows and macOS only');
    return new Promise(resolve=>{
      let child;
      try {
        child=spawn(spec.file,spec.args,{
          shell:false,windowsHide:true,stdio:'ignore',
        });
      } catch {
        resolve(JSON.stringify({harness:'dsh',mode:'desktop',state:'activation-failed',
          taskSubmitted:false,executionConfirmed:false,
          reason:'Unable to invoke OS deep-link handler'}));
        return;
      }
      child.once('error',()=>resolve(JSON.stringify({
        harness:'dsh',mode:'desktop',state:'activation-failed',
        taskSubmitted:false,executionConfirmed:false,
        reason:'OS deep-link handler is unavailable',
      })));
      child.once('spawn',()=>{
        child.unref?.();
        resolve(JSON.stringify({
          harness:'dsh',mode:'desktop',state:'activation-requested',
          taskSubmitted:false,executionConfirmed:false,
          warning:'dsh://open requests focus only; Desktop does not accept a task or session ID from this link.',
        }));
      });
    });
  };
}
