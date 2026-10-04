/**
 * TCV-7069 — `tc report` prints the link to the plan it reported to, for an
 * existing plan and for the one --auto-create makes, and `--auto-create --public`
 * makes the new plan public and prints its share link.
 *
 * The whole command runs against a stubbed API, so these assert what it prints,
 * the share request it sends, and that sharing happens after the results are in.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { report } from '../src/commands/report.js';

const API_URL = 'https://api.testcollab.io';
const PROJECT = 4;
const COMPANY = 5004;
const PLAN_ID = 88;
const CASE_ID = 21;
const EXECUTION_ID = 1021;
const SHARE_TOKEN = 'aaa.bbb.ccc';
const PLAN_LINK = `https://testcollab.io/project/${PROJECT}/test_plans/${PLAN_ID}/view`;
const PUBLIC_LINK_LINE =
  `🌐 Public link (opens without a TestCollab account): ${PLAN_LINK}?public_token=${SHARE_TOKEN}&region=US`;

const originalCwd = process.cwd();
let workDir;
let calls;
let shareResponse;

function wire(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function stubApi() {
  const testCase = { id: CASE_ID, title: 'Sign in', suite: { id: 10 }, tags: [] };
  global.fetch = jest.fn(async (input, options = {}) => {
    const url = new URL(input);
    const endpoint = url.pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ key: `${method} ${endpoint}`, body });

    switch (`${method} ${endpoint}`) {
      // --auto-create
      case `GET /testcases/${CASE_ID}`: return wire(testCase);
      case `PUT /testcases/${CASE_ID}`: return wire({ ...testCase, tags: body.tags });
      case 'GET /testcases': return wire([testCase]);
      case 'GET /tags': return wire([{ id: 8, name: 'CI Imported' }]);
      case 'GET /suites': return wire([{ id: 10, title: 'Login', parent_id: 0 }]);
      case 'GET /testplanfolders': return wire([{ id: 9, title: 'CI' }]);
      case 'POST /testplans': return wire({ id: PLAN_ID });
      case 'POST /testplantestcases/bulkAdd': return wire({ status: true });
      case 'POST /testplans/assign': return wire({ status: true });
      // the upload
      case 'GET /system': return wire({});
      case 'GET /users/me': return wire({ id: 1, first_name: 'Tester' });
      case `GET /projects/${PROJECT}`: return wire({ id: PROJECT, company: { id: COMPANY } });
      case `GET /testplans/${PLAN_ID}`: return wire({ id: PLAN_ID, project: { id: PROJECT } });
      case 'GET /testplanregressions': return wire([{ id: 1 }]);
      case 'GET /testplanconfigurations': return wire([]);
      case 'GET /executedtestcases':
        return wire([{ id: EXECUTION_ID, test_plan_test_case: { id: 2021, test_case: CASE_ID } }]);
      case `PUT /executedtestcases/${EXECUTION_ID}`: return wire({ id: EXECUTION_ID });
      // --public
      case 'POST /tokens/shareEntityToken': return wire(shareResponse);
      default:
        throw new Error(`Unexpected request ${method} ${endpoint}`);
    }
  });
}

async function run(options) {
  const resultFile = path.join(workDir, 'results.xml');
  fs.writeFileSync(
    resultFile,
    '<testsuite name="LoginTests"><testcase classname="LoginTests" name="[TC-21] Sign in"/></testsuite>'
  );
  await report({
    project: String(PROJECT),
    apiKey: 'test-key',
    apiUrl: API_URL,
    format: 'junit',
    resultFile,
    ...options
  });
}

function printed() {
  return console.log.mock.calls.map((args) => args.join(' '));
}

function keys() {
  return calls.map((call) => call.key);
}

beforeEach(() => {
  // The command writes tmp/tc_test_plan in the working directory, and other test
  // files run commands that write and delete the same file in parallel.
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcv7069-report-'));
  process.chdir(workDir);
  calls = [];
  shareResponse = { status: true, jwt: SHARE_TOKEN, message: 'Success' };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  stubApi();
});

afterEach(() => {
  delete global.fetch;
  jest.restoreAllMocks();
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('report plan link', () => {
  test('prints the link to an existing plan passed with --test-plan-id', async () => {
    await run({ testPlanId: String(PLAN_ID) });

    expect(keys()).toContain(`PUT /executedtestcases/${EXECUTION_ID}`);
    expect(printed()).toContain(`🔗 Test plan: ${PLAN_LINK}`);
    expect(keys()).not.toContain('POST /tokens/shareEntityToken');
  });

  test('prints the link to the plan --auto-create made, and leaves it private', async () => {
    await run({ autoCreate: true });

    expect(keys()).toContain('POST /testplans');
    expect(printed()).toContain(`🔗 Test plan: ${PLAN_LINK}`);
    expect(keys()).not.toContain('POST /tokens/shareEntityToken');
    expect(printed().some((line) => line.includes('public_token'))).toBe(false);
  });
});

describe('report --public', () => {
  test('shares the auto-created plan after the results are in, and prints its public link', async () => {
    await run({ autoCreate: true, public: true });

    const share = calls.find((call) => call.key === 'POST /tokens/shareEntityToken');
    expect(share.body).toEqual({
      entity: 'testplan',
      entityId: PLAN_ID,
      project: PROJECT,
      company: COMPANY
    });
    expect(keys().indexOf('POST /tokens/shareEntityToken')).toBeGreaterThan(
      keys().indexOf(`PUT /executedtestcases/${EXECUTION_ID}`)
    );
    expect(printed()).toContain(`🔗 Test plan: ${PLAN_LINK}`);
    expect(printed()).toContain(PUBLIC_LINK_LINE);
    expect(process.exit).not.toHaveBeenCalled();
  });

  test('requires --auto-create and stops before calling the API', async () => {
    await expect(run({ testPlanId: String(PLAN_ID), public: true })).rejects.toThrow('process.exit(1)');

    expect(console.error).toHaveBeenCalledWith('❌ Error: --public requires --auto-create');
    expect(calls).toEqual([]);
  });

  test('fails the run when the plan cannot be made public, and keeps the results', async () => {
    shareResponse = { status: false, message: 'Company information not matched' };

    await expect(run({ autoCreate: true, public: true })).rejects.toThrow('process.exit(1)');

    expect(keys()).toContain(`PUT /executedtestcases/${EXECUTION_ID}`);
    expect(printed()).toContain(`🔗 Test plan: ${PLAN_LINK}`);
    expect(console.error).toHaveBeenCalledWith(
      `❌ Error: Could not make test plan ${PLAN_ID} public: Company information not matched`
    );
    expect(printed().some((line) => line.includes('public_token'))).toBe(false);
  });
});
