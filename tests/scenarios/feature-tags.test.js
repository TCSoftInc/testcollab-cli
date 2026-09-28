/**
 * TCV-7053: tags on a Feature are inherited by every synced scenario.
 */

import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import {
  createTempDir,
  initGitRepo,
  cleanupTempDir,
  createFeatureFile,
  commitAllChanges
} from '../utils/git-helpers.js';
import {
  setupApiMocks,
  setupInitialSyncMocks,
  mockExistingSyncState,
  mockResolveIds,
  mockSuccessfulSync,
  mockFetch,
  getFinalSyncPayload,
  resetApiMocks
} from '../utils/api-mocks.js';
import { featuresync } from '../../src/commands/featuresync.js';

const PROJECT_ID = '42';
const API_URL = 'https://api.testcollab.com';
const FEATURE_PATH = 'features/tagged.feature';

describe('TCV-7053: Feature tags', () => {
  let tempDir;
  let git;
  let originalEnv;
  let originalCwd;

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
    process.chdir(originalCwd);
    await cleanupTempDir(tempDir);
    resetApiMocks();
    if (originalEnv) {
      process.env.TESTCOLLAB_TOKEN = originalEnv;
    } else {
      delete process.env.TESTCOLLAB_TOKEN;
    }
  });

  async function syncFirstTime(content) {
    await createFeatureFile(tempDir, FEATURE_PATH, content);
    const headCommit = await commitAllChanges(git, 'Add tagged feature');
    setupInitialSyncMocks(PROJECT_ID, headCommit);
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });
    return getFinalSyncPayload().changes[0];
  }

  async function syncModification(before, after) {
    await createFeatureFile(tempDir, FEATURE_PATH, before);
    const firstCommit = await commitAllChanges(git, 'Add tagged feature');
    await createFeatureFile(tempDir, FEATURE_PATH, after);
    const secondCommit = await commitAllChanges(git, 'Remove Feature tag');

    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(PROJECT_ID, firstCommit))
      .mockResolvedValueOnce(mockResolveIds({}, {}))
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: secondCommit }));
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });
    return getFinalSyncPayload().changes[0];
  }

  test('Feature tags go before Rule and Scenario tags on every scenario', async () => {
    const change = await syncFirstTime(`@automated @web
Feature: Tagged checkout

  @smoke
  Scenario: Pay by card
    Given a card

  @payments
  Rule: Payment methods

    @wallet
    Scenario: Pay by wallet
      Given a wallet

    Scenario: Pay by transfer
      Given a bank account
`);

    expect(change.scenarios.map(scenario => scenario.tags)).toEqual([
      ['automated', 'web', 'smoke'],
      ['automated', 'web', 'payments', 'wallet'],
      ['automated', 'web', 'payments']
    ]);
  });

  test('removing the last inherited tag sends an empty tag list', async () => {
    const before = `@automated
Feature: Tagged checkout

  @smoke
  Scenario: Pay by card
    Given a card

  Scenario: Pay by transfer
    Given a bank account
`;
    const after = `Feature: Tagged checkout

  @smoke
  Scenario: Pay by card
    Given a card

  Scenario: Pay by transfer
    Given a bank account
`;
    const change = await syncModification(before, after);

    expect(change.scenarios.map(scenario => scenario.tags)).toEqual([
      ['smoke'],
      []
    ]);
  });
});
