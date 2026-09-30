/**
 * The API token travels in the request URL (`?token=`), and Node's fetch repeats
 * a URL it cannot parse (an --api-url without https://, for example) in its error
 * message. These commands print that error, so the token must be hidden in it.
 *
 * tc sync is covered in scenarios/sync-token-not-printed.test.js.
 */

import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

import { createBuild } from '../src/commands/createBuild.js';
import { gate } from '../src/commands/gate.js';
import { reportSingleCase } from '../src/commands/reportCase.js';

const TOKEN = 'tc-secret-token-8c1f';
const BAD_API_URL = 'api.testcollab.com';

let consoleError;

beforeEach(() => {
  // Node's fetch fails like this for a URL it cannot parse
  global.fetch = jest.fn(async (url) => {
    throw new TypeError(`Failed to parse URL from ${url}`);
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  // process.exit must stop the command the way it does in a real run
  jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  delete global.fetch;
  jest.restoreAllMocks();
});

function printedErrors() {
  return consoleError.mock.calls.map((args) => args.join(' ')).join('\n');
}

test('tc gate prints the failed request with the token hidden', async () => {
  // The values commander supplies when the gate options are left out
  const options = { failOn: 'failed', maxFailed: '0', wait: '0', pollInterval: '15' };

  await expect(
    gate({ ...options, apiKey: TOKEN, apiUrl: BAD_API_URL, project: '42', testPlanId: '7' })
  ).rejects.toThrow('process.exit(2)');

  expect(printedErrors()).toContain(`Failed to parse URL from ${BAD_API_URL}/testplans/7?token=***`);
  expect(printedErrors()).not.toContain(TOKEN);
});

test('tc reportCase fails with the token hidden', async () => {
  const error = await reportSingleCase({
    apiKey: TOKEN,
    apiUrl: BAD_API_URL,
    project: '42',
    testPlanRunId: '7',
    executedTestCaseId: '9',
    status: 'passed'
  }).catch((thrown) => thrown);

  expect(error.message).toContain(
    `Failed to parse URL from ${BAD_API_URL}/executedtestcases?project=42&regression=7&id=9&_limit=1&token=***`
  );
  expect(error.message).not.toContain(TOKEN);
});

test('tc createBuild prints the failed request with the token hidden', async () => {
  await expect(
    createBuild({ apiKey: TOKEN, apiUrl: BAD_API_URL, project: '42', version: '1.0.0' })
  ).rejects.toThrow('process.exit(1)');

  expect(printedErrors()).toContain(`Failed to parse URL from ${BAD_API_URL}/projects/42?token=***`);
  expect(printedErrors()).not.toContain(TOKEN);
});
