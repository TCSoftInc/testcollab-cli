/**
 * TCV-7133: the Rule: blocks of a feature file travel with the feature.
 *
 * TestCollab keeps one requirement per feature file and writes each Rule: block into
 * it as an acceptance criterion. The scenarios only carried the title of the rule they
 * sit under, so the text under a rule, and a rule with no scenario yet, never reached
 * the server. These tests run the real featuresync (real git, real Gherkin parse) and
 * read the payload it sends.
 */

import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import { createHash } from 'crypto';
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
const FEATURE_PATH = 'features/refunds.feature';

const REFUNDS = `Feature: Refunds
  Customers can return an item for a refund.

  Background:
    Given I am logged in as a customer

  Rule: A refund is only possible within 30 days of purchase
    Refunds after 30 days need a manager.

      The manager signs the form.

    Example: Return inside the window
      Given I bought a jacket 10 days ago
      Then the refund is approved

  @later
  Rule: Gift cards are refunded as store credit
    No example is written for this rule yet.
`;

const REFUND_RULES = [
  {
    title: 'A refund is only possible within 30 days of purchase',
    description: 'Refunds after 30 days need a manager.\nThe manager signs the form.'
  },
  {
    title: 'Gift cards are refunded as store credit',
    description: 'No example is written for this rule yet.'
  }
];

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

describe('TCV-7133: the Rule: blocks of a feature', () => {
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

  async function syncFirstTime(content, filePath = FEATURE_PATH) {
    await createFeatureFile(tempDir, filePath, content);
    const headCommit = await commitAllChanges(git, 'Add feature');
    setupInitialSyncMocks(PROJECT_ID, headCommit);
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });
    return getFinalSyncPayload().changes[0];
  }

  test('each rule goes with the feature: its title and the text under it, a rule with no scenario too', async () => {
    const change = await syncFirstTime(REFUNDS);

    expect(change.feature.rules).toEqual(REFUND_RULES);
    // A rule with no scenario adds no test case
    expect(change.scenarios.map(s => [s.title, s.rule.title])).toEqual([
      ['Return inside the window', 'A refund is only possible within 30 days of purchase']
    ]);
  });

  test('the rules change no hash, so the suite and the cases of an older sync are still found', async () => {
    const change = await syncFirstTime(REFUNDS);

    // What every CLI before TCV-7133 hashed for this file (see rules.test.js)
    expect(change.feature.hash).toBe(sha1(`${FEATURE_PATH}:Customers can return an item for a refund.\nGiven I am logged in as a customer`));
    expect(change.scenarios[0].hash).toBe(sha1(`${FEATURE_PATH}:Given I bought a jacket 10 days ago\nThen the refund is approved`));
  });

  test('a file with no rule sends no rules field, as before', async () => {
    const change = await syncFirstTime(`Feature: Login
  Sign in with a password.

  Scenario: Sign in
    When I sign in
    Then I see the dashboard
`);

    expect(change.feature).not.toHaveProperty('rules');
  });

  test('a rename with no content change still sends the rules', async () => {
    await createFeatureFile(tempDir, FEATURE_PATH, REFUNDS);
    const firstCommit = await commitAllChanges(git, 'Add feature');
    await git.mv(FEATURE_PATH, 'features/store_refunds.feature');
    const secondCommit = await commitAllChanges(git, 'Rename feature');

    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(PROJECT_ID, firstCommit))
      .mockResolvedValueOnce(mockResolveIds({}, {}))
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: secondCommit }));
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });

    const change = getFinalSyncPayload().changes[0];
    expect(change.status).toBe('R100');
    expect(change.feature.rules).toEqual(REFUND_RULES);
    // A rename sends no steps
    expect(change.scenarios[0].steps).toBeUndefined();
  });

  // TCV-7133: a requirement can fail after the API saved the case checkpoint.
  // Every sync checks the API's durable pending work, without resending any cases.
  test.each([false, true])('retry pending requirements with no feature delta (later commit: %s)', async (laterCommit) => {
    await createFeatureFile(tempDir, FEATURE_PATH, REFUNDS);
    const firstCommit = await commitAllChanges(git, 'Add feature');
    if (laterCommit) await git.raw(['commit', '--allow-empty', '-m', 'No feature changes']);
    const headCommit = await git.revparse(['HEAD']);
    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(PROJECT_ID, firstCommit))
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: headCommit, createdRequirements: 1 }));

    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });

    expect(getFinalSyncPayload()).toMatchObject({ headCommit, changes: [] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
