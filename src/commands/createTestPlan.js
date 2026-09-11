/**
 * createTestPlan.js
 *
 * Creates a Test Plan in TestCollab, adds CI-tagged test cases,
 * and assigns the plan to a user.
 *
 * Options:
 * - --api-key        API token
 * - --project        Project ID
 * - --ci-tag-id      Tag ID to select test cases
 * - --assignee-id    User ID to assign the plan
 * - --build          Build id or version string the plan is executed against (TCV-6788)
 * - --release        Release ID the plan belongs to (TCV-6788)
 * - --override-assignees  Give --assignee-id every test case, replacing the
 *                    default assignees inherited from the test cases (TCV-6891)
 * - --api-url        (defaults to TESTCOLLAB_API_URL, then https://api.testcollab.io)
 */

import fs from 'fs';
import {
  TestPlanTestCasesApi,
  Configuration,
  ProjectsApi,
  UsersApi,
  TestCasesApi,
  ProjectUsersApi
} from 'testcollab-sdk';

// TCV-6788: the build/release lookups and the plan create go through direct
// requests instead of the SDK — the published SDK's TestPlanPayload does not
// carry `build`/`release`, and its serializer drops keys it does not know.
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

function relationId(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'object' ? value.id : value;
}

/**
 * TCV-6788: the builds whose version matches `version` exactly (trimmed,
 * case-insensitive). The server-side filter is re-applied on the client so a
 * looser match can never silently link the plan to the wrong build.
 */
export function selectBuildsByVersion(builds, version) {
  const wanted = String(version === undefined || version === null ? '' : version)
    .trim()
    .toLowerCase();
  const list = Array.isArray(builds) ? builds : [];
  return list.filter(
    (build) => String(build?.version ?? '').trim().toLowerCase() === wanted
  );
}

/**
 * TCV-6788: resolve a --build value (build id or version string) to a build of
 * the project. A numeric value is looked up as an id first and retried as a
 * version, so a pipeline can pass a numeric version (e.g. a build number).
 * Throws when the build cannot be resolved — the caller aborts before creating
 * the plan, so a pipeline never ends up with an unlinked plan.
 */
