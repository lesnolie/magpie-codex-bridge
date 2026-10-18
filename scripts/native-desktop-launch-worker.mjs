#!/usr/bin/env node
/**
 * One-shot native Codex Desktop launcher. NOT a Codex CLI/app-server worker.
 * Executed by the locally authorized plugin in a detached Node process so a
 * short-lived remote MCP request can safely return before PowerShell finishes.
 *
 * Only a previously prepared, locally persisted, same-project dispatching
 * ticket is accepted. No prompt, URL or workspace path travels in argv.
 */
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {desktopPrompt,desktopUrl,openCodexDesktop,safeDesktopFailureDetails} from '../src/native-collab.mjs';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export async function dispatchPendingDesktop({
  project,launchId,sessions=createChatSessions(),
  openDesktop=openCodexDesktop,platform=process.platform,
  permissionFile=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),
    'MagpieLocalReview','codex-remote-enabled.flag'),
  hasPermission=existsSync
}={}){
  if(platform!=='win32')throw Error('Windows Desktop worker only');
  if(typeof project!=='string'||!project||project.length>96||!UUID.test(launchId||''))
    throw Error('Invalid Desktop dispatch receipt');
  if(!hasPermission(permissionFile))throw Error('Local Codex permission revoked');
  // Reads the exact persisted ticket, never accepts project roots, prompts or
  // chat URLs from the detached process command line.
  const ticket=sessions.readDesktopDispatch({project,launchId});
  const prompt=desktopPrompt({
    project,goal:ticket.goal,chatUrl:ticket.chatUrl,
    taskId:ticket.taskId,launchId
  });
  let stage='building-uri';
  try{
    const url=desktopUrl(ticket.root,prompt);
    stage='windows-launcher';
    await openDesktop(url,{platform});
    sessions.updateLaunch({project,launchId,status:'opened_unconfirmed'});
    return {status:'opened_unconfirmed',confirmedExecution:false};
  }catch(error){
    const detail=safeDesktopFailureDetails(error,stage);
    sessions.updateLaunch({project,launchId,status:'dispatch_failed',...detail});
    return {status:'dispatch_failed',confirmedExecution:false,...detail};
  }
}

import {fileURLToPath} from 'node:url';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [project,launchId,...extra]=process.argv.slice(2);
  if(extra.length)process.exitCode=1;
  else{
    try{
      const result=await dispatchPendingDesktop({project,launchId});
      if(result.status!=='opened_unconfirmed')process.exitCode=1;
    }catch{
      // An invalid or revoked ticket must never open Codex or be silently
      // replaced. No sensitive goal/URL/path/error text is printed.
      process.exitCode=1;
    }
  }
}
