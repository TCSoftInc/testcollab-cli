/** TCV-7028: drive both report modes through the real SDK and command. */
import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { report } from '../src/commands/report.js';

let temp, calls, suites, cases, assigned, nextId;
const originalFetch = global.fetch;
const bddSuite = (id, title, parent_id = 0) => ({ id, title, parent_id, is_bdd_managed: true });
const bddCase = (id, title, suite) => ({ id, title, suite: { id: suite }, is_bdd_managed: true });
function wire(data, status = 200) { return new Response(JSON.stringify(data), { status }); }

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcv7028-report-'));
  calls = []; nextId = 500;
  suites = [bddSuite(10, 'Login API')];
  cases = [bddCase(21, 'Sign in', 10), bddCase(22, 'Sign out', 10), bddCase(23, 'Pay {{method}}', 10)];
  assigned = [21, 22, 23];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
  const write = fs.writeFileSync;
  jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => write(file === 'tmp/tc_test_plan' ? path.join(temp, 'plan') : file, ...args));
  global.fetch = jest.fn(async (input, options = {}) => {
    const url = new URL(input); const endpoint = url.pathname; const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ endpoint, method, body, query: url.searchParams });
    if (endpoint === '/suites' && method === 'GET') return wire(suites);
    if (endpoint === '/suites' && method === 'POST') { const item = { id: nextId++, ...body }; suites.push(item); return wire(item); }
    if (endpoint === '/testcases' && method === 'GET') return wire(cases.filter(item => item.suite.id === Number(url.searchParams.get('suite'))));
    if (/^\/testcases\/\d+$/.test(endpoint) && method === 'GET') return wire(cases.find(item => item.id === Number(endpoint.split('/')[2])) || {}, cases.some(item => item.id === Number(endpoint.split('/')[2])) ? 200 : 404);
    if (endpoint === '/testcases' && method === 'POST') { const item = { id: nextId++, ...body, suite: { id: body.suite } }; cases.push(item); return wire(item); }
    if (/^\/testcases\/\d+$/.test(endpoint) && method === 'PUT') return wire({ id: Number(endpoint.split('/')[2]), ...body });
    if (endpoint === '/tags' && method === 'GET') return wire([{ id: 8, name: 'CI Imported' }]);
    if (endpoint === '/users/me') return wire({ id: 1, first_name: 'Tester' });
    if (endpoint === '/testplanfolders' && method === 'GET') return wire([{ id: 9, title: 'CI' }]);
    if (endpoint === '/testplans' && method === 'POST') { assigned = []; return wire({ id: 88 }); }
    if (endpoint === '/testplantestcases/bulkAdd') {
      const selection = body.testCaseCollection;
      assigned.push(...selection.testCases);
      if (selection.selector.length) assigned.push(...cases.filter(item => !item.is_bdd_managed).map(item => item.id));
      return wire({ status: true });
    }
    if (endpoint === '/testplans/assign') return wire({ status: true });
    if (endpoint === '/system') return wire({});
    if (endpoint === '/projects/4') return wire({ id: 4, company: { id: 5004 } });
    if (endpoint === '/testplans/88') return wire({ id: 88, project: { id: 4 } });
    if (endpoint === '/testplanregressions') return wire([{ id: 1 }]);
    if (endpoint === '/testplanconfigurations') return wire([]);
    if (endpoint === '/executedtestcases') return wire(assigned.map(id => ({ id: id + 1000, test_plan_test_case: { id: id + 2000, test_case: id } })));
    if (/^\/executedtestcases\/\d+(\/updateTimeTaken)?$/.test(endpoint)) return wire({ id: Number(endpoint.split('/')[2]) });
    if (endpoint === '/executioncomments') return wire({ id: 1 });
    throw new Error(`Unexpected request ${method} ${endpoint}`);
  });
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); fs.rmSync(temp, { recursive: true, force: true }); });
async function run(xml, autoCreate = false) {
  const resultFile = path.join(temp, 'results.xml');
  fs.writeFileSync(resultFile, `<testsuite name="cucumber">${xml}</testsuite>`);
  await report({ project: '4', apiKey: 'test-key', apiUrl: 'http://localhost:1337', format: 'junit', resultFile, ...(autoCreate ? { autoCreate: true } : { testPlanId: '88' }) });
}
const writes = () => calls.filter(call => call.method !== 'GET');
const resultWrites = () => calls.filter(call => /^\/executedtestcases\/\d+$/.test(call.endpoint));

