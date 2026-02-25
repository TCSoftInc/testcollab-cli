# TestCollab CLI

## Feature Sync utility for Behavior driven development (BDD)

A command-line interface for TestCollab operations, providing Git-based synchronization of Gherkin feature files with TestCollab projects.

## Overview

This CLI tool implements a sophisticated Git-based workflow to synchronize Gherkin feature files between your local repository and TestCollab. All the feature files along with the hierarchical path they are in, are synced with TestCollab's test suite and test cases tree.

## Installation

### Global Installation (Recommended)

```bash
npm install -g testcollab-cli
```

After global installation, you can use the `tc` command from anywhere:

```bash
export TESTCOLLAB_TOKEN=abcdef...
tc sync --project 123
```

### Local Installation

```bash
npm install testcollab-cli --save-dev
```

With local installation, use npx to run commands:

```bash
export TESTCOLLAB_TOKEN=abcdef...
npx tc sync --project 123
```

## Prerequisites

1. **Git Repository**: The CLI must be run from within a Git repository containing `.feature` files. Other version control systems are not supported.
2. **Committed Changes**: The files you want to sync must be committed to Git. If you try to run sync on uncommitted changes, it will display a silent warning.
3. **API Token**: A valid TestCollab API token with project access

## Sample project

You can use this repo as a sample project: https://github.com/TCSoftInc/testcollab-bdd-demo
Fork it, and run `tc sync` to try how the sync works before integrating live project.

## Authentication

Set your TestCollab API token as an environment variable:

### Unix/Linux/macOS:
```bash
export TESTCOLLAB_TOKEN=your_api_token_here
```

### Windows Command Prompt:
```cmd
set TESTCOLLAB_TOKEN=your_api_token_here
```

### Windows PowerShell:
```powershell
$env:TESTCOLLAB_TOKEN = "your_api_token_here"
```

You can obtain an API token from your TestCollab account settings.

## Commands

### `tc sync`

Synchronizes Gherkin feature files from your Git repository with TestCollab using intelligent diff analysis.

#### Syntax

```bash
tc sync --project <project_id> [options]
```

#### Required Options

- `--project <id>`: TestCollab project ID (required)

#### Optional Options

- `--api-url <url>`: TestCollab API base URL (default: `https://api.testcollab.io`)

#### Examples

##### Basic Sync

```bash
tc sync --project 123
```

##### Custom API URL

```bash
tc sync --project 123 --api-url https://your-testcollab.com/api
```

#### Run from source (without installing globally)

From the project root:

```bash
export TESTCOLLAB_TOKEN=abcdef...
node ./src/index.js sync --project 123
```

### Initial Sync

```bash
$ tc sync --project 123

🔍 Fetching sync state from TestCollab...
📊 Last synced commit: none (initial sync)
📊 Current HEAD commit: a1b2c3d4
🔍 Analyzing changes...
📄 Found 5 change(s)
🔧 Processing changes and calculating hashes...
🔍 Resolving existing item IDs...
📦 Building sync payload...
🚀 Syncing with TestCollab...

📊 Synchronization Results:
✨ Created 3 suite(s)
✨ Created 8 test case(s)

✅ Synchronization completed successfully
```

### Subsequent Sync with Changes

```bash
$ tc sync --project 123

🔍 Fetching sync state from TestCollab...
📊 Last synced commit: a1b2c3d4
📊 Current HEAD commit: e5f6g7h8
🔍 Analyzing changes...
📄 Found 3 change(s)
🔧 Processing changes and calculating hashes...
🔍 Resolving existing item IDs...
📦 Building sync payload...
🚀 Syncing with TestCollab...

📊 Synchronization Results:
✨ Created 1 test case(s)
🔄 Updated 2 test case(s)
🔄 Renamed 1 suite(s)

✅ Synchronization completed successfully
```

### No Changes

```bash
$ tc sync --project 123

🔍 Fetching sync state from TestCollab...
📊 Last synced commit: e5f6g7h8
📊 Current HEAD commit: e5f6g7h8
✅ Already up to date - no sync needed
```

## Error Handling

### Common Errors

#### Missing API Token
```bash
❌ Error: TESTCOLLAB_TOKEN environment variable is not set
   Please set your TestCollab API token as an environment variable.
   Example: export TESTCOLLAB_TOKEN=your_api_token_here
```

#### Not in Git Repository
```bash
❌ Error: Not in a Git repository
   Please run this command from within a Git repository.
```

#### API Connection Issues
```bash
❌ Error: Failed to connect to TestCollab API: Connection refused
```

#### Invalid Project ID
```bash
❌ Error: Failed to fetch sync state: 404 Not Found
```

## Best Practices

1. **Commit Before Syncing**: Always commit your `.feature` files before running sync
2. **Regular Syncing**: Sync frequently to avoid large change sets, we recommend integrating with CI so all feature files are automatically synced.
3. **Meaningful Commit Messages**: Use clear commit messages as they help track sync history
4. **Test in Development**: Test the sync in a development project before using in production
5. **Branch Strategy**: Consider your Git branching strategy - sync from the branch that represents your test suite

## CI/CD Integration

### GitHub Actions

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
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0  # Important: fetch full history
      
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - run: npm install -g testcollab-cli
      
      - run: tc sync --project ${{ secrets.TESTCOLLAB_PROJECT_ID }}
        env:
          TESTCOLLAB_TOKEN: ${{ secrets.TESTCOLLAB_TOKEN }}
```

### GitLab CI

```yaml
sync-features:
  stage: test
  image: node:18
  before_script:
    - npm install -g testcollab-cli
  script:
    - tc sync --project $TESTCOLLAB_PROJECT_ID
  variables:
    TESTCOLLAB_TOKEN: $TESTCOLLAB_TOKEN
  only:
    changes:
      - "**/*.feature"