export async function resolveBuild(baseApiUrl, token, projectId, buildRef) {
  const raw = String(buildRef).trim();

  if (/^\d+$/.test(raw)) {
    let build = null;
    try {
      build = await apiRequest(baseApiUrl, token, `/builds/${raw}`);
    } catch (error) {
      if (error?.status !== 404) {
        throw error;
      }
    }
    if (build && relationId(build.project) === projectId) {
      return build;
    }
  }

  const builds = await apiRequest(
    baseApiUrl,
    token,
    `/builds?project=${projectId}&version=${encodeURIComponent(raw)}`
  );
  const matches = selectBuildsByVersion(builds, raw);

  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} builds in project ${projectId} have version "${raw}" ` +
        `(ids: ${matches.map((b) => b.id).join(', ')}). Pass --build <id> to pick one.`
    );
  }
  throw new Error(
    `No build ${/^\d+$/.test(raw) ? 'with id or version' : 'with version'} "${raw}" ` +
      `found in project ${projectId}. Create the build in TestCollab first, then re-run.`
  );
}

function getDate() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
}

export async function createTestPlan(options) {
  const {
    project,
    ciTagId,
    assigneeId,
    apiUrl,
    build,
    release,
    overrideAssignees
  } = options;

  // Resolve API key: --api-key flag takes precedence, then TESTCOLLAB_TOKEN env var
  const apiKey = options.apiKey || process.env.TESTCOLLAB_TOKEN;

  // Normalize/Default API base URL
  const effectiveApiUrl = (apiUrl && String(apiUrl).trim())
    ? String(apiUrl).trim().replace(/\/+$/, '')
    : 'https://api.testcollab.io';

  // Validate required inputs
  if (!apiKey) {
    console.error('❌ Error: No API key provided');
    console.error('   Pass --api-key <key> or set the TESTCOLLAB_TOKEN environment variable.');
    process.exit(1);
  }
  if (!project) {
    console.error('❌ Error: --project is required');
    process.exit(1);
  }
  if (!ciTagId) {
    console.error('❌ Error: --ci-tag-id is required');
    process.exit(1);
  }
  if (!assigneeId) {
    console.error('❌ Error: --assignee-id is required');
    process.exit(1);
  }

  const parsedProjectId = Number(project);
  const parsedTagId = Number(ciTagId);
  const parsedAssigneeId = Number(assigneeId);

  if (Number.isNaN(parsedProjectId)) {
    console.error('❌ Error: --project must be a number');
    process.exit(1);
  }
  if (Number.isNaN(parsedTagId)) {
    console.error('❌ Error: --ci-tag-id must be a number');
    process.exit(1);
  }
  if (Number.isNaN(parsedAssigneeId)) {
    console.error('❌ Error: --assignee-id must be a number');
    process.exit(1);
  }

  // TCV-6788: --release is always an id; --build takes an id or a version string.
  let parsedReleaseId = null;
  if (release !== undefined) {
    parsedReleaseId = Number(release);
    if (!Number.isInteger(parsedReleaseId) || parsedReleaseId <= 0) {
      console.error('❌ Error: --release must be a release ID');
      process.exit(1);
    }
  }
  if (build !== undefined && !String(build).trim()) {
    console.error('❌ Error: --build must be a build ID or a version string');
    process.exit(1);
  }

  // Configure SDK with token and base URL via fetchApi hook
  const config = new Configuration({
    basePath: effectiveApiUrl,
    fetchApi: (url, opts) => {
      const separator = url.includes('?') ? '&' : '?';
      const urlWithToken = `${url}${separator}token=${apiKey}`;
      return fetch(urlWithToken, opts);
    }
  });

  const projectsApi = new ProjectsApi(config);
  const usersApi = new UsersApi(config);
  const tcApi = new TestCasesApi(config);
  const projectUsersApi = new ProjectUsersApi(config);
  const testPlanCases = new TestPlanTestCasesApi(config);

  // Ensure tmp directory exists and remove old id file if present
  try {
    if (!fs.existsSync('tmp')) {
      fs.mkdirSync('tmp', { recursive: true });
    }
    if (fs.existsSync('tmp/tc_test_plan')) {
      fs.unlinkSync('tmp/tc_test_plan');
    }
  } catch (e) {
    // Non-fatal; continue
  }

  console.log('validating project and other details...');
  try {
    const projectResponse = await projectsApi.getProject({
      id: parsedProjectId
    });
    if (!projectResponse || !projectResponse.id || projectResponse.id !== parsedProjectId) {
      console.error('❌ Error: Project not found. Ensure you have access to this project.');
      process.exit(1);
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'status' in e && 'text' in e) {
      try {
        const bodyText = await e.text();
        console.error(`❌ Error: Failed to validate project (HTTP ${e.status} ${e.statusText || ''}${bodyText ? ` - ${bodyText}` : ''})`);
      } catch {
        console.error(`❌ Error: Failed to validate project (HTTP ${e.status} ${e.statusText || ''})`);
      }
    } else {
      const message = e?.message || String(e);
      console.error(`❌ Error: Failed to validate project (${message})`);
    }
    process.exit(1);
  }

  try {
    const tagResponse = await tcApi.getTestCasesTags({
      project: parsedProjectId,
      filter: JSON.stringify({
        id: parsedTagId
      })
    });
    if(!tagResponse || !tagResponse.length || !tagResponse[0].id || tagResponse[0].id !== parsedTagId) {
      console.error('❌ Error: Tag not found or tag does not belong to the project');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Error: Invalid tag ID or tag does not belong to the project');
    // console.error(e);
    process.exit(1);
  }

  try{
    let projectUsers = await projectUsersApi.getProjectUsers({
      project: parsedProjectId,
      limit: -1
    });
    if(!projectUsers || !projectUsers.length) {
      console.error('❌ Error: Invalid assignee or assignee does not have access to the project');
      process.exit(1);
    }
    let assigneeFound = false;
    for(let i = 0; i < projectUsers.length; i++) {
      if(projectUsers[i].user.id === parsedAssigneeId) {
        assigneeFound = true;
        break;
      }
    }
    if(!assigneeFound) {
      console.error('❌ Error: Invalid assignee or assignee does not have access to the project');
      process.exit(1);
    }
  }catch (e) {
    console.error('❌ Error: Invalid assignee or assignee does not have access to the project');
    // console.error(e);
    process.exit(1);
  }

  // TCV-6788: resolve the build before the plan is created, so a version that
  // has not been recorded as a build yet fails here instead of leaving an
  // unlinked plan behind.
  let resolvedBuild = null;
  if (build !== undefined) {
    try {
      resolvedBuild = await resolveBuild(effectiveApiUrl, apiKey, parsedProjectId, build);
      console.log(`Build: ${resolvedBuild.version} (id ${resolvedBuild.id})`);
    } catch (e) {
      console.error(`❌ Error: ${e?.message || String(e)}`);
      process.exit(1);
    }
  }

  const testPlanPayload = {
    project: parsedProjectId,
    title: `CI Test: ${getDate()}`,
    description: 'This is a test plan created using the Node.js SDK',
    status: 1,
    priority: 1,
    test_plan_folder: null,
    custom_fields: []
  };
  if (resolvedBuild) {
    testPlanPayload.build = resolvedBuild.id;
  }
  if (parsedReleaseId !== null) {
    testPlanPayload.release = parsedReleaseId;
  }

  try {
    console.log('Step 1: Creating a new test plan...');
    const createResponse = await apiRequest(effectiveApiUrl, apiKey, '/testplans', {
      method: 'POST',
      body: testPlanPayload
    });

    const testPlanId = createResponse.id;
    console.log(`Test Plan ID: ${testPlanId}`);

    console.log('Step 2: Adding test cases (matching CI tag) to the test plan...');
    let tptcAddResult = await testPlanCases.bulkAddTestPlanTestCases({
      testPlanTestCaseBulkAddPayload: {
        testplan: testPlanId,
        testCaseCollection: {
          testCases: [],
          selector: [
            {
              field: 'tags',
              operator: 'jsonstring_2',
              value: `{"filter":[[${parsedTagId}]],"type":"equals","filterType":"number"}`
            }
          ]
        }
      }
    });
    if(tptcAddResult && tptcAddResult.status === false) {
      console.error('❌ Error: Failed to add test cases to the test plan');
      console.error(tptcAddResult);
      process.exit(1);
    }

    // TCV-6891: a test case can carry a default assignee (TCV-6779), which step 2
    // copies onto the plan. The pipeline decides whether --assignee-id replaces
    // those or only covers the cases that have none. This goes through
    // apiRequest instead of the SDK because the published SDK's
    // TestPlanAssignmentPayload serializer drops keys it does not know, so
    // `override_existing_assignees` would never reach the API.
    console.log(
      overrideAssignees === true
        ? `Step 3: Assigning every test case to user ${parsedAssigneeId} (default assignees overridden)...`
        : `Step 3: Assigning unassigned test cases to user ${parsedAssigneeId} (default assignees kept)...`
    );
    const assignmentResponse = await apiRequest(
      effectiveApiUrl,
      apiKey,
      `/testplans/assign?testplan=${testPlanId}&project=${parsedProjectId}`,
      {
        method: 'POST',
        body: {
          executor: 'team',
          assignment_criteria: 'testCase',
          assignment_method: 'automatic',
          assignment: {
            user: [parsedAssigneeId],
            testCases: { testCases: [], selector: [] },
            configuration: null
          },
          project: parsedProjectId,
          testplan: testPlanId,
          override_existing_assignees: overrideAssignees === true
        }
      }
    );

    if (assignmentResponse && assignmentResponse.assignments_preserved) {
      console.log(
        '   Every test case already had an assignee, so nothing was reassigned. ' +
          'Pass --override-assignees to give them all to --assignee-id.'
      );
    }

    // Persist test plan id
    fs.writeFileSync('tmp/tc_test_plan', `TESTCOLLAB_TEST_PLAN_ID=${testPlanId}`);
    console.log('✅ Test plan created and assigned successfully.');
  } catch (error) {
    // console.error("ERROR:", error);
    // Improve error visibility if error is a Response-like object
    if (error && typeof error === 'object' && 'status' in error && 'text' in error) {
      try {
        const bodyText = await error.text();
        console.error(`❌ Error: HTTP ${error.status} ${error.statusText || ''} - ${bodyText}`);
      } catch {
        console.error(`❌ Error: HTTP ${error.status} ${error.statusText || ''}`);
      }
    } else {
      const message = error?.message || String(error);
      console.error(`❌ Error: ${message}`);
    }
    process.exit(1);
  }
}

