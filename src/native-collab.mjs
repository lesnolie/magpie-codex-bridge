/**
 * ChatGPT -> native Codex Desktop handoff. No app-server is required.
 *
 * One remote MCP call may open a prefilled Codex Desktop composer, or queue a
 * message to a previously LOCAL-verified, project-matched Codex thread.
 * Neither mechanism proves the agent has begun work. Do not auto-retry.
 */
import { execFile as nativeExecFile, spawn as nativeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createChatSessions } from '../skills/magpie-codex-collab/chat-session.mjs';
import { projectRoots } from './projects.mjs';
import { resolveCodexBinary, resolveCodexPermissionMode } from './codex-tasks.mjs';

const execFile=promisify(nativeExecFile);

function fail(reason){throw new Error(reason);}
// Never expose raw stderr/stdout. PowerShell may echo the launch URI, including
// the private ChatGPT URL, into its error output.
export function categorizeDesktopLaunchFailure(error){
  const code=String(error?.code??'').toUpperCase();
  const stderr=typeof error?.stderr==='string'?error.stderr.slice(0,2500):'';
  if(code==='ENOENT')return 'launcher-not-found';
  if(code==='E2BIG'||code==='ENAMETOOLONG')return 'launcher-argument-too-long';
  if(code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return 'launcher-output-overflow';
  if(['EACCES','EPERM'].includes(code))return 'access-denied';
  if(['ETIMEDOUT','ESRCH'].includes(code))return 'launcher-timeout';
  if(/invalid native codex launch|invalid codex desktop link|exceeds safe length/i.test(error?.message||''))
    return 'invalid-uri';
  if(/Start-Process|No application is associated|The specified file was not found|没有与之关联的应用/i.test(stderr))
    return 'protocol-handler-error';
  if(typeof error?.code==='number'||/^\d{1,4}$/.test(code)||code==='ERR_CHILD_PROCESS_FAILED')
    return 'command-failed';
  return 'unexpected-error';
}
function response(ticket,status,extra={}){
  return {
    project:ticket.project,taskId:ticket.launch?.taskId,
    launchId:ticket.launch?.launchId,chatUrl:ticket.launch?.chatUrl,
    status,transport:ticket.launch?.transport,
    activeChatUnchanged:true,confirmedExecution:false,
    ...extra
  };
}
/** Safe, fixed-schema launcher diagnostic; no raw shell output or process args. */
export function safeDesktopFailureDetails(error,stage='windows-launcher'){
  const allowedCodes=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','E2BIG',
    'ENAMETOOLONG','ERR_CHILD_PROCESS_STDIO_MAXBUFFER','ERR_CHILD_PROCESS_FAILED']);
  const raw=String(error?.code??'').toUpperCase();
  const failureCode=allowedCodes.has(raw)?raw:(/^\d{1,3}$/.test(raw)?raw:null);
  const exitStatus=Number.isInteger(error?.code)&&error.code>=0&&error.code<=255
    ?error.code:null;
  const n=typeof error?.name==='string'?error.name:'';
  const failureKind=['Error','TypeError','RangeError','SystemError','AbortError'].includes(n)
    ?n:'unknown';
  return {failureCategory:categorizeDesktopLaunchFailure(error),
    failureStage:stage==='building-uri'?'building-uri':'windows-launcher',
    failureCode,exitStatus,failureKind};
}
export function desktopPrompt({project,goal,chatUrl,taskId,launchId,mode='desktop'}){
  const cliMode=mode==='cli';
  const instructions=[
    '$magpie-codex-collab',
    cliMode?'START MODE: Standalone Codex CLI exec, not Codex Desktop or Magpie app-server.'
      :'START MODE: Native Codex Desktop, not Magpie app-server.',
    'PROJECT: '+project,
    'TASK_ID: '+taskId,
    'LAUNCH_ID: '+launchId,
    'TARGET_CHAT: '+chatUrl,
    '',
    'Follow the installed magpie-codex-collab Skill. IMPORTANT:',
    ...(cliMode?[
      'CLI GATE: An independently launched codex exec session may have no in-app browser backend.',
      'Check the official browser backend once. If iab is unavailable, report MAGPIE_BROWSER_UNAVAILABLE and finish promptly.',
      'Do not retry unavailable backends, use private APIs, infer a browser session, or assert chat binding.'
    ]:[]),
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
// CLI stdout/stderr are never returned to remote MCP clients.
const CLI_PROGRESS_TYPES=Object.freeze({
  'thread.started':'cli-thread-started',
  'turn.started':'cli-turn-started',
  'turn.completed':'cli-turn-finished',
  'turn.failed':'cli-turn-failed'
});
async function runObservedCli(binary,args,options,progress,spawnProcess=nativeSpawn){
  return new Promise((resolve,reject)=>{
    let child;
    try {
      child=spawnProcess(binary,args,{...options,stdio:['ignore','pipe','pipe']});
    } catch(e) {reject(e);return;}
    let out='',errTail='',lineBuffer='',settled=false,timedOut=false;
    let timer;
    const done=(error,result)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      if(error)reject(error);else resolve(result);
    };
    child.once('spawn',()=>progress('cli-process-started'));
    child.stdout?.on('data',chunk=>{
      const part=String(chunk);
      out=(out+part).slice(-64*1024);
      lineBuffer+=part;
      if(lineBuffer.length>256*1024)lineBuffer=lineBuffer.slice(-4096);
      let idx;
      while((idx=lineBuffer.indexOf('\n'))>=0){
        const line=lineBuffer.slice(0,idx);
        lineBuffer=lineBuffer.slice(idx+1);
        let event;
        try{event=JSON.parse(line);}catch{continue;}
        const phase=CLI_PROGRESS_TYPES[event?.type];
        if(phase)progress(phase); // Only four fixed labels; no model output.
      }
    });
    child.stderr?.on('data',chunk=>{errTail=(errTail+String(chunk)).slice(-2048);});
    child.once('error',error=>done(error));
    child.once('close',(code,signal)=>{
      if(timedOut){
        const e=new Error('Codex exec timeout');
        e.code='ETIMEDOUT';done(e);return;
      }
      if(code!==0){
        const e=new Error('Codex exec failed');
        e.code=Number.isInteger(code)?code:'CLI_EXIT';
        e.stderr=errTail;done(e);return;
      }
      done(null,{stdout:out,stderr:errTail,exitCode:0});
    });
    timer=setTimeout(()=>{
      timedOut=true;
      child.kill?.();
      // Report at timeout even if a platform cannot terminate the process.
      const e=new Error('Codex exec timeout');
      e.code='ETIMEDOUT';
      done(e);
    },options.timeout);
  });
}
export async function launchNativeCli({binary,root,prompt,sandbox='workspace-write',
  approval=null,timeout=180000,run=execFile,onProgress=null,spawnProcess=nativeSpawn}={}){
  if(!root||!prompt||!binary)fail('Missing native CLI project, binary or prompt');
  if(!['read-only','workspace-write'].includes(sandbox))fail('Invalid CLI sandbox');
  if(approval!==null&&approval!=='never')fail('Invalid CLI approval policy');
  const args=['exec','--cd',root,'--sandbox',sandbox];
  // Codex exec accepts --config; interactive --ask-for-approval can be rejected.
  if(approval==='never')args.push('--config','approval_policy="never"');
  if(typeof onProgress==='function')args.push('--json');
  args.push('--',prompt);
  const options={
    shell:false,windowsHide:true,timeout:Math.min(180000,Math.max(1000,timeout)),
    maxBuffer:64*1024,cwd:root,env:{...process.env,MAGPIE_NATIVE_COLLAB_EXPERIMENT:'1'}
  };
  // Optional structured status observation is LOCAL ONLY. No prompts, item
  // content, tokens, URLs or raw stderr are published to the options page.
  if(typeof onProgress==='function')
    return runObservedCli(binary,args,options,onProgress,spawnProcess);
  return run(binary,args,options);
}

export function createNativeCollab(options={},dependencies={}){
  const roots=dependencies.projectRoots||(()=>projectRoots(options));
  const chat=dependencies.chatSessions||createChatSessions({projectRoots:roots});
  const open=dependencies.openDesktop||openCodexDesktop;
  const queue=dependencies.queueMessage||queueToNativeThread;
  const platform=dependencies.platform||process.platform;
  const bin=dependencies.binary||(()=>resolveCodexBinary(options));
  const cli=dependencies.launchCli||launchNativeCli;

  async function start({project,goal,chatUrl,taskId,retryFailed=false,failedLaunchId}={}){
    if(options.codexEnabled!==true)fail('Native Codex remote startup requires local Codex permission to be enabled in Magpie');
    if(resolveCodexPermissionMode(options)==='read-only')
      fail('Codex permission is read-only; change it locally before requesting a coding task');
    if(typeof chatUrl!=='string'||!chatUrl.trim()){
      // ChatGPT MCP does not receive the current chat's URL automatically.
      // Crucially, do NOT guess from an earlier project binding.
      return {status:'needs_chat_url',project,confirmedExecution:false,
        instructions:'Paste the exact URL of THIS ChatGPT conversation (chatgpt.com/c/...) and call codex_collab_start again. No task was launched or created.'};
    }
    // Without an explicit project, resolve ONLY an exact, unique, workspace-
    // verified ChatGPT URL binding. The remote side cannot inspect Desktop's
    // currently focused project, so an unrelated/legacy match is never guessed.
    if(project===undefined||project===null||project===''||project==='auto'){
      const linked=chat.findLinkedProject?.({chatUrl});
      if(!linked)return {status:'needs_project_context',confirmedExecution:false,
        instructions:'No uniquely verified native Desktop workspace is bound to this exact ChatGPT URL. Start pairing from the intended Codex Desktop project; do not reuse another project binding.'};
      project=linked;
    }
    let ticket=chat.prepareLaunch({project,goal,chatUrl,taskId});
    if(retryFailed===true){
      // A normal retry remains fully idempotent. Explicit recovery is allowed
      // ONLY for the exact failed Desktop ticket the user named, never for a
      // queued/opened/dispatching ticket. The original goal was also checked
      // by prepareLaunch above; the target and task cannot change.
      if(ticket.launch.status==='dispatch_failed'&&ticket.launch.transport==='desktop'){
        if(typeof failedLaunchId!=='string'||ticket.launch.launchId!==failedLaunchId)
          fail('Explicit Desktop retry requires the exact failedLaunchId from chat_session_status');
        if(typeof taskId!=='string'||ticket.launch.taskId!==taskId)
          fail('Explicit Desktop retry requires the exact original taskId');
        chat.recoverLaunch({project,launchId:failedLaunchId,taskId,chatUrl,confirm:true});
        // Fetch the new prepared ticket with its internally validated localRoot;
        // recoverLaunch deliberately does not expose a project root to MCP.
        ticket=chat.prepareLaunch({project,goal,chatUrl,taskId});
      }else if(ticket.launch.recoveredFrom===failedLaunchId){
        // The same explicit request was already dispatched; do not launch twice.
        return response(ticket,ticket.launch.status,{reused:true,
          instructions:'The launch was already dispatched or is in progress. No second dispatch was attempted.'});
      }else{
        fail('Explicit Desktop retry refused: no matching failed native Desktop launch');
      }
    }
    if(ticket.reused&&ticket.launch.status!=='prepared')
      return response(ticket,ticket.launch.status,{reused:true,
        failureCategory:ticket.launch.failureCategory||null,
        failureStage:ticket.launch.failureStage||null,
        failureCode:ticket.launch.failureCode||null,
        exitStatus:ticket.launch.exitStatus??null,
        instructions:'Previous launch request was already sent or attempted. For a confirmed dispatch_failed Desktop ticket, explicitly supply retryFailed=true, failedLaunchId and the original taskId with the unchanged goal and chat URL; otherwise do not retry.'});
    const launchId=ticket.launch.launchId;
    const prompt=desktopPrompt({project,goal,chatUrl:ticket.launch.chatUrl,
      taskId:ticket.launch.taskId,launchId});
    // Mark BEFORE side effects to prevent duplicate execution on MCP retry.
    chat.updateLaunch({project,launchId,status:'dispatching'});
    let dispatchStage='building-uri';
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
        await cli({binary:bin(),root:ticket.localRoot,prompt:desktopPrompt({project,goal,chatUrl:ticket.launch.chatUrl,taskId:ticket.launch.taskId,launchId,mode:'cli'})});
        chat.updateLaunch({project,launchId,status:'opened_unconfirmed'});
        return response(ticket,'cli_exited_unverified',{
          instructions:'Native Codex CLI exited. Verify the Skill actually reached PROJECT_VERIFIED in the target ChatGPT chat. CLI success alone does not confirm browser collaboration.'
        });
      }
      const url=desktopUrl(ticket.localRoot,prompt);
      dispatchStage='windows-launcher';
      await open(url,{platform});
      chat.updateLaunch({project,launchId,status:'opened_unconfirmed'});
      return response(ticket,'opened_unconfirmed',{
        instructions:'Codex Desktop was asked to open the project with a prefilled $magpie-codex-collab prompt. Press Send once in Codex Desktop. Only native Codex can verify and activate this ChatGPT chat.'
      });
    }catch(error){
      const detail=safeDesktopFailureDetails(error,dispatchStage);
      chat.updateLaunch({project,launchId,status:'dispatch_failed',...detail});
      return response(ticket,'dispatch_failed',{...detail,
        error:ticket.launch.transport==='queue'
          ?'Codex CLI queue failed; no automatic fallback to a second Desktop thread'
          :options.nativeCollabCliExperimental===true?'Native Codex CLI experiment failed or timed out':'Codex Desktop URL handler could not be launched',
        instructions:'Check the local Codex installation and Magpie logs. A failed launch is not confirmation of execution.'
      });
    }
  }
  return {start};
}
