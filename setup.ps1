# Windows entry point. Usage:  .\setup.ps1 -Project "C:\path\to\your\project" [extra setup.mjs flags]
param([string]$Project = "", [Parameter(ValueFromRemainingArguments = $true)] $Rest)
$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is required (18+)."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $a = Read-Host "Install Node.js LTS with winget now? [y/N]"
        if ($a -match '^(y|yes)$') { winget install --id OpenJS.NodeJS.LTS -e --source winget; Write-Host "Open a NEW terminal and run setup.ps1 again."; exit 0 }
    }
    Write-Host "Install it from https://nodejs.org and run setup.ps1 again."; exit 1
}
$args2 = @()
if ($Project) { $args2 += @("--project", $Project) }
if ($Rest) { $args2 += $Rest }
node "$PSScriptRoot\scripts\setup.mjs" @args2
