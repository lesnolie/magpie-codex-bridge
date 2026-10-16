import { realpath, lstat, readdir, readFile } from 'node:fs/promises';
import { statSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_RESULTS = 80;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache', 'dist', 'build', 'coverage', '.idea', '.vscode', 'secrets', 'private']);
const SAFE_EXT = new Set(['.lua', '.md', '.txt', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.css', '.scss', '.html', '.htm', '.py', '.rs', '.go', '.c', '.h', '.cpp', '.hpp', '.java', '.kt', '.sh', '.ps1', '.sql', '.svg', '.diff', '.patch', '.ini', '.cfg', '.properties', '.gradle', '.sum']);
const SAFE_BASENAMES = new Set(['Dockerfile', 'Makefile', 'Gemfile', 'Rakefile', '.gitignore', '.editorconfig', '.gitattributes', '.npmrc.example']);
const DENY_NAME = /(^\.env(?:\.|$)|^\.npmrc$|(^|[._-])(password|passwd|secret|credential|token|private-key|id_rsa|id_ed25519)([._-]|$)|\.(pem|key|p12|pfx|kdbx|sqlite|db|env|crt)$)/i;

export function isAllowedEntry(name, isDirectory = false) {
  if (!name || name === '.' || name === '..' || DENY_NAME.test(name)) return false;
  if (isDirectory) return !SKIP_DIRS.has(name) && (!name.startsWith('.') || name === '.github');
  return SAFE_BASENAMES.has(name) || SAFE_EXT.has(path.extname(name).toLowerCase());
}

/** The picker writes a separate local-only allowlist; the MCP tool surface cannot edit it. */
export function projectsConfigPath(config = {}) {
  const specified = config.configPath || process.env.MAGPIE_REVIEW_CONFIG_PATH;
  if (specified) return path.resolve(specified);
  return process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'magpie-local-review', 'projects.json')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie-local-review', 'projects.json');
}

export function projectRoots(config = {}) {
  const file = projectsConfigPath(config);
  let input;
  // Explicitly saved in Magpie's embedded page: the page-owned allowlist wins,
  // including an empty list (revocation). Legacy native-picker files still work
  // until the user chooses to manage projects inside Magpie.
  if (config.rootsSource === 'magpie-page') {
    if (!Array.isArray(config.roots)) throw new Error('Invalid embedded project configuration: expected roots array');
    input = config.roots;
  } else if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || !Array.isArray(parsed.roots)) throw new Error('Invalid project manager configuration: expected roots array');
    input = parsed.roots;
  } else {
    input = config.roots ?? (process.env.MAGPIE_REVIEW_ROOTS || '').split(';').filter(Boolean);
  }
  if (!Array.isArray(input)) throw new Error('roots must be a list');
  const roots = input.map((entry, i) => {
    const folder = typeof entry === 'string' ? entry : entry?.path;
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error(`Project #${i + 1} requires an absolute path`);
    const resolved = realpathSync(folder);
    if (!statSync(resolved).isDirectory() || path.parse(resolved).root === resolved) throw new Error('Project must be a specific directory, not a filesystem root');
    const name = typeof entry === 'object' && entry.name ? String(entry.name) : path.basename(resolved);
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) throw new Error('Project name should contain only letters, numbers, dots, underscores or hyphens');
    return { name, root: resolved };
  });
  if (new Set(roots.map(x => x.name)).size !== roots.length) throw new Error('Duplicate project names');
  return roots;
}

function segments(relative = '.') {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes('\\')) throw new Error('Invalid relative path');
  if (relative === '.') return [];
  if (path.posix.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) throw new Error('Only project-relative paths are accepted');
  const parts = relative.split('/');
  if (parts.some(x => !x || x === '.' || x === '..')) throw new Error('Path traversal is not allowed');
  return parts;
}

async function locate(p, relative, kind = 'file') {
  const parts = segments(relative);
  let cursor = p.root;
  for (let i = 0; i < parts.length; i++) {
    const next = parts[i];
    if (!isAllowedEntry(next, i !== parts.length - 1 || kind === 'directory')) throw new Error('Hidden/secret or unsupported path');
    cursor = path.join(cursor, next);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('Symlinks are not exposed');
    if (i !== parts.length - 1 && !info.isDirectory()) throw new Error('Parent path is not a directory');
  }
  const actual = await realpath(cursor);
  // Sync realpath can preserve a Windows short 8.3 user profile alias
  // (RUNNER~1), while async realpath expands it (runneradmin). Normalize
  // both endpoints using the same async API before checking containment.
  // This still rejects directory escapes and symlink traversal.
  const canonicalRoot = await realpath(p.root);
  const canonicalRelative = path.relative(canonicalRoot, actual);
  if (canonicalRelative === '..' || canonicalRelative.startsWith('..' + path.sep) || path.isAbsolute(canonicalRelative)) {
    throw new Error('Path leaves project');
  }
  const info = await lstat(actual);
  if (kind === 'file' && !parts.length) throw new Error('Specify a file');
  if (kind === 'file' && !info.isFile()) throw new Error('Not a regular file');
  if (kind === 'directory' && !info.isDirectory()) throw new Error('Not a directory');
  return { actual, info };
}

