param(
  [string]$RepositoryName = 'magpie-codex-bridge'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) is required. Install it and run gh auth login.' }
& gh auth status
if ($LASTEXITCODE -ne 0) { throw 'Run gh auth login first.' }

if (-not (Test-Path '.git')) {
  & git init -b main
  if ($LASTEXITCODE -ne 0) { throw 'git init failed.' }
  & git add -A
  if ($LASTEXITCODE -ne 0) { throw 'git add failed.' }
  & git commit -m 'feat: Magpie Codex Bridge phase 1 prototype'
  if ($LASTEXITCODE -ne 0) { throw 'git commit failed. Configure git user.name and user.email.' }
}
if ((& git remote) -contains 'origin') { throw 'Repository already has an origin remote; inspect it before publishing.' }

Write-Host "Creating a PUBLIC GitHub repository '$RepositoryName'..."
& gh repo create $RepositoryName --public --source . --remote origin --push
if ($LASTEXITCODE -ne 0) { throw 'GitHub repository creation or push failed.' }
& gh repo view --web
