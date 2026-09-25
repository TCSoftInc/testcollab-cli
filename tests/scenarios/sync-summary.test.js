/**
 * TCV-7029: tc sync prints what the sync did.
 *
 * POST /bdd/sync answers { success, message, results }, and the summary read the
 * counts from the top level of that answer. So it printed no count, never showed
 * a warning, and always ended with "No changes were required", even after it had
 * created suites and test cases. These tests run the real featuresync against
 * that answer shape and read what it prints.
 */

import { describe, test, beforeEach, afterEach, expect, jest } from '@jest/globals';
import {
  createTempDir,
  initGitRepo,
  cleanupTempDir,
  createFeatureFile,
  commitAllChanges
} from '../utils/git-helpers.js';
import {
  setupApiMocks,
  mockInitialSyncState,
  mockSuccessfulSync,
  mockFetch,
  resetApiMocks
} from '../utils/api-mocks.js';
import { featuresync } from '../../src/commands/featuresync.js';

const PROJECT_ID = '42';
const API_URL = 'https://api.testcollab.com';
const PLAN_WARNING =
  'Scenario Outline Examples were not saved as test datasets: test datasets are not available for this project (they need the Elite or Enterprise plan).';
const NO_CHANGES = 'ℹ️  No changes were required - everything is already in sync';

describe('TCV-7029: the sync summary', () => {
  let tempDir;
  let git;
  let originalEnv;
  let originalCwd;
  let log;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await createTempDir();
    git = await initGitRepo(tempDir);
    setupApiMocks();
    originalEnv = process.env.TESTCOLLAB_TOKEN;
    process.env.TESTCOLLAB_TOKEN = 'test-token-12345';
    process.chdir(tempDir);
  });

  afterEach(async () => {
    if (log) {
      log.mockRestore();
      log = null;
    }
    process.chdir(originalCwd);
    await cleanupTempDir(tempDir);
    resetApiMocks();
    if (originalEnv) {
      process.env.TESTCOLLAB_TOKEN = originalEnv;
    } else {
      delete process.env.TESTCOLLAB_TOKEN;
    }
  });

  // One first sync that the server answers with `results`; returns every printed line
  async function syncAndPrint(results) {
    await createFeatureFile(tempDir, 'features/login.feature', `Feature: Login

  Scenario: Sign in
    When I sign in
    Then I see the dashboard
`);
    const headCommit = await commitAllChanges(git, 'Add feature');
    mockFetch
      .mockResolvedValueOnce(mockInitialSyncState(PROJECT_ID))
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: headCommit, ...results }));
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });
    return log.mock.calls.map(args => args.join(' '));
  }

  test('the counts and the warnings in the answer are printed', async () => {
    const printed = await syncAndPrint({ createdSuites: 1, createdCases: 2, warnings: [PLAN_WARNING] });

    expect(printed).toContain('✨ Created 1 suite(s)');
    expect(printed).toContain('✨ Created 2 test case(s)');
    expect(printed).toContain('\n⚠️  Warnings:');
    expect(printed).toContain(`   ${PLAN_WARNING}`);
    expect(printed).not.toContain(NO_CHANGES);
  });

  test('a sync that changed nothing still says so', async () => {
    const printed = await syncAndPrint({ createdSuites: 0, createdCases: 0 });

    expect(printed).toContain(NO_CHANGES);
    expect(printed.filter(line => /^(✨|🔄|🗑️)/.test(line))).toEqual([]);
  });
});
