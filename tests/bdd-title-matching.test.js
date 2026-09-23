/**
 * TCV-7028: matching CI results to the test cases `tc sync` created.
 *
 * A synced .feature file holds no TestCollab id, so these tests cover the pair
 * that identifies a case instead: the feature title and the scenario title.
 */

import { jest } from '@jest/globals';
import {
  BDD_TITLE_CHUNK_SIZE,
  applyBddMatches,
  collectBddLookup,
  featureTitleCandidates,
  indexBddMatches,
  matchBddSyncedCases
} from '../src/lib/bddCases.js';
import { addBddMatchesToUpload, parseJUnitReport } from '../src/commands/report.js';

// What `@cucumber/junit-xml-formatter` writes: the feature in classname, the
// scenario in name, and no TestCollab id anywhere.
const CUCUMBER_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="Cucumber" tests="3" failures="1" skipped="0" time="0.5">
  <testcase classname="User login" name="Valid password signs in" time="0.1" />
  <testcase classname="User login" name="Wrong password is refused" time="0.2">
    <failure message="expected 401">AssertionError: expected 401 but got 200</failure>
  </testcase>
  <testcase classname="Checkout" name="Valid password signs in" time="0.2" />
</testsuite>`;

function apiResponse(titleMatches, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve({ success: true, results: { suites: {}, cases: {}, titleMatches } }),
    text: () => Promise.resolve('')
  });
}

describe('featureTitleCandidates', () => {
  test('reads the feature from the suite a flat JUnit report gives', () => {
    expect(featureTitleCandidates({ suite: 'User login', suitePath: ['User login'] })).toEqual(['User login']);
  });

  test('tries the nearest suite first, then its ancestors', () => {
    expect(featureTitleCandidates({ suitePath: ['features', 'Auth', 'User login'] }))
      .toEqual(['User login', 'Auth', 'features']);
  });

  test('falls back to the leaf suite when there is no path', () => {
    expect(featureTitleCandidates({ suite: 'User login' })).toEqual(['User login']);
  });

  test('drops blanks and duplicates', () => {
    expect(featureTitleCandidates({ suitePath: ['Auth', '  ', 'Auth'] })).toEqual(['Auth']);
  });

  test('a test with no suite at all has nothing to match on', () => {
    expect(featureTitleCandidates({ title: 'orphan' })).toEqual([]);
  });
});

describe('collectBddLookup', () => {
  test('asks about every unresolved test, by feature and by scenario', () => {
    const { allTests } = parseJUnitReport(CUCUMBER_JUNIT);
    expect(collectBddLookup(allTests)).toEqual({
      featureTitles: ['User login', 'Checkout'],
      scenarioTitles: ['Valid password signs in', 'Wrong password is refused']
    });
  });

  test('skips tests that already carry a TestCollab id', () => {
    const lookup = collectBddLookup([
      { title: 'Already tagged', suite: 'User login', tcId: '42' },
      { title: 'Valid password signs in', suite: 'User login' }
    ]);
    expect(lookup.scenarioTitles).toEqual(['Valid password signs in']);
  });

  test('a report with no suites asks nothing', () => {
    expect(collectBddLookup([{ title: 'orphan' }])).toEqual({ featureTitles: [], scenarioTitles: [] });
  });
});

describe('applyBddMatches', () => {
  const matches = [
    { caseId: 11, caseTitle: 'Valid password signs in', suiteId: 3, suiteTitle: 'User login' },
    { caseId: 12, caseTitle: 'Wrong password is refused', suiteId: 3, suiteTitle: 'User login' },
    { caseId: 13, caseTitle: 'Valid password signs in', suiteId: 4, suiteTitle: 'Checkout' }
  ];

  test('the same scenario title under two features lands on two different cases', () => {
    const { allTests } = parseJUnitReport(CUCUMBER_JUNIT);
    expect(applyBddMatches(allTests, indexBddMatches(matches))).toBe(3);
    expect(allTests.map(t => t.tcId)).toEqual(['11', '12', '13']);
    expect(allTests.map(t => t.bddCaseId)).toEqual(['11', '12', '13']);
  });

  test('matches through a different case and spacing', () => {
    const tests = [{ title: '  VALID   password signs in ', suite: 'user login' }];
    expect(applyBddMatches(tests, indexBddMatches(matches))).toBe(1);
    expect(tests[0].tcId).toBe('11');
  });

  test('a scenario of another feature is left unresolved', () => {
    const tests = [{ title: 'Wrong password is refused', suite: 'Checkout' }];
    expect(applyBddMatches(tests, indexBddMatches(matches))).toBe(0);
    expect(tests[0].tcId).toBeUndefined();
  });

  test('an ancestor suite matches when the nearest one does not', () => {
    const tests = [{ title: 'Valid password signs in', suitePath: ['User login', 'Happy path'] }];
    expect(applyBddMatches(tests, indexBddMatches(matches))).toBe(1);
    expect(tests[0].tcId).toBe('11');
  });

  test('a test that already has an id is never re-pointed', () => {
    const tests = [{ title: 'Valid password signs in', suite: 'User login', tcId: '99' }];
    expect(applyBddMatches(tests, indexBddMatches(matches))).toBe(0);
    expect(tests[0].tcId).toBe('99');
    expect(tests[0].bddCaseId).toBeUndefined();
  });

  test('two synced cases with the same title resolve to the older one, every run', () => {
    const duplicates = [
      { caseId: 11, caseTitle: 'Valid password signs in', suiteId: 3, suiteTitle: 'User login' },
      { caseId: 77, caseTitle: 'Valid password signs in', suiteId: 3, suiteTitle: 'User login' }
    ];
    const tests = [{ title: 'Valid password signs in', suite: 'User login' }];
    applyBddMatches(tests, indexBddMatches(duplicates));
    expect(tests[0].tcId).toBe('11');
  });

  test('an incomplete match is ignored rather than trusted', () => {
    expect(indexBddMatches([{ caseId: 5, caseTitle: 'x' }, { caseTitle: 'y', suiteTitle: 'f' }, null]).size).toBe(0);
  });
});

describe('matchBddSyncedCases', () => {
  const options = { baseApiUrl: 'http://localhost:1337', apiKey: 'k-1', projectId: 8 };

  afterEach(() => {
    delete global.fetch;
    jest.restoreAllMocks();
  });

  test('asks the API about the parsed titles and applies what comes back', async () => {
    global.fetch = jest.fn(() => apiResponse([
      { caseId: 11, caseTitle: 'Valid password signs in', suiteId: 3, suiteTitle: 'User login' }
    ]));
    const { allTests } = parseJUnitReport(CUCUMBER_JUNIT);

    expect(await matchBddSyncedCases({ ...options, allTests })).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, request] = global.fetch.mock.calls[0];
    expect(url).toBe('http://localhost:1337/bdd/resolve-ids?token=k-1');
    expect(JSON.parse(request.body)).toEqual({
      projectId: 8,
      // A TestCollab that predates this feature reads only these two and answers
      // empty results, instead of failing the run.
      features: [],
      scenarios: [],
      titles: {
        features: ['User login', 'Checkout'],
        scenarios: ['Valid password signs in', 'Wrong password is refused']
      }
    });
    expect(allTests[0].tcId).toBe('11');
  });

  test('sends long title lists in chunks', async () => {
    global.fetch = jest.fn(() => apiResponse([]));
    const allTests = Array.from({ length: BDD_TITLE_CHUNK_SIZE + 1 }, (unused, i) => ({
      title: `Scenario ${i}`,
      suite: 'User login'
    }));

    await matchBddSyncedCases({ ...options, allTests });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).titles.scenarios).toHaveLength(BDD_TITLE_CHUNK_SIZE);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).titles.scenarios).toHaveLength(1);
  });

  test('a project with nothing synced costs no request', async () => {
    global.fetch = jest.fn(() => apiResponse([]));
    expect(await matchBddSyncedCases({ ...options, allTests: [{ title: 'orphan' }] })).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a server that does not answer with matches is not an error', async () => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, results: { suites: {}, cases: {} } }),
      text: () => Promise.resolve('')
    }));
    const { allTests } = parseJUnitReport(CUCUMBER_JUNIT);
    expect(await matchBddSyncedCases({ ...options, allTests })).toBe(0);
    expect(allTests[0].tcId).toBeNull();
  });

  test('a failed lookup warns and lets the upload go on', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn(() => apiResponse([], false, 500));
    const { allTests } = parseJUnitReport(CUCUMBER_JUNIT);

    expect(await matchBddSyncedCases({ ...options, allTests })).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not check for BDD-synced test cases'));
  });
});

describe('addBddMatchesToUpload', () => {
  test('a matched result joins the upload and stops counting as missing an id', () => {
    const parsedReport = parseJUnitReport(CUCUMBER_JUNIT);
    expect(parsedReport.resultsToUpload).toEqual({});
    // The parser deduplicates by title: the same scenario title ran under two features.
    expect(parsedReport.unresolvedIds).toEqual(['Valid password signs in', 'Wrong password is refused']);

    applyBddMatches(parsedReport.allTests, indexBddMatches([
      { caseId: 11, caseTitle: 'Valid password signs in', suiteId: 3, suiteTitle: 'User login' },
      { caseId: 12, caseTitle: 'Wrong password is refused', suiteId: 3, suiteTitle: 'User login' }
    ]));
    addBddMatchesToUpload(parsedReport);

    expect(parsedReport.resultsToUpload['0']).toEqual([
      expect.objectContaining({ tcId: '11', status: 1, title: 'Valid password signs in' }),
      expect.objectContaining({ tcId: '12', status: 2, title: 'Wrong password is refused' })
    ]);
    // The Checkout run of the same scenario title matched nothing, so the title stays.
    expect(parsedReport.unresolvedIds).toEqual(['Valid password signs in']);
  });

  test('a failure carries its error details to the execution', () => {
    const parsedReport = parseJUnitReport(CUCUMBER_JUNIT);
    applyBddMatches(parsedReport.allTests, indexBddMatches([
      { caseId: 12, caseTitle: 'Wrong password is refused', suiteId: 3, suiteTitle: 'User login' }
    ]));
    addBddMatchesToUpload(parsedReport);

    expect(parsedReport.resultsToUpload['0'][0]).toEqual(expect.objectContaining({
      tcId: '12',
      status: 2,
      errDetails: 'AssertionError: expected 401 but got 200'
    }));
  });
});
