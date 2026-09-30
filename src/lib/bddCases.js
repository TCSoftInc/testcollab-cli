/** TCV-7028: resolve report results using the public SDK's BDD ownership fields. */
import { Configuration, SuitesApi, TestCaseFromJSON } from '@testcollab/sdk';

export function normalizeTitle(title) {
  return String(title || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function featureTitle(test) {
  // JUnit classname must survive nested testsuite paths and humanization.
  return test.classname !== undefined ? test.classname : (test.suite || '');
}

export async function fetchSuiteCases({ baseApiUrl, apiKey, projectId, suiteId }) {
  // TCV-6489: only the transport is raw; ownership is decoded by the generated SDK.
  const params = new URLSearchParams({ project: String(projectId), suite: String(suiteId), _limit: '-1', token: apiKey });
  const response = await fetch(`${baseApiUrl}/testcases?${params}`);
  if (!response.ok) {
    throw new Error(`Could not read cases in suite ${suiteId}: HTTP ${response.status}`);
  }
  const cases = await response.json();
  if (!Array.isArray(cases)) throw new Error(`Invalid case list for suite ${suiteId}`);
  return cases.map(item => TestCaseFromJSON(item));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalTemplate(title) {
  return normalizeTitle(title).replace(/<([^<>]+)>/g, '{{$1}}');
}

function matchesExpandedTitle(template, name) {
  const parts = canonicalTemplate(template).split(/(\{\{[^{}]+\}\})/);
  if (parts.length === 1) return false;
  const pattern = parts.map(part => /^\{\{/.test(part) ? '.*?' : escapeRegex(part)).join('');
  return new RegExp(`^${pattern}$`).test(normalizeTitle(name));
}

export function matchesScenarioTitle(testCase, reportedName) {
  const title = normalizeTitle(testCase.title);
  const name = normalizeTitle(reportedName);
  const rule = String(testCase.description || '').split('\n').find(line => line.startsWith('Rule: '));
  const titles = [title];
  if (rule) titles.push(`${normalizeTitle(rule.slice(6))} - ${title}`);
  return titles.some(candidate => {
    if (candidate === name || matchesExpandedTitle(candidate, name)) return true;
    // The JS/JVM message formatter appends Examples names and #table.row,
    // followed by the expanded pickle name when the outline title is parameterized.
    const numbered = name.match(/^(.*?) - #\d+\.\d+(?:: .*)?$/);
    if (!numbered) return false;
    const prefix = canonicalTemplate(numbered[1]);
    const template = canonicalTemplate(candidate);
    return prefix === template || prefix.startsWith(`${template} - `);
  });
}

/** Marker IDs win; only unmarked results enter title matching. */
export async function matchBddSyncedCases({ baseApiUrl, apiKey, projectId, allTests, humanizeSuiteName, matchUnmanaged = false }) {
  const unresolved = (allTests || []).filter(test => !test.tcId);
  if (!unresolved.length) return 0;
  const config = new Configuration({
    basePath: baseApiUrl,
    fetchApi: (url, options) => {
      const target = new URL(url);
      target.searchParams.set('token', apiKey);
      // getAllSuites has no limit argument. Ask for the whole project, not 100 rows.
      target.searchParams.set('_limit', '-1');
      return fetch(target.toString(), options);
    }
  });
  const suites = await new SuitesApi(config).getAllSuites({ project: projectId });
  const bddSuites = suites.filter(suite => suite.isBddManaged && !suite.isReference);
  // Sync's directory/file containers can have the same title as their feature.
  // Features are the leaves of that BDD tree; empty features remain candidates.
  const bddParents = new Set(bddSuites.map(suite => Number(suite.parentId)));
  const features = bddSuites.filter(suite => !bddParents.has(Number(suite.id)));
  const casesBySuite = new Map();
  const casesIn = async suite => {
    if (!casesBySuite.has(suite.id)) {
      casesBySuite.set(suite.id, await fetchSuiteCases({ baseApiUrl, apiKey, projectId, suiteId: suite.id }));
    }
    return casesBySuite.get(suite.id);
  };
  let matched = 0;
  for (const test of unresolved) {
    const candidates = features.filter(suite => suite.title === featureTitle(test));
    if (candidates.length) {
      if (candidates.length !== 1) {
        test.bddUnmatchedReason = 'ambiguous feature title';
        continue;
      }
      const cases = (await casesIn(candidates[0])).filter(testCase => testCase.isBddManaged && !testCase.archived && !testCase.isReference);
      const matches = cases.filter(testCase => matchesScenarioTitle(testCase, test.title));
      if (matches.length !== 1) {
        test.bddUnmatchedReason = matches.length ? 'ambiguous scenario title' : 'scenario is not synced (or is archived)';
        continue;
      }
      test.tcId = String(matches[0].id);
      test.bddCaseId = test.tcId;
      matched++;
      continue;
    }
    // Existing-plan mode can reuse a normal case, but must never create one.
    // Auto-create keeps its existing humanized hierarchy/title/create path.
    if (matchUnmanaged) {
      const path = test.suitePath?.length ? test.suitePath : [test.suite || ''];
      let parentId = 0;
      let suite;
      for (const part of path) {
        suite = suites.find(item => !item.isBddManaged && item.title === humanizeSuiteName(part) && Number(item.parentId || 0) === parentId);
        if (!suite) break;
        parentId = Number(suite.id);
      }
      if (suite) {
        const testCase = (await casesIn(suite)).find(item => !item.isBddManaged && !item.archived && normalizeTitle(item.title) === normalizeTitle(test.title));
        if (testCase) {
          test.tcId = String(testCase.id);
          test.matchedCaseId = test.tcId;
        }
      }
    }
  }
  return matched;
}

// A partially skipped outline is skipped; a failure always wins. Keep configs apart.
const RESULT_PRIORITY = { 1: 0, 0: 1, 3: 2, 4: 3, 2: 4 };
export function rollUpBddResults(tests) {
  const groups = new Map();
  const result = [];
  for (const test of tests) {
    if (!test.tcId || test.bddUnmatchedReason) continue;
    if (!test.bddCaseId) {
      result.push(test);
      continue;
    }
    const key = `${test.configId || '0'}:${test.tcId}`;
    let combined = groups.get(key);
    if (!combined) {
      combined = { ...test, duration: 0, errDetails: null, attachmentPaths: [] };
      groups.set(key, combined);
      result.push(combined);
    }
    if (RESULT_PRIORITY[test.status] > RESULT_PRIORITY[combined.status]) combined.status = test.status;
    combined.duration += Number(test.duration) || 0;
    if (test.errDetails) combined.errDetails = [combined.errDetails, `${test.title}: ${test.errDetails}`].filter(Boolean).join('\n\n');
    combined.attachmentPaths = [...new Set([...combined.attachmentPaths, ...(test.attachmentPaths || [])])];
  }
  return result;
}
