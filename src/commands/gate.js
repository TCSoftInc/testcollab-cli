/**
 * gate.js
 *
 * TCV-6668 — Use TestCollab as a quality gate in a CI pipeline (e.g. Azure DevOps).
 *
 * Reads the results of a Test Plan via the TestCollab REST API and exits non-zero
 * when the configured gate criteria are not met, which fails the surrounding CI
 * step (Azure DevOps, Jenkins, GitLab CI, Ansible, …).
 *
 * Results are computed LIVE from the executed test cases of the plan's latest run
 * (regression) — deliberately NOT from the plan's cached `results` summary, which
 * is not refreshed on every executed-case update. This keeps the gate correct
 * immediately after a `tc report` upload in the same pipeline.
 *
 * Exit codes: 0 = gate passed · 1 = gate failed · 2 = usage / API error.
 */

// Standard system statuses, in display order. User-defined statuses are appended.
const SYSTEM_STATUSES = ['unexecuted', 'passed', 'failed', 'skipped', 'blocked'];

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

function buildUrl(baseApiUrl, endpoint, token) {
  const normalized = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const separator = normalized.includes('?') ? '&' : '?';
  return `${baseApiUrl}${normalized}${separator}token=${encodeURIComponent(token)}`;
}

async function apiGet(baseApiUrl, token, endpoint) {
  let response;
  try {
    response = await fetch(buildUrl(baseApiUrl, endpoint, token), {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a comma-separated --fail-on list into an array of status system names.
 * Defaults to ['failed'] — the minimum gate: any failing test case fails the build.
 */
export function parseFailOn(value) {
  if (value === undefined || value === null) {
    return ['failed'];
  }
  const list = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['failed'];
}

/**
 * Count executed test cases by their status system name.
 *
 * A missing/blank status is treated as 'unexecuted'. User-defined statuses are
 * preserved under their own key, so `--fail-on <customStatus>` works too.
 *
 * @param {Array} executedCases  ExecutedTestCase records from GET /executedtestcases
 * @returns {object} status system name -> count (system statuses always present)
 */
export function summarize(executedCases) {
  const counts = { unexecuted: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 };
  const list = Array.isArray(executedCases) ? executedCases : [];
  for (const ec of list) {
    const raw = ec && typeof ec.status === 'string' ? ec.status.trim() : '';
    const status = raw || 'unexecuted';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

/**
 * Evaluate the gate criteria against a result summary. Pure — no I/O.
 *
 * @param {object} summary  status -> count, e.g. { passed, failed, blocked, ... }
 * @param {object} options
 *   - failOn {string[]}       statuses that count against the gate (default ['failed'])
 *   - maxFailed {number}      allowed number of fail-on cases before failing (default 0)
 *   - minPassRate {number}    minimum pass rate %, over executed cases (optional)
 *   - requireComplete {bool}  fail if any case is still unexecuted (default false)
 * @returns {object} { passed, reasons, total, executed, unexecuted, passedCount, offending, passRate, counts }
 */
export function evaluateGate(summary, options = {}) {
  const counts = {};
  let total = 0;
  for (const [key, value] of Object.entries(summary || {})) {
    const n = Number(value) || 0;
    counts[key] = n;
    total += n;
  }

  const unexecuted = counts.unexecuted || 0;
  const executed = total - unexecuted;
  const passedCount = counts.passed || 0;

  const failOn = options.failOn && options.failOn.length ? options.failOn : ['failed'];
  const maxFailed = Number.isFinite(options.maxFailed) ? options.maxFailed : 0;
  let offending = 0;
  for (const status of failOn) {
    offending += counts[status] || 0;
  }

  const reasons = [];
  if (offending > maxFailed) {
    reasons.push(
      maxFailed > 0
        ? `${offending} case(s) with status [${failOn.join(', ')}] exceed the allowed maximum of ${maxFailed}`
        : `${offending} case(s) with status [${failOn.join(', ')}]`
    );
  }

  if (options.requireComplete && unexecuted > 0) {
    reasons.push(`${unexecuted} case(s) still unexecuted (--require-complete)`);
  }

  let passRate = null;
  if (
    options.minPassRate !== undefined &&
    options.minPassRate !== null &&
    Number.isFinite(options.minPassRate)
  ) {
    passRate = executed > 0 ? (passedCount / executed) * 100 : 0;
    if (passRate < options.minPassRate) {
      reasons.push(
        `pass rate ${passRate.toFixed(1)}% is below the required ${options.minPassRate}%`
      );
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
    total,
    executed,
    unexecuted,
    passedCount,
    offending,
    passRate,
    counts
  };
}

function formatCounts(counts) {
  const order = [...SYSTEM_STATUSES];
  for (const key of Object.keys(counts)) {
    if (!order.includes(key)) {
      order.push(key);
    }
  }
  return order
    .filter((key) => counts[key] !== undefined)
    .map((key) => `${key}: ${counts[key]}`)
    .join(' · ');
}

function parseNumericOption(value, flag, { allowNull = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (allowNull) {
      return null;
    }
    return NaN;
  }
  const n = Number(value);
  if (Number.isNaN(n)) {
    console.error(`❌ Error: ${flag} must be a number`);
    process.exit(2);
  }
  return n;
}

/**
 * `tc gate` command action.
 */
export async function gate(options) {
  const apiKey = options.apiKey || process.env.TESTCOLLAB_TOKEN;
  if (!apiKey) {
    console.error('❌ Error: No API key provided');
    console.error('   Pass --api-key <key> or set the TESTCOLLAB_TOKEN environment variable.');
    process.exit(2);
  }

  const projectId = parseNumericOption(options.project, '--project');
  if (Number.isNaN(projectId)) {
    console.error('❌ Error: --project is required and must be a number');
    process.exit(2);
  }
  const testPlanId = parseNumericOption(options.testPlanId, '--test-plan-id');
  if (Number.isNaN(testPlanId)) {
    console.error('❌ Error: --test-plan-id is required and must be a number');
    process.exit(2);
  }

  const failOn = parseFailOn(options.failOn);
  const maxFailed = parseNumericOption(options.maxFailed, '--max-failed');
  if (Number.isNaN(maxFailed)) {
    console.error('❌ Error: --max-failed must be a number');
    process.exit(2);
  }
  const minPassRate = parseNumericOption(options.minPassRate, '--min-pass-rate', { allowNull: true });
  const configId = parseNumericOption(options.config, '--config', { allowNull: true });
  const regressionOption = parseNumericOption(options.regression, '--regression', { allowNull: true });
  const waitSeconds = parseNumericOption(options.wait, '--wait', { allowNull: true }) || 0;
  const pollSeconds = parseNumericOption(options.pollInterval, '--poll-interval', { allowNull: true }) || 15;
  const requireComplete = Boolean(options.requireComplete);

  const baseApiUrl = getBaseApiUrl(options.apiUrl);

  try {
    // TCV-6668: validate the plan exists / token works, and grab its title + project.
    let plan;
    try {
      plan = await apiGet(baseApiUrl, apiKey, `/testplans/${testPlanId}`);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        console.error('❌ Error: authentication failed — check the API token and its access to this project.');
        process.exit(2);
      }
      throw error;
    }
    if (!plan || !plan.id) {
      console.error(`❌ Error: test plan ${testPlanId} not found.`);
      process.exit(2);
    }
    if (plan.project && plan.project.id && Number(plan.project.id) !== projectId) {
      console.error(`❌ Error: test plan ${testPlanId} does not belong to project ${projectId}.`);
      process.exit(2);
    }
    const planTitle = plan.title || '';

    // TCV-6668: resolve the run (regression) to evaluate — latest by default.
    let regressionId = regressionOption;
    if (regressionId === null) {
      const runs = await apiGet(
        baseApiUrl,
        apiKey,
        `/testplanregressions?project=${projectId}&testplan=${testPlanId}&_sort=id:desc&_limit=1`
      );
      if (!Array.isArray(runs) || !runs.length || !runs[0] || !runs[0].id) {
        console.error(`❌ Error: test plan ${testPlanId} has no runs yet — nothing to gate on.`);
        process.exit(2);
      }
      regressionId = runs[0].id;
    }

    const execEndpoint = () => {
      let endpoint = `/executedtestcases?test_plan=${testPlanId}&regression=${regressionId}&_limit=-1`;
      if (configId !== null) {
        endpoint += `&test_plan_config=${configId}`;
      }
      return endpoint;
    };

    // TCV-6668: optional wait — poll until the run has no unexecuted cases (or timeout).
    let executedCases = await apiGet(baseApiUrl, apiKey, execEndpoint());
    if (waitSeconds > 0) {
      const deadline = Date.now() + waitSeconds * 1000;
      let running = summarize(executedCases);
      while ((running.unexecuted || 0) > 0 && Date.now() < deadline) {
        console.log(`⏳ Waiting for execution to complete — ${running.unexecuted} case(s) unexecuted…`);
        await sleep(Math.max(1, pollSeconds) * 1000);
        executedCases = await apiGet(baseApiUrl, apiKey, execEndpoint());
        running = summarize(executedCases);
      }
    }

    if (!Array.isArray(executedCases) || !executedCases.length) {
      console.error(
        `❌ Error: no executed test cases found for run #${regressionId}` +
          `${configId !== null ? ` (config ${configId})` : ''}.`
      );
      process.exit(2);
    }

    const summary = summarize(executedCases);
    const verdict = evaluateGate(summary, { failOn, maxFailed, minPassRate, requireComplete });

    const label = planTitle ? `#${testPlanId} "${planTitle}"` : `#${testPlanId}`;
    console.log(
      `ℹ️  Test plan ${label} — run #${regressionId}` +
        `${configId !== null ? ` · config ${configId}` : ''}`
    );
    console.log(`   ${formatCounts(summary)}  (${verdict.total} total)`);
    if (verdict.passRate !== null) {
      console.log(`   pass rate: ${verdict.passRate.toFixed(1)}%`);
    }

    if (verdict.passed) {
      console.log('✅ Quality gate PASSED');
      process.exit(0);
    }

    console.log('❌ Quality gate FAILED');
    verdict.reasons.forEach((reason) => console.log(`   - ${reason}`));
    process.exit(1);
  } catch (error) {
    console.error(`❌ Error: ${error?.message || String(error)}`);
    process.exit(2);
  }
}
