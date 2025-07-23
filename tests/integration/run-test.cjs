#!/usr/bin/env node

/**
 * Test Runner for Gherkin Sync Integration Tests
 * Usage: node run-test.js [test-name]
 * 
 * Environment Variables Required:
 * - TESTCOLLAB_TOKEN: API token for TestCollab
 * - TESTCOLLAB_URL: Base URL (default: http://localhost:1337)
 * - TEST_PROJECT_ID: Project ID to test with (default: 1)
 */

const path = require('path');
const Mocha = require('mocha');
const fs = require('fs');

async function runTest(testName) {
    console.log('🚀 Gherkin Sync Integration Test Runner\n');

    // Check required environment variables
    if (!process.env.TESTCOLLAB_TOKEN) {
        console.error('❌ Error: TESTCOLLAB_TOKEN environment variable is required');
        console.log('💡 Set it with: export TESTCOLLAB_TOKEN="your-token-here"');
        process.exit(1);
    }

    console.log('🔧 Environment Configuration:');
    console.log(`   TESTCOLLAB_URL: ${process.env.TESTCOLLAB_URL || 'http://localhost:1337'}`);
    console.log(`   TEST_PROJECT_ID: ${process.env.TEST_PROJECT_ID || '1'}`);
    console.log(`   TESTCOLLAB_TOKEN: ${process.env.TESTCOLLAB_TOKEN.substring(0, 8)}...\n`);

    const mocha = new Mocha();

    const availableTests = {
        'single-feature': './01-single-feature-sync.test.cjs',
        'basic-sync': './basic-sync.test.cjs'
    };

    if (testName && !availableTests[testName]) {
        console.error(`❌ Error: Test "${testName}" not found`);
        console.log('📋 Available tests:');
        Object.keys(availableTests).forEach(test => {
            console.log(`   - ${test}`);
        });
        process.exit(1);
    }

    const testsToRun = testName ? [testName] : Object.keys(availableTests);
    testsToRun.forEach(test => {
        const testPath = path.join(__dirname, availableTests[test]);
        if (fs.existsSync(testPath)) {
            mocha.addFile(testPath);
        }
    });
    
    console.log(`🧪 Running ${testsToRun.length} test(s):\n`);

    mocha.run(function (failures) {
        process.exitCode = failures ? 1 : 0;  // exit with non-zero status if there are failures
        if (failures > 0) {
            console.log(`\n❌ ${failures} test(s) failed.`);
            console.log('\n💡 Tips for troubleshooting:');
            console.log('   - Ensure TestCollab API is running on the specified URL');
            console.log('   - Verify the API token has sufficient permissions');
            console.log('   - Check that the test project exists and is accessible');
            console.log('   - Review the detailed error messages above');
        } else {
            console.log('\n🎉 All tests passed successfully!');
        }
    });
}

// Parse command line arguments
const testName = process.argv[2];

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Gherkin Sync Integration Test Runner');
    console.log('');
    console.log('Usage:');
    console.log('  node run-test.js [test-name]');
    console.log('');
    console.log('Available tests:');
    console.log('  single-feature    Test single feature file sync');
    console.log('  basic-sync        Test basic feature file sync');
    console.log('');
    console.log('Environment Variables:');
    console.log('  TESTCOLLAB_TOKEN   API token (required)');
    console.log('  TESTCOLLAB_URL     Base URL (default: http://localhost:1337)');
    console.log('  TEST_PROJECT_ID    Project ID (default: 1)');
    console.log('');
    console.log('Examples:');
    console.log('  export TESTCOLLAB_TOKEN="your-token"');
    console.log('  node run-test.js single-feature');
    console.log('  node run-test.js  # Run all tests');
    process.exit(0);
}

// Run the tests
runTest(testName).catch(error => {
    console.error('💥 Test runner error:', error.message);
    process.exit(1);
});
