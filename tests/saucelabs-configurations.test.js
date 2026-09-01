/**
 * TCV-6921 — a JUnit report produced on several browsers keeps one result per browser.
 *
 * The fixture is a REAL saucectl report: a Playwright spec run on Sauce Labs
 * across Chromium and Firefox, captured with `--reporters.junit.enabled=true`.
 * It matters that it is real, because the shape is what the fix hangs off — the
 * browser lives only in the top-level `<testsuite>`'s `<properties>`, and the
 * test names are byte-identical between the two suites.
 *
 * The upload test asserts the WIRE BODY of each `PUT /executedtestcases/:id`
 * rather than an internal return value: `test_plan_config` is what decides which
 * browser's row a result lands on, and before this change all six results were
 * written to three rows with no `test_plan_config` at all.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { parseJUnitReport, report } from '../src/commands/report.js';
import {
  matchSuitesToConfigurations,
  readSuiteConfigurationSource,
  scoreSuiteAgainstConfiguration,
  suiteToConfigurationParameters
} from '../src/lib/reportConfigurations.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/saucectl-report.xml'
);

const CHROMIUM_SESSION = 'https://app.eu-central-1.saucelabs.com/tests/13bdb6b56d4c4ac0943de345ecd39b24';
const FIREFOX_SESSION = 'https://app.eu-central-1.saucelabs.com/tests/2f0a5c54fe9148d5854d78aedcc0b435';

describe('parsing a real saucectl report', () => {
  const xml = fs.readFileSync(FIXTURE, 'utf8');

  test('reads the browser, the platform and the session URL off each top-level suite', () => {
    const { reportSuites } = parseJUnitReport(xml);

    expect(reportSuites).toEqual([
      {
        suiteName: 'Chromium Win11',
        browser: 'chromium 149',
        platform: 'Windows 11',
        sessionUrl: CHROMIUM_SESSION
      },
      {
        suiteName: 'Firefox Win11',
        browser: 'firefox 151',
        platform: 'Windows 11',
        sessionUrl: FIREFOX_SESSION
      }
    ]);
  });

  test('tags every result with the suite it came from, so the browsers stay apart', () => {
    const records = parseJUnitReport(xml).resultsToUpload['0'];

    expect(records).toHaveLength(6);
    expect(records.slice(0, 3).map(r => r.configSource.suiteName))
      .toEqual(['Chromium Win11', 'Chromium Win11', 'Chromium Win11']);
    expect(records.slice(3).map(r => r.configSource.suiteName))
      .toEqual(['Firefox Win11', 'Firefox Win11', 'Firefox Win11']);
  });

  test('the two browsers disagree about the same test case, which is what gets lost', () => {
    const records = parseJUnitReport(xml).resultsToUpload['0'];
    const byBrowser = suiteName => records.filter(r => r.configSource.suiteName === suiteName);

    // TC-1 passed on Chromium and failed on Firefox.
    expect(byBrowser('Chromium Win11')[0].tcId).toBe('1');
    expect(byBrowser('Chromium Win11')[0].status).toBe(1);
    expect(byBrowser('Firefox Win11')[0].tcId).toBe('1');
    expect(byBrowser('Firefox Win11')[0].status).toBe(2);
  });

  test('a report whose suites carry no properties parses exactly as before', () => {
    const plain = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Suite" tests="2" failures="0">
    <testcase classname="Suite" name="[TC-100] one" time="0.5" />
    <testcase classname="Suite" name="[TC-200] two" time="1.0" />
  </testsuite>
</testsuites>`;
    const parsed = parseJUnitReport(plain);

    expect(parsed.reportSuites).toEqual([]);
    expect(parsed.hasConfig).toBe(false);
    expect(parsed.resultsToUpload['0'].map(r => r.tcId)).toEqual(['100', '200']);
    expect(parsed.resultsToUpload['0'][0].configSource).toBeNull();
  });

  test('an explicit config-id-N marker still wins over the suite properties', () => {
    const marked = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Chromium Win11">
    <properties>
      <property name="browser" value="chromium 149"></property>
      <property name="platform" value="Windows 11"></property>
    </properties>
    <testcase classname="tc.spec.js" name="[TC-1] config-id-77 one" time="0.5" />
  </testsuite>
</testsuites>`;
    const parsed = parseJUnitReport(marked);

    expect(parsed.hasConfig).toBe(true);
    expect(Object.keys(parsed.resultsToUpload)).toEqual(['77']);
  });

  test('a <properties> block inside a <testcase> is not read as the suite`s', () => {
    const nested = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Suite">
    <testcase classname="Suite" name="[TC-1] one" time="0.5">
      <properties><property name="browser" value="chromium"></property></properties>
    </testcase>
  </testsuite>
</testsuites>`;

    expect(parseJUnitReport(nested).reportSuites).toEqual([]);
  });
});

describe('readSuiteConfigurationSource', () => {
  test('returns null when the suite names neither a browser nor a platform', () => {
    expect(readSuiteConfigurationSource('Suite', { url: 'https://example.test' })).toBeNull();
    expect(readSuiteConfigurationSource('Suite', {})).toBeNull();
  });

  test('accepts the browserName / platformName spellings other runners use', () => {
    expect(readSuiteConfigurationSource('Suite', { browsername: 'safari', platformname: 'macOS 13' }))
      .toEqual({ suiteName: 'Suite', browser: 'safari', platform: 'macOS 13', sessionUrl: '' });
  });
});

describe('matchSuitesToConfigurations', () => {
  const chromium = { suiteName: 'Chromium Win11', browser: 'chromium 149', platform: 'Windows 11' };
  const firefox = { suiteName: 'Firefox Win11', browser: 'firefox 151', platform: 'Windows 11' };

  const config = (id, browser, os) => ({
    id,
    parameters: [{ field: 'browser', value: browser }, { field: 'os', value: os }]
  });

  test('matches on browser and platform, ignoring case and the version suffix', () => {
    const result = matchSuitesToConfigurations(
      [chromium, firefox],
      [config(164, 'Chromium', 'Windows 11'), config(165, 'Firefox', 'Windows 11')]
    );

    expect(result.matched).toBe(true);
    expect(result.bySuiteName).toEqual({ 'Chromium Win11': 164, 'Firefox Win11': 165 });
  });

  test('a plan with more configurations than the report has browsers still matches', () => {
    const result = matchSuitesToConfigurations(
      [chromium],
      [config(1, 'Firefox', 'Windows 11'), config(2, 'Chromium', 'Windows 11')]
    );

    expect(result.bySuiteName).toEqual({ 'Chromium Win11': 2 });
  });

  test('the browser+platform match claims its configuration before a weaker one can', () => {
    // Both configurations name Chromium; only one names the platform the suite ran on.
    const result = matchSuitesToConfigurations(
      [chromium],
      [config(1, 'Chromium', 'macOS 13'), config(2, 'Chromium', 'Windows 11')]
    );

    expect(result.bySuiteName).toEqual({ 'Chromium Win11': 2 });
  });

  test('falls back to the suite name when the configuration names something else', () => {
    const result = matchSuitesToConfigurations(
      [{ suiteName: 'Nightly smoke', browser: 'chromium 149', platform: 'Windows 11' }],
      [{ id: 9, parameters: [{ field: 'run', value: 'Nightly' }, { field: 'kind', value: 'smoke' }] }]
    );

    expect(result.bySuiteName).toEqual({ 'Nightly smoke': 9 });
  });

  test('"chrome" never matches inside "chromium"', () => {
    const result = matchSuitesToConfigurations([chromium], [config(1, 'Chrome', 'Windows 11')]);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain('Chromium Win11');
  });

  test('one unmatched suite drops the whole mapping, so no browser silently overwrites another', () => {
    const webkit = { suiteName: 'Webkit Mac', browser: 'webkit 26', platform: 'macOS 13' };
    const result = matchSuitesToConfigurations(
      [chromium, webkit],
      [config(164, 'Chromium', 'Windows 11'), config(165, 'Firefox', 'Windows 11')]
    );

    expect(result.matched).toBe(false);
    expect(result.bySuiteName).toEqual({});
    expect(result.reason).toContain('Webkit Mac');
  });

  test('refuses when the report has more browsers than the plan has configurations', () => {
    const result = matchSuitesToConfigurations([chromium, firefox], [config(164, 'Chromium', 'Windows 11')]);

    expect(result.matched).toBe(false);
    expect(result.reason).toContain('only 1 configuration');
  });

  test('refuses when the plan has no configurations at all', () => {
    const result = matchSuitesToConfigurations([chromium], []);

    expect(result.matched).toBe(false);
    expect(result.reason).toBe('the test plan has no configurations');
  });

  test('two suites never share a configuration', () => {
    const result = matchSuitesToConfigurations(
      [chromium, { ...firefox, browser: 'chromium 149' }],
      [config(164, 'Chromium', 'Windows 11'), config(165, 'Firefox', 'Windows 11')]
    );

    expect(result.matched).toBe(false);
  });

  test('scores a configuration with no parameters as no match', () => {
    expect(scoreSuiteAgainstConfiguration(chromium, { id: 1, parameters: [] })).toBe(0);
  });
});

describe('suiteToConfigurationParameters', () => {
  test('turns a suite into the {field,value} pairs a configuration stores', () => {
    expect(suiteToConfigurationParameters({
      suiteName: 'Chromium Win11',
      browser: 'chromium 149',
      platform: 'Windows 11'
    })).toEqual([
      { field: 'browser', value: 'chromium 149' },
      { field: 'os', value: 'Windows 11' }
    ]);
  });

  test('falls back to the suite name when neither browser nor platform is known', () => {
    expect(suiteToConfigurationParameters({ suiteName: 'Nightly' }))
      .toEqual([{ field: 'suite', value: 'Nightly' }]);
  });
});

describe('uploading the real report to a plan with two configurations', () => {
  const API_URL = 'http://api.test';
  const TOKEN = 'token-123';
  const PROJECT = 8;
  const PLAN = 131;
  const CHROMIUM_CONFIG = 166;
  const FIREFOX_CONFIG = 167;

  let exitSpy;
  let logSpy;
  let warnSpy;

  /**
   * One executed case per (test case, configuration) pair, which is what
   * assignment by configuration creates.
   */
  function assignedCases() {
    const cases = [];
    let id = 53407;
    for (const testCase of [1, 2, 3]) {
      for (const config of [CHROMIUM_CONFIG, FIREFOX_CONFIG]) {
        cases.push({
          id: id++,
          test_plan_test_case: { id: 13900 + testCase, test_case: testCase },
          test_plan_config: { id: config },
          time_taken: 0
        });
      }
    }
    return cases;
  }

  function mockApi({ configurations } = {}) {
    const puts = [];
    const routes = {
      'GET /system': { ok: true },
      [`GET /projects/${PROJECT}`]: { id: PROJECT, company: { id: 5004 } },
      [`GET /testplans/${PLAN}`]: { id: PLAN, project: { id: PROJECT } },
      'GET /testplanregressions': [{ id: 364 }],
      'GET /testplanconfigurations': configurations !== undefined
        ? configurations
        : [
            { id: CHROMIUM_CONFIG, parameters: [{ field: 'browser', value: 'Chromium' }, { field: 'os', value: 'Windows 11' }] },
            { id: FIREFOX_CONFIG, parameters: [{ field: 'browser', value: 'Firefox' }, { field: 'os', value: 'Windows 11' }] }
          ],
      'GET /users/me': { id: 5011 },
      'GET /executedtestcases': assignedCases()
    };

    global.fetch = jest.fn(async (url, opts = {}) => {
      const method = opts.method || 'GET';
      const { pathname } = new URL(url);
      const body = opts.body ? JSON.parse(opts.body) : null;

      if (method === 'PUT' && /^\/executedtestcases\/\d+$/.test(pathname)) {
        puts.push(body);
        return jsonResponse({ id: body.id });
      }
      if (method === 'POST') {
        return jsonResponse({ id: 1 });
      }

      const route = routes[`${method} ${pathname}`];
      return jsonResponse(route === undefined ? {} : route);
    });

    return puts;
  }

  function jsonResponse(payload) {
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, statusText: 'OK', json: async () => payload, text: async () => text };
  }

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
    delete global.fetch;
  });

  const runReport = () => report({
    project: String(PROJECT),
    testPlanId: String(PLAN),
    format: 'junit',
    resultFile: FIXTURE,
    apiUrl: API_URL,
    apiKey: TOKEN
  });

  test('writes all six results, one per browser per test case', async () => {
    const puts = mockApi();
    await runReport();

    expect(puts).toHaveLength(6);
    expect(new Set(puts.map(p => p.id)).size).toBe(6);
  });

  test('each result carries the configuration of the browser that produced it', async () => {
    const puts = mockApi();
    await runReport();

    const byConfig = configId => puts.filter(p => p.test_plan_config === configId);
    expect(byConfig(CHROMIUM_CONFIG)).toHaveLength(3);
    expect(byConfig(FIREFOX_CONFIG)).toHaveLength(3);
  });

  test("the passing browser's result survives the failing one", async () => {
    const puts = mockApi();
    await runReport();

    // TC-1 and TC-3 passed on Chromium (status 1) and failed on Firefox (status 2).
    // Before this change both rows read "failed", because Firefox was written last.
    const statusFor = (execId) => puts.find(p => p.id === execId).status;
    expect(statusFor(53407)).toBe(1); // test case 1, Chromium
    expect(statusFor(53408)).toBe(2); // test case 1, Firefox
    expect(statusFor(53411)).toBe(1); // test case 3, Chromium
    expect(statusFor(53412)).toBe(2); // test case 3, Firefox
  });

  test('each result links back to the Sauce Labs session it came from', async () => {
    const puts = mockApi();
    await runReport();

    const sessionFor = configId =>
      new Set(puts.filter(p => p.test_plan_config === configId).map(p => p.execution_context.session_url));

    expect(sessionFor(CHROMIUM_CONFIG)).toEqual(new Set([CHROMIUM_SESSION]));
    expect(sessionFor(FIREFOX_CONFIG)).toEqual(new Set([FIREFOX_SESSION]));
  });

  test('the existing provenance keys are kept alongside the session URL', async () => {
    const puts = mockApi();
    await runReport();

    expect(puts[0].execution_context.tool).toBe('tc-cli');
    expect(puts[0].execution_source).toBeTruthy();
  });

  test('time_taken is per browser, not the two browsers summed into one row', async () => {
    const puts = mockApi();
    await runReport();

    // Chromium's TC-1 took 1.608s, Firefox's took 0.005s; both round up to 1s.
    expect(puts.find(p => p.id === 53407).time_taken).toBe(2000);
    expect(puts.find(p => p.id === 53408).time_taken).toBe(1000);
  });

  test('a plan with no configurations keeps the old behaviour and says so', async () => {
    const puts = mockApi({ configurations: [] });
    await runReport();

    expect(puts.every(p => p.test_plan_config === undefined)).toBe(true);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('the test plan has no configurations');
  });

  test('an unmatchable browser leaves every result unmapped rather than half-mapped', async () => {
    const puts = mockApi({
      configurations: [
        { id: CHROMIUM_CONFIG, parameters: [{ field: 'browser', value: 'Chromium' }] },
        { id: FIREFOX_CONFIG, parameters: [{ field: 'browser', value: 'Safari' }] }
      ]
    });
    await runReport();

    expect(puts.every(p => p.test_plan_config === undefined)).toBe(true);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('Firefox Win11');
  });
});
