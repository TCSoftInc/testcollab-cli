/**
 * createBuild.js
 *
 * TCV-6794 — record in TestCollab the build a CI pipeline has just produced or
 * deployed, so the version under test is captured at deploy time.
 *
 * The pipeline tells TestCollab rather than TestCollab listening for deployment
 * events from each vendor, so the same one-liner works in Azure DevOps, GitLab CI,
 * Jenkins and GitHub Actions and needs no extra permissions in the customer's
 * DevOps environment.
 *
 * Options:
 * - --project          Project ID (required)
 * - --version          Version that was built/deployed (required)
 * - --environment      Environment it was deployed to
 * - --deployment-url   Link back to the pipeline run / deployment
 * - --commit           Commit SHA the build was produced from
 * - --notes            Free-text note
 * - --api-key          API token
 * - --api-url          (defaults to https://api.testcollab.io)
 *
 * The build is matched on version first and only created when missing, so a
 * pipeline that re-runs (or several jobs of the same run) never records the same
 * version twice. Releases are attached server-side by the release version
 * patterns — the CLI never creates one.
 */

import fs from 'fs';

// Builds shipped after the last `testcollab-sdk` release and its generated
// payload serializers drop keys they do not know, so these calls are made
// directly against the REST API (same `?token=` auth the other commands use).
function buildUrl(baseApiUrl, endpoint, token) {
  const normalized = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const separator = normalized.includes('?') ? '&' : '?';
  return `${baseApiUrl}${normalized}${separator}token=${encodeURIComponent(token)}`;
}

async function apiRequest(baseApiUrl, token, endpoint, options = {}) {
  const { method = 'GET', body } = options;
  const requestOptions = {
    method,
    headers: { Accept: 'application/json' }
  };
  if (body !== undefined) {
    requestOptions.headers['Content-Type'] = 'application/json';
    requestOptions.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(buildUrl(baseApiUrl, endpoint, token), requestOptions);
  } catch (error) {
    throw new Error(`Failed to call ${endpoint}: ${error?.message || String(error)}`);
  }

  const rawBody = await response.text();
  let data = null;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = rawBody;
    }
  }

  if (!response.ok) {
    const message =
      (data && typeof data === 'object' && (data.message || data.error)) ||
      (typeof data === 'string' ? data : '') ||
      response.statusText ||
      `HTTP ${response.status}`;
    const error = new Error(String(message));
    error.status = response.status;
    throw error;
  }

  // Some endpoints answer 200 with a failure envelope instead of an HTTP error.
  if (data && typeof data === 'object' && data.status === false) {
    throw new Error(String(data.message || `Request to ${endpoint} failed`));
  }

  return data;
}

/**
 * TCV-6794: a version reduced to the form two versions are compared in — trimmed,
 * with a single leading `v`/`V` removed. Mirrors `stripLeadingV` in the API's
 * api/build/services/versionPattern.js, so `v2.14.0` and `2.14.0` are one build
 * here exactly as they are one build when matched against a release pattern.
 *
 * @param {*} value the raw version
 * @returns {string} the comparable form
 */
export function normalizeVersion(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .replace(/^[vV]/, '');
}

/**
 * TCV-6794: the builds recording `version`, oldest first. Pure — no I/O. The
 * server-side filter is a LIKE, so the comparison is re-applied on the client and
 * a looser match can never be mistaken for the same version.
 *
 * @param {Array} builds   Build records from GET /builds
 * @param {string} version The version that was built
 * @returns {Array} the matching builds, lowest id first
 */
export function selectBuildsByVersion(builds, version) {
  const wanted = normalizeVersion(version);
  const list = Array.isArray(builds) ? builds : [];
  return list
    .filter((build) => normalizeVersion(build?.version) === wanted)
    .sort((a, b) => Number(a?.id) - Number(b?.id));
}

/**
 * TCV-6794: the fields a pipeline can record on a build, as the CLI option that
 * carries them and the API column they are stored in. `--deployment-url` is the
 * link back to the pipeline run, which the build detail page shows as the
 * deployment link.
 */
const BUILD_FIELDS = [
  { option: 'environment', field: 'environment', label: 'Environment' },
  { option: 'deploymentUrl', field: 'build_url', label: 'Deployment URL' },
  { option: 'commit', field: 'commit_sha', label: 'Commit' },
  { option: 'notes', field: 'notes', label: 'Notes' }
];

// The values the pipeline passed, keyed by API column. Blank options are skipped
// so an unset CI variable never blanks out a field.
function collectBuildFields(options) {
  const values = {};
  BUILD_FIELDS.forEach(({ option, field }) => {
    const value = options[option];
    if (value !== undefined && String(value).trim()) {
      values[field] = String(value).trim();
    }
  });
  return values;
}

