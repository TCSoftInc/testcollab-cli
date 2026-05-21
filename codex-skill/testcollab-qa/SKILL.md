---
name: testcollab-qa
description: Execute a TestCollab test plan against a web app via browser automation. Fetches test cases with `tc getTestPlan`, drives the browser to run each case, writes JUnit XML, and uploads results with `tc report`. Use when the user asks to run a TestCollab test plan, execute regression tests from TestCollab, or do QA against a web app with a given project/test-plan ID.
metadata:
  short-description: Run a TestCollab test plan as an AI QA tester
---

# TestCollab QA Agent

Execute human-curated test plans from TestCollab against a live web application using browser automation, then upload pass/fail results back to TestCollab.

## When to Use

- User asks you to run a TestCollab test plan
- User provides a TestCollab project ID and test plan ID and an app URL
- User says "run the regression tests" / "execute the test plan" in a TestCollab context

Don't use for:
- Unit testing or code-level tests (use the project's test framework)
- Creating test plans (use the TestCollab UI or `tc createTestPlan`)
- Syncing feature files (use `tc sync`)

## Prerequisites

1. **`@testcollab/cli` installed globally** — `npm install -g @testcollab/cli` (provides the `tc` command)
2. **`TESTCOLLAB_TOKEN` set** in the environment (from Account Settings > API Tokens in TestCollab)
3. **A browser automation tool** available in the shell:
   - `playwright-cli` (preferred — `npm install -g @executeautomation/playwright-cli` or equivalent), OR
   - Any browser tool Codex already has connected via MCP
4. **Target app running** at a known URL (e.g., `http://localhost:3000` or a staging URL)

## Arguments

The user should provide:
- `--project <id>` — TestCollab project ID
- `--test-plan-id <id>` — Test plan ID to execute
- `--url <app-url>` — App URL to test against

If any are missing, ask the user before proceeding.

## Procedure

### Step 1: Fetch the test plan

```bash
tc getTestPlan \
  --project <PROJECT_ID> \
  --test-plan-id <TEST_PLAN_ID> \
  --output /tmp/tc-plan.json
```

Read `/tmp/tc-plan.json`. The JSON contains:
- `testPlan` — metadata (title, status, total cases)
- `testCases[]` — array of cases, each with:
  - `id` — TestCollab case ID (needed for result mapping)
  - `title` — human-readable test name
  - `suite` — test suite grouping
  - `steps[]` — ordered steps with `step` (action) and `expectedResult` (assertion)
  - `priority` — low / normal / high

### Step 2: Open the browser

Open the app URL using your available browser tool. With `playwright-cli`:

```bash
playwright-cli open <APP_URL> --browser=chromium
playwright-cli snapshot
```

Confirm the page loaded by reading the snapshot's accessibility tree.

### Step 3: Execute each test case

For every test case in the plan:

1. Read the steps and expected results.
2. Perform each step in order:
   - **Navigate** → `playwright-cli goto <url>`
   - **Click** → `playwright-cli snapshot`, find the element by visible text, then `playwright-cli click <ref>`
   - **Type/Fill** → `playwright-cli fill <ref> "value"` or `playwright-cli type "value"`
   - **Verify** → `playwright-cli snapshot` and check the accessibility tree for the expected text/state
3. Record the outcome:
   - **pass** — all steps completed AND expected results matched
   - **fail** — any expected result didn't match (capture what was expected vs. what was found)
   - **skip** — couldn't execute (e.g., login prerequisite failed)

Important:
- Always take a fresh snapshot before interacting — element refs change between page loads.
- Use the accessibility tree text for verification, not screenshots.
- If a page needs time to load, snapshot again before asserting.
- Dismiss cookie banners, onboarding tours, and notification popups before proceeding.

### Step 4: Generate JUnit XML

Write `/tmp/tc-results.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="TestCollab Plan: {PLAN_TITLE}" tests="{TOTAL}" failures="{FAIL_COUNT}" skipped="{SKIP_COUNT}">
    <!-- Passed -->
    <testcase classname="{SUITE_NAME}" name="[TC-{ID}] {TITLE}" time="{SECONDS}"/>

    <!-- Failed -->
    <testcase classname="{SUITE_NAME}" name="[TC-{ID}] {TITLE}" time="{SECONDS}">
      <failure message="{SHORT_REASON}">Expected: {EXPECTED}
Actual: {ACTUAL}</failure>
    </testcase>

    <!-- Skipped -->
    <testcase classname="{SUITE_NAME}" name="[TC-{ID}] {TITLE}">
      <skipped message="{REASON}"/>
    </testcase>
  </testsuite>
</testsuites>
```

**Critical:** The `[TC-{ID}]` prefix in `name` is how `tc report` maps results back to the correct TestCollab case. Without it, results create new cases instead of updating existing ones. Escape `&` `<` `>` `"` in failure messages.

### Step 5: Upload results

```bash
tc report \
  --project <PROJECT_ID> \
  --test-plan-id <TEST_PLAN_ID> \
  --format junit \
  --result-file /tmp/tc-results.xml
```

### Step 6: Close the browser

```bash
playwright-cli close
```

### Step 7: Summarize for the user

Print a short summary:
- Test plan name
- Total / Passed / Failed / Skipped counts
- Each case with ID, title, result
- For failures, expected vs. actual

## Configuration-Specific Plans

If the plan has configurations (Browser × OS matrix), `configResults` is present per case. For each configuration:
1. Set up the matching environment (browser, viewport, etc.)
2. Execute all cases for that configuration
3. Include `config-id-{configId}` in the JUnit classname:
   ```xml
   <testcase classname="config-id-1.Permissions" name="[TC-42] Admin access check"/>
   ```

## Common Pitfalls

1. **Missing `[TC-ID]` prefix in JUnit names** — `tc report` cannot map results back without it.
2. **Reusing stale element refs** — always re-snapshot before clicking/typing.
3. **Asserting before the page loaded** — snapshot, wait if needed, snapshot again.
4. **Not dismissing modals** — banners and popups block interactions.
5. **Calling vague expected results a pass** — verify at least one concrete element is present.
6. **Wrong `classname`** — should match the test case's `suite` field so results group correctly.
7. **Malformed XML** — escape `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`.

## Verification Checklist

- [ ] `tc getTestPlan` fetched the plan successfully
- [ ] Every test case was attempted (pass, fail, or skip — none left unexecuted)
- [ ] JUnit XML has `[TC-{ID}]` in every case name
- [ ] JUnit XML has correct `classname` per case
- [ ] Failure messages describe expected vs. observed
- [ ] `tc report` uploaded successfully
- [ ] Summary printed for the user
