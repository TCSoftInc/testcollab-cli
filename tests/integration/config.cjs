/**
 * Configuration for Gherkin Sync Integration Tests
 * 
 * This file contains the configuration settings for running integration tests
 * against the TestCollab API.
 */

module.exports = {
    // TestCollab API Configuration
    apiToken: 'YzEQ29cGUp0UqpvZ',
    baseUrl: 'http://localhost:1337',
    
    // Test Configuration
    testProjectId: '1',
    
    // Test Data Configuration
    testDataDir: 'test-data',
    
    // CLI Configuration
    cliPath: './tc-gherkin-push.js',
    
    // Test Timeouts (in milliseconds)
    timeouts: {
        cliExecution: 30000,  // 30 seconds
        apiCall: 10000,       // 10 seconds
        cleanup: 5000         // 5 seconds
    },
    
    // Verification Settings
    verification: {
        checkApiResults: true,
        strictOutputValidation: true,
        logDetailedOutput: true
    }
};
