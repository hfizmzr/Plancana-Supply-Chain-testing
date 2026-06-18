# ============================================================
# run_f08.ps1 — Plancana F08 & F08.1 Selenium Test Runner
# View Traceability & View Product History
#
# Usage (from repo root):
#   cd tests\selenium
#   .\run_f08.ps1
#
# Requirements:
#   - Python 3.x installed and on PATH
#   - Google Chrome installed
#   - ChromeDriver on PATH (version must match Chrome)
#     Download: https://chromedriver.chromium.org/downloads
#   - VALID_BATCH_ID and INCOMPLETE_BATCH_ID set in test_f08_traceability.py
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "======================================" -ForegroundColor Cyan
Write-Host "  Plancana F08 / F08.1 Selenium Tests" -ForegroundColor Cyan
Write-Host "  View Traceability & Product History" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# --- Verify Python is available ---
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Python not found on PATH. Install Python 3 and try again." -ForegroundColor Red
    exit 1
}

$pythonVersion = python --version 2>&1
Write-Host "Using $pythonVersion" -ForegroundColor Gray

# --- Install / upgrade dependencies ---
Write-Host ""
Write-Host "Installing dependencies from requirements.txt..." -ForegroundColor Yellow
python -m pip install -r requirements.txt --quiet
if (-not $?) {
    Write-Host "ERROR: pip install failed." -ForegroundColor Red
    exit 1
}

# --- Warn if batch IDs are still placeholders ---
$testFile = Get-Content "test_f08_traceability.py" -Raw
if ($testFile -match "REPLACE_WITH_VALID_BATCH_ID") {
    Write-Host ""
    Write-Host "WARNING: VALID_BATCH_ID is still a placeholder." -ForegroundColor Yellow
    Write-Host "         Update test_f08_traceability.py before running TC-08-001, 005, 006." -ForegroundColor Yellow
}
if ($testFile -match "REPLACE_WITH_INCOMPLETE_BATCH_ID") {
    Write-Host "WARNING: INCOMPLETE_BATCH_ID is still a placeholder." -ForegroundColor Yellow
    Write-Host "         Update test_f08_traceability.py before running TC-08-004." -ForegroundColor Yellow
}

# --- Run tests ---
Write-Host ""
Write-Host "Running tests..." -ForegroundColor Yellow
Write-Host ""

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$reportFile = "report_f08_$timestamp.html"

python -m pytest test_f08_traceability.py `
    -v `
    --html=$reportFile `
    --self-contained-html `
    --tb=short

$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "All tests passed." -ForegroundColor Green
} else {
    Write-Host "Some tests failed. Check output above." -ForegroundColor Red
}

Write-Host "HTML report saved to: tests\selenium\$reportFile" -ForegroundColor Cyan
Write-Host ""

exit $exitCode
