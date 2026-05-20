#!/usr/bin/env bash
# Run a TestCollab test plan using Hermes Agent as the QA executor.
#
# Usage:
#   ./run-qa.sh --project 16 --test-plan-id 555 --url http://localhost:3000
#
# Prerequisites:
#   - hermes installed and configured with an LLM provider
#   - @testcollab/cli installed (npm install -g @testcollab/cli)
#   - TESTCOLLAB_TOKEN set in environment or ~/.hermes/.env
#   - testcollab-qa skill installed (bash install.sh)

set -euo pipefail

PROJECT=""
TEST_PLAN_ID=""
APP_URL=""
API_URL="https://api.testcollab.io"

while [[ $# -gt 0 ]]; do
  case $1 in
    --project) PROJECT="$2"; shift 2 ;;
    --test-plan-id) TEST_PLAN_ID="$2"; shift 2 ;;
    --url) APP_URL="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ -z "$PROJECT" ] || [ -z "$TEST_PLAN_ID" ] || [ -z "$APP_URL" ]; then
  echo "Usage: $0 --project <id> --test-plan-id <id> --url <app-url>"
  echo ""
  echo "Options:"
  echo "  --project        TestCollab project ID"
  echo "  --test-plan-id   Test plan ID to execute"
  echo "  --url            App URL to test against (e.g., http://localhost:3000)"
  echo "  --api-url        TestCollab API URL (default: https://api.testcollab.io)"
  exit 1
fi

PLAN_FILE="/tmp/tc-plan-${TEST_PLAN_ID}.json"
RESULT_FILE="/tmp/tc-results-${TEST_PLAN_ID}.xml"

echo "=== TestCollab QA Agent ==="
echo "Project: $PROJECT"
echo "Test Plan: $TEST_PLAN_ID"
echo "App URL: $APP_URL"
echo ""

echo "Step 1: Fetching test plan..."
tc getTestPlan \
  --project "$PROJECT" \
  --test-plan-id "$TEST_PLAN_ID" \
  --api-url "$API_URL" \
  --output "$PLAN_FILE"

CASE_COUNT=$(cat "$PLAN_FILE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['testCases']))" 2>/dev/null || echo "?")
echo "   Found $CASE_COUNT test cases"
echo ""

echo "Step 2: Launching Hermes to execute test cases..."
hermes --prompt "Execute the TestCollab test plan at $PLAN_FILE against the app at $APP_URL. Follow the testcollab-qa skill procedure. Write JUnit XML results to $RESULT_FILE. Do not run tc report — I will handle that." --accept-hooks 2>&1

echo ""
echo "Step 3: Uploading results..."
if [ -f "$RESULT_FILE" ]; then
  tc report \
    --project "$PROJECT" \
    --test-plan-id "$TEST_PLAN_ID" \
    --format junit \
    --result-file "$RESULT_FILE" \
    --api-url "$API_URL"
  echo ""
  echo "Done. Results uploaded to TestCollab."
else
  echo "Warning: Result file not found at $RESULT_FILE"
  echo "Check Hermes output for errors."
  exit 1
fi
