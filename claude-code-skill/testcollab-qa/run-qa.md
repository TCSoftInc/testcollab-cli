Execute a TestCollab test plan as an AI QA tester using browser automation.

Arguments: $ARGUMENTS
Expected format: `--project <id> --test-plan-id <id> --url <app-url>` (all required)

## Instructions

You are an AI QA tester. You will fetch a test plan from TestCollab, execute each test case in a real browser, and upload the results back.

### Step 1: Parse arguments

Extract `--project`, `--test-plan-id`, and `--url` from the arguments. If any are missing, ask the user.

### Step 2: Fetch the test plan

```bash
tc getTestPlan --project <project-id> --test-plan-id <plan-id> --output /tmp/tc-plan.json
```

Read `/tmp/tc-plan.json` to get the test plan and its test cases.

### Step 3: Open the browser

```bash
playwright-cli open <app-url> --browser=chromium
```

Take a snapshot to confirm the page loaded:

```bash
playwright-cli snapshot
```

### Step 4: Execute each test case

For each test case in the plan:

1. Read the test case steps and expected results
2. Execute each step using playwright-cli commands:
   - **Navigate**: `playwright-cli goto <url>`
   - **Click**: Take a `playwright-cli snapshot`, find the element by its visible text, then `playwright-cli click <ref>`
   - **Type/Fill**: `playwright-cli fill <ref> "value"` or `playwright-cli type "value"`
   - **Verify**: Take a `playwright-cli snapshot` and check the accessibility tree for the expected content
3. Record the result: PASS if all expected results match, FAIL with details if any don't match, SKIP if a step can't be executed

Important:
- Always take a snapshot before interacting with elements — you need the ref IDs
- Use the accessibility tree text to verify expected results, not screenshots
- If a page needs time to load, take another snapshot after a short wait
- If login is needed and credentials are in the arguments, handle login first

### Step 5: Generate JUnit XML

Write a JUnit XML file to `/tmp/tc-results.xml` with this format:

```xml
<testsuite name="<plan-title>" tests="<count>" failures="<fail-count>">
  <testcase classname="<suite>" name="[TC-<id>] <title>" time="<seconds>"/>
  <!-- For failures: -->
  <testcase classname="<suite>" name="[TC-<id>] <title>" time="<seconds>">
    <failure message="<what failed>">
      Expected: <expected result>
      Actual: <what was found>
    </failure>
  </testcase>
</testsuite>
```

The `[TC-<id>]` prefix in the name is critical — it maps results back to TestCollab test cases.

### Step 6: Upload results

```bash
tc report --project <project-id> --test-plan-id <plan-id> --format junit --result-file /tmp/tc-results.xml
```

### Step 7: Close the browser

```bash
playwright-cli close
```

### Step 8: Report summary

Print a summary table:
- Test plan name
- Total / Passed / Failed / Skipped counts
- Each test case with its ID, title, and result
- For failures, include what was expected vs. what was found
