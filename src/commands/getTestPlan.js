/**
 * getTestPlan.js
 *
 * Fetches a test plan and its test cases from TestCollab, outputs as
 * structured JSON for consumption by AI coding agents.
 *
 * Handles configuration-based test plans: when a plan has multiple
 * configurations (e.g., Browser: Chrome, OS: Windows), the output
 * includes per-configuration execution status for each test case.
 *
 * Options:
 * - --api-key        API token
 * - --project        Project ID
 * - --test-plan-id   Test plan ID to fetch
 * - --api-url        (defaults to https://api.testcollab.io)
 * - --output         Write JSON to file instead of stdout
 */

import fs from 'fs';
import {
  Configuration,
  TestPlansApi,
  TestPlanTestCasesApi,
  TestPlansConfigsApi,
} from 'testcollab-sdk';

const STATUS_MAP = { 0: 'draft', 1: 'ready', 2: 'finished', 3: 'finished_with_failures' };
const PRIORITY_MAP = { 0: 'low', 1: 'normal', 2: 'high' };

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function getTestPlan(options) {
  const { project, testPlanId, apiUrl } = options;

  // Resolve API key
  const apiKey = options.apiKey || process.env.TESTCOLLAB_TOKEN;

  // Normalize API base URL
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

  // Configure SDK
  const config = new Configuration({
    basePath: effectiveApiUrl,
    fetchApi: (url, opts) => {
      const separator = url.includes('?') ? '&' : '?';
      const urlWithToken = `${url}${separator}token=${apiKey}`;
      return fetch(urlWithToken, opts);
    }
  });

  const testPlansApi = new TestPlansApi(config);
  const testPlanTestCasesApi = new TestPlanTestCasesApi(config);
  const testPlansConfigsApi = new TestPlansConfigsApi(config);

  try {
    // 1. Fetch test plan metadata
    console.error('Fetching test plan...');
    const testPlan = await testPlansApi.getTestPlan({ id: parsedTestPlanId });

    if (!testPlan || !testPlan.id) {
      console.error('❌ Error: Test plan not found');
      process.exit(1);
    }

    // 2. Fetch configurations for this test plan
    let configurations = [];
    const configMap = {};
    try {
      configurations = await testPlansConfigsApi.getTestPlanConfigs({
        project: parsedProjectId,
        testplan: parsedTestPlanId,
        limit: -1,
      });
      if (configurations && configurations.length) {
        for (const cfg of configurations) {
          configMap[cfg.id] = cfg;
        }
      }
    } catch {
      // Plan has no configurations — that's fine
      configurations = [];
    }

    const hasConfigs = configurations.length > 0;
    if (hasConfigs) {
      console.error(`   Found ${configurations.length} configuration(s)`);
    }

    // 3. Fetch ALL test cases (paginate)
    console.error('Fetching test cases...');
    let allCases = [];
    let start = 0;
    const batchSize = 100;
    while (true) {
      const batch = await testPlanTestCasesApi.getTestPlanTestCases({
        project: parsedProjectId,
        testplan: parsedTestPlanId,
        limit: batchSize,
        start,
      });
      if (!batch || !batch.length) break;
      allCases.push(...batch);
      if (batch.length < batchSize) break;
      start += batchSize;
    }

    if (allCases.length === 0) {
      console.error('⚠️  Warning: Test plan has zero test cases');
    }

    // 4. Build output
    const result = {
      testPlan: {
        id: testPlan.id,
        title: testPlan.title,
        status: STATUS_MAP[testPlan.status] || String(testPlan.status),
        description: stripHtml(testPlan.description),
        priority: PRIORITY_MAP[testPlan.priority] || String(testPlan.priority),
        totalCases: allCases.length,
      },
      configurations: hasConfigs
        ? configurations.map(cfg => ({
            id: cfg.id,
            parameters: cfg.parameters.map(p => ({ field: p.field, value: p.value })),
            assignedTo: cfg.assignedTo ? cfg.assignedTo.name || cfg.assignedTo.id : null,
          }))
        : undefined,
      testCases: allCases.map(tptc => {
        const tc = tptc.testCase;
        const testCase = {
          id: tc.id,
          testPlanTestCaseId: tptc.id,
          title: tc.title,
          description: stripHtml(tc.description),
          priority: PRIORITY_MAP[tc.priority] || String(tc.priority),
          suite: tc.suite || null,
          status: tptc.status,
          steps: (tc.steps || []).map(s => ({
            step: stripHtml(s.step),
            expectedResult: stripHtml(s.expectedResult),
          })),
        };

        // Include per-configuration results when configs exist
        if (hasConfigs && tptc.results && tptc.results.length) {
          testCase.configResults = tptc.results.map(r => {
            const cfg = configMap[r.configId];
            return {
              configId: r.configId,
              configLabel: cfg
                ? cfg.parameters.map(p => `${p.field}: ${p.value}`).join(', ')
                : null,
              status: r.status,
            };
          });
        }

        return testCase;
      }),
    };

    // Remove undefined configurations key for non-config plans
    if (!hasConfigs) {
      delete result.configurations;
    }

    // 5. Output
    const jsonOutput = JSON.stringify(result, null, 2);

    if (options.output) {
      fs.writeFileSync(options.output, jsonOutput);
      console.error(`✅ Test plan written to ${options.output}`);
      console.error(`   ${result.testPlan.title} - ${result.testCases.length} test cases`);
    } else {
      console.log(jsonOutput);
      console.error(`✅ Fetched "${result.testPlan.title}" - ${result.testCases.length} test cases`);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && 'text' in error) {
      try {
        const bodyText = await error.text();
        console.error(`❌ Error: HTTP ${error.status} ${error.statusText || ''}${bodyText ? ` - ${bodyText}` : ''}`);
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
