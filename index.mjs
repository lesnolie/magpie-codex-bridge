import { createProjectTools, projectRoots } from './src/projects.mjs';
import { createChatSessions } from './skills/magpie-codex-collab/chat-session.mjs';
import { createNativeCollab } from './src/native-collab.mjs';
import { createPeerMessages, normalizeHarness } from './src/peer-messages.mjs';
import { createHarnessRunner } from './src/harness-runner.mjs';
import { existsSync } from 'node:fs';
import { createCodexTasks, resolveCodexPermissionMode } from './src/codex-tasks.mjs';
import { startModelCatalogSync } from './src/model-catalog.mjs';
import { reconcileRemoteService, writeBootstrapStatus, remotePaths } from './src/remote-service.mjs';

const arg = (description, extra = {}) => ({ type: 'string', description, ...extra });
const wrap = (fn) => async (args, ctx) => {
  try { return await fn(args || {}, ctx); }
  catch (error) { return JSON.stringify({ ok: false, error: error.message }); }
};

export const MagpieProjectReview = async (_input, options = {}) => {
  // A local Magpie settings toggle is the only way to enable persistence.
  // Never make tool discovery fail merely because Windows Task Scheduler or
  // Node.js is unavailable; the existing six read-only tools must still work.
  try { await reconcileRemoteService(options); }
  catch (error) {
    if (options.remoteAutoStart === true) await writeBootstrapStatus('setup-failed', error?.message || String(error));
    console.warn('[magpie-local-review] Remote autostart:', error?.message || String(error));
  }
  // Local-only, data-only model snapshot for the sandboxed plugin page.
  // Never blocks the six read-only tools when the gateway is unavailable.
  try { await startModelCatalogSync(options); }
  catch (error) { console.warn('[magpie-local-review] Catalog:', error?.message || String(error)); }
  const tools = createProjectTools(options);
  // Always register the four Codex tool schemas so the upstream Magpie MCP
  // discovery catalog is stable even when local options are changed later.
  // Execution remains fail-closed inside createCodexTasks unless the local user
  // explicitly enables Codex; Cloudflare also filters these tools by its
  // locally managed permission flag.
  const codex = createCodexTasks(options);
  const peers = createPeerMessages();
  const harnessRunner = createHarnessRunner(options);
  const chat = createChatSessions({projectRoots:()=>projectRoots(options)});
  const nativeCollab = createNativeCollab(options,{chatSessions:chat,projectRoots:()=>projectRoots(options)});
  const codexTools = {
    codex_submit_task: { description: 'Submit a task to local Codex for a Codex Desktop registered project. Only Codex may modify files, and only if separately enabled in Magpie.', args: { project: arg('Allowed project name'), prompt: arg('Task instruction'), continueThread: { type: 'boolean', description: 'Continue the last successful Codex thread for this project, default false' }, chatUrl: { type: 'string', description: 'Optional exact ChatGPT conversation URL supplied by the user. Opts this app-server turn into ego-browser web collaboration; requires installed magpie-web-collab Skill. When omitted, MCP-only task behavior is unchanged.' } }, execute: wrap(codex.submit) },
    codex_task_status: { description: 'Read state and progress of a previously submitted local Codex task.', args: { project: arg('Allowed project name'), taskId: arg('Task ID') }, execute: wrap(codex.status) },
    codex_task_result: { description: 'Read local Codex output and completion status for a task.', args: { project: arg('Allowed project name'), taskId: arg('Task ID') }, execute: wrap(codex.result) },
    codex_wait_task: { description: 'Wait up to 15 seconds for a local Codex task to finish; return its result so ChatGPT can immediately review it in this active conversation. Cannot initiate a new chat or send unsolicited notifications.', args: { project: arg('Approved project name'), taskId: arg('Task ID'), waitMs: { type: 'integer', minimum: 0, maximum: 15000, description: 'Maximum wait in milliseconds (up to 15000)' } }, execute: wrap(codex.wait) },
    codex_review_inbox: { description: 'List local completed Codex tasks awaiting ChatGPT review, including tasks from an earlier chat or plugin reload. Local receipt files are not project modifications.', args: { project: { type: 'string', description: 'Optional approved project name' } }, execute: wrap(codex.inbox) },
    codex_review_changes: { description: 'Read Codex task completion output and a bounded, filtered Git diff from its submission baseline for ChatGPT code review. Source files only, no execution or edits.', args: { project: arg('Approved project name'), taskId: arg('Task ID'), file: { type: 'string', description: 'Optional project-relative changed source file for focused review' } }, execute: wrap(codex.changes) },
    codex_ack_review: { description: 'After ChatGPT has ACTUALLY reviewed a completed Codex task, record approved / changes_requested / no_changes verdict in the local review receipt. Does not edit source code or notify a chat.', args: { project: arg('Approved project'), taskId: arg('Completed task ID'), decision: { type: 'string', enum: ['approved', 'changes_requested', 'no_changes'] }, summary: arg('Brief evidence-based review conclusion, 1-1500 characters') }, execute: wrap(codex.acknowledge) },
    chat_session_status: { description: 'Read verified ChatGPT binding, task checkpoint and pending switch for a Codex Desktop project. Also includes a read-only, privacy-safe preflight of the saved Desktop launch URI (length and validation reason only). Does not run a launcher, access the browser or send a message.', args: { project: arg('Codex Desktop project name') }, execute: wrap(({project})=>JSON.stringify({...chat.status(project),desktopUriPreflight:nativeCollab.diagnose({project})})) },
    chat_session_request_transfer: { description: 'Stage a request to switch to a new ChatGPT conversation for an existing Codex task. The active chat remains unchanged until native Codex verifies and activates it locally. A URL is needed for new conversations outside the ego-browser page native Codex manages.', args: {project:arg('Codex Desktop project'), taskId:arg('Existing task ID'), url:{type:'string',description:'Optional exact https://chatgpt.com/c/... chat URL; recommended for outside-browser switches'},reason:{type:'string',description:'Short reason for transfer'}}, execute: wrap(args=>JSON.stringify(chat.request(args))) },
    codex_collab_start: { description: 'Start a NEW native Codex Desktop collaboration using the installed magpie-codex-collab Skill. Project is optional only when the supplied exact ChatGPT URL uniquely matches a locally workspace-verified Desktop thread. REQUIRES the exact CURRENT ChatGPT chat URL because MCP cannot read it automatically. Never infer the URL from prior conversations or a project title. If absent, return needs_chat_url with no side effects. With a verified local linked native thread, queue a message; otherwise open Desktop with prefilled text and optionally attempt locally enabled verified UIA submission. If not verified, the user must press Send. Neither action confirms execution. Only an explicit retryFailed=true with exact failedLaunchId, original taskId, goal and chat URL can recover a dispatch_failed Desktop request. No automatic retry.', args: {project:{type:'string',description:'Optional. Without project, resolve only the unique workspace-verified native thread for the exact supplied ChatGPT URL. Never use another conversation or project.'},goal:arg('User-requested coding goal, max 1200 characters'),chatUrl:{type:'string',description:'Exact URL of THIS ChatGPT conversation; must be supplied explicitly by the user'},taskId:{type:'string',description:'Existing failed launch taskId required for an explicit retry; optional when starting a new task'},
      retryFailed:{type:'boolean',description:'Explicit user-approved one-time recovery of a dispatch_failed Desktop ticket. Default false. No retry for in-flight, queued or opened requests.'},
      failedLaunchId:{type:'string',description:'Exact original failed launch UUID. Required with retryFailed=true, together with matching taskId, goal, project and chatUrl.'}}, execute: wrap(args=>nativeCollab.start(args).then(JSON.stringify)) },
    codex_cancel_task: { description: 'Cancel a previously submitted local Codex task.', args: { project: arg('Allowed project name'), taskId: arg('Task ID') }, execute: wrap(codex.cancel) },
  };
  const harnessTools = {
    agent_run: { description: 'Start EXACTLY the user-requested harness. Codex uses existing native Desktop or app-server; Claude Code/OpenCode use their documented CLI (not Desktop). Never substitute. Separate local Agent 启动权限 is required, and only allowed projects are accessible. Dispatch does not mean task completed.', args: {
      harness: arg('Required user-selected harness: codex, claude, opencode; never substitute'),
      project: arg('Exact locally authorized project name'),
      prompt: arg('The actual authorized instruction, max 12000 chars'),
      chatUrl: {type:'string',description:'Exact current ChatGPT conversation URL supplied by the user; required for native Codex Desktop and ego-browser collaboration'},
      mode: {type:'string',enum:['desktop','cli','app-server'],description:'Codex defaults to Desktop if chatUrl provided, otherwise app-server; Claude/OpenCode support CLI only'},
    }, execute: wrap(async a => {
      if (options.agentLaunchEnabled !== true) throw Error('Agent native launch is disabled in local Magpie settings');
      const selected = normalizeHarness(a.harness);
      if (selected === 'codex') {
        if (a.mode === 'cli') throw Error('Standalone Codex CLI is not supported; select Desktop or app-server');
        if ((a.mode || (a.chatUrl ? 'desktop' : 'app-server')) === 'desktop') {
          if (!a.chatUrl) throw Error('Native Codex Desktop requires an exact ChatGPT conversation URL');
          return JSON.stringify({harness:'codex',mode:'desktop',
            ...await nativeCollab.start({project:a.project,goal:a.prompt,chatUrl:a.chatUrl})});
        }
        return JSON.stringify({harness:'codex',mode:'app-server',
          ...JSON.parse(codex.submit({project:a.project,prompt:a.prompt,chatUrl:a.chatUrl}))});
      }
      if (a.mode && a.mode !== 'cli') throw Error('Selected harness does not support requested mode; no fallback');
      return harnessRunner.launch({...a,harness:selected});
    }) },
    agent_run_status: {description:'Read actual execution status for the exact selected CLI/app-server task. Desktop status uses chat_session_status.',args:{
      harness:arg('Harness chosen with agent_run'),
      project:arg('Original authorized project'),
      taskId:arg('Task ID from agent_run'),
      mode:{type:'string',enum:['cli','app-server'],description:'Codex app-server or another harness CLI'},
    },execute:wrap(a=>{
      const selected=normalizeHarness(a.harness);
      if(selected==='codex'){
        if(a.mode!=='app-server') throw Error('For Codex Desktop use chat_session_status');
        return codex.status({project:a.project,taskId:a.taskId});
      }
      return harnessRunner.status({...a,harness:selected});
    })},
    agent_run_cancel: {description:'Cancel selected CLI/app-server task if still running. Separate local agent-launch permission is required.',args:{
      harness:arg('Exact harness previously selected'),
      project:arg('Original authorized project'),
      taskId:arg('Task ID returned from agent_run'),
      mode:{type:'string',enum:['cli','app-server'],description:'CLI or Codex app-server'},
    },execute:wrap(a=>{
      if(options.agentLaunchEnabled!==true) throw Error('Agent launch permission disabled in local Magpie settings');
      const selected=normalizeHarness(a.harness);
      if(selected==='codex'){
        if(a.mode!=='app-server')throw Error('Desktop cancellation not supported; check chat_session_status');
        return codex.cancel({project:a.project,taskId:a.taskId});
      }
      return harnessRunner.cancel({...a,harness:selected});
    })},
  };
  const peerTools = {
    agent_register: { description: 'LOCAL AGENT ONLY (not remote Cloudflare). Bind an active harness session and its exact ChatGPT Web chat for peer command exchange. Registration is self-declared, not proof of execution or filesystem permission.', args: { harness: arg('Exact locally running harness name: codex, claude, opencode, or other'), project: arg('Human-readable project label; not a grant to project files'), mode: { type: 'string', enum: ['desktop','cli','app-server','ide','other'], description: 'Optional current execution mode. This is metadata, not an execution capability grant.' }, chatUrl: arg('Exact verified ChatGPT conversation URL observed through ego-browser') }, execute: wrap((a, ctx) => peers.register(a, ctx?.agent || '')) },
    agent_poll: { description: 'LOCAL AGENT ONLY. Read up to ten queued peer commands for a registered session during an active harness turn. A poll marks delivered, not executed; acknowledge after processing.', args: { sessionId: arg('Session ID returned by agent_register'), chatUrl: arg('Exact bound ChatGPT conversation URL') }, execute: wrap(peers.poll) },
    agent_ack: { description: 'LOCAL AGENT ONLY. Mark a previously polled peer command processed. No implicit approval of unrelated actions.', args: { sessionId: arg('Registered session ID'), chatUrl: arg('Exact bound ChatGPT URL'), messageId: arg('Original message ID') }, execute: wrap(peers.acknowledge) },
    agent_sessions: { description: 'Read locally registered peer harness sessions, their project labels, ChatGPT binding and queued counts. Does NOT mean those agents can be launched or are executing.', args: {}, execute: wrap(() => peers.list()) },
    agent_message_status: { description: 'Read routing status of a message to an agent: queued, delivered (polled), or acked. No status confirms execution.', args: { sessionId: arg('Registered session ID'), chatUrl: arg('Exact bound ChatGPT URL'), messageId: arg('Optional message ID') }, execute: wrap(peers.status) },
    agent_message_send: { description: 'Send a user-directed command to the EXACT harness the user names (e.g. claude, codex, opencode), never a substitute. Automatically routes to the one registered session for that harness and exact verified ChatGPT conversation; optionally narrow by project or execution mode. This queues only and does not launch a stopped Desktop/CLI process. Separate local permission required.', args: { harness: { type: 'string', description: 'User-selected harness name, e.g. claude, codex, opencode. REQUIRED when sessionId omitted. Do not guess or silently substitute.' }, project: { type: 'string', description: 'Optional exact project label to distinguish multiple sessions of one harness.' }, mode: { type: 'string', enum: ['desktop','cli','app-server','ide','other'], description: 'Optional exact execution mode to distinguish multiple sessions.' }, sessionId: { type: 'string', description: 'Optional exact session ID if multiple sessions of the SAME requested harness match; not usually needed.' }, chatUrl: arg('Exact bound ChatGPT conversation URL supplied by the user or verified through ego-browser'), taskId: arg('Stable task ID'), messageId: arg('Unique message ID for idempotency on tool retries'), command: { type: 'string', enum: ['REQUEST','RESULT','UPDATE','BLOCKED','DONE'], description: 'Message intent, not a permanent sender role' }, message: arg('User request or message, max 4000 characters') }, execute: wrap(a => {
      if (options.peerMessagingEnabled !== true) throw Error('Peer messaging is disabled in local Magpie settings');
      return peers.send(a);
    }) },
  };
  const projectsWithStatus = async () => {
    const data = JSON.parse(await tools.projects());
    const configured = options.codexEnabled === true;
    const remoteOn = options.remoteAutoStart === true;
    // On a fresh ChatGPT conversation, projects() also signals whether
    // older Codex tasks await review, without returning their code/output.
    let pendingReviewCount = null;
    if (configured) {
      try { pendingReviewCount = JSON.parse(await codex.inbox({})).total; }
      catch { /* Project source may be temporarily unavailable. */ }
    }
    return JSON.stringify({
      ...data,
      codex: {
        integrationVersion: '0.4.29-alpha.1',
        toolsRegistered: true,
        toolCount: 26,
        pendingReviewCount,
        localEnabled: configured,
        allowWrites: configured && resolveCodexPermissionMode(options) !== 'read-only',
        permissionMode: resolveCodexPermissionMode(options),
        remoteAutoStart: remoteOn,
        remoteGateEnabled: process.platform === 'win32' && existsSync(remotePaths().codexEnabledFile),
      },
    });
  };
  return {
    tool: {
      ...codexTools,
      ...peerTools,
      ...harnessTools,
      projects: { description: 'List Codex Desktop registered projects and report pending Codex reviews. When pendingReviewCount is positive call codex_review_inbox and codex_review_changes to audit; never modify project files.', args: {}, execute: wrap(projectsWithStatus) },
      list_files: { description: 'List non-secret files within an allowed project directory. Paths are project-relative.', args: { project: arg('Project name'), directory: arg('Relative directory, default .') }, execute: wrap(tools.list_files) },
      read_file: { description: 'Read a limited range of an allowed source code or text file; no secrets, symlinks or files outside project roots.', args: { project: arg('Project name'), file: arg('Relative source path'), startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 200 } }, execute: wrap(tools.read_file) },
      search_text: { description: 'Search exact text within allowed source files, bounded to 300 files and 50 matches.', args: { project: arg('Project name'), query: arg('Literal search text'), directory: arg('Relative directory, default .'), maxMatches: { type: 'integer', minimum: 1, maximum: 50 } }, execute: wrap(tools.search_text) },
      git_status: { description: 'Read Git worktree status from allowed local project; no changes made.', args: { project: arg('Project name') }, execute: wrap(tools.git_status) },
      git_diff: { description: 'Review unstaged changes to a specific allowed, existing source file; no changes made.', args: { project: arg('Project name'), file: arg('Relative tracked source file') }, execute: wrap(tools.git_diff) },
    }
  };
};