```

## Troubleshooting

### Sync Conflicts

If you see a `409` error, it means another sync has occurred since your last sync:

```bash
❌ Error: Sync failed: 409 Conflict - Repository state has changed
```

**Solution**: Pull the latest changes and try again:
```bash
git pull origin main
tc sync --project 123
```

### Parser Errors

If Gherkin files have syntax errors:

```bash
⚠️  Warning: Could not process features/login.feature: Unexpected token
```

**Solution**: Fix the Gherkin syntax errors and commit the changes.

---

### `tc createTestPlan`

Creates a new Test Plan in the given project, adds all test cases that have the specified CI tag, and assigns it to a user.

#### Syntax

```bash
tc createTestPlan \
  --api-key <key> \
  --project <project_id> \
  --ci-tag-id <tag_id> \
  --assignee-id <user_id> \
  --company-id <company_id> \
  [--api-url <url>]
```

#### Required Options

- `--api-key <key>`: TestCollab API key
- `--project <id>`: Project ID
- `--ci-tag-id <id>`: Tag ID used to select cases to include
- `--assignee-id <id>`: User ID to assign the plan's execution
- `--company-id <id>`: Company ID

#### Optional Options

- `--api-url <url>`: TestCollab API base URL (default: `https://api.testcollab.io`)

#### Examples

```bash
tc createTestPlan --api-key $TESTCOLLAB_TOKEN --project 123 --ci-tag-id 456 --assignee-id 789 --company-id 100
```

This command writes the created plan id to `tmp/tc_test_plan` as `TESTCOLLAB_TEST_PLAN_ID=<id>`.

#### Run from source

```bash
node ./src/index.js createTestPlan --api-key $TESTCOLLAB_TOKEN --project 123 --ci-tag-id 456 --assignee-id 789 --company-id 100
```

---

### `tc report`

Reads a test result file and uploads test run results for the given Test Plan.
- `--mocha-json-result`: parses Mochawesome JSON and updates assigned executed test cases directly
- `--junit-xml-result`: parses JUnit XML and updates assigned executed test cases directly

The CLI validates token/company/project/test plan context first, then updates executed test cases directly (same flow as the TestCollab cypress reporter).

#### Syntax

```bash
tc report \
  --api-key <key> \
  --project <project_id> \
  --company-id <company_id> \
  --test-plan-id <test_plan_id> \
  [--mocha-json-result <path>] \
  [--junit-xml-result <path>] \
  [--api-url <url>]
```

#### Required Options

- `--api-key <key>`: TestCollab API key
- `--project <id>`: Project ID
- `--company-id <id>`: Company ID
- `--test-plan-id <id>`: Test Plan ID to attach results

#### Optional Options

- `--mocha-json-result <path>`: Path to Mochawesome JSON (default: `./mochawesome-report/mochawesome.json`)
- `--junit-xml-result <path>`: Path to JUnit XML file (if provided, this takes precedence over `--mocha-json-result`)
- `--api-url <url>`: Override TestCollab API base URL if needed

For JUnit input, each `<testcase name="...">` must include a TestCollab case ID so results can be mapped. Supported patterns:
- `[TC-123] ...`
- `... TC-123 ...`
- `... id-123 ...`
- `... testcase-123 ...`

For Mochawesome input, each test should also include a TestCollab case ID in `title` or `fullTitle` using one of the same patterns.

For configuration-specific plan runs:
- Mochawesome: top-level suite titles should be `config-id-<id>`
- JUnit: include `config-id-<id>` (or `config-<id>`) in testcase `name` or `classname`

#### Examples

```bash
tc report --api-key $TESTCOLLAB_TOKEN --project 123 --company-id 100 --test-plan-id 555 --mocha-json-result ./mochawesome-report/mochawesome.json
```

```bash
tc report --api-key $TESTCOLLAB_TOKEN --project 123 --company-id 100 --test-plan-id 555 --junit-xml-result ./reports/junit.xml
```

Sample files are available in:
- `samples/reports/mochawesome.json`
- `samples/reports/junit.xml`
- `samples/reports/junit-tagged.xml`
- `samples/reports/junit-multi-suite.xml`
- `samples/reports/junit-entities.xml`
- `samples/reports/junit-short-tags.xml`

#### Run from source

```bash
node ./src/index.js report --api-key $TESTCOLLAB_TOKEN --project 123 --company-id 100 --test-plan-id 555 --mocha-json-result ./mochawesome-report/mochawesome.json
```

```bash
node ./src/index.js report --api-key $TESTCOLLAB_TOKEN --project 123 --company-id 100 --test-plan-id 555 --junit-xml-result ./reports/junit.xml
```


### Large Repositories

For very large repositories:
- The CLI only processes changed files, so performance scales with the number of changes, not repository size
- Consider breaking large feature sets into smaller, logical groups
- Monitor payload size - keep individual syncs under 6MB

## Development

### Requirements

- Node.js 18.0.0 or higher
- Git 2.0 or higher
- Access to a TestCollab instance

### Local Development

```bash
git clone <repository>
cd testcollab-cli
npm install
npm link  # Makes 'tc' command available globally
```

## Support

For issues and questions:

- GitHub Issues: [Report a bug or request a feature](https://github.com/TCSoftInc/testcollab-cli/issues)
- Documentation: [TestCollab Documentation](https://help.testcollab.com)
- Support: support@testcollab.com
- Test Collab: [TestCollab website](https://testcollab.com)

## License

MIT License - see the LICENSE file for details.
