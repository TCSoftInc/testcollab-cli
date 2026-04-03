/**
 * report.js
 *
 * Upload test run results to TestCollab and attach them to a Test Plan.
 * Supports:
 * - Mochawesome JSON
 * - JUnit XML
 *
 * This command follows the same direct execution-update flow used by the
 * cypress reporter plugin: it validates context, fetches assigned executed
 * cases, and updates each executed test case directly.
 */

import fs from 'fs';
import path from 'path';
import {
  Configuration,
  TestCasesApi,
  SuitesApi,
  TestPlanFoldersApi,
  TestPlansApi,
  TestPlanTestCasesApi,
  TestPlansAssignmentApi,
  UsersApi,
  ProjectsApi
} from 'testcollab-sdk';

const RUN_RESULT_MAP = {
  pass: 1,
  fail: 2,
  skip: 3,
  block: 4,
  unexecuted: 0
};

const SYSTEM_STATUS = {
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped'
};

const TC_ID_PATTERNS = [
  /\[\s*TC-(\d+)\s*\]/i,
  /\bTC-(\d+)\b/i,
  /\bid-(\d+)\b/i,
  /\btestcase-(\d+)\b/i
];

const CONFIG_ID_PATTERNS = [
  /\bconfig-id-(\d+)\b/i,
  /\bconfig-(\d+)\b/i,
  /\[\s*config-id-(\d+)\s*\]/i
];

/**
 * Humanize a raw test suite name from test runners.
 *
 * Handles Java packages, file paths, common suffixes, and casing conventions.
 *
 * Examples:
 *   "com.foo.bar.LoginTests"     → "Login"
 *   "tests/auth/login.spec.ts"   → "Login"
 *   "UserProfileTests"           → "User Profile"
 *   "user_profile_spec"          → "User Profile"
 *   "my-component-test"          → "My Component"
 *   ""                           → "Uncategorized"
 */
export function humanizeSuiteName(raw) {
  let name = String(raw || '').trim();
  if (!name) {
    return 'Uncategorized';
  }

  // 1. Strip file path prefix (everything before the last / or \)
  name = name.replace(/^.*[/\\]/, '');

  // 2. Strip common test file extensions (before package prefix to avoid matching "login.spec" as package)
  name = name.replace(/\.(spec|test|tests)\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|rb|go)$/i, '');
  name = name.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|rb|go)$/i, '');

  // 3. Strip Java-style package prefix (all-lowercase dot-separated segments before a capitalized class name)
  //    e.g. "com.foo.bar.LoginTests" → "LoginTests"
  name = name.replace(/^(?:[a-z][a-z0-9]*\.)+/, '');

  // 4. Strip common test suffixes at end of name
  name = name.replace(/(Tests|Test|Spec|Suite|Specs)$/i, '');

  // 5. Split camelCase: "UserProfile" → "User Profile"
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // 6. Split snake_case and kebab-case: "user_profile" or "user-profile" → "user profile"
  name = name.replace(/[_-]+/g, ' ');

  // 7. Collapse whitespace and trim
  name = name.replace(/\s+/g, ' ').trim();

  // 8. Title case each word
  name = name
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  return name || 'Uncategorized';
}

/**
 * Normalize a test case title for comparison.
 * Lowercase, trim, collapse all whitespace to a single space.
 */
export function normalizeTitle(title) {
  return String(title || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function toAbsolutePath(inputPath) {
  return path.isAbsolute(inputPath) ? inputPath : path.join(process.cwd(), inputPath);
}

function getBaseApiUrl(apiUrl) {
  if (apiUrl && String(apiUrl).trim()) {
    return String(apiUrl).trim().replace(/\/+$/, '');
  }
  if (process.env.NODE_ENV === 'production') {
    return 'https://api.testcollab.io';
  }
  if (process.env.NODE_ENV === 'staging') {
    return 'https://api.testcollab-dev.io';
  }
  return 'http://localhost:1337';
}

function decodeXmlEntities(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#([0-9]+);/g, (_, decimal) => {
      try {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      } catch {
        return '';
      }
    })
    .replace(/&amp;/g, '&');
}

function parseXmlAttributes(input) {
  const attrs = {};
  const attrRegex = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;

  while ((match = attrRegex.exec(input)) !== null) {
    const key = match[1];
    const value = match[3] !== undefined ? match[3] : match[4];
    attrs[key] = decodeXmlEntities(value);
  }

  return attrs;
}

function getFailureDetails(body) {
  const expandedFailure = body.match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>/i);
  if (expandedFailure) {
    const attrs = parseXmlAttributes(expandedFailure[2] || '');
    return {
      message: attrs.message || attrs.type || '',
      stack: decodeXmlEntities((expandedFailure[3] || '').trim())
    };
  }

  const shortFailure = body.match(/<(failure|error)\b([^>]*)\/>/i);
  if (shortFailure) {
    const attrs = parseXmlAttributes(shortFailure[2] || '');
    return {
      message: attrs.message || attrs.type || '',
      stack: ''
    };
  }

  return {
    message: '',
    stack: ''
  };
}

