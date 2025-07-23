const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const { expect } = require('chai');
const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: process.env.DATABASE_HOST,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  },
});

describe('Gherkin Sync Integration Test', () => {
  const cliPath = path.resolve(__dirname, '../../tc-gherkin-push.js');
  const featuresDir = path.resolve(__dirname, 'test-data/features');
  const project = 15;
  const apiUrl = 'http://localhost:1337';

  after(async () => {
    // Clean up created test cases and suites
    await knex('testcases').where({ project }).del();
    await knex('suites').where({ project }).del();
    await knex.destroy();
  });

  it('should sync feature files and create test cases', async () => {
    const command = `node ${cliPath} --project ${project} --dir ${featuresDir} --api-url ${apiUrl}`;
    const { stdout, stderr } = await execAsync(command, {
      env: { ...process.env, TESTCOLLAB_TOKEN: 'test-token' }
    });

    expect(stderr).to.be.empty;
    expect(stdout).to.include('Synchronization completed successfully');

    // Verify test cases were created
    const testcases = await knex('testcases').where({ project });
    expect(testcases).to.have.lengthOf(2);
  });
});
