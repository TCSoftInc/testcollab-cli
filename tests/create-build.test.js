/**
 * Tests for the createBuild command (TCV-6794).
 *
 * These cover how a pipeline's --version is turned into exactly one build:
 *   - normalizeVersion()      — the trim + leading-`v` rule versions are compared by
 *   - selectBuildsByVersion() — which of the API's candidates are the same version
 *   - createBuild()           — match-first / create-if-missing, the build id written
 *                               to tmp/tc_build, and the failures that stop a pipeline
 */

import fs from 'fs';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
  createBuild,
  normalizeVersion,
  selectBuildsByVersion
} from '../src/commands/createBuild.js';

const API_URL = 'http://api.test';
const TOKEN = 'token-123';
const PROJECT = 45;
const BUILD_FILE = 'tmp/tc_build';

const BUILD_A = { id: 7, version: '2026.8.6-rc1', project: { id: PROJECT } };

const baseOptions = {
  apiKey: TOKEN,
  apiUrl: API_URL,
  project: String(PROJECT),
  version: '2026.8.6-rc1'
};

/**
 * Stub global fetch with a router keyed on the request path + method, so the tests
 * drive the real request/parse path of the command.
 */
function mockApi(routes) {
  const calls = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const { pathname, search } = new URL(url);
    calls.push(`${method} ${pathname}${search.replace(/[?&]token=[^&]*/, '')}`);
    const route = routes[`${method} ${pathname}`];
    if (route === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ message: 'Resource not found' })
      };
    }
    const body =
      typeof route === 'function' ? route(opts.body ? JSON.parse(opts.body) : null) : route;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
  });
  return calls;
}

// process.exit(1) must abort the command the way it does in a real run, so it is
// turned into a throw the test can assert on.
function expectExit() {
  return jest.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
}

function readBuildFile() {
  return fs.existsSync(BUILD_FILE) ? fs.readFileSync(BUILD_FILE, 'utf8') : null;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete global.fetch;
  jest.restoreAllMocks();
  if (fs.existsSync(BUILD_FILE)) fs.unlinkSync(BUILD_FILE);
});

describe('normalizeVersion', () => {
  test('trims and drops a single leading v/V', () => {
    expect(normalizeVersion(' v2.14.0 ')).toBe('2.14.0');
    expect(normalizeVersion('V2.14.0')).toBe('2.14.0');
    expect(normalizeVersion('2.14.0')).toBe('2.14.0');
  });

  test('drops only the first v, so a version that starts with v survives', () => {
    expect(normalizeVersion('vv1.0')).toBe('v1.0');
    expect(normalizeVersion('victory-1.0')).toBe('ictory-1.0');
  });

  test('tolerates a missing version', () => {
    expect(normalizeVersion(undefined)).toBe('');
    expect(normalizeVersion(null)).toBe('');
  });
});

describe('selectBuildsByVersion', () => {
  test('treats v-prefixed and bare versions as the same version', () => {
    const builds = [{ id: 1, version: 'v2.14.0' }];
    expect(selectBuildsByVersion(builds, '2.14.0')).toEqual(builds);
    expect(selectBuildsByVersion([{ id: 1, version: '2.14.0' }], 'v2.14.0')).toHaveLength(1);
  });

  test('does not match a partial version', () => {
    expect(selectBuildsByVersion([BUILD_A], '2026.8.6')).toEqual([]);
  });

  test('does not match on case beyond the leading v', () => {
    expect(selectBuildsByVersion([BUILD_A], '2026.8.6-RC1')).toEqual([]);
  });

  test('returns every build sharing the version, oldest first', () => {
    const dupes = [
      { id: 9, version: '1.0' },
      { id: 4, version: 'v1.0' }
    ];
    expect(selectBuildsByVersion(dupes, '1.0').map((b) => b.id)).toEqual([4, 9]);
  });

  test('tolerates a missing or malformed response', () => {
    expect(selectBuildsByVersion(undefined, '1.0')).toEqual([]);
    expect(selectBuildsByVersion([null, {}], '1.0')).toEqual([]);
  });
});

