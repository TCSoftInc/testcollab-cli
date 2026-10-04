/**
 * TCV-7071: tc sync sends, for each Examples row of an outline, the index Cucumber writes
 * at the end of the row's name in a JUnit report (#<table>.<row>) and the name of its
 * Examples table. The API stores them in the dataset row, and tc report sets the result of
 * one row by that index.
 *
 * The table number is the position of the block among all the Examples blocks of the outline,
 * a block without a table included (checked against Cucumber JS 12.9.0, @cucumber/query), and
 * the row number is the row in that block. These tests run the real featuresync on the
 * feature files of docs/bdd/ and read the payload it sends.
 */

import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  getFinalSyncPayload,
  resetApiMocks
} from '../utils/api-mocks.js';
import { featuresync } from '../../src/commands/featuresync.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bdd-examples');
const PROJECT_ID = '42';
const API_URL = 'https://api.testcollab.com';

describe('TCV-7071: the Examples index of each dataset row', () => {
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

  async function syncFirstTime(filePath, content) {
    await createFeatureFile(tempDir, filePath, content);
    const headCommit = await commitAllChanges(git, 'Add feature');
    setupInitialSyncMocks(PROJECT_ID, headCommit);
    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });
    return getFinalSyncPayload().changes[0];
  }

  test('docs/bdd/discount.feature: two named tables, then a table with no name', async () => {
    const change = await syncFirstTime('features/discount.feature', fs.readFileSync(path.join(FIXTURES, 'discount.feature'), 'utf8'));

    const [plain, byTotal, coupon] = change.scenarios;
    expect(plain).not.toHaveProperty('examples');
    expect(byTotal.examples).toEqual({
      parameters: ['total', 'discount'],
      rows: [['50', '0'], ['99', '0'], ['100', '10'], ['500', '40']],
      indexes: ['1.1', '1.2', '2.1', '2.2'],
      names: ['Small carts', 'Small carts', 'Large carts', 'Large carts']
    });
    expect([coupon.examples.indexes, coupon.examples.names]).toEqual([['1.1', '1.2'], ['', '']]);
  });

  test('docs/bdd/6-three-tables.feature: #2.1 is the second row of the dataset', async () => {
    const change = await syncFirstTime('features/three_tables.feature', fs.readFileSync(path.join(FIXTURES, '6-three-tables.feature'), 'utf8'));

    expect(change.scenarios[0].examples).toEqual({
      parameters: ['total', 'discount'],
      rows: [['50', '0'], ['100', '10'], ['500', '40'], ['900', '40']],
      indexes: ['1.1', '2.1', '2.2', '3.1'],
      names: ['Small carts', 'Large carts', 'Large carts', 'Huge carts']
    });
  });

  test('a block without a table takes a table number, under a rule too', async () => {
    // Cucumber JS names the rows of this outline "Big orders - Shipping for <weight> kg - Light - #2.1: ..."
    const change = await syncFirstTime('features/shipping.feature', `Feature: Numbering check

  Rule: Big orders

    Scenario Outline: Shipping for <weight> kg
      When the weight is <weight>
      Then shipping is <cost>

      Examples:

      Examples: Light
        | weight | cost |
        | 1      | 5    |
        | 2      | 5    |
`);

    expect(change.scenarios[0].examples).toEqual({
      parameters: ['weight', 'cost'],
      rows: [['1', '5'], ['2', '5']],
      indexes: ['2.1', '2.2'],
      names: ['Light', 'Light']
    });
  });
});
