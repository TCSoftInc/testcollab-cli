/**
 * TCV-6202: a scenario's tags do not become part of a description.
 *
 * `tc sync` read the feature description and the background text line by line up to
 * the next Scenario: heading, so the tag line written above that heading was read in
 * too. The server writes the background text as the description of every case of the
 * feature, and the feature description as the suite description. These tests run the
 * real featuresync (real git, real Gherkin parse) and read the payload it sends.
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
  getLastApiCall,
  resetApiMocks
} from '../utils/api-mocks.js';
import { featuresync } from '../../src/commands/featuresync.js';

const PROJECT_ID = '42';
const API_URL = 'https://api.testcollab.com';
const FEATURE_PATH = 'features/auth/user_login.feature';

// The file from the ticket, cut to two scenarios.
const TICKET_EXAMPLE = `Feature: Users Authentication
  A registered user wants to sign in

  Background:
    Given that the test application is running on production
    And he is currently on the login page

  @authentication
  Scenario: Verify successful login with a valid username and password
    When He enters dummy data "valid@example.com" in the email entry field
    And He clicks the login button
    Then He should be redirected to the profile section

  @auth @ci
  Scenario: Failed login with incorrect creds
    When I enter "valid@example.com" in the email field
    Then I should see an error message "Invalid credentials"
`;

// The same feature with no Background: the tags were read into the feature description
const NO_BACKGROUND = `Feature: Users Authentication
  A registered user wants to sign in

  @authentication
  Scenario: Verify successful login
    When He clicks the login button
    Then He should be redirected to the profile section
`;

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

describe('TCV-6202: scenario tags stay out of the descriptions', () => {
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
    const headCommit = await commitAllChanges(git, 'Add feature');
    setupInitialSyncMocks(PROJECT_ID, headCommit);
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });
    return getFinalSyncPayload().changes[0];
  }

  // Commits `before`, then `after`, and syncs the second commit as a modification.
  async function syncModification(before, after, resolved) {
    await createFeatureFile(tempDir, FEATURE_PATH, before);
    const firstCommit = await commitAllChanges(git, 'Add feature');
    await createFeatureFile(tempDir, FEATURE_PATH, after);
    const secondCommit = await commitAllChanges(git, 'Change feature');

    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(PROJECT_ID, firstCommit))
      .mockResolvedValueOnce(mockResolveIds(resolved.suites, resolved.cases))
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: secondCommit }));
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });

    return {
      resolveRequest: getLastApiCall('POST', '/resolve-ids').body,
      change: getFinalSyncPayload().changes[0]
    };
  }

  test('the ticket example: the first scenario tag stays out of the background text, the case description', async () => {
    const change = await syncFirstTime(TICKET_EXAMPLE);

    expect(change.feature).toEqual({
      hash: expect.any(String),
      title: 'Users Authentication',
      description: 'A registered user wants to sign in',
      background: [
        'Given that the test application is running on production',
        'And he is currently on the login page'
      ],
      backgroundText: [
        'Given that the test application is running on production',
        'And he is currently on the login page'
      ]
    });
    // Still sent as the scenario tags
    expect(change.scenarios.map(s => s.tags)).toEqual([['authentication'], ['auth', 'ci']]);
  });

  test('with no Background, the first scenario tag stays out of the feature description, the suite description', async () => {
    const change = await syncFirstTime(NO_BACKGROUND);

    expect(change.feature.description).toBe('A registered user wants to sign in');
    expect(change.feature.backgroundText).toBeUndefined();
    expect(change.scenarios[0].tags).toEqual(['authentication']);
  });

  test('tag lines, comments and blank lines before the first scenario stay out, the background lines stay in', async () => {
    const change = await syncFirstTime(`Feature: Checkout

  Background: Signed in
    The shopper has an account.
    Given I am signed in
    And my cart holds:
      | item  |
      | shirt |

  # The happy path
  @smoke @checkout

  @web
  # Tagged twice
  Scenario: Pay by card
    When I pay by card
    Then the order is placed
`);

    expect(change.feature.backgroundText).toEqual([
      'The shopper has an account.',
      'Given I am signed in',
      'And my cart holds:',
      '| item  |',
      '| shirt |'
    ]);
    expect(change.scenarios[0].tags).toEqual(['smoke', 'checkout', 'web']);
  });

  test('a block ends at the next scenario whatever its keyword: Example and Scenario Outline', async () => {
    // Read line by line, the background went on through an Example: to the end of the file
    const example = await syncFirstTime(`Feature: Refunds

  Background:
    Given I am logged in

  Example: Return inside the window
    Given I bought a jacket 10 days ago
    Then the refund is approved
`);
    expect(example.feature.backgroundText).toEqual(['Given I am logged in']);

    // ... and the feature description through a Scenario Outline and its Examples
    setupApiMocks();
    const outline = await syncFirstTime(`Feature: Refunds
  Customers can return an item.

  Scenario Outline: Return after <days> days
    Given I bought a jacket <days> days ago

    Examples:
      | days |
      | 10   |
`);
    expect(outline.feature.description).toBe('Customers can return an item.');
  });

  test('the background ends where a tagged rule starts (TCV-6912)', async () => {
    const change = await syncFirstTime(`Feature: Refunds

  Background:
    Given I am logged in

  @policy
  Rule: A refund is only possible within 30 days

    Example: Return inside the window
      Given I bought a jacket 10 days ago
`);

    expect(change.feature.backgroundText).toEqual(['Given I am logged in']);
    expect(change.scenarios[0].tags).toEqual(['policy']);
  });

  test('with nothing after it, a background or a description reads to the end of the file', async () => {
    const backgroundOnly = await syncFirstTime(`Feature: Work in progress

  Background:
    Given I am logged in
    # Scenarios to come
`);
    expect(backgroundOnly.feature.backgroundText).toEqual(['Given I am logged in']);
    expect(backgroundOnly.scenarios).toEqual([]);

    setupApiMocks();
    const descriptionOnly = await syncFirstTime(`Feature: Work in progress
  Scenarios to come.
`);
    expect(descriptionOnly.feature.description).toBe('Scenarios to come.');
  });

  test('the feature hash is the one older CLIs stored, so the suite is found and gets the corrected description', async () => {
    const edited = NO_BACKGROUND.replace('Then He should be redirected to the profile section', 'Then He should see the profile section');
    // What every CLI hashed for this file, before and after TCV-6202: the description read
    // on into the tag line, then one "undefinedundefined" per scenario step (the feature
    // hash reads each step string as if it were a step object).
    const storedHash = sha1(`${FEATURE_PATH}:A registered user wants to sign in\n@authentication\nundefinedundefined\nundefinedundefined`);

    const { resolveRequest, change } = await syncModification(NO_BACKGROUND, edited, {
      suites: { [storedHash]: { suiteId: 101 } },
      cases: {}
    });

    expect(resolveRequest.features).toEqual([storedHash]);
    expect(change.status).toBe('M');
    expect(change.feature.prevHash).toBe(storedHash);
    expect(change.feature.suiteId).toBe(101);
    // The server replaces the suite description when the one sent differs
    expect(change.feature.description).toBe('A registered user wants to sign in');
  });
});