function get(roots, name) {
  const p = roots.find(x => x.name === name);
  if (!p) throw new Error('Unknown project; call projects first');
  return p;
}
function safeOutput(x) { return JSON.stringify(x); }
function textLimit(text, limit = 30000) {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}
async function readSafe(actual, bytes = DEFAULT_MAX_BYTES) {
  const s = await lstat(actual);
  if (!s.isFile() || s.size > bytes) throw new Error(`File exceeds read limit (${bytes} bytes) or is not regular`);
  const buffer = await readFile(actual);
  if (buffer.includes(0)) throw new Error('Binary data not available');
  return buffer.toString('utf8');
}

export function createProjectTools(config = {}) {
  // Re-read the local allowlist for every request so the native picker takes effect immediately.
  // No MCP tool can add/remove roots; only the local user can edit the config file.
  const roots = () => projectRoots(config);
  const maxBytes = Math.min(DEFAULT_MAX_BYTES, Math.max(1024, Number(config.maxBytes) || DEFAULT_MAX_BYTES));
  return {
    projects: async () => safeOutput({ projects: roots().map(x => ({ name: x.name, directory: path.basename(x.root) })), readOnly: true }),
    list_files: async ({ project, directory = '.' }) => {
      const p = get(roots(), project);
      const { actual } = await locate(p, directory, 'directory');
      const entries = await readdir(actual, { withFileTypes: true });
      const items = entries.filter(e => !e.isSymbolicLink() && (e.isFile() || e.isDirectory()) && isAllowedEntry(e.name, e.isDirectory())).slice(0, MAX_RESULTS).map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
      return safeOutput({ project, directory, entries: items, truncated: entries.length > MAX_RESULTS });
    },
    read_file: async ({ project, file, startLine = 1, maxLines = 180 }) => {
      const p = get(roots(), project);
      const { actual } = await locate(p, file);
      const txt = await readSafe(actual, maxBytes);
      const lines = txt.split(/\r?\n/);
      const from = Math.max(1, Math.floor(Number(startLine) || 1));
      const take = Math.min(200, Math.max(1, Math.floor(Number(maxLines) || 180)));
      const chunk = lines.slice(from - 1, from - 1 + take).map((s, i) => `${from + i}: ${s}`).join('\n');
      return safeOutput({ project, file, startLine: from, totalLines: lines.length, ...textLimit(chunk) });
    },
    search_text: async ({ project, query, directory = '.', maxMatches = 30 }) => {
      if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('query must contain 1-200 characters');
      const p = get(roots(), project);
      const { actual } = await locate(p, directory, 'directory');
      const matches = [];
      let scanned = 0;
      const limit = Math.min(50, Math.max(1, Math.floor(Number(maxMatches) || 30)));
      const target = query.toLowerCase();
      async function walk(dir, depth = 0) {
        if (depth > 6 || scanned >= 300 || matches.length >= limit) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (scanned >= 300 || matches.length >= limit) break;
          if (entry.isSymbolicLink() || !isAllowedEntry(entry.name, entry.isDirectory())) continue;
          const next = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(next, depth + 1);
          else if (entry.isFile()) {
            scanned++;
            let txt;
            try { txt = await readSafe(next, maxBytes); } catch { continue; }
            const lines = txt.split(/\r?\n/);
            for (let i = 0; i < lines.length && matches.length < limit; i++) {
              if (lines[i].toLowerCase().includes(target)) matches.push({ file: path.relative(p.root, next).split(path.sep).join('/'), line: i + 1, preview: lines[i].slice(0, 220) });
            }
          }
        }
      }
      await walk(actual);
      return safeOutput({ project, query, matches, filesScanned: scanned, capped: scanned >= 300 || matches.length >= limit });
    },
    git_status: async ({ project }) => {
      const p = get(roots(), project);
      const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', 'status', '--short', '--untracked-files=normal'], { cwd: p.root, timeout: 5000, maxBuffer: 250000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
      const records = stdout.split(/\r?\n/).filter(Boolean).filter(line => {
        const f = line.slice(3).replace(/^"|"$/g, '').replace(/\\/g, '/');
        try { return segments(f).every((x, i, arr) => isAllowedEntry(x, i < arr.length - 1)); } catch { return false; }
      });
      return safeOutput({ project, changes: records.slice(0, MAX_RESULTS), truncated: records.length > MAX_RESULTS });
    },
    git_diff: async ({ project, file }) => {
      const p = get(roots(), project);
      await locate(p, file);
      const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', 'diff', '--no-ext-diff', '--no-textconv', '--', file], { cwd: p.root, timeout: 5000, maxBuffer: 100000, env: { ...process.env, GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
      return safeOutput({ project, file, ...textLimit(stdout) });
    },
  };
}
