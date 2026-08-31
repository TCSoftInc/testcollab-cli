/**
 * Report one assigned execution immediately.
 *
 * This deliberately uses the same ExecutedTestCase endpoints as the Run screen
 * and `tc report`. The credential decides who executed the case; accepting a
 * reporter id here would let callers impersonate somebody else.
 */

import fs from 'fs';
import path from 'path';

import { resolveAttachments } from '../lib/attachments.js';
import { TcApiClient, encodeComment } from './report.js';

const relationId = (value) =>
  value && typeof value === 'object' ? value.id : value;

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function optionalPositiveNumber(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be greater than zero`);
  }
  return parsed;
}

function readStepResults(filePath) {
  if (!filePath) return null;
  const absolutePath = path.resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read --step-results-file: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--step-results-file must contain a JSON array');
  }
  return parsed;
}

function normalizeAttachments(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function findExecutionQuery({ projectId, testPlanRunId, executedTestCaseId }) {
  const params = new URLSearchParams({
    project: String(projectId),
    regression: String(testPlanRunId),
    id: String(executedTestCaseId),
    _limit: '1'
  });
  return `/executedtestcases?${params.toString()}`;
}

/**
 * Throwing implementation used by tests and other commands.
 */
export async function reportSingleCase(options) {
  const apiKey = options.apiKey || process.env.TESTCOLLAB_TOKEN;
  if (!apiKey) {
    throw new Error('No API key provided. Pass --api-key or set TESTCOLLAB_TOKEN.');
  }

  const projectId = positiveInteger(options.project, '--project');
  const testPlanRunId = positiveInteger(options.testPlanRunId, '--test-plan-run-id');
  const executedTestCaseId = positiveInteger(
    options.executedTestCaseId,
    '--executed-test-case-id'
  );
  const status = String(options.status || '').trim();
  if (!status) throw new Error('--status is required');

  const timeTaken = optionalPositiveNumber(options.timeTaken, '--time-taken');
  const stepWiseResult = readStepResults(options.stepResultsFile);
  const attachmentPaths = normalizeAttachments(options.attachment);

  const client = new TcApiClient({
    accessToken: apiKey,
    projectId,
    testPlanId: 0,
    baseApiUrl: options.apiUrl
  });

  const rows = await client.request(
    findExecutionQuery({ projectId, testPlanRunId, executedTestCaseId })
  );
  const execution = Array.isArray(rows) ? rows[0] : null;
  if (!execution || Number(execution.id) !== executedTestCaseId) {
    throw new Error(
      `Executed test case ${executedTestCaseId} was not found in test plan run ${testPlanRunId}`
    );
  }

  const executionProjectId = relationId(execution.project);
  const executionRunId = relationId(execution.regression);
  if (
    Number(executionProjectId) !== projectId ||
    Number(executionRunId) !== testPlanRunId
  ) {
    throw new Error('The executed test case does not belong to the requested project and run');
  }

  const testPlanId = relationId(execution.test_plan);
  const testPlanTestCaseId = relationId(execution.test_plan_test_case);
  if (!testPlanId || !testPlanTestCaseId) {
    throw new Error('The executed test case is missing its test plan relationship');
  }

  const updatePayload = {
    id: executedTestCaseId,
    test_plan_test_case: testPlanTestCaseId,
    project: projectId,
    status,
    test_plan: testPlanId
  };
  const testPlanConfigId = relationId(execution.test_plan_config);
  if (testPlanConfigId) updatePayload.test_plan_config = testPlanConfigId;
  if (options.comment !== undefined) {
    updatePayload.comment = encodeComment(options.comment);
  }
  if (stepWiseResult) updatePayload.step_wise_result = stepWiseResult;

  const updated = await client.request(`/executedtestcases/${executedTestCaseId}`, {
    method: 'PUT',
    body: updatePayload
  });
  if (!updated || !updated.id) {
    throw new Error(`TestCollab did not confirm execution ${executedTestCaseId}`);
  }

  if (timeTaken !== null) {
    await client.request(`/executedtestcases/${executedTestCaseId}/updateTimeTaken`, {
      method: 'PUT',
      body: { time_taken: timeTaken, project: projectId }
    });
  }

  let attachmentsUploaded = 0;
  if (attachmentPaths.length) {
    const project = await client.request(`/projects/${projectId}`);
    const companyId = relationId(project && project.company);
    if (!companyId) throw new Error(`Project ${projectId} is missing its company`);

    const resolved = resolveAttachments(attachmentPaths, [process.cwd()]);
    if (resolved.warnings.length) {
      throw new Error(resolved.warnings.join('; '));
    }

    const attachmentIds = [];
    for (const file of resolved.files) {
      attachmentIds.push(
        await client.uploadAttachmentFile({ ...file, companyId })
      );
    }
    if (attachmentIds.length) {
      await client.linkAttachments(executedTestCaseId, attachmentIds);
      attachmentsUploaded = attachmentIds.length;
    }
  }

  return {
    id: executedTestCaseId,
    status,
    attachmentsUploaded,
    result: updated
  };
}

export async function reportCase(options) {
  try {
    const result = await reportSingleCase(options);
    console.log(
      `✅ Executed test case ${result.id} reported as ${result.status}` +
        (result.attachmentsUploaded
          ? ` with ${result.attachmentsUploaded} attachment(s)`
          : '')
    );
    return result;
  } catch (error) {
    console.error(`❌ Error: ${error?.message || String(error)}`);
    process.exitCode = 1;
    return null;
  }
}

export function collectAttachment(value, previous) {
  return (previous || []).concat(value);
}
