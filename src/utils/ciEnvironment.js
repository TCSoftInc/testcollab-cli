/**
 * ciEnvironment.js
 *
 * TCV-6794 — infer the build's provenance from the CI provider's own environment
 * variables, so a pipeline only has to say `tc createBuild --project <id>`.
 *
 * Every provider already exports the run URL, the commit and the repository, and
 * every pipeline author was otherwise pasting the same three interpolations by hand:
 *
 *   --deployment-url "$(System.CollectionUri)$(System.TeamProject)/_build/results?buildId=$(Build.BuildId)"
 *   --commit-url     "$(Build.Repository.Uri)/commit/$(Build.SourceVersion)"
 *   --repo-url       "$(Build.Repository.Uri)"
 *
 * Detection never overrides an explicit flag — the CLI merges these UNDER whatever
 * the user passed — and the resolved provider is logged so a wrong guess shows up in
 * the pipeline log rather than quietly recording a bad link.
 *
 * Commit URL paths differ per host, so each provider supplies its own builder rather
 * than a shared `${repo}/commit/${sha}` guess:
 *   Azure DevOps / GitHub  {repo}/commit/{sha}
 *   GitLab                 {repo}/-/commit/{sha}
 *   Bitbucket              {repo}/commits/{sha}
 */

// Azure's Build.Repository.Uri arrives as https://{org}@dev.azure.com/... . The URL
// still resolves, but browsers may prompt for credentials and it reads as a leaked
// username, so drop the userinfo here as well as server-side.
const stripUserinfo = (value) => {
  if (!value) return value;
  const raw = String(value).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return raw;
  }
  if (!parsed.username && !parsed.password) return raw;
  parsed.username = '';
  parsed.password = '';
  return parsed.toString().replace(/\/+$/, '');
};

const trimSlashes = (value) =>
  value ? String(value).trim().replace(/\/+$/, '') : value;

const join = (...parts) => parts.filter(Boolean).map(trimSlashes).join('/');

