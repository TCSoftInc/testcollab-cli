/**
 * createTestPlan.js
 *
 * Creates a Test Plan in TestCollab, adds CI-tagged test cases,
 * and assigns the plan to a user.
 *
 * Options map from previous env vars:
 * - --api-key        (TESTCOLLAB_API_KEY)
 * - --project        (TESTCOLLAB_PROJECT_ID)
 * - --ci-tag-id      (TESTCOLLAB_CI_TAG_ID)
 * - --assignee-id    (TESTCOLLAB_ASSIGNEE_ID)
 * - --company-id     (TESTCOLLAB_COMPANY_ID) [accepted, not required]
 * - --api-url        (defaults to https://api.testcollab.io)
 */

import fs from 'fs';
import {
  TestPlansApi,
  TestPlanTestCasesApi,
  TestPlansAssignmentApi,
  Configuration
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
    apiKey,
    project,
    ciTagId,
    assigneeId,
    companyId,
    // nodeEnv,
    apiUrl
  } = options;
  // // Apply node env if provided
  // if (nodeEnv) {
  //   process.env.NODE_ENV = nodeEnv;
  // }

  // Normalize/Default API base URL
  const effectiveApiUrl = (apiUrl && String(apiUrl).trim())
    ? String(apiUrl).trim().replace(/\/+$/, '')
    : 'https://api.testcollab.io';

  // Validate required inputs
  if (!apiKey) {
    console.error('❌ Error: --api-key is required (was TESTCOLLAB_API_KEY)');
    process.exit(1);
  }
  if (!project) {
    console.error('❌ Error: --project is required (was TESTCOLLAB_PROJECT_ID)');
    process.exit(1);
  }
  if (!ciTagId) {
    console.error('❌ Error: --ci-tag-id is required (was TESTCOLLAB_CI_TAG_ID)');
    process.exit(1);
  }
  if (!assigneeId) {
    console.error('❌ Error: --assignee-id is required (was TESTCOLLAB_ASSIGNEE_ID)');
    process.exit(1);
  }

  const parsedProjectId = Number(project);
  const parsedTagId = Number(ciTagId);
  const parsedAssigneeId = Number(assigneeId);
  const parsedCompanyId = Number(companyId);

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
  if (Number.isNaN(parsedCompanyId)) {
    console.error('❌ Error: --company-id must be a number');
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
    await testPlanCases.bulkAddTestPlanTestCases({
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


