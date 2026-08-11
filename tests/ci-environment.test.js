/**
 * TCV-6794 — CI provider detection for `tc createBuild`.
 *
 * Every pipeline author was pasting the same three interpolations by hand, so the
 * CLI now reads them from the provider's own environment. Two properties matter:
 * the values must be right per provider (commit URL paths differ), and detection
 * must never override a flag the user passed.
 */
import { describe, expect, test } from '@jest/globals';

import {
  applyCiEnvironment,
  detectCiEnvironment
} from '../src/utils/ciEnvironment.js';

const AZURE = {
  TF_BUILD: 'True',
  BUILD_BUILDNUMBER: '1.0.20260811.7',
  BUILD_BUILDID: '51',
  BUILD_SOURCEVERSION: '7117a600b3fc5ac9b8f24f950e62115fe254cb14',
  // Azure hands this over with the org as userinfo.
  BUILD_REPOSITORY_URI: 'https://abhi0498@dev.azure.com/abhi0498/abhi-personal/_git/abhi-personal',
  SYSTEM_COLLECTIONURI: 'https://dev.azure.com/abhi0498/',
  SYSTEM_TEAMPROJECT: 'abhi-personal'
};

const GITHUB = {
  GITHUB_ACTIONS: 'true',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'TCSoftInc/testcollab-cli',
  GITHUB_RUN_ID: '99887766',
  GITHUB_RUN_NUMBER: '42',
  GITHUB_SHA: 'abc1234def5678'
};

const GITLAB = {
  GITLAB_CI: 'true',
  CI_PROJECT_URL: 'https://gitlab.com/gigapromoters/tc-api',
  CI_COMMIT_SHA: 'deadbeefcafe',
  CI_PIPELINE_URL: 'https://gitlab.com/gigapromoters/tc-api/-/pipelines/123',
  CI_PIPELINE_IID: '77'
};

describe('detectCiEnvironment', () => {
  test('reads Azure DevOps and strips the org userinfo from the repo URL', () => {
    const { provider, values } = detectCiEnvironment(AZURE);
    expect(provider).toBe('Azure DevOps');
    expect(values.version).toBe('1.0.20260811.7');
    expect(values.commit).toBe('7117a600b3fc5ac9b8f24f950e62115fe254cb14');
    expect(values.repoUrl).toBe(
      'https://dev.azure.com/abhi0498/abhi-personal/_git/abhi-personal'
    );
    expect(values.commitUrl).toBe(
      'https://dev.azure.com/abhi0498/abhi-personal/_git/abhi-personal/commit/7117a600b3fc5ac9b8f24f950e62115fe254cb14'
    );
    expect(values.deploymentUrl).toBe(
      'https://dev.azure.com/abhi0498/abhi-personal/_build/results?buildId=51'
    );
  });

  test('reads GitHub Actions', () => {
    const { provider, values } = detectCiEnvironment(GITHUB);
    expect(provider).toBe('GitHub Actions');
    expect(values.repoUrl).toBe('https://github.com/TCSoftInc/testcollab-cli');
    expect(values.commitUrl).toBe(
      'https://github.com/TCSoftInc/testcollab-cli/commit/abc1234def5678'
    );
    expect(values.deploymentUrl).toBe(
      'https://github.com/TCSoftInc/testcollab-cli/actions/runs/99887766'
    );
  });

  test('uses GitLab’s /-/commit/ path, not the GitHub shape', () => {
    const { provider, values } = detectCiEnvironment(GITLAB);
    expect(provider).toBe('GitLab CI');
    expect(values.commitUrl).toBe(
      'https://gitlab.com/gigapromoters/tc-api/-/commit/deadbeefcafe'
    );
    expect(values.deploymentUrl).toBe(
      'https://gitlab.com/gigapromoters/tc-api/-/pipelines/123'
    );
  });

  test('reports nothing outside a recognised CI provider', () => {
    expect(detectCiEnvironment({ HOME: '/Users/abhi' })).toBeNull();
  });

  test('omits values the provider did not export rather than emitting blanks', () => {
    const { values } = detectCiEnvironment({
      TF_BUILD: 'True',
      BUILD_BUILDNUMBER: '5'
    });
    expect(values.version).toBe('5');
    expect(values).not.toHaveProperty('commitUrl');
    expect(values).not.toHaveProperty('repoUrl');
    expect(values).not.toHaveProperty('deploymentUrl');
  });

  test('does not infer a repo link from a git remote it cannot turn into a web URL', () => {
    const { provider, values } = detectCiEnvironment({
      JENKINS_URL: 'https://jenkins.internal',
      BUILD_URL: 'https://jenkins.internal/job/deploy/12/',
      BUILD_NUMBER: '12',
      GIT_COMMIT: 'aaa111',
      GIT_URL: 'git@github.com:TCSoftInc/testcollab-cli.git'
    });
    expect(provider).toBe('Jenkins');
    expect(values.deploymentUrl).toBe('https://jenkins.internal/job/deploy/12');
    expect(values).not.toHaveProperty('repoUrl');
    expect(values).not.toHaveProperty('commitUrl');
  });
});

describe('applyCiEnvironment', () => {
  test('never overrides a value the pipeline passed explicitly', () => {
    const { options, applied } = applyCiEnvironment(
      { version: 'release-9', commitUrl: 'https://example.test/c/1' },
      AZURE
    );
    expect(options.version).toBe('release-9');
    expect(options.commitUrl).toBe('https://example.test/c/1');
    // …while still filling the ones that were left out.
    expect(options.commit).toBe('7117a600b3fc5ac9b8f24f950e62115fe254cb14');
    expect(applied).toContain('commit');
    expect(applied).not.toContain('version');
    expect(applied).not.toContain('commitUrl');
  });

  test('treats an empty string as "not supplied"', () => {
    const { options } = applyCiEnvironment({ version: '   ' }, AZURE);
    expect(options.version).toBe('1.0.20260811.7');
  });

  test('leaves options untouched off-CI', () => {
    const original = { project: 24 };
    const { options, provider, applied } = applyCiEnvironment(original, {});
    expect(provider).toBeNull();
    expect(applied).toEqual([]);
    expect(options).toEqual(original);
  });
});
