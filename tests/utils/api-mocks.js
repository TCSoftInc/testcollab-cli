/**
 * API mocking utilities for TestCollab CLI tests
 * 
 * Provides utilities for mocking API calls during testing, enabling isolated
 * testing of CLI logic without requiring a live TestCollab server.
 */

import { jest } from '@jest/globals';

/**
 * Global mock fetch that can be used across tests
 */
export const mockFetch = jest.fn();

/**
 * Setup fetch mocking for tests
 */
export function setupApiMocks() {
  // Replace global fetch with our mock
  global.fetch = mockFetch;
  
  // Clear any previous mock calls
  mockFetch.mockClear();
}

/**
 * Create a mock API response
 * @param {Object} data - Response data
 * @param {number} status - HTTP status code
 * @param {boolean} ok - Whether response is successful
 * @returns {Promise<Object>} Mock response object
 */
export function createApiResponse(data, status = 200, ok = true) {
  return Promise.resolve({
    ok,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data))
  });
}

/**
 * Mock the sync state API call for initial sync
 * @param {string} projectId - Project ID
 * @returns {Object} Mock response for initial sync (no previous commit)
 */
export function mockInitialSyncState(projectId) {
  return createApiResponse({
    projectId: parseInt(projectId),
    lastSyncedCommit: null,
    lastSyncTime: null,
    syncEnabled: true
  });
}

/**
 * Mock the sync state API call with a previous commit
 * @param {string} projectId - Project ID
 * @param {string} lastCommit - Last synced commit hash
 * @returns {Object} Mock response with previous commit
 */
export function mockExistingSyncState(projectId, lastCommit) {
  return createApiResponse({
    projectId: parseInt(projectId),
    lastSyncedCommit: lastCommit,
    lastSyncTime: new Date().toISOString(),
    syncEnabled: true
  });
}

/**
 * Mock the resolve-ids API call for initial sync (empty results)
 * @returns {Object} Mock response with empty resolution maps
 */
export function mockEmptyResolveIds() {
  return createApiResponse({
    success: true,
    results: {
      suites: {},
      cases: {}
    }
  });
}

/**
 * Mock the resolve-ids API call with existing items
 * @param {Object} suites - Suite hash to ID mapping
 * @param {Object} cases - Test case hash to ID mapping
 * @returns {Object} Mock response with resolved IDs
 */
export function mockResolveIds(suites = {}, cases = {}) {
  return createApiResponse({
    success: true,
    results: {
      suites,
      cases
    }
  });
}

/**
 * Mock a successful sync completion
 * @param {Object} results - Sync results
 * @returns {Object} Mock successful sync response
 */
export function mockSuccessfulSync(results = {}) {
  const defaultResults = {
    storedCommit: 'f1a2b3c',
    createdSuites: 4,
    createdCases: 3,
    renamedSuites: 0,
    renamedCases: 0,
    updatedCases: 0,
    deletedSuites: 0,
    deletedCases: 0,
    warnings: []
  };

  return createApiResponse({
    success: true,
    message: 'Synchronization completed successfully',
    results: { ...defaultResults, ...results }
  });
}

/**
 * Set up API mocks for initial sync scenario
 * @param {string} projectId - Project ID
 * @param {string} headCommit - HEAD commit hash for final sync
 */
export function setupInitialSyncMocks(projectId, headCommit) {
  mockFetch
    .mockResolvedValueOnce(mockInitialSyncState(projectId))
    .mockResolvedValueOnce(mockEmptyResolveIds())
    .mockResolvedValueOnce(mockSuccessfulSync({ 
      storedCommit: headCommit 
    }));
}

/**
 * Get the last API call made to a specific endpoint
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} pathPattern - URL path pattern to match
 * @returns {Object|null} API call details or null if not found
 */
export function getLastApiCall(method, pathPattern) {
  const calls = mockFetch.mock.calls;
  
  for (let i = calls.length - 1; i >= 0; i--) {
    const [url, options] = calls[i];
    const requestMethod = (options?.method || 'GET').toUpperCase();
    
    if (requestMethod === method.toUpperCase() && url.includes(pathPattern)) {
      return {
        url,
        options,
        body: options?.body ? JSON.parse(options.body) : null,
        headers: options?.headers || {}
      };
    }
  }
  
  return null;
}

/**
 * Get all API calls made during the test
 * @returns {Array} Array of API call details
 */
export function getAllApiCalls() {
  return mockFetch.mock.calls.map(([url, options]) => ({
    url,
    method: options?.method || 'GET',
    body: options?.body ? JSON.parse(options.body) : null,
    headers: options?.headers || {}
  }));
}

/**
 * Verify that the expected API calls were made in the correct order
 * @param {Array} expectedCalls - Array of expected call patterns
 * @returns {boolean} True if calls match expectations
 */
export function verifyApiCallSequence(expectedCalls) {
  const actualCalls = getAllApiCalls();
  
  if (actualCalls.length !== expectedCalls.length) {
    return false;
  }
  
  for (let i = 0; i < expectedCalls.length; i++) {
    const expected = expectedCalls[i];
    const actual = actualCalls[i];
    
    if (actual.method !== expected.method) {
      return false;
    }
    
    if (!actual.url.includes(expected.path)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Extract the final sync payload from API calls
 * @returns {Object|null} The payload sent to POST /bdd/sync
 */
export function getFinalSyncPayload() {
  const syncCall = getLastApiCall('POST', '/bdd/sync');
  return syncCall ? syncCall.body : null;
}

/**
 * Assert that fetch was called with the correct endpoint
 * @param {string} method - HTTP method
 * @param {string} path - URL path
 * @param {number} callIndex - Which call to check (0-based)
 */
export function assertApiCall(method, path, callIndex = 0) {
  const calls = mockFetch.mock.calls;
  
  if (calls.length <= callIndex) {
    throw new Error(`Expected API call ${callIndex + 1}, but only ${calls.length} calls were made`);
  }
  
  const [url, options] = calls[callIndex];
  const actualMethod = options?.method || 'GET';
  
  if (actualMethod.toUpperCase() !== method.toUpperCase()) {
    throw new Error(`Expected ${method} but got ${actualMethod}`);
  }
  
  if (!url.includes(path)) {
    throw new Error(`Expected URL to contain "${path}" but got "${url}"`);
  }
}

/**
 * Mock an API error response
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @returns {Promise<Object>} Mock error response
 */
export function createApiError(status, message) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: message,
    json: () => Promise.resolve({ message }),
    text: () => Promise.resolve(message)
  });
}

/**
 * Reset all API mocks
 */
export function resetApiMocks() {
  mockFetch.mockReset();
}

/**
 * Custom Jest matchers for API testing
 */
export const apiMatchers = {
  /**
   * Check if a payload matches the expected GherkinSyncDelta structure
   * @param {Object} received - The payload to check
   * @param {Object} expected - Expected values
   */
  toBeValidSyncPayload(received, expected = {}) {
    const pass = 
      received &&
      typeof received.projectId === 'number' &&
      typeof received.headCommit === 'string' &&
      received.headCommit.length === 40 &&
      Array.isArray(received.changes) &&
      (received.prevCommit === null || typeof received.prevCommit === 'string');
    
    if (pass) {
      return {
        message: () => `Expected payload not to be a valid GherkinSyncDelta`,
        pass: true
      };
    } else {
      return {
        message: () => `Expected payload to be a valid GherkinSyncDelta structure`,
        pass: false
      };
    }
  }
};
