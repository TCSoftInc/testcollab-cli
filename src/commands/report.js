/**
 * report.js
 *
 * Upload a Mochawesome JSON result to TestCollab and attach it to a Test Plan.
 * This wraps the `uploadTCRunResult` CLI from `testcollab-cypress-plugin`.
 *
 * Options map from previous env vars:
 * - --api-key            (TESTCOLLAB_API_KEY)
 * - --project            (TESTCOLLAB_PROJECT_ID)
 * - --company-id         (TESTCOLLAB_COMPANY_ID)
 * - --test-plan-id       (TESTCOLLAB_TEST_PLAN_ID)
 * - --mocha-json-result  (path to mochawesome.json, defaults to ./mochawesome-report/mochawesome.json)
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export async function report(options) {
  const {
    apiKey,
    project,
    companyId,
    testPlanId,
    mochaJsonResult,
    apiUrl
  } = options;

  // Basic validations
  if (!apiKey) {
    console.error('❌ Error: --api-key is required (was TESTCOLLAB_API_KEY)');
    process.exit(1);
  }
  if (!project) {
    console.error('❌ Error: --project is required (was TESTCOLLAB_PROJECT_ID)');
    process.exit(1);
  }
  if (!companyId) {
    console.error('❌ Error: --company-id is required (was TESTCOLLAB_COMPANY_ID)');
    process.exit(1);
  }
  if (!testPlanId) {
    console.error('❌ Error: --test-plan-id is required (was TESTCOLLAB_TEST_PLAN_ID)');
    process.exit(1);
  }

  const parsedProjectId = Number(project);
  const parsedCompanyId = Number(companyId);
  const parsedTestPlanId = Number(testPlanId);
  if (Number.isNaN(parsedProjectId)) {
    console.error('❌ Error: --project must be a number');
    process.exit(1);
  }
  if (Number.isNaN(parsedCompanyId)) {
    console.error('❌ Error: --company-id must be a number');
    process.exit(1);
  }
  if (Number.isNaN(parsedTestPlanId)) {
    console.error('❌ Error: --test-plan-id must be a number');
    process.exit(1);
  }

  const resultPath = mochaJsonResult || './mochawesome-report/mochawesome.json';
  const absResultPath = path.isAbsolute(resultPath) ? resultPath : path.join(process.cwd(), resultPath);
  if (!fs.existsSync(absResultPath)) {
    console.error(`❌ Error: Mochawesome JSON not found at: ${absResultPath}`);
    console.error('   Ensure you have run your tests and generated mochawesome.json,');
    console.error('   or provide a custom path via --mocha-json-result <path>');
    process.exit(1);
  }

  // Optional: override API base URL used by the plugin's internal API wrapper
  if (apiUrl && String(apiUrl).trim()) {
    const sanitizedBaseUrl = String(apiUrl).trim().replace(/\/+$/, '');
    try {
      const tcApiModulePath = require.resolve('testcollab-cypress-plugin/tcapi.js');
      const TCApi = require(tcApiModulePath);
      // Monkey-patch getBaseApiUrl to force the provided base URL
      TCApi.prototype.getBaseApiUrl = function () {
        return sanitizedBaseUrl;
      };
    } catch (e) {
      console.warn('⚠️  Warning: Could not patch plugin base URL; proceeding with default.');
    }
  }

  // Call the plugin entry directly (note: it exits the process on completion)
  try {
    const startUploadResults = require(require.resolve('testcollab-cypress-plugin/index.js'));
    console.log('🚀 Uploading test run result to TestCollab...');
    await Promise.resolve(startUploadResults(
      String(apiKey),
      parsedCompanyId,
      parsedProjectId,
      parsedTestPlanId,
      absResultPath
    ));
  } catch (err) {
    console.error(`❌ Error: ${err?.message || String(err)}`);
    process.exit(1);
  }
}


