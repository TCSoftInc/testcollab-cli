/**
 * Initial Sync Test - Scenario 1
 * 
 * Tests the first-time synchronization of a TestCollab project with Gherkin
 * feature files. This test verifies that when a project has never been synced
 * before, all feature files are correctly processed and the appropriate
 * GherkinSyncDelta payload is generated.
 * 
 * Based on: gherkin-docs/bdd-integration/scenario_1_initial_sync.md
 */

import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import { 
  createTempDir, 
  initGitRepo, 
  cleanupTempDir,
  getHeadCommit 
} from '../utils/git-helpers.js';
import { 
  setupApiMocks, 
  setupInitialSyncMocks,
  mockFetch,
  getFinalSyncPayload,
  assertApiCall,
  resetApiMocks 
} from '../utils/api-mocks.js';
import { 
  buildInitialSyncScenario,
  EXPECTED_PAYLOADS,
  VALIDATORS 
} from '../utils/scenario-builders.js';
import { featuresync } from '../../src/commands/featuresync.js';

describe('Scenario 1: Initial Sync', () => {
  let tempDir;
  let git;
  let originalEnv;

  beforeEach(async () => {
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
    process.chdir('/Users/abhi/Documents/projects-2025/tc-gherkin');
  });

  test('should generate correct payload for initial sync with two feature files', async () => {
    // === SETUP ===
    // Build the initial sync scenario matching the documentation
    // This creates features/auth/user_login.feature and features/account/account_settings.feature
    const headCommit = await buildInitialSyncScenario(tempDir, git);
    
    // Setup API mocks for initial sync scenario
    const projectId = '42'; // Using the project ID from scenario documentation
    setupInitialSyncMocks(projectId, headCommit);
    
    // === EXECUTE ===
    // Run the CLI sync command
    await featuresync({
      project: projectId,
      apiUrl: 'https://api.testcollab.com'  // Mock URL
    });
    
    // === VERIFY API CALL SEQUENCE ===
    // For initial sync, resolve-ids is skipped when there are no old hashes
    expect(mockFetch).toHaveBeenCalledTimes(2);
    
    // Verify first call: GET /bdd/sync (sync state)
    assertApiCall('GET', '/bdd/sync', 0);
    const syncStateCall = mockFetch.mock.calls[0];
    expect(syncStateCall[0]).toContain(`project=${projectId}`);
    
    // Verify second call: POST /bdd/sync (final sync)
    // resolve-ids is skipped for initial sync with no old hashes
    assertApiCall('POST', '/bdd/sync', 1);
    
    // === VERIFY FINAL PAYLOAD STRUCTURE ===
    const payload = getFinalSyncPayload();
    expect(payload).toBeTruthy();
    
    // Basic payload structure
    expect(payload.projectId).toBe(parseInt(projectId));
    expect(payload.prevCommit).toBeNull(); // Initial sync has no previous commit
    expect(payload.headCommit).toBe(headCommit);
    expect(payload.headCommit).toMatch(/^[a-f0-9]{40}$/); // Valid Git commit hash
    expect(Array.isArray(payload.changes)).toBe(true);
    expect(payload.changes).toHaveLength(2); // Two feature files
    
    // === VERIFY CHANGES ARRAY ===
    const changes = payload.changes;
    
    // All changes should be marked as "added" for initial sync
    changes.forEach(change => {
      expect(change.status).toBe('A');
      expect(change.oldPath).toBeNull();
      expect(change.newPath).toBeTruthy();
      expect(change.newPath.endsWith('.feature')).toBe(true);
    });
    
    // Find auth and account changes
    const authChange = changes.find(c => c.newPath === 'features/auth/user_login.feature');
    const accountChange = changes.find(c => c.newPath === 'features/account/account_settings.feature');
    
    expect(authChange).toBeTruthy();
    expect(accountChange).toBeTruthy();
    
    // === VERIFY AUTH FEATURE ===
    expect(authChange.feature).toBeTruthy();
    expect(authChange.feature.title).toBe('User Login');
    expect(VALIDATORS.isValidFeatureHash(authChange.feature)).toBe(true);
    
    // Verify background steps
    expect(Array.isArray(authChange.feature.background)).toBe(true);
    expect(authChange.feature.background).toHaveLength(2);
    expect(authChange.feature.background[0].keyword).toBe('Given');
    expect(authChange.feature.background[0].text).toBe('the application is running');
    expect(authChange.feature.background[1].keyword).toBe('And');
    expect(authChange.feature.background[1].text).toBe('I am on the login page');
    
    // Verify scenarios
    expect(Array.isArray(authChange.scenarios)).toBe(true);
    expect(authChange.scenarios).toHaveLength(2);
    
    const successScenario = authChange.scenarios.find(s => s.title === 'Successful login with valid credentials');
    const failScenario = authChange.scenarios.find(s => s.title === 'Failed login with incorrect password');
    
    expect(successScenario).toBeTruthy();
    expect(failScenario).toBeTruthy();
    
    expect(VALIDATORS.isValidScenarioHash(successScenario)).toBe(true);
    expect(VALIDATORS.isValidScenarioHash(failScenario)).toBe(true);
    expect(VALIDATORS.areValidSteps(successScenario.steps)).toBe(true);
    expect(VALIDATORS.areValidSteps(failScenario.steps)).toBe(true);
    
    // Verify specific steps for successful login
    expect(successScenario.steps).toHaveLength(5);
    expect(successScenario.steps[0].keyword).toBe('When');
    expect(successScenario.steps[0].text).toBe('I enter "valid@example.com" in the email field');
    
    // === VERIFY ACCOUNT FEATURE ===
    expect(accountChange.feature).toBeTruthy();
    expect(accountChange.feature.title).toBe('Account Settings');
    expect(VALIDATORS.isValidFeatureHash(accountChange.feature)).toBe(true);
    expect(accountChange.feature.background).toBeUndefined(); // Account feature has no background
    
    // Verify account scenarios
    expect(Array.isArray(accountChange.scenarios)).toBe(true);
    expect(accountChange.scenarios).toHaveLength(1);
    
    const emailScenario = accountChange.scenarios[0];
    expect(emailScenario.title).toBe('Change email address');
    expect(VALIDATORS.isValidScenarioHash(emailScenario)).toBe(true);
    expect(VALIDATORS.areValidSteps(emailScenario.steps)).toBe(true);
    expect(emailScenario.steps).toHaveLength(3);
    
    // === VERIFY HASH CONSISTENCY ===
    // Each scenario should have a unique hash
    const allScenarios = [...authChange.scenarios, ...accountChange.scenarios];
    const scenarioHashes = allScenarios.map(s => s.hash);
    const uniqueHashes = [...new Set(scenarioHashes)];
    expect(uniqueHashes).toHaveLength(scenarioHashes.length);
    
    // Feature hashes should be different
    expect(authChange.feature.hash).not.toBe(accountChange.feature.hash);
  });

  test('should handle initial sync with no existing commit reference', async () => {
    // Setup basic scenario
    const headCommit = await buildInitialSyncScenario(tempDir, git);
    const projectId = '42';
    
    // Setup mocks specifically for initial sync (lastSyncedCommit: null)
    setupInitialSyncMocks(projectId, headCommit);
    
    // Execute
    await featuresync({
      project: projectId,
      apiUrl: 'https://api.testcollab.com'
    });
    
    // Verify the sync state call received correct project ID
    const syncStateCall = mockFetch.mock.calls[0];
    expect(syncStateCall[0]).toContain(`project=${projectId}`);
    expect(syncStateCall[1].method).toBeUndefined(); // GET is default
    
    // Verify payload has null prevCommit
    const payload = getFinalSyncPayload();
    expect(payload.prevCommit).toBeNull();
    expect(payload.headCommit).toBe(headCommit);
  });

  test('should create correct number of suites and test cases according to documentation', async () => {
    // Based on scenario 1 documentation:
    // - features/auth/user_login.feature creates: auth (parent) + User Login (child) = 2 suites
    // - features/account/account_settings.feature creates: account (parent) + Account Settings (child) = 2 suites
    // - Total: 4 suites, 3 test cases (2 from login + 1 from account)
    
    const headCommit = await buildInitialSyncScenario(tempDir, git);
    const projectId = '42';
    
    // Setup mocks with expected counts from documentation
    setupInitialSyncMocks(projectId, headCommit);
    
    await featuresync({
      project: projectId,
      apiUrl: 'https://api.testcollab.com'
    });
    
    const payload = getFinalSyncPayload();
    
    // Count scenarios across all changes
    const totalScenarios = payload.changes.reduce((count, change) => {
      return count + (change.scenarios ? change.scenarios.length : 0);
    }, 0);
    
    expect(totalScenarios).toBe(3); // As documented: 2 login scenarios + 1 account scenario
    expect(payload.changes).toHaveLength(2); // 2 feature files
    
    // Each change should represent a different feature file path
    const paths = payload.changes.map(c => c.newPath);
    expect(paths).toContain('features/auth/user_login.feature');
    expect(paths).toContain('features/account/account_settings.feature');
  });

  test('should include proper authorization headers in API calls', async () => {
    const headCommit = await buildInitialSyncScenario(tempDir, git);
    const projectId = '42';
    
    setupInitialSyncMocks(projectId, headCommit);
    
    await featuresync({
      project: projectId,
      apiUrl: 'https://api.testcollab.com'
    });
    
    // Verify all API calls include authorization header
    const apiCalls = mockFetch.mock.calls;
    
    apiCalls.forEach((call, index) => {
      const [url, options] = call;
      const headers = options?.headers || {};
      expect(headers['Authorization']).toBe('Bearer test-token-12345');
    });
  });
});
