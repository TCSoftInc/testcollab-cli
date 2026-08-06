/**
 * TCV-6789 — tests for resolving the build a CI run's results belong to.
 *
 * The HTTP layer is stubbed so the real resolution logic runs: which build is
 * reused, when one is created, and what is sent to the API.
 */

import { jest } from '@jest/globals';
import { pickBuildByVersion, resolveBuild } from '../src/lib/builds.js';

const BASE_URL = 'http://localhost:1337';
const TOKEN = 'test-token';
const PROJECT_ID = 4;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: '',
    text: async () => JSON.stringify(body)
  };
}

/**
 * Queue one stub response per expected call, in order.
 */
function stubFetch(responses) {
  const calls = [];
  global.fetch = jest.fn(async (url, options) => {
    calls.push({ url, options });
    const next = responses[calls.length - 1];
    if (!next) {
      throw new Error(`Unexpected extra request to ${url}`);
    }
    return next;
  });
  return calls;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

describe('pickBuildByVersion', () => {
  test('returns null when nothing matches', () => {
    expect(pickBuildByVersion([{ id: 1, version: '1.0.0' }], '2.0.0')).toBeNull();
  });

  test('returns null for an empty or missing list', () => {
    expect(pickBuildByVersion([], '1.0.0')).toBeNull();
    expect(pickBuildByVersion(null, '1.0.0')).toBeNull();
  });

  test('matches the exact version only', () => {
    const builds = [
      { id: 1, version: '1.0.0-rc1' },
      { id: 2, version: '1.0.0' }
    ];
    expect(pickBuildByVersion(builds, '1.0.0').id).toBe(2);
  });

  test('picks the most recent build when a version is recorded more than once', () => {
    const builds = [
      { id: 3, version: '1.0.0' },
      { id: 9, version: '1.0.0' },
      { id: 7, version: '1.0.0' }
    ];
    expect(pickBuildByVersion(builds, '1.0.0').id).toBe(9);
  });

  test('ignores surrounding whitespace on the wanted version', () => {
    expect(pickBuildByVersion([{ id: 1, version: '1.0.0' }], '  1.0.0 ').id).toBe(1);
  });
});

describe('resolveBuild by version', () => {
  test('reuses an existing build and does not create one', async () => {
    const calls = stubFetch([jsonResponse([{ id: 12, version: '2.14.1' }])]);

    const build = await resolveBuild({
      baseApiUrl: BASE_URL,
      token: TOKEN,
      projectId: PROJECT_ID,
      buildVersion: '2.14.1'
    });

    expect(build).toEqual({ id: 12, version: '2.14.1', created: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/builds?project=4&version=2.14.1');
    expect(calls[0].options.method).toBe('GET');
  });

  test('creates the build from the version and environment when none exists', async () => {
    const calls = stubFetch([
      jsonResponse([]),
      jsonResponse({ id: 30, version: '2.15.0', environment: 'Staging' })
    ]);

    const build = await resolveBuild({
      baseApiUrl: BASE_URL,
      token: TOKEN,
      projectId: PROJECT_ID,
      buildVersion: '2.15.0',
      environment: 'Staging'
    });

    expect(build).toEqual({ id: 30, version: '2.15.0', created: true });
    expect(calls).toHaveLength(2);
    expect(calls[1].options.method).toBe('POST');
    expect(JSON.parse(calls[1].options.body)).toEqual({
      project: PROJECT_ID,
      version: '2.15.0',
      environment: 'Staging'
    });
  });

  test('omits environment from the created build when none was given', async () => {
    const calls = stubFetch([jsonResponse([]), jsonResponse({ id: 31, version: '2.15.1' })]);

    await resolveBuild({
      baseApiUrl: BASE_URL,
      token: TOKEN,
      projectId: PROJECT_ID,
      buildVersion: '2.15.1'
    });

    expect(JSON.parse(calls[1].options.body)).toEqual({
      project: PROJECT_ID,
      version: '2.15.1'
    });
  });

  test('never sets a release on the build it creates', async () => {
    const calls = stubFetch([jsonResponse([]), jsonResponse({ id: 32, version: '3.0.0' })]);

    await resolveBuild({
      baseApiUrl: BASE_URL,
      token: TOKEN,
      projectId: PROJECT_ID,
      buildVersion: '3.0.0'
    });

    expect(JSON.parse(calls[1].options.body)).not.toHaveProperty('release');
  });

  test('url-encodes a version with characters that need it', async () => {
    const calls = stubFetch([jsonResponse([{ id: 40, version: 'release/2.0 rc' }])]);

    await resolveBuild({
      baseApiUrl: BASE_URL,
      token: TOKEN,
      projectId: PROJECT_ID,
      buildVersion: 'release/2.0 rc'
    });

    expect(calls[0].url).toContain('version=release%2F2.0%20rc');
  });

  test('warns but keeps the existing build when its environment differs', async () => {
    stubFetch([jsonResponse([{ id: 12, version: '2.14.1', environment: 'Production' }])]);

    const build = await resolveBuild({
      baseApiUrl: BASE_URL,
      token: TOKEN,
      projectId: PROJECT_ID,
      buildVersion: '2.14.1',
      environment: 'Staging'
    });

    expect(build.id).toBe(12);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Production'));
  });

  test('surfaces the API error message when the build cannot be created', async () => {
    stubFetch([jsonResponse([]), jsonResponse({ message: 'Forbidden' }, { ok: false, status: 403 })]);

    await expect(
      resolveBuild({
        baseApiUrl: BASE_URL,
        token: TOKEN,
        projectId: PROJECT_ID,
        buildVersion: '2.16.0'
      })
    ).rejects.toThrow('Forbidden');
  });
});

describe('resolveBuild by id', () => {
  test('accepts a build that belongs to the project', async () => {
    const calls = stubFetch([
      jsonResponse({ id: 12, version: '2.14.1', project: { id: PROJECT_ID } })
    ]);

    const build = await resolveBuild({
      baseApiUrl: BASE_URL,
      token: TOKEN,
      projectId: PROJECT_ID,
      buildId: 12
    });

    expect(build).toEqual({ id: 12, version: '2.14.1', created: false });
    expect(calls[0].url).toContain('/builds/12');
  });

  test('accepts a project returned as a plain id', async () => {
    stubFetch([jsonResponse({ id: 12, version: '2.14.1', project: PROJECT_ID })]);

    const build = await resolveBuild({
      baseApiUrl: BASE_URL,
      token: TOKEN,
      projectId: PROJECT_ID,
      buildId: 12
    });

    expect(build.id).toBe(12);
  });

  test('rejects a build from another project instead of linking it', async () => {
    stubFetch([jsonResponse({ id: 12, version: '2.14.1', project: { id: 99 } })]);

    await expect(
      resolveBuild({
        baseApiUrl: BASE_URL,
        token: TOKEN,
        projectId: PROJECT_ID,
        buildId: 12
      })
    ).rejects.toThrow('does not belong to project 4');
  });

  test('names the build in the error when the id does not exist', async () => {
    stubFetch([jsonResponse({ message: 'Resource not found' }, { ok: false, status: 404 })]);

    await expect(
      resolveBuild({
        baseApiUrl: BASE_URL,
        token: TOKEN,
        projectId: PROJECT_ID,
        buildId: 999
      })
    ).rejects.toThrow('Build 999 not found');
  });

  test('passes other API errors through untouched', async () => {
    stubFetch([jsonResponse({ message: 'Forbidden' }, { ok: false, status: 403 })]);

    await expect(
      resolveBuild({
        baseApiUrl: BASE_URL,
        token: TOKEN,
        projectId: PROJECT_ID,
        buildId: 12
      })
    ).rejects.toThrow('Forbidden');
  });
});
