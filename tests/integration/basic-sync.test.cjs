const { exec } = require('child_process');
const path = require('path');
const assert = require('assert');
const config = require('./config');
//describe require


const {
    apiToken,
    baseUrl,
    testProjectId,
    testDataDir,
    cliPath,
    timeouts
} = config;

const featureFilePath = path.join(__dirname, testDataDir, 'features');

// Helper function to make API calls
async function makeApiCall(endpoint, options = {}) {
    const url = `${baseUrl}/${endpoint}`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
        ...options,
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API call failed: ${response.statusText} - ${errorText}`);
    }
    return response.json();
}

// Helper function to run the CLI tool
function runCli(args) {
    return new Promise((resolve, reject) => {
        const command = `node ${cliPath} ${args}`;
        exec(command, { timeout: timeouts.cliExecution }, (error, stdout, stderr) => {
            if (error) {
                return reject({ error, stdout, stderr });
            }
            resolve({ stdout, stderr });
        });
    });
}

describe('Gherkin Sync - Basic Feature File', function() {
    this.timeout(timeouts.cliExecution + timeouts.apiCall * 2); // Set a generous timeout for the whole test

    let createdSuiteId = null;

    it('should sync a basic feature file and create a corresponding suite and test cases', async () => {
        // 1. Run the CLI tool to sync the feature file
        const cliArgs = `--project ${testProjectId} --dir ${featureFilePath}`;
        const { stdout } = await runCli(cliArgs);

        assert(stdout.includes('Gherkin sync completed successfully!'), 'CLI success message not found');

        // 2. Verify the suite was created via API
        const suites = await makeApiCall(`suites?project=${testProjectId}&title=Basic Feature File Sync`);
        assert.strictEqual(suites.length, 1, 'Expected to find one suite named "Basic Feature File Sync"');
        
        const suite = suites[0];
        createdSuiteId = suite.id;
        assert.strictEqual(suite.title, 'Basic Feature File Sync', 'Suite title does not match');

        // 3. Verify the test cases were created under the new suite
        const testCases = await makeApiCall(`testcases?project=${testProjectId}&suite=${createdSuiteId}`);
        assert.strictEqual(testCases.length, 2, 'Expected to find two test cases in the suite');

        const scenarioNames = ['First Scenario', 'Second Scenario'];
        const syncedTestCaseTitles = testCases.map(tc => tc.title).sort();
        assert.deepStrictEqual(syncedTestCaseTitles, scenarioNames.sort(), 'Test case titles do not match scenario names');
    });

    after(async function() {
        // Cleanup: Remove the created suite and its test cases
        if (createdSuiteId) {
            this.timeout(timeouts.cleanup);
            try {
                await makeApiCall(`suites/${createdSuiteId}?project=${testProjectId}`, { method: 'DELETE' });
                console.log(`    ✓ Cleaned up suite ID: ${createdSuiteId}`);
            } catch (err) {
                console.error(`    ✗ Failed to clean up suite ID: ${createdSuiteId}`, err);
            }
        }
    });
});
