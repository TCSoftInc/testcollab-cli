/**
 * TCV-7071: a CI report gives each Examples row of a synced Scenario Outline its own result.
 *
 * tc sync stores each dataset row's Examples index (bdd_example_index, "<table>.<row>").
 * tc report reads the #table.row at the end of each JUnit name, sets the status of that row
 * only, and gives the case the status of its rows that ranks highest in the project's status
 * order. With no number, or no index in the dataset, the case is reported as before.
 *
 * The JUnit files are the samples in docs/bdd/ of the main repository (fixtures/bdd-examples):
 * Cucumber JS 12.9.0 and Cucumber JVM 8.0.4 runs of discount.feature, and runs of only the
 * @smoke Examples table of discount.feature and of 6-three-tables.feature.
 */
import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { report } from '../src/commands/report.js';
import { exampleIndexOf, applyExampleResults } from '../src/lib/bddCases.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bdd-examples');
const STEPS = [
  { step: 'the cart total is {{total}}', expected_result: 'the discount is {{discount}}' },
  { step: 'the coupon is "{{code}}"', expected_result: 'the coupon discount is {{percent}}' }
];
const DISCOUNT_ROWS = [['50', '0', '1.1', 'Small carts'], ['99', '0', '1.2', 'Small carts'], ['100', '10', '2.1', 'Large carts'], ['500', '40', '2.2', 'Large carts']];
const THREE_TABLE_ROWS = [['50', '0', '1.1', 'Small carts'], ['100', '10', '2.1', 'Large carts'], ['500', '40', '2.2', 'Large carts'], ['900', '40', '3.1', 'Huge carts']];

let temp, calls, executions, statuses;
const originalFetch = global.fetch;
function wire(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
const bddCase = (id, title) => ({ id, title, suite: { id: 10 }, is_bdd_managed: true });
const cases = [bddCase(31, 'An empty cart has no discount'), bddCase(32, 'A discount by cart total'), bddCase(33, 'Coupon {{code}} gives {{percent}} percent')];

// An execution as GET /executedtestcases returns it: the dataset it runs, and one result per row and step
function execution(caseId, { rows, indexed = true, statusOfRow = () => 'unexecuted' } = {}) {
  const datasetId = caseId + 600;
  const datarows = (rows || []).map(([first, second, index, name]) =>
    indexed ? { 1: first, 2: second, bdd_example_index: index, bdd_example_name: name } : { 1: first, 2: second });
  const results = [];
  datarows.forEach((datarow, rowIndex) => {
    [0, 1].forEach(stepIndex => results.push({
      dataset_id: datasetId, dataset_row_index: rowIndex, step_index: stepIndex,
      step: 'a step', expected_result: 'a result', status: statusOfRow(rowIndex), comment: rowIndex === 0 ? 'kept' : null
    }));
  });
  return {
    id: caseId + 1000,
    test_plan_test_case: { id: caseId + 2000, test_case: caseId },
    test_case_revision: { steps: STEPS },
    testdataset: rows ? [{ id: datasetId, parameters: [{ key: 1, field: 'a' }, { key: 2, field: 'b' }], datarows }] : null,
    testdataset_wise_result: results
  };
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcv7071-report-'));
  calls = [];
  statuses = null;
  executions = [execution(31), execution(32, { rows: DISCOUNT_ROWS }), execution(33, { rows: [['SAVE10', '10', '1.1', ''], ['SAVE20', '20', '1.2', '']] })];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
  const write = fs.writeFileSync;
  jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => write(file === 'tmp/tc_test_plan' ? path.join(temp, 'plan') : file, ...args));
  global.fetch = jest.fn(async (input, options = {}) => {
    const url = new URL(input);
    const endpoint = url.pathname;
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ endpoint, method, body });
    if (endpoint === '/suites') return wire([{ id: 10, title: 'Checkout discount', parent_id: 0, is_bdd_managed: true }]);
    if (endpoint === '/testcases') return wire(cases);
    if (endpoint === '/system') return wire({});
    if (endpoint === '/users/me') return wire({ id: 1 });
    if (endpoint === '/projects/4') return wire({ id: 4, company: { id: 5004 } });
    if (endpoint === '/testplans/88') return wire({ id: 88, project: { id: 4 } });
    if (endpoint === '/testplanregressions') return wire([{ id: 1 }]);
    if (endpoint === '/testplanconfigurations') return wire([]);
    if (endpoint === '/statuses') return statuses ? wire(statuses) : wire({ message: 'Forbidden' }, 403);
    if (endpoint === '/executedtestcases') return wire(executions);
    if (/^\/executedtestcases\/\d+(\/updateTimeTaken)?$/.test(endpoint)) return wire({ id: Number(endpoint.split('/')[2]) });
    if (endpoint === '/executioncomments') return wire({ id: 1 });
    throw new Error(`Unexpected request ${method} ${endpoint}`);
  });
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); fs.rmSync(temp, { recursive: true, force: true }); });

