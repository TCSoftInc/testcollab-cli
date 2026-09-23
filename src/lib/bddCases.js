/**
 * bddCases.js
 *
 * TCV-7028: match the results of a Cucumber run to the test cases `tc sync`
 * created from the same .feature files.
 *
 * A synced feature file holds no TestCollab id, so the marker `tc report`
 * normally looks for in a test name does not exist. What every Cucumber report
 * does carry is the feature title (the JUnit `classname`, or the suite a
 * Mochawesome reporter wrote) and the scenario title (the test name) — and the
 * sync stored exactly that pair, as a BDD managed suite with a BDD managed test
 * case under it. So the pair is the identity, and the API resolves it.
 *
 * Only cases the sync owns can match. A hand written case that happens to share
 * a scenario title is never written to.
 */

// The API refuses more titles than this in one request, and a long IN list is a
// slow query against a large project.
export const BDD_TITLE_CHUNK_SIZE = 200;

/**
 * Normalize a test case title for comparison.
 * Lowercase, trim, collapse all whitespace to a single space.
 */
export function normalizeTitle(title) {
  return String(title || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// A separator no title can hold, so "Login / a b" and "Login a / b" stay apart.
const TITLE_KEY_SEPARATOR = '\u0000';

function titleKey(featureTitle, scenarioTitle) {
  return `${normalizeTitle(featureTitle)}${TITLE_KEY_SEPARATOR}${normalizeTitle(scenarioTitle)}`;
}

/**
 * The feature titles a test could belong to, nearest first.
 *
 * A Cucumber JUnit report names the feature in `classname`, which the parser
 * reports as the test's suite. A nested report (Mochawesome from a Cucumber
 * preprocessor, or a runner that wraps features in a testsuite per directory)
 * puts the feature somewhere in the suite path, so the ancestors are tried
 * after the leaf.
 */
export function featureTitleCandidates(test) {
  const suitePath = Array.isArray(test?.suitePath) && test.suitePath.length
    ? test.suitePath
    : (test?.suite ? [test.suite] : []);

  const candidates = suitePath
    .map(title => String(title || '').trim())
    .filter(Boolean)
    .reverse();

  return [...new Set(candidates)];
}

/**
 * The titles to ask the API about: every feature title a still-unresolved test
 * could belong to, and every scenario title it reported.
 */
export function collectBddLookup(allTests) {
  const featureTitles = new Set();
  const scenarioTitles = new Set();

  (allTests || []).forEach((test) => {
    if (!test || test.tcId) {
      return;
    }
    const scenarioTitle = String(test.title || '').trim();
    const features = featureTitleCandidates(test);
    if (!scenarioTitle || !features.length) {
      return;
    }
    features.forEach(feature => featureTitles.add(feature));
    scenarioTitles.add(scenarioTitle);
  });

  return {
    featureTitles: [...featureTitles],
    scenarioTitles: [...scenarioTitles]
  };
}

export function chunkList(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Index the API's matches by feature title + scenario title.
 *
 * The API answers in id order, so when a project holds two synced cases with
 * the same title under the same feature the oldest one wins — the same case on
 * every run, rather than one that moves with the row order.
 */
export function indexBddMatches(matches) {
  const index = new Map();

  (matches || []).forEach((match) => {
    if (!match || !match.caseId || !match.suiteTitle || !match.caseTitle) {
      return;
    }
    const key = titleKey(match.suiteTitle, match.caseTitle);
    if (!index.has(key)) {
      index.set(key, String(match.caseId));
    }
  });

  return index;
}

/**
 * Give every unresolved test the id of the synced case it belongs to.
 * `bddCaseId` marks the ones matched this way: they are owned by the sync, so
 * nothing downstream may tag, edit or re-create them.
 */
export function applyBddMatches(allTests, index) {
  let matched = 0;

  (allTests || []).forEach((test) => {
    if (!test || test.tcId) {
      return;
    }
    for (const feature of featureTitleCandidates(test)) {
      const caseId = index.get(titleKey(feature, test.title));
      if (caseId) {
        test.tcId = caseId;
        test.bddCaseId = caseId;
        matched += 1;
        return;
      }
    }
  });

  return matched;
}

/**
 * Ask the API which BDD managed cases carry these titles.
 *
 * The empty `features` and `scenarios` hash lists are deliberate: a TestCollab
 * that predates this feature ignores `titles` and answers with empty results
 * rather than failing, so an older server degrades to "nothing matched".
 */
export async function fetchBddTitleMatches({ baseApiUrl, apiKey, projectId, featureTitles, scenarioTitles }) {
  const matches = [];

  for (const features of chunkList(featureTitles, BDD_TITLE_CHUNK_SIZE)) {
    for (const scenarios of chunkList(scenarioTitles, BDD_TITLE_CHUNK_SIZE)) {
      const response = await fetch(`${baseApiUrl}/bdd/resolve-ids?token=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          projectId,
          features: [],
          scenarios: [],
          titles: { features, scenarios }
        })
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${body}`.trim());
      }

      const data = await response.json();
      const found = data && data.results && Array.isArray(data.results.titleMatches)
        ? data.results.titleMatches
        : [];
      matches.push(...found);
    }
  }

  return matches;
}

/**
 * Resolve every unresolved test against the synced cases and return how many
 * were matched.
 *
 * A failure here is a warning, never a throw: a project with no synced features
 * has nothing to gain from this step, and it must not be able to fail a run
 * that would otherwise upload its results.
 */
export async function matchBddSyncedCases({ baseApiUrl, apiKey, projectId, allTests }) {
  const { featureTitles, scenarioTitles } = collectBddLookup(allTests);
  if (!featureTitles.length || !scenarioTitles.length) {
    return 0;
  }

  let matches;
  try {
    matches = await fetchBddTitleMatches({ baseApiUrl, apiKey, projectId, featureTitles, scenarioTitles });
  } catch (error) {
    console.warn(`⚠️  Could not check for BDD-synced test cases: ${error?.message || String(error)}`);
    return 0;
  }

  return applyBddMatches(allTests, indexBddMatches(matches));
}
