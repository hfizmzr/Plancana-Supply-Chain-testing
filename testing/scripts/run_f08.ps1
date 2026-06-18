# =============================================================================
# run_f08.ps1 — Plancana F08 & F08.1 Selenium Test Runner (PowerShell)
# View Traceability & View Product History
#
# Usage (from testing\scripts):
#   .\run_f08.ps1                           # seed + headless tests
#   .\run_f08.ps1 -headed                   # seed + visible browser
#   .\run_f08.ps1 -headed -keepOpen         # browser stays open after tests
#   .\run_f08.ps1 -skipSeed                 # skip seeding (reuse batch_ids.json)
#   .\run_f08.ps1 -report                   # generate HTML report
#   .\run_f08.ps1 -k "TC08001"              # filter to one test class
#
# NOTE: PowerShell switches use a single dash (-headed), not double dash (--headed)
#
# Prerequisites:
#   1. Node.js 18+  (node --version)
#   2. Python 3.9+  (python --version)
#   3. Google Chrome installed
#   4. Backend running at http://localhost:3000
#   5. Frontend running at http://localhost:3001
#   6. Blockchain network up  (docker compose ps)
#   7. DB seeded with accounts  (cd application && npx prisma db seed)
# =============================================================================

param(
    [switch]$headed,
    [switch]$keepOpen,
    [switch]$skipSeed,
    [switch]$report,
    [string]$k = ""
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  Plancana F08 / F08.1 Selenium Tests" -ForegroundColor Green
Write-Host "  View Traceability & Product History" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""

# ── Check Node.js ────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: node not found on PATH. Install Node.js 18+." -ForegroundColor Red
    exit 1
}
$nodeVer = node --version 2>&1
Write-Host "Node:   $nodeVer" -ForegroundColor Gray

# ── Check Python ─────────────────────────────────────────────
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: python not found on PATH. Install Python 3.9+." -ForegroundColor Red
    exit 1
}
$pyVer = python --version 2>&1
Write-Host "Python: $pyVer" -ForegroundColor Gray

# ── Install Python dependencies ───────────────────────────────
Write-Host "Installing Python dependencies..." -ForegroundColor Yellow
python -m pip install -r requirements.txt --quiet
if (-not $?) { Write-Host "ERROR: pip install failed." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Configuration:" -ForegroundColor Cyan
Write-Host "  Seed:      $(if ($skipSeed) { 'skipped (--skip-seed)' } else { 'yes' })"
Write-Host "  Mode:      $(if ($headed)   { 'headed (visible browser)' } else { 'headless' })"
Write-Host "  Keep open: $(if ($keepOpen) { 'yes' } else { 'no' })"
Write-Host "  Report:    $(if ($report)   { 'yes' } else { 'no' })"
Write-Host "  Filter:    $(if ($k)        { $k } else { '(all F08 tests)' })"
Write-Host ""

# ══════════════════════════════════════════════════════════════
#  STEP 1 — Seed test data
# ══════════════════════════════════════════════════════════════
if (-not $skipSeed) {
    Write-Host "── Step 1: Seeding test batch data ──" -ForegroundColor Yellow
    Write-Host ""

    node seed_test_data.js
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ERROR: Seed script failed." -ForegroundColor Red
        Write-Host "       Check that backend and blockchain are running." -ForegroundColor Red
        Write-Host "       Tip: run with --skip-seed to reuse existing batch_ids.json" -ForegroundColor Yellow
        exit 1
    }
    Write-Host ""
} else {
    Write-Host "── Step 1: Skipping seed (--skip-seed) ──" -ForegroundColor Gray

    if (-not (Test-Path "batch_ids.json")) {
        Write-Host "ERROR: --skip-seed used but batch_ids.json not found." -ForegroundColor Red
        Write-Host "       Run without --skip-seed first to generate it." -ForegroundColor Yellow
        exit 1
    }
    $ids = Get-Content "batch_ids.json" | ConvertFrom-Json
    Write-Host "  Using existing batch IDs:" -ForegroundColor Gray
    Write-Host "    VALID_BATCH_ID:      $($ids.VALID_BATCH_ID)" -ForegroundColor Gray
    Write-Host "    INCOMPLETE_BATCH_ID: $($ids.INCOMPLETE_BATCH_ID)" -ForegroundColor Gray
    Write-Host "    Seeded at:           $($ids.seeded_at)" -ForegroundColor Gray
    Write-Host ""
}

# ══════════════════════════════════════════════════════════════
#  STEP 2 — Run Selenium tests
# ══════════════════════════════════════════════════════════════
Write-Host "── Step 2: Running Selenium tests ──" -ForegroundColor Yellow
Write-Host ""

$pytestArgs = @("test_f08_traceability.py", "-v", "--tb=short", "--disable-warnings")

if ($headed)   { $pytestArgs += "--headed" }
if ($keepOpen) { $pytestArgs += "--keep-open" }
if ($k -and -not $k.StartsWith("-")) { $pytestArgs += "-k"; $pytestArgs += $k }

if ($report) {
    $timestamp  = Get-Date -Format "yyyyMMdd_HHmmss"
    $reportFile = "report_f08_$timestamp.html"
    $pytestArgs += "--html=$reportFile"
    $pytestArgs += "--self-contained-html"
    $env:HTML_REPORT_PATH = $reportFile
}

python -m pytest @pytestArgs
$exitCode = $LASTEXITCODE

# ══════════════════════════════════════════════════════════════
#  Summary
# ══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
if ($exitCode -eq 0) {
    Write-Host "  ALL TESTS PASSED" -ForegroundColor Green
} else {
    Write-Host "  TESTS FAILED (exit code: $exitCode)" -ForegroundColor Red
}
if ($report -and (Test-Path $reportFile)) {
    Write-Host ""
    Write-Host "  HTML report: $(Resolve-Path $reportFile)" -ForegroundColor Cyan
}
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""

exit $exitCode
