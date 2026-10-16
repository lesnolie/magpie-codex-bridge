# Magpie Local Project Review (v0.3.4 alpha)

A **read-only Magpie MCP tool plugin** for reviewing code produced by a cheaper model in **official local Codex** with ChatGPT Web acting as **advisor/reviewer**. **No ChatGPT Web model provider; no second Codex agent; no browser scraping.** GitHub remains the common source of truth after pushes.

## Automatically managed Windows remote MCP (v0.3.4 alpha)

For an **already configured Cloudflare Access MCP** connection, Magpie now
provides an opt-in **Project Review → ChatGPT 远程连接 → 自动启动** switch.

When enabled, the plugin host:

- checks for valid existing `%APPDATA%\magpie-local-review\cloudflare-mcp.json`;
- locates Node.js **20+**, installs versioned bundled adapter/manager scripts under
  `%LOCALAPPDATA%\MagpieLocalReview` (outside Magpie's updateable cache);
- registers the current user's **non-elevated, interactive-logon** Windows
  task **Magpie Local Review MCP (Managed)** and launches it immediately.
- uses a supervisor to wait for Magpie's local gateway (`127.0.0.1:3425`),
  bind the JWT-protected six-tool adapter (`127.0.0.1:48765`) only while
  Magpie is available, avoid interrupting an existing listener, and release
  the bridge when Magpie quits. It does *not* restart Magpie or cloudflared.

One-time opt-in is done through the Magpie plugin UI, **not a PowerShell
command**. Turning the switch off tells the plugin host to end/delete only
its own named task. It never touches unrelated tasks, Cloudflare Access,
project permissions or the previous C2C task. Service status is written to
`%LOCALAPPDATA%\MagpieLocalReview\service-status.json` (local only).

**Lifecycle limitation:** Magpie's community iframe can only save options,
not spawn processes; its Bun/Node plugin host may load lazily. The settings
change requests a host reload, but if no host is active, actual task
registration is deferred until Magpie next loads the plugin tools. The
page therefore shows the *requested preference*, not a verified running
status. For your first real Windows acceptance test, keep the previously
running adapter alive while enabling the toggle and refreshing ChatGPT's
tools. Thereafter the manager should start automatically at logon.
A successful CI run is not proof that Windows Task Scheduler accepted it.

**Important:** The custom ChatGPT Web MCP endpoint itself cannot remotely
start programs on an otherwise stopped PC. The Windows user must be signed in,
Magpie running, Cloudflare Tunnel connected, and this managed task installed.

## Existing Cloudflare Tunnel adapter (v0.3.3 alpha)

You can reuse a healthy Cloudflare Tunnel and fixed hostname, e.g. `c2c.ilxyz.xyz -> 127.0.0.1:48765`. This release **bundles** `scripts/cloudflare-mcp-adapter.mjs` plus a Windows setup launcher, and forwards only the six read-only project review tools to Magpie on `127.0.0.1:3425`. It rejects requests without a **cryptographically verified Cloudflare Access JWT**. Do **not** publish this without first protecting the entire hostname with a Cloudflare Access app limited to your own identity and enabling Managed OAuth.

**Configuration**: In the plugin's `scripts` folder double-click `setup-cloudflare-mcp.cmd`, provide the Access team domain and app audience, and keep the PowerShell console running for initial verification. It does not change Cloudflare Tunnel routes or resurrect the previous C2C program. See [full Cloudflare configuration, authentication, tests, autostart, and troubleshooting](docs/cloudflare-mcp.md). ChatGPT's HTTPS MCP URL is `https://c2c.ilxyz.xyz/mcp` (use **HTTPS URL**, not OpenAI Tunnel). Windows Magpie tool-host may start lazily; the new opt-in manager registers a persistent logon task once the host loads, rather than relying on tool calls to launch a server for every request.

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

## Manage project permissions directly in Magpie (v0.3.2 alpha)

**No second download and no manual JSON editing.** Update this plugin in Magpie and open the new **Project Review** entry in Magpie's sidebar under **Plugins**. Paste the full folder path from Windows Explorer (open the folder, Alt+D then Ctrl+C), then click **添加项目**. Remove permissions from the same page. All changes are stored in the plugin's own Magpie `options` and automatically reload the plugin host.

Magpie's [embedded plugin page API](https://usemagpie.ai/docs/plugins#pages-in-the-window) permits reading and saving only this plugin's options, **not obtaining local absolute paths from an OS folder dialog**. Thus the embedded page asks for a folder path rather than pretending to offer a native chooser. Magpie validates project roots when its tools are called; never select a whole drive/home directory.

## Optional legacy native Windows folder picker (v0.3.1)

**No editing `plugins.json` is required.** If you specifically want the native Windows system folder dialog, locate the bundled plugin files in Magpie’s plugin cache and double-click `scripts/manage-projects.cmd`. The helper opens a native **Choose folder** dialog with **Add folder**, **Remove selected** and **Done**. You may manage multiple approved projects at any time. Native helper changes take effect on the **next MCP tool call**, without restarting Magpie; page changes reload the tool host automatically. The helper runs locally only, does not start a network service, and is not callable through MCP.

The optional helper stores its small allowlist at `%APPDATA%\magpie-local-review\projects.json`, not inside Magpie's own `plugins.json`. Project names are derived from directory names (Latin letters/numbers; others transliterated to `-` or given a `project` name). This is intentionally separate from Codex's working-folder list. Removing a folder immediately blocks **new** MCP reads but does not retract data already returned in the conversation.

The local picker file takes precedence over legacy `options.roots`, but **not** over roots explicitly saved from the new Magpie embedded page. Deleting the picker file restores the old inline options. This design keeps older plugin installations working until the embedded page is used.

**Windows/WSL distinction:** The picker writes the Windows `%APPDATA%` file. If Magpie itself runs inside WSL/Linux, it cannot automatically see that Windows file. Use the original explicit Linux `roots` option (or point `MAGPIE_REVIEW_CONFIG_PATH` in Magpie's environment to a shared, accessible JSON file) until a WSL-specific helper is provided. On macOS/Linux, the original manual options remain available.

**Magpie UI:** The plugin now registers an embedded page under Plugins. Page-managed roots (once saved) take priority over the legacy Windows chooser file. A native folder picker cannot be invoked directly by this sandboxed page; the Windows helper remains optional.

## Configure allowed folders (alternative / non-Windows)

Do **not** make the root of a drive or your whole home directory available. Add only projects you intend to review. If Magpie does not yet support embedded plugin pages and the Windows folder picker cannot be used, edit `~/.config/magpie/plugins.json` in **the Magpie host's own environment**:

```json
{
  "plugins": [
    {
      "spec": "github:lesnolie/magpie-codex-bridge",
      "options": {
        "roots": [
          { "name": "TMN", "path": "C:/work/TMN" }
        ]
      }
    }
  ]
}
```

**Merge this entry into your existing plugins list; do not replace the whole file.** If Magpie runs in WSL instead of Windows, use an accessible Linux path (e.g. `/mnt/c/work/TMN`), not a Windows drive path. The plugin must run on a machine/environment that can read the desired project. Settings changed from the embedded page trigger Magpie to reload the plugin host; the separate Windows picker updates on the next call.

Existing users: click **Update** in Magpie after the new version is merged to `main`. The Magpie sidebar shows a new **Project Review** page when Magpie supports community plugin pages. The plugin's MCP tool list remains the same six read-only tools.

> The embedded page is tested with local mocks but has not yet been tested in the installed Windows Magpie application. If no page appears after updating the plugin, verify the Magpie application itself supports the community `magpie.page` API.

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

Tests are local Node mocks with a temporary Git repository, and **do not** prove that ChatGPT Web or Magpie on your Windows computer can reach the tools. Mainline publication is subject to real Windows acceptance testing.
