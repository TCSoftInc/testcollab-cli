#!/usr/bin/env node

/**
 * tc-gherkin-push.js
 * 
 * A CLI tool that uploads local *.feature files to Test Collab.
 * 
 * Usage:
 *   tc-gherkin-push --project <id> [--dir <path>]
 * 
 * Options:
 *   --project <id>  Test Collab project ID
 *   --dir <path>    Directory containing feature files (default: "features")
 * 
 * Environment variables:
 *   TESTCOLLAB_TOKEN  API token for Test Collab authentication
 */

import { Command } from 'commander';
import { glob } from 'glob';
import fs from 'fs/promises';
import path from 'path';
import pkg from 'testcollab-sdk';
const { TestCasesApi, Configuration } = pkg;

// Initialize commander
const program = new Command();

program
  .name('tc-gherkin-push')
  .description('Upload Gherkin feature files to Test Collab')
  .requiredOption('--project <id>', 'Test Collab project ID')
  .option('--dir <path>', 'Directory containing feature files', 'features')
  .version('1.0.0');

// Main execution logic
program.action(async (options) => {
  try {
    // Validate environment
    const token = process.env.TESTCOLLAB_TOKEN;
    if (!token) {
      console.error('Error: TESTCOLLAB_TOKEN environment variable is not set');
      process.exit(1);
    }

    // Initialize the Test Collab API client
    const apiClient = initializeApiClient(token);
    
    // Process feature files
    await processFeatureFiles(options.project, options.dir, apiClient);
    
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
});

/**
 * Initialize the TestCollab SDK client
 * @param {string} token - The authentication token
 * @returns {TestCasesApi} The initialized API client
 */
function initializeApiClient(token) {
  try {
    // Create a configuration with the auth token
    const config = new Configuration({
      apiKey: token,
      basePath: 'https://api.testcollab.io'
    });
    
    // Create the TestCasesApi instance
    return new TestCasesApi(config);
  } catch (error) {
    throw new Error(`Failed to initialize API client: ${error.message}`);
  }
}

/**
 * Process all feature files in the specified directory
 * @param {string} projectId - The Test Collab project ID
 * @param {string} directoryPath - The directory containing feature files
 * @param {TestCasesApi} apiClient - The initialized API client
 */
async function processFeatureFiles(projectId, directoryPath, apiClient) {
  try {
    // Find all feature files in the directory (recursively)
    const featurePattern = path.join(directoryPath, '**', '*.feature');
    const featureFiles = await glob(featurePattern);
    
    if (featureFiles.length === 0) {
      console.log(`No feature files found in ${directoryPath}`);
      return;
    }
    
    console.log(`Found ${featureFiles.length} feature file(s)`);
    
    // Process each feature file
    for (const filePath of featureFiles) {
      await processFeatureFile(filePath, projectId, apiClient);
    }
    
    console.log('All feature files processed successfully');
  } catch (error) {
    throw new Error(`Failed to process feature files: ${error.message}`);
  }
}

/**
 * Process a single feature file
 * @param {string} filePath - Path to the feature file
 * @param {string} projectId - The Test Collab project ID
 * @param {TestCasesApi} apiClient - The initialized API client
 */
async function processFeatureFile(filePath, projectId, apiClient) {
  try {
    // Extract the filename to use as the title
    const fileName = path.basename(filePath);
    
    // Read the feature file content
    const fileContent = await fs.readFile(filePath, 'utf8');
    
    // Check if a test case with this title already exists
    const existingCase = await findExistingTestCase(projectId, fileName, apiClient);
    
    if (existingCase) {
      // Update the existing test case
      await updateTestCase(existingCase.id, fileContent, apiClient);
      console.log(`🔄 Updated: ${fileName}`);
    } else {
      // Create a new test case
      await createTestCase(projectId, fileName, fileContent, apiClient);
      console.log(`➕ Created: ${fileName}`);
    }
  } catch (error) {
    console.error(`Failed to process ${filePath}: ${error.message}`);
    // Continue processing other files even if one fails
  }
}

/**
 * Find an existing test case by title
 * @param {string} projectId - The Test Collab project ID
 * @param {string} title - The test case title (filename)
 * @param {TestCasesApi} apiClient - The initialized API client
 * @returns {Object|null} The test case if found, null otherwise
 */
async function findExistingTestCase(projectId, title, apiClient) {
  try {
    // Get test cases filtered by title
    const response = await apiClient.getTestCases({
      projectId: projectId,
      q: title
    });
    
    // If the response contains test cases and the first one matches our title
    if (response && response.length > 0) {
      // Return the first matching test case
      // TODO: Implement AST parsing for more granular Gherkin handling
      return response[0];
    }
    
    return null;
  } catch (error) {
    throw new Error(`Failed to search for existing test case: ${error.message}`);
  }
}

/**
 * Update an existing test case
 * @param {string} caseId - The test case ID
 * @param {string} content - The feature file content
 * @param {TestCasesApi} apiClient - The initialized API client
 */
async function updateTestCase(caseId, content, apiClient) {
  try {
    await apiClient.updateTestCase({
      id: caseId,
      testCasePayload: {
        body: content,
        test_type: 'gherkin'
      }
    });
  } catch (error) {
    throw new Error(`Failed to update test case: ${error.message}`);
  }
}

/**
 * Create a new test case
 * @param {string} projectId - The Test Collab project ID
 * @param {string} title - The test case title (filename)
 * @param {string} content - The feature file content
 * @param {TestCasesApi} apiClient - The initialized API client
 */
async function createTestCase(projectId, title, content, apiClient) {
  try {
    // Create a new test case payload
    const payload = {
      title: title,
      body: content,
      test_type: 'gherkin'
    };
    
    await apiClient.createTestCase({
      projectId: projectId,
      testCasePayload: payload
    });
  } catch (error) {
    throw new Error(`Failed to create test case: ${error.message}`);
  }
}

// Parse command line arguments and execute the program
program.parse(process.argv);
