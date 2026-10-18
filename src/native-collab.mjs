/**
 * ChatGPT -> native Codex Desktop handoff. No app-server is required.
 *
 * One remote MCP call may open a prefilled Codex Desktop composer, or queue a
 * message to a previously LOCAL-verified, project-matched Codex thread.
 * Neither mechanism proves the agent has begun work. Do not auto-retry.
 */
import { execFile as nativeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createChatSessions } from '../skills/magpie-codex-collab/chat-session.mjs';
import { projectRoots } from './projects.mjs';
import { resolveCodexBinary, resolveCodexPermissionMode } from './codex-tasks.mjs';

const execFile=promisify(nativeExecFile);

function fail(reason){throw new Error(reason);}
function response(ticket,status,extra={}){
  return {
    project:ticket.project,taskId:ticket.launch?.taskId,
    launchId:ticket.launch?.launchId,chatUrl:ticket.launch?.chatUrl,
    status,transport:ticket.launch?.transport,
    activeChatUnchanged:true,confirmedExecution:false,
    ...extra
  };
}
export function desktopPrompt({project,goal,chatUrl,taskId,launchId}){
  const instructions=[
    '$magpie-codex-collab',
    'START MODE: Native Codex Desktop, not Magpie app-server.',
    'PROJECT: '+project,
    'TASK_ID: '+taskId,
    'LAUNCH_ID: '+launchId,
    'TARGET_CHAT: '+chatUrl,
    '',
    'Follow the installed magpie-codex-collab Skill. IMPORTANT:',
    '1. First open EXACT TARGET_CHAT in ONE Codex-managed ChatGPT tab.',
    '2. Ask ChatGPT there to verify this same project using Magpie MCP projects and read_file.',
    '3. Only after the verification, run local chat-session prepare/activate for this TASK_ID and TARGET_CHAT.',
    '4. Do not assume the deep link started a turn. Do not use another ChatGPT chat.',
    '5. After pairing, run the requested native Codex work and report EXECUTED for ChatGPT code review.',
    '',
    'USER GOAL:',
    goal
  ];
  return instructions.join('\n');
}
export function desktopUrl(projectRoot,prompt){
  if(typeof projectRoot!=='string'||!projectRoot||typeof prompt!=='string')fail('Invalid native Codex launch');
  const u=new URL('codex://threads/new');
  u.searchParams.set('path',projectRoot);
  u.searchParams.set('prompt',prompt);
  if(u.toString().length>8500)fail('Desktop deep link exceeds safe length');
  return u.toString();
}
// Windows uses the already registered codex:// URI handler. Windows may open
// only the prompt composer, not submit it. Shell=false and no string interpolation
// into an unquoted PowerShell command; URL is a separately encoded literal.
export async function openCodexDesktop(url,{platform=process.platform,run=execFile}={}){
  if(platform!=='win32')fail('Automatic native Desktop opening currently supports Windows only');
  if(typeof url!=='string'||!url.startsWith('codex://threads/new?'))fail('Invalid Codex Desktop link');
  const script="$ErrorActionPreference='Stop';Start-Process -FilePath '"+url.replace(/'/g,"''")+"'";
  await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64')],{
    windowsHide:true,timeout:15000,maxBuffer:16*1024
  });
}
export async function queueToNativeThread(threadId,prompt,{binary='codex.exe',run=execFile}={}){
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(threadId||''))fail('Invalid verified Codex thread ID');
  await run(binary,['queue','--thread',threadId,'--message',prompt],{
    shell:false,windowsHide:true,timeout:16000,maxBuffer:8*1024
  });
}

// Experimental native Codex CLI backend. Does not use app-server.
// CLI stdout/stderr are deliberately not returned to remote MCP clients.
export async function launchNativeCli({binary,root,prompt,sandbox='workspace-write',
  approval=null,timeout=180000,run=execFile}={}){
  if(!root||!prompt||!binary)fail('Missing native CLI project, binary or prompt');
  if(!['read-only','workspace-write'].includes(sandbox))fail('Invalid CLI sandbox');
  if(approval!==null&&approval!=='never')fail('Invalid CLI approval policy');
  const args=['exec','--cd',root,'--sandbox',sandbox];
  if(approval==='never')args.push('--ask-for-approval','never');
  args.push('--',prompt);
  // stdout may contain secrets or model-generated claims. Never forward it to
  // a remote MCP result or sandbox page; local diagnostics inspect only markers.
  return run(binary,args,{
    shell:false,windowsHide:true,timeout:Math.min(180000,Math.max(1000,timeout)),
    maxBuffer:64*1024,env:{...process.env,MAGPIE_NATIVE_COLLAB_EXPERIMENT:'1'}
  });
}

