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
 * - --api-url        (defaults to https://api.testcollab.io)
 */

import fs from 'fs';
import {
  TestPlansApi,
  TestPlanTestCasesApi,
  TestPlansAssignmentApi,
  Configuration,
  ProjectsApi,
  UsersApi,
  TestCasesApi,
  ProjectUsersApi
} from 'testcollab-sdk';

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
    apiUrl
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
  const testPlansApi = new TestPlansApi(config);
  const testPlanCases = new TestPlanTestCasesApi(config);
  const testPlanAssignment = new TestPlansAssignmentApi(config);

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
    const projectResponse = await projectsApi.getProjects({
      filter: JSON.stringify({
        id: parsedProjectId
      })
    });
    if(!projectResponse || !projectResponse.length) {
      console.error('❌ Error: Project not found. Ensure you have access to this project.');
      process.exit(1);
    }
  } catch (e) {
    console.error('❌ Error: Failed to validate project. Ensure the project ID is correct and you have access.');
    // console.error(e);
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

  try {
    console.log('Step 1: Creating a new test plan...');
    const createResponse = await testPlansApi.addTestPlan({
      testPlanPayload: {
        project: parsedProjectId,
        title: `CI Test: ${getDate()}`,
        description: 'This is a test plan created using the Node.js SDK',
        status: 1,
        priority: 1,
        testPlanFolder: null,
        customFields: []
      }
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

    console.log('Step 3: Assigning the test plan to a user...');
    const assignmentResponse = await testPlanAssignment.assignTestPlan({
      project: parsedProjectId,
      testplan: testPlanId,
      testPlanAssignmentPayload: {
        executor: 'team',
        assignmentCriteria: 'testCase',
        assignmentMethod: 'automatic',
        assignment: {
          user: [parsedAssigneeId],
          testCases: { testCases: [], selector: [] },
          configuration: null
        },
        project: parsedProjectId,
        testplan: testPlanId
      }
    });

    console.log(assignmentResponse);

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


