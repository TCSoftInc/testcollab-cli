'use strict';

// Real CLI -> real local API -> isolated database. Run the backend on Node 10:
// TC_CLI_NODE=/path/to/node22 node tests/local-api/report-custom-fields.cjs
// Only tc_cli_custom_fields_test and its template are reset by the API harness.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const cliRoot = path.resolve(__dirname, '../..');
const apiRoot = path.resolve(cliRoot, '../tc-api');
process.chdir(apiRoot);
process.env.TEST_DATABASE_NAME = 'tc_cli_custom_fields_test';
const harness = require(path.join(apiRoot, 'tests/bootstrap'));
const fetch = require(path.join(apiRoot, 'node_modules/node-fetch'));
const token = 'local-cli-custom-field-verification';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fields-api-'));
const plain = value => value && value.toJSON ? value.toJSON() : value;
let strapi, baseUrl, project, caseId, checks = 0;

async function eventually(read, condition, label) {
  const deadline = Date.now() + 8000;
  do {
    const value = await read();
    if (condition(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}
async function get(endpoint) {
  const response = await fetch(baseUrl + endpoint + (endpoint.indexOf('?') === -1 ? '?' : '&') + 'token=' + token);
  const data = await response.json();
  assert.strictEqual(response.status, 200, 'GET ' + endpoint);
  return data;
}
async function run(format, planId, inputs, expectFailure) {
  const resultFile = path.join(temp, 'results.' + (format === 'junit' ? 'xml' : 'json'));
  fs.writeFileSync(resultFile, format === 'junit'
    ? '<testsuite name="CLI Smoke"><testcase classname="CLI Smoke" name="Reports a result"/></testsuite>'
    : JSON.stringify({ results: [{ title: 'CLI Smoke', tests: [{ title: 'Reports a result', fullTitle: 'Reports a result', state: 'passed' }] }] }));
  const args = [path.join(cliRoot, 'src/index.js'), 'report', '--project', String(project.id), '--api-url', baseUrl,
    '--format', format, '--result-file', resultFile].concat(planId ? ['--test-plan-id', String(planId)] : ['--auto-create']);
  inputs.forEach(input => args.push('--custom-field', input));
  try {
    await execFile(process.env.TC_CLI_NODE || 'node', args, { cwd: temp, env: Object.assign({}, process.env, { TESTCOLLAB_TOKEN: token }), maxBuffer: 4 * 1024 * 1024 });
    assert.ok(!expectFailure, 'Expected the CLI to reject these values');
  } catch (error) {
    const output = ((error.stdout || '') + (error.stderr || '')).split(token).join('***');
    if (!expectFailure) throw new Error('CLI failed: ' + output);
    assert.strictEqual(error.code, 1, output);
    return null;
  }
  const saved = fs.readFileSync(path.join(temp, 'tmp/tc_test_plan'), 'utf8');
  return Number(saved.split('=')[1]);
}

async function main() {
  strapi = await harness.loadApp();
  harness.clearFakes();
  strapi.app.middleware.unshift(async (ctx, next) => {
    await next();
    if (ctx.status >= 400) console.error('HTTPFAIL ' + ctx.method + ' ' + ctx.path + ' ' + ctx.status + ' ' + JSON.stringify(ctx.body).split(token).join('***'));
  });
  baseUrl = await harness.getBaseUrl();
  const create = async (model, data) => plain(await strapi.query(model).create(data));
  const actor = 5011, company = 5004;
  project = await create('project', { name: 'CLI custom-field API verification', company: company, created_by: actor, archived: false });
  const role = await create('tcrole', { name: 'CLI verification manager', company: company,
    permissions: require(path.join(apiRoot, 'utils2/common')).getAllPermissions() });
  await create('projectuser', { project: project.id, user: actor, role: role.id });
  await create('projectuser', { project: project.id, user: 5014, role: role.id });
  await strapi.services.status.onNewProjectAdd(project.id, actor);
  await create('token', { token: token, user: actor, name: 'Local CLI verification', is_restricted: 0 });
  const suite = await create('suite', { title: 'CLI Smoke', project: project.id, created_by: actor, is_bdd_managed: true });
  const testCase = await create('testcase', { title: 'Reports a result', project: project.id, suite: suite.id, created_by: actor,
    priority: '1', steps: [], is_bdd_managed: true, custom_fields: [] });
  caseId = testCase.id;
  await create('testcaserevision', { testcase: caseId, project: project.id, suite: suite.id, title: testCase.title,
    revision: 1, modified_fields: [], action_type: 'create', is_head: true, steps: [], custom_fields: [], priority: '1', created_by: actor });
  const options = [{ systemValue: 1, label: 'Chrome' }, { systemValue: 2, label: 'Firefox' }];
  const fixtures = [
    { type: 'text', input: '  text with = and Unicode ✓  ', value: '  text with = and Unicode ✓  ' },
    { type: 'textarea', input: 'First line\nSecond line = value', value: 'First line\nSecond line = value' },
    { type: 'editor', input: '<p>Hello <strong>world</strong> &amp; QA</p>', value: '<p>Hello <strong>world</strong> &amp; QA</p>' },
    { type: 'number', input: '-12.5', value: -12.5 },
    { type: 'date', input: '2028-02-29', value: '2028-02-29' },
    { type: 'url', input: 'https://ci.example.com/run?a=b=c&job=qa#results', value: 'https://ci.example.com/run?a=b=c&job=qa#results' },
    { type: 'user', input: String(actor), value: actor },
    { type: 'dropdown', input: 'Firefox', value: 2, extra: { options: options } },
    { type: 'multipleSelect', input: '["Chrome",2]', value: [1, 2], extra: { options: options } },
    { type: 'dropdown', label: 'Config', input: '[1,"Firefox"]', value: [1, 2], extra: { options: options, act_as_config: true } }
  ];
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    fixture.field = await create('customfield', { name: 'cli_verify_' + i, label: fixture.label || fixture.type, type: fixture.type,
      entity: 'TestPlan', company: company, projects: [project.id], is_required: false, extra: fixture.extra || {} });
  }
  const inputs = fixtures.map(fixture => fixture.field.name + '=' + fixture.input);
  const members = await get('/projectusers?project=' + project.id + '&_limit=-1');
  function expectedLabel(fixture) {
    if (fixture.value === null || (Array.isArray(fixture.value) && !fixture.value.length)) return '';
    if (fixture.type === 'user') return members.find(member => member.user.id === fixture.value).user.name;
    if (fixture.extra && fixture.extra.options) {
      return (Array.isArray(fixture.value) ? fixture.value : [fixture.value]).map(value =>
        fixture.extra.options.find(option => option.systemValue === value).label).join(',');
    }
    return fixture.input;
  }
  async function verify(planId, expected) {
    const plan = await get('/testplans/' + planId);
    expected.forEach(fixture => {
      const stored = plan.custom_fields.find(field => field.id === fixture.field.id);
      assert.ok(stored, fixture.type + ': missing from plan response');
      assert.deepStrictEqual(stored.value, fixture.value, fixture.type + ': API read-back value');
      assert.strictEqual(stored.valueLabel, expectedLabel(fixture), fixture.type + ': displayed label');
      checks += 2;
    });
    await eventually(async () => plain(await strapi.query('testplancustomfield').find({ testplan: planId, _limit: -1 }, [])), rows =>
      expected.every(fixture => rows.some(row => row.customfield_id === fixture.field.id &&
        row.customfield_value === (Array.isArray(fixture.value) ? (fixture.value.length ? ',' + fixture.value.join(',') + ',' : '') : fixture.value === null ? null : String(fixture.value)) &&
        row.customfield_valuelabel === expectedLabel(fixture))), 'denormalized field values and labels');
    checks += expected.length * 2;
    const executions = plain(await strapi.query('executedtestcase').find({ test_plan: planId, _limit: -1 }, []));
    assert.ok(executions.length > 0 && executions.every(row => row.status === 'passed'), 'report updates actual executions');
    checks++;
    return plan;
  }
  for (const format of ['junit', 'mochawesome']) {
    const planId = await run(format, null, inputs);
    await verify(planId, fixtures);
    console.log('CHECK ' + format + ' auto-create: all 9 types + configuration dropdown persisted');
    // Read/merge/write must retain arrays and metadata when changing one field.
    const changed = fixtures.map((fixture, index) => Object.assign({}, fixture, index === 0 ? { input: 'Updated', value: 'Updated' } : {}));
    await run(format, planId, [fixtures[0].field.name + '=Updated']);
    await verify(planId, changed);
    console.log('CHECK ' + format + ' existing plan: supplied field updated, all other types preserved');
    const newInputs = ['Changed text', 'Changed\ntextarea', '<p>Changed <em>editor</em></p>', '0', '2026-10-06',
      'ftp://files.example.com/results.xml', '5014', 'Chrome', '[2]', '[2]'];
    const newValues = ['Changed text', 'Changed\ntextarea', '<p>Changed <em>editor</em></p>', 0, '2026-10-06',
      'ftp://files.example.com/results.xml', 5014, 1, [2], [2]];
    const updated = fixtures.map((fixture, index) => Object.assign({}, fixture, { input: newInputs[index], value: newValues[index] }));
    await run(format, planId, updated.map(fixture => fixture.field.name + '=' + fixture.input));
    await verify(planId, updated);
    console.log('CHECK ' + format + ' existing plan: every type updated');
    const cleared = fixtures.map(fixture => Object.assign({}, fixture, { value: Array.isArray(fixture.value) ? [] : null }));
    await run(format, planId, fixtures.map(fixture => fixture.field.name + '='));
    await verify(planId, cleared);
    console.log('CHECK ' + format + ' existing plan: every optional type cleared');
  }
  await strapi.query('customfield').update({ id: fixtures[0].field.id }, { is_required: true });
  const plansBefore = await strapi.query('testplan').count({ project: project.id });
  await run('junit', null, [fixtures[1].field.name + '=Only textarea'], true);
  assert.strictEqual(await strapi.query('testplan').count({ project: project.id }), plansBefore, 'required failure creates no plan'); checks++;
  await run('junit', null, [fixtures[0].field.name + '='], true);
  assert.strictEqual(await strapi.query('testplan').count({ project: project.id }), plansBefore, 'empty required failure creates no plan'); checks++;
  assert.deepStrictEqual(harness.takeBlockedHosts(), [], 'No unrecorded external calls');
  console.log('PASS local API custom fields: ' + checks + ' persistence/execution assertions');
}

main().catch(error => {
  console.error('FAIL local API custom fields: ' + String(error.stack || error).split(token).join('***'));
  process.exitCode = 1;
}).then(async () => {
  await harness.stopApp();
  // The test database holds the fixtures. Remove only the temporary CLI files.
  const remove = util.promisify(require(path.join(apiRoot, 'node_modules/rimraf')));
  await remove(temp);
});
