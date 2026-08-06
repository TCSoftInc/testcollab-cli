# TestCollab CLI

Command-line tools for syncing Gherkin feature files, running test plans, and uploading results to [TestCollab](https://testcollab.com).

```
npm install -g @testcollab/cli
```

## Quick Start

Upload test results to TestCollab from your CI pipeline — no setup required:

```bash
export TESTCOLLAB_TOKEN=your_token_here

# Run your tests, then upload results (auto-creates everything in TestCollab)
tc report --project 123 --format junit --result-file ./results.xml --auto-create
```

That's it. The `--auto-create` flag creates the tag, suites, test cases, and test plan for you.

For more control, you can pre-create a test plan and map results by ID:

```bash
# Step 1: Create a test plan with your CI-tagged cases
tc createTestPlan --project 123 --ci-tag-id 456 --assignee-id 789

# Step 2: After running your tests, upload results
tc report --project 123 --test-plan-id 555 --format junit --result-file ./results.xml
```

Or sync BDD feature files to TestCollab:

```bash
tc sync --project 123
```

## Commands

| Command | What it does |
|---------|-------------|
| [`tc createBuild`](#tc-createbuild) | Record the build your pipeline just produced or deployed |
| [`tc createTestPlan`](#tc-createtestplan) | Create a test plan and assign tagged cases |
| [`tc getTestPlan`](#tc-gettestplan) | Fetch a test plan as JSON for agent-driven execution |
| [`tc report`](#tc-report) | Upload Mochawesome or JUnit results (with `--auto-create` or to an existing plan) |
| [`tc gate`](#tc-gate) | Fail the CI build unless a Test Plan's results meet the quality gate |
| [`tc sync`](#tc-sync) | Sync `.feature` files from Git to TestCollab (designed for CI/CD, works locally too) |

The simplest workflow is **run your tests → `report --auto-create`**. For more control, use **createTestPlan → run your tests → report**. For agent-driven execution of human-curated test plans, see the [Agentic QA Guide](docs/agentic-qa.md). To use [Hermes Agent](https://github.com/NousResearch/hermes-agent) as your QA executor with browser automation, see the [Hermes Agent Integration](docs/hermes-agent.md).

---

### `tc createBuild`

Records the version your pipeline just built or deployed as a **build** in TestCollab, so the version under test is captured at deploy time and results stay traceable to it. Run it as one step in whichever pipeline does the deploy — Azure DevOps, GitLab CI, Jenkins and GitHub Actions all work the same way, and TestCollab needs no access to your DevOps environment.

```bash
tc createBuild \
  --project <id> \
  --version <version> \
  [--environment <name>] \
  [--deployment-url <url>] \
  [--commit <sha>] \
  [--notes <text>] \
  [--api-key <key>] \
  [--api-url <url>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--project <id>` | Yes | Project ID |
| `--version <version>` | Yes | Version that was built or deployed (e.g. `2026.8.6-rc1`) |
| `--environment <name>` | No | Environment it was deployed to (e.g. `staging`) |
| `--deployment-url <url>` | No | Link back to the pipeline run — shown as the deployment link on the build |
| `--commit <sha>` | No | Commit SHA the build was produced from |
| `--notes <text>` | No | Free-text note about the build |
| `--api-key <key>` | No | TestCollab API key (or set `TESTCOLLAB_TOKEN` env var) |
| `--api-url <url>` | No | API base URL (default: `https://api.testcollab.io`). Use `https://api-eu.testcollab.io` for EU region. |

**Output:** Writes the build ID to `tmp/tc_build` as `TESTCOLLAB_BUILD_ID=<id>`, so later steps can reference it (the same way `createTestPlan` writes `tmp/tc_test_plan`).

- The build is **matched on version first and only created when it is missing**, so a re-run of the pipeline — or several jobs of the same run — never records the same version twice. A leading `v` is ignored when matching, so `v2.14.0` and `2.14.0` are one build.
- An existing build is **reused as-is**: a later stage never overwrites what the deploy stage recorded. Anything you pass that differs is reported and left unapplied.
- If the version matches a **release**'s version pattern, TestCollab attaches the build to that release. The CLI never creates a release.

#### Every value is a standard CI variable

The command is a one-liner in a pipeline file because each option maps to a variable the pipeline already has:

| Option | Azure DevOps | GitLab CI | GitHub Actions | Jenkins |
|--------|--------------|-----------|----------------|---------|
| `--version` | `$(Build.BuildNumber)` | `$CI_COMMIT_TAG` / `$CI_PIPELINE_IID` | `${{ github.run_number }}` | `$BUILD_NUMBER` |
| `--environment` | `$(Environment.Name)` | `$CI_ENVIRONMENT_NAME` | `${{ github.event.deployment.environment }}` | `$DEPLOY_ENV` |
| `--deployment-url` | `$(System.CollectionUri)$(System.TeamProject)/_build/results?buildId=$(Build.BuildId)` | `$CI_PIPELINE_URL` | `${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}` | `$BUILD_URL` |
| `--commit` | `$(Build.SourceVersion)` | `$CI_COMMIT_SHA` | `${{ github.sha }}` | `$GIT_COMMIT` |

```yaml
# Azure DevOps — after the deploy step
- script: |
    npx @testcollab/cli createBuild \
      --project $(TC_PROJECT_ID) \
      --version "$(Build.BuildNumber)" \
      --environment "$(Environment.Name)" \
      --commit "$(Build.SourceVersion)" \
      --deployment-url "$(System.CollectionUri)$(System.TeamProject)/_build/results?buildId=$(Build.BuildId)"
  env:
    TESTCOLLAB_TOKEN: $(TESTCOLLAB_TOKEN)
  displayName: Record build in TestCollab
```

Then run the tests against it, referencing the same version:

```bash
tc createTestPlan --project 45 --ci-tag-id 12 --assignee-id 7 --build "$(Build.BuildNumber)"
```

---

### `tc createTestPlan`

Creates a test plan, adds all test cases matching a CI tag, and assigns it to a user. Designed for CI pipelines where you want to automatically create a plan before running tests.

```bash
tc createTestPlan \
  --project <id> \
  --ci-tag-id <id> \
  --assignee-id <id> \
  [--build <idOrVersion>] \
  [--release <id>] \
  [--api-key <key>] \
  [--api-url <url>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--project <id>` | Yes | Project ID |
| `--ci-tag-id <id>` | Yes | Tag ID — test cases with this tag are added to the plan |
| `--assignee-id <id>` | Yes | User ID to assign the plan execution to |
| `--build <idOrVersion>` | No | Build the plan is executed against — a build ID or a version string (e.g. `2026.8.6-rc1`). Results are then traceable to that build. |
| `--release <id>` | No | Release ID the plan belongs to |
| `--api-key <key>` | No | TestCollab API key (or set `TESTCOLLAB_TOKEN` env var) |
| `--api-url <url>` | No | API base URL (default: `https://api.testcollab.io`). Use `https://api-eu.testcollab.io` for EU region. |

**Output:** Writes the created plan ID to `tmp/tc_test_plan` as `TESTCOLLAB_TEST_PLAN_ID=<id>`. You can source this file in subsequent CI steps.

#### Tying the plan to the version it tests

A pipeline that has just deployed a build can create its plan against that build in the same run, so the results carry the deployment context through to the build traceability views and release readiness:

```bash
# the version your pipeline just deployed — no need to look up a build ID first
tc createTestPlan --project 45 --ci-tag-id 12 --assignee-id 7 --build "$APP_VERSION"
```

- `--build` accepts either a **build ID** or a **version string**. A numeric value is looked up as an ID first and retried as a version, so a numeric version (e.g. a build number) works too.
- The build must already exist in TestCollab. If nothing matches, the command **fails with a clear message and creates no plan**, rather than leaving an unlinked plan behind — record the build first with [`tc createBuild`](#tc-createbuild) (or in the app under Test plans → Builds) and re-run.
- If several builds share the version, the command asks you to pass the build ID instead.
- Passing only `--build` is enough when the build belongs to a release: TestCollab fills the plan's release in from the build. Passing only `--release` links the release with no build attached.

---

### `tc getTestPlan`

Fetches a test plan and its test cases as structured JSON, designed to be consumed by AI coding agents (Claude Code, Cursor, Codex, etc.) that execute the cases against a running app via browser automation (e.g. Playwright MCP).

```bash
tc getTestPlan \
  --project <id> \
  --test-plan-id <id> \
  [--api-key <key>] \
  [--api-url <url>] \
  [--output <path>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--project <id>` | Yes | Project ID |
| `--test-plan-id <id>` | Yes | Test plan ID to fetch |
| `--api-key <key>` | No | TestCollab API key (or set `TESTCOLLAB_TOKEN` env var) |
| `--api-url <url>` | No | API base URL (default: `https://api.testcollab.io`). Use `https://api-eu.testcollab.io` for EU region. |
| `--output <path>` | No | Write JSON to file instead of stdout |

**Output shape** (HTML is stripped from step text and descriptions):

```json
{
  "testPlan": {
    "id": 555,
    "title": "Sprint 12 Regression",
    "status": "ready",
    "description": "Regression tests for sprint 12 release",
    "priority": "normal",
    "totalCases": 15
  },
  "testCases": [
    {
      "id": 42,
      "testPlanTestCaseId": 789,
      "title": "Regular user cannot access admin settings",
      "description": "Verify that a non-admin user is blocked from the admin panel",
      "priority": "high",
      "suite": "Permissions",
      "status": "unexecuted",
      "steps": [
        { "step": "Log in as testuser@example.com", "expectedResult": "Dashboard is displayed" },
        { "step": "Navigate to /admin/settings", "expectedResult": "403 page is shown" }
      ]
    }
  ]
}
```

If the plan has configurations (e.g. Browser × OS matrix), each test case also includes a `configResults` array with per-configuration status.

**Piping:** progress messages go to stderr so stdout stays clean.

```bash
# Pipe to jq
tc getTestPlan --project 16 --test-plan-id 555 2>/dev/null | jq '.testCases | length'

# Write to file for an agent to consume
tc getTestPlan --project 16 --test-plan-id 555 --output /tmp/plan.json
```

For the full agent-driven QA workflow that combines this with `tc report`, see the [Agentic QA Guide](docs/agentic-qa.md).

---

### `tc report`

Parses a test result file (Mochawesome JSON or JUnit XML) and uploads results to a TestCollab test plan.

```bash
# Auto-create mode (zero setup)
tc report --project <id> --format <mochawesome|junit> --result-file <path> --auto-create

# Existing plan mode
tc report --project <id> --test-plan-id <id> --format <mochawesome|junit> --result-file <path>
```

| Option | Required | Description |
|--------|----------|-------------|
| `--project <id>` | Yes | Project ID |
| `--test-plan-id <id>` | * | Test plan to attach results to (required unless `--auto-create`) |
| `--format <type>` | Yes | `mochawesome` or `junit` |
| `--result-file <path>` | Yes | Path to the result file |
| `--api-key <key>` | No | TestCollab API key (or set `TESTCOLLAB_TOKEN` env var) |
| `--api-url <url>` | No | API base URL override (default: `https://api.testcollab.io`). Use `https://api-eu.testcollab.io` for EU region. |
| `--skip-missing` | No | Mark test cases in the test plan but not in the result file as **skipped** |
| `--auto-create` | * | Auto-create tag, suites, test cases, folder, and test plan from result file |
| `--build <idOrVersion>` | No | Build the results were run against, by id or version. A version with no build yet is created as one. Requires `--auto-create`. |
| `--environment <name>` | No | Environment recorded on the build when `--build` creates it (e.g. `Staging`) |

> \* Either `--test-plan-id` or `--auto-create` is required (they are mutually exclusive).

**Output:** Writes the resolved test plan id to `tmp/tc_test_plan` as `TESTCOLLAB_TEST_PLAN_ID=<id>` for both modes (the `--auto-create` plan or the `--test-plan-id` you passed). A later CI step can source it, so `tc report --auto-create` can be followed by `tc gate` without hardcoding the plan id.

#### `--auto-create`

The zero-setup option for CI pipelines. When `--auto-create` is passed instead of `--test-plan-id`, the CLI parses your result file and automatically creates everything needed in TestCollab:

```bash
tc report \
  --project 123 \
  --format junit \
  --result-file ./results.xml \
  --auto-create
```

**What it creates (only if missing):**

| Resource | Name | Created once or every run? |
|----------|------|---------------------------|
| Tag | `CI Imported` | Once (reused on subsequent runs) |
| Test suites | Humanized from classname/describe block | Once per unique name |
| Test cases | From test names in result file | Once (matched by ID or title on subsequent runs) |
| Test plan folder | `CI` | Once |
| Test plan | `CI Run: DD-MM-YYYY HH:MM` | Every run |
| Build | From `--build <version>` | Once per version (reused on later runs) |

**How test matching works:**

- If a test name contains a TC ID (e.g., `[TC-42] should login`) — matched by ID
- If no TC ID — matched by normalized title within the same suite (case-insensitive, whitespace-collapsed)
- If no match at all — a new test case is created

Both modes can coexist in the same result file. Some tests can have IDs while others rely on title matching.

**Suite name cleanup:** Raw suite names from test runners are automatically humanized:

| Raw (from test runner) | Becomes |
|------------------------|---------|
| `com.app.LoginTests` | `Login` |
| `tests/auth/login.spec.ts` | `Login` |
| `UserProfileTests` | `User Profile` |
| `user_profile_spec` | `User Profile` |

**Required permissions:** The API key must have permissions to create tags, suites, test cases, test plans, test plan folders, and assign test plans. Typically the **Admin** or **Lead** role. See [docs/auto-create.md](docs/auto-create.md) for the full list.

#### `--build` — tie the results to the version that was deployed

Pass the version your pipeline just deployed and the auto-created plan is linked to that build, so the results show up in the build's traceability view and in release readiness:

```bash
tc report \
  --project 123 \
  --format junit \
  --result-file ./results.xml \
  --auto-create \
  --build "$BUILD_VERSION" \
  --environment Staging
```

- `--build` takes a **build id or a version string**, the same as [`tc createTestPlan`](#tc-createtestplan). A numeric value is looked up as an id first and retried as a version, so numeric versions and build numbers work too.
- A build is simply a record of a version that was deployed, so if no build in the project has that version yet it is **created** from the version (and `--environment`, when given). An existing build is reused, and `--environment` is then ignored — the build already says which environment it is.
- If several builds in the project share the version, the command stops and asks for an id rather than guessing which one the results belong to. An id belonging to another project also stops the run, rather than being recorded as a new version.
- A **release is never created**. The plan picks up a release when one of the project's releases has a version pattern matching the build (for example pattern `2.14.*` and build `2.14.9`); otherwise the plan simply has no release. Releases stay a planning decision someone makes in TestCollab.
- `--build` requires `--auto-create`. A plan passed with `--test-plan-id` keeps whatever build it was already given.

#### `--skip-missing`

By default, test cases in the test plan that don't appear in the result file are left untouched. When `--skip-missing` is passed, these unmatched cases are automatically marked as **skipped**. This is useful when your result file only contains the tests that actually ran, and you want the full test plan status to reflect that anything not executed was skipped.

```bash
tc report \
  --project 123 \
  --test-plan-id 555 \
  --format junit \
  --result-file ./results.xml \
  --skip-missing
```

#### Mapping test cases

When using `--test-plan-id` (not `--auto-create`), your test names must include a TestCollab case ID so results can be matched. Any of these patterns work:

```
[TC-123] Login should succeed          ← bracketed
TC-123 Login should succeed            ← prefix
Login should succeed id-123            ← id- prefix
Login should succeed testcase-123      ← testcase- prefix
checkout-42                            ← whole name is a slug ending in the ID
```

A marker always wins over the trailing-number form, so `[TC-1730] ... and UTF-8` matches case
**1730**, not 8. The trailing-number form only applies when the *entire* name is a slug
(`checkout-42`, `login-flow-123`); a name that merely ends in a hyphenated number, such as
`Digest uses SHA-256`, carries no ID and needs an explicit marker.

When using `--auto-create`, IDs are optional — tests without IDs are matched by title or created automatically.

#### Configuration-specific runs

If your test plan uses multiple configurations, include the config ID in your test names:

- **Mochawesome:** Use `config-id-<id>` as a top-level suite title
- **JUnit:** Include `config-id-<id>` or `config-<id>` in the test case name or classname

#### Sample files

See `samples/reports/` for example Mochawesome and JUnit files you can reference.

#### Supported frameworks

Any framework that can produce **Mochawesome JSON** or **JUnit XML** works with `tc report`. Here's how popular frameworks generate compatible output:

| Framework | How to get compatible output | `--format` |
|-----------|------------------------------|------------|
| **Cypress** | `mochawesome` reporter (built-in plugin) | `mochawesome` |
| **Playwright** | `--reporter=junit` | `junit` |
| **Jest** | `jest-junit` package | `junit` |
| **Pytest** | `--junitxml=results.xml` (built-in) | `junit` |
| **TestNG** | Generates JUnit-compatible XML | `junit` |
| **JUnit 4/5** | Native JUnit XML output | `junit` |
| **Robot Framework** | `--xunit output.xml` | `junit` |
| **PHPUnit** | `--log-junit results.xml` (built-in) | `junit` |
| **Cucumber.js** | JUnit formatter plugin | `junit` |
| **Cucumber JVM** | JUnit XML via built-in plugin | `junit` |
| **WebDriverIO** | `@wdio/junit-reporter` | `junit` |
| **TestCafe** | `testcafe-reporter-junit` | `junit` |
| **Newman (Postman)** | `newman-reporter-junit` | `junit` |
| **Behave** | `--junit` flag (built-in) | `junit` |
| **Go (`go test`)** | `go-junit-report` | `junit` |
| **Kaspresso / Kotlin** | JUnit XML (inherits from JUnit runner) | `junit` |

For detailed setup instructions per framework, see [Framework Setup Guide](docs/frameworks.md).

---

### `tc gate`

Turn a TestCollab Test Plan into a **quality gate** for your pipeline. `tc gate` reads the plan's latest run results via the API and **exits non-zero when the gate is not met**, which fails the surrounding CI step (Azure DevOps, Jenkins, GitLab CI, Ansible, …).

```bash
tc gate --project <id> --test-plan-id <id> [--fail-on <statuses>] [options]
```

The minimum gate — any failing test case fails the build:

```bash
tc gate --project 45 --test-plan-id 123 --fail-on failed
```

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--project <id>` | Yes | — | TestCollab project ID |
| `--test-plan-id <id>` | Yes | — | Test Plan to evaluate |
| `--fail-on <statuses>` | No | `failed` | Comma-separated statuses that fail the gate (e.g. `failed,blocked`). User-defined statuses are supported. |
| `--max-failed <n>` | No | `0` | Tolerate up to N cases in `--fail-on` statuses before failing |
| `--min-pass-rate <pct>` | No | — | Fail if the pass rate (`passed / executed`) is below this percent |
| `--require-complete` | No | off | Fail if any case in the run is still unexecuted |
| `--config <id>` | No | — | Evaluate a single Test Plan configuration |
| `--regression <id>` | No | latest | Evaluate a specific run/regression |
| `--wait <seconds>` | No | `0` | Poll until the run has no unexecuted cases, up to this many seconds (for "hold the deploy until QA finishes") |
| `--poll-interval <seconds>` | No | `15` | Seconds between polls when `--wait` is set |
| `--api-key <key>` | No | — | API key (or set `TESTCOLLAB_TOKEN`) |
| `--api-url <url>` | No | `https://api.testcollab.io` | API base URL (use `https://api-eu.testcollab.io` for EU) |

**Exit codes:** `0` gate passed · `1` gate failed · `2` usage / API error.

Results are read **live** from the executed test cases of the plan's latest run, so the gate is correct immediately after a `tc report` upload in the same pipeline.

#### Example output

```
ℹ️  Test plan #123 "Checkout flow" — run #7
   unexecuted: 0 · passed: 10 · failed: 2 · skipped: 1 · blocked: 0  (13 total)
❌ Quality gate FAILED
   - 2 case(s) with status [failed]
```

#### Typical pipeline: run tests → report → gate

```bash
# 1. run your automated tests → JUnit/xUnit results
npx playwright test --reporter=junit

# 2. push the results into a TestCollab plan
tc report --project 45 --test-plan-id 123 --format junit --result-file results.xml

# 3. gate the build on the plan's results
tc gate --project 45 --test-plan-id 123 --fail-on failed --require-complete
```

See the [Azure DevOps quality gate guide](docs/azure-devops-quality-gate.md) for a full pipeline and an Ansible Tower example.

---

### `tc sync`

Synchronizes Gherkin `.feature` files from your Git repository with TestCollab. Features become test suites, scenarios become test cases. Designed to run in CI/CD pipelines (on push to main), but works locally too — it uses Git commit hashes to track what's already been synced.

```bash
tc sync --project <id> [--api-key <key>] [--api-url <url>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--project <id>` | Yes | TestCollab project ID |
| `--api-key <key>` | No | TestCollab API key (or set `TESTCOLLAB_TOKEN` env var) |
| `--api-url <url>` | No | API base URL (default: `https://api.testcollab.io`). Use `https://api-eu.testcollab.io` for EU region. |

#### How it works

1. Detects which `.feature` files changed since the last sync (using `git diff`)
2. Parses the Gherkin and calculates content hashes
3. Sends only the changes to TestCollab (creates, updates, renames, or deletes)

Only **committed** files are synced. Uncommitted changes are ignored (with a warning).

#### Example output

```
🔍 Fetching sync state from TestCollab...
📊 Last synced commit: a1b2c3d4
📊 Current HEAD commit: e5f6g7h8
📄 Found 3 change(s)
🚀 Syncing with TestCollab...

📊 Synchronization Results:
✨ Created 1 test case(s)
🔄 Updated 2 test case(s)
🔄 Renamed 1 suite(s)

✅ Synchronization completed successfully
```

#### Try it with a sample project

Fork [testcollab-bdd-demo](https://github.com/TCSoftInc/testcollab-bdd-demo) and run `tc sync` to see how it works before integrating with your own project.

---

## Authentication

All commands authenticate the same way. Provide your API key using **either** method:

1. **`--api-key` flag** (takes precedence)
2. **`TESTCOLLAB_TOKEN` environment variable** (recommended for CI/CD)

**Getting your API token:** Go to TestCollab → Account Settings → API Tokens.

**EU region:** If your TestCollab account is hosted in the EU, pass `--api-url https://api-eu.testcollab.io` to all commands.

### Setting the token

```bash
# macOS / Linux
export TESTCOLLAB_TOKEN=your_token_here

# Windows (Command Prompt)
set TESTCOLLAB_TOKEN=your_token_here

# Windows (PowerShell)
$env:TESTCOLLAB_TOKEN = "your_token_here"
```

---

## CI/CD Integration

The most common use case is uploading test results from CI. The simplest approach uses `--auto-create`:

### GitHub Actions

#### Upload test results (auto-create — recommended)

```yaml
name: Test Pipeline
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      TESTCOLLAB_TOKEN: ${{ secrets.TESTCOLLAB_TOKEN }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm install -g @testcollab/cli && npm ci

      # Run your tests (example: Playwright with JUnit output)
      - run: PLAYWRIGHT_JUNIT_OUTPUT_NAME=results.xml npx playwright test --reporter=junit

      # Upload results — auto-creates everything in TestCollab
      # --build ties the plan to the version that was tested (drop it if you
      # don't track builds)
      - run: |
          tc report \
            --project ${{ secrets.TC_PROJECT_ID }} \
            --format junit \
            --result-file results.xml \
            --auto-create \
            --build ${{ github.sha }}
```

#### Upload test results (manual plan — for full control)

If you need to control exactly which test cases go into the plan (via a CI tag), use the two-step `createTestPlan` + `report` workflow:

```yaml
name: Test Pipeline
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      TESTCOLLAB_TOKEN: ${{ secrets.TESTCOLLAB_TOKEN }}
      APP_VERSION: ${{ github.ref_name }}   # the version you just deployed
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm install -g @testcollab/cli && npm ci

      # Step 1: Create test plan with CI-tagged cases, tied to the deployed build
      #         (--build takes a build ID or a version string; drop it if you
      #          don't track builds, or use --release <id> on its own)
      - run: |
          tc createTestPlan \
            --project ${{ secrets.TC_PROJECT_ID }} \
            --ci-tag-id ${{ secrets.TC_CI_TAG_ID }} \
            --assignee-id ${{ secrets.TC_ASSIGNEE_ID }} \
            --build ${{ env.APP_VERSION }}

      # Step 2: Read the created test plan ID
      - run: cat tmp/tc_test_plan >> $GITHUB_ENV

      # Step 3: Run your tests (example: Cypress)
      - run: npx cypress run --reporter mochawesome

      # Step 4: Upload results to TestCollab
      - run: |
          tc report \
            --project ${{ secrets.TC_PROJECT_ID }} \
            --test-plan-id $TESTCOLLAB_TEST_PLAN_ID \
            --format mochawesome \
            --result-file ./mochawesome-report/mochawesome.json
```

#### Sync feature files (on .feature file changes)

If you use BDD and want to keep TestCollab in sync with your `.feature` files:

```yaml
name: Sync Feature Files
on:
  push:
    branches: [main]
    paths: ['**/*.feature']

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history required for accurate diffs

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm install -g @testcollab/cli

      - run: tc sync --project ${{ secrets.TC_PROJECT_ID }}
        env:
          TESTCOLLAB_TOKEN: ${{ secrets.TESTCOLLAB_TOKEN }}
```

> **Important:** `tc sync` requires `fetch-depth: 0` so it can compute accurate diffs against the last synced commit.

### GitLab CI

#### Upload test results (auto-create)

```yaml
test-and-report:
  stage: test
  image: node:22
  variables:
    TESTCOLLAB_TOKEN: $TESTCOLLAB_TOKEN
  before_script:
    - npm install -g @testcollab/cli && npm ci
  script:
    - PLAYWRIGHT_JUNIT_OUTPUT_NAME=results.xml npx playwright test --reporter=junit
    - tc report --project $TC_PROJECT_ID --format junit --result-file results.xml --auto-create --build "$CI_COMMIT_SHORT_SHA" --environment Staging
```

#### Upload test results (manual plan)

```yaml
test-and-report:
  stage: test
  image: node:22
  variables:
    TESTCOLLAB_TOKEN: $TESTCOLLAB_TOKEN
  before_script:
    - npm install -g @testcollab/cli && npm ci
  script:
    # --build ties the plan to the version this pipeline deployed (build ID or version
    # string; it must already exist as a build in TestCollab). Omit it, or use
    # --release <id> instead, if you don't track builds.
    - tc createTestPlan --project $TC_PROJECT_ID --ci-tag-id $TC_CI_TAG_ID --assignee-id $TC_ASSIGNEE_ID --build $APP_VERSION
    - export $(cat tmp/tc_test_plan)
    - npx cypress run --reporter mochawesome
    - tc report --project $TC_PROJECT_ID --test-plan-id $TESTCOLLAB_TEST_PLAN_ID --format mochawesome --result-file ./mochawesome-report/mochawesome.json
```

#### Sync feature files

```yaml
sync-features:
  stage: test
  image: node:22
  before_script:
    - npm install -g @testcollab/cli
  script:
    - tc sync --project $TC_PROJECT_ID
  variables:
    TESTCOLLAB_TOKEN: $TESTCOLLAB_TOKEN
  only:
    changes:
      - "**/*.feature"
```

### Azure DevOps

Use TestCollab as a **quality gate** in an Azure Pipelines YAML pipeline: report your automated results, then gate the build on the plan's outcome. Because `tc gate` returns a non-zero exit code when the gate fails, Azure DevOps fails the step automatically — no extra configuration needed.

```yaml
trigger:
  branches: { include: [main] }

pool:
  vmImage: ubuntu-latest

variables:
  - group: testcollab        # variable group holding TESTCOLLAB_TOKEN (mark it secret)
  - name: TC_PROJECT
    value: '45'
  - name: TC_PLAN
    value: '123'

steps:
  - task: NodeTool@0
    inputs: { versionSpec: '22.x' }

  - script: npm install -g @testcollab/cli && npm ci
    displayName: Install CLI & deps

  # run your tests → JUnit results
  - script: npx playwright test --reporter=junit
    displayName: Run tests

  # push results into the TestCollab plan
  - script: >
      tc report --project $(TC_PROJECT) --test-plan-id $(TC_PLAN)
      --format junit --result-file results.xml
    displayName: Report results to TestCollab
    env: { TESTCOLLAB_TOKEN: $(TESTCOLLAB_TOKEN) }

  # the quality gate — fails the pipeline if the plan has any failing case
  - script: >
      tc gate --project $(TC_PROJECT) --test-plan-id $(TC_PLAN)
      --fail-on failed --require-complete
    displayName: TestCollab quality gate
    env: { TESTCOLLAB_TOKEN: $(TESTCOLLAB_TOKEN) }
```

Store `TESTCOLLAB_TOKEN` as a **secret** variable (a variable group or Azure Key Vault). For a deployment gate ("hold the release until manual QA is green"), add `--wait <seconds>` so the gate polls until the plan's run is complete before evaluating.

See the [Azure DevOps quality gate guide](docs/azure-devops-quality-gate.md) for the full walkthrough, granular gate criteria, and an **Ansible Tower** example.

---

## Troubleshooting

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `TESTCOLLAB_TOKEN environment variable is not set` | Missing token | Set the env var (see [Authentication](#authentication)) |
| `Not in a Git repository` | CLI run outside a Git repo | Run from inside a Git repository |
| `Failed to fetch sync state: 404` | Wrong project ID | Check the project ID in TestCollab |
| `409 Conflict` | Repo state changed since last sync | `git pull` and retry |
| `Could not process features/x.feature` | Gherkin syntax error | Fix the `.feature` file syntax |

### Tips

- **Commit before syncing** — Only committed `.feature` files are synced
- **Sync often** — Smaller changesets are easier to review
- **Use CI** — Automate sync on push so your test cases are always current
- **Test first** — Try sync on a dev project before pointing at production
- **Large repos** — The CLI only processes changed files, so performance scales with changes, not repo size. Keep individual syncs under 6MB.

---

## Requirements

- Node.js 18.0.0 or higher
- Git 2.0 or higher

## Installation options

```bash
# Global (recommended)
npm install -g @testcollab/cli
tc sync --project 123

# Local (per-project)
npm install @testcollab/cli --save-dev
npx tc sync --project 123
```

## Links

- [TestCollab](https://testcollab.com)
- [Documentation](https://help.testcollab.com)
- [Sample BDD project](https://github.com/TCSoftInc/testcollab-bdd-demo)
- [Report a bug](https://github.com/TCSoftInc/testcollab-cli/issues)
- [Support](mailto:support@testcollab.com)

## License

MIT
