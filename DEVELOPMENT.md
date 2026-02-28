# Development Guide

Guide for contributing to the TestCollab CLI.

## Setup

```bash
git clone https://github.com/TCSoftInc/testcollab-cli.git
cd testcollab-cli
npm install
```

### Make the CLI available globally (for testing)

```bash
npm link          # creates global 'tc' symlink to your local code
npm unlink -g testcollab-cli  # undo when done
```

## Running locally

You don't need to install the package to test changes. Run directly with Node:

```bash
# From the tc-cli directory
node src/index.js sync --project 123
node src/index.js createTestPlan --api-key $TOKEN --project 123 ...
node src/index.js report --api-key $TOKEN --project 123 ...
node src/index.js specgen --src ../my-app/src --out ../my-app/features
```

Or use `npm link` (see above) and run `tc` from anywhere.

## Environment variables

```bash
# Required for sync
export TESTCOLLAB_TOKEN=your_api_token

# Required for specgen (pick one)
export ANTHROPIC_API_KEY=sk-ant-...
export GOOGLE_GENAI_API_KEY=...

# Optional: point at a different API
export API_URL=http://localhost:1337  # or use --api-url flag
```

## Project structure

```
tc-cli/
├── src/
│   ├── index.js                  # CLI entry point (Commander.js)
│   ├── commands/
│   │   ├── featuresync.js        # tc sync
│   │   ├── createTestPlan.js     # tc createTestPlan
│   │   ├── report.js             # tc report
│   │   └── specgen.js            # tc specgen
│   └── ai/
│       └── discovery.js          # AI-powered source code analysis for specgen
├── tests/
│   ├── README.md                 # Testing strategy docs
│   ├── utils/                    # Test helpers (git, API mocks, builders)
│   └── scenarios/                # Test scenarios per feature
├── samples/
│   └── reports/                  # Sample Mochawesome & JUnit files
├── docs/
│   └── specgen.md                # Specgen design notes
├── .github/workflows/
│   └── release.yml               # CI/CD pipeline
└── package.json
```

## Key technical decisions

### ES Modules

The package uses `"type": "module"`. This means:

- Use `import` / `export`, not `require()`
- File extensions are required in imports (e.g., `./commands/featuresync.js`)
- `__dirname` is not available — use `import.meta.url` instead

### Dependencies

| Package | Purpose |
|---------|---------|
| `commander` | CLI argument parsing |
| `simple-git` | Git operations (diff, log, status) |
| `@cucumber/gherkin` | Gherkin `.feature` file parsing |
| `@anthropic-ai/sdk` | Claude AI for specgen |
| `@google/generative-ai` | Gemini AI for specgen |
| `testcollab-sdk` | TestCollab API client (createTestPlan, report) |
| `testcollab-cypress-plugin` | Shared result upload logic (report) |

## Testing

```bash
# Run all tests
npm test

# Run a specific test file
npm test tests/scenarios/initial-sync.test.js

# Watch mode
npm test -- --watch

# Coverage report
npm test -- --coverage
```

Tests use **real Git repositories** (created in temp dirs) with **mocked network calls**. See `tests/README.md` for the full testing strategy.

### Creating test scenarios

Use the test utilities in `tests/utils/`:

- `git-helpers.js` — Create temp Git repos, add/modify/delete files, commit
- `api-mocks.js` — Mock TestCollab API responses
- `scenario-builders.js` — Build complex test scenarios

## How each command works

### `tc sync` (featuresync.js)

1. Validates Git repo and `TESTCOLLAB_TOKEN`
2. Calls `GET /bdd/sync?project=<id>` to get the last synced commit
3. Runs `git diff --find-renames` between last sync and HEAD
4. Parses changed `.feature` files with `@cucumber/gherkin`
5. Computes SHA-1 hashes for features and scenarios
6. Calls `POST /bdd/resolve-ids` to map old hashes to existing TestCollab IDs
7. Builds a `GherkinSyncDelta` payload and POSTs to `POST /bdd/sync`

Key details:
- Rename detection: `R100` = pure rename, `R097` = rename + content change
- Hash-based matching with title fallback for ID resolution
- Handles deleted scenarios within modified files

### `tc createTestPlan` (createTestPlan.js)

1. Validates project, tag, and assignee exist
2. Creates a test plan named `CI Test: DD-MM-YYYY HH:MM`
3. Bulk-adds test cases matching the CI tag
4. Assigns the plan to the specified user
5. Writes plan ID to `tmp/tc_test_plan`

### `tc report` (report.js)

1. Validates API key, project, and test plan
2. Parses the result file based on `--format`:
   - **Mochawesome**: Walks nested suites, extracts test titles and results
   - **JUnit**: Parses XML `<testcase>` elements
3. Extracts TestCollab case IDs from test names (patterns: `[TC-123]`, `TC-123`, `id-123`, `testcase-123`)
4. Optionally extracts configuration IDs (`config-id-<id>`, `config-<id>`)
5. Maps results: pass → 1, fail → 2, skip → 3
6. Uploads results to the test plan via TestCollab API

### `tc specgen` (specgen.js + ai/discovery.js)

1. Scans source directory for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` files
2. Sends file summaries to AI for **discovery** — identifies target families and targets
3. Caches discovery results in `.testcollab/specgen.json`
4. For each target, generates a `.feature` file with 2-4 scenarios using structured AI output
5. Falls back to a template feature if AI generation fails

## Debugging

### Add debug logging

```javascript
// Temporary — add anywhere in command files
console.log('Debug:', JSON.stringify(payload, null, 2));
```

### Test with a scratch repo

```bash
mkdir /tmp/test-repo && cd /tmp/test-repo
git init && git config user.email "test@test.com" && git config user.name "Test"

mkdir -p features/auth
cat > features/auth/login.feature << 'EOF'
Feature: Login
  Scenario: Valid credentials
    Given the user is on the login page
    When they enter valid credentials
    Then they should see the dashboard
EOF

git add . && git commit -m "Initial"
node /path/to/tc-cli/src/index.js sync --project 123
```

### Mock the API

```javascript
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ lastSyncedCommit: null }),
});
```

## Publishing

```bash
# 1. Dry-run to check what gets published
npm pack

# 2. Bump version
npm version patch -m "release %s"   # or minor / major

# 3. Publish
npm publish

# 4. Push tags
git push --follow-tags
```

The GitHub Actions workflow (`.github/workflows/release.yml`) also handles automated publishing on release creation.

### What gets published

Controlled by `.npmignore`:
- **Included:** `src/`, `samples/`, `package.json`, `README.md`, `LICENSE`
- **Excluded:** `tests/`, `DEV_NOTES.md`, `debug-*.js`, `.env`
