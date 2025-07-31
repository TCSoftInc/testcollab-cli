# TestCollab CLI

A command-line interface for TestCollab operations, providing Git-based synchronization of Gherkin feature files with TestCollab projects.

## Overview

This CLI tool implements a sophisticated Git-based workflow to synchronize Gherkin feature files between your local repository and TestCollab. It preserves historical test results even when files, folders, or titles are renamed or moved.

### Key Features

- **Git-based Change Detection**: Uses `git diff` to identify exactly what changed since the last sync
- **Smart Hash Calculation**: Calculates deterministic hashes for features and scenarios to track content changes
- **Preserves Test History**: Maintains execution history even when files are renamed or content is modified
- **Atomic Operations**: All changes are applied transactionally - if any part fails, nothing is changed
- **Efficient Syncing**: Only processes changed files, making it suitable for large repositories

## Installation

### Global Installation (Recommended)

```bash
npm install -g testcollab-cli
```

After global installation, you can use the `tc` command from anywhere:

```bash
tc featuresync --project 123
```

### Local Installation

```bash
npm install testcollab-cli --save-dev
```

With local installation, use npx to run commands:

```bash
npx tc featuresync --project 123
```

## Prerequisites

1. **Git Repository**: The CLI must be run from within a Git repository containing `.feature` files
2. **Committed Changes**: The files you want to sync must be committed to Git
3. **API Token**: A valid TestCollab API token with project access

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

### `tc featuresync`

Synchronizes Gherkin feature files from your Git repository with TestCollab using intelligent diff analysis.

#### Syntax

```bash
tc featuresync --project <project_id> [options]
```

#### Required Options

- `--project <id>`: TestCollab project ID (required)

#### Optional Options

- `--api-url <url>`: TestCollab API base URL (default: `https://api.testcollab.io`)

#### Examples

##### Basic Sync

```bash
tc featuresync --project 123
```

##### Custom API URL

```bash
tc featuresync --project 123 --api-url https://your-testcollab.com/api
```

## How It Works

### Workflow Overview

1. **Fetch Sync State**: Retrieves the last synced commit SHA from TestCollab
2. **Analyze Changes**: Uses `git diff --find-renames` to identify what changed since the last sync
3. **Calculate Hashes**: Computes deterministic hashes for old and new versions of features/scenarios
4. **Resolve IDs**: Maps old hashes to existing TestCollab suite/test case IDs
5. **Build Payload**: Constructs a detailed change set with minimal, precise operations
6. **Sync**: Sends the payload to TestCollab for atomic processing
7. **Update State**: Records the new commit SHA for the next sync

### Change Detection

The CLI uses Git's native diff capabilities to detect:

- **Added files** (`A`): New `.feature` files
- **Modified files** (`M`): Changes to existing `.feature` files  
- **Deleted files** (`D`): Removed `.feature` files
- **Renamed files** (`R100`): Pure renames with no content changes
- **Renamed + Modified** (`R97`, etc.): Files that were both renamed and had content changes

### Hash Calculation

- **Feature Hash**: Based on all step text (background + scenarios), ignoring titles and paths
- **Scenario Hash**: Based on the step text only, ignoring scenario titles
- **Deterministic**: Same content always produces the same hash, enabling reliable change detection

### Smart ID Resolution

When content changes, the CLI:
1. Calculates hashes for the old version (from the previous commit)
2. Sends these hashes to TestCollab's `/resolve-ids` endpoint
3. Gets back the corresponding suite/test case IDs
4. Uses these IDs to update existing items rather than creating duplicates

## Example Output

### Initial Sync

```bash
$ tc featuresync --project 123

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
$ tc featuresync --project 123

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
$ tc featuresync --project 123

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
2. **Regular Syncing**: Sync frequently to avoid large change sets
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
      
      - run: tc featuresync --project ${{ secrets.TESTCOLLAB_PROJECT_ID }}
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
    - tc featuresync --project $TESTCOLLAB_PROJECT_ID
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
tc featuresync --project 123
```

### Parser Errors

If Gherkin files have syntax errors:

```bash
⚠️  Warning: Could not process features/login.feature: Unexpected token
```

**Solution**: Fix the Gherkin syntax errors and commit the changes.

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

- GitHub Issues: [Report a bug or request a feature](https://github.com/testcollab/testcollab-cli/issues)
- Documentation: [TestCollab Documentation](https://docs.testcollab.io)
- Support: Contact TestCollab support team

## License

MIT License - see the LICENSE file for details.
