import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { report } from '../src/commands/report.js';
import { prepareTestPlanCustomFields } from '../src/lib/testPlanCustomFields.js';

const originalFetch = global.fetch;
let temp, calls, definitions, plan, updateResponse, updateStatus;
const field = (id, name, type = 'text', extra = {}) => ({ id, name, label: name, entity: 'TestPlan', type, is_required: false, ...extra });
const wire = (data, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-report-fields-'));
  calls = [];
  definitions = [field(1, 'Environment_text', 'text', { label: 'Environment' }), field(2, 'Notes_text')];
  plan = { id: 88, project: { id: 4 }, title: 'Nightly run', custom_fields: [{ id: 2, name: 'Notes_text', value: 'Keep this', valueLabel: 'Keep this' }] };
  updateResponse = { id: 88 }; updateStatus = 200;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit ${code}`); });
  const write = fs.writeFileSync;
  jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => write(file === 'tmp/tc_test_plan' ? path.join(temp, 'plan') : file, ...args));
  global.fetch = jest.fn(async (input, options = {}) => {
    const url = new URL(input), endpoint = url.pathname, method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ endpoint, method, body, url });
    if (endpoint === '/customfields') return wire(definitions);
    if (endpoint === '/projectusers') return wire([{ user: { id: 7, name: 'Test User' } }]);
    if (endpoint === '/suites') return wire([{ id: 10, title: 'Login', is_bdd_managed: true, parent_id: 0 }]);
    if (endpoint === '/testcases') return wire([{ id: 21, title: 'Sign in', suite: { id: 10 }, is_bdd_managed: true }]);
    if (endpoint === '/testcases/21') return wire({ id: 21, title: 'Sign in', suite: { id: 10 }, is_bdd_managed: true });
    if (endpoint === '/testplans/88') return wire(method === 'PUT' ? updateResponse : plan, method === 'PUT' ? updateStatus : 200);
    if (endpoint === '/testplans' && method === 'POST') return wire({ id: 88 });
    if (endpoint === '/testplanfolders') return wire([{ id: 9, title: 'CI' }]);
    if (endpoint === '/testplantestcases/bulkAdd' || endpoint === '/testplans/assign') return wire({ status: true });
    if (endpoint === '/users/me') return wire({ id: 1, first_name: 'Tester' });
    if (endpoint === '/system') return wire({});
    if (endpoint === '/projects/4') return wire({ id: 4, company: { id: 5004 } });
    if (endpoint === '/testplanregressions') return wire([{ id: 1 }]);
    if (endpoint === '/testplanconfigurations') return wire([]);
    if (endpoint === '/executedtestcases') return wire([{ id: 1021, test_plan_test_case: { id: 2021, test_case: 21 } }]);
    if (endpoint === '/executedtestcases/1021') return wire({ id: 1021 });
    throw new Error(`Unexpected request ${method} ${endpoint}`);
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});

async function run(inputs, autoCreate = false, format = 'junit') {
  const resultFile = path.join(temp, 'results');
  const content = format === 'junit'
    ? '<testsuite name="Login"><testcase classname="Login" name="Sign in"/></testsuite>'
    : JSON.stringify({ results: [{ title: 'Login', tests: [{ title: '[TC-21] Sign in', fullTitle: 'Login [TC-21] Sign in', state: 'passed' }] }] });
  fs.writeFileSync(resultFile, content);
  await report({ project: '4', apiKey: 'test-key', apiUrl: 'http://localhost:1337', format, resultFile, customField: inputs, ...(autoCreate ? { autoCreate: true } : { testPlanId: '88' }) });
}
const writes = () => calls.filter(call => call.method !== 'GET');
const prepare = (inputs, testPlanId) => prepareTestPlanCustomFields({ apiUrl: 'http://localhost:1337', apiKey: 'test-key', projectId: 4, inputs, testPlanId });

it.each(['junit', 'mochawesome'])('sets repeated fields on an auto-created plan for %s', async format => {
  await run(['Environment=Staging', 'Notes_text=URL: https://example.com/?a=b=c'], true, format);
  const planWrite = writes().find(call => call.endpoint === '/testplans');
  expect(planWrite.body.custom_fields).toEqual([
    { id: 1, name: 'Environment_text', label: 'Environment', value: 'Staging', valueLabel: 'Staging' },
    { id: 2, name: 'Notes_text', label: 'Notes_text', value: 'URL: https://example.com/?a=b=c', valueLabel: 'URL: https://example.com/?a=b=c' }
  ]);
  expect(writes().some(call => /^\/(testcases|suites|tags)(\/|$)/.test(call.endpoint))).toBe(false);
  expect(writes().find(call => call.endpoint === '/executedtestcases/1021').body).not.toHaveProperty('custom_fields');
  const query = calls.find(call => call.endpoint === '/customfields').url.searchParams;
  expect([query.get('company'), query.get('projects'), query.get('entity'), query.get('_limit')]).toEqual(['5004', '4', 'TestPlan', '-1']);
});

it('merges existing-plan fields and sends only title, project and fields before uploading', async () => {
  await run(['1=Staging']);
  expect(writes()[0]).toMatchObject({ endpoint: '/testplans/88', method: 'PUT', body: {
    title: 'Nightly run', project: 4,
    custom_fields: [plan.custom_fields[0], { id: 1, name: 'Environment_text', label: 'Environment', value: 'Staging', valueLabel: 'Staging' }]
  } });
  expect(Object.keys(writes()[0].body).sort()).toEqual(['custom_fields', 'project', 'title']);
  expect(writes()[1].endpoint).toBe('/executedtestcases/1021');
});

it('replaces a supplied field without duplicates and retains other field metadata', async () => {
  plan.custom_fields.unshift({ id: 1, name: 'Environment_text', value: 'Old' });
  plan.custom_fields[1].color = 'blue';
  await run(['Environment_text=New']);
  expect(writes()[0].body.custom_fields).toEqual([
    plan.custom_fields[1], { id: 1, name: 'Environment_text', label: 'Environment', value: 'New', valueLabel: 'New' }
  ]);
});

it.each([false, true])('leaves the original reporting flow when no fields are supplied (auto=%s)', async auto => {
  await run(undefined, auto);
  expect(calls.some(call => call.endpoint === '/customfields')).toBe(false);
  expect(writes().some(call => call.endpoint === '/testplans/88')).toBe(false);
  expect(writes().some(call => call.endpoint === '/executedtestcases/1021')).toBe(true);
});

it.each(['Unknown=value', 'bad-format', '=empty-name', 'Environment=Staging'])('fails before any writes for invalid fields: %s', async input => {
  if (input === 'Environment=Staging') definitions[0].entity = 'TestCase';
  await expect(run([input], true)).rejects.toThrow('exit 1');
  expect(writes()).toEqual([]);
});

it('refuses to update a plan in another project', async () => {
  plan.project = { id: 5 };
  await expect(run(['Environment=Staging'])).rejects.toThrow('exit 1');
  expect(writes()).toEqual([]);
});

it.each([200, 403])('stops before execution uploads when a plan update fails with HTTP %s', async status => {
  updateResponse = { status: false, title: 'Cannot edit this plan' }; updateStatus = status;
  await expect(run(['Environment=Staging'])).rejects.toThrow('exit 1');
  expect(writes().map(call => call.endpoint)).toEqual(['/testplans/88']);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Cannot edit this plan'));
});

it('rejects ambiguous labels and repeated aliases for the same field', async () => {
  definitions.push(field(3, 'Other_text', 'text', { label: 'Environment' }));
  await expect(prepare(['Environment=Staging'])).rejects.toThrow('ambiguous');
  await expect(prepare(['Environment_text=Staging', '1=Production'])).rejects.toThrow('more than once');
  expect(writes()).toEqual([]);
});

it('requires mandatory fields on creation and preserves them on update', async () => {
  definitions[1].is_required = true;
  await expect(prepare(['Environment=Staging'])).rejects.toThrow('Missing required');
  const prepared = await prepare(['Environment=Staging'], 88);
  expect(prepared.customFields).toContainEqual(plan.custom_fields[0]);
});

it('converts option labels, arrays, numbers, dates and project user IDs to API values', async () => {
  const options = [{ systemValue: 1, label: 'Chrome' }, { systemValue: 2, label: 'Firefox' }];
  definitions = [field(1, 'Browser', 'dropdown', { extra: { options } }), field(2, 'Platforms', 'multipleSelect', { extra: { options } }),
    field(3, 'Retries', 'number'), field(4, 'Run date', 'date'), field(5, 'Owner', 'user'), field(6, 'Config', 'dropdown', { extra: { options, act_as_config: true } })];
  const prepared = await prepare(['Browser=Firefox', 'Platforms=["Chrome",2]', 'Retries=0', 'Run date=2026-10-06', 'Owner=7', 'Config=Chrome']);
  expect(prepared.customFields.map(item => [item.value, item.valueLabel])).toEqual([
    [2, 'Firefox'], [[1, 2], 'Chrome,Firefox'], [0, '0'], ['2026-10-06', '2026-10-06'], [7, 'Test User'], [[1], 'Chrome']
  ]);
});

it.each([
  ['dropdown', 'Safari', { options: [{ systemValue: 1, label: 'Chrome' }] }],
  ['multipleSelect', '[broken', {}], ['number', 'NaN', {}], ['date', '2026-02-30', {}],
  ['url', 'bad-url', {}], ['user', '999', {}], ['text', '', {}]
])('rejects invalid %s values before writes', async (type, value, extra) => {
  definitions = [field(1, 'Field', type, { extra, is_required: true })];
  await expect(prepare([`Field=${value}`])).rejects.toThrow();
  expect(writes()).toEqual([]);
});

it('clears an optional field without deleting another field', async () => {
  const prepared = await prepare(['Environment='], 88);
  expect(prepared.customFields).toEqual([plan.custom_fields[0], { id: 1, name: 'Environment_text', label: 'Environment', value: null, valueLabel: '' }]);
});

it('keeps labels aligned with distinct multiple-select options that share a label', async () => {
  definitions = [field(1, 'Choices', 'multipleSelect', { extra: { options: [
    { systemValue: 1, label: 'Same label' }, { systemValue: 2, label: 'Same label' }
  ] } })];
  const prepared = await prepare(['Choices=[1,2,1]']);
  expect(prepared.customFields[0]).toMatchObject({ value: [1, 2], valueLabel: 'Same label,Same label' });
});

it('accepts FTP URLs just as the product URL field does', async () => {
  definitions = [field(1, 'Artifact', 'url')];
  const prepared = await prepare(['Artifact=ftp://files.example.com/results.xml']);
  expect(prepared.customFields[0].value).toBe('ftp://files.example.com/results.xml');
});

it('redacts credentials when a custom-field request fails', async () => {
  global.fetch = jest.fn(async url => { throw new Error(`Cannot fetch ${url}`); });
  const error = await prepare(['Environment=Staging']).catch(error => error);
  expect(error.message).toContain('token=***');
  expect(error.message).not.toContain('test-key');
});
