/**
 * testPlanLinks.js
 *
 * TCV-7069 — the test plan link that `tc createTestPlan` and `tc report` print,
 * and the public share link that `--public` prints.
 *
 * The CLI only knows the API URL. The app is served from the same domain without
 * the API's `api.` / `api-eu.` label (api.testcollab.io → testcollab.io), and that
 * one app serves both regions: a share link carries `region=US|EU` so the app
 * knows which API to call for a visitor who is not signed in. The app's own
 * "Get shareable link" button builds the same link.
 */

const APP_URL = 'https://testcollab.io';
// The local API (http://localhost:1337) is used by the app's dev server.
const LOCAL_APP_URL = 'http://localhost:8080';
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const API_HOST_PATTERN = /^api(-eu)?\.(.+)$/i;

/**
 * The app URL and data region that belong to an API URL. An API host that does
 * not follow the `api.` pattern is taken to be the production app.
 */
export function appLocation(apiUrl) {
  let url;
  try {
    url = new URL(String(apiUrl));
  } catch {
    return { appUrl: APP_URL, region: 'US' };
  }

  const match = API_HOST_PATTERN.exec(url.hostname);
  if (match) {
    return { appUrl: `${url.protocol}//${match[2]}`, region: match[1] ? 'EU' : 'US' };
  }
  if (LOCAL_HOSTS.includes(url.hostname)) {
    return { appUrl: LOCAL_APP_URL, region: 'US' };
  }
  return { appUrl: APP_URL, region: 'US' };
}

/**
 * The link to a test plan in the app, for anyone signed in to TestCollab.
 */
export function testPlanUrl(apiUrl, projectId, testPlanId) {
  return `${appLocation(apiUrl).appUrl}/project/${projectId}/test_plans/${testPlanId}/view`;
}

/**
 * The link that opens a public test plan without a TestCollab account.
 */
export function publicTestPlanUrl(apiUrl, projectId, testPlanId, shareToken) {
  const { region } = appLocation(apiUrl);
  return `${testPlanUrl(apiUrl, projectId, testPlanId)}?public_token=${shareToken}&region=${region}`;
}

/**
 * Make a test plan public and return its share link. This is the call behind the
 * app's "Get shareable link" button: the API marks the plan public and answers
 * with the token the link carries.
 *
 * `request(endpoint, options)` is the calling command's REST helper. The SDK is
 * not used: it has no share call, and its Project model drops the company the
 * share call needs.
 */
export async function shareTestPlan({ request, apiUrl, projectId, testPlanId }) {
  try {
    const project = await request(`/projects/${projectId}`);
    const company = typeof project?.company === 'object' ? project.company?.id : project?.company;
    const result = await request('/tokens/shareEntityToken', {
      method: 'POST',
      body: { entity: 'testplan', entityId: testPlanId, project: projectId, company }
    });
    // A refusal comes back as HTTP 200 with status false and a message.
    if (!result || !result.status || !result.jwt) {
      throw new Error(result?.message || 'the API returned no share link');
    }
    return publicTestPlanUrl(apiUrl, projectId, testPlanId, result.jwt);
  } catch (error) {
    throw new Error(`Could not make test plan ${testPlanId} public: ${error?.message || String(error)}`);
  }
}
