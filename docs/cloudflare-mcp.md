# Reuse the existing Cloudflare Tunnel for read-only Magpie Project Review

Existing route: `c2c.ilxyz.xyz` through Healthy `codex-ilxyz` Tunnel to `http://127.0.0.1:48765`. Leave this route alone. The old `codex-with-chatgpt` program/port 48765 is obsolete.

The bundled `scripts/cloudflare-mcp-adapter.mjs` runs a minimal HTTP MCP proxy on `127.0.0.1:48765/mcp` and forwards **only six whitelisted read-only tools** to `http://127.0.0.1:3425/mcp/magpie/tools`. It also checks a signed Cloudflare Access JWT, including its RSA signature, issuer, expiration and the **specific Access Application AUD**. It does not expose Magpie's other tools or endpoints, and does not need the Magpie Gateway Key because it calls the loopback endpoint with no proxy-forwarding headers.

## Automatic lifecycle after first working connection (Windows)

If the Cloudflare app, tunnel and local JWT config already work, **you no
longer need to launch the Node adapter manually after each Windows login.**

In Magpie's **Project Review** page, enable **ChatGPT 远程连接 → 自动启动**
once. The next Magpie plugin host initialization registers an interactive,
least-privilege **Magpie Local Review MCP (Managed)** scheduled task pointing
to a stable copy under `%LOCALAPPDATA%\MagpieLocalReview`. A supervisor
waits for Magpie's `3425` gateway, opens `48765` while available, and
closes it again when Magpie stops. It leaves an already occupied `48765`
alone. The local state file is
`%LOCALAPPDATA%\MagpieLocalReview\service-status.json`.
Switching the toggle off removes only this plugin's HKCU Run value, deletes the opt-in marker and closes the plugin-owned listener on the manager's next tick.

**Installation diagnostics (v0.3.4-alpha.2):** The adapter's
`service-status.json` is written only if the background manager has
actually started. The plugin host now writes a separate
`%LOCALAPPDATA%\MagpieLocalReview\service-bootstrap.json`
as soon as it begins processing the saved auto-start option. It records
`initializing`, `checking-node`, `registering-windows-task`,
`task-start-requested`, `task-start-failed`, or `setup-failed`
(and a bounded error reason). If **neither file exists** after a
plugin update and options toggle, the host probably has not executed
the plugin initializer; do not claim the task has been installed.
The page's checkbox reflects the desired setting, not Windows status.

Magpie's embedded page can **only** modify plugin options; it cannot
launch a process or inspect the Windows task state. The plugin host may be
lazy: if it has not started since the settings update, installation waits
for plugin-host activation. The toggle therefore does not prove the task
is installed until checked on Windows. No credentials or secrets are
placed in the scheduled task or status file; the adapter retains strict
Cloudflare JWT checks and the same six-tool allowlist.

## Set up Cloudflare (required BEFORE starting public access)

1. Cloudflare dashboard > **Zero Trust > Access controls > Applications**. Add a **self-hosted** Access application protecting the hostname `c2c.ilxyz.xyz` (the entire host, including `/mcp`), or edit its existing Access app. Set an **Allow** policy limited to your own login identity/email and configure the intended identity provider. **Never add a Bypass/Everyone policy.**
2. Under the same app's **Advanced settings**, enable **Managed OAuth** (Cloudflare One). This lets ChatGPT complete an OAuth login instead of failing at a browser login redirect. Confirm that the app domain is protected by Access.
3. From Access Overview, copy the **Application AUD** and your Access **Team domain** (`<team>.cloudflareaccess.com`). They aren't secrets. No tunnel token or Cloudflare API token is required by this adapter. You MUST configure them for JWT validation.
4. On the Windows computer actually running Magpie (`3425`) and `cloudflared` (Cloudflare Tunnel connector), open a PowerShell console in the installed plugin folder and run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-cloudflare-mcp.ps1`. Enter the Team domain and Application AUD. It writes `%APPDATA%\magpie-local-review\cloudflare-mcp.json` and starts Node on `127.0.0.1:48765`.
5. Keep the console open and verify: `Get-NetTCPConnection -State Listen -LocalPort 3425,48765`. Use `https://c2c.ilxyz.xyz/mcp` in **ChatGPT Plugins > Add custom MCP server**, choose **HTTPS URL** (not OpenAI Tunnel) and OAuth. Complete Cloudflare login, then inspect exactly 6 read-only tools. If the Access screen does not offer Managed OAuth, don't switch the service to an anonymous/public mode.
6. After interactive verification, open Magpie **Project Review** and enable **自动启动** once. The plugin host will register the managed Windows task; you do **not** need to schedule `start-cloudflare-mcp.ps1` manually. The old `Codex with ChatGPT - TMN` task is not touched.

## Troubleshooting

- **502 from Cloudflare**: adapter is not listening at 48765 on the computer hosting `cloudflared`; verify its connector is on that Windows machine.
- **401 from Cloudflare Access**: you have not completed the OAuth login, or the Access policy denies you.
- **401 JSON from local adapter**: no valid `Cf-Access-Jwt-Assertion` header was sent, or the configured Team domain/AUD does not match the issued token. It intentionally cannot be tested anonymously via PowerShell to get source data.
- **502 JSON from local adapter**: Magpie at `127.0.0.1:3425` cannot be reached or returned a different protocol.
- `GET /mcp` returns 405; **only MCP POST** is implemented by Magpie's built-in `/mcp/magpie/tools` server.

## Security assumptions

The adapter listens on loopback only, checks JWT RSA signatures using the public keys from `<team>.cloudflareaccess.com/cdn-cgi/access/certs`, locks to a specific Application AUD, rejects all browser Origins, returns only permitted tools, blocks resources/prompts/unrecognized tool calls, strips CF headers on forwarding, and forwards to the hardcoded Magpie loopback endpoint. It does not authenticate by public domain name alone. Do not remove the Cloudflare Access policy. The content of ordinary source files may still contain embedded credentials; review allowed project roots. Deleting a root affects subsequent requests, not data already returned to a chat.

Authoritative references:
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt


### v0.3.4-alpha.3 Windows startup strategy

The v0.3.4-alpha.2 Scheduled Tasks command failed on one Windows system.
The replacement uses only the signed-in user's standard
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` registry key;
it is installed using PowerShell's .NET registry APIs via EncodedCommand,
which avoids schtasks argument quoting. It starts a detached, hidden Node
manager immediately and at subsequent Windows sign-ins. No admin account,
password, global service or Cloudflare changes are requested.

`service-bootstrap.json` now reports `registering-user-startup`,
`starting-manager`, or `manager-launch-requested`. Only
`service-status.json` reporting `online` means the adapter actually
listens. A missing runtime file with an installed startup registry entry
still requires Windows acceptance troubleshooting.

When disabling, this version deletes only its own HKCU Run value and
`service-enabled.flag`. Its manager detects that marker and exits; no
unknown process is killed. The previous plugin-owned scheduled-task name
(`Magpie Local Review MCP (Managed)`) is removed best-effort as an
upgrade migration, but other tasks are not modified.

The first real Windows login may briefly show a console window because
Node.js is a console application. The plugin launch from Magpie uses
`windowsHide` and starts without a console; future releases may add
a native hidden launcher if needed.
