---
name: testcollab-qa
description: "Use when executing a TestCollab test plan against a web app via browser automation. Fetches test cases, drives the browser, generates JUnit XML, uploads results."
version: 1.0.0
author: TestCollab
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [qa, testing, browser-automation, testcollab, test-plan, junit]
    category: software-development
    requires_toolsets: [terminal, browser]
    config:
      - key: testcollab.project_id
        description: "TestCollab project ID"
        default: ""
      - key: testcollab.api_url
        description: "TestCollab API base URL"
        default: "https://api.testcollab.io"
    required_environment_variables:
      - name: TESTCOLLAB_TOKEN
        description: "TestCollab API key from Account Settings > API Tokens"
---

# TestCollab QA Agent

Execute human-curated test plans from TestCollab against a live web application using browser automation, then report results back.

## Overview

This skill connects TestCollab's test management with Hermes' browser automation to create an on-demand QA agent. Humans curate test plans in TestCollab (what to test), and you execute them (how to test) via the browser, then upload pass/fail results.

The workflow uses two CLI commands from `@testcollab/cli`:

- `tc getTestPlan` — fetches a test plan as structured JSON (test cases, steps, expected results)
- `tc report` — uploads JUnit XML results back to TestCollab

## When to Use

- User asks you to run a TestCollab test plan
- User asks you to do QA testing against a web app using a test plan
- User provides a TestCollab project ID and test plan ID for execution
- User says "run the regression tests" or "execute the test plan" with TestCollab context

Don't use for:
- Unit testing or code-level testing (use test frameworks directly)
- Creating test plans (use TestCollab UI or `tc createTestPlan`)
- Syncing feature files (use `tc sync`)

## Prerequisites

Before starting, verify these are in place:

1. **@testcollab/cli installed globally:**
   ```bash
   npm list -g @testcollab/cli 2>/dev/null || npm install -g @testcollab/cli
   ```

2. **TESTCOLLAB_TOKEN set** in `~/.hermes/.env` or environment:
   ```bash
   echo "TESTCOLLAB_TOKEN=your-token-here" >> ~/.hermes/.env
   ```

3. **Target app running** at a known URL (e.g., `http://localhost:3000` or a staging URL)

## Procedure

### Step 1: Fetch the Test Plan

```bash
tc getTestPlan \
  --project <PROJECT_ID> \
  --test-plan-id <TEST_PLAN_ID> \
  --output /tmp/tc-plan.json
```

Read the output file to understand what needs testing:

```bash
cat /tmp/tc-plan.json
```

The JSON contains:
- `testPlan` — metadata (title, status, total cases)
- `testCases[]` — array of test cases, each with:
  - `id` — TestCollab case ID (needed for result mapping)
  - `title` — human-readable test name
  - `suite` — test suite grouping
  - `steps[]` — ordered steps with `step` (action) and `expectedResult` (assertion)
  - `priority` — low / normal / high

### Step 2: Execute Each Test Case

For each test case in the plan:

1. **Navigate** to the app's starting URL
2. **Perform each step** in order using browser tools:
   - `browser_navigate` — go to URLs
   - `browser_snapshot` — read the page accessibility tree
   - `browser_click` — click elements by reference ID (e.g., `@e5`)
   - `browser_type` — type into input fields
   - `browser_scroll` — scroll the page
   - `browser_press` — press keyboard keys
3. **Verify expected results** after each step:
   - Take a `browser_snapshot` and check the accessibility tree for expected text, elements, or states
   - Use `browser_vision` for visual verification when text matching is insufficient
4. **Record the outcome:**
   - **pass** — all steps completed and expected results matched
   - **fail** — any step's expected result did not match (capture the reason)
   - **skip** — could not execute (e.g., login prerequisite failed, page not loading)

### Step 3: Generate JUnit XML Results

After executing all test cases, write a JUnit XML file:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="TestCollab Plan: {PLAN_TITLE}" tests="{TOTAL}" failures="{FAIL_COUNT}" skipped="{SKIP_COUNT}">
    <!-- Passed test -->
    <testcase classname="{SUITE_NAME}" name="[TC-{ID}] {TITLE}" time="{SECONDS}"/>

    <!-- Failed test -->
    <testcase classname="{SUITE_NAME}" name="[TC-{ID}] {TITLE}" time="{SECONDS}">
      <failure message="{SHORT_REASON}">{DETAILED_DESCRIPTION}</failure>
    </testcase>

    <!-- Skipped test -->
    <testcase classname="{SUITE_NAME}" name="[TC-{ID}] {TITLE}">
      <skipped message="{REASON}"/>
    </testcase>
  </testsuite>
