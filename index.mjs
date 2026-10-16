import { createProjectTools } from './src/projects.mjs';
import { reconcileRemoteService, writeBootstrapStatus } from './src/remote-service.mjs';

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
  const tools = createProjectTools(options);
  return {
    tool: {
      projects: { description: 'List only explicitly allowed project names (read-only).', args: {}, execute: wrap(tools.projects) },
      list_files: { description: 'List non-secret files within an allowed project directory. Paths are project-relative.', args: { project: arg('Project name'), directory: arg('Relative directory, default .') }, execute: wrap(tools.list_files) },
      read_file: { description: 'Read a limited range of an allowed source code or text file; no secrets, symlinks or files outside project roots.', args: { project: arg('Project name'), file: arg('Relative source path'), startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 200 } }, execute: wrap(tools.read_file) },
      search_text: { description: 'Search exact text within allowed source files, bounded to 300 files and 50 matches.', args: { project: arg('Project name'), query: arg('Literal search text'), directory: arg('Relative directory, default .'), maxMatches: { type: 'integer', minimum: 1, maximum: 50 } }, execute: wrap(tools.search_text) },
      git_status: { description: 'Read Git worktree status from allowed local project; no changes made.', args: { project: arg('Project name') }, execute: wrap(tools.git_status) },
      git_diff: { description: 'Review unstaged changes to a specific allowed, existing source file; no changes made.', args: { project: arg('Project name'), file: arg('Relative tracked source file') }, execute: wrap(tools.git_diff) },
    }
  };
};
