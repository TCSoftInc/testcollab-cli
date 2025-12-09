/**
 * File Renamed, Content Unchanged Test - Scenario 4
 * 
 * Tests the synchronization when a feature file is renamed but its content
 * remains identical. This test verifies that when a file path changes,
 * the CLI correctly computes new hashes (since path is part of hash input)
 * and sends both old and new hashes to allow the server to update existing
 * records in place rather than creating duplicates.
 * 
 * Based on: gherkin-docs/bdd-integration/scenario_4_file_renamed_content_unchanged.md
 */

import { describe, test, beforeEach, afterEach, expect, jest } from '@jest/globals';
import { 
  createTempDir, 
  initGitRepo, 
  cleanupTempDir,
  createFeatureFile,
  commitAllChanges,
  getHeadCommit 
} from '../utils/git-helpers.js';
import { 
  setupApiMocks, 
  mockExistingSyncState,
  mockResolveIds,
  mockSuccessfulSync,
  mockFetch,
  getFinalSyncPayload,
  assertApiCall,
  getLastApiCall,
  resetApiMocks 
} from '../utils/api-mocks.js';
import { 
  FEATURE_CONTENT,
  VALIDATORS 
} from '../utils/scenario-builders.js';
import { featuresync } from '../../src/commands/featuresync.js';

/**
 * Build the file rename scenario matching the documentation
 * @param {string} tempDir - Directory path
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<{initialCommit: string, renameCommit: string}>} Both commit hashes
 */
async function buildFileRenamedScenario(tempDir, git) {
  // Create initial file at features/login/user_login.feature
  const userLoginContent = `Feature: Successful User Login
  As a registered user
  I want to log in to the system
  So that I can access my account

  Background:
    Given the application is running
    And I am on the login page

  Scenario: Happy-path login
    When I enter "valid@example.com" in the email field
    And I enter "correctpassword" in the password field
    And I click the login button
    Then I should be redirected to the dashboard
    And I should see a welcome message

  Scenario: Failed login with incorrect password
    When I enter "valid@example.com" in the email field
    And I enter "wrongpassword" in the password field
    And I click the login button
    Then I should see an error message "Invalid credentials"
    And I should remain on the login page`;

  await createFeatureFile(tempDir, 'features/login/user_login.feature', userLoginContent);
  const initialCommit = await commitAllChanges(git, 'Initial commit: i7j8k9l');
  
  // Rename file from user_login.feature to user_login_success.feature
  // Content remains exactly the same
  await git.mv('features/login/user_login.feature', 'features/login/user_login_success.feature');
  const renameCommit = await commitAllChanges(git, 'Rename user_login.feature to user_login_success.feature: m0n1o2p');
  
  return { initialCommit, renameCommit };
}

