/** TCV-7028: real SDK decoding and report parsing; only HTTP is stubbed. */
import { jest } from '@jest/globals';
import { matchBddSyncedCases, matchesScenarioTitle, rollUpBddResults } from '../src/lib/bddCases.js';
import { parseJUnitReport, addBddMatchesToUpload, humanizeSuiteName } from '../src/commands/report.js';

const options = { baseApiUrl: 'http://localhost:1337', apiKey: 'test-key', projectId: 4, humanizeSuiteName };
const suite = (id = 11, title = 'Login API', extra = {}) => ({ id, title, parent_id: 0, is_bdd_managed: true, ...extra });
const testCase = (id = 21, title = 'Sign in', extra = {}) => ({ id, title, is_bdd_managed: true, ...extra });
const result = (title = 'Sign in', extra = {}) => ({ title, suite: 'Login API', classname: 'Login API', status: 1, configId: '0', duration: 1, ...extra });
const originalFetch = global.fetch;
function api(suites, cases = {}) {
  global.fetch = jest.fn(async input => {
    const url = new URL(input);
    expect(url.searchParams.get('project')).toBe('4');
    expect(url.searchParams.get('token')).toBe('test-key');
    expect(url.searchParams.get('_limit')).toBe('-1');
    if (url.pathname === '/suites') return new Response(JSON.stringify(suites));
    if (url.pathname === '/testcases') return new Response(JSON.stringify(cases[url.searchParams.get('suite')] || []));
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  });
}
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

