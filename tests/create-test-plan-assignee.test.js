/**
 * Tests for --override-assignees on the createTestPlan command (TCV-6891).
 *
 * A test case can carry a default assignee (TCV-6779), which the API copies onto
 * the plan when the cases are added. These tests drive the whole command against
 * a stubbed fetch and assert the BODY it posts to /testplans/assign, because that
 * body is the only thing that decides whether --assignee-id replaces those
 * default assignees or only covers the cases without one.
 *
 * Asserting the wire body is deliberate: the published SDK's
 * TestPlanAssignmentPayload serializer lists the keys it knows, so it drops
 * override_existing_assignees silently. A test that stubbed the SDK would pass
 * while the flag did nothing.
 */

import fs from 'fs';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { createTestPlan } from '../src/commands/createTestPlan.js';

const API_URL = 'http://api.test';
const TOKEN = 'token-123';
const PROJECT = 45;
const TAG = 2;
const ASSIGNEE = 5011;
const PLAN_ID = 123;
const PLAN_FILE = 'tmp/tc_test_plan';

const baseOptions = {
  apiKey: TOKEN,
  apiUrl: API_URL,
  project: String(PROJECT),
  ciTagId: String(TAG),
  assigneeId: String(ASSIGNEE)
};

/**
 * Stub global fetch with a router keyed on method + path, so the command runs its
 * real request path. Every call is recorded with its parsed body.
 */
function mockApi(overrides = {}) {
  const routes = {
    [`GET /projects/${PROJECT}`]: { id: PROJECT, name: 'Ent St P2' },
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
    ...overrides
  };
  const calls = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const { pathname, search } = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({
      key: `${method} ${pathname}`,
      query: search.replace(/[?&]token=[^&]*/, ''),
      body
    });
    const route = routes[`${method} ${pathname}`];
    if (route === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ message: 'Resource not found' }),
        text: async () => JSON.stringify({ message: 'Resource not found' })
      };
    }
    const value = typeof route === 'function' ? route(body) : route;
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

function assignBody(calls) {
  return calls.find((call) => call.key === 'POST /testplans/assign');
}

beforeEach(() => {
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
  if (fs.existsSync(PLAN_FILE)) fs.unlinkSync(PLAN_FILE);
});

describe('createTestPlan assignment payload', () => {
  test('keeps the test case default assignees when the flag is absent', async () => {
    const calls = mockApi();

    await createTestPlan({ ...baseOptions });

    const assign = assignBody(calls);
    expect(assign).toBeDefined();
    expect(assign.body.override_existing_assignees).toBe(false);
    // The rest of the payload is what the SDK used to serialize - snake_case
    // keys, automatic assignment of every case in the plan to the one user.
    expect(assign.body).toEqual({
      executor: 'team',
      assignment_criteria: 'testCase',
      assignment_method: 'automatic',
      assignment: {
        user: [ASSIGNEE],
        testCases: { testCases: [], selector: [] },
        configuration: null
      },
      project: PROJECT,
      testplan: PLAN_ID,
      override_existing_assignees: false
    });
    expect(assign.query).toBe(`?testplan=${PLAN_ID}&project=${PROJECT}`);
    // The flag belongs to the assignment, not to the plan itself.
    const create = calls.find((call) => call.key === 'POST /testplans');
    expect(create.body.override_existing_assignees).toBeUndefined();
  });

  test('overrides the default assignees when --override-assignees is passed', async () => {
    const calls = mockApi();

    await createTestPlan({ ...baseOptions, overrideAssignees: true });

    expect(assignBody(calls).body.override_existing_assignees).toBe(true);
  });

  test('sends a real boolean, not a string, for either state', async () => {
    let calls = mockApi();
    await createTestPlan({ ...baseOptions, overrideAssignees: true });
    expect(typeof assignBody(calls).body.override_existing_assignees).toBe('boolean');

    calls = mockApi();
    await createTestPlan({ ...baseOptions });
    expect(typeof assignBody(calls).body.override_existing_assignees).toBe('boolean');
  });

  test('creates the plan and records its id even when every case was already assigned', async () => {
    const calls = mockApi({
      'POST /testplans/assign': { status: true, created_id: 0, assignments_preserved: true }
    });

    await createTestPlan({ ...baseOptions });

    expect(assignBody(calls)).toBeDefined();
    expect(fs.readFileSync(PLAN_FILE, 'utf8')).toBe(`TESTCOLLAB_TEST_PLAN_ID=${PLAN_ID}`);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('nothing was reassigned')
    );
  });

  test('fails the pipeline when the assignment call fails', async () => {
    mockApi({ 'POST /testplans/assign': undefined });

    await expect(createTestPlan({ ...baseOptions })).rejects.toThrow('process.exit(1)');
    expect(fs.existsSync(PLAN_FILE)).toBe(false);
  });
});