</testsuites>
```

**Critical:** The `[TC-{ID}]` prefix in the `name` attribute is how `tc report` maps results back to the correct test case. Without it, results create new cases instead of updating existing ones.

Write the file:
```bash
# Write to /tmp/tc-results.xml using write_file or terminal
```

### Step 4: Upload Results

```bash
tc report \
  --project <PROJECT_ID> \
  --test-plan-id <TEST_PLAN_ID> \
  --format junit \
  --result-file /tmp/tc-results.xml
```

### Step 5: Report Summary

After uploading, summarize:
- Total test cases executed
- Passed / Failed / Skipped counts
- Key failures with brief descriptions
- Link to results in TestCollab (if available)

## Execution Strategy

### Login handling

Many apps require authentication. Before executing test cases:

1. Navigate to the login page
2. Enter credentials (ask the user for credentials if not provided)
3. Verify login succeeded (check for dashboard/home page elements)
4. Proceed with test cases

If login fails, mark all dependent test cases as **skipped** with reason "Login prerequisite failed".

### Step interpretation

Test case steps are written in natural language. Interpret them contextually:

| Step text | Browser action |
|-----------|---------------|
| "Navigate to /settings" | `browser_navigate` to `{BASE_URL}/settings` |
| "Click the Save button" | `browser_snapshot` → find Save button → `browser_click` its ref |
| "Enter 'test@example.com' in the email field" | `browser_snapshot` → find email input → `browser_click` → `browser_type` |
| "Verify the success message appears" | `browser_snapshot` → check for success text in the tree |
| "The page title should be 'Dashboard'" | `browser_snapshot` → verify title element text |

### Expected result verification

Use the accessibility tree from `browser_snapshot` as the primary verification method:

- **Text presence**: Check if expected text appears in the tree
- **Element state**: Check for disabled, checked, selected attributes
- **Navigation**: Check if URL changed to expected path
- **Visual**: Use `browser_vision` as fallback for layout/visual assertions

A test case **passes** only when ALL steps complete AND the final expected result is verified.

## Configuration-Specific Plans

If the test plan has configurations (e.g., Browser x OS matrix), the JSON includes `configResults` per test case. For each configuration:

1. Set up the matching environment (browser, viewport, etc.)
2. Execute all test cases for that configuration
3. Include `config-id-{configId}` in the JUnit test name:
   ```xml
   <testcase classname="config-id-1.Permissions" name="[TC-42] Admin access check"/>
   ```

## Common Pitfalls

1. **Missing `[TC-ID]` in JUnit output.** Without the `[TC-{ID}]` prefix in test case names, `tc report` cannot map results back. Always include it.

2. **Rushing through steps.** Web pages need time to load. After navigation or form submission, take a `browser_snapshot` before asserting. If the page hasn't loaded, wait a moment and snapshot again.

3. **Hardcoding element selectors.** Accessibility trees change between page loads. Always take a fresh `browser_snapshot` before interacting with elements — don't reuse reference IDs from a previous snapshot.

4. **Not handling modals/overlays.** Cookie consent banners, onboarding tours, and notification popups can block interactions. Dismiss them before proceeding.

5. **Interpreting ambiguous expected results as pass.** When an expected result is vague (e.g., "page loads correctly"), verify at least one concrete element (a heading, a data table, a specific button) is present. Don't assume pass.

6. **Forgetting to set classname in JUnit.** The `classname` should match the test case's `suite` field. This groups results correctly in TestCollab.

7. **Generating malformed XML.** Escape special characters in failure messages: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`.

## Verification Checklist

- [ ] `tc getTestPlan` fetched the plan successfully
- [ ] All test cases were attempted (passed, failed, or skipped — none left unexecuted)
- [ ] JUnit XML has `[TC-{ID}]` prefix in every test case name
- [ ] JUnit XML has correct `classname` (suite name) for each test case
- [ ] Failure messages describe what was expected vs. what was observed
- [ ] `tc report` uploaded successfully (check output for confirmation)
- [ ] Summary reported to user with pass/fail/skip counts
