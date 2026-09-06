/**
 * Report one assigned execution immediately.
 *
 * This deliberately uses the same ExecutedTestCase endpoints as the Run screen
 * and `tc report`. The credential decides who executed the case; accepting a
 * reporter id here would let callers impersonate somebody else.
 */

import fs from 'fs';
import path from 'path';

import { MAX_ATTACHMENT_BYTES, resolveAttachments } from '../lib/attachments.js';
import { TcApiClient, encodeComment } from './report.js';

export const APPROVED_AGENT_ARTIFACT_ROOT = '/agent/approved-artifacts';
export const AGENT_RUN_MANIFEST = '/agent/run.json';
const APPROVED_ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_AGENT_RUN_MANIFEST_BYTES = 1024 * 1024;

const rejectUnapprovedAttachment = () => {
  throw new Error('Agent attachments must be immutable copies approved by the Secret helper');
};

/**
 * Resolve Agent mode without trusting only a mutable child-process environment.
 * The model can unset TC_AGENT_RUN_ID, but it cannot replace the root-owned run
 * manifest written by the harness. This remains defense in depth; backend
 * authorization is still required to close direct API and bulk-report bypasses.
 */
export function resolveAgentRunId(environment = {}, options = {}) {
  const filesystem = options.filesystem || fs;
  const manifestPath = options.manifestPath || AGENT_RUN_MANIFEST;
  const trustedUid = options.trustedUid === undefined ? 0 : options.trustedUid;
  const trustedGid = options.trustedGid === undefined ? 0 : options.trustedGid;
  const environmentRunId = String(environment.TC_AGENT_RUN_ID || '');
  if (environmentRunId && !/^[1-9][0-9]*$/.test(environmentRunId)) {
    rejectUnapprovedAttachment();
  }

  let manifestRunId = '';
  let fd = null;
  try {
    fd = filesystem.openSync(
      manifestPath,
      filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW
    );
    const stat = filesystem.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== trustedUid ||
      stat.gid !== trustedGid ||
      (stat.mode & 0o022) !== 0 ||
      stat.size <= 0 ||
      stat.size > MAX_AGENT_RUN_MANIFEST_BYTES
    ) {
      rejectUnapprovedAttachment();
    }
    const manifest = JSON.parse(filesystem.readFileSync(fd, 'utf8'));
    manifestRunId = String(manifest && manifest.agent_run || '');
    if (!/^[1-9][0-9]*$/.test(manifestRunId)) rejectUnapprovedAttachment();
  } catch (error) {
    if (!error || error.code !== 'ENOENT') rejectUnapprovedAttachment();
  } finally {
    if (fd !== null) filesystem.closeSync(fd);
  }

  if (environmentRunId && manifestRunId && environmentRunId !== manifestRunId) {
    rejectUnapprovedAttachment();
  }
  return environmentRunId || manifestRunId || null;
}

/**
 * Verify the local capability represented by a promoted artifact path. This is
 * deliberately a local safe-path control, not backend authorization: the root
 * helper owns the parent and file, so the model uid cannot replace either
 * between this check and the upload reopen.
 */
export function verifyApprovedAgentAttachments(rawPaths, options = {}) {
  const filesystem = options.filesystem || fs;
  const root = options.root || APPROVED_AGENT_ARTIFACT_ROOT;
  const runId = String(options.runId || '');
  const trustedUid = options.trustedUid === undefined ? 0 : options.trustedUid;
  const trustedGid = options.trustedGid === undefined ? 0 : options.trustedGid;
  if (!/^[1-9][0-9]*$/.test(runId) || !Number.isInteger(filesystem.constants.O_NOFOLLOW)) {
    rejectUnapprovedAttachment();
  }

  let rootStat;
  try {
    rootStat = filesystem.lstatSync(root);
  } catch {
    rejectUnapprovedAttachment();
  }
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== trustedUid ||
    rootStat.gid !== trustedGid ||
    (rootStat.mode & 0o777) !== 0o755
  ) {
    rejectUnapprovedAttachment();
  }

  const seen = new Set();
  return (rawPaths || []).map((rawPath) => {
    const candidate = String(rawPath || '');
    if (
      !path.isAbsolute(candidate) ||
      path.normalize(candidate) !== candidate ||
      candidate.includes('\u0000') ||
      seen.has(candidate)
    ) {
      rejectUnapprovedAttachment();
    }
    const relative = path.relative(root, candidate);
    const parts = relative.split(path.sep);
    if (
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      parts.length !== 2 ||
      !new RegExp(`^request-${runId}-[a-f0-9]{32}$`).test(parts[0]) ||
      !APPROVED_ARTIFACT_NAME_PATTERN.test(parts[1])
    ) {
      rejectUnapprovedAttachment();
    }

    const requestDirectory = path.join(root, parts[0]);
    let requestStat;
    let fileStat;
    let fd = null;
    try {
      requestStat = filesystem.lstatSync(requestDirectory);
      fileStat = filesystem.lstatSync(candidate);
      if (
        !requestStat.isDirectory() ||
        requestStat.isSymbolicLink() ||
        requestStat.uid !== trustedUid ||
        requestStat.gid !== trustedGid ||
        (requestStat.mode & 0o777) !== 0o555 ||
        !fileStat.isFile() ||
        fileStat.isSymbolicLink() ||
        fileStat.uid !== trustedUid ||
        fileStat.gid !== trustedGid ||
        fileStat.nlink !== 1 ||
        (fileStat.mode & 0o777) !== 0o444 ||
        fileStat.size > MAX_ATTACHMENT_BYTES
      ) {
        rejectUnapprovedAttachment();
      }
      fd = filesystem.openSync(
        candidate,
        filesystem.constants.O_RDONLY | filesystem.constants.O_NOFOLLOW
      );
      const opened = filesystem.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== fileStat.dev ||
        opened.ino !== fileStat.ino ||
        opened.size !== fileStat.size ||
        opened.nlink !== 1 ||
        opened.uid !== trustedUid ||
        opened.gid !== trustedGid ||
        (opened.mode & 0o777) !== 0o444
      ) {
        rejectUnapprovedAttachment();
      }
    } catch {
      rejectUnapprovedAttachment();
    } finally {
      if (fd !== null) filesystem.closeSync(fd);
    }
    seen.add(candidate);
    return candidate;
  });
}

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
export async function reportSingleCase(options, dependencies = {}) {
  const environment = dependencies.environment || process.env;
  const apiKey = options.apiKey || environment.TESTCOLLAB_TOKEN;
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
  let attachmentPaths = normalizeAttachments(options.attachment);
  if (attachmentPaths.length) {
    const agentRunId = resolveAgentRunId(environment, {
      filesystem: dependencies.filesystem,
      manifestPath: dependencies.agentManifestPath,
      trustedUid: dependencies.trustedUid,
      trustedGid: dependencies.trustedGid,
    });
    // Human CLI use outside an Agent container retains ordinary attachment
    // behavior. Agent mode is recognized by either immutable harness state or
    // the run-scoped environment marker.
    if (agentRunId) {
      attachmentPaths = verifyApprovedAgentAttachments(attachmentPaths, {
        runId: agentRunId,
        root: dependencies.approvedArtifactRoot,
        trustedUid: dependencies.trustedUid,
        trustedGid: dependencies.trustedGid,
        filesystem: dependencies.filesystem,
      });
    }
  }

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
