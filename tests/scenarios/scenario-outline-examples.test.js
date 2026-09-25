/**
 * TCV-6057: a Scenario Outline's Examples table reaches TestCollab.
 *
 * `tc sync` used to send an outline's steps with their <placeholders> and drop
 * the Examples table. It now sends the table with the scenario, so the API can
 * turn it into a test dataset, and writes each placeholder as {{name}}, the
 * reference TestCollab fills from that dataset. These tests run the real
 * featuresync (real git, real Gherkin parse) and read the payload it sends to
 * POST /bdd/sync.
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
const FEATURE_PATH = 'features/auth/login.feature';

const LOGIN_OUTLINE = `Feature: User Login

  Background:
    Given the application is running

  Scenario Outline: Login attempt with different credentials
    When I enter "<email>" in the email field
    And I enter "<password>" in the password field
    Then I should see "<result>"

    Examples:
      | email             | password | result          |
      | valid@example.com | correct  | the dashboard   |
      | valid@example.com | wrong    | an error banner |
`;

const LOGIN_STEP_LINES = [
  'When I enter "<email>" in the email field',
  'And I enter "<password>" in the password field',
  'Then I should see "<result>"'
];

// What every CLI before TCV-6057 hashed: keyword + step line, placeholders as written.
function legacyHash(filePath, stepLines) {
  return createHash('sha1').update(`${filePath}:${stepLines.join('\n')}`, 'utf8').digest('hex');
}

describe('TCV-6057: Scenario Outline Examples', () => {
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

  test('an outline is one scenario that carries its Examples table and {{name}} references', async () => {
    const change = await syncFirstTime(LOGIN_OUTLINE);

    expect(change.scenarios).toHaveLength(1);
    const [scenario] = change.scenarios;
    expect(scenario.title).toBe('Login attempt with different credentials');
    expect(scenario.steps).toEqual([
      'When I enter "{{email}}" in the email field',
      'And I enter "{{password}}" in the password field',
      'Then I should see "{{result}}"'
    ]);
    expect(scenario.examples).toEqual({
      parameters: ['email', 'password', 'result'],
      rows: [
        ['valid@example.com', 'correct', 'the dashboard'],
        ['valid@example.com', 'wrong', 'an error banner']
      ]
    });
    // Cucumber does not fill a Background from the Examples, so neither does the sync
    expect(change.feature.background).toEqual(['Given the application is running']);
  });

  test('several Examples blocks become one table: columns in first-seen order, empty where a block has none', async () => {
    const change = await syncFirstTime(`Feature: Search

  Scenario Outline: Search by <field>
    When I search the <field> for "<term>"
    Then I see <count> results

    @smoke
    Examples: Titles
      | field | term  | count |
      | title | login | 2     |

    Examples: Tags
      | term       | field | count | note     |
      | regression | tag   | 14    | nightly  |
      | smoke      | tag   | 3     |          |

    Examples: Without a table
`);

    const [scenario] = change.scenarios;
    expect(scenario.examples).toEqual({
      parameters: ['field', 'term', 'count', 'note'],
      rows: [
        ['title', 'login', '2', ''],
        ['tag', 'regression', '14', 'nightly'],
        ['tag', 'smoke', '3', '']
      ]
    });
    expect(scenario.steps).toEqual([
      'When I search the {{field}} for "{{term}}"',
      'Then I see {{count}} results'
    ]);
    // The title keeps its placeholder: it is how the sync and CI results find the case again
    expect(scenario.title).toBe('Search by <field>');
  });

  test('a placeholder in a step table or doc string is replaced too, and the HTML around it is not', async () => {
    const change = await syncFirstTime(`Feature: Directory

  Scenario Outline: Import a <td> user
    Given the following users exist:
      | name   | role |
      | <name> | <td> |
    When I open the directory
    Then I see the welcome text
      """
      Welcome <name>, you are a <td>.
      """

    Examples:
      | name  | td    |
      | Aslak | admin |
`);

    const [scenario] = change.scenarios;
    expect(scenario.steps).toEqual([
      'Given the following users exist:<table class="bdd-data-table"><tbody>' +
        '<tr><td>name</td><td>role</td></tr>' +
        '<tr><td>{{name}}</td><td>{{td}}</td></tr>' +
        '</tbody></table>',
      'When I open the directory',
      'Then I see the welcome text<pre class="bdd-doc-string">Welcome {{name}}, you are a {{td}}.</pre>'
    ]);
    expect(scenario.examples).toEqual({ parameters: ['name', 'td'], rows: [['Aslak', 'admin']] });
  });

  test('only Examples columns are replaced; other angle brackets stay as written', async () => {
    const change = await syncFirstTime(`Feature: Partial

  Scenario Outline: One column
    When I type <text> into <field>
    Then the cell shows:
      | <other> |

    Examples:
      | text  |
      | hello |
`);

    const [scenario] = change.scenarios;
    expect(scenario.steps).toEqual([
      'When I type {{text}} into <field>',
      'Then the cell shows:<table class="bdd-data-table"><tbody><tr><td>&lt;other&gt;</td></tr></tbody></table>'
    ]);
  });

  test('a plain Scenario, and an outline with no example rows, send no table and keep their text', async () => {
    const change = await syncFirstTime(`Feature: Plain

  Scenario: Plain steps
    When I sign in as <admin>
    Then I see the dashboard

  Scenario Outline: Header only
    When I sign in as <role>

    Examples:
      | role |

  Scenario Outline: No Examples at all
    When I sign in as <role>
`);

    expect(change.scenarios).toHaveLength(3);
    change.scenarios.forEach(scenario => expect(scenario).not.toHaveProperty('examples'));
    expect(change.scenarios.map(s => s.steps)).toEqual([
      ['When I sign in as <admin>', 'Then I see the dashboard'],
      ['When I sign in as <role>'],
      ['When I sign in as <role>']
    ]);
  });

  test('the scenario hash ignores the Examples and the {{name}} rewrite, so a case synced by an older CLI keeps its identity', async () => {
    const change = await syncFirstTime(LOGIN_OUTLINE);

    expect(change.scenarios[0].hash).toBe(legacyHash(FEATURE_PATH, LOGIN_STEP_LINES));
  });

  test('changing only an Examples value updates the synced case and sends the new table', async () => {
    await createFeatureFile(tempDir, FEATURE_PATH, LOGIN_OUTLINE);
    const firstCommit = await commitAllChanges(git, 'Add feature');
    await createFeatureFile(tempDir, FEATURE_PATH, LOGIN_OUTLINE.replace('| wrong    |', '| expired  |'));
    const secondCommit = await commitAllChanges(git, 'Change one example');

    const scenarioHash = legacyHash(FEATURE_PATH, LOGIN_STEP_LINES);
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
    expect(change.scenarios).toHaveLength(1);
    const scenario = change.scenarios[0];
    expect([scenario.hash, scenario.prevHash, scenario.caseId]).toEqual([scenarioHash, scenarioHash, 1001]);
    expect(scenario.deleted).toBeUndefined();
    expect(scenario.examples.rows).toEqual([
      ['valid@example.com', 'correct', 'the dashboard'],
      ['valid@example.com', 'expired', 'an error banner']
    ]);
  });

  test('a rename with no content change sends neither steps nor the table', async () => {
    await createFeatureFile(tempDir, FEATURE_PATH, LOGIN_OUTLINE);
    const firstCommit = await commitAllChanges(git, 'Add feature');
    await git.mv(FEATURE_PATH, 'features/auth/sign_in.feature');
    const secondCommit = await commitAllChanges(git, 'Rename feature');

    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(PROJECT_ID, firstCommit))
      .mockResolvedValueOnce(mockResolveIds({}, {}))
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: secondCommit }));
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });

    const change = getFinalSyncPayload().changes[0];
    expect(change.status).toBe('R100');
    change.scenarios.filter(s => !s.deleted).forEach(scenario => {
      expect(scenario).not.toHaveProperty('steps');
      expect(scenario).not.toHaveProperty('examples');
    });
  });
});
