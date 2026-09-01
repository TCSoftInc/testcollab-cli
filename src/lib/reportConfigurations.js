/**
 * reportConfigurations.js
 *
 * TCV-6921 — map the browsers a JUnit report was produced on onto the
 * configurations a TestCollab plan already has.
 *
 * saucectl (and any runner that fans one spec out over several platforms) emits
 * one top-level `<testsuite>` per job and puts the browser, the platform and the
 * session URL in that suite's `<properties>` block:
 *
 *   <testsuite name="Chromium Win11">
 *     <properties>
 *       <property name="url" value="https://app.eu-central-1.saucelabs.com/tests/..."/>
 *       <property name="browser" value="chromium 149"/>
 *       <property name="platform" value="Windows 11"/>
 *     </properties>
 *
 * The test names underneath are identical in every suite, so the browser is the
 * only thing that tells the results apart. Without this mapping every suite
 * writes to the same executed case and the last browser wins.
 *
 * Configurations are NOT created here. `POST /testplanconfigurations` refuses
 * once a plan has executed cases, and it replaces the whole set rather than
 * appending — so on an existing plan the only correct move is to match.
 */

// The property names saucectl uses. `device` is included because the same
// reporter emits it for real-device jobs.
const BROWSER_PROPERTY_KEYS = ['browser', 'browsername'];
const PLATFORM_PROPERTY_KEYS = ['platform', 'platformname', 'os', 'device'];
const SESSION_URL_PROPERTY_KEYS = ['url'];

function firstProperty(properties, keys) {
  if (!properties) {
    return '';
  }
  for (const key of keys) {
    const value = properties[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

/**
 * Read the browser / platform / session URL a `<testsuite>`'s properties describe.
 * Returns null when the suite carries none of them, which is what keeps every
 * hand-written JUnit report on its existing code path.
 */
export function readSuiteConfigurationSource(suiteName, properties) {
  const browser = firstProperty(properties, BROWSER_PROPERTY_KEYS);
  const platform = firstProperty(properties, PLATFORM_PROPERTY_KEYS);
  const sessionUrl = firstProperty(properties, SESSION_URL_PROPERTY_KEYS);

  if (!browser && !platform) {
    return null;
  }

  return {
    suiteName: String(suiteName || '').trim(),
    browser,
    platform,
    sessionUrl
  };
}

function normalize(value) {
  return String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Drop the version a runner appends to the browser name: saucectl reports
 * "chromium 149" while a configuration says "Chromium". The version is the part
 * that changes every time Sauce Labs updates an image, so matching on it would
 * make the mapping break on its own.
 */
function stripVersion(value) {
  return normalize(value).replace(/[\s/_-]*v?\d+(\.\d+)*\.?$/, '').trim();
}

/** Every value stored on a configuration's `parameters` array, normalized. */
function configurationValues(configuration) {
  const parameters = Array.isArray(configuration?.parameters) ? configuration.parameters : [];
  return parameters
    .map((parameter) => normalize(parameter?.value))
    .filter(Boolean);
}

/** A whole-word test, so "chrome" never matches inside "chromium". */
function containsWord(haystack, needle) {
  if (!haystack || !needle) {
    return false;
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * How well one report suite matches one configuration. Higher is better; 0 means
 * no match at all. The tiers are deliberately coarse so the outcome is easy to
 * explain in a warning message.
 *
 *   3  browser and platform both named by the configuration
 *   2  browser named by the configuration
 *   1  the configuration's values all appear in the suite name
 */
export function scoreSuiteAgainstConfiguration(suite, configuration) {
  const values = configurationValues(configuration);
  if (!values.length) {
    return 0;
  }

  const browser = stripVersion(suite?.browser);
  const platform = normalize(suite?.platform);

  const browserMatched = Boolean(browser) && values.some((value) => stripVersion(value) === browser);
  const platformMatched = Boolean(platform) && values.some((value) => normalize(value) === platform);

  if (browserMatched && platformMatched) {
    return 3;
  }
  if (browserMatched) {
    return 2;
  }

  const suiteName = normalize(suite?.suiteName);
  if (suiteName && values.every((value) => containsWord(suiteName, value))) {
    return 1;
  }

  return 0;
}

/**
 * Assign each report suite its own configuration.
 *
 * All or nothing on purpose: a partial mapping would leave one browser still
 * overwriting another, which is the bug being fixed and is harder to notice than
 * no mapping at all. On failure the caller keeps its existing behaviour and says
 * why.
 *
 * @returns {{matched: boolean, bySuiteName: Object<string, number>, reason: string}}
 */
export function matchSuitesToConfigurations(suites, configurations) {
  const reportSuites = Array.isArray(suites) ? suites.filter(Boolean) : [];
  const planConfigurations = Array.isArray(configurations) ? configurations.filter((c) => c && c.id) : [];

  if (!reportSuites.length) {
    return { matched: false, bySuiteName: {}, reason: 'the report has no browser-specific suites' };
  }
  if (!planConfigurations.length) {
    return { matched: false, bySuiteName: {}, reason: 'the test plan has no configurations' };
  }
  if (reportSuites.length > planConfigurations.length) {
    return {
      matched: false,
      bySuiteName: {},
      reason: `the report has ${reportSuites.length} browser suites but the test plan has only ${planConfigurations.length} configuration(s)`
    };
  }

  // Best scores first, so a suite that names both its browser and its platform
  // claims that configuration before a weaker suite-name match can take it.
  const candidates = [];
  reportSuites.forEach((suite, suiteIndex) => {
    planConfigurations.forEach((configuration, configurationIndex) => {
      const score = scoreSuiteAgainstConfiguration(suite, configuration);
      if (score > 0) {
        candidates.push({ score, suiteIndex, configurationIndex });
      }
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.suiteIndex - b.suiteIndex || a.configurationIndex - b.configurationIndex);

  const takenSuites = new Set();
  const takenConfigurations = new Set();
  const bySuiteName = {};

  for (const candidate of candidates) {
    if (takenSuites.has(candidate.suiteIndex) || takenConfigurations.has(candidate.configurationIndex)) {
      continue;
    }
    takenSuites.add(candidate.suiteIndex);
    takenConfigurations.add(candidate.configurationIndex);
    bySuiteName[reportSuites[candidate.suiteIndex].suiteName] =
      planConfigurations[candidate.configurationIndex].id;
  }

  if (takenSuites.size !== reportSuites.length) {
    const unmatched = reportSuites
      .filter((_, index) => !takenSuites.has(index))
      .map((suite) => `"${suite.suiteName}" (${[suite.browser, suite.platform].filter(Boolean).join(' / ')})`)
      .join(', ');
    return {
      matched: false,
      bySuiteName: {},
      reason: `no configuration matches ${unmatched}`
    };
  }

  return { matched: true, bySuiteName, reason: '' };
}

/**
 * A configuration's `parameters` describing one report suite, for the
 * `--auto-create` path where the plan is new and configurations can still be
 * written. Mirrors what the app's plan wizard stores: a list of
 * `{ field, value }` pairs.
 */
export function suiteToConfigurationParameters(suite) {
  const parameters = [];
  const browser = String(suite?.browser || '').trim();
  const platform = String(suite?.platform || '').trim();

  if (browser) {
    parameters.push({ field: 'browser', value: browser });
  }
  if (platform) {
    parameters.push({ field: 'os', value: platform });
  }
  if (!parameters.length && suite?.suiteName) {
    parameters.push({ field: 'suite', value: String(suite.suiteName).trim() });
  }

  return parameters;
}
