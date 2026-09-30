/**
 * TCV-7031: a step's data table and doc string reach TestCollab.
 *
 * `tc sync` used to send only the keyword and the step line, so the table or
 * text block under a step was lost. These tests run the real featuresync (real
 * git, real Gherkin parse) and read the payload it sends to POST /bdd/sync.
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
const FEATURE_PATH = 'features/user_directory.feature';

// The example from the ticket.
const TICKET_EXAMPLE = `Feature: User directory

  Scenario: Bulk user import
    Given the following users exist:
      | name   | email              |
      | Aslak  | aslak@example.com  |
      | Julien | julien@example.com |
    When I open the directory
    Then I see the welcome text
      """
      Welcome to the directory.
      2 users are listed.
      """
`;

const USERS_TABLE =
  '<table class="bdd-data-table"><tbody>' +
  '<tr><td>name</td><td>email</td></tr>' +
  '<tr><td>Aslak</td><td>aslak@example.com</td></tr>' +
  '<tr><td>Julien</td><td>julien@example.com</td></tr>' +
  '</tbody></table>';

// What every CLI before TCV-7031 hashed: keyword + step line, nothing else.
function legacyHash(filePath, stepLines) {
  return createHash('sha1').update(`${filePath}:${stepLines.join('\n')}`, 'utf8').digest('hex');
}

describe('TCV-7031: step data tables and doc strings', () => {
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

  test('the ticket example: the table follows the step line, the text block follows the Then line', async () => {
    const change = await syncFirstTime(TICKET_EXAMPLE);

    expect(change.scenarios[0].steps).toEqual([
      `Given the following users exist:${USERS_TABLE}`,
      'When I open the directory',
      'Then I see the welcome text<pre class="bdd-doc-string">Welcome to the directory.<br>2 users are listed.</pre>'
    ]);
  });

  test('every step stays on one line, because the API reads the steps line by line', async () => {
    const change = await syncFirstTime(`Feature: Blank lines

  Scenario: A text block with an empty line
    Given the message
      """
      first paragraph

      second paragraph
      """
    Then it is sent
`);

    const steps = change.scenarios[0].steps;
    steps.forEach(step => expect(step).not.toMatch(/[\r\n]/));
    expect(steps[0]).toBe(
      'Given the message<pre class="bdd-doc-string">first paragraph<br><br>second paragraph</pre>'
    );
    expect(steps[1]).toBe('Then it is sent');
  });

  test('cell and text block content shows as plain text, never as markup', async () => {
    const change = await syncFirstTime(`Feature: Escaping

  Scenario: Markup in a cell
    Given these values:
      | value     | note      |
      | <b>bold</b> | Tom & Jerry |
      | a \\| b   | line\\nbreak |
    Then the page shows
      """
      <script>alert(1)</script> & more
      """
`);

    const [given, then] = change.scenarios[0].steps;
    expect(given).toContain('<td>&lt;b&gt;bold&lt;/b&gt;</td><td>Tom &amp; Jerry</td>');
    // Gherkin's own escapes: \| is a pipe inside the cell, \n a line break
    expect(given).toContain('<td>a | b</td><td>line<br>break</td>');
    expect(then).toBe(
      'Then the page shows<pre class="bdd-doc-string">&lt;script&gt;alert(1)&lt;/script&gt; &amp; more</pre>'
    );
  });

  test('a table can sit under any keyword', async () => {
    const change = await syncFirstTime(`Feature: Keywords

  Scenario: Tables everywhere
    Given a list:
      | g |
    And another list:
      | a |
    When I submit:
      | w |
    Then the result is:
      | t |
    But not:
      | b |
`);

    const cell = value => `<table class="bdd-data-table"><tbody><tr><td>${value}</td></tr></tbody></table>`;
    expect(change.scenarios[0].steps).toEqual([
      `Given a list:${cell('g')}`,
      `And another list:${cell('a')}`,
      `When I submit:${cell('w')}`,
      `Then the result is:${cell('t')}`,
      `But not:${cell('b')}`
    ]);
  });

  test('a background table is sent with the background, which the API puts on every case', async () => {
    const change = await syncFirstTime(`Feature: Background

  Background:
    Given the roles exist:
      | role  |
      | admin |

  Scenario: One
    When I open the directory

  Scenario: Two
    When I open the settings
`);

    expect(change.feature.background).toEqual([
      'Given the roles exist:<table class="bdd-data-table"><tbody><tr><td>role</td></tr><tr><td>admin</td></tr></tbody></table>'
    ]);
    expect(change.scenarios).toHaveLength(2);
  });

  test('steps without a table or text block are sent exactly as before', async () => {
    const change = await syncFirstTime(`Feature: Plain

  Background:
    Given the application is running

  Scenario: Plain steps
    Given I am on the login page
    When I sign in
    Then I see the dashboard
`);

    expect(change.feature.background).toEqual(['Given the application is running']);
    expect(change.scenarios[0].steps).toEqual([
      'Given I am on the login page',
      'When I sign in',
      'Then I see the dashboard'
    ]);
  });

  test('the scenario hash ignores the table, so a case synced by an older CLI keeps its identity', async () => {
    const change = await syncFirstTime(TICKET_EXAMPLE);

    expect(change.scenarios[0].hash).toBe(
      legacyHash(FEATURE_PATH, [
        'Given the following users exist:',
        'When I open the directory',
        'Then I see the welcome text'
      ])
    );
  });

  test('changing one cell updates the synced case instead of creating another', async () => {
    await createFeatureFile(tempDir, FEATURE_PATH, TICKET_EXAMPLE);
    const firstCommit = await commitAllChanges(git, 'Add feature');
    await createFeatureFile(tempDir, FEATURE_PATH, TICKET_EXAMPLE.replace('julien@example.com', 'julien@example.org'));
    const secondCommit = await commitAllChanges(git, 'Change one cell');

    // The hashes the server stored at the first sync, as an older CLI computed them
    const scenarioHash = legacyHash(FEATURE_PATH, [
      'Given the following users exist:',
      'When I open the directory',
      'Then I see the welcome text'
    ]);
    // Probe run: learn the feature hash the CLI sends for the previous commit
    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(PROJECT_ID, firstCommit))
      .mockResolvedValueOnce(mockResolveIds({}, {}))
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: secondCommit }));
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });
    const probe = getLastApiCall('POST', '/resolve-ids').body;
    expect(probe.scenarios).toEqual([scenarioHash]);
    const featureHash = probe.features[0];

    setupApiMocks();
    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(PROJECT_ID, firstCommit))
      .mockResolvedValueOnce(mockResolveIds({ [featureHash]: { suiteId: 101 } }, { [scenarioHash]: { caseId: 1001 } }))
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: secondCommit, updatedCases: 1 }));
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });

    const change = getFinalSyncPayload().changes[0];
    expect(change.status).toBe('M');
    expect(change.feature.hash).toBe(featureHash);
    expect(change.feature.prevHash).toBe(featureHash);
    expect(change.feature.suiteId).toBe(101);
    expect(change.scenarios).toHaveLength(1);
    const scenario = change.scenarios[0];
    expect(scenario.hash).toBe(scenarioHash);
    expect(scenario.prevHash).toBe(scenarioHash);
    expect(scenario.caseId).toBe(1001);
    expect(scenario.deleted).toBeUndefined();
    expect(scenario.steps[0]).toContain('<td>julien@example.org</td>');
    expect(scenario.steps[0]).not.toContain('julien@example.com');
  });
});
