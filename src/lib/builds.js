/**
 * builds.js
 *
 * TCV-6789 — resolve the Build that a CI run's results belong to.
 *
 * `--build` takes a build id or a version string, the same way `tc createTestPlan`
 * reads it (TCV-6788): a numeric value is looked up as an id first and retried as
 * a version, so a pipeline can pass a numeric version (e.g. a build number).
 *
 * The difference here is what happens when nothing matches. In keeping with what
 * `--auto-create` means, a version with no build yet gets one created from the
 * version (and the environment, when one is given) — a build is simply a record
 * of a version that was deployed.
 *
 * A release is never created: the build's own release auto-match runs server-side
 * on create, and the test plan picks the release up from the build (TCV-6787). A
 * release is a planning decision a person makes.
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
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'object' ? value.id : value;
}

/**
 * The builds whose version matches `version` exactly (trimmed, case-insensitive).
 * Pure — no I/O. The server-side filter is re-applied on the client so a looser
 * match can never silently link the plan to the wrong build.
 *
 * @param {Array} builds   Build records from GET /builds
 * @param {string} version The version that was asked for
 * @returns {Array} the matching builds
 */
export function selectBuildsByVersion(builds, version) {
  const wanted = String(version === undefined || version === null ? '' : version)
    .trim()
    .toLowerCase();
  const list = Array.isArray(builds) ? builds : [];
  return list.filter((build) => String(build?.version ?? '').trim().toLowerCase() === wanted);
}

/**
 * Resolve a --build value (build id or version string) to a build of the project,
 * creating it from the version when no build records that version yet.
 *
 * @param {string} baseApiUrl TestCollab API base URL
 * @param {string} token      TestCollab API token
 * @param {number} projectId  Project the build belongs to
 * @param {string} buildRef   Build id or version string
 * @param {object} options
 *   - environment {string} Environment recorded on a build that gets created
 * @returns {Promise<{id: number, version: string, created: boolean}>}
 */
export async function resolveBuild(baseApiUrl, token, projectId, buildRef, options = {}) {
  const { environment } = options;
  const raw = String(buildRef === undefined || buildRef === null ? '' : buildRef).trim();
  const looksLikeId = /^\d+$/.test(raw);

  if (looksLikeId) {
    let build = null;
    try {
      build = await apiRequest(baseApiUrl, token, `/builds/${raw}`);
    } catch (error) {
      // A missing id is not fatal — the value is retried as a version below.
      if (error?.status !== 404) {
        throw error;
      }
    }
    if (build) {
      if (relationId(build.project) === projectId) {
        console.log(`   ✓ Build "${build.version}" (existing, id: ${build.id})`);
        return { id: build.id, version: build.version, created: false };
      }
      // The id exists but in another project — a mistyped id, not a version.
      // Falling through would record "${raw}" as a brand new version.
      throw new Error(
        `Build ${raw} belongs to another project. Pass a build id from project ${projectId}, or the version that was deployed.`
      );
    }
  }

  const builds = await apiRequest(
    baseApiUrl,
    token,
    `/builds?project=${encodeURIComponent(projectId)}&version=${encodeURIComponent(raw)}&_limit=-1`
  );
  const matches = selectBuildsByVersion(builds, raw);

  if (matches.length > 1) {
    throw new Error(
      `${matches.length} builds in project ${projectId} have version "${raw}" ` +
        `(ids: ${matches.map((b) => b.id).join(', ')}). Pass --build <id> to pick one.`
    );
  }

  if (matches.length === 1) {
    const existing = matches[0];
    console.log(`   ✓ Build "${existing.version}" (existing, id: ${existing.id})`);
    if (environment && existing.environment && existing.environment !== environment) {
      console.warn(
        `⚠️  Build "${existing.version}" already exists with environment "${existing.environment}"; --environment "${environment}" was ignored`
      );
    }
    return { id: existing.id, version: existing.version, created: false };
  }

  const payload = { project: projectId, version: raw };
  if (environment) {
    payload.environment = environment;
  }
  const created = await apiRequest(baseApiUrl, token, '/builds', { method: 'POST', body: payload });
  if (!created || !created.id) {
    throw new Error(`Failed to create build "${raw}"`);
  }
  const environmentNote = environment ? `, environment: ${environment}` : '';
  console.log(`   ✓ Build "${raw}" (created, id: ${created.id}${environmentNote})`);
  return { id: created.id, version: raw, created: true };
}
