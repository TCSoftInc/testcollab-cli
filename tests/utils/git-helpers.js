/**
 * Git testing utilities for TestCollab CLI tests
 * 
 * Provides helper functions for creating and managing temporary Git repositories
 * during testing, ensuring realistic Git scenarios for CLI testing.
 */

import { simpleGit } from 'simple-git';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Create a temporary directory for testing
 * @returns {Promise<string>} Path to temporary directory
 */
export async function createTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'tc-cli-test-'));
}

/**
 * Initialize a Git repository in the given directory
 * @param {string} tempDir - Directory path
 * @returns {Promise<import('simple-git').SimpleGit>} Git instance
 */
export async function initGitRepo(tempDir) {
  const git = simpleGit(tempDir);
  
  await git.init();
  await git.addConfig('user.email', 'test@testcollab.com');
  await git.addConfig('user.name', 'TestCollab CLI Test');
  
  return git;
}

/**
 * Create a feature file with the given content
 * @param {string} tempDir - Base directory
 * @param {string} relativePath - Relative path from tempDir (e.g., 'features/auth/login.feature')
 * @param {string} content - Gherkin content
 */
export async function createFeatureFile(tempDir, relativePath, content) {
  const fullPath = path.join(tempDir, relativePath);
  const dirPath = path.dirname(fullPath);
  
  // Create directory structure if it doesn't exist
  await fs.mkdir(dirPath, { recursive: true });
  
  // Write the feature file
  await fs.writeFile(fullPath, content, 'utf8');
}

/**
 * Commit all current changes with a message
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @param {string} message - Commit message
 * @returns {Promise<string>} Commit hash
 */
export async function commitAllChanges(git, message) {
  await git.add('.');
  const result = await git.commit(message);
  return result.commit;
}

/**
 * Get the current HEAD commit hash
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<string>} HEAD commit hash
 */
export async function getHeadCommit(git) {
  return await git.revparse(['HEAD']);
}

/**
 * Clean up a temporary directory
 * @param {string} tempDir - Directory to remove
 */
export async function cleanupTempDir(tempDir) {
  await fs.rm(tempDir, { recursive: true, force: true });
}

/**
 * Set up a complete test repository with initial feature files
 * @param {string} tempDir - Directory path
 * @returns {Promise<{git: import('simple-git').SimpleGit, initialCommit: string}>}
 */
export async function setupTestRepo(tempDir) {
  const git = await initGitRepo(tempDir);
  
  // Create some initial feature files to match the scenario documentation
  await createFeatureFile(tempDir, 'features/auth/user_login.feature', `Feature: User Login
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
    And I should remain on the login page`);

  await createFeatureFile(tempDir, 'features/account/account_settings.feature', `Feature: Account Settings
  As a registered user
  I want to manage my account settings
  So that I can personalize my experience

  Scenario: Change email address
    When I enter a new email address
    And I press Save
    Then I should receive a confirmation link`);

  const initialCommit = await commitAllChanges(git, 'Initial commit with feature files');
  
  return { git, initialCommit };
}

/**
 * Create a more realistic directory structure matching the scenario docs
 * @param {string} tempDir - Directory path
 * @returns {Promise<{git: import('simple-git').SimpleGit, initialCommit: string}>}
 */
export async function setupInitialSyncScenario(tempDir) {
  const git = await initGitRepo(tempDir);
  
  // Create the exact structure from scenario 1 documentation
  await createFeatureFile(tempDir, 'features/auth/user_login.feature', `Feature: User Login
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
    And I should remain on the login page`);

  await createFeatureFile(tempDir, 'features/account/account_settings.feature', `Feature: Account Settings
  As a registered user
  I want to manage my account settings
  So that I can personalize my experience

  Scenario: Change email address
    When I enter a new email address
    And I press Save
    Then I should receive a confirmation link`);

  const initialCommit = await commitAllChanges(git, 'Initial commit: add auth and account features');
  
  return { git, initialCommit };
}

/**
 * Check if a path exists
 * @param {string} path - Path to check
 * @returns {Promise<boolean>} True if exists
 */
export async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file's content
 * @param {string} filePath - Path to file
 * @returns {Promise<string>} File content
 */
export async function readFile(filePath) {
  return await fs.readFile(filePath, 'utf8');
}

/**
 * Get git status for debugging
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @returns {Promise<Object>} Git status
 */
export async function getGitStatus(git) {
  return await git.status();
}

/**
 * Get git diff output
 * @param {import('simple-git').SimpleGit} git - Git instance
 * @param {Array<string>} options - Diff options
 * @returns {Promise<string>} Diff output
 */
export async function getGitDiff(git, options = []) {
  return await git.diff(options);
}