it('a marker wins without a title lookup', async () => {
  api([suite()], { 11: [testCase()] });
  const allTests = [result('[TC-90] Sign in', { tcId: '90' })];
  expect(await matchBddSyncedCases({ ...options, allTests })).toBe(0);
  expect(allTests[0].tcId).toBe('90');
  expect(global.fetch).not.toHaveBeenCalled();
});
it('uses exact raw feature title and normalizes only the scenario title', async () => {
  api([suite()], { 11: [testCase()] });
  const allTests = [result('  SIGN\tin '), result('Sign in', { classname: 'Login Api' })];
  expect(await matchBddSyncedCases({ ...options, allTests })).toBe(1);
  expect(allTests[0].bddCaseId).toBe('21');
  expect(allTests[1].tcId).toBeUndefined();
});
it('keeps classname when nested JUnit paths describe a different hierarchy', async () => {
  api([suite()], { 11: [testCase()] });
  const parsed = parseJUnitReport('<testsuite name="runner"><testsuite name="directory"><testcase classname="Login API" name="Sign in"/></testsuite></testsuite>');
  expect(parsed.allTests[0].suitePath).toEqual(['runner', 'directory']);
  await matchBddSyncedCases({ ...options, allTests: parsed.allTests });
  addBddMatchesToUpload(parsed);
  expect(parsed.resultsToUpload['0'][0].tcId).toBe('21');
});
it('does not confuse the sync folder with its same-named feature', async () => {
  api([suite(10), suite(11, 'Login API', { parent_id: 10 })], { 11: [testCase()] });
  const allTests = [result()];
  expect(await matchBddSyncedCases({ ...options, allTests })).toBe(1);
});
it('skips two feature suites with the same raw title', async () => {
  api([suite(11), suite(12)], { 11: [testCase()], 12: [testCase(22)] });
  const allTests = [result()];
  await matchBddSyncedCases({ ...options, allTests });
  expect(allTests[0].bddUnmatchedReason).toBe('ambiguous feature title');
  expect(allTests[0].tcId).toBeUndefined();
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
it('skips duplicate scenario titles instead of choosing the oldest case', async () => {
  api([suite()], { 11: [testCase(), testCase(22, ' SIGN  IN ')] });
  const allTests = [result()];
  await matchBddSyncedCases({ ...options, allTests });
  expect(allTests[0].bddUnmatchedReason).toBe('ambiguous scenario title');
  expect(allTests[0].tcId).toBeUndefined();
});
it('marks a missing scenario as unmatched and never falls through to a manual case', async () => {
  api([suite(), suite(12, 'Login Api', { is_bdd_managed: false })], { 11: [], 12: [testCase()] });
  const allTests = [result()];
  await matchBddSyncedCases({ ...options, allTests, matchUnmanaged: true });
  expect(allTests[0].bddUnmatchedReason).toContain('not synced');
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
it.each([
  { archived: true }, { is_bdd_managed: false }, { is_reference: true }
])('does not match an ineligible BDD case: %j', async extra => {
  api([suite()], { 11: [testCase(21, 'Sign in', extra)] });
  const allTests = [result()];
  await matchBddSyncedCases({ ...options, allTests });
  expect(allTests[0].bddUnmatchedReason).toBeDefined();
});
it('preserves separate cases with different titles even when their steps are identical', async () => {
  api([suite()], { 11: [testCase(21, 'Pay by card'), testCase(22, 'Pay by wallet')] });
  const allTests = [result('Pay by card'), result('Pay by wallet')];
  await matchBddSyncedCases({ ...options, allTests });
  expect(allTests.map(test => test.tcId)).toEqual(['21', '22']);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
it('matches manual cases through the humanized hierarchy in existing-plan mode', async () => {
  api([suite(12, 'Login', { is_bdd_managed: false })], { 12: [testCase(23, 'Sign in', { is_bdd_managed: false })] });
  const allTests = [result('SIGN IN', { classname: 'com.app.LoginTests', suite: 'com.app.LoginTests' })];
  await matchBddSyncedCases({ ...options, allTests, matchUnmanaged: true });
  expect(allTests[0].matchedCaseId).toBe('23');
  expect(allTests[0].bddCaseId).toBeUndefined();
});
it('leaves unmatched manual results for the auto-create path', async () => {
  api([]);
  const allTests = [result()];
  await matchBddSyncedCases({ ...options, allTests });
  expect(allTests[0].bddUnmatchedReason).toBeUndefined();
  expect(allTests[0].tcId).toBeUndefined();
});
it('a lookup failure aborts before auto-create can duplicate an unknown BDD case', async () => {
  global.fetch = jest.fn(async () => new Response('{}', { status: 403 }));
  await expect(matchBddSyncedCases({ ...options, allTests: [result()] })).rejects.toThrow();
});

// Naming from cucumber/junit-xml-formatter (shared by current Cucumber JS and JVM).
it.each([
  ['Pay {{method}}', 'Pay visa'],
  ['Pay {{method}}', 'Pay <method> - #1.1: Pay visa'],
  ['Pay {{method}}', 'Pay <method> - Cards - #2.3: Pay visa'],
  ['Pay', 'Pay - #1.1'],
  ['Pay', 'Pay - Valid cards - #2.1'],
  ['Pay ({{method}}) + tax?', 'Pay (visa) + tax?']
])('matches outline %s to %s', (title, name) => {
  expect(matchesScenarioTitle(testCase(1, title), name)).toBe(true);
});
it('does not treat an arbitrary title prefix as an outline row', () => {
  expect(matchesScenarioTitle(testCase(1, 'Pay'), 'Payment failed')).toBe(false);
  expect(matchesScenarioTitle(testCase(1, 'Pay'), 'Pay - another scenario')).toBe(false);
});
it('recognizes the formatter rule prefix from the synced description', () => {
  expect(matchesScenarioTitle(testCase(1, 'Refund', { description: 'Background\nRule: Within 30 days\nOther' }), 'Within 30 days - Refund')).toBe(true);
});
it('keeps a failed outline failed, sums durations and preserves errors and attachments', () => {
  const rows = [result('row 1', { tcId: '21', bddCaseId: '21', status: 2, duration: 2, errDetails: 'broken', attachmentPaths: ['fail.png'] }), result('row 2', { tcId: '21', bddCaseId: '21', duration: 3, attachmentPaths: ['pass.png'] })];
  const rolled = rollUpBddResults(rows);
  expect(rolled).toHaveLength(1);
  expect(rolled[0]).toMatchObject({ status: 2, duration: 5, attachmentPaths: ['fail.png', 'pass.png'] });
  expect(rolled[0].errDetails).toContain('row 1: broken');
  expect(rows[0].duration).toBe(2);
});
it('keeps configurations separate and preserves skipped outlines', () => {
  const rows = [result('row 1', { tcId: '21', bddCaseId: '21', status: 3 }), result('row 2', { tcId: '21', bddCaseId: '21', status: 3 }), result('row 3', { tcId: '21', bddCaseId: '21', configId: '7' })];
  expect(rollUpBddResults(rows).map(row => [row.configId, row.status])).toEqual([['0', 3], ['7', 1]]);
});
it('rolls parsed outline rows up in existing-plan upload records', async () => {
  api([suite()], { 11: [testCase(21, 'Pay {{method}}')] });
  const parsed = parseJUnitReport('<testsuite><testcase classname="Login API" name="Pay &lt;method&gt; - #1.1: Pay visa"><failure><![CDATA[visa declined]]></failure></testcase><testcase classname="Login API" name="Pay &lt;method&gt; - #1.2: Pay amex"><failure><![CDATA[amex declined]]></failure></testcase></testsuite>');
  await matchBddSyncedCases({ ...options, allTests: parsed.allTests });
  addBddMatchesToUpload(parsed);
  expect(parsed.resultsToUpload['0']).toHaveLength(1);
  expect(parsed.resultsToUpload['0'][0].status).toBe(2);
  expect(parsed.resultsToUpload['0'][0].errDetails).toBe(
    'Pay <method> - #1.1: Pay visa: visa declined\n\nPay <method> - #1.2: Pay amex: amex declined'
  );
  expect(parsed.unresolvedIds).toEqual([]);
});