// TCV-6794: an existing build is reused as-is rather than overwritten — a later
// pipeline stage must not rewrite what the deploy stage recorded. Say which
// values were left alone so the difference is visible in the pipeline log.
function warnAboutIgnoredFields(existingBuild, values) {
  BUILD_FIELDS.forEach(({ field, label }) => {
    if (!Object.prototype.hasOwnProperty.call(values, field)) return;
    const current = existingBuild[field] == null ? '' : String(existingBuild[field]);
    if (current === values[field]) return;
    console.warn(
      `⚠️  Build already records ${label.toLowerCase()} "${current}"; ` +
        `"${values[field]}" was not applied. Edit the build in TestCollab to change it.`
    );
  });
}

export async function createBuild(options) {
  const { project, version, apiUrl } = options;

  // Resolve API key: --api-key flag takes precedence, then TESTCOLLAB_TOKEN env var
  const apiKey = options.apiKey || process.env.TESTCOLLAB_TOKEN;

  // Normalize/Default API base URL
  const effectiveApiUrl =
    apiUrl && String(apiUrl).trim()
      ? String(apiUrl).trim().replace(/\/+$/, '')
      : 'https://api.testcollab.io';

  if (!apiKey) {
    console.error('❌ Error: No API key provided');
    console.error('   Pass --api-key <key> or set the TESTCOLLAB_TOKEN environment variable.');
    process.exit(1);
  }
  if (!project) {
    console.error('❌ Error: --project is required');
    process.exit(1);
  }

  const parsedProjectId = Number(project);
  if (!Number.isInteger(parsedProjectId) || parsedProjectId <= 0) {
    console.error('❌ Error: --project must be a project ID');
    process.exit(1);
  }

  const rawVersion = version === undefined || version === null ? '' : String(version).trim();
  if (!rawVersion) {
    console.error('❌ Error: --version is required');
    console.error('   Pass the version your pipeline built, e.g. --version "$BUILD_BUILDNUMBER".');
    process.exit(1);
  }

  // Ensure tmp directory exists and remove any id file from an earlier step, so a
  // failed run never leaves the previous build's id behind for later steps.
  try {
    if (!fs.existsSync('tmp')) {
      fs.mkdirSync('tmp', { recursive: true });
    }
    if (fs.existsSync('tmp/tc_build')) {
      fs.unlinkSync('tmp/tc_build');
    }
  } catch (e) {
    // Non-fatal; continue
  }

  try {
    const projectResponse = await apiRequest(
      effectiveApiUrl,
      apiKey,
      `/projects/${parsedProjectId}`
    );
    if (!projectResponse || projectResponse.id !== parsedProjectId) {
      console.error('❌ Error: Project not found. Ensure you have access to this project.');
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ Error: Failed to validate project (${e?.message || String(e)})`);
    process.exit(1);
  }

  const values = collectBuildFields(options);

  let build;
  let created = false;
  try {
    // Match on version first. `_contains` is a LIKE, which is what makes the
    // leading-`v` and case variants of the version come back as candidates;
    // selectBuildsByVersion then decides which of them are the same version.
    const candidates = await apiRequest(
      effectiveApiUrl,
      apiKey,
      `/builds?project=${parsedProjectId}` +
        `&version_contains=${encodeURIComponent(normalizeVersion(rawVersion) || rawVersion)}` +
        `&_limit=-1`
    );
    const matches = selectBuildsByVersion(candidates, rawVersion);

    if (matches.length > 1) {
      // Version is not unique per project, so this is possible for builds recorded
      // before this command existed. Reusing the oldest keeps the pipeline green
      // and keeps every run of this version pointing at the same build.
      console.warn(
        `⚠️  ${matches.length} builds already record version "${rawVersion}" ` +
          `(ids: ${matches.map((b) => b.id).join(', ')}). Using the oldest.`
      );
    }

    if (matches.length > 0) {
      build = matches[0];
      warnAboutIgnoredFields(build, values);
    } else {
      build = await apiRequest(effectiveApiUrl, apiKey, '/builds', {
        method: 'POST',
        body: { project: parsedProjectId, version: rawVersion, ...values }
      });
      if (!build || !build.id) {
        throw new Error(`Failed to record build "${rawVersion}"`);
      }
      created = true;
    }
  } catch (error) {
    console.error(`❌ Error: ${error?.message || String(error)}`);
    process.exit(1);
  }

  const release = build.release && typeof build.release === 'object' ? build.release : null;
  console.log(
    `Build "${build.version}" (${created ? 'created' : 'existing'}, id ${build.id})` +
      (build.environment ? ` — ${build.environment}` : '')
  );
  if (release) {
    console.log(`Release: ${release.name} (id ${release.id})`);
  }

  try {
    fs.writeFileSync('tmp/tc_build', `TESTCOLLAB_BUILD_ID=${build.id}`);
  } catch (e) {
    console.warn(`⚠️  Could not write tmp/tc_build (${e?.message || String(e)})`);
  }

  console.log(`✅ Build recorded. Build ID: ${build.id}`);
}