async function run(fixture) {
  await report({ project: '4', apiKey: 'test-key', apiUrl: 'http://localhost:1337', format: 'junit', resultFile: path.join(FIXTURES, fixture), testPlanId: '88' });
}
const resultWrite = caseId => calls.find(call => call.method === 'PUT' && call.endpoint === `/executedtestcases/${caseId + 1000}`);
// The status of each iteration in the update, as the Run screen shows them (one per row)
const iterations = body => {
  const rows = [];
  body.testdataset_wise_result.forEach(entry => { rows[entry.dataset_row_index] = entry.status; });
  return rows;
};

it.each([
  ['1-cucumber-js-12.9.0-junit-formatter.xml'],
  ['2-cucumber-jvm-8.0.4-junit-plugin.xml']
])('%s: iterations 1 to 3 passed, iteration 4 failed, case failed', async fixture => {
  await run(fixture);

  const discount = resultWrite(32).body;
  expect(iterations(discount)).toEqual(['passed', 'passed', 'passed', 'failed']);
  expect(discount.status).toBe('failed');
  expect(discount.step_wise_result.map(step => step.status)).toEqual(['failed', 'failed']);
  // only the status of an entry changes; the comment a tester left stays
  expect(discount.testdataset_wise_result[0]).toEqual({ ...executions[1].testdataset_wise_result[0], status: 'passed' });
  expect(discount.testdataset_wise_result).toHaveLength(8);

  // "#1.1: Coupon SAVE10 gives 10 percent": the number with the row's own name after it
  const coupon = resultWrite(33).body;
  expect([iterations(coupon), coupon.status]).toEqual([['passed', 'passed'], 'passed']);

  // a plain scenario is reported as before
  const plain = resultWrite(31).body;
  expect([plain.status, plain.testdataset_wise_result]).toEqual([1, undefined]);
  expect(console.log).toHaveBeenCalledWith('🥒 6 Examples row(s) got their own result');
  // the error of the failed row is still the execution comment
  expect(calls.find(call => call.endpoint === '/executioncomments').body.executed_test_case).toBe(1032);
});

it('5-cucumber-js-only-smoke-table.xml: iteration 3 passed, iteration 4 failed, iterations 1 and 2 not changed', async () => {
  await run('5-cucumber-js-only-smoke-table.xml');

  const discount = resultWrite(32).body;
  expect(iterations(discount)).toEqual(['unexecuted', 'unexecuted', 'passed', 'failed']);
  expect(discount.status).toBe('failed');
  expect(resultWrite(31)).toBeUndefined();
});

it('6-cucumber-js-three-tables-only-smoke.xml: #2.1 is row 2 of the three-table dataset, not row 3', async () => {
  executions[1] = execution(32, { rows: THREE_TABLE_ROWS });
  await run('6-cucumber-js-three-tables-only-smoke.xml');

  const discount = resultWrite(32).body;
  expect(iterations(discount)).toEqual(['unexecuted', 'passed', 'failed', 'unexecuted']);
  expect(discount.status).toBe('failed');
});

it('a dataset with no Examples index (synced by an older CLI) gets the result of today', async () => {
  executions[1] = execution(32, { rows: DISCOUNT_ROWS, indexed: false });
  await run('1-cucumber-js-12.9.0-junit-formatter.xml');

  const discount = resultWrite(32).body;
  expect([discount.status, discount.testdataset_wise_result]).toEqual([2, undefined]);
  expect(discount.step_wise_result.map(step => step.status)).toEqual([2, 2]);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('the test dataset of this run has no Examples index'));
});

it('a row that already failed in this run keeps its result, and the case stays failed', async () => {
  executions[1] = execution(32, { rows: DISCOUNT_ROWS, statusOfRow: rowIndex => (rowIndex === 0 ? 'failed' : 'unexecuted') });
  await run('5-cucumber-js-only-smoke-table.xml');

  const discount = resultWrite(32).body;
  expect(iterations(discount)).toEqual(['failed', 'unexecuted', 'passed', 'failed']);
  expect(discount.status).toBe('failed');
});