export function createNativeCollab(options={},dependencies={}){
  const roots=dependencies.projectRoots||(()=>projectRoots(options));
  const chat=dependencies.chatSessions||createChatSessions({projectRoots:roots});
  const open=dependencies.openDesktop||openCodexDesktop;
  const queue=dependencies.queueMessage||queueToNativeThread;
  const platform=dependencies.platform||process.platform;
  const bin=dependencies.binary||(()=>resolveCodexBinary(options));
  const cli=dependencies.launchCli||launchNativeCli;

  async function start({project,goal,chatUrl,taskId}={}){
    if(options.codexEnabled!==true)fail('Native Codex remote startup requires local Codex permission to be enabled in Magpie');
    if(resolveCodexPermissionMode(options)==='read-only')
      fail('Codex permission is read-only; change it locally before requesting a coding task');
    if(typeof chatUrl!=='string'||!chatUrl.trim()){
      // ChatGPT MCP does not receive the current chat's URL automatically.
      // Crucially, do NOT guess from an earlier project binding.
      return {status:'needs_chat_url',project,confirmedExecution:false,
        instructions:'Paste the exact URL of THIS ChatGPT conversation (chatgpt.com/c/...) and call codex_collab_start again. No task was launched or created.'};
    }
    const ticket=chat.prepareLaunch({project,goal,chatUrl,taskId});
    if(ticket.reused&&ticket.launch.status!=='prepared')
      return response(ticket,ticket.launch.status,{reused:true,
        instructions:'Previous launch request was already sent or attempted. Do not retry automatically; check Codex Desktop and session status.'});
    const launchId=ticket.launch.launchId;
    const prompt=desktopPrompt({project,goal,chatUrl:ticket.launch.chatUrl,
      taskId:ticket.launch.taskId,launchId});
    // Mark BEFORE side effects to prevent duplicate execution on MCP retry.
    chat.updateLaunch({project,launchId,status:'dispatching'});
    try{
      if(ticket.launch.transport==='queue'){
        const executable=bin();
        await queue(ticket.nativeThreadId,prompt,{binary:executable});
        chat.updateLaunch({project,launchId,status:'queued_unconfirmed'});
        return response(ticket,'queued_unconfirmed',{
          instructions:'Codex queue acknowledged STORAGE, not delivery/execution. Check the linked native Codex Desktop thread; do not start another thread automatically.'
        });
      }
      if(options.nativeCollabCliExperimental===true){
        // Explicit local opt-in only. A successful CLI exit is not proof the
        // in-app browser was available or the ChatGPT pairing succeeded.
        await cli({binary:bin(),root:ticket.localRoot,prompt});
        chat.updateLaunch({project,launchId,status:'opened_unconfirmed'});
        return response(ticket,'cli_exited_unverified',{
          instructions:'Native Codex CLI exited. Verify the Skill actually reached PROJECT_VERIFIED in the target ChatGPT chat. CLI success alone does not confirm browser collaboration.'
        });
      }
      await open(desktopUrl(ticket.localRoot,prompt),{platform});
      chat.updateLaunch({project,launchId,status:'opened_unconfirmed'});
      return response(ticket,'opened_unconfirmed',{
        instructions:'Codex Desktop was asked to open the project with a prefilled $magpie-codex-collab prompt. Press Send once in Codex Desktop. Only native Codex can verify and activate this ChatGPT chat.'
      });
    }catch(error){
      chat.updateLaunch({project,launchId,status:'dispatch_failed'});
      return response(ticket,'dispatch_failed',{
        error:ticket.launch.transport==='queue'
          ?'Codex CLI queue failed; no automatic fallback to a second Desktop thread'
          :options.nativeCollabCliExperimental===true?'Native Codex CLI experiment failed or timed out':'Codex Desktop URL handler could not be launched',
        instructions:'Check the local Codex installation and Magpie logs. A failed launch is not confirmation of execution.'
      });
    }
  }
  return {start};
}
