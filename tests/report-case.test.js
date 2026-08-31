/**
 * Tests for immediate, single-case result reporting.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { reportSingleCase } from '../src/commands/reportCase.js';

const API_URL = 'http://api.test';
const TOKEN = 'agent-run-token';
const PROJECT = 27;
const RUN = 44;
const EXECUTION = 17922;

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(body)
  };
}

function mockApi(handler) {
  const calls = [];
  global.fetch = jest.fn(async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    parsed.searchParams.delete('token');
    const call = {
      method,
      path: parsed.pathname + parsed.search,
      body:
        options.body && typeof options.body === 'string'
          ? JSON.parse(options.body)
          : options.body
    };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

const execution = {
  id: EXECUTION,
  project: PROJECT,
  regression: RUN,
  test_plan: 252,
  test_plan_test_case: { id: 901, test_case: 123 },
  test_plan_config: { id: 8 },
  assigned_to: 77,
  status: 'unexecuted'
};

const options = {
  apiKey: TOKEN,
  apiUrl: API_URL,
  project: String(PROJECT),
  testPlanRunId: String(RUN),
  executedTestCaseId: String(EXECUTION),
  status: 'needs_review'
};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete global.fetch;
  jest.restoreAllMocks();
});

test('uses the existing executed-test-case update and never sends a reporter id', async () => {
  let updateBody = null;
  const calls = mockApi((call) => {
    if (call.method === 'GET' && call.path.startsWith('/executedtestcases?')) {
      return response([execution]);
    }
    if (call.method === 'PUT' && call.path === `/executedtestcases/${EXECUTION}`) {
      updateBody = call.body;
      return response({ ...execution, status: call.body.status });
    }
    return response({ message: 'not found' }, 404);
  });

  const result = await reportSingleCase({ ...options, comment: 'ready & waiting' });

  expect(result.status).toBe('needs_review');
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    `GET /executedtestcases?project=${PROJECT}&regression=${RUN}&id=${EXECUTION}&_limit=1`,
    `PUT /executedtestcases/${EXECUTION}`
  ]);
  expect(updateBody).toEqual({
    id: EXECUTION,
    test_plan_test_case: 901,
    project: PROJECT,
    status: 'needs_review',
    test_plan: 252,
    test_plan_config: 8,
    comment: 'ready%20%26%20waiting'
  });
  expect(updateBody.executed_by).toBeUndefined();
  expect(updateBody.reporter_id).toBeUndefined();
  expect(updateBody.execution_source).toBeUndefined();
});

test('refuses an execution that is not in the exact run', async () => {
  const calls = mockApi((call) => {
    if (call.method === 'GET') return response([]);
    return response({ id: EXECUTION });
  });

  await expect(reportSingleCase(options)).rejects.toThrow(
    `Executed test case ${EXECUTION} was not found in test plan run ${RUN}`
  );
  expect(calls).toHaveLength(1);
});

test('reports time and attaches an explicitly requested file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-report-case-'));
  const attachment = path.join(tempDir, 'evidence.txt');
  fs.writeFileSync(attachment, 'observed evidence');
  const calls = mockApi((call) => {
    if (call.method === 'GET' && call.path.startsWith('/executedtestcases?')) {
      return response([execution]);
    }
    if (call.method === 'PUT' && call.path === `/executedtestcases/${EXECUTION}`) {
      return response({ ...execution, status: 'passed' });
    }
    if (call.method === 'PUT' && call.path.endsWith('/updateTimeTaken')) {
      return response({ message: 'Time updated successfully' });
    }
    if (call.method === 'GET' && call.path === `/projects/${PROJECT}`) {
      return response({ id: PROJECT, company: { id: 5 } });
    }
    if (call.method === 'POST' && call.path === '/upload') {
      return response([{ id: 700 }]);
    }
    if (call.method === 'PUT' && call.path.endsWith('/updateAttachments')) {
      expect(call.body).toEqual({ attachments: [700], project: PROJECT });
      return response({ id: EXECUTION, attachments: [{ id: 700 }] });
    }
    return response({ message: 'not found' }, 404);
  });

  try {
    const result = await reportSingleCase({
      ...options,
      status: 'passed',
      timeTaken: '12.5',
      attachment: [attachment]
    });
    expect(result.attachmentsUploaded).toBe(1);
    expect(
      calls.find((call) => call.path.endsWith('/updateTimeTaken')).body
    ).toEqual({ time_taken: 12.5, project: PROJECT });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
