import { createProjectTools } from './src/projects.mjs';
import { existsSync } from 'node:fs';
import { createCodexTasks } from './src/codex-tasks.mjs';
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
  const tools = createProjectTools(options);
  // Always register the four Codex tool schemas so the upstream Magpie MCP
  // discovery catalog is stable even when local options are changed later.
  // Execution remains fail-closed inside createCodexTasks unless the local user
  // explicitly enables Codex; Cloudflare also filters these tools by its
  // locally managed permission flag.
  const codex = createCodexTasks(options);
  const codexTools = {
    codex_submit_task: { description: 'Submit a task to local Codex for a project from the selected local project source. Only Codex may modify files, and only if separately enabled in Magpie.', args: { project: arg('Allowed project name'), prompt: arg('Task instruction'), continueThread: { type: 'boolean', description: 'Continue the last successful Codex thread for this project, default false' } }, execute: wrap(codex.submit) },
    codex_task_status: { description: 'Read state and progress of a previously submitted local Codex task.', args: { project: arg('Allowed project name'), taskId: arg('Task ID') }, execute: wrap(codex.status) },
    codex_task_result: { description: 'Read local Codex output and completion status for a task.', args: { project: arg('Allowed project name'), taskId: arg('Task ID') }, execute: wrap(codex.result) },
    codex_wait_task: { description: 'Wait up to 15 seconds for a local Codex task to finish; return its result so ChatGPT can immediately review it in this active conversation. Cannot initiate a new chat or send unsolicited notifications.', args: { project: arg('Approved project name'), taskId: arg('Task ID'), waitMs: { type: 'integer', minimum: 0, maximum: 15000, description: 'Maximum wait in milliseconds (up to 15000)' } }, execute: wrap(codex.wait) },
    codex_review_inbox: { description: 'List local completed Codex tasks awaiting ChatGPT review, including tasks from an earlier chat or plugin reload. Local receipt files are not project modifications.', args: { project: { type: 'string', description: 'Optional approved project name' } }, execute: wrap(codex.inbox) },
    codex_review_changes: { description: 'Read Codex task completion output and a bounded, filtered Git diff from its submission baseline for ChatGPT code review. Source files only, no execution or edits.', args: { project: arg('Approved project name'), taskId: arg('Task ID'), file: { type: 'string', description: 'Optional project-relative changed source file for focused review' } }, execute: wrap(codex.changes) },
    codex_ack_review: { description: 'After ChatGPT has ACTUALLY reviewed a completed Codex task, record approved / changes_requested / no_changes verdict in the local review receipt. Does not edit source code or notify a chat.', args: { project: arg('Approved project'), taskId: arg('Completed task ID'), decision: { type: 'string', enum: ['approved', 'changes_requested', 'no_changes'] }, summary: arg('Brief evidence-based review conclusion, 1-1500 characters') }, execute: wrap(codex.acknowledge) },
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
        integrationVersion: '0.4.5-alpha.1',
        toolsRegistered: true,
        toolCount: 14,
        pendingReviewCount,
        localEnabled: configured,
        allowWrites: configured && options.codexAllowWrites === true,
        remoteAutoStart: remoteOn,
        remoteGateEnabled: process.platform === 'win32' && existsSync(remotePaths().codexEnabledFile),
      },
    });
  };
  return {
    tool: {
      ...codexTools,
      projects: { description: 'List projects from the configured local source and report pending Codex reviews. When pendingReviewCount is positive call codex_review_inbox and codex_review_changes to audit; never modify project files.', args: {}, execute: wrap(projectsWithStatus) },
      list_files: { description: 'List non-secret files within an allowed project directory. Paths are project-relative.', args: { project: arg('Project name'), directory: arg('Relative directory, default .') }, execute: wrap(tools.list_files) },
      read_file: { description: 'Read a limited range of an allowed source code or text file; no secrets, symlinks or files outside project roots.', args: { project: arg('Project name'), file: arg('Relative source path'), startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 200 } }, execute: wrap(tools.read_file) },
      search_text: { description: 'Search exact text within allowed source files, bounded to 300 files and 50 matches.', args: { project: arg('Project name'), query: arg('Literal search text'), directory: arg('Relative directory, default .'), maxMatches: { type: 'integer', minimum: 1, maximum: 50 } }, execute: wrap(tools.search_text) },
      git_status: { description: 'Read Git worktree status from allowed local project; no changes made.', args: { project: arg('Project name') }, execute: wrap(tools.git_status) },
      git_diff: { description: 'Review unstaged changes to a specific allowed, existing source file; no changes made.', args: { project: arg('Project name'), file: arg('Relative tracked source file') }, execute: wrap(tools.git_diff) },
    }
  };
};
