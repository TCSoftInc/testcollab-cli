/**
 * Scenario building utilities for TestCollab CLI tests
 * 
 * Provides pre-built test scenarios and helper functions for setting up
 * various Git repository states for testing different sync scenarios.
 */

import { createFeatureFile, commitAllChanges } from './git-helpers.js';

/**
 * Standard feature file content for testing
 */
export const FEATURE_CONTENT = {
  USER_LOGIN: `Feature: User Login
  As a registered user
  I want to log in to the system
  So that I can access my account

  Background:
    Given the application is running
    And I am on the login page

  Scenario: Successful login with valid credentials
    When I enter "valid@example.com" in the email field
    And I enter "correctpassword" in the password field
    And I click the login button
    Then I should be redirected to the dashboard
    And I should see a welcome message

  Scenario: Failed login with incorrect password
    When I enter "valid@example.com" in the email field
    And I enter "wrongpassword" in the password field
    And I click the login button
    Then I should see an error message "Invalid credentials"
    And I should remain on the login page`,

  ACCOUNT_SETTINGS: `Feature: Account Settings
  As a registered user
  I want to manage my account settings
  So that I can personalize my experience

  Scenario: Change email address
    When I enter a new email address
    And I press Save
    Then I should receive a confirmation link`,

  // More complex feature with background
  ORDER_MANAGEMENT: `Feature: Order Management
  As a customer
  I want to manage my orders
  So that I can track and modify my purchases

  Background:
    Given I am logged in as a customer
    And I have orders in my account

  Scenario: View order details
    When I click on an order
    Then I should see the order details
    And I should see the order status

  Scenario: Cancel pending order
    Given I have a pending order
    When I click cancel order
    And I confirm the cancellation
    Then the order status should be "Cancelled"
    And I should receive a cancellation confirmation`,

  // Feature without background
  SEARCH: `Feature: Product Search
  As a visitor
  I want to search for products
  So that I can find what I need

  Scenario: Search with results
    When I search for "laptop"
    Then I should see search results
    And the results should contain "laptop"

  Scenario: Search with no results
    When I search for "xyzabc123"
    Then I should see no results message
    And I should see search suggestions`
};

/**
 * Build the initial sync scenario as described in scenario 1 documentation
 * Creates a repository with auth and account features, matching the expected
 * structure that should create 4 suites and 3 test cases.
 * 
 * @param {string} tempDir - Directory path
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<string>} Commit hash
 */
export async function buildInitialSyncScenario(tempDir, git) {
  // Create the exact structure from scenario 1 documentation
  await createFeatureFile(tempDir, 'features/auth/user_login.feature', FEATURE_CONTENT.USER_LOGIN);
  await createFeatureFile(tempDir, 'features/account/account_settings.feature', FEATURE_CONTENT.ACCOUNT_SETTINGS);
  
  const commit = await commitAllChanges(git, 'Initial commit: add auth and account features');
  return commit;
}

/**
 * Build a more complex initial scenario with multiple nested directories
 * 
 * @param {string} tempDir - Directory path
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<string>} Commit hash
 */
export async function buildComplexInitialScenario(tempDir, git) {
  // Create a more complex directory structure
  await createFeatureFile(tempDir, 'features/auth/login/user_login.feature', FEATURE_CONTENT.USER_LOGIN);
  await createFeatureFile(tempDir, 'features/auth/signup/user_registration.feature', `Feature: User Registration
  Scenario: Successful registration
    When I fill in registration form
    Then I should be registered`);
  
  await createFeatureFile(tempDir, 'features/shop/orders/order_management.feature', FEATURE_CONTENT.ORDER_MANAGEMENT);
  await createFeatureFile(tempDir, 'features/shop/search/product_search.feature', FEATURE_CONTENT.SEARCH);
  
  await createFeatureFile(tempDir, 'features/account/settings/account_settings.feature', FEATURE_CONTENT.ACCOUNT_SETTINGS);
  
  const commit = await commitAllChanges(git, 'Initial commit: complex feature structure');
  return commit;
}