const PROVIDERS = [
  {
    name: 'Azure DevOps',
    detect: (env) => env.TF_BUILD === 'True' || env.TF_BUILD === 'true',
    read: (env) => {
      const repoUrl = stripUserinfo(env.BUILD_REPOSITORY_URI);
      const collection = trimSlashes(env.SYSTEM_COLLECTIONURI);
      const project = env.SYSTEM_TEAMPROJECT;
      return {
        version: env.BUILD_BUILDNUMBER,
        commit: env.BUILD_SOURCEVERSION,
        repoUrl,
        commitUrl:
          repoUrl && env.BUILD_SOURCEVERSION
            ? join(repoUrl, 'commit', env.BUILD_SOURCEVERSION)
            : undefined,
        deploymentUrl:
          collection && project && env.BUILD_BUILDID
            ? `${collection}/${encodeURIComponent(project)}/_build/results?buildId=${env.BUILD_BUILDID}`
            : undefined
      };
    }
  },
  {
    name: 'GitHub Actions',
    detect: (env) => env.GITHUB_ACTIONS === 'true',
    read: (env) => {
      const server = trimSlashes(env.GITHUB_SERVER_URL) || 'https://github.com';
      const repoUrl = env.GITHUB_REPOSITORY
        ? join(server, env.GITHUB_REPOSITORY)
        : undefined;
      return {
        version: env.GITHUB_RUN_NUMBER,
        commit: env.GITHUB_SHA,
        repoUrl,
        commitUrl:
          repoUrl && env.GITHUB_SHA
            ? join(repoUrl, 'commit', env.GITHUB_SHA)
            : undefined,
        deploymentUrl:
          repoUrl && env.GITHUB_RUN_ID
            ? join(repoUrl, 'actions/runs', env.GITHUB_RUN_ID)
            : undefined
      };
    }
  },
  {
    name: 'GitLab CI',
    detect: (env) => env.GITLAB_CI === 'true',
    read: (env) => {
      const repoUrl = trimSlashes(env.CI_PROJECT_URL);
      return {
        version: env.CI_PIPELINE_IID,
        commit: env.CI_COMMIT_SHA,
        repoUrl,
        // GitLab puts a `-` segment before `commit`.
        commitUrl:
          repoUrl && env.CI_COMMIT_SHA
            ? join(repoUrl, '-/commit', env.CI_COMMIT_SHA)
            : undefined,
        deploymentUrl: trimSlashes(env.CI_PIPELINE_URL)
      };
    }
  },
  {
    name: 'Bitbucket Pipelines',
    detect: (env) => Boolean(env.BITBUCKET_BUILD_NUMBER),
    read: (env) => {
      const repoUrl = env.BITBUCKET_GIT_HTTP_ORIGIN
        ? stripUserinfo(env.BITBUCKET_GIT_HTTP_ORIGIN)
        : undefined;
      return {
        version: env.BITBUCKET_BUILD_NUMBER,
        commit: env.BITBUCKET_COMMIT,
        repoUrl,
        commitUrl:
          repoUrl && env.BITBUCKET_COMMIT
            ? join(repoUrl, 'commits', env.BITBUCKET_COMMIT)
            : undefined,
        deploymentUrl:
          repoUrl && env.BITBUCKET_BUILD_NUMBER
            ? join(repoUrl, 'pipelines/results', env.BITBUCKET_BUILD_NUMBER)
            : undefined
      };
    }
  },
  {
    name: 'CircleCI',
    detect: (env) => env.CIRCLECI === 'true',
    read: (env) => ({
      version: env.CIRCLE_BUILD_NUM,
      commit: env.CIRCLE_SHA1,
      // CIRCLE_REPOSITORY_URL is a git remote (git@host:org/repo.git), not a web
      // URL, so it is deliberately not reported as repoUrl — a wrong link is worse
      // than no link.
      deploymentUrl: trimSlashes(env.CIRCLE_BUILD_URL)
    })
  },
  {
    name: 'Jenkins',
    detect: (env) => Boolean(env.JENKINS_URL),
    read: (env) => ({
      version: env.BUILD_NUMBER,
      commit: env.GIT_COMMIT,
      // GIT_URL is the clone URL and may end in .git or be an ssh remote, so no
      // repo/commit link is inferred.
      deploymentUrl: trimSlashes(env.BUILD_URL)
    })
  }
];

/**
 * Identify the CI provider and read what it can tell us about this run.
 *
 * @param {object} env  process.env, or a stand-in for tests
 * @returns {{provider: string, values: object}|null} null when not running in a
 *          recognised CI provider (a developer's laptop, say)
 */
export function detectCiEnvironment(env = process.env) {
  const source = env || {};
  for (const provider of PROVIDERS) {
    if (!provider.detect(source)) continue;
    const raw = provider.read(source) || {};
    const values = {};
    // Drop anything the provider could not supply, so the caller's own defaults
    // and explicit flags are never overwritten with undefined.
    Object.keys(raw).forEach((key) => {
      const value = raw[key];
      if (value !== undefined && value !== null && String(value).trim()) {
        values[key] = String(value).trim();
      }
    });
    return { provider: provider.name, values };
  }
  return null;
}

/**
 * Merge detected values UNDER the options the user passed explicitly.
 *
 * @returns {{options: object, provider: string|null, applied: string[]}} `applied`
 *          lists the fields detection actually filled, for logging.
 */
export function applyCiEnvironment(options = {}, env = process.env) {
  const detected = detectCiEnvironment(env);
  if (!detected) return { options, provider: null, applied: [] };

  const merged = { ...options };
  const applied = [];
  Object.keys(detected.values).forEach((key) => {
    const existing = merged[key];
    if (existing === undefined || existing === null || !String(existing).trim()) {
      merged[key] = detected.values[key];
      applied.push(key);
    }
  });
  return { options: merged, provider: detected.provider, applied };
}

export const __testables = { stripUserinfo, PROVIDERS };