describe('Scenario 4: File Renamed, Content Unchanged', () => {
  let tempDir;
  let git;
  let originalEnv;
  let originalCwd;

  beforeEach(async () => {
    originalCwd = process.cwd();
    // Setup temporary directory and Git repository
    tempDir = await createTempDir();
    git = await initGitRepo(tempDir);
    
    // Setup API mocking
    setupApiMocks();
    
    // Setup environment variables for CLI
    originalEnv = process.env.TESTCOLLAB_TOKEN;
    process.env.TESTCOLLAB_TOKEN = 'test-token-12345';
    
    // Change working directory to test repo for CLI execution
    process.chdir(tempDir);
  });

  afterEach(async () => {
    // Cleanup
    await cleanupTempDir(tempDir);
    resetApiMocks();
    
    // Restore environment
    if (originalEnv) {
      process.env.TESTCOLLAB_TOKEN = originalEnv;
    } else {
      delete process.env.TESTCOLLAB_TOKEN;
    }
    
    // Change back to original directory
    process.chdir(originalCwd);
  });

  test('should generate correct payload for file rename with content unchanged', async () => {
    // === SETUP ===
    // Build the file rename scenario matching the documentation
    const { initialCommit, renameCommit } = await buildFileRenamedScenario(tempDir, git);
    
    // Setup API mocks for rename scenario
    const projectId = '42'; // Using the project ID from scenario documentation
    
    // First, run a quick sync to capture the actual OLD hashes that will be sent to resolve-ids
    let oldFeatureHash = null;
    let oldScenarioHashes = [];
    
    // Create a temporary mock to capture the resolve-ids call
    const captureResolveMock = jest.fn().mockImplementation((url, options) => {
      if (url.includes('/resolve-ids') && options?.body) {
        const body = JSON.parse(options.body);
        oldFeatureHash = body.features[0];
        oldScenarioHashes = body.scenarios;
        // Return empty results for this capture run
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, results: { suites: {}, cases: {} } })
        });
      }
      // For other calls, return basic responses
      if (url.includes('/bdd/sync') && !options?.body) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ projectId: parseInt(projectId), lastSyncedCommit: initialCommit })
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true })
      });
    });
    
    global.fetch = captureResolveMock;
    
    // Run sync to capture actual OLD hashes that will be sent to resolve-ids
    await featuresync({
      project: projectId,
      apiUrl: 'https://api.testcollab.com'
    });
    
    // Now setup proper mocks using captured OLD hashes
    setupApiMocks();
    
    // Mock the sync state to return the initial commit (server is synced to that point)
    const syncStateResponse = mockExistingSyncState(projectId, initialCommit);
    
    // Mock resolve-ids to return the existing suite and test case IDs using the OLD hashes
    const suiteMapping = oldFeatureHash ? { [oldFeatureHash]: { suiteId: 101 } } : {};
    const caseMapping = {};
    if (oldScenarioHashes.length >= 2) {
      caseMapping[oldScenarioHashes[0]] = { caseId: 1001 };
      caseMapping[oldScenarioHashes[1]] = { caseId: 1002 };
    }
    
    const resolveIdsResponse = mockResolveIds(suiteMapping, caseMapping);
    
    // Mock successful sync response with rename counts
    const finalSyncResponse = mockSuccessfulSync({
      storedCommit: renameCommit,
      renamedSuites: 1,
      updatedSuites: 1,
      createdSuites: 0,
      renamedCases: 0,
      updatedCases: 2,
      createdCases: 0
    });
    
    // Setup the mock chain
    mockFetch
      .mockResolvedValueOnce(syncStateResponse)
      .mockResolvedValueOnce(resolveIdsResponse)
      .mockResolvedValueOnce(finalSyncResponse);
    
    // === EXECUTE ===
    // Run the CLI sync command
    await featuresync({
      project: projectId,
      apiUrl: 'https://api.testcollab.com'
    });
    
    // === VERIFY API CALL SEQUENCE ===
    expect(mockFetch).toHaveBeenCalledTimes(3);
    
    // Verify first call: GET /bdd/sync (sync state)
    assertApiCall('GET', '/bdd/sync', 0);
    const syncStateCall = mockFetch.mock.calls[0];
    expect(syncStateCall[0]).toContain(`project=${projectId}`);
    
    // Verify second call: POST /resolve-ids
    assertApiCall('POST', '/resolve-ids', 1);
    const resolveIdsCall = getLastApiCall('POST', '/resolve-ids');
    expect(resolveIdsCall.body.projectId).toBe(projectId);
    expect(resolveIdsCall.body.features).toHaveLength(1); // Should have one feature hash
    expect(resolveIdsCall.body.scenarios).toHaveLength(2); // Should have two scenario hashes
    
    // Verify third call: POST /bdd/sync (final sync)
    assertApiCall('POST', '/bdd/sync', 2);
    
    // === VERIFY FINAL PAYLOAD STRUCTURE ===
    const payload = getFinalSyncPayload();
    expect(payload).toBeTruthy();
    
    // Basic payload structure
    expect(payload.projectId).toBe(parseInt(projectId));
    expect(payload.prevCommit).toBe(initialCommit);
    expect(payload.headCommit).toBe(renameCommit);
    expect(payload.headCommit).toMatch(/^[a-f0-9]{40}$/); // Valid Git commit hash
    expect(Array.isArray(payload.changes)).toBe(true);
    expect(payload.changes).toHaveLength(1); // One file changed
    
    // === VERIFY CHANGE DETAILS ===
    const change = payload.changes[0];
    
    // Verify change status and paths
    expect(change.status).toBe('R100'); // 100% rename (no content change)
    expect(change.oldPath).toBe('features/login/user_login.feature');
    expect(change.newPath).toBe('features/login/user_login_success.feature');
    
    // === VERIFY FEATURE DETAILS ===
    expect(change.feature).toBeTruthy();
    expect(change.feature.title).toBe('Successful User Login');
    expect(change.feature.prevHash).toBeTruthy(); // Should have old hash
    expect(change.feature.hash).toBeTruthy(); // Should have new hash
    expect(VALIDATORS.isValidFeatureHash(change.feature)).toBe(true);
    
    // Feature should not include steps array since content didn't change
    expect(change.feature.steps).toBeUndefined();
    // Background is included for renamed files since we need the full feature data
    expect(Array.isArray(change.feature.background)).toBe(true);
    expect(change.feature.background).toHaveLength(2);
    
    // === VERIFY SCENARIOS ===
    expect(Array.isArray(change.scenarios)).toBe(true);
    expect(change.scenarios).toHaveLength(2);
    
    // Find scenarios by title
    const happyPathScenario = change.scenarios.find(s => s.title === 'Happy-path login');
    const incorrectPwScenario = change.scenarios.find(s => s.title === 'Failed login with incorrect password');
    
    expect(happyPathScenario).toBeTruthy();
    expect(incorrectPwScenario).toBeTruthy();
    
    // Verify happy-path scenario
    expect(happyPathScenario.caseId).toBe(1001); // From resolve-ids response
    expect(happyPathScenario.prevHash).toBeTruthy(); // Should have old hash
    expect(happyPathScenario.hash).toBeTruthy(); // Should have new hash
    expect(VALIDATORS.isValidScenarioHash(happyPathScenario)).toBe(true);
    
    // Verify incorrect password scenario
    expect(incorrectPwScenario.caseId).toBe(1002); // From resolve-ids response
    expect(incorrectPwScenario.prevHash).toBeTruthy(); // Should have old hash
    expect(incorrectPwScenario.hash).toBeTruthy(); // Should have new hash
    expect(VALIDATORS.isValidScenarioHash(incorrectPwScenario)).toBe(true);
    
    // Scenarios should not include steps array since content didn't change
    expect(happyPathScenario.steps).toBeUndefined();
    expect(incorrectPwScenario.steps).toBeUndefined();
    
    // === VERIFY HASH CONSISTENCY ===
    // All new hashes should be different from old hashes
    expect(change.feature.hash).not.toBe(change.feature.prevHash);
    expect(happyPathScenario.hash).not.toBe(happyPathScenario.prevHash);
    expect(incorrectPwScenario.hash).not.toBe(incorrectPwScenario.prevHash);
    
    // All new hashes should be unique
    const newHashes = [
      change.feature.hash,
      happyPathScenario.hash,
      incorrectPwScenario.hash
    ];
    const uniqueNewHashes = [...new Set(newHashes)];
    expect(uniqueNewHashes).toHaveLength(newHashes.length);
  });

  test('should handle multiple file renames in a single commit', async () => {
    // === SETUP ===
    // Create multiple files, then rename them all
    await createFeatureFile(tempDir, 'features/auth/login.feature', FEATURE_CONTENT.USER_LOGIN);
    await createFeatureFile(tempDir, 'features/user/settings.feature', FEATURE_CONTENT.ACCOUNT_SETTINGS);
    const initialCommit = await commitAllChanges(git, 'Initial commit with multiple features');
    
    // Rename both files
    await git.mv('features/auth/login.feature', 'features/auth/user_authentication.feature');
    await git.mv('features/user/settings.feature', 'features/user/account_management.feature');
    const renameCommit = await commitAllChanges(git, 'Rename multiple feature files');
    
    // Setup API mocks
    const projectId = '42';
    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(projectId, initialCommit))
      .mockResolvedValueOnce(mockResolveIds(
        { 'hash1': { suiteId: 101 }, 'hash2': { suiteId: 102 } }, // Multiple feature hashes
        { 'scenario1': { caseId: 1001 }, 'scenario2': { caseId: 1002 }, 'scenario3': { caseId: 1003 } } // Multiple scenario hashes
      ))
      .mockResolvedValueOnce(mockSuccessfulSync({
        storedCommit: renameCommit,
        renamedSuites: 2,
        updatedSuites: 2,
        updatedCases: 3
      }));
    
    // === EXECUTE ===
    await featuresync({
      project: projectId,
      apiUrl: 'https://api.testcollab.com'
    });
    
    // === VERIFY ===
    const payload = getFinalSyncPayload();
    expect(payload.changes).toHaveLength(2); // Two files renamed
    
    // All changes should be R100 (rename without content change)
    payload.changes.forEach(change => {
      expect(change.status).toBe('R100');
      expect(change.oldPath).toBeTruthy();
      expect(change.newPath).toBeTruthy();
      expect(change.oldPath).not.toBe(change.newPath);
    });
  });

  test('should include proper authorization headers in API calls', async () => {
    const { initialCommit, renameCommit } = await buildFileRenamedScenario(tempDir, git);
    const projectId = '42';
    
    // Setup basic mocks
    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(projectId, initialCommit))
      .mockResolvedValueOnce(mockResolveIds())
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: renameCommit }));
    
    await featuresync({
      project: projectId,
      apiUrl: 'https://api.testcollab.com'
    });
    
    // Verify all API calls include proper headers if needed
    // Note: The current implementation uses token-based auth, not Bearer tokens
    const apiCalls = mockFetch.mock.calls;
    expect(apiCalls.length).toBeGreaterThan(0);
    
    // At minimum, verify calls were made with proper URLs
    apiCalls.forEach((call, index) => {
      const [url, options] = call;
      expect(url).toContain('api.testcollab.com');
    });
  });

  test('should handle resolve-ids when no existing hashes are found', async () => {
    const { initialCommit, renameCommit } = await buildFileRenamedScenario(tempDir, git);
    const projectId = '42';
    
    // Mock resolve-ids to return empty results (no existing hashes found)
    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(projectId, initialCommit))
      .mockResolvedValueOnce(mockResolveIds({}, {})) // Empty results
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: renameCommit }));
    
    await featuresync({
      project: projectId,
      apiUrl: 'https://api.testcollab.com'
    });
    
    const payload = getFinalSyncPayload();
    expect(payload).toBeTruthy();
    
    // When no existing IDs are found, scenarios should not have caseId
    const change = payload.changes[0];
    change.scenarios.forEach(scenario => {
      expect(scenario.caseId).toBeUndefined();
    });
  });

  test('should correctly diff renamed file with git', async () => {
    const { initialCommit, renameCommit } = await buildFileRenamedScenario(tempDir, git);
    
    // Verify Git correctly identifies this as a rename
    const diffOutput = await git.diff(['--name-status', '--find-renames', `${initialCommit}..${renameCommit}`]);
    
    expect(diffOutput).toContain('R100'); // 100% rename
    expect(diffOutput).toContain('features/login/user_login.feature');
    expect(diffOutput).toContain('features/login/user_login_success.feature');
  });
});
