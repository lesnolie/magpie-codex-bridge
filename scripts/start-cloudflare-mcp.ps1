# Start without prompting, after one-time setup-cloudflare-mcp.ps1.
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'cloudflare-mcp-adapter.mjs')