it.each([false, true])('reports pass/fail/skipped and one rolled-up outline with auto-create=%s', async auto => {
  cases.push(bddCase(24, 'Pending', 10)); assigned.push(24);
  await run('<testcase classname="Login API" name="Sign in"/><testcase classname="Login API" name="Sign out"><failure message="broken"/></testcase><testcase classname="Login API" name="Pending"><skipped/></testcase><testcase classname="Login API" name="Pay &lt;method&gt; - #1.1: Pay visa" time="1"><failure message="declined"/></testcase><testcase classname="Login API" name="Pay &lt;method&gt; - #1.2: Pay amex" time="2"/>', auto);
  expect(resultWrites().map(call => [call.endpoint, call.body.status])).toEqual([['/executedtestcases/1021', 1], ['/executedtestcases/1022', 2], ['/executedtestcases/1024', 3], ['/executedtestcases/1023', 2]]);
  expect(resultWrites()[3].body.time_taken).toBe(3000);
  expect(writes().some(call => /^\/(suites|testcases|tags)(\/|$)/.test(call.endpoint))).toBe(false);
  if (auto) expect(new Set(assigned)).toEqual(new Set([21, 22, 23, 24]));
});
it.each([false, true])('lists unsynced and ambiguous cases without writes to them, auto-create=%s', async auto => {
  cases.push(bddCase(25, 'Sign out', 10));
  await run('<testcase classname="Login API" name="Sign in"/><testcase classname="Login API" name="Not synced"/><testcase classname="Login API" name="Sign out"/>', auto);
  expect(resultWrites()).toHaveLength(1);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Not synced'));
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ambiguous scenario title'));
  expect(writes().some(call => call.endpoint === '/testcases' || call.endpoint === '/suites')).toBe(false);
  if (auto) expect(assigned).toEqual([21]);
});
it('does not create even an empty plan when all BDD results are unmatched', async () => {
  await run('<testcase classname="Login API" name="Not synced"/>', true);
  expect(writes()).toEqual([]);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Not synced'));
  expect(process.exit).not.toHaveBeenCalled();
});
it('preserves marker precedence for a BDD case and does not tag it', async () => {
  await run('<testcase classname="Login API" name="[TC-22] Sign in"/>', true);
  expect(assigned).toEqual([22]);
  expect(resultWrites()[0].endpoint).toBe('/executedtestcases/1022');
  expect(writes().some(call => /^\/(suites|testcases|tags)(\/|$)/.test(call.endpoint))).toBe(false);
});
it('creates only the non-BDD result in a mixed project', async () => {
  await run('<testcase classname="Login API" name="Sign in"/><testcase classname="com.app.SearchTests" name="Find items"/>', true);
  expect(cases).toHaveLength(4);
  expect(cases[3].title).toBe('Find items');
  expect(writes().filter(call => call.endpoint === '/testcases')).toHaveLength(1);
  expect(assigned).toContain(21);
  expect(assigned).toContain(cases[3].id);
});
it('reuses a normal title in its humanized suite in existing-plan mode', async () => {
  suites.push({ id: 12, title: 'Search', parent_id: 0 });
  cases.push({ id: 26, title: 'Find items', suite: { id: 12 } }); assigned.push(26);
  await run('<testcase classname="com.app.SearchTests" name="Find items"/>');
  expect(resultWrites()[0].endpoint).toBe('/executedtestcases/1026');
  expect(writes().some(call => /^\/(suites|testcases|testplans)(\/|$)/.test(call.endpoint))).toBe(false);
});
it('skips an archived BDD marker without adding it or making a copy', async () => {
  cases[0].archived = true;
  await run('<testcase classname="Login API" name="[TC-21] Sign in"/>', true);
  expect(writes()).toEqual([]);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('case is archived'));
});