describe('createBuild', () => {
  test('creates the build when the version is not recorded yet', async () => {
    let posted = null;
    const calls = mockApi({
      [`GET /projects/${PROJECT}`]: { id: PROJECT },
      'GET /builds': [],
      'POST /builds': (body) => {
        posted = body;
        return { id: 31, version: '2026.8.6-rc1' };
      }
    });

    await createBuild({
      ...baseOptions,
      environment: 'staging',
      deploymentUrl: 'https://dev.azure.com/acme/run/900',
      commit: 'abc1234',
      notes: 'nightly'
    });

    expect(posted).toEqual({
      project: PROJECT,
      version: '2026.8.6-rc1',
      environment: 'staging',
      build_url: 'https://dev.azure.com/acme/run/900',
      commit_sha: 'abc1234',
      notes: 'nightly'
    });
    expect(calls).toEqual([
      `GET /projects/${PROJECT}`,
      `GET /builds?project=${PROJECT}&version_contains=2026.8.6-rc1&_limit=-1`,
      'POST /builds'
    ]);
    expect(readBuildFile()).toBe('TESTCOLLAB_BUILD_ID=31');
  });

  test('reuses the existing build instead of recording the version twice', async () => {
    const calls = mockApi({
      [`GET /projects/${PROJECT}`]: { id: PROJECT },
      'GET /builds': [BUILD_A]
    });

    await createBuild(baseOptions);

    // No POST /builds — the version was already recorded.
    expect(calls).toEqual([
      `GET /projects/${PROJECT}`,
      `GET /builds?project=${PROJECT}&version_contains=2026.8.6-rc1&_limit=-1`
    ]);
    expect(readBuildFile()).toBe('TESTCOLLAB_BUILD_ID=7');
  });

  test('matches a build recorded with a leading v (searching on the bare version)', async () => {
    const calls = mockApi({
      [`GET /projects/${PROJECT}`]: { id: PROJECT },
      'GET /builds': [{ id: 12, version: 'v2.14.0' }]
    });

    await createBuild({ ...baseOptions, version: '2.14.0' });

    expect(calls).toContain(
      `GET /builds?project=${PROJECT}&version_contains=2.14.0&_limit=-1`
    );
    expect(readBuildFile()).toBe('TESTCOLLAB_BUILD_ID=12');
  });

  test('ignores candidates the LIKE returns that are a different version', async () => {
    mockApi({
      [`GET /projects/${PROJECT}`]: { id: PROJECT },
      'GET /builds': [{ id: 8, version: '11.4.20' }],
      'POST /builds': { id: 40, version: '1.4.2' }
    });

    await createBuild({ ...baseOptions, version: '1.4.2' });

    expect(readBuildFile()).toBe('TESTCOLLAB_BUILD_ID=40');
  });

  test('uses the oldest build and warns when the version is already recorded twice', async () => {
    mockApi({
      [`GET /projects/${PROJECT}`]: { id: PROJECT },
      'GET /builds': [
        { id: 9, version: '1.0' },
        { id: 4, version: 'v1.0' }
      ]
    });

    await createBuild({ ...baseOptions, version: '1.0' });

    expect(console.warn.mock.calls.join('\n')).toContain('2 builds already record version "1.0"');
    expect(readBuildFile()).toBe('TESTCOLLAB_BUILD_ID=4');
  });

  test('warns rather than overwrites when a value differs on the existing build', async () => {
    mockApi({
      [`GET /projects/${PROJECT}`]: { id: PROJECT },
      'GET /builds': [{ ...BUILD_A, environment: 'staging' }]
    });

    await createBuild({ ...baseOptions, environment: 'production' });

    expect(console.warn.mock.calls.join('\n')).toContain(
      'Build already records environment "staging"'
    );
  });

  test('does not warn when the existing build already carries the same values', async () => {
    mockApi({
      [`GET /projects/${PROJECT}`]: { id: PROJECT },
      'GET /builds': [{ ...BUILD_A, environment: 'staging' }]
    });

    await createBuild({ ...baseOptions, environment: 'staging' });

    expect(console.warn).not.toHaveBeenCalled();
  });

  test('requires a version', async () => {
    const exit = expectExit();
    await expect(createBuild({ ...baseOptions, version: '  ' })).rejects.toThrow(
      'process.exit(1)'
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('requires an API key', async () => {
    const exit = expectExit();
    const previous = process.env.TESTCOLLAB_TOKEN;
    delete process.env.TESTCOLLAB_TOKEN;
    await expect(createBuild({ ...baseOptions, apiKey: undefined })).rejects.toThrow(
      'process.exit(1)'
    );
    expect(exit).toHaveBeenCalledWith(1);
    if (previous !== undefined) process.env.TESTCOLLAB_TOKEN = previous;
  });

  test('stops on an unknown project instead of recording a build', async () => {
    const exit = expectExit();
    const calls = mockApi({});
    await expect(createBuild(baseOptions)).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    expect(calls).toEqual([`GET /projects/${PROJECT}`]);
    expect(readBuildFile()).toBeNull();
  });

  test('leaves no build id behind when the create fails', async () => {
    const exit = expectExit();
    fs.mkdirSync('tmp', { recursive: true });
    fs.writeFileSync(BUILD_FILE, 'TESTCOLLAB_BUILD_ID=999');

    global.fetch = jest.fn(async (url, opts = {}) => {
      const { pathname } = new URL(url);
      if (pathname === `/projects/${PROJECT}`) {
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ id: PROJECT }) };
      }
      if (pathname === '/builds' && (opts.method || 'GET') === 'GET') {
        return { ok: true, status: 200, statusText: 'OK', text: async () => '[]' };
      }
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => JSON.stringify({ message: 'Forbidden' })
      };
    });

    await expect(createBuild(baseOptions)).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    expect(readBuildFile()).toBeNull();
  });
});
