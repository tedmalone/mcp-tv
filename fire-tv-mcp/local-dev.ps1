param(
  [switch]$SkipInstall,
  [switch]$SkipCheckDeps,
  [switch]$SkipTest,
  [switch]$RunDev,
  [switch]$RunStart
)

$ErrorActionPreference = 'Stop'

if ($RunDev -and $RunStart) {
  throw "Use only one of -RunDev or -RunStart."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "== fire-tv-mcp local workflow ==" -ForegroundColor Cyan

if (-not $SkipInstall) {
  Write-Host "[1/5] npm install" -ForegroundColor Yellow
  npm install
} else {
  Write-Host "[1/5] npm install (skipped)" -ForegroundColor DarkYellow
}

if (-not (Test-Path ".env")) {
  if (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
    Write-Host "[2/5] Created .env from .env.example" -ForegroundColor Green
  } else {
    Write-Host "[2/5] No .env.example found; skipping .env bootstrap" -ForegroundColor DarkYellow
  }
} else {
  Write-Host "[2/5] .env already exists" -ForegroundColor Green
}

Write-Host "[3/5] npm run build" -ForegroundColor Yellow
npm run build

if (-not $SkipCheckDeps) {
  Write-Host "[4/5] npm run check-deps" -ForegroundColor Yellow
  npm run check-deps
} else {
  Write-Host "[4/5] check-deps (skipped)" -ForegroundColor DarkYellow
}

if (-not $SkipTest) {
  Write-Host "[5/5] npm test" -ForegroundColor Yellow
  npm test
} else {
  Write-Host "[5/5] test (skipped)" -ForegroundColor DarkYellow
}

Write-Host "Workflow complete." -ForegroundColor Green

if ($RunDev) {
  Write-Host "Starting dev server: npm run dev" -ForegroundColor Cyan
  npm run dev
} elseif ($RunStart) {
  Write-Host "Starting built server: npm start" -ForegroundColor Cyan
  npm start
}
