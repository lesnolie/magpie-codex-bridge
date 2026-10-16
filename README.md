# Magpie Local Project Review (v0.3 alpha)

A **read-only Magpie MCP tool plugin** for reviewing code produced by a cheaper model in **official local Codex** with ChatGPT Web acting as **advisor/reviewer**. **No ChatGPT Web model provider; no second Codex agent; no browser scraping.** GitHub remains the common source of truth after pushes.

## Architecture

```text
Local Codex (budget model) ── edits/tests ──> allowed project directory ── git push ──> GitHub
                                              │                                  │
                                       Magpie tool plugin                       │
                                              │                                  │
                                         Magpie MCP                            │
                                              │                                  │
                                       Secure MCP Tunnel*                      │
                                              │                                  │
                              ChatGPT Web (advisor/reviewer) <─────────────────┘
```

*The ChatGPT account/workspace must support connecting custom MCP servers. If not, **use the already-connected GitHub integration** to review committed/pushed branches and PRs. No custom MCP tunnel is required for the GitHub fallback.

## Features (read only)

- `projects`: configured project names; does not expose arbitrary directories.
- `list_files`: list source files and subdirectories.
- `read_file`: read source lines, capped at 64 KiB per source file and 200 lines per call.
- `search_text`: literal text search, bounded by 300 scanned files and 50 matches.
- `git_status`: read uncommitted state (does not stage or commit).
- `git_diff`: read **unstaged diff for a specific existing source file**. Staged changes are visible through GitHub after commit/push; use `git status` to identify them locally.

No arbitrary shell, code write, git push or Codex session tools. The Magpie tools endpoint exposes **all enabled plugins' tools**, not just this one. Turn off unrelated sensitive tool plugins before granting remote access.

## Configure allowed folders

Do **not** make the root of a drive or your whole home directory available. Add only projects you intend to review. Configure via the Magpie UI (Settings → Plugins → Installed → plugin Options), or edit `~/.config/magpie/plugins.json` in **the Magpie host's own environment**:

```json
{
  "plugins": [
    {
      "spec": "github:lesnolie/magpie-codex-bridge#feat/local-project-review",
      "options": {
        "roots": [
          { "name": "TMN", "path": "C:/work/TMN" }
        ]
      }
    }
  ]
}
```

**Merge this entry into your existing plugins list; do not replace the whole file.** If Magpie runs in WSL instead of Windows, use an accessible Linux path (e.g. `/mnt/c/work/TMN`), not a Windows drive path. The plugin must run on a machine/environment that can read the desired project. Paths are resolved at plugin load; a changed options setting requires restarting/reloading the tool plugin host.

Local source install: `magpie plugin add ./magpie-local-review`. Git branch install: `magpie plugin add github:lesnolie/magpie-codex-bridge#feat/local-project-review` (test installation; do not replace your production plugin automatically). Magpie's installed tools list will include six new tools. Run `npm test` to validate the plugin itself.

> Until this branch is merged, treat it as a preview, not a production release. If Magpie already has the same GitHub plugin spec installed at another ref, use a local folder copy for isolated testing.

## Connect ChatGPT Web

1. Check ChatGPT **Plugins** → **Add custom MCP server**. Availability depends on the user's plan/workspace; OpenAI currently documents full custom MCP for Business/Enterprise/Edu and read/fetch custom MCP for Pro, and does not promise access for every Plus account.
2. If this option is available, run Magpie with its tool plugin enabled. Magpie serves local **Streamable HTTP** MCP at `http://127.0.0.1:3425/mcp/magpie/tools` (or the configured Magpie port).
3. Use OpenAI **Secure MCP Tunnel** to connect the local MCP server; do **not** simply expose Magpie's unauthenticated loopback gateway on the public internet. Configure the tunnel's authenticated connection and Magpie gateway key according to official docs. In ChatGPT Plugins, choose Tunnel and the provisioned tunnel ID, or an authenticated HTTPS MCP endpoint.
4. Confirm ChatGPT can list the `magpie-codex-bridge_projects` tool (exact prefix shown in Magpie). First ask it to list projects, read a harmless test Lua file, then inspect an unstaged diff.

Connecting Codex *to* Magpie via `codex mcp add` is **not necessary** for ChatGPT Web to review the local project.

## GitHub fallback (recommended to start)

Have local Codex work on a branch, run tests, and push commits or open a PR. ChatGPT Web can use the already connected GitHub integration to inspect diffs and provide actionable review comments. This works independently of whether custom MCP connectivity is enabled for your ChatGPT account. GitHub does not contain local uncommitted changes; those require an active local MCP connection.

Sample reviewer prompt:

> Review branch/PR against main. Focus on Lua logic, UI regression, performance, correctness and automated-test coverage. Explain each finding with file paths and changed code. Do not edit files unless I explicitly ask. Provide a focused task list for my local Codex to implement.

## Safety and limitations

- Only configured project directories can be referenced. No runtime tool can add or change roots.
- File reads reject absolute and parent-traversal paths, symlinks, secret-looking filenames and binary or oversized files; source extensions only.
- All tool calls are read-only. **This is defense in depth, not a DLP system**: credentials embedded in an ordinary `.lua` or `.js` source file could still be returned; audit folders before enabling remote access.
- `git diff` is limited to unstaged changes of one existing file. No shell commands are accepted from the model.
- A remote ChatGPT Web session is *not* connected just because a plugin loads successfully in Magpie. You must connect the MCP service separately, if your plan/workspace supports it.
- No local Codex app-server integration in this branch. ChatGPT and Codex coordinate through files, Git commits, PRs and optional human-approved task handoffs. Optional web Loop is deferred until the read-only review path works.

## Development

```bash
npm run check
npm test
```

Tests are local Node mocks with a temporary Git repository, and **do not** prove that ChatGPT Web or Magpie on your Windows computer can reach the tools. The `main` branch remains unchanged pending acceptance.
