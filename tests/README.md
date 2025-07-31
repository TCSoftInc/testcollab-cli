# TestCollab CLI Testing Strategy

This document outlines the comprehensive testing strategy for the TestCollab CLI tool, focusing on verifying that the correct `GherkinSyncDelta` payload is generated for various Git-based synchronization scenarios.

## Overview

The TestCollab CLI implements a sophisticated Git-based workflow to synchronize Gherkin feature files between local repositories and TestCollab projects. Our testing strategy ensures that the CLI generates the correct API payloads for all supported scenarios while maintaining high reliability and fast execution.

## Testing Philosophy

### Hybrid Approach: Real Git + Mocked Network

We use a **hybrid testing approach** that combines the best of both worlds:

1. **Real Git Repositories** - For accuracy and authenticity
2. **Mocked Network Requests** - For speed, reliability, and control

### Why This Approach?

#### Real Git Repositories
- **Authenticity**: The CLI's core logic revolves around `git diff` and `git show` commands
- **Accuracy**: Only real Git operations can guarantee we're testing the exact same behavior users will experience
- **Edge Cases**: Git's rename detection, merge scenarios, and file status changes are complex and best tested against the real thing
- **Future-Proof**: Changes to Git behavior will be automatically reflected in our tests

#### Mocked Network Requests
- **Speed**: Tests run in milliseconds instead of seconds
- **Reliability**: No network failures or timeouts
- **Control**: We can simulate any API response scenario
- **Isolation**: Tests don't depend on external services
- **Deterministic**: Same inputs always produce same outputs

## Test Framework Setup

### Jest Configuration
- **Test Runner**: Jest 29.7.0
- **Environment**: Node.js
- **ES Modules**: Configured with `NODE_OPTIONS="--experimental-vm-modules"`
- **Test Pattern**: `tests/**/*.test.js`

### Dependencies
- `jest`: Test framework
- `simple-git`: Git operations (same as CLI)
- `@cucumber/gherkin`: Gherkin parsing (same as CLI)

## Testing Workflow

### Test Structure

Each test follows this pattern:

```javascript
describe('Scenario: File Renamed (Content Unchanged)', () => {
  let tempDir;
  let git;
  
  beforeEach(async () => {
    // 1. Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-cli-test-'));
    
    // 2. Initialize Git repository
    git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test User');
  });
  
  afterEach(async () => {
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  
  test('should generate correct payload for file rename without content change', async () => {
    // 3. Setup initial state (create and commit files)
    await setupInitialFiles(tempDir);
    const initialCommit = await git.revparse(['HEAD']);
    
    // 4. Mock API responses
    mockFetch
      .mockResolvedValueOnce(createApiResponse({ lastSyncedCommit: initialCommit }))
      .mockResolvedValueOnce(createApiResponse({ suites: {}, test_cases: {} }))
      .mockResolvedValueOnce(createApiResponse({ success: true }));
    
    // 5. Make changes (rename file)
    await fs.rename(
      path.join(tempDir, 'features/login.feature'),
      path.join(tempDir, 'features/authentication.feature')
    );
    await git.add('.');
    await git.commit('Rename login.feature to authentication.feature');
    
    // 6. Execute CLI command
    const result = await runCliSync(tempDir, { project: '123' });
    
    // 7. Verify API calls and payload
    expect(mockFetch).toHaveBeenCalledTimes(3);
    
    // Verify final payload structure
    const syncPayload = getLastApiCall(mockFetch, 'POST', '/bdd/sync');
    expect(syncPayload).toMatchObject({
      lastSyncedCommit: initialCommit,
      currentCommit: expect.any(String),
      changes: [
        {
          change_type: 'renamed',
          status: 'R100',
          old_path: 'features/login.feature',
          new_path: 'features/authentication.feature',
          // ... more specific assertions
        }
      ]
    });
  });
});
```

## Test Scenarios

Our tests cover all scenarios documented in `../gherkin-docs/bdd-integration/`:

### 1. Initial Sync (`scenario_1_initial_sync.md`)
- **Setup**: Empty TestCollab project, repository with feature files
- **Expected**: All suites and test cases created
- **Payload**: All changes marked as `added` with `A` status

### 2. File Added (`scenario_2_file_added.md`)
- **Setup**: Previous sync exists, new .feature file added
- **Expected**: New suite and test cases created
- **Payload**: Single change with `A` status

### 3. File Deleted (`scenario_3_file_deleted.md`)
- **Setup**: Previous sync exists, .feature file removed
- **Expected**: Suite and test cases marked for deletion
- **Payload**: Single change with `D` status

### 4. File Renamed - Content Unchanged (`scenario_4_file_renamed_content_unchanged.md`)
- **Setup**: Previous sync exists, file renamed without content changes
- **Expected**: Suite renamed, test cases updated with new paths
- **Payload**: Single change with `R100` status

### 5. File Renamed - Content Changed (`scenario_5_r_97.md`)
- **Setup**: Previous sync exists, file renamed and content modified
- **Expected**: Complex resolution using old hashes to preserve IDs
- **Payload**: Single change with `R97` status, hash resolution

### 6. New Scenario Added (`scenario_6_new_scenario_added.md`)
- **Setup**: Previous sync exists, new scenario added to existing file
- **Expected**: New test case created, existing ones preserved
- **Payload**: File marked as `M` status with detailed scenario changes