/**
 * Build scenario for file addition
 * Starts with initial files, then adds a new feature file
 * 
 * @param {string} tempDir - Directory path
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<{initialCommit: string, newCommit: string}>} Both commit hashes
 */
export async function buildFileAddedScenario(tempDir, git) {
  // Initial commit
  await createFeatureFile(tempDir, 'features/auth/user_login.feature', FEATURE_CONTENT.USER_LOGIN);
  const initialCommit = await commitAllChanges(git, 'Initial commit');
  
  // Add new file
  await createFeatureFile(tempDir, 'features/account/account_settings.feature', FEATURE_CONTENT.ACCOUNT_SETTINGS);
  const newCommit = await commitAllChanges(git, 'Add account settings feature');
  
  return { initialCommit, newCommit };
}

/**
 * Build scenario for file deletion
 * Starts with multiple files, then removes one
 * 
 * @param {string} tempDir - Directory path
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<{initialCommit: string, deleteCommit: string}>} Both commit hashes
 */
export async function buildFileDeletedScenario(tempDir, git) {
  // Initial commit with multiple files
  await createFeatureFile(tempDir, 'features/auth/user_login.feature', FEATURE_CONTENT.USER_LOGIN);
  await createFeatureFile(tempDir, 'features/account/account_settings.feature', FEATURE_CONTENT.ACCOUNT_SETTINGS);
  await createFeatureFile(tempDir, 'features/shop/search.feature', FEATURE_CONTENT.SEARCH);
  const initialCommit = await commitAllChanges(git, 'Initial commit with multiple features');
  
  // Delete one file
  await git.rm(['features/shop/search.feature']);
  const deleteCommit = await commitAllChanges(git, 'Remove search feature');
  
  return { initialCommit, deleteCommit };
}

/**
 * Build scenario for file rename without content change
 * 
 * @param {string} tempDir - Directory path
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<{initialCommit: string, renameCommit: string}>} Both commit hashes
 */
export async function buildFileRenamedScenario(tempDir, git) {
  // Initial commit
  await createFeatureFile(tempDir, 'features/login.feature', FEATURE_CONTENT.USER_LOGIN);
  const initialCommit = await commitAllChanges(git, 'Initial commit');
  
  // Rename file
  await git.mv(['features/login.feature', 'features/authentication.feature']);
  const renameCommit = await commitAllChanges(git, 'Rename login.feature to authentication.feature');
  
  return { initialCommit, renameCommit };
}

/**
 * Build scenario for content modification
 * 
 * @param {string} tempDir - Directory path
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<{initialCommit: string, modifyCommit: string}>} Both commit hashes
 */
export async function buildFileModifiedScenario(tempDir, git) {
  // Initial commit
  await createFeatureFile(tempDir, 'features/auth/user_login.feature', FEATURE_CONTENT.USER_LOGIN);
  const initialCommit = await commitAllChanges(git, 'Initial commit');
  
  // Modify content - add a new scenario
  const modifiedContent = FEATURE_CONTENT.USER_LOGIN + `

  Scenario: Failed login with non-existent user
    When I enter "nonexistent@example.com" in the email field
    And I enter "anypassword" in the password field
    And I click the login button
    Then I should see an error message "User not found"
    And I should remain on the login page`;
  
  await createFeatureFile(tempDir, 'features/auth/user_login.feature', modifiedContent);
  const modifyCommit = await commitAllChanges(git, 'Add new scenario to login feature');
  
  return { initialCommit, modifyCommit };
}

/**
 * Build scenario for new scenario addition to existing feature
 * 
 * @param {string} tempDir - Directory path
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<{initialCommit: string, addScenarioCommit: string}>} Both commit hashes
 */