it('the case takes the status that ranks highest in the project\'s status order', async () => {
  // a passed row and a skipped row; the API refuses a case status that ranks below a row's
  const xml = '<testsuite name="Cucumber">' +
    '<testcase classname="Checkout discount" name="A discount by cart total - Small carts - #1.1"/>' +
    '<testcase classname="Checkout discount" name="A discount by cart total - Small carts - #1.2"><skipped/></testcase>' +
    '<testcase classname="Checkout discount" name="A discount by cart total - Large carts - #2.1"><failure message="no"/></testcase>' +
    '</testsuite>';
  const resultFile = path.join(temp, 'mixed.xml');
  fs.writeFileSync(resultFile, xml);
  const runMixed = () => report({ project: '4', apiKey: 'test-key', apiUrl: 'http://localhost:1337', format: 'junit', resultFile, testPlanId: '88' });

  // The default order (the statuses cannot be read): Skipped ranks above Failed
  await runMixed();
  expect(iterations(resultWrite(32).body)).toEqual(['passed', 'skipped', 'failed', 'unexecuted']);
  expect(resultWrite(32).body.status).toBe('skipped');

  // A project that ranks Failed highest
  calls = [];
  statuses = [
    { system_name: 'unexecuted', priority: 1 }, { system_name: 'passed', priority: 10 },
    { system_name: 'skipped', priority: 20 }, { system_name: 'failed', priority: 50 }
  ];
  await runMixed();
  expect(resultWrite(32).body.status).toBe('failed');
  expect(calls.filter(call => call.endpoint === '/statuses')).toHaveLength(1);
});

it('an index with no row in the dataset counts toward the case status only, with a warning', async () => {
  executions[1] = execution(32, { rows: DISCOUNT_ROWS.slice(0, 2) });
  await run('5-cucumber-js-only-smoke-table.xml');

  const discount = resultWrite(32).body;
  expect(iterations(discount)).toEqual(['unexecuted', 'unexecuted']);
  expect(discount.status).toBe('failed');
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Examples index #2.1, #2.2'));
});

it('a report with no Examples rows reads no status order', async () => {
  const resultFile = path.join(temp, 'plain.xml');
  fs.writeFileSync(resultFile, '<testsuite name="Cucumber"><testcase classname="Checkout discount" name="An empty cart has no discount"/></testsuite>');
  await report({ project: '4', apiKey: 'test-key', apiUrl: 'http://localhost:1337', format: 'junit', resultFile, testPlanId: '88' });

  expect(resultWrite(31).body.status).toBe(1);
  expect(calls.some(call => call.endpoint === '/statuses')).toBe(false);
});

describe('exampleIndexOf', () => {
  it.each([
    ['A discount by cart total - Small carts - #1.2', '1.2'],
    ['Coupon <code> gives <percent> percent - #1.1: Coupon SAVE10 gives 10 percent', '1.1'],
    ['Big orders - Shipping for <weight> kg - Light - #2.1: Shipping for 1 kg', '2.1'],
    ['Checkout discount - A discount by cart total - Large carts - Example #2.2', null],
    ['An empty cart has no discount', null],
    [undefined, null]
  ])('%s -> %s', (name, index) => {
    expect(exampleIndexOf(name)).toBe(index);
  });
});

describe('applyExampleResults', () => {
  it('reads a dataset and row results stored as JSON text, and skips a dataset that is gone', () => {
    const stored = execution(32, { rows: DISCOUNT_ROWS });
    const update = applyExampleResults({
      execCase: {
        testdataset: JSON.stringify([null, { ...stored.testdataset[0], datarows: JSON.stringify(stored.testdataset[0].datarows) }]),
        testdataset_wise_result: JSON.stringify(stored.testdataset_wise_result)
      },
      exampleResults: [{ index: '2.2', status: 2 }],
      statusPriority: null
    });
    expect([update.status, update.rowsSet, update.unmatchedIndexes]).toEqual(['failed', 1, []]);
  });

  it('is null for row results that cannot be read', () => {
    expect(applyExampleResults({ execCase: { testdataset: '[', testdataset_wise_result: 'nope' }, exampleResults: [{ index: '1.1', status: 1 }] })).toBeNull();
  });
});
