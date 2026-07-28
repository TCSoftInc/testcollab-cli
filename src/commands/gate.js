/**
 * gate.js
 *
 * TCV-6668 — Use TestCollab as a quality gate in a CI pipeline (e.g. Azure DevOps).
 *
 * Reads the results of a Test Plan via the TestCollab REST API and exits non-zero
 * when the configured gate criteria are not met, which fails the surrounding CI
 * step (Azure DevOps, Jenkins, GitLab CI, Ansible, …).
 *
 * For the plan's LATEST run, results are computed LIVE from the executed test cases
 * (fresh right after a `tc report`), with unexecuted derived as
 * (cases in plan × configs) − executed — matching the backend's own aggregation, so
 * stale/orphaned rows don't over-report it. For an explicit OLDER --regression, the
 * run's frozen `result` summary is used (exactly what the UI shows for that run),
 * because an old run's rows accumulate 'unexecuted' placeholders for cases added to
 * the plan afterwards, which would over-count if recounted.
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

// Normalize a /count response ({ count: N }) or a list ([...]) or a bare number.
function extractCount(resp) {
  if (typeof resp === 'number') {
    return resp;
  }
  if (Array.isArray(resp)) {
    return resp.length;
  }
  if (resp && typeof resp === 'object' && resp.count !== undefined) {
    return Number(resp.count);
  }
  const n = Number(resp);
  return Number.isFinite(n) ? n : NaN;
}

// TCV-6668: total planned executions for the plan = cases × configurations
// (or just cases when a single --config is targeted). Used to derive unexecuted.
// Returns null on any failure so the caller keeps the literal count.
async function fetchPlannedTotal(baseApiUrl, token, projectId, testPlanId, configId) {
  try {
    const caseResp = await apiGet(
      baseApiUrl,
      token,
      `/testplantestcases/count?project=${projectId}&testplan=${testPlanId}`
    );
    const caseCount = extractCount(caseResp);
    if (!Number.isFinite(caseCount)) {
      return null;
    }
    if (configId !== null) {
      return caseCount;
    }
    const configs = await apiGet(
      baseApiUrl,
      token,
      `/testplanconfigurations?project=${projectId}&testplan=${testPlanId}&_limit=-1`
    );
    const configCount = Array.isArray(configs) ? configs.length : 0;
    return caseCount * Math.max(1, configCount);
  } catch {
    return null;
  }
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
 * Recompute `unexecuted` from the plan's real case count instead of trusting the
 * literal 'unexecuted' rows returned for a run.
 *
 * TCV-6668: a run's executedtestcase rows can include stale/orphaned 'unexecuted'
 * placeholders (e.g. for cases later removed from the plan), which over-reports
 * unexecuted. The backend (`getResult`/`updatePlanStats`) derives it instead:
 * unexecuted = max(0, totalPlanned − executed), where executed counts every
 * non-unexecuted status. We match that. If totalPlanned is unknown (count call
 * failed), the literal count is kept unchanged.
 *
 * @param {object} summary       status -> count from summarize()
 * @param {number|null} totalPlanned  cases in plan × configurations (or per config)
 * @returns {object} a new summary with a corrected `unexecuted`
 */
export function reconcileUnexecuted(summary, totalPlanned) {
  if (!Number.isFinite(totalPlanned) || totalPlanned < 0) {
    return { ...summary };
  }
  let executed = 0;
  for (const [key, value] of Object.entries(summary)) {
    if (key !== 'unexecuted') {
      executed += Number(value) || 0;
    }
  }
  return { ...summary, unexecuted: Math.max(0, totalPlanned - executed) };
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

// TCV-6668: strict numeric parsing. Every numeric option is interpolated into an
// API query string, so we reject anything that isn't a finite number in range
// (an integer by default). This both fixes nonsensical values like `--max-failed -1`
// and closes the injection surface — e.g. Number('1 OR 1=1') is NaN and rejected.
function parseNumericOption(value, flag, { allowNull = false, integer = true, min, max } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (allowNull) {
      return null;
    }
    return NaN;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    console.error(`❌ Error: ${flag} must be ${integer ? 'an integer' : 'a number'}`);
    process.exit(2);
  }
  if (min !== undefined && n < min) {
    console.error(`❌ Error: ${flag} must be >= ${min}`);
    process.exit(2);
  }
  if (max !== undefined && n > max) {
    console.error(`❌ Error: ${flag} must be <= ${max}`);
    process.exit(2);
  }
  return n;
}