export async function buildScenarioAddedScenario(tempDir, git) {
  // Initial commit with basic account settings
  const basicAccountSettings = `Feature: Account Settings
  As a registered user
  I want to manage my account settings
  So that I can personalize my experience

  Scenario: Change email address
    When I enter a new email address
    And I press Save
    Then I should receive a confirmation link`;
  
  await createFeatureFile(tempDir, 'features/account/account_settings.feature', basicAccountSettings);
  const initialCommit = await commitAllChanges(git, 'Initial commit with basic account settings');
  
  // Add new scenario
  const extendedAccountSettings = basicAccountSettings + `

  Scenario: Change password
    When I enter a new password
    And I confirm the new password
    And I press Save
    Then I should see a success message
    And I should be able to login with the new password`;
  
  await createFeatureFile(tempDir, 'features/account/account_settings.feature', extendedAccountSettings);
  const addScenarioCommit = await commitAllChanges(git, 'Add password change scenario');
  
  return { initialCommit, addScenarioCommit };
}

/**
 * Expected payload structure helpers
 */
export const EXPECTED_PAYLOADS = {
  /**
   * Get expected payload structure for initial sync
   * @param {number} projectId - Project ID
   * @param {string} headCommit - HEAD commit hash
   * @returns {Object} Expected payload structure
   */
  initialSync: (projectId, headCommit) => ({
    projectId,
    prevCommit: null,
    headCommit,
    changes: [
      {
        status: 'A',
        oldPath: null,
        newPath: 'features/auth/user_login.feature',
        feature: {
          hash: expect.any(String),
          title: 'User Login',
          background: expect.any(Array)
        },
        scenarios: expect.arrayContaining([
          expect.objectContaining({
            hash: expect.any(String),
            title: 'Successful login with valid credentials',
            steps: expect.any(Array)
          }),
          expect.objectContaining({
            hash: expect.any(String),
            title: 'Failed login with incorrect password',
            steps: expect.any(Array)
          })
        ])
      },
      {
        status: 'A',
        oldPath: null,
        newPath: 'features/account/account_settings.feature',
        feature: {
          hash: expect.any(String),
          title: 'Account Settings'
        },
        scenarios: expect.arrayContaining([
          expect.objectContaining({
            hash: expect.any(String),
            title: 'Change email address',
            steps: expect.any(Array)
          })
        ])
      }
    ]
  }),

  /**
   * Get expected payload structure for file addition
   * @param {number} projectId - Project ID
   * @param {string} prevCommit - Previous commit hash
   * @param {string} headCommit - HEAD commit hash
   * @returns {Object} Expected payload structure
   */
  fileAdded: (projectId, prevCommit, headCommit) => ({
    projectId,
    prevCommit,
    headCommit,
    changes: [
      {
        status: 'A',
        oldPath: null,
        newPath: 'features/account/account_settings.feature',
        feature: expect.objectContaining({
          title: 'Account Settings'
        }),
        scenarios: expect.any(Array)
      }
    ]
  })
};

/**
 * Validation helpers
 */
export const VALIDATORS = {
  /**
   * Validate that a scenario hash is correctly calculated
   * @param {Object} scenario - Scenario object
   * @returns {boolean} True if hash is valid format
   */
  isValidScenarioHash: (scenario) => {
    return scenario.hash && 
           typeof scenario.hash === 'string' && 
           scenario.hash.length === 40 &&
           /^[a-f0-9]+$/.test(scenario.hash);
  },

  /**
   * Validate that a feature hash is correctly calculated
   * @param {Object} feature - Feature object
   * @returns {boolean} True if hash is valid format
   */
  isValidFeatureHash: (feature) => {
    return feature.hash && 
           typeof feature.hash === 'string' && 
           feature.hash.length === 40 &&
           /^[a-f0-9]+$/.test(feature.hash);
  },

  /**
   * Validate steps array structure
   * @param {Array} steps - Steps array
   * @returns {boolean} True if steps are valid
   */
  areValidSteps: (steps) => {
    return Array.isArray(steps) && steps.every(step => 
      step.keyword && step.text && 
      typeof step.keyword === 'string' && 
      typeof step.text === 'string'
    );
  }
};
