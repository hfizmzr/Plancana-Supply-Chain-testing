#!/usr/bin/env bash
# =============================================================================
# Plancana UC-5 Selenium Test Runner
#
# Prerequisites:
#   1. Python 3.9+ installed  
#   2. pip install -r requirements.txt
#   3. Plancana app running at http://localhost:3001
#   4. Backend API running at http://localhost:3000
#   5. Chrome installed (google-chrome): sudo apt-get install -y google-chrome-stable
#   6. WSLg enabled for GPU-accelerated ArcGIS maps (--headed)
#
# Usage:
#   ./run_tests.sh                         # headless, auto-close (SwiftShader GPU)
#   ./run_tests.sh --headed                # visible via WSLg (D3D12 GPU)
#   ./run_tests.sh --headed --keep-open    # browser stays open
#   ./run_tests.sh --report                # generate HTML report
#   ./run_tests.sh -k "test_01"            # filter by test name
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd)"

# ---- Colors ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Plancana UC-5 Selenium Test Suite${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# ---- Check prerequisites ----
echo "Checking prerequisites..."

if ! command -v python3 &>/dev/null; then
    echo -e "${RED}ERROR: python3 not found${NC}"
    exit 1
fi

if ! python3 -c "import selenium" 2>/dev/null; then
    echo -e "${YELLOW}selenium not installed. Running pip install...${NC}"
    pip install -r requirements.txt 2>&1 | tail -3
fi

# ---- Parse flags ----
HEADED=""
KEEP_OPEN=""
GEN_REPORT=""
PYTEST_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --headed)    HEADED="--headed"; shift ;;
        --keep-open) KEEP_OPEN="--keep-open"; shift ;;
        --report)    GEN_REPORT="true"; shift ;;
        *)           PYTEST_ARGS+=("$1"); shift ;;
    esac
done

# ---- Setup ----
export PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}"
# WSLg GPU: route Mesa OpenGL through D3D12 → Windows GPU
export GALLIUM_DRIVER="${GALLIUM_DRIVER:-d3d12}"

if [ -n "$GEN_REPORT" ]; then
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    REPORT_FILE="$SCRIPT_DIR/report_${TIMESTAMP}.html"
    export HTML_REPORT_PATH="$REPORT_FILE"
    PYTEST_ARGS+=("--html=$REPORT_FILE" "--self-contained-html")
fi

echo ""
echo -e "${CYAN}Configuration:${NC}"
echo "  Mode:     ${HEADED:+visible}${HEADED:-headless}"
echo "  Keep open: ${KEEP_OPEN:+yes}${KEEP_OPEN:-no}"
echo "  Report:   ${GEN_REPORT:+$REPORT_FILE}${GEN_REPORT:-(none)}"
echo "  Target:   ${PLANCANA_URL:-http://localhost:3001}"
echo ""

# ---- Run tests ----
echo -e "${GREEN}Running UC-5 tests...${NC}"
echo ""

python3 -m pytest \
    -v \
    --tb=short \
    --disable-warnings \
    -p no:cacheprovider \
    $HEADED \
    $KEEP_OPEN \
    "${PYTEST_ARGS[@]}" \
    . 2>&1 | tee test_run.log

EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo -e "${GREEN}========================================${NC}"
if [ "$EXIT_CODE" -eq 0 ]; then
    echo -e "${GREEN}  ALL TESTS PASSED${NC}"
else
    echo -e "${RED}  TESTS FAILED (exit code: $EXIT_CODE)${NC}"
    echo -e "${YELLOW}  See test_run.log for details${NC}"
fi

if [ -n "$GEN_REPORT" ] && [ -f "$REPORT_FILE" ]; then
    echo ""
    echo -e "${CYAN}  HTML Report:${NC} file://$REPORT_FILE"
fi
echo -e "${GREEN}========================================${NC}"

exit $EXIT_CODE
