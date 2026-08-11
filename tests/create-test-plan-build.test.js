/**
 * Tests for the --build / --release options on the createTestPlan command (TCV-6788).
 *
 * These cover how a --build value is resolved to a build of the project:
 *   - selectBuildsByVersion() — the exact-version match applied to the API response
 *   - resolveBuild()          — id lookup, version lookup, and the failure messages
 *                               that stop a pipeline before an unlinked plan exists
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { selectBuildsByVersion, resolveBuild } from '../src/commands/createTestPlan.js';

const API_URL = 'http://api.test';
const TOKEN = 'token-123';
const PROJECT = 45;

const BUILD_A = { id: 7, version: '2026.8.6-rc1', project: { id: PROJECT } };
const BUILD_NUMERIC = { id: 9, version: '1234', project: { id: PROJECT } };

/**
 * Stub global fetch with a router keyed on the request path, so the tests drive
 * the real request/parse path of the command.
 */
function mockApi(routes) {
  const calls = [];
  global.fetch = jest.fn(async (url) => {
    const { pathname, search } = new URL(url);
    calls.push(`${pathname}${search.replace(/[?&]token=[^&]*/, '')}`);
    const route = routes[pathname];
    if (!route) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => JSON.stringify({ message: 'Resource not found' })
      };
    }
    const body = typeof route === 'function' ? route(search) : route;
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
  });
  return calls;
}

afterEach(() => {
  delete global.fetch;
});

describe('selectBuildsByVersion', () => {
  test('matches the version exactly', () => {
    expect(selectBuildsByVersion([BUILD_A, BUILD_NUMERIC], '1234')).toEqual([BUILD_NUMERIC]);
  });

  test('ignores surrounding whitespace and case', () => {
    expect(selectBuildsByVersion([BUILD_A], ' 2026.8.6-RC1 ')).toEqual([BUILD_A]);
  });

  test('does not match a partial version', () => {
    expect(selectBuildsByVersion([BUILD_A], '2026.8.6')).toEqual([]);
  });

  test('returns every build sharing the version', () => {
    const dupes = [
      { id: 3, version: 'dupe-1.0' },
      { id: 4, version: 'dupe-1.0' }
    ];
    expect(selectBuildsByVersion(dupes, 'dupe-1.0')).toHaveLength(2);
  });

  test('tolerates a missing or malformed response', () => {
    expect(selectBuildsByVersion(undefined, '1.0')).toEqual([]);
    expect(selectBuildsByVersion([null, {}], '1.0')).toEqual([]);
  });
});

describe('resolveBuild', () => {
  test('resolves a numeric value as a build id', async () => {
    const calls = mockApi({ '/builds/7': BUILD_A });
    await expect(resolveBuild(API_URL, TOKEN, PROJECT, '7')).resolves.toEqual(BUILD_A);
    expect(calls).toEqual(['/builds/7']);
  });

  test('falls back to a version lookup when no build has that id', async () => {
    const calls = mockApi({ '/builds': [BUILD_NUMERIC] });
    await expect(resolveBuild(API_URL, TOKEN, PROJECT, '1234')).resolves.toEqual(BUILD_NUMERIC);
    expect(calls).toEqual(['/builds/1234', `/builds?project=${PROJECT}&version=1234`]);
  });

  test('falls back to a version lookup when the id belongs to another project', async () => {
    mockApi({
      '/builds/7': { ...BUILD_A, project: { id: 99 } },
      '/builds': []
    });
    await expect(resolveBuild(API_URL, TOKEN, PROJECT, '7')).rejects.toThrow(
      `No build with id or version "7" found in project ${PROJECT}`
    );
  });

  test('resolves a version string', async () => {
    const calls = mockApi({ '/builds': [BUILD_A] });
    await expect(resolveBuild(API_URL, TOKEN, PROJECT, '2026.8.6-rc1')).resolves.toEqual(BUILD_A);
    expect(calls).toEqual([`/builds?project=${PROJECT}&version=2026.8.6-rc1`]);
  });

  test('fails with a clear message when the version has no build', async () => {
    mockApi({ '/builds': [] });
    await expect(resolveBuild(API_URL, TOKEN, PROJECT, '9.9.9')).rejects.toThrow(
      `No build with version "9.9.9" found in project ${PROJECT}. Create the build in TestCollab first, then re-run.`
    );
  });

  test('fails when several builds share the version', async () => {
    mockApi({
      '/builds': [
        { id: 3, version: 'dupe-1.0' },
        { id: 4, version: 'dupe-1.0' }
      ]
    });
    await expect(resolveBuild(API_URL, TOKEN, PROJECT, 'dupe-1.0')).rejects.toThrow(
      '2 builds in project 45 have version "dupe-1.0" (ids: 3, 4). Pass --build <id> to pick one.'
    );
  });

  test('ignores builds the API returns that do not match the version', async () => {
    mockApi({ '/builds': [BUILD_A, BUILD_NUMERIC] });
    await expect(resolveBuild(API_URL, TOKEN, PROJECT, '2026.8.6-rc1')).resolves.toEqual(BUILD_A);
  });

  test('surfaces a non-404 error instead of retrying as a version', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => JSON.stringify({ message: 'Forbidden' })
    }));
    await expect(resolveBuild(API_URL, TOKEN, PROJECT, '7')).rejects.toThrow('Forbidden');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
