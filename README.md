# TestCollab CLI

Command-line tools for syncing Gherkin feature files, running test plans, and uploading results to [TestCollab](https://testcollab.com).

```
npm install -g testcollab-cli
```

## Quick Start

Upload test results to TestCollab from your CI pipeline in two steps:

```bash
export TESTCOLLAB_TOKEN=your_token_here

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
| [`tc createTestPlan`](#tc-createtestplan) | Create a test plan and assign tagged cases |
| [`tc report`](#tc-report) | Upload Mochawesome or JUnit results |
| [`tc sync`](#tc-sync) | Sync `.feature` files from Git to TestCollab (designed for CI/CD, works locally too) |

The most common workflow is **createTestPlan → run your tests → report** to automatically upload test results from CI/CD.

---

### `tc createTestPlan`

Creates a test plan, adds all test cases matching a CI tag, and assigns it to a user. Designed for CI pipelines where you want to automatically create a plan before running tests.

```bash
tc createTestPlan \
  --project <id> \
  --ci-tag-id <id> \
  --assignee-id <id> \
  [--api-key <key>] \
  [--api-url <url>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--project <id>` | Yes | Project ID |
| `--ci-tag-id <id>` | Yes | Tag ID — test cases with this tag are added to the plan |
| `--assignee-id <id>` | Yes | User ID to assign the plan execution to |
| `--api-key <key>` | No | TestCollab API key (or set `TESTCOLLAB_TOKEN` env var) |
| `--api-url <url>` | No | API base URL (default: `https://api.testcollab.io`). Use `https://api-eu.testcollab.io` for EU region. |

**Output:** Writes the created plan ID to `tmp/tc_test_plan` as `TESTCOLLAB_TEST_PLAN_ID=<id>`. You can source this file in subsequent CI steps.

---

### `tc report`

Parses a test result file (Mochawesome JSON or JUnit XML) and uploads results to a TestCollab test plan.

```bash
tc report \
  --project <id> \
  --test-plan-id <id> \
  --format <mochawesome|junit> \
  --result-file <path> \
  [--api-key <key>] \
  [--api-url <url>]
```

| Option | Required | Description |
|--------|----------|-------------|
| `--project <id>` | Yes | Project ID |
| `--test-plan-id <id>` | Yes | Test plan to attach results to |
| `--format <type>` | Yes | `mochawesome` or `junit` |
| `--result-file <path>` | Yes | Path to the result file |
| `--api-key <key>` | No | TestCollab API key (or set `TESTCOLLAB_TOKEN` env var) |
| `--api-url <url>` | No | API base URL override (default: `https://api.testcollab.io`). Use `https://api-eu.testcollab.io` for EU region. |

#### Mapping test cases

Your test names must include a TestCollab case ID so results can be matched. Any of these patterns work:

```
[TC-123] Login should succeed          ← bracketed
TC-123 Login should succeed            ← prefix
Login should succeed id-123            ← id- prefix
Login should succeed testcase-123      ← testcase- prefix
```

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

The most common use case is uploading test results from CI: create a test plan, run your tests, then report results back to TestCollab.

### GitHub Actions

#### Upload test results (create plan + run tests + report)

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

      - run: npm install -g testcollab-cli && npm ci

      # Step 1: Create test plan with CI-tagged cases
      - run: |
          tc createTestPlan \
            --project ${{ secrets.TC_PROJECT_ID }} \
            --ci-tag-id ${{ secrets.TC_CI_TAG_ID }} \
            --assignee-id ${{ secrets.TC_ASSIGNEE_ID }}

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

      - run: npm install -g testcollab-cli

      - run: tc sync --project ${{ secrets.TC_PROJECT_ID }}
        env:
          TESTCOLLAB_TOKEN: ${{ secrets.TESTCOLLAB_TOKEN }}
```

> **Important:** `tc sync` requires `fetch-depth: 0` so it can compute accurate diffs against the last synced commit.

### GitLab CI

#### Upload test results

```yaml
test-and-report:
  stage: test
  image: node:22
  variables:
    TESTCOLLAB_TOKEN: $TESTCOLLAB_TOKEN
  before_script:
    - npm install -g testcollab-cli && npm ci
  script:
    - tc createTestPlan --project $TC_PROJECT_ID --ci-tag-id $TC_CI_TAG_ID --assignee-id $TC_ASSIGNEE_ID
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
    - npm install -g testcollab-cli
  script:
    - tc sync --project $TC_PROJECT_ID
  variables:
    TESTCOLLAB_TOKEN: $TESTCOLLAB_TOKEN
  only:
    changes:
      - "**/*.feature"
```

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
npm install -g testcollab-cli
tc sync --project 123

# Local (per-project)
npm install testcollab-cli --save-dev
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
