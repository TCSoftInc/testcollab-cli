/**
 * builds.js
 *
 * TCV-6789 — resolve the Build that a CI run's results belong to.
 *
 * A build is simply a record of a version that was deployed, so a pipeline can
 * name it by the version string it already knows. When that version has not been
 * recorded yet the build is created from the version (and the environment, when
 * one is given); an existing build is reused as-is.
 *
 * A release is never created here: the build's own release auto-match runs
 * server-side on create, and the test plan picks the release up from the build
 * (TCV-6787). A release is a planning decision a person makes.
 *
 * Builds shipped after the last `testcollab-sdk` release, so these calls are made
 * directly against the REST API rather than through the SDK.
 */

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

  return data;
}

/**
 * The id of a relation that may come back as a plain id or as a populated object.
 */
function relationId(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'object' ? value.id : value;
}

/**
 * Pick the build to reuse out of the ones returned for a version. Pure — no I/O.
 *
 * A version is not unique within a project, so when several builds carry it the
 * most recently created one (highest id) wins: that is the one the pipeline just
 * deployed.
 *
 * @param {Array} builds   Build records from GET /builds
 * @param {string} version The version that was asked for
 * @returns {object|null}  The build to reuse, or null when there is no match
 */
export function pickBuildByVersion(builds, version) {
  const wanted = String(version || '').trim();
  const list = Array.isArray(builds) ? builds : [];
  const matches = list.filter((b) => b && String(b.version || '').trim() === wanted);
  if (!matches.length) {
    return null;
  }
  return matches.reduce((newest, b) => (Number(b.id) > Number(newest.id) ? b : newest));
}

/**
 * Resolve the build to link a test plan to, creating it when only a version is
 * known and no build records it yet.
 *
 * @param {object} params
 *   - baseApiUrl {string}   TestCollab API base URL
 *   - token {string}        TestCollab API token
 *   - projectId {number}    Project the build belongs to
 *   - buildVersion {string} Version to look up / create (mutually exclusive with buildId)
 *   - buildId {number}      Existing build id (mutually exclusive with buildVersion)
 *   - environment {string}  Environment recorded on a build that gets created
 * @returns {Promise<{id: number, version: string, created: boolean}>}
 */
export async function resolveBuild({
  baseApiUrl,
  token,
  projectId,
  buildVersion,
  buildId,
  environment
}) {
  if (buildId) {
    let build;
    try {
      build = await apiRequest(baseApiUrl, token, `/builds/${encodeURIComponent(buildId)}`);
    } catch (error) {
      // The API's 404 body says only "Resource not found"; name the build instead.
      if (error?.status === 404) {
        throw new Error(`Build ${buildId} not found`);
      }
      throw error;
    }
    if (!build || !build.id) {
      throw new Error(`Build ${buildId} not found`);
    }
    if (Number(relationId(build.project)) !== Number(projectId)) {
      throw new Error(`Build ${buildId} does not belong to project ${projectId}`);
    }
    console.log(`   ✓ Build "${build.version}" (existing, id: ${build.id})`);
    return { id: build.id, version: build.version, created: false };
  }

  const version = String(buildVersion || '').trim();
  if (!version) {
    throw new Error('A build version is required to resolve a build');
  }

  const existingBuilds = await apiRequest(
    baseApiUrl,
    token,
    `/builds?project=${encodeURIComponent(projectId)}&version=${encodeURIComponent(version)}&_limit=-1`
  );
  const existing = pickBuildByVersion(existingBuilds, version);

  if (existing) {
    console.log(`   ✓ Build "${version}" (existing, id: ${existing.id})`);
    if (environment && existing.environment && existing.environment !== environment) {
      console.warn(
        `⚠️  Build "${version}" already exists with environment "${existing.environment}"; --environment "${environment}" was ignored`
      );
    }
    return { id: existing.id, version, created: false };
  }

  const payload = { project: projectId, version };
  if (environment) {
    payload.environment = environment;
  }
  const created = await apiRequest(baseApiUrl, token, '/builds', { method: 'POST', body: payload });
  if (!created || !created.id) {
    throw new Error(`Failed to create build "${version}"`);
  }
  const environmentNote = environment ? `, environment: ${environment}` : '';
  console.log(`   ✓ Build "${version}" (created, id: ${created.id}${environmentNote})`);
  return { id: created.id, version, created: true };
}
