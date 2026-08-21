/**
 * testCaseIds.js
 *
 * TCV-6866 — read a [TC-<n>] marker as the number TestCollab actually shows.
 *
 * A test case carries two numbers. `display_number` is the per-company business
 * id printed everywhere in the product (grids, the test case page, exports,
 * reports) behind a "TC-" prefix, and it is the only one a user can see.
 * `testcases.id` is the internal primary key, which the product never shows.
 *
 * A marker copied out of the app therefore holds the display number, so that is
 * what results are matched on first. The internal id keeps working as a fallback
 * so pipelines written before this existed do not have to be rewritten.
 *
 * Business ids shipped after the last `testcollab-sdk` release, so these calls
 * are made directly against the REST API rather than through the SDK.
 */

// Keeps the ?id_in= query string well inside the URL length a proxy will accept.
const CASE_ID_CHUNK_SIZE = 100;

function buildUrl(baseApiUrl, endpoint, token) {
  const normalized = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const separator = normalized.includes('?') ? '&' : '?';
  return `${baseApiUrl}${normalized}${separator}token=${encodeURIComponent(token)}`;
}

async function apiGet(baseApiUrl, token, endpoint) {
  let response;
  try {
    response = await fetch(buildUrl(baseApiUrl, endpoint, token), {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
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
 * The distinct, non-empty values of a list, as strings. `String(null)` is the
 * truthy "null", so anything missing is dropped before it is stringified —
 * otherwise a report where only some tests carry a marker would query for it.
 */
function distinctValues(values) {
  const list = Array.isArray(values) ? values : [];
  return [
    ...new Set(
      list
        .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
        .map((value) => String(value).trim())
    )
  ];
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Index test case records both ways: internal id → business id, and back.
 *
 * Pure. The maps are built from the `display_number` each record actually
 * carries, so a server that ignores the filter (or does not know the field at
 * all) can widen the result set but can never produce a wrong mapping.
 *
 * @param {Array} testCases records from GET /testcases
 * @returns {{displayNumberByCaseId: Map<string,string>, caseIdByDisplayNumber: Map<string,string>}}
 */
export function indexTestCaseNumbers(testCases) {
  const displayNumberByCaseId = new Map();
  const caseIdByDisplayNumber = new Map();

  (Array.isArray(testCases) ? testCases : []).forEach((testCase) => {
    const caseId = testCase && testCase.id !== undefined && testCase.id !== null ? String(testCase.id) : '';
    const displayNumber =
      testCase && testCase.display_number !== undefined && testCase.display_number !== null
        ? String(testCase.display_number)
        : '';
    if (!caseId || !displayNumber) {
      return;
    }
    displayNumberByCaseId.set(caseId, displayNumber);
    // A business id is unique per company, so the first record wins and a
    // repeated one is the same case coming back twice.
    if (!caseIdByDisplayNumber.has(displayNumber)) {
      caseIdByDisplayNumber.set(displayNumber, caseId);
    }
  });

  return { displayNumberByCaseId, caseIdByDisplayNumber };
}

/**
 * Read the business ids of a known set of test cases.
 *
 * Never throws: a server that predates business ids (or a role that cannot read
 * test cases) leaves the index empty, which puts matching back exactly where it
 * was before this existed — internal ids only.
 *
 * @param {string} baseApiUrl TestCollab API base URL
 * @param {string} token      TestCollab API token
 * @param {number} projectId  Project the cases belong to
 * @param {Array}  caseIds    Internal test case ids
 * @returns {Promise<{displayNumberByCaseId: Map<string,string>, caseIdByDisplayNumber: Map<string,string>}>}
 */
export async function fetchTestCaseNumbers(baseApiUrl, token, projectId, caseIds) {
  const ids = distinctValues(caseIds);
  if (!ids.length) {
    return indexTestCaseNumbers([]);
  }

  let records = [];
  try {
    records = await fetchCasesByField(baseApiUrl, token, projectId, 'id_in', ids);
  } catch (error) {
    console.warn(
      `⚠️  Could not read the TestCollab ids (TC-) of this run's test cases: ${error?.message || String(error)}`
    );
    console.warn('   Falling back to matching on internal test case ids only.');
    return indexTestCaseNumbers([]);
  }

  return indexTestCaseNumbers(records);
}

async function fetchCasesByField(baseApiUrl, token, projectId, field, values) {
  const records = [];
  for (const valueChunk of chunk(values, CASE_ID_CHUNK_SIZE)) {
    const query = valueChunk.map((value) => `${field}=${encodeURIComponent(value)}`).join('&');
    const rows = await apiGet(
      baseApiUrl,
      token,
      `/testcases?project=${encodeURIComponent(projectId)}&${query}&_limit=-1`
    );
    if (Array.isArray(rows)) {
      records.push(...rows);
    }
  }
  return records;
}

/**
 * Resolve the markers a report carries to test cases of one project.
 *
 * Used where there is no run to scope the lookup to yet — `--auto-create` builds
 * the plan out of the report — so the project is the scope. Both queries filter
 * on `project`, which is what keeps a marker from resolving to a case of another
 * project that happens to share the number (the API's own project check only
 * stops that across companies).
 *
 * A business id is looked up first and the internal id only for the markers left
 * over. A server that does not know business ids warns and falls back to internal
 * ids; a failure of the internal-id lookup throws, because auto-create would
 * otherwise treat every marked test as new and duplicate the cases.
 *
 * @param {string} baseApiUrl TestCollab API base URL
 * @param {string} token      TestCollab API token
 * @param {number} projectId  Project to look in
 * @param {Array}  markers    Ids taken from the test names
 * @returns {Promise<Map<string, object>>} marker → test case record
 */
export async function fetchCasesByMarker(baseApiUrl, token, projectId, markers) {
  const wanted = distinctValues(markers);
  const byMarker = new Map();
  if (!wanted.length) {
    return byMarker;
  }

  let byDisplayNumber = [];
  try {
    byDisplayNumber = await fetchCasesByField(baseApiUrl, token, projectId, 'display_number_in', wanted);
  } catch (error) {
    console.warn(
      `⚠️  Could not look up test cases by their TestCollab id (TC-): ${error?.message || String(error)}`
    );
    console.warn('   Falling back to matching on internal test case ids only.');
  }

  byDisplayNumber.forEach((testCase) => {
    const displayNumber =
      testCase && testCase.display_number !== undefined && testCase.display_number !== null
        ? String(testCase.display_number)
        : '';
    if (displayNumber && wanted.includes(displayNumber) && !byMarker.has(displayNumber)) {
      byMarker.set(displayNumber, testCase);
    }
  });

  const unresolved = wanted.filter((marker) => !byMarker.has(marker));
  if (unresolved.length) {
    const byInternalId = await fetchCasesByField(baseApiUrl, token, projectId, 'id_in', unresolved);
    byInternalId.forEach((testCase) => {
      const caseId = testCase && testCase.id !== undefined && testCase.id !== null ? String(testCase.id) : '';
      if (caseId && !byMarker.has(caseId)) {
        byMarker.set(caseId, testCase);
      }
    });
  }

  return byMarker;
}

/**
 * How a test case is named in a log line: the id a user can look up, with the
 * internal id alongside it so both spellings of a marker are recognisable.
 */
export function formatCaseLabel(caseId, displayNumberByCaseId) {
  const id = String(caseId);
  const displayNumber = displayNumberByCaseId ? displayNumberByCaseId.get(id) : undefined;
  return displayNumber ? `TC-${displayNumber} (internal id ${id})` : `internal id ${id}`;
}