// TCV-6668: fail-on values are matched against status names client-side (never sent
// to the API), but validate them anyway — reject anything outside a safe charset so
// a stray quote/semicolon can't slip through as a "status".
function validateFailOn(failOn) {
  const SAFE = /^[A-Za-z0-9_ -]+$/;
  for (const status of failOn) {
    if (!SAFE.test(status)) {
      console.error(`❌ Error: --fail-on contains an invalid status "${status}" (allowed: letters, numbers, space, _ , -)`);
      process.exit(2);
    }
  }
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

  const projectId = parseNumericOption(options.project, '--project', { min: 1 });
  if (Number.isNaN(projectId)) {
    console.error('❌ Error: --project is required and must be a positive integer');
    process.exit(2);
  }
  const testPlanId = parseNumericOption(options.testPlanId, '--test-plan-id', { min: 1 });
  if (Number.isNaN(testPlanId)) {
    console.error('❌ Error: --test-plan-id is required and must be a positive integer');
    process.exit(2);
  }

  const failOn = parseFailOn(options.failOn);
  validateFailOn(failOn);
  const maxFailed = parseNumericOption(options.maxFailed, '--max-failed', { min: 0 });
  if (Number.isNaN(maxFailed)) {
    console.error('❌ Error: --max-failed must be a non-negative integer');
    process.exit(2);
  }
  const minPassRate = parseNumericOption(options.minPassRate, '--min-pass-rate', { allowNull: true, integer: false, min: 0, max: 100 });
  const configId = parseNumericOption(options.config, '--config', { allowNull: true, min: 1 });
  const regressionOption = parseNumericOption(options.regression, '--regression', { allowNull: true, min: 1 });
  const waitSeconds = parseNumericOption(options.wait, '--wait', { allowNull: true, min: 0 }) || 0;
  const pollSeconds = parseNumericOption(options.pollInterval, '--poll-interval', { allowNull: true, min: 0 }) || 15;
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

    // TCV-6668: resolve which run to gate on, and how to read its results.
    //   • Latest run (default) — count executed cases LIVE (fresh right after a
    //     `tc report`), deriving unexecuted from the plan's real case count.
    //   • An explicit OLDER run — use its frozen `result` summary (exactly what the
    //     UI shows for that run). An old run's executed-case rows accumulate
    //     'unexecuted' placeholders for cases added to the plan afterwards, so
    //     recounting them over-reports; the stored per-run summary is authoritative.
    const latestRuns = await apiGet(
      baseApiUrl,
      apiKey,
      `/testplanregressions?project=${projectId}&testplan=${testPlanId}&_sort=id:desc&_limit=1`
    );
    if (!Array.isArray(latestRuns) || !latestRuns.length || !latestRuns[0] || !latestRuns[0].id) {
      console.error(`❌ Error: test plan ${testPlanId} has no runs yet — nothing to gate on.`);
      process.exit(2);
    }
    const latestRun = latestRuns[0];

    let regressionId = latestRun.id;
    let regressionNumber = latestRun.iteration || 0;
    let storedResult = null;
    if (regressionOption !== null && regressionOption !== latestRun.id) {
      let run = null;
      try {
        run = await apiGet(baseApiUrl, apiKey, `/testplanregressions/${regressionOption}`);
      } catch {
        run = null;
      }
      if (!run || !run.id) {
        console.error(`❌ Error: run/regression ${regressionOption} not found for test plan ${testPlanId}.`);
        process.exit(2);
      }
      regressionId = run.id;
      regressionNumber = Number(run.iteration) || 0;
      if (run.result && typeof run.result === 'object' && !Array.isArray(run.result)) {
        storedResult = run.result;
      }
    }

    const execEndpoint = () => {
      let endpoint = `/executedtestcases?project=${projectId}&test_plan=${testPlanId}&regression=${regressionId}&_limit=-1`;
      if (configId !== null) {
        endpoint += `&test_plan_config=${configId}`;
      }
      return endpoint;
    };

    let summary;
    if (storedResult && configId === null) {
      // Historical run — authoritative frozen per-run summary (matches the UI).
      summary = { ...storedResult };
    } else {
      // Latest run, or a --config slice: count live and derive unexecuted from the
      // plan's real case count (see reconcileUnexecuted).
      const totalPlanned = await fetchPlannedTotal(baseApiUrl, apiKey, projectId, testPlanId, configId);
      let executedCases = await apiGet(baseApiUrl, apiKey, execEndpoint());

      // TCV-6668: optional wait — poll until the run has no unexecuted cases (or timeout).
      if (waitSeconds > 0) {
        const deadline = Date.now() + waitSeconds * 1000;
        let running = reconcileUnexecuted(summarize(executedCases), totalPlanned);
        while ((running.unexecuted || 0) > 0 && Date.now() < deadline) {
          console.log(`⏳ Waiting for execution to complete — ${running.unexecuted} case(s) unexecuted…`);
          await sleep(Math.max(1, pollSeconds) * 1000);
          executedCases = await apiGet(baseApiUrl, apiKey, execEndpoint());
          running = reconcileUnexecuted(summarize(executedCases), totalPlanned);
        }
      }

      if (!Array.isArray(executedCases) || !executedCases.length) {
        console.error(
          `❌ Error: no executed test cases found for run #${regressionNumber || regressionId}` +
            `${configId !== null ? ` (config ${configId})` : ''}.`
        );
        process.exit(2);
      }

      summary = reconcileUnexecuted(summarize(executedCases), totalPlanned);
    }

    // TCV-6668: warn on --fail-on statuses that don't exist in this run (likely a typo).
    const knownStatuses = new Set([...SYSTEM_STATUSES, ...Object.keys(summary)]);
    const unknownFailOn = failOn.filter((status) => !knownStatuses.has(status));
    if (unknownFailOn.length) {
      console.warn(`⚠️  --fail-on status(es) not present in this run: ${unknownFailOn.join(', ')} (typo?)`);
    }

    const verdict = evaluateGate(summary, { failOn, maxFailed, minPassRate, requireComplete });

    const label = planTitle ? `#${testPlanId} "${planTitle}"` : `#${testPlanId}`;
    console.log(
      `ℹ️  Test plan ${label} — run #${regressionNumber || regressionId}` +
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
