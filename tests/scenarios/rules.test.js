/**
 * TCV-6912: scenarios written under a Rule: heading reach TestCollab.
 *
 * `tc sync` used to read only the scenarios placed directly under the feature, so a
 * feature organised in rules synced as an empty suite. These tests run the real
 * featuresync (real git, real Gherkin parse) and read the payload it sends.
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
const FEATURE_PATH = 'features/refunds.feature';

// The example from the ticket.
const TICKET_EXAMPLE = `Feature: Refunds
  Customers can return an item for a refund.

  Background:
    Given I am logged in as a customer

  Rule: A refund is only possible within 30 days of purchase

    Background:
      Given the store has a 30 day return policy

    Example: Return inside the window
      Given I bought a jacket 10 days ago
      When I request a refund
      Then the refund is approved

    Example: Return outside the window
      Given I bought a jacket 45 days ago
      When I request a refund
      Then the refund is rejected

  Rule: The item must be unused

    Example: Worn item
      Given I bought a jacket 5 days ago
      And I have worn it
      When I request a refund
      Then the refund is rejected
`;

const POLICY_RULE = {
  title: 'A refund is only possible within 30 days of purchase',
  backgroundText: ['Given the store has a 30 day return policy']
};

// A rule first, with no feature background: the text older CLIs read on into the rule.
const RULE_FIRST = `@billing
Feature: Refunds
  Customers can return an item.

  @policy
  Rule: A refund is only possible within 30 days
    Refunds after 30 days need a manager.

    Background:
      Given the store has a 30 day return policy

    @smoke
    Example: Return inside the window
      Given I bought a jacket 10 days ago
      Then the refund is approved
`;

function sha1(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

// The scenario hash every CLI computes: the path and the scenario's own step lines.
function scenarioHash(filePath, stepLines) {
  return sha1(`${filePath}:${stepLines.join('\n')}`);
}

describe('TCV-6912: scenarios under a Rule: heading', () => {
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

  // Commits `before`, then `after`, and syncs the second commit as a modification.
  // `resolved` answers resolve-ids with { suites, cases } keyed by the hashes it is asked for.
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

  test('the ticket example: every example becomes a case of the feature, with no suite for a rule', async () => {
    const change = await syncFirstTime(TICKET_EXAMPLE);

    expect(change.feature).toEqual({
      hash: expect.any(String),
      title: 'Refunds',
      description: 'Customers can return an item for a refund.',
      background: ['Given I am logged in as a customer'],
      backgroundText: ['Given I am logged in as a customer']
    });
    expect(change.scenarios).toEqual([
      {
        hash: scenarioHash(FEATURE_PATH, ['Given I bought a jacket 10 days ago', 'When I request a refund', 'Then the refund is approved']),
        title: 'Return inside the window',
        rule: POLICY_RULE,
        steps: [
          'Given the store has a 30 day return policy',
          'Given I bought a jacket 10 days ago',
          'When I request a refund',
          'Then the refund is approved'
        ]
      },
      {
        hash: scenarioHash(FEATURE_PATH, ['Given I bought a jacket 45 days ago', 'When I request a refund', 'Then the refund is rejected']),
        title: 'Return outside the window',
        rule: POLICY_RULE,
        steps: [
          'Given the store has a 30 day return policy',
          'Given I bought a jacket 45 days ago',
          'When I request a refund',
          'Then the refund is rejected'
        ]
      },
      {
        hash: scenarioHash(FEATURE_PATH, ['Given I bought a jacket 5 days ago', 'And I have worn it', 'When I request a refund', 'Then the refund is rejected']),
        title: 'Worn item',
        rule: { title: 'The item must be unused' },
        steps: [
          'Given I bought a jacket 5 days ago',
          'And I have worn it',
          'When I request a refund',
          'Then the refund is rejected'
        ]
      }
    ]);
  });

  test('the rule stays out of the feature description and the feature background text', async () => {
    const change = await syncFirstTime(RULE_FIRST);

    expect(change.feature.description).toBe('Customers can return an item.');
    expect(change.feature.background).toBeUndefined();
    expect(change.feature.backgroundText).toBeUndefined();
    expect(change.scenarios).toHaveLength(1);
    expect(change.scenarios[0].rule).toEqual({
      title: 'A refund is only possible within 30 days',
      backgroundText: ['Given the store has a 30 day return policy']
    });
  });

  test('rule tags go ahead of the scenario tags, as Cucumber inherits them', async () => {
    const change = await syncFirstTime(`Feature: Tags

  @policy @finance
  Rule: Tagged rule

    @smoke
    Scenario: Tagged scenario
      Given a step

    Scenario: Untagged scenario
      Given another step
`);

    expect(change.scenarios.map(s => s.tags)).toEqual([['policy', 'finance', 'smoke'], ['policy', 'finance']]);
  });

  test('a rule background table is kept with the step, like a feature background table', async () => {
    const change = await syncFirstTime(`Feature: Roles

  Rule: Admins manage users

    Background:
      Given the roles exist:
        | role  |
        | admin |

    Example: Add a user
      When I add a user
`);

    expect(change.scenarios[0].steps).toEqual([
      'Given the roles exist:<table class="bdd-data-table"><tbody><tr><td>role</td></tr><tr><td>admin</td></tr></tbody></table>',
      'When I add a user'
    ]);
    // The description text is read like the feature background text: the lines of the block
    expect(change.scenarios[0].rule.backgroundText).toEqual(['Given the roles exist:', '| role  |', '| admin |']);
  });

  test('a Scenario Outline under a rule is read like one at the top of the feature (TCV-6057)', async () => {
    const outline = `    Scenario Outline: Return after <days> days
      Given I bought a jacket <days> days ago
      Then the refund is <result>

      Examples:
        | days | result   |
        | 40   | rejected |
`;
    const topLevel = await syncFirstTime(`Feature: Outlines\n\n${outline}`, 'features/top.feature');
    setupApiMocks();
    const underRule = await syncFirstTime(`Feature: Outlines\n\n  Rule: Plain rule\n\n${outline}`, 'features/rule.feature');

    const { rule, hash, ...ruleScenario } = underRule.scenarios[0];
    const { hash: topHash, ...topScenario } = topLevel.scenarios[0];
    expect(rule).toEqual({ title: 'Plain rule' });
    expect(ruleScenario).toEqual(topScenario);
    expect(ruleScenario.examples).toEqual({ parameters: ['days', 'result'], rows: [['40', 'rejected']] });
    expect(ruleScenario.steps).toEqual(['Given I bought a jacket {{days}} days ago', 'Then the refund is {{result}}']);
    expect(topLevel.scenarios[0].rule).toBeUndefined();
  });

  test('a rule background is not rewritten for an outline, like the feature background', async () => {
    const change = await syncFirstTime(`Feature: Outlines

  Rule: Rule with a background

    Background:
      Given the <days> day policy text is literal

    Scenario Outline: Return after <days> days
      Given I bought a jacket <days> days ago

      Examples:
        | days |
        | 40   |
`);

    expect(change.scenarios[0].steps).toEqual([
      'Given the <days> day policy text is literal',
      'Given I bought a jacket {{days}} days ago'
    ]);
  });

  test('the feature hash is the one an older CLI stored, so an empty suite it created gets its scenarios', async () => {
    const edited = TICKET_EXAMPLE.replace('45 days ago', '60 days ago');
    // What every CLI before TCV-6912 hashed for this file: description, background, and
    // no scenario, because it saw none.
    const storedHash = sha1(`${FEATURE_PATH}:Customers can return an item for a refund.\nGiven I am logged in as a customer`);

    const { resolveRequest, change } = await syncModification(TICKET_EXAMPLE, edited, {
      suites: { [storedHash]: { suiteId: 101 } },
      cases: {}
    });

    expect(resolveRequest.features).toEqual([storedHash]);
    expect(change.status).toBe('M');
    expect(change.feature.prevHash).toBe(storedHash);
    expect(change.feature.suiteId).toBe(101);
    expect(change.scenarios.map(s => s.title)).toEqual(['Return inside the window', 'Return outside the window', 'Worn item']);
    // None has a case yet, so the server creates all three under suite 101
    change.scenarios.forEach(s => {
      expect(s.caseId).toBeUndefined();
      expect(s.deleted).toBeUndefined();
    });
  });

  test('a rule written before any feature background keeps the stored feature hash too', async () => {
    // Older CLIs read the rule into the feature description, and hashed that
    const legacyDescription = 'Customers can return an item.\n@policy\nRule: A refund is only possible within 30 days\nRefunds after 30 days need a manager.';
    const change = await syncFirstTime(RULE_FIRST);

    expect(change.feature.hash).toBe(sha1(`${FEATURE_PATH}:${legacyDescription}\n`));
  });

  test('a scenario moved to another rule keeps its hash, so its case is updated', async () => {
    const moved = TICKET_EXAMPLE
      .replace(`
    Example: Worn item
      Given I bought a jacket 5 days ago
      And I have worn it
      When I request a refund
      Then the refund is rejected
`, '')
      .replace(`
    Example: Return outside the window`, `
    Example: Worn item
      Given I bought a jacket 5 days ago
      And I have worn it
      When I request a refund
      Then the refund is rejected

    Example: Return outside the window`);
    const wornHash = scenarioHash(FEATURE_PATH, ['Given I bought a jacket 5 days ago', 'And I have worn it', 'When I request a refund', 'Then the refund is rejected']);

    const { change } = await syncModification(TICKET_EXAMPLE, moved, { suites: {}, cases: { [wornHash]: { caseId: 1003 } } });

    const worn = change.scenarios.find(s => s.title === 'Worn item');
    expect(worn.hash).toBe(wornHash);
    expect(worn.prevHash).toBe(wornHash);
    expect(worn.caseId).toBe(1003);
    expect(worn.rule).toEqual(POLICY_RULE);
    expect(worn.steps[0]).toBe('Given the store has a 30 day return policy');
    expect(change.scenarios.filter(s => s.deleted)).toEqual([]);
  });

  test('the same title under two rules: an edited scenario keeps its own case', async () => {
    const before = `Feature: Permissions

  Rule: Only admins delete users

    Example: Admin
      Given I am an admin
      When I delete a user
      Then the user is deleted

  Rule: Only admins edit users

    Example: Admin
      Given I am an admin
      When I edit a user
      Then the user is saved
`;
    const after = before.replace('Then the user is deleted', 'Then the user is deleted for good');
    const deleteHash = scenarioHash(FEATURE_PATH, ['Given I am an admin', 'When I delete a user', 'Then the user is deleted']);
    const editHash = scenarioHash(FEATURE_PATH, ['Given I am an admin', 'When I edit a user', 'Then the user is saved']);

    const { change } = await syncModification(before, after, {
      suites: {},
      cases: { [deleteHash]: { caseId: 1001 }, [editHash]: { caseId: 1002 } }
    });

    expect(change.scenarios.map(s => [s.rule && s.rule.title, s.prevHash, s.caseId, s.deleted])).toEqual([
      ['Only admins delete users', deleteHash, 1001, undefined],
      ['Only admins edit users', editHash, 1002, undefined]
    ]);
  });

  test('a scenario moved to another rule and edited in one commit keeps its case when its title is unique', async () => {
    const before = `Feature: Moves

  Rule: First rule

    Example: Travelling scenario
      Given a step

  Rule: Second rule

    Example: Staying scenario
      Given another step
`;
    const after = `Feature: Moves

  Rule: First rule

  Rule: Second rule

    Example: Staying scenario
      Given another step

    Example: Travelling scenario
      Given a changed step
`;
    const travellingHash = scenarioHash(FEATURE_PATH, ['Given a step']);

    const { change } = await syncModification(before, after, { suites: {}, cases: { [travellingHash]: { caseId: 1001 } } });

    const travelling = change.scenarios.find(s => s.title === 'Travelling scenario');
    expect(travelling.rule).toEqual({ title: 'Second rule' });
    expect(travelling.prevHash).toBe(travellingHash);
    expect(travelling.caseId).toBe(1001);
    expect(change.scenarios.filter(s => s.deleted)).toEqual([]);
  });
});
