/**
 * CI environment isolation for tests (TCV-6794).
 *
 * `tc createBuild` infers version/commit/repo/run URLs from the CI provider's own
 * environment variables. That means the test suite inherits whatever CI it happens
 * to run on: on GitHub Actions `GITHUB_ACTIONS=true` is set, detection fires, and
 * any test asserting an exact request payload sees extra inferred fields it never
 * passed. The suite then passes on a laptop and fails in CI — which is exactly what
 * happened on the v1.14 release run.
 *
 * Tests that assert on payloads should call `clearCiEnv()` in `beforeEach` and
 * `restoreCiEnv()` in `afterEach`. Tests that want detection should set the vars
 * themselves via `withCiEnv()`.
 */

// Every variable the detector reads, across all supported providers.
const CI_VARIABLES = [
  // Azure DevOps
  'TF_BUILD',
  'BUILD_BUILDNUMBER',
  'BUILD_BUILDID',
  'BUILD_SOURCEVERSION',
  'BUILD_REPOSITORY_URI',
  'SYSTEM_COLLECTIONURI',
  'SYSTEM_TEAMPROJECT',
  // GitHub Actions
  'GITHUB_ACTIONS',
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_SHA',
  // GitLab CI
  'GITLAB_CI',
  'CI_PROJECT_URL',
  'CI_COMMIT_SHA',
  'CI_PIPELINE_URL',
  'CI_PIPELINE_IID',
  // Bitbucket Pipelines
  'BITBUCKET_BUILD_NUMBER',
  'BITBUCKET_COMMIT',
  'BITBUCKET_GIT_HTTP_ORIGIN',
  // CircleCI
  'CIRCLECI',
  'CIRCLE_BUILD_NUM',
  'CIRCLE_SHA1',
  'CIRCLE_BUILD_URL',
  'CIRCLE_REPOSITORY_URL',
  // Jenkins
  'JENKINS_URL',
  'BUILD_NUMBER',
  'BUILD_URL',
  'GIT_COMMIT',
  'GIT_URL'
];

let saved = null;

/** Remove every CI marker, so detection stays inert regardless of the host. */
export function clearCiEnv() {
  saved = {};
  CI_VARIABLES.forEach((name) => {
    if (name in process.env) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
}

/** Put back whatever `clearCiEnv()` removed. */
export function restoreCiEnv() {
  if (!saved) return;
  Object.entries(saved).forEach(([name, value]) => {
    process.env[name] = value;
  });
  saved = null;
}

/** Run with a specific provider's variables in place, then restore. */
export function withCiEnv(vars, fn) {
  clearCiEnv();
  Object.entries(vars).forEach(([name, value]) => {
    process.env[name] = value;
  });
  try {
    return fn();
  } finally {
    CI_VARIABLES.forEach((name) => delete process.env[name]);
    restoreCiEnv();
  }
}

export { CI_VARIABLES };
