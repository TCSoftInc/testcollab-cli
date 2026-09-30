/**
 * tc sync never prints the API token.
 *
 * The token travels in the request URL (`?token=`). The sync printed the URL of
 * its first request, and Node's fetch repeats a URL it cannot parse in its error
 * message, so the token reached the terminal and the CI log. These tests run the
 * real featuresync and read everything it prints.
 */

import { format } from 'util';
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
  mockExistingSyncState,
  mockResolveIds,
  mockSuccessfulSync,
  mockFetch,
  resetApiMocks
} from '../utils/api-mocks.js';
import { featuresync } from '../../src/commands/featuresync.js';

const PROJECT_ID = '42';
const API_URL = 'https://api.testcollab.com';
const TOKEN = 'tc-secret-token-8c1f';

const LOGIN_FEATURE = `Feature: Login

  Scenario: Sign in
    When I sign in
    Then I see the dashboard
`;

// Everything the command prints, through the console or straight to stdout/stderr
function capturePrinted() {
  const printed = [];
  ['log', 'info', 'warn', 'error', 'debug'].forEach(method => {
    jest.spyOn(console, method).mockImplementation((...args) => {
      printed.push(format(...args));
    });
  });
  [process.stdout, process.stderr].forEach(stream => {
    jest.spyOn(stream, 'write').mockImplementation(chunk => {
      printed.push(String(chunk));
      return true;
    });
  });
  return () => printed.join('\n');
}

describe('tc sync never prints the API token', () => {
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
    process.env.TESTCOLLAB_TOKEN = TOKEN;
    process.chdir(tempDir);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    await cleanupTempDir(tempDir);
    resetApiMocks();
    if (originalEnv) {
      process.env.TESTCOLLAB_TOKEN = originalEnv;
    } else {
      delete process.env.TESTCOLLAB_TOKEN;
    }
  });

  test('a sync run sends the token but prints nothing that contains it', async () => {
    await createFeatureFile(tempDir, 'features/login.feature', LOGIN_FEATURE);
    const lastSyncedCommit = await commitAllChanges(git, 'Add feature');
    await createFeatureFile(tempDir, 'features/login.feature', `${LOGIN_FEATURE}
  Scenario: Sign out
    When I sign out
    Then I see the sign-in page
`);
    const headCommit = await commitAllChanges(git, 'Add a scenario');
    // All three requests: the sync state, resolve-ids for the changed file, and the sync
    mockFetch
      .mockResolvedValueOnce(mockExistingSyncState(PROJECT_ID, lastSyncedCommit))
      .mockResolvedValueOnce(mockResolveIds())
      .mockResolvedValueOnce(mockSuccessfulSync({ storedCommit: headCommit, createdCases: 1 }));
    const printed = capturePrinted();

    await featuresync({ project: PROJECT_ID, apiUrl: API_URL });

    // The transport is unchanged: the token is still in each request URL
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      `${API_URL}/bdd/sync?project=${PROJECT_ID}&token=${TOKEN}`,
      `${API_URL}/bdd/resolve-ids?token=${TOKEN}`,
      `${API_URL}/bdd/sync?token=${TOKEN}`
    ]);
    expect(printed()).toContain('🔍 Fetching sync state from TestCollab...');
    expect(printed()).toContain('✅ Synchronization completed successfully');
    expect(printed()).not.toContain(TOKEN);
  });

  test('an --api-url without https:// fails with the token hidden in the error', async () => {
    await createFeatureFile(tempDir, 'features/login.feature', LOGIN_FEATURE);
    await commitAllChanges(git, 'Add feature');
    // Node's fetch fails like this for a URL it cannot parse
    mockFetch.mockImplementationOnce(async url => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    });
    jest.spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`process.exit(${code})`);
    });
    const printed = capturePrinted();

    await expect(featuresync({ project: PROJECT_ID, apiUrl: 'api.testcollab.com' })).rejects.toThrow(
      'process.exit(1)'
    );

    expect(printed()).toContain(
      `❌ Error: Failed to connect to TestCollab API: Failed to parse URL from api.testcollab.com/bdd/sync?project=${PROJECT_ID}&token=***`
    );
    expect(printed()).not.toContain(TOKEN);
  });
});
