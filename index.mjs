import { createProjectTools, projectRoots } from './src/projects.mjs';
import { createChatSessions } from './skills/magpie-codex-collab/chat-session.mjs';
import { createNativeCollab } from './src/native-collab.mjs';
import { startLocalCliTest } from './src/local-cli-test.mjs';
import { publishNativeSessionPreview } from './src/native-session-preview.mjs';
import { existsSync } from 'node:fs';
import { createCodexTasks, resolveCodexPermissionMode } from './src/codex-tasks.mjs';
import { startModelCatalogSync } from './src/model-catalog.mjs';
import { reconcileRemoteService, writeBootstrapStatus, remotePaths } from './src/remote-service.mjs';

const arg = (description, extra = {}) => ({ type: 'string', description, ...extra });
const wrap = (fn) => async (args) => {
  try { return await fn(args || {}); }
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
  // Local Magpie options are an explicit user action, not a remote MCP call.
  // Dispatch one trusted nonce on host reload; NEVER register an action tool.
  try { await startLocalCliTest(options); }
  catch { console.warn('[magpie-local-review] Local CLI diagnostic could not initialize'); }
  const tools = createProjectTools(options);
  // Always register the four Codex tool schemas so the upstream Magpie MCP
  // discovery catalog is stable even when local options are changed later.
  // Execution remains fail-closed inside createCodexTasks unless the local user
  // explicitly enables Codex; Cloudflare also filters these tools by its
  // locally managed permission flag.
  const codex = createCodexTasks(options);
  const chat = createChatSessions({projectRoots:()=>projectRoots(options)});
  // Only a privacy-safe point-in-time summary; the iframe cannot inspect Desktop focus.
  try { await publishNativeSessionPreview({roots:()=>projectRoots(options),sessions:chat}); }
  catch { console.warn('[magpie-local-review] Native collaboration preview unavailable'); }
  const nativeCollab = createNativeCollab(options,{chatSessions:chat,projectRoots:()=>projectRoots(options)});
  const codexTools = {
    codex_submit_task: { description: 'Submit a task to local Codex for a Codex Desktop registered project. Only Codex may modify files, and only if separately enabled in Magpie.', args: { project: arg('Allowed project name'), prompt: arg('Task instruction'), continueThread: { type: 'boolean', description: 'Continue the last successful Codex thread for this project, default false' } }, execute: wrap(codex.submit) },
    codex_task_status: { description: 'Read state and progress of a previously submitted local Codex task.', args: { project: arg('Allowed project name'), taskId: arg('Task ID') }, execute: wrap(codex.status) },
    codex_task_result: { description: 'Read local Codex output and completion status for a task.', args: { project: arg('Allowed project name'), taskId: arg('Task ID') }, execute: wrap(codex.result) },
    codex_wait_task: { description: 'Wait up to 15 seconds for a local Codex task to finish; return its result so ChatGPT can immediately review it in this active conversation. Cannot initiate a new chat or send unsolicited notifications.', args: { project: arg('Approved project name'), taskId: arg('Task ID'), waitMs: { type: 'integer', minimum: 0, maximum: 15000, description: 'Maximum wait in milliseconds (up to 15000)' } }, execute: wrap(codex.wait) },
    codex_review_inbox: { description: 'List local completed Codex tasks awaiting ChatGPT review, including tasks from an earlier chat or plugin reload. Local receipt files are not project modifications.', args: { project: { type: 'string', description: 'Optional approved project name' } }, execute: wrap(codex.inbox) },
    codex_review_changes: { description: 'Read Codex task completion output and a bounded, filtered Git diff from its submission baseline for ChatGPT code review. Source files only, no execution or edits.', args: { project: arg('Approved project name'), taskId: arg('Task ID'), file: { type: 'string', description: 'Optional project-relative changed source file for focused review' } }, execute: wrap(codex.changes) },
    codex_ack_review: { description: 'After ChatGPT has ACTUALLY reviewed a completed Codex task, record approved / changes_requested / no_changes verdict in the local review receipt. Does not edit source code or notify a chat.', args: { project: arg('Approved project'), taskId: arg('Completed task ID'), decision: { type: 'string', enum: ['approved', 'changes_requested', 'no_changes'] }, summary: arg('Brief evidence-based review conclusion, 1-1500 characters') }, execute: wrap(codex.acknowledge) },
    chat_session_status: { description: 'Read the current verified ChatGPT conversation binding, task checkpoint and any pending switch for a Codex Desktop project. Does not operate a browser or send a message.', args: { project: arg('Codex Desktop project name') }, execute: wrap(({project})=>JSON.stringify(chat.status(project))) },
    chat_session_request_transfer: { description: 'Stage a request to switch to a new ChatGPT conversation for an existing Codex task. The active chat remains unchanged until native Codex verifies and activates it locally. A URL is needed for new conversations outside the managed browser.', args: {project:arg('Codex Desktop project'), taskId:arg('Existing task ID'), url:{type:'string',description:'Optional exact https://chatgpt.com/c/... chat URL; recommended for outside-browser switches'},reason:{type:'string',description:'Short reason for transfer'}}, execute: wrap(args=>JSON.stringify(chat.request(args))) },
    codex_collab_start: { description: 'Start a NEW native Codex Desktop collaboration using the installed magpie-codex-collab Skill. Project is optional only when the supplied exact ChatGPT URL uniquely matches a locally workspace-verified Desktop thread. REQUIRES the exact CURRENT ChatGPT chat URL because MCP cannot read it automatically. Never infer the URL from prior conversations or a project title. If absent, return needs_chat_url with no side effects. With a verified local linked native thread, queue a message; otherwise open Desktop with prefilled text and the user must press Send. Neither action confirms execution. Only an explicit retryFailed=true with exact failedLaunchId, original taskId, goal and chat URL can recover a dispatch_failed Desktop request. No automatic retry.', args: {project:{type:'string',description:'Optional. Without project, resolve only the unique workspace-verified native thread for the exact supplied ChatGPT URL. Never use another conversation or project.'},goal:arg('User-requested coding goal, max 1200 characters'),chatUrl:{type:'string',description:'Exact URL of THIS ChatGPT conversation; must be supplied explicitly by the user'},taskId:{type:'string',description:'Existing failed launch taskId required for an explicit retry; optional when starting a new task'},
      retryFailed:{type:'boolean',description:'Explicit user-approved one-time recovery of a dispatch_failed Desktop ticket. Default false. No retry for in-flight, queued or opened requests.'},
      failedLaunchId:{type:'string',description:'Exact original failed launch UUID. Required with retryFailed=true, together with matching taskId, goal, project and chatUrl.'}}, execute: wrap(args=>nativeCollab.start(args).then(JSON.stringify)) },
    codex_cancel_task: { description: 'Cancel a previously submitted local Codex task.', args: { project: arg('Allowed project name'), taskId: arg('Task ID') }, execute: wrap(codex.cancel) },
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
        integrationVersion: '0.4.18-alpha.1',
        toolsRegistered: true,
        toolCount: 17,
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
      projects: { description: 'List Codex Desktop registered projects and report pending Codex reviews. When pendingReviewCount is positive call codex_review_inbox and codex_review_changes to audit; never modify project files.', args: {}, execute: wrap(projectsWithStatus) },
      list_files: { description: 'List non-secret files within an allowed project directory. Paths are project-relative.', args: { project: arg('Project name'), directory: arg('Relative directory, default .') }, execute: wrap(tools.list_files) },
      read_file: { description: 'Read a limited range of an allowed source code or text file; no secrets, symlinks or files outside project roots.', args: { project: arg('Project name'), file: arg('Relative source path'), startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 200 } }, execute: wrap(tools.read_file) },
      search_text: { description: 'Search exact text within allowed source files, bounded to 300 files and 50 matches.', args: { project: arg('Project name'), query: arg('Literal search text'), directory: arg('Relative directory, default .'), maxMatches: { type: 'integer', minimum: 1, maximum: 50 } }, execute: wrap(tools.search_text) },
      git_status: { description: 'Read Git worktree status from allowed local project; no changes made.', args: { project: arg('Project name') }, execute: wrap(tools.git_status) },
      git_diff: { description: 'Review unstaged changes to a specific allowed, existing source file; no changes made.', args: { project: arg('Project name'), file: arg('Relative tracked source file') }, execute: wrap(tools.git_diff) },
    }
  };
};