### 7. File Modified (`scenario_7_file_modified.md`)
- **Setup**: Previous sync exists, existing file content changed
- **Expected**: Test cases updated based on content changes
- **Payload**: File marked as `M` status with hash-based change detection

## API Mocking Strategy

### Mocked Endpoints

We mock three critical API endpoints:

#### 1. `GET /bdd/sync/state` (Sync State)
```javascript
mockApiResponse('/bdd/sync/state', {
  lastSyncedCommit: 'abc123def456',
  projectId: '123'
});
```

#### 2. `POST /resolve-ids` (ID Resolution)
```javascript
mockApiResponse('/resolve-ids', {
  suites: {
    'hash1': { id: 'suite_001', name: 'Login Features' },
    'hash2': { id: 'suite_002', name: 'Account Management' }
  },
  test_cases: {
    'hash3': { id: 'tc_001', name: 'Successful login' },
    'hash4': { id: 'tc_002', name: 'Invalid credentials' }
  }
});
```

#### 3. `POST /bdd/sync` (Final Sync)
```javascript
// This is captured and verified, not mocked with specific responses
const finalPayload = captureApiCall('/bdd/sync');
expect(finalPayload).toMatchSnapshot();
```

### Mock Implementation

```javascript
// Global fetch mock setup
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Helper functions
function createApiResponse(data, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data)
  });
}

function getLastApiCall(mockFetch, method, pathPattern) {
  const calls = mockFetch.mock.calls;
  const call = calls.find(([url, options]) => 
    url.includes(pathPattern) && 
    (options?.method || 'GET') === method
  );
  return call ? JSON.parse(call[1].body) : null;
}
```

## Git Repository Testing Utilities

### Repository Setup

```javascript
async function createTestRepo(tempDir) {
  const git = simpleGit(tempDir);
  await git.init();
  await git.addConfig('user.email', 'test@testcollab.com');
  await git.addConfig('user.name', 'TestCollab CLI Test');
  return git;
}

async function createFeatureFile(dir, filename, content) {
  const featuresDir = path.join(dir, 'features');
  await fs.mkdir(featuresDir, { recursive: true });
  await fs.writeFile(path.join(featuresDir, filename), content);
}

async function commitChanges(git, message) {
  await git.add('.');
  return await git.commit(message);
}
```

### Scenario Builders

```javascript
async function setupInitialSyncScenario(tempDir) {
  await createFeatureFile(tempDir, 'login.feature', `
Feature: User Login
  Scenario: Successful login
    Given I am on the login page
    When I enter valid credentials
    Then I should be logged in
  `);
  
  await createFeatureFile(tempDir, 'account.feature', `
Feature: Account Management
  Scenario: View profile
    Given I am logged in
    When I navigate to my profile
    Then I should see my account details
  `);
}
```

## Assertion Strategies

### Payload Structure Validation

```javascript
expect(payload).toMatchObject({
  lastSyncedCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
  currentCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
  changes: expect.arrayContaining([
    expect.objectContaining({
      change_type: expect.oneOf(['added', 'modified', 'deleted', 'renamed']),
      status: expect.stringMatching(/^[AMDR](\d+)?$/),
      // ... more specific checks
    })
  ])
});
```

### Snapshot Testing

For complex payloads, we use Jest snapshots:

```javascript
expect(payload).toMatchSnapshot('initial-sync-payload');
```

### Hash Verification

```javascript
function verifyHashConsistency(payload) {
  payload.changes.forEach(change => {
    if (change.old_hashes) {
      expect(change.old_hashes.feature_hash).toMatch(/^[a-f0-9]{40}$/);
      expect(change.old_hashes.scenario_hashes).toBeArrayOfHashes();
    }
  });
}
```

## Running Tests

### All Tests
```bash
npm test
```

### Specific Test File
```bash
npm test tests/scenarios/initial-sync.test.js
```

### Watch Mode
```bash
npm test -- --watch
```

### Coverage Report
```bash
npm test -- --coverage
```

## Test File Organization

```
tests/
├── README.md                 # This file
├── hello.test.js             # Basic Jest verification
├── utils/                    # Test utilities
│   ├── git-helpers.js        # Git repository utilities
│   ├── api-mocks.js          # API mocking utilities
│   └── scenario-builders.js  # Test scenario setup
└── scenarios/                # Actual test scenarios
    ├── initial-sync.test.js
    ├── file-added.test.js
    ├── file-deleted.test.js
    ├── file-renamed-unchanged.test.js
    ├── file-renamed-changed.test.js
    ├── scenario-added.test.js
    └── file-modified.test.js
```

## Benefits of This Approach

1. **High Fidelity**: Tests use real Git operations for maximum accuracy
2. **Fast Execution**: Network mocking keeps tests under 100ms each
3. **Deterministic**: Same inputs always produce same outputs
4. **Comprehensive**: Covers all documented scenarios plus edge cases
5. **Maintainable**: Clear separation between Git logic and API logic
6. **Future-Proof**: Real Git testing adapts to Git version changes
7. **Debuggable**: Failed tests show exact payload differences

## Next Steps

1. Implement test utilities (`utils/` directory)
2. Create first test for initial sync scenario
3. Add remaining scenario tests one by one
4. Set up CI/CD integration
5. Add performance benchmarks
6. Consider property-based testing for edge cases

This testing strategy ensures the TestCollab CLI generates correct payloads for all Git-based synchronization scenarios while maintaining fast, reliable test execution.