function collectAllTestsFromSuite(suite, parentSuiteName) {
  try {
    const suiteName = (suite && suite.title) || parentSuiteName || '';
    const rawTests = suite && Array.isArray(suite.tests) ? suite.tests : [];
    const tests = rawTests.map(t => Object.assign({}, t, { _suiteName: suiteName }));
    const childSuites = suite && Array.isArray(suite.suites) ? suite.suites : [];
    childSuites.forEach((childSuite) => {
      const nestedTests = collectAllTestsFromSuite(childSuite, suiteName);
      if (nestedTests && nestedTests.length) {
        tests.push(...nestedTests);
      }
    });
    return tests;
  } catch {
    return [];
  }
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function durationMsToSeconds(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  return Math.ceil(durationMs / 1000);
}

function durationSecondsToSeconds(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  return Math.ceil(durationSeconds);
}

function getTestState(testData) {
  const state = String(testData?.state || '').toLowerCase();
  if (testData?.pass === true || state === SYSTEM_STATUS.PASSED) {
    return SYSTEM_STATUS.PASSED;
  }
  if (testData?.fail === true || state === SYSTEM_STATUS.FAILED) {
    return SYSTEM_STATUS.FAILED;
  }
  return SYSTEM_STATUS.SKIPPED;
}

function toRunStatus(status) {
  if (status === SYSTEM_STATUS.PASSED) {
    return RUN_RESULT_MAP.pass;
  }
  if (status === SYSTEM_STATUS.FAILED) {
    return RUN_RESULT_MAP.fail;
  }
  return RUN_RESULT_MAP.skip;
}

function getConfigIdFromSuiteTitle(title) {
  const value = String(title || '');
  const match = /^config-id-(\d+)$/i.exec(value.trim());
  return match && match[1] ? match[1] : null;
}

export function extractConfigIdFromText(text) {
  const normalizedText = String(text || '');
  for (const pattern of CONFIG_ID_PATTERNS) {
    const match = normalizedText.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

export function extractTestCaseIdFromTitle(title) {
  const normalizedTitle = String(title || '');

  const suffix = normalizedTitle.split('-').pop();
  if (suffix && /^\d+$/.test(suffix)) {
    return suffix;
  }

  for (const pattern of TC_ID_PATTERNS) {
    const match = normalizedTitle.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

function extractTestCaseIdFromMochawesomeTest(testData) {
  const testTitle = String(testData?.title || '').trim();
  const fullTitle = String(testData?.fullTitle || '').trim();
  // Prefer fullTitle because some reporters shorten `title` and keep the canonical ID in fullTitle.
  return extractTestCaseIdFromTitle(fullTitle) || extractTestCaseIdFromTitle(testTitle);
}

function prepareMochawesomeRunRecord(testData) {
  if (!testData || typeof testData !== 'object') {
    return null;
  }

  const tcId = extractTestCaseIdFromMochawesomeTest(testData);
  if (!tcId) {
    return null;
  }

  const testState = getTestState(testData);
  const status = toRunStatus(testState);
  const errMessage = String(testData?.err?.message || '').trim();
  const errStack = String(testData?.err?.estack || testData?.err?.stack || '').trim();
  const errDetails = errStack || errMessage || null;

  const durationRaw = Number.parseInt(testData?.duration, 10);
  const duration = durationMsToSeconds(durationRaw);

  const title = String(testData?.fullTitle || testData?.title || '').trim() || '(Unnamed test case)';

  return {
    tcId,
    status,
    errDetails,
    title,
    duration
  };
}

function readMochawesomePayload(absResultPath) {
  const rawContent = fs.readFileSync(absResultPath, 'utf8');
  let payload;
  try {
    payload = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(`Invalid Mochawesome JSON: ${error?.message || String(error)}`);
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Mochawesome result content is empty or invalid');
  }
  if (!Array.isArray(payload.results) || payload.results.length === 0) {
    throw new Error('Mochawesome payload has no results');
  }

  return payload;
}

export function parseMochawesomeReport(payload) {
  const reportData = payload;
  if (!reportData || typeof reportData !== 'object') {
    throw new Error('Mochawesome result content is empty or invalid');
  }
  if (!Array.isArray(reportData.results) || !reportData.results.length) {
    throw new Error('Mochawesome payload has no results');
  }

  const resultsToUpload = {};
  const unresolvedIds = [];
  const allTests = [];
  let hasConfig = false;
  let tests = 0;
  let passes = 0;
  let failures = 0;
  let skipped = 0;

  reportData.results.forEach((fileResult) => {
    let topSuites = fileResult && Array.isArray(fileResult.suites) ? fileResult.suites : [];
    if (!topSuites.length && fileResult && Array.isArray(fileResult.tests) && fileResult.tests.length) {
      // Some reporters emit tests directly on the top result object.
      topSuites = [fileResult];
    }
    if (!topSuites.length) {
      return;
    }

    const configSuites = topSuites
      .map((suite) => ({ suite, id: getConfigIdFromSuiteTitle(suite?.title) }))
      .filter((entry) => Boolean(entry.id));

    const allTopSuitesAreConfigs = configSuites.length > 0 && configSuites.length === topSuites.length;

    if (allTopSuitesAreConfigs) {
      hasConfig = true;
      configSuites.forEach(({ suite, id }) => {
        const testsInSuite = collectAllTestsFromSuite(suite);
        testsInSuite.forEach((testData) => {
          const state = getTestState(testData);
          tests += 1;
          if (state === SYSTEM_STATUS.PASSED) {
            passes += 1;
          } else if (state === SYSTEM_STATUS.FAILED) {
            failures += 1;
          } else {
            skipped += 1;
          }

          const title = String(testData?.fullTitle || testData?.title || '').trim() || '(Unnamed test case)';
          const tcId = extractTestCaseIdFromMochawesomeTest(testData);
          const errMessage = String(testData?.err?.message || '').trim();
          const errStack = String(testData?.err?.estack || testData?.err?.stack || '').trim();
          const durationRaw = Number.parseInt(testData?.duration, 10);

          allTests.push({
            title,
            suite: testData._suiteName || '',
            tcId: tcId || null,
            configId: id,
            status: toRunStatus(state),
            errDetails: errStack || errMessage || null,
            duration: durationMsToSeconds(durationRaw)
          });

          const runRecord = prepareMochawesomeRunRecord(testData);
          if (!runRecord) {
            unresolvedIds.push(title);
            return;
          }

          if (!resultsToUpload[id]) {
            resultsToUpload[id] = [];
          }
          resultsToUpload[id].push(runRecord);
        });
      });
      return;
    }

    topSuites.forEach((suite) => {
      const testsInSuite = collectAllTestsFromSuite(suite);
      testsInSuite.forEach((testData) => {
        const state = getTestState(testData);
        tests += 1;
        if (state === SYSTEM_STATUS.PASSED) {
          passes += 1;
        } else if (state === SYSTEM_STATUS.FAILED) {
          failures += 1;
        } else {
          skipped += 1;
        }

        const title = String(testData?.fullTitle || testData?.title || '').trim() || '(Unnamed test case)';
        const tcId = extractTestCaseIdFromMochawesomeTest(testData);
        const errMessage = String(testData?.err?.message || '').trim();
        const errStack = String(testData?.err?.estack || testData?.err?.stack || '').trim();
        const durationRaw = Number.parseInt(testData?.duration, 10);

        allTests.push({
          title,
          suite: testData._suiteName || '',
          tcId: tcId || null,
          configId: '0',
          status: toRunStatus(state),
          errDetails: errStack || errMessage || null,
          duration: durationMsToSeconds(durationRaw)
        });

        const runRecord = prepareMochawesomeRunRecord(testData);
        if (!runRecord) {
          unresolvedIds.push(title);
          return;
        }

        if (!resultsToUpload['0']) {
          resultsToUpload['0'] = [];
        }
        resultsToUpload['0'].push(runRecord);
      });
    });
  });

  if (!Object.keys(resultsToUpload).length && !allTests.length) {
    throw new Error('Could not parse results.');
  }

  if (!tests && reportData.stats && Number.isFinite(reportData.stats.tests)) {
    tests = reportData.stats.tests;
    passes = Number.isFinite(reportData.stats.passes) ? reportData.stats.passes : passes;
    failures = Number.isFinite(reportData.stats.failures) ? reportData.stats.failures : failures;
    const pending = Number.isFinite(reportData.stats.pending) ? reportData.stats.pending : 0;
    const explicitSkipped = Number.isFinite(reportData.stats.skipped) ? reportData.stats.skipped : 0;
    skipped = explicitSkipped || pending;
  }

  return {
    format: 'mochawesome',
    hasConfig,
    resultsToUpload,
    allTests,
    stats: {
      tests,
      passes,
      failures,
      skipped
    },
    unresolvedIds: unique(unresolvedIds)
  };
}

export function parseJUnitXml(junitXmlContent) {
  if (!junitXmlContent || typeof junitXmlContent !== 'string') {
    throw new Error('JUnit XML content is empty or invalid');
  }

  const testCases = [];
  const testcaseRegex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let match;

  while ((match = testcaseRegex.exec(junitXmlContent)) !== null) {
    const attrs = parseXmlAttributes(match[1] || '');
    const body = match[2] || '';

    const rawName = (attrs.name || '').trim();
    const rawClassName = (attrs.classname || '').trim();
    const timeInSeconds = Number.parseFloat(attrs.time);
    const duration = durationSecondsToSeconds(timeInSeconds);

    let state = SYSTEM_STATUS.PASSED;
    const hasSkipped = /<skipped\b/i.test(body) || String(attrs.status || '').toLowerCase() === SYSTEM_STATUS.SKIPPED;
    const hasFailed = /<failure\b/i.test(body) || /<error\b/i.test(body);

    if (hasSkipped) {
      state = SYSTEM_STATUS.SKIPPED;
    } else if (hasFailed) {
      state = SYSTEM_STATUS.FAILED;
    }

    const failureDetails = getFailureDetails(body);
    const testCaseId = extractTestCaseIdFromTitle(rawName) || extractTestCaseIdFromTitle(rawClassName);
    const configId = extractConfigIdFromText(rawName) || extractConfigIdFromText(rawClassName);

    testCases.push({
      title: rawName || '(Unnamed test case)',
      suite: rawClassName || 'JUnit Tests',
      testCaseId,
      configId,
      duration,
      state,
      failureMessage: failureDetails.message,
      failureStack: failureDetails.stack
    });
  }

  if (!testCases.length) {
    throw new Error('No <testcase> elements were found in the provided JUnit XML');
  }

  return testCases;
}

export function parseJUnitReport(junitXmlContent) {
  const testCases = parseJUnitXml(junitXmlContent);

  const resultsToUpload = {};
  const unresolvedIds = [];
  let hasConfig = false;

  let passes = 0;
  let failures = 0;
  let skipped = 0;

  testCases.forEach((testCase) => {
    if (testCase.state === SYSTEM_STATUS.PASSED) {
      passes += 1;
    } else if (testCase.state === SYSTEM_STATUS.FAILED) {
      failures += 1;
    } else {
      skipped += 1;
    }

    if (!testCase.testCaseId) {
      unresolvedIds.push(testCase.title);
      return;
    }

    const key = testCase.configId ? String(testCase.configId) : '0';
    if (testCase.configId) {
      hasConfig = true;
    }

    if (!resultsToUpload[key]) {
      resultsToUpload[key] = [];
    }

    resultsToUpload[key].push({
      tcId: String(testCase.testCaseId),
      status: toRunStatus(testCase.state),
      errDetails: String(testCase.failureStack || testCase.failureMessage || '').trim() || null,
      title: `${testCase.suite} ${testCase.title}`.trim(),
      duration: testCase.duration
    });
  });

  const allTests = testCases.map(tc => ({
    title: tc.title,
    suite: tc.suite,
    tcId: tc.testCaseId || null,
    configId: tc.configId ? String(tc.configId) : '0',
    status: toRunStatus(tc.state),
    errDetails: String(tc.failureStack || tc.failureMessage || '').trim() || null,
    duration: tc.duration
  }));

  if (!Object.keys(resultsToUpload).length && !allTests.length) {
    throw new Error('Could not parse results.');
  }

  return {
    format: 'junit',
    hasConfig,
    resultsToUpload,
    allTests,
    stats: {
      tests: testCases.length,
      passes,
      failures,
      skipped
    },
    unresolvedIds: unique(unresolvedIds)
  };
}

function encodeComment(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  try {
    return escape(text);
  } catch {
    return encodeURIComponent(text);
  }
}

class TcApiClient {
  constructor({ accessToken, projectId, testPlanId, baseApiUrl }) {
    this.accessToken = String(accessToken);
    this.projectId = Number(projectId);
    this.testPlanId = Number(testPlanId);
    this.baseApiUrl = getBaseApiUrl(baseApiUrl);

    this.project = null;
    this.user = null;
    this.testPlan = null;
    this.testPlanRun = null;
    this.testPlanConfigs = null;
  }

  buildUrl(endpoint) {
    const normalized = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const separator = normalized.includes('?') ? '&' : '?';
    // console.log("build url", `${this.baseApiUrl}${normalized}${separator}token=${encodeURIComponent(this.accessToken)}`);
    return `${this.baseApiUrl}${normalized}${separator}token=${encodeURIComponent(this.accessToken)}`;
  }

  async request(endpoint, options = {}) {
    const {
      method = 'GET',
      body
    } = options;

    const headers = {
      Accept: 'application/json'
    };

    const requestOptions = {
      method,
      headers
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestOptions.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(this.buildUrl(endpoint), requestOptions);
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
        (data && typeof data === 'object' && (data.message || data.error || data.status)) ||
        (typeof data === 'string' ? data : '') ||
        response.statusText ||
        `Request failed with status ${response.status}`;

      const error = new Error(String(message));
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  async hasAccessTokenExpired() {
    try {
      const responseData = await this.request('/system');
      if (responseData && (responseData.code === 401 || responseData.statusCode === 401)) {
        return true;
      }
      return false;
    } catch (error) {
      if (error?.status === 401) {
        return true;
      }
      return true;
    }
  }

  async getUserInfo() {
    if (this.user && this.user.id) {
      return this.user;
    }

    try {
      const resources = await this.request('/users/me');
      if (resources && resources.id) {
        this.user = resources;
        return resources;
      }
    } catch {
      return null;
    }

    return null;
  }

  async getProjectInfo() {
    if (this.project && this.project.id) {
      return this.project;
    }

    try {
      const resources = await this.request(`/projects/${this.projectId}`);
      if (resources && resources.id) {
        this.project = resources;
        return resources;
      }
    } catch {
      return null;
    }

    return null;
  }

  async getTestplanInfo() {
    if (this.testPlan && this.testPlan.id) {
      return this.testPlan;
    }

    try {
      const resources = await this.request(`/testplans/${this.testPlanId}`);
      if (resources && resources.id) {
        this.testPlan = resources;
        return resources;
      }
    } catch {
      return null;
    }

    return null;
  }

  async getTestplanRunInfo() {
    if (this.testPlanRun && this.testPlanRun.id) {
      return this.testPlanRun;
    }

    const params = new URLSearchParams({
      project: String(this.projectId),
      testplan: String(this.testPlanId),
      _limit: '1',
      _sort: 'id:desc'
    });

    try {
      const resources = await this.request(`/testplanregressions?${params.toString()}`);
      if (Array.isArray(resources) && resources.length && resources[0] && resources[0].id) {
        this.testPlanRun = resources[0];
        return this.testPlanRun;
      }
    } catch {
      return null;
    }

    return null;
  }

  async getTestplanConfigs() {
    if (Array.isArray(this.testPlanConfigs) && this.testPlanConfigs.length) {
      return this.testPlanConfigs;
    }

    const params = new URLSearchParams({
      project: String(this.projectId),
      testplan: String(this.testPlanId),
      _limit: '-1'
    });

    try {
      const resources = await this.request(`/testplanconfigurations?${params.toString()}`);
      if (Array.isArray(resources)) {
        this.testPlanConfigs = resources;
        return resources;
      }
    } catch {
      return [];
    }

    return [];
  }

  async getAssignedCases(testPlanConfigId = null) {
    if (!this.testPlanRun || !this.testPlanRun.id || !this.user || !this.user.id) {
      return [];
    }

    const params = new URLSearchParams({
      project: String(this.projectId),
      test_plan: String(this.testPlanId),
      regression: String(this.testPlanRun.id),
      assigned_to: String(this.user.id),
      _limit: '-1'
    });

    if (testPlanConfigId && String(testPlanConfigId) !== '0') {
      params.set('test_plan_config', String(testPlanConfigId));
    }

    try {
      const resources = await this.request(`/executedtestcases?${params.toString()}`);
      if (Array.isArray(resources)) {
        return resources;
      }
      return [];
    } catch {
      return [];
    }
  }

  async updateCaseRunResult(id, data) {
    try {
      const updateResult = await this.request(`/executedtestcases/${id}`, {
        method: 'PUT',
        body: data
      });
      if (updateResult && updateResult.id) {
        return updateResult;
      }
    } catch {
      return null;
    }

    return null;
  }

  async uploadCaseComments(data) {
    try {
      const createResult = await this.request('/executioncomments', {
        method: 'POST',
        body: data
      });

      if (createResult && createResult.id) {
        return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  async updateCaseTimeTaken(id, data) {
    try {
      await this.request(`/executedtestcases/${id}/updateTimeTaken`, {
        method: 'PUT',
        body: data
      });
      return true;
    } catch {
      return false;
    }
  }

  async bulkSkipTestCases(data) {
    try {
      const result = await this.request('/testplantestcases/bulkAction', {
        method: 'POST',
        body: data
      });
      return result;
    } catch {
      return null;
    }
  }
}

function findMatchingExecutedCase(casesAssigned, runRecord, hasConfig, configId) {
  const targetCaseId = String(runRecord.tcId);
  if (hasConfig && configId && String(configId) !== '0') {
    const targetConfigId = String(configId);
    return casesAssigned.find((assignedCase) => {
      const assignedTestCaseId = assignedCase?.test_plan_test_case?.test_case;
      const assignedConfigId = assignedCase?.test_plan_config?.id;
      return (
        assignedTestCaseId !== undefined &&
        String(assignedTestCaseId) === targetCaseId &&
        assignedConfigId !== undefined &&
        String(assignedConfigId) === targetConfigId
      );
    });
  }

  return casesAssigned.find((assignedCase) => {
    const assignedTestCaseId = assignedCase?.test_plan_test_case?.test_case;
    return assignedTestCaseId !== undefined && String(assignedTestCaseId) === targetCaseId;
  });
}

function buildUpdatePayload({ execCase, projectId, testPlanId, runRecord, configId, hasConfig }) {
  const payload = {
    id: execCase.id,
    test_plan_test_case: execCase.test_plan_test_case.id,
    project: projectId,
    status: runRecord.status,
    test_plan: testPlanId
  };

  if (hasConfig && configId && String(configId) !== '0') {
    payload.test_plan_config = Number(configId);
  }

  if (runRecord.duration && runRecord.duration > 0) {
    const existingTime = Number(execCase.time_taken) > 0 ? Number(execCase.time_taken) : 0;
    payload.time_taken = (runRecord.duration * 1000) + existingTime;
  }

  if (Array.isArray(execCase?.test_case_revision?.steps) && execCase.test_case_revision.steps.length) {
    payload.step_wise_result = execCase.test_case_revision.steps.map((step) => ({
      ...step,
      status: runRecord.status
    }));
  }

  return payload;
}

async function uploadUsingReporterFlow({
  apiKey,
  projectId,
  testPlanId,
  apiUrl,
  hasConfig,
  resultsToUpload,
  unresolvedIds,
  skipMissing = false
}) {
  const tcApiInstance = new TcApiClient({
    accessToken: apiKey,
    projectId,
    testPlanId,
    baseApiUrl: apiUrl
  });

  const hasTokenExpired = await tcApiInstance.hasAccessTokenExpired();
  if (hasTokenExpired === true) {
    throw new Error('Access token validation failed.');
  }

  const projectData = await tcApiInstance.getProjectInfo();
  if (!projectData || !projectData.id) {
    throw new Error('Project could not be fetched. Ensure the project ID is correct and you have access.');
  }

  const testPlanData = await tcApiInstance.getTestplanInfo();
  if (!testPlanData || !testPlanData.id) {
    throw new Error('Testplan could not be fetched.');
  }

  if (
    testPlanData.project &&
    testPlanData.project.id &&
    String(testPlanData.project.id) !== String(projectData.id)
  ) {
    throw new Error('Testplan does not belong to project.');
  }

  const testPlanRun = await tcApiInstance.getTestplanRunInfo();
  if (!testPlanRun || !testPlanRun.id) {
    throw new Error('Run information not found.');
  }

  await tcApiInstance.getTestplanConfigs();

  const userData = await tcApiInstance.getUserInfo();
  if (!userData || !userData.id) {
    throw new Error('User could not be fetched for this API key.');
  }

  const casesAssigned = await tcApiInstance.getAssignedCases();
  console.log({ 'Total assigned cases found': Array.isArray(casesAssigned) ? casesAssigned.length : 0 });

  const unmatchedCaseIds = new Set();
  const unmatchedConfigIds = new Set();
  const matchedExecCaseIds = new Set();
  let matched = 0;
  let updated = 0;
  let errors = 0;
  let skippedMissing = 0;

  const configIds = Object.keys(resultsToUpload);

  for (const configId of configIds) {
    const records = Array.isArray(resultsToUpload[configId]) ? resultsToUpload[configId] : [];

    if (hasConfig) {
      console.log('--------------------------------------------------------------------------');
      console.log({ processing_for_config_id: configId });
    }

    for (const runRecord of records) {
      try {
        console.log({ Processing: runRecord });

        if (!runRecord || !runRecord.tcId) {
          continue;
        }

        const execCase = findMatchingExecutedCase(casesAssigned, runRecord, hasConfig, configId);
        if (!execCase || !execCase.id) {
          if (hasConfig && String(configId) !== '0') {
            unmatchedConfigIds.add(`${runRecord.tcId}:${configId}`);
          } else {
            unmatchedCaseIds.add(String(runRecord.tcId));
          }
          continue;
        }

        matched += 1;
        matchedExecCaseIds.add(execCase.id);

        const updatePayload = buildUpdatePayload({
          execCase,
          projectId,
          testPlanId,
          runRecord,
          configId,
          hasConfig
        });

        const updateResult = await tcApiInstance.updateCaseRunResult(execCase.id, updatePayload);
        if (!updateResult || !updateResult.id) {
          errors += 1;
          continue;
        }

        updated += 1;

        if (runRecord.status === RUN_RESULT_MAP.fail && runRecord.errDetails) {
          await tcApiInstance.uploadCaseComments({
            project: projectId,
            executed_test_case: execCase.id,
            mentions: [],
            comment: encodeComment(runRecord.errDetails)
          });
        }

        if (updatePayload.time_taken) {
          await tcApiInstance.updateCaseTimeTaken(execCase.id, {
            time_taken: updatePayload.time_taken,
            project: projectId
          });
        }
      } catch {
        errors += 1;
      }
    }
  }

  // --skip-missing: mark all assigned cases not present in the result file as skipped
  if (skipMissing) {
    const missingCases = casesAssigned.filter(
      (assignedCase) => assignedCase && assignedCase.id && !matchedExecCaseIds.has(assignedCase.id)
    );

    if (missingCases.length) {
      console.log(`\n⏭️  --skip-missing: marking ${missingCases.length} unmatched test case(s) as skipped...`);

      // Group missing cases by config ID — the bulkAction endpoint requires
      // test_plan_config when configs exist, so we need one call per config
      const missingByConfig = {};
      for (const c of missingCases) {
        const tptc = c.test_plan_test_case;
        const testCaseId = tptc && typeof tptc === 'object' ? tptc.test_case : null;
        if (testCaseId === null || testCaseId === undefined) {
          continue;
        }
        const configId = c.test_plan_config && typeof c.test_plan_config === 'object'
          ? String(c.test_plan_config.id)
          : c.test_plan_config ? String(c.test_plan_config) : '0';
        if (!missingByConfig[configId]) {
          missingByConfig[configId] = [];
        }
        missingByConfig[configId].push(testCaseId);
      }

      for (const [configId, testCaseIds] of Object.entries(missingByConfig)) {
        if (!testCaseIds.length) {
          continue;
        }

        const bulkPayload = {
          actionType: 'skip',
          testcases: testCaseIds,
          project: projectId,
          testplan: testPlanId
        };

        if (configId && configId !== '0') {
          bulkPayload.test_plan_config = Number(configId);
        }

        const bulkResult = await tcApiInstance.bulkSkipTestCases(bulkPayload);

        if (bulkResult && bulkResult.status === true) {
          skippedMissing += bulkResult.affected || testCaseIds.length;
        } else {
          const errMsg = (bulkResult && bulkResult.message) || 'Unknown error';
          console.warn(`⚠️  Bulk skip failed for config ${configId}: ${errMsg}`);
          errors += testCaseIds.length;
        }
      }
    }
  }

  return {
    matched,
    updated,
    errors,
    skippedMissing,
    unresolvedIds: unique(unresolvedIds || []),
    unmatchedCaseIds: unique([...unmatchedCaseIds]),
    unmatchedConfigIds: unique([...unmatchedConfigIds])
  };
}

function validateRequiredOptions({ apiKey, project, testPlanId }) {
  if (!apiKey) {
    console.error('❌ Error: No API key provided');
    console.error('   Pass --api-key <key> or set the TESTCOLLAB_TOKEN environment variable.');
    process.exit(1);
  }
  if (!project) {
    console.error('❌ Error: --project is required');
    process.exit(1);
  }
  if (!testPlanId) {
    console.error('❌ Error: --test-plan-id is required');
    process.exit(1);
  }

  const parsedProjectId = Number(project);
  const parsedTestPlanId = Number(testPlanId);

  if (Number.isNaN(parsedProjectId)) {
    console.error('❌ Error: --project must be a number');
    process.exit(1);
  }
  if (Number.isNaN(parsedTestPlanId)) {
    console.error('❌ Error: --test-plan-id must be a number');
    process.exit(1);
  }

  return {
    parsedProjectId,
    parsedTestPlanId
  };
}

function logUploadSummary(formatLabel, summary) {
  console.log(`✅ ${formatLabel} report processed (${summary.matched || 0} matched, ${summary.updated || 0} updated)`);

  if (summary.skippedMissing) {
    console.log(`⏭️  ${summary.skippedMissing} test case(s) not in result file marked as skipped`);
  }
  if (summary.unresolvedIds?.length) {
    console.warn(`⚠️  ${summary.unresolvedIds.length} testcase(s) missing TestCollab ID`);
  }
  if (summary.unmatchedCaseIds?.length) {
    console.warn(`⚠️  ${summary.unmatchedCaseIds.length} testcase ID(s) not found in assigned executed cases`);
  }
  if (summary.unmatchedConfigIds?.length) {
    console.warn(`⚠️  ${summary.unmatchedConfigIds.length} testcase/config pair(s) could not be matched`);
  }
  if (summary.errors) {
    console.warn(`⚠️  ${summary.errors} testcase update(s) failed while processing report`);
  }
}

function normalizeReportFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  if (format === 'mochawesome' || format === 'junit') {
    return format;
  }
  return '';
}

function getFormattedDate() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
}

function createSdkConfig(apiKey, apiUrl) {
  const effectiveApiUrl = getBaseApiUrl(apiUrl);
  return new Configuration({
    basePath: effectiveApiUrl,
    fetchApi: (url, opts) => {
      const separator = url.includes('?') ? '&' : '?';
      return fetch(`${url}${separator}token=${encodeURIComponent(apiKey)}`, opts);
    }
  });
}

/**
 * Auto-create mode orchestrator.
 *
 * Creates all missing TestCollab resources (tag, suites, test cases, folder, test plan)
 * from the parsed test result file, then returns the new test plan ID.
 *
 * Uses testcollab-sdk (same pattern as createTestPlan.js).
 */
async function autoCreateTestPlan({ apiKey, apiUrl, projectId, parsedReport }) {
  const config = createSdkConfig(apiKey, apiUrl);

  const usersApi = new UsersApi(config);
  const testCasesApi = new TestCasesApi(config);
  const suitesApi = new SuitesApi(config);
  const foldersApi = new TestPlanFoldersApi(config);
  const testPlansApi = new TestPlansApi(config);
  const testPlanCasesApi = new TestPlanTestCasesApi(config);
  const testPlanAssignmentApi = new TestPlansAssignmentApi(config);

  const allTests = parsedReport.allTests;
  if (!allTests || !allTests.length) {
    throw new Error('No tests found in result file for auto-create');
  }

  console.log('🔧 Auto-create mode: setting up TestCollab resources...');

  // 1. Get current user
  const currentUser = await usersApi.getMyUser();
  if (!currentUser || !currentUser.id) {
    throw new Error('Failed to fetch current user. Check your API key.');
  }

  // 2. Find or create "CI Imported" tag
  const existingTags = await testCasesApi.getTestCasesTags({ project: projectId });
  let ciTag = (existingTags || []).find(t => t.name === 'CI Imported');
  if (!ciTag) {
    ciTag = await testCasesApi.addTags({
      testCasesTagPayload: { name: 'CI Imported', project: projectId }
    });
  }
  console.log(`   ✓ Tag "CI Imported" (id: ${ciTag.id})`);

  // 3. Fetch all existing suites
  const existingSuites = await suitesApi.getAllSuites({ project: projectId });
  const suiteCache = [...(existingSuites || [])];

  // 4. Build suite map: raw suite name → TestCollab suite
  const suiteMap = {};
  const uniqueRawSuites = [...new Set(allTests.map(t => t.suite))];

  for (const rawSuite of uniqueRawSuites) {
    const humanized = humanizeSuiteName(rawSuite);
    let suiteObj = suiteCache.find(s => s.title === humanized);
    if (!suiteObj) {
      suiteObj = await suitesApi.addSuite({
        addSuitePayload: {
          parentId: 0,
          title: humanized,
          project: projectId
        }
      });
      suiteCache.push(suiteObj);
      console.log(`   ✓ Suite "${humanized}" (created, id: ${suiteObj.id})`);
    } else {
      console.log(`   ✓ Suite "${humanized}" (existing, id: ${suiteObj.id})`);
    }
    suiteMap[rawSuite] = suiteObj;
  }

  // 5. Fetch existing test cases per suite (for title matching)
  const testCasesBySuite = {};
  for (const rawSuite of uniqueRawSuites) {
    const suiteObj = suiteMap[rawSuite];
    const cases = await testCasesApi.getTestCases({
      project: projectId,
      limit: -1,
      filter: JSON.stringify({ suite: suiteObj.id })
    });
    testCasesBySuite[suiteObj.id] = cases || [];
  }

  // 6. For each test: match by ID or title, create if needed, ensure tag
  let matchedByIdCount = 0;
  let matchedByTitleCount = 0;
  let createdCount = 0;

  for (const test of allTests) {
    const targetSuite = suiteMap[test.suite];

    if (test.tcId) {
      // Has TC ID — verify it exists and ensure tag
      try {
        const existingCase = await testCasesApi.getTestCase({ id: Number(test.tcId) });
        if (existingCase && existingCase.id) {
          const existingTagIds = (existingCase.tags || []).map(t => typeof t === 'object' ? t.id : t);
          if (!existingTagIds.includes(ciTag.id)) {
            await testCasesApi.updateTestCase({
              id: existingCase.id,
              testCasePayload: {
                title: existingCase.title,
                project: projectId,
                suite: existingCase.suite?.id || existingCase.suite || targetSuite.id,
                tags: [...existingTagIds, ciTag.id],
                customFields: []
              }
            });
          }
          matchedByIdCount++;
        }
      } catch {
        // Test case with this ID doesn't exist — treat as unresolved
        test.tcId = null;
      }
    }

    if (!test.tcId) {
      // No TC ID — search by normalized title within the suite
      const normalizedTestTitle = normalizeTitle(test.title);
      const suiteCases = testCasesBySuite[targetSuite.id] || [];
      const match = suiteCases.find(c => normalizeTitle(c.title) === normalizedTestTitle);

      if (match) {
        test.tcId = String(match.id);
        // Ensure tag on matched case
        const existingTagIds = (match.tags || []).map(t => typeof t === 'object' ? t.id : t);
        if (!existingTagIds.includes(ciTag.id)) {
          await testCasesApi.updateTestCase({
            id: match.id,
            testCasePayload: {
              title: match.title,
              project: projectId,
              suite: match.suite?.id || match.suite || targetSuite.id,
              tags: [...existingTagIds, ciTag.id],
              customFields: []
            }
          });
        }
        matchedByTitleCount++;
      } else {
        // Create new test case
        const newCase = await testCasesApi.createTestCase({
          testCasePayload: {
            title: test.title,
            project: projectId,
            suite: targetSuite.id,
            tags: [ciTag.id],
            priority: 1,
            customFields: []
          }
        });
        test.tcId = String(newCase.id);
        // Add to cache so duplicates in same run don't create again
        testCasesBySuite[targetSuite.id].push(newCase);
        createdCount++;
      }
    }
  }
  console.log(`   ✓ ${matchedByIdCount} matched by ID, ${matchedByTitleCount} matched by title, ${createdCount} created new`);

  // 7. Rebuild resultsToUpload from enriched allTests
  const newResultsToUpload = {};
  for (const test of allTests) {
    if (!test.tcId) continue;
    const key = test.configId || '0';
    if (!newResultsToUpload[key]) {
      newResultsToUpload[key] = [];
    }
    newResultsToUpload[key].push({
      tcId: String(test.tcId),
      status: test.status,
      errDetails: test.errDetails,
      title: test.title,
      duration: test.duration
    });
  }
  parsedReport.resultsToUpload = newResultsToUpload;
  parsedReport.unresolvedIds = [];

  // 8. Find or create "CI" test plan folder
  const existingFolders = await foldersApi.getTestPlanFolders({ project: projectId, limit: -1 });
  let ciFolder = (existingFolders || []).find(f => f.title === 'CI');
  if (!ciFolder) {
    ciFolder = await foldersApi.createTestPlanFolder({
      testPlanFolderPayload: {
        project: projectId,
        title: 'CI',
        parentId: 0
      }
    });
    console.log(`   ✓ Folder "CI" (created, id: ${ciFolder.id})`);
  } else {
    console.log(`   ✓ Folder "CI" (existing, id: ${ciFolder.id})`);
  }

  // 9. Create test plan
  const planTitle = `CI Run: ${getFormattedDate()}`;
  const newPlan = await testPlansApi.addTestPlan({
    testPlanPayload: {
      project: projectId,
      title: planTitle,
      description: 'Auto-created by tc-cli --auto-create',
      status: 1,
      priority: 1,
      testPlanFolder: ciFolder.id,
      customFields: []
    }
  });
  console.log(`   ✓ Test Plan "${planTitle}" (id: ${newPlan.id})`);

  // 10. Bulk-add test cases by tag
  const addResult = await testPlanCasesApi.bulkAddTestPlanTestCases({
    testPlanTestCaseBulkAddPayload: {
      testplan: newPlan.id,
      testCaseCollection: {
        testCases: [],
        selector: [
          {
            field: 'tags',
            operator: 'jsonstring_2',
            value: `{"filter":[[${ciTag.id}]],"type":"equals","filterType":"number"}`
          }
        ]
      }
    }
  });
  if (addResult && addResult.status === false) {
    throw new Error('Failed to add test cases to the test plan');
  }

  // 11. Assign to current user
  await testPlanAssignmentApi.assignTestPlan({
    project: projectId,
    testplan: newPlan.id,
    testPlanAssignmentPayload: {
      executor: 'team',
      assignmentCriteria: 'testCase',
      assignmentMethod: 'automatic',
      assignment: {
        user: [currentUser.id],
        testCases: { testCases: [], selector: [] },
        configuration: null
      },
      project: projectId,
      testplan: newPlan.id
    }
  });

  const totalCases = allTests.filter(t => t.tcId).length;
  console.log(`   ✓ ${totalCases} test cases added and assigned to ${currentUser.firstName || currentUser.email}`);

  return { testPlanId: newPlan.id };
}

export async function report(options) {
  const {
    project,
    testPlanId,
    format,
    resultFile,
    apiUrl,
    skipMissing,
    autoCreate
  } = options;

  // Resolve API key: --api-key flag takes precedence, then TESTCOLLAB_TOKEN env var
  const apiKey = options.apiKey || process.env.TESTCOLLAB_TOKEN;

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
  if (Number.isNaN(parsedProjectId)) {
    console.error('❌ Error: --project must be a number');
    process.exit(1);
  }

  // Validate: either --test-plan-id or --auto-create, not both, not neither
  if (autoCreate && testPlanId) {
    console.error('❌ Error: --test-plan-id and --auto-create are mutually exclusive');
    process.exit(1);
  }
  if (!autoCreate && !testPlanId) {
    console.error('❌ Error: Either --test-plan-id or --auto-create is required');
    process.exit(1);
  }

  let parsedTestPlanId = null;
  if (testPlanId) {
    parsedTestPlanId = Number(testPlanId);
    if (Number.isNaN(parsedTestPlanId)) {
      console.error('❌ Error: --test-plan-id must be a number');
      process.exit(1);
    }
  }

  const normalizedFormat = normalizeReportFormat(format);
  if (!normalizedFormat) {
    console.error('❌ Error: --format must be either "mochawesome" or "junit"');
    process.exit(1);
  }

  if (!resultFile || !String(resultFile).trim()) {
    console.error('❌ Error: --result-file is required');
    process.exit(1);
  }

  const absResultPath = toAbsolutePath(String(resultFile).trim());
  if (!fs.existsSync(absResultPath)) {
    console.error(`❌ Error: Result file not found at: ${absResultPath}`);
    console.error('   Ensure the result file exists and you passed a valid path via --result-file <path>');
    process.exit(1);
  }

  try {
    // Parse the result file
    let parsedReport;
    if (normalizedFormat === 'junit') {
      const junitXmlContent = fs.readFileSync(absResultPath, 'utf8');
      parsedReport = parseJUnitReport(junitXmlContent);
    } else {
      const mochawesomePayload = readMochawesomePayload(absResultPath);
      parsedReport = parseMochawesomeReport(mochawesomePayload);
    }

    const stats = parsedReport.stats;
    const formatLabel = normalizedFormat === 'junit' ? 'JUnit XML' : 'Mochawesome JSON';
    console.log(
      `ℹ️  Parsed ${formatLabel} (${stats.tests} tests: ${stats.passes} passed, ${stats.failures} failed, ${stats.skipped} skipped)`
    );

    // Auto-create mode: create all missing resources
    let effectiveTestPlanId = parsedTestPlanId;
    if (autoCreate) {
      const autoResult = await autoCreateTestPlan({
        apiKey: String(apiKey),
        apiUrl,
        projectId: parsedProjectId,
        parsedReport
      });
      effectiveTestPlanId = autoResult.testPlanId;
    }

    // Upload results
    console.log(`🚀 Uploading ${formatLabel} test run result to TestCollab...`);
    const summary = await uploadUsingReporterFlow({
      apiKey: String(apiKey),
      projectId: parsedProjectId,
      testPlanId: effectiveTestPlanId,
      apiUrl,
      hasConfig: parsedReport.hasConfig,
      resultsToUpload: parsedReport.resultsToUpload,
      unresolvedIds: parsedReport.unresolvedIds,
      skipMissing: Boolean(skipMissing)
    });

    logUploadSummary(normalizedFormat === 'junit' ? 'JUnit' : 'Mochawesome', summary);
  } catch (err) {
    console.error(`❌ Error: ${err?.message || String(err)}`);
    process.exit(1);
  }
}
