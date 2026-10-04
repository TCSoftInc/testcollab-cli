/**
 * TCV-7069 — `tc createTestPlan` prints the link to the plan it created, and
 * `--public` makes that plan public and prints its share link.
 *
 * The whole command runs against a stubbed fetch, so these assert what the
 * command prints and the request it sends to share the plan.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createTestPlan } from '../src/commands/createTestPlan.js';

const API_URL = 'https://api.testcollab.io';
const TOKEN = 'token-123';
const PROJECT = 45;
const COMPANY = 5004;
const TAG = 2;
const ASSIGNEE = 5011;
const PLAN_ID = 123;
const SHARE_TOKEN = 'aaa.bbb.ccc';
const PLAN_FILE = 'tmp/tc_test_plan';
const PLAN_LINK = `https://testcollab.io/project/${PROJECT}/test_plans/${PLAN_ID}/view`;

const originalCwd = process.cwd();
let workDir;

const baseOptions = {
  apiKey: TOKEN,
  apiUrl: API_URL,
  project: String(PROJECT),
  ciTagId: String(TAG),
  assigneeId: String(ASSIGNEE)
};

/**
 * Stub global fetch with a router keyed on method + path. Every call is recorded
 * with its parsed body.
 */
function mockApi(overrides = {}) {
  const routes = {
    [`GET /projects/${PROJECT}`]: { id: PROJECT, name: 'Ent St P2', company: { id: COMPANY } },
    'GET /tags': [{ id: TAG, name: 'ci' }],
    'GET /projectusers': [
      {
        id: 1,
        project: { id: PROJECT },
        user: { id: ASSIGNEE, email: 'ci@testcollab.io' },
        role: { id: 1, name: 'Manager' }
      }
    ],
    'POST /testplans': { id: PLAN_ID },
    'POST /testplantestcases/bulkAdd': { status: true, created_id: 1 },
    'POST /testplans/assign': { status: true, created_id: 1 },
    'POST /tokens/shareEntityToken': { status: true, jwt: SHARE_TOKEN, message: 'Success' },
    ...overrides
  };
  const calls = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const { pathname } = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ key: `${method} ${pathname}`, body });
    const value = routes[`${method} ${pathname}`];
    if (value === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ message: 'Resource not found' }),
        text: async () => JSON.stringify({ message: 'Resource not found' })
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => value,
      text: async () => JSON.stringify(value)
    };
  });
  return calls;
}

function printed() {
  return console.log.mock.calls.map((args) => args.join(' '));
}

function shareCalls(calls) {
  return calls.filter((call) => call.key === 'POST /tokens/shareEntityToken');
}

beforeEach(() => {
  // The command writes tmp/tc_test_plan in the working directory, and other test
  // files run commands that write and delete the same file in parallel.
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcv7069-plan-'));
  process.chdir(workDir);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  // process.exit(1) must abort the command the way it does in a real run.
  jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  delete global.fetch;
  jest.restoreAllMocks();
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('createTestPlan plan link', () => {
  test('prints the link to the new plan and leaves the plan private', async () => {
    const calls = mockApi();

    await createTestPlan({ ...baseOptions });

    expect(printed()).toContain(`🔗 Test plan: ${PLAN_LINK}`);
    expect(shareCalls(calls)).toHaveLength(0);
    expect(printed().some((line) => line.includes('public_token'))).toBe(false);
  });

  test('links to the app that serves the EU API', async () => {
    mockApi();

    await createTestPlan({ ...baseOptions, apiUrl: 'https://api-eu.testcollab.io' });

    expect(printed()).toContain(`🔗 Test plan: ${PLAN_LINK}`);
  });
});

describe('createTestPlan --public', () => {
  test('shares the new plan and prints its public link', async () => {
    const calls = mockApi();

    await createTestPlan({ ...baseOptions, public: true });

    const shares = shareCalls(calls);
    expect(shares).toHaveLength(1);
    expect(shares[0].body).toEqual({
      entity: 'testplan',
      entityId: PLAN_ID,
      project: PROJECT,
      company: COMPANY
    });
    // The plan is shared only once it is complete.
    const keys = calls.map((call) => call.key);
    expect(keys.indexOf('POST /tokens/shareEntityToken')).toBeGreaterThan(
      keys.indexOf('POST /testplans/assign')
    );
    expect(printed()).toContain(`🔗 Test plan: ${PLAN_LINK}`);
    expect(printed()).toContain(
      `🌐 Public link (opens without a TestCollab account): ${PLAN_LINK}?public_token=${SHARE_TOKEN}&region=US`
    );
  });

  test('marks an EU public link with the EU region', async () => {
    mockApi();

    await createTestPlan({ ...baseOptions, apiUrl: 'https://api-eu.testcollab.io', public: true });

    expect(printed()).toContain(
      `🌐 Public link (opens without a TestCollab account): ${PLAN_LINK}?public_token=${SHARE_TOKEN}&region=EU`
    );
  });

  test('fails the pipeline when the plan cannot be made public, after the plan is complete', async () => {
    mockApi({
      'POST /tokens/shareEntityToken': { status: false, message: 'Company information not matched' }
    });

    await expect(createTestPlan({ ...baseOptions, public: true })).rejects.toThrow('process.exit(1)');

    expect(console.error).toHaveBeenCalledWith(
      `❌ Error: Could not make test plan ${PLAN_ID} public: Company information not matched`
    );
    // The private plan is complete and still reachable.
    expect(fs.readFileSync(PLAN_FILE, 'utf8')).toBe(`TESTCOLLAB_TEST_PLAN_ID=${PLAN_ID}`);
    expect(printed()).toContain(`🔗 Test plan: ${PLAN_LINK}`);
    expect(printed().some((line) => line.includes('public_token'))).toBe(false);
  });
});
