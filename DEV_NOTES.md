# TestCollab CLI - Development Notes

## Overview

The TestCollab CLI (`testcollab-cli`) is normally published as an npm package and installed globally or locally in projects. However, when working on local changes to the CLI itself, you need to run the CLI from your local development directory instead of the published package.

## Local Development Setup

### Prerequisites

- Node.js 18.0.0 or higher
- Git repository for testing CLI functionality
- TestCollab API token for integration testing

### Initial Setup

1. **Clone and install dependencies:**
   ```bash
   cd cli2
   npm install
   ```

2. **Make the CLI executable (Unix/Linux/macOS):**
   ```bash
   chmod +x src/index.js
   ```

## Running the CLI Locally

When developing locally, you have several options to run the CLI:

### Option 1: Direct Node Execution (Recommended)

```bash
# From the cli2 directory
node src/index.js sync --project 123

# Or using full path from anywhere
node /path/to/cli2/src/index.js sync --project 123
```

### Option 2: Global Linking (for system-wide access)

```bash
# Link the package globally (run from cli2 directory)
npm link

# Now you can use 'tc' command anywhere
tc sync --project 123

# To unlink later
npm unlink -g testcollab-cli
```

### Option 3: Local Package Linking

If you're testing the CLI in another project:

```bash
# In your test project directory
npm link /path/to/cli2

# Now you can use it in that project
npx tc sync --project 123
```

### Option 4: Direct Script Execution

```bash
# Make it executable and run directly (Unix/Linux/macOS)
./src/index.js sync --project 123
```

## Development Workflow

### Environment Setup

Set your TestCollab API token:

```bash
export TESTCOLLAB_TOKEN=your_api_token_here
```

For Windows:
```cmd
set TESTCOLLAB_TOKEN=your_api_token_here
```

### Testing Changes

1. **Make your code changes**

2. **Test with a local Git repository:**
   ```bash
   # Navigate to a test repository with .feature files
   cd /path/to/test-repo
   
   # Run the local CLI
   node /path/to/cli2/src/index.js sync --project 123
   ```

3. **Run unit tests:**
   ```bash
   cd cli2
   npm test
   ```

4. **Run specific test scenarios:**
   ```bash
   npm test tests/scenarios/initial-sync.test.js
   ```

### Common Development Commands

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run with coverage
npm test -- --coverage

# Debug Gherkin parsing
node debug-gherkin.js

# Test parsing with v33 syntax
node test-v33-parsing.js

# Debug messages
node debug-messages.js
```

## Debugging Tips

### Debug Mode

Add debug logging to your local development:

```javascript
// Add to src/commands/featuresync.js
console.log('Debug: Processing change', change);
```

### Testing with Different Repositories

Create test repositories with various scenarios:

```bash
# Create test repo
mkdir test-repo && cd test-repo
git init
git config user.email "test@example.com"
git config user.name "Test User"

# Add feature files
mkdir -p features/auth
echo 'Feature: Login' > features/auth/login.feature
git add . && git commit -m "Initial commit"

# Test CLI
node /path/to/cli2/src/index.js sync --project 123
```

### Mock API for Testing

For testing without hitting real API:

```javascript
// Create a test script
import { jest } from '@jest/globals';

// Mock fetch globally
global.fetch = jest.fn();
global.fetch.mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ lastSyncedCommit: null })
});

// Now run your CLI logic
```

## File Structure

```
cli2/
├── src/
│   ├── index.js           # Main CLI entry point
│   └── commands/
│       └── featuresync.js # Sync command implementation
├── tests/                 # Test files
├── debug-*.js            # Debug utilities
├── package.json          # Package configuration
└── DEV_NOTES.md          # This file
```

## Important Notes

### ES Modules

This package uses ES modules (`"type": "module"`), so:

- Use `import` instead of `require`
- File extensions are required in imports
- `__dirname` is not available (use `import.meta.url`)

### Binary Configuration

The CLI is configured with:

```json
{
  "bin": {
    "tc": "./src/index.js"
  }
}
```

This means when published, users can run `tc` command, but during development you need to run the script directly.

### Git Integration

The CLI heavily relies on Git operations, so always test in actual Git repositories with:

- Committed .feature files
- Various Git statuses (added, modified, renamed, deleted)
- Different branch scenarios

## Troubleshooting

### Permission Denied (Unix/Linux/macOS)

```bash
chmod +x src/index.js
```

### Module Not Found Errors

Ensure you're using Node.js 18+ and have run `npm install`.

### API Connection Issues

Verify your token and API URL:

```bash
export TESTCOLLAB_TOKEN=your_token
node src/index.js sync --project 123 --api-url https://your-api.com
```

### Git Repository Issues

CLI must run within a Git repository:

```bash
git init  # If not already a Git repo
git add .
git commit -m "Initial commit"
```

## Publishing vs Development

- **Published package**: Users install with `npm install -g testcollab-cli` and run `tc`
- **Local development**: Run with `node src/index.js` or `npm link` for global access

When your changes are ready, they'll be published to npm and users will get the updated version through normal npm update processes.

## Related Files

- `README.md` - User documentation
- `tests/README.md` - Testing strategy
- `gherkin-docs/bdd-integration/` - Integration scenarios
- `api/BDD_DEV_NOTES.md` - Server-side development notes

## Publishing instructions

    # 1) Dry run packaging
    npm pack

    # 2) Version bump (pick one)
    npm version patch -m "release %s"   # or minor/major

    # 3) Publish (unscoped)
    npm publish

    # 4) Push git tags
    git push --follow-tags