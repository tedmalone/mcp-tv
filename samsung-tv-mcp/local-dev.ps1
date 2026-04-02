param(
  [switch]$SkipInstall,
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

Write-Host "== samsung-tv-mcp local workflow ==" -ForegroundColor Cyan

if (-not $SkipInstall) {
  Write-Host "[1/4] npm install" -ForegroundColor Yellow
  npm install
} else {
  Write-Host "[1/4] npm install (skipped)" -ForegroundColor DarkYellow
}

if (-not (Test-Path ".env")) {
  if (Test-Path ".env.example") {
    Copy-Item ".env.example" ".env"
    Write-Host "[2/4] Created .env from .env.example" -ForegroundColor Green
  } else {
    Write-Host "[2/4] No .env.example found; skipping .env bootstrap" -ForegroundColor DarkYellow
  }
} else {
  Write-Host "[2/4] .env already exists" -ForegroundColor Green
}

Write-Host "[3/4] npm run build" -ForegroundColor Yellow
npm run build

if (-not $SkipTest) {
  Write-Host "[4/4] npm test" -ForegroundColor Yellow
  npm test
} else {
  Write-Host "[4/4] test (skipped)" -ForegroundColor DarkYellow
}

Write-Host "Workflow complete." -ForegroundColor Green

if ($RunDev) {
  Write-Host "Starting dev server: npm run dev" -ForegroundColor Cyan
  npm run dev
} elseif ($RunStart) {
  Write-Host "Starting built server: npm start" -ForegroundColor Cyan
  npm start
}
