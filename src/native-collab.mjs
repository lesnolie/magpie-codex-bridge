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
import { tryVerifiedDesktopAutoSend } from './desktop-auto-send.mjs';
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
  if(code==='DESKTOP_URL_TOO_LONG')return 'url-too-long';
  if(code==='DESKTOP_BAD_ROOT')return 'invalid-project-root';
  if(code==='DESKTOP_BAD_PROMPT')return 'invalid-prompt';
  if(code==='DESKTOP_URI_ENCODING_FAILED')return 'uri-construction-error';
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
    'ENAMETOOLONG','ERR_CHILD_PROCESS_STDIO_MAXBUFFER','ERR_CHILD_PROCESS_FAILED',
    'DESKTOP_URL_TOO_LONG','DESKTOP_BAD_ROOT','DESKTOP_BAD_PROMPT','DESKTOP_URI_ENCODING_FAILED']);
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
    '1. First open EXACT TARGET_CHAT in ONE ego-browser page (not the Codex in-app browser).',
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
const MAX_DESKTOP_URI_LENGTH=8500;
function codedUriError(code){
  const error=new Error('Native Desktop URI validation failed');
  error.code=code;
  return error;
}
function buildDesktopUri(projectRoot,prompt){
  if(typeof projectRoot!=='string'||!projectRoot)
    throw codedUriError('DESKTOP_BAD_ROOT');
  if(typeof prompt!=='string'||!prompt)
    throw codedUriError('DESKTOP_BAD_PROMPT');
  try{
    const u=new URL('codex://threads/new');
    u.searchParams.set('path',projectRoot);
    u.searchParams.set('prompt',prompt);
    return u.toString();
  }catch{
    // Never preserve an exception possibly containing a private encoded URL.
    throw codedUriError('DESKTOP_URI_ENCODING_FAILED');
  }
}
/** Read-only, privacy-safe preview of the EXACT URI builder used at dispatch.
 * No URL, project directory, goal, prompt, or URL fragments are returned.
 */
export function describeDesktopUri(projectRoot,prompt){
  const base={limit:MAX_DESKTOP_URI_LENGTH,
    rootLength:typeof projectRoot==='string'?projectRoot.length:null,
    promptLength:typeof prompt==='string'?prompt.length:null};
  try{
    const uri=buildDesktopUri(projectRoot,prompt);
    return {...base,valid:uri.length<=MAX_DESKTOP_URI_LENGTH,
      reason:uri.length>MAX_DESKTOP_URI_LENGTH?'url-too-long':'ready',
      uriLength:uri.length};
  }catch(error){
    return {...base,valid:false,reason:categorizeDesktopLaunchFailure(error),uriLength:null};
  }
}
export function desktopUrl(projectRoot,prompt){
  const uri=buildDesktopUri(projectRoot,prompt);
  if(uri.length>MAX_DESKTOP_URI_LENGTH)throw codedUriError('DESKTOP_URL_TOO_LONG');
  return uri;
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

export function createNativeCollab(options={},dependencies={}){
  const roots=dependencies.projectRoots||(()=>projectRoots(options));
  const chat=dependencies.chatSessions||createChatSessions({projectRoots:roots});
  const open=dependencies.openDesktop||openCodexDesktop;
  const queue=dependencies.queueMessage||queueToNativeThread;
  const platform=dependencies.platform||process.platform;
  const bin=dependencies.binary||(()=>resolveCodexBinary(options));
  const autoSend=dependencies.desktopAutoSend||tryVerifiedDesktopAutoSend;

  function diagnose({project}={}){
    // Never export the launch source fields to MCP; the inspector callback
    // returns ONLY safe lengths and allowlisted reason labels.
    return chat.inspectLaunch(project,({project:registered,root,launch})=>{
      if(launch.transport!=='desktop')
        return {transport:launch.transport,valid:null,reason:'not-desktop'};
      const prompt=desktopPrompt({project:registered,goal:launch.goal,
        chatUrl:launch.chatUrl,taskId:launch.taskId,launchId:launch.launchId});
      return {transport:'desktop',...describeDesktopUri(root,prompt)};
    });
  }

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
      const url=desktopUrl(ticket.localRoot,prompt);
      dispatchStage='windows-launcher';
      await open(url,{platform});
      chat.updateLaunch({project,launchId,status:'opened_unconfirmed'});
      // Local-only experimental opt-in. Never treat an invoked UI button as
      // evidence of Codex turn execution or successful ChatGPT pairing.
      const autoSubmit=options.nativeDesktopAutoSendExperimental===true
        ?await autoSend(prompt,{platform})
        :'disabled';
      // Durable diagnostic only. UIA invocation never confirms Codex execution.
      try { chat.recordAutoSubmit?.({project,launchId,result:autoSubmit}); }
      catch { /* Native pairing may have advanced; never re-dispatch. */ }
      return response(ticket,'opened_unconfirmed',{
        autoSubmit,
        instructions:autoSubmit==='sent-composer-cleared'
          ?'The uniquely verified native Codex composer was submitted once and cleared. Turn execution and chat binding remain unconfirmed until native Codex reports them; do not resend.'
          :autoSubmit==='invoked-unconfirmed'
          ?'A uniquely verified native Codex Send button was invoked. Actual turn execution and chat binding remain unconfirmed.'
          :'Codex Desktop was asked to open the project with a prefilled $magpie-codex-collab prompt. Press Send once in Codex Desktop if the composer is still populated. Only native Codex can verify and activate this ChatGPT chat.'
      });
    }catch(error){
      const detail=safeDesktopFailureDetails(error,dispatchStage);
      chat.updateLaunch({project,launchId,status:'dispatch_failed',...detail});
      return response(ticket,'dispatch_failed',{...detail,
        error:ticket.launch.transport==='queue'
          ?'Codex CLI queue failed; no automatic fallback to a second Desktop thread'
          :'Codex Desktop URL handler could not be launched',
        instructions:'Check the local Codex installation and Magpie logs. A failed launch is not confirmation of execution.'
      });
    }
  }
  return {start,diagnose};
}
