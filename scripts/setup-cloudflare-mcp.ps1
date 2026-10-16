# Run this once in the updated magpie-codex-bridge plugin folder.
# Cloudflare Zero Trust > Access > Applications > your Access app
# gives the TEAM domain and Application AUD value. Neither is a secret.
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js >=20 is required (node not found in PATH). Install Node.js or use an existing node.exe.' }
$major = [int]((& $node --version).Trim('v').Split('.')[0])
if ($major -lt 20) { throw 'Node.js >=20 is required' }
$scriptPath = Join-Path $PSScriptRoot 'cloudflare-mcp-adapter.mjs'
if (-not (Test-Path $scriptPath)) { throw "Missing adapter: $scriptPath" }
$dir = Join-Path $env:APPDATA 'magpie-local-review'
$file = Join-Path $dir 'cloudflare-mcp.json'
Write-Host 'Cloudflare Access -> Magpie read-only MCP adapter' -ForegroundColor Cyan
Write-Host 'Before using the PUBLIC route, protect c2c.ilxyz.xyz with Cloudflare Access and enable Managed OAuth.'
$team = Read-Host 'Cloudflare Access team domain (e.g. myteam.cloudflareaccess.com)'
$aud = Read-Host 'Application AUD tag (from Access app Overview)'
$team = ($team.Trim() -replace '^https://', '').TrimEnd('/').ToLowerInvariant()
if ($team -notmatch '^[a-z0-9-]+\.cloudflareaccess\.com$') { throw 'Invalid team domain' }
if ($aud -notmatch '^[a-zA-Z0-9_-]{6,256}$') { throw 'Invalid Application AUD' }
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$settings = @{ teamDomain = $team; audience = $aud } | ConvertTo-Json
[IO.File]::WriteAllText($file, $settings, (New-Object Text.UTF8Encoding($false)))
Write-Host "Configuration saved to: $file" -ForegroundColor Green
Write-Host 'Starting adapter on 127.0.0.1:48765. Leave this terminal running for first test.'
& $node $scriptPath
