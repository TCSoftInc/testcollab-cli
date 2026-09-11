/**
 * api-url.test.js
 *
 * Verifies the --api-url resolution order applied by every CLI command:
 * 1. explicit --api-url flag
 * 2. TESTCOLLAB_API_URL environment variable
 * 3. https://api.testcollab.io (US production)
 *
 * Agent containers always set TESTCOLLAB_API_URL to the API that owns the
 * run, so the env fallback keeps run tokens in the right region even when
 * the caller omits --api-url.
 */

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultApiUrl } from '../src/apiUrl.js';

describe('defaultApiUrl resolution', () => {
  const originalEnv = process.env.TESTCOLLAB_API_URL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TESTCOLLAB_API_URL;
    } else {
      process.env.TESTCOLLAB_API_URL = originalEnv;
    }
  });

  test('returns TESTCOLLAB_API_URL when the environment variable is set', () => {
    process.env.TESTCOLLAB_API_URL = 'https://api-eu.testcollab.io';
    expect(defaultApiUrl()).toBe('https://api-eu.testcollab.io');
  });

  test('falls back to production US when the environment variable is unset', () => {
    delete process.env.TESTCOLLAB_API_URL;
    expect(defaultApiUrl()).toBe('https://api.testcollab.io');
  });

  test('falls back to production US when the environment variable is empty', () => {
    process.env.TESTCOLLAB_API_URL = '';
    expect(defaultApiUrl()).toBe('https://api.testcollab.io');
  });
});

describe('CLI precedence: --api-url flag over TESTCOLLAB_API_URL', () => {
  async function withServer(callback) {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      await callback(url, requests);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function runCli(args, extraEnv = {}) {
    const child = spawn(process.execPath, ['src/index.js', ...args], {
      cwd: path.resolve('.'),
      env: { TESTCOLLAB_TOKEN: 'run-token', ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode));
    });
  }

  test('the TESTCOLLAB_API_URL env var supplies the default for commands', () =>
    withServer(async (url, requests) => {
      await runCli(
        ['getTestPlan', '--project', '1', '--test-plan-id', '1'],
        { TESTCOLLAB_API_URL: url }
      );
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0]).toMatch(/^GET \/testplans\//);
    }));

  test('an explicit --api-url flag overrides TESTCOLLAB_API_URL', () =>
    withServer(async (url, requests) => {
      await runCli(
        ['getTestPlan', '--project', '1', '--test-plan-id', '1', '--api-url', url],
        { TESTCOLLAB_API_URL: 'http://127.0.0.1:1/unused' }
      );
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0]).toMatch(/^GET \/testplans\//);
    }));
});
