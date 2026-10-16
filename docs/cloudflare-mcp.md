# Reuse the existing Cloudflare Tunnel for read-only Magpie Project Review

Existing route: `c2c.ilxyz.xyz` through Healthy `codex-ilxyz` Tunnel to `http://127.0.0.1:48765`. Leave this route alone. The old `codex-with-chatgpt` program/port 48765 is obsolete.

The bundled `scripts/cloudflare-mcp-adapter.mjs` runs a minimal HTTP MCP proxy on `127.0.0.1:48765/mcp` and forwards **only six whitelisted read-only tools** to `http://127.0.0.1:3425/mcp/magpie/tools`. It also checks a signed Cloudflare Access JWT, including its RSA signature, issuer, expiration and the **specific Access Application AUD**. It does not expose Magpie's other tools or endpoints, and does not need the Magpie Gateway Key because it calls the loopback endpoint with no proxy-forwarding headers.

## Set up Cloudflare (required BEFORE starting public access)

1. Cloudflare dashboard > **Zero Trust > Access controls > Applications**. Add a **self-hosted** Access application protecting the hostname `c2c.ilxyz.xyz` (the entire host, including `/mcp`), or edit its existing Access app. Set an **Allow** policy limited to your own login identity/email and configure the intended identity provider. **Never add a Bypass/Everyone policy.**
2. Under the same app's **Advanced settings**, enable **Managed OAuth** (Cloudflare One). This lets ChatGPT complete an OAuth login instead of failing at a browser login redirect. Confirm that the app domain is protected by Access.
3. From Access Overview, copy the **Application AUD** and your Access **Team domain** (`<team>.cloudflareaccess.com`). They aren't secrets. No tunnel token or Cloudflare API token is required by this adapter. You MUST configure them for JWT validation.
4. On the Windows computer actually running Magpie (`3425`) and `cloudflared` (Cloudflare Tunnel connector), open a PowerShell console in the installed plugin folder and run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-cloudflare-mcp.ps1`. Enter the Team domain and Application AUD. It writes `%APPDATA%\magpie-local-review\cloudflare-mcp.json` and starts Node on `127.0.0.1:48765`.
5. Keep the console open and verify: `Get-NetTCPConnection -State Listen -LocalPort 3425,48765`. Use `https://c2c.ilxyz.xyz/mcp` in **ChatGPT Plugins > Add custom MCP server**, choose **HTTPS URL** (not OpenAI Tunnel) and OAuth. Complete Cloudflare login, then inspect exactly 6 read-only tools. If the Access screen does not offer Managed OAuth, don't switch the service to an anonymous/public mode.
6. After interactive verification, schedule `scripts/start-cloudflare-mcp.ps1` with Windows Task Scheduler as the signed-in user at logon, using `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <full-plugin-path>\scripts\start-cloudflare-mcp.ps1`. **Do not edit** or reuse the broken `Codex with ChatGPT - TMN` task until the new service is tested, and keep this script's folder stable across plugin updates.

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
