/**
 * TCV-7036: two scenarios of one feature file with the same steps are two test cases.
 *
 * A scenario's hash is its file path and step lines, so scenarios with the same steps
 * share it. `tc sync` used to map every scenario to the one case resolve-ids names per
 * hash, and to miss a removed scenario whose hash another scenario still had. It now
 * matches the scenarios of the new file to those of the old file one to one, gives each
 * old scenario its own case from the list the API answers (caseLists), and sends a removed
 * scenario with its case id. These tests run the real featuresync (real git, real Gherkin
 * parse) and read the payload it sends.
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
const FEATURE_PATH = 'features/checkout.feature';
const CARD_CASE = 1001;
const WALLET_CASE = 1002;

const outline = (title, method, when = 'When I pay with "<method>"') => `
  Scenario Outline: ${title}
    Given I have an item in my cart
    ${when}
    Then the order is confirmed

    Examples:
      | method |
      | ${method} |
`;

// The sample file from the ticket
const TICKET_EXAMPLE = `Feature: Checkout
${outline('Pay with a card', 'visa')}${outline('Pay with a wallet', 'paypal')}`;

function scenarioHash(stepLines) {
  return createHash('sha1').update(`${FEATURE_PATH}:${stepLines.join('\n')}`, 'utf8').digest('hex');
}

const PAY_HASH = scenarioHash(['Given I have an item in my cart', 'When I pay with "<method>"', 'Then the order is confirmed']);

// What the API answers for the two cases the first sync created
const TICKET_CASES = {
  cases: { [PAY_HASH]: { caseId: WALLET_CASE } },
  caseLists: { [PAY_HASH]: [{ caseId: CARD_CASE, title: 'Pay with a card' }, { caseId: WALLET_CASE, title: 'Pay with a wallet' }] }
};

// [title, prevHash, caseId, deleted] of each scenario the change sends
const summary = change => change.scenarios.map(s => [s.title, s.prevHash, s.caseId, s.deleted]);

describe('TCV-7036: scenarios with the same steps in one feature file', () => {
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

  // Commits `before`, then `after`, and syncs the second commit as a modification.
  // `resolved` is the resolve-ids answer: { cases, caseLists }; no caseLists is an older API.
  async function syncModification(before, after, resolved) {
    await createFeatureFile(tempDir, FEATURE_PATH, before);
    const firstCommit = await commitAllChanges(git, 'Add feature');
    await createFeatureFile(tempDir, FEATURE_PATH, after);
    const secondCommit = await commitAllChanges(git, 'Change feature');

    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(PROJECT_ID, firstCommit))
      .mockResolvedValueOnce(mockResolveIds({}, resolved.cases, resolved.caseLists))
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: secondCommit }));
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });

    return {
      resolveRequest: getLastApiCall('POST', '/resolve-ids').body,
      change: getFinalSyncPayload().changes[0]
    };
  }

  test('the scenarios share a hash, which stays what every CLI stored', async () => {
    const { resolveRequest, change } = await syncModification(TICKET_EXAMPLE, TICKET_EXAMPLE.replace('| paypal |', '| paypal |\n      | venmo |'), TICKET_CASES);

    expect(resolveRequest.scenarios).toEqual([PAY_HASH, PAY_HASH]);
    expect(change.scenarios.map(s => s.hash)).toEqual([PAY_HASH, PAY_HASH]);
    expect(summary(change)).toEqual([
      ['Pay with a card', PAY_HASH, CARD_CASE, undefined],
      ['Pay with a wallet', PAY_HASH, WALLET_CASE, undefined]
    ]);
    expect(change.scenarios[1].examples.rows).toEqual([['paypal'], ['venmo']]);
  });

  test('renaming one scenario sends it with its own case; the other keeps its case', async () => {
    const { change } = await syncModification(TICKET_EXAMPLE, TICKET_EXAMPLE.replace('Pay with a card', 'Pay by card'), TICKET_CASES);

    expect(summary(change)).toEqual([
      ['Pay by card', PAY_HASH, CARD_CASE, undefined],
      ['Pay with a wallet', PAY_HASH, WALLET_CASE, undefined]
    ]);
  });

  test('removing one scenario sends its case id as removed; the other keeps its case', async () => {
    const withoutCard = `Feature: Checkout
${outline('Pay with a wallet', 'paypal')}`;

    const { change } = await syncModification(TICKET_EXAMPLE, withoutCard, TICKET_CASES);

    expect(summary(change)).toEqual([
      ['Pay with a wallet', PAY_HASH, WALLET_CASE, undefined],
      [undefined, PAY_HASH, CARD_CASE, true]
    ]);
  });

  test('swapping the two scenarios keeps each on its case, by title', async () => {
    const swapped = `Feature: Checkout
${outline('Pay with a wallet', 'paypal')}${outline('Pay with a card', 'visa')}`;

    const { change } = await syncModification(TICKET_EXAMPLE, swapped, TICKET_CASES);

    expect(summary(change)).toEqual([
      ['Pay with a wallet', PAY_HASH, WALLET_CASE, undefined],
      ['Pay with a card', PAY_HASH, CARD_CASE, undefined]
    ]);
  });

  test('a scenario that changes its steps keeps its case by title; its twin keeps its own', async () => {
    const edited = TICKET_EXAMPLE.replace('When I pay with "<method>"', 'When I pay by card with "<method>"');

    const { change } = await syncModification(TICKET_EXAMPLE, edited, TICKET_CASES);

    expect(change.scenarios[0].hash).not.toBe(PAY_HASH);
    expect(summary(change)).toEqual([
      ['Pay with a card', PAY_HASH, CARD_CASE, undefined],
      ['Pay with a wallet', PAY_HASH, WALLET_CASE, undefined]
    ]);
  });

  test('a scenario added with the same steps as another is new: no case id, no previous hash', async () => {
    const before = `Feature: Checkout
${outline('Pay with a card', 'visa')}`;

    const { change } = await syncModification(before, TICKET_EXAMPLE, {
      cases: { [PAY_HASH]: { caseId: CARD_CASE } },
      caseLists: { [PAY_HASH]: [{ caseId: CARD_CASE, title: 'Pay with a card' }] }
    });

    expect(summary(change)).toEqual([
      ['Pay with a card', PAY_HASH, CARD_CASE, undefined],
      ['Pay with a wallet', undefined, undefined, undefined]
    ]);
  });

  test('the same steps and the same title: the cases go in file order, and removing the second removes its case', async () => {
    const twins = `Feature: Checkout
${outline('Pay', 'visa')}${outline('Pay', 'paypal')}`;
    const resolved = {
      cases: { [PAY_HASH]: { caseId: WALLET_CASE } },
      caseLists: { [PAY_HASH]: [{ caseId: CARD_CASE, title: 'Pay' }, { caseId: WALLET_CASE, title: 'Pay' }] }
    };

    const edited = await syncModification(twins, twins.replace('| paypal |', '| amex |'), resolved);
    expect(summary(edited.change)).toEqual([
      ['Pay', PAY_HASH, CARD_CASE, undefined],
      ['Pay', PAY_HASH, WALLET_CASE, undefined]
    ]);

    setupApiMocks();
    const removed = await syncModification(twins, `Feature: Checkout
${outline('Pay', 'visa')}`, resolved);
    expect(summary(removed.change)).toEqual([
      ['Pay', PAY_HASH, CARD_CASE, undefined],
      [undefined, PAY_HASH, WALLET_CASE, true]
    ]);
  });

  test('a listed case whose title matches no scenario goes to the scenario left over', async () => {
    // Before this fix, renaming "Pay with a card" to "Pay by card" reached the wallet case
    // only, so the card case still has its first title
    const renamed = TICKET_EXAMPLE.replace('Pay with a card', 'Pay by card');

    const { change } = await syncModification(renamed, renamed.replace('| visa |', '| amex |'), TICKET_CASES);

    expect(summary(change)).toEqual([
      ['Pay by card', PAY_HASH, CARD_CASE, undefined],
      ['Pay with a wallet', PAY_HASH, WALLET_CASE, undefined]
    ]);
  });

  test('an API without caseLists: every scenario of the hash gets its one case, and a removal that would take it is not sent', async () => {
    const withoutCard = `Feature: Checkout
${outline('Pay with a wallet', 'paypal')}`;
    const olderApi = { cases: TICKET_CASES.cases };

    const renamed = await syncModification(TICKET_EXAMPLE, TICKET_EXAMPLE.replace('Pay with a card', 'Pay by card'), olderApi);
    expect(summary(renamed.change)).toEqual([
      ['Pay by card', PAY_HASH, WALLET_CASE, undefined],
      ['Pay with a wallet', PAY_HASH, WALLET_CASE, undefined]
    ]);

    setupApiMocks();
    const removed = await syncModification(TICKET_EXAMPLE, withoutCard, olderApi);
    expect(summary(removed.change)).toEqual([['Pay with a wallet', PAY_HASH, WALLET_CASE, undefined]]);
  });

  test('two scenarios never continue one old scenario, also when their steps differ', async () => {
    // "Login" keeps its title with new steps; its copy "Login v2" keeps the old steps.
    const before = `Feature: Login

  Scenario: Login
    Given the login page
    When I sign in
`;
    const after = `Feature: Login

  Scenario: Login
    Given the login page
    When I sign in with a passkey

  Scenario: Login v2
    Given the login page
    When I sign in
`;
    const loginHash = scenarioHash(['Given the login page', 'When I sign in']);

    const { change } = await syncModification(before, after, { cases: { [loginHash]: { caseId: CARD_CASE } } });

    // The copy has the old steps, so it continues the old scenario; "Login" is new
    expect(summary(change)).toEqual([
      ['Login', undefined, undefined, undefined],
      ['Login v2', loginHash, CARD_CASE, undefined]
    ]);
  });
});
