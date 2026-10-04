/**
 * TCV-7069 — the test plan link and the public share link the CLI prints.
 *
 * The CLI only knows the API URL, so these pin how each API host maps to the app
 * that serves it, and the exact call `--public` makes to share a plan.
 */

import { describe, expect, jest, test } from '@jest/globals';

import {
  appLocation,
  publicTestPlanUrl,
  shareTestPlan,
  testPlanUrl
} from '../src/lib/testPlanLinks.js';

describe('appLocation', () => {
  test.each([
    ['https://api.testcollab.io', 'https://testcollab.io', 'US'],
    ['https://api-eu.testcollab.io', 'https://testcollab.io', 'EU'],
    ['https://api.testcollab-dev.io', 'https://testcollab-dev.io', 'US'],
    ['https://api-eu.testcollab-dev.io', 'https://testcollab-dev.io', 'EU'],
    ['https://API-EU.testcollab.io/', 'https://testcollab.io', 'EU'],
    ['http://localhost:1337', 'http://localhost:8080', 'US'],
    ['http://127.0.0.1:1337', 'http://localhost:8080', 'US']
  ])('%s is served by %s (%s)', (apiUrl, appUrl, region) => {
    expect(appLocation(apiUrl)).toEqual({ appUrl, region });
  });

  test('an API host without the api. label falls back to the production app', () => {
    expect(appLocation('https://testcollab-proxy.example.com')).toEqual({
      appUrl: 'https://testcollab.io',
      region: 'US'
    });
  });

  test('a value that is not a URL falls back to the production app', () => {
    expect(appLocation('not a url')).toEqual({ appUrl: 'https://testcollab.io', region: 'US' });
    expect(appLocation(undefined)).toEqual({ appUrl: 'https://testcollab.io', region: 'US' });
  });
});

describe('testPlanUrl', () => {
  test('is the plan view route of the app', () => {
    expect(testPlanUrl('https://api.testcollab.io', 45, 123)).toBe(
      'https://testcollab.io/project/45/test_plans/123/view'
    );
  });

  test('carries no region, because a signed-in browser already knows it', () => {
    expect(testPlanUrl('https://api-eu.testcollab.io', 45, 123)).toBe(
      'https://testcollab.io/project/45/test_plans/123/view'
    );
  });
});

describe('publicTestPlanUrl', () => {
  test('is the link the app\'s "Get shareable link" button builds', () => {
    expect(publicTestPlanUrl('https://api.testcollab.io', 45, 123, 'aaa.bbb.ccc')).toBe(
      'https://testcollab.io/project/45/test_plans/123/view?public_token=aaa.bbb.ccc&region=US'
    );
  });

  test('tells the app to use the EU API for an EU plan', () => {
    expect(publicTestPlanUrl('https://api-eu.testcollab.io', 45, 123, 'aaa.bbb.ccc')).toBe(
      'https://testcollab.io/project/45/test_plans/123/view?public_token=aaa.bbb.ccc&region=EU'
    );
  });
});

describe('shareTestPlan', () => {
  const API_URL = 'https://api-eu.testcollab.io';

  function stubRequest(responses) {
    return jest.fn(async (endpoint) => {
      const response = responses[endpoint];
      if (response instanceof Error) {
        throw response;
      }
      return response;
    });
  }

  test('shares the plan with the project company and returns the share link', async () => {
    const request = stubRequest({
      '/projects/45': { id: 45, company: { id: 5004, name: 'Acme' } },
      '/tokens/shareEntityToken': { status: true, jwt: 'aaa.bbb.ccc', message: 'Success' }
    });

    const url = await shareTestPlan({ request, apiUrl: API_URL, projectId: 45, testPlanId: 123 });

    expect(url).toBe(
      'https://testcollab.io/project/45/test_plans/123/view?public_token=aaa.bbb.ccc&region=EU'
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, '/projects/45');
    expect(request).toHaveBeenNthCalledWith(2, '/tokens/shareEntityToken', {
      method: 'POST',
      body: { entity: 'testplan', entityId: 123, project: 45, company: 5004 }
    });
  });

  test('reads the company when the project carries it as a bare id', async () => {
    const request = stubRequest({
      '/projects/45': { id: 45, company: 5004 },
      '/tokens/shareEntityToken': { status: true, jwt: 'aaa.bbb.ccc' }
    });

    await shareTestPlan({ request, apiUrl: API_URL, projectId: 45, testPlanId: 123 });

    expect(request.mock.calls[1][1].body.company).toBe(5004);
  });

  test('fails with the API message when the share is refused', async () => {
    // The endpoint refuses with HTTP 200 and status false.
    const request = stubRequest({
      '/projects/45': { id: 45, company: { id: 5004 } },
      '/tokens/shareEntityToken': { status: false, message: 'Company information not matched' }
    });

    await expect(
      shareTestPlan({ request, apiUrl: API_URL, projectId: 45, testPlanId: 123 })
    ).rejects.toThrow('Could not make test plan 123 public: Company information not matched');
  });

  test('fails when the answer carries no share token', async () => {
    const request = stubRequest({
      '/projects/45': { id: 45, company: { id: 5004 } },
      '/tokens/shareEntityToken': { status: true }
    });

    await expect(
      shareTestPlan({ request, apiUrl: API_URL, projectId: 45, testPlanId: 123 })
    ).rejects.toThrow('Could not make test plan 123 public: the API returned no share link');
  });

  test('fails with the request error when a call fails', async () => {
    const request = stubRequest({
      '/projects/45': { id: 45, company: { id: 5004 } },
      '/tokens/shareEntityToken': new Error('Forbidden')
    });

    await expect(
      shareTestPlan({ request, apiUrl: API_URL, projectId: 45, testPlanId: 123 })
    ).rejects.toThrow('Could not make test plan 123 public: Forbidden');
  });
});
