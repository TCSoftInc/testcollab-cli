/**
 * TCV-6866 — tests for matching a result to a test case by the id the app shows.
 *
 * The bug: a marker like [TC-74002] was compared only against
 * `test_plan_test_case.test_case`, the internal primary key. The product shows
 * `display_number` everywhere, so every result tagged with the visible id was
 * dropped — and `tc report` still exited 0, so the pipeline went green with
 * nothing recorded.
 *
 * The HTTP layer is stubbed so the real lookup logic runs: which query is sent,
 * in what order, and what a failure of each one does.
 */

import { jest } from '@jest/globals';
import {
  fetchCasesByMarker,
  fetchTestCaseNumbers,
  formatCaseLabel,
  indexTestCaseNumbers
} from '../src/lib/testCaseIds.js';
import { resolveExecutedCase, formatIdList } from '../src/commands/report.js';

const BASE_URL = 'http://localhost:1337';
const TOKEN = 'test-token';
const PROJECT_ID = 19018;

/**
 * The two numbers of the ticket's production example: the app shows 74002, the
 * row's primary key is 1582490.
 */
const CASES = [
  { id: 1582490, display_number: 74002, title: 'Deployed page returns HTTP 200' },
  { id: 1582499, display_number: 74011, title: 'No unresolved template placeholders remain' }
];

function assignedCase(execId, testCaseId, configId = null) {
  return {
    id: execId,
    test_plan_test_case: { id: execId * 10, test_case: testCaseId },
    test_plan_config: configId ? { id: configId } : null
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: '',
    text: async () => JSON.stringify(body)
  };
}

function stubFetch(responses) {
  const calls = [];
  global.fetch = jest.fn(async (url, options) => {
    calls.push({ url, options });
    const next = responses[calls.length - 1];
    if (!next) {
      throw new Error(`Unexpected extra request to ${url}`);
    }
    return next;
  });
  return calls;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

describe('indexTestCaseNumbers', () => {
  test('indexes both ways', () => {
    const { displayNumberByCaseId, caseIdByDisplayNumber } = indexTestCaseNumbers(CASES);
    expect(displayNumberByCaseId.get('1582490')).toBe('74002');
    expect(caseIdByDisplayNumber.get('74002')).toBe('1582490');
  });

  test('a case with no business id yet is left out of both maps', () => {
    const { displayNumberByCaseId, caseIdByDisplayNumber } = indexTestCaseNumbers([
      { id: 7, display_number: null },
      { id: 8 }
    ]);
    expect(displayNumberByCaseId.size).toBe(0);
    expect(caseIdByDisplayNumber.size).toBe(0);
  });

  test('survives a missing or malformed response', () => {
    expect(indexTestCaseNumbers(null).caseIdByDisplayNumber.size).toBe(0);
    expect(indexTestCaseNumbers([null, undefined]).caseIdByDisplayNumber.size).toBe(0);
  });
});

describe('resolveExecutedCase — the number the app shows (TCV-6866)', () => {
  const { caseIdByDisplayNumber } = indexTestCaseNumbers(CASES);
  const casesAssigned = [assignedCase(900, 1582490), assignedCase(901, 1582499)];

  test('a marker holding the business id matches — this is the reported bug', () => {
    const { execCase, matchedBy } = resolveExecutedCase(
      casesAssigned,
      { tcId: '74002' },
      false,
      '0',
      caseIdByDisplayNumber
    );
    expect(execCase.id).toBe(900);
    expect(matchedBy).toBe('display_number');
  });

  test('a marker holding the internal id still matches, so existing pipelines keep working', () => {
    const { execCase, matchedBy } = resolveExecutedCase(
      casesAssigned,
      { tcId: '1582499' },
      false,
      '0',
      caseIdByDisplayNumber
    );
    expect(execCase.id).toBe(901);
    expect(matchedBy).toBe('internal_id');
  });

  test('with no index at all, matching is exactly what it was before', () => {
    expect(resolveExecutedCase(casesAssigned, { tcId: '1582490' }, false, '0').execCase.id).toBe(900);
    expect(resolveExecutedCase(casesAssigned, { tcId: '74002' }, false, '0').execCase).toBeUndefined();
  });

  test('an id that names nothing in the run matches nothing', () => {
    const { execCase, matchedBy } = resolveExecutedCase(
      casesAssigned,
      { tcId: '999001' },
      false,
      '0',
      caseIdByDisplayNumber
    );
    expect(execCase).toBeUndefined();
    expect(matchedBy).toBeNull();
  });

  test('a number that is one case\'s business id and another\'s internal id resolves to the business id, and says so', () => {
    // Both cases are in the run: case 3 is shown as TC-1, case 1 is internally 1.
    const both = [assignedCase(910, 1), assignedCase(911, 3)];
    const index = indexTestCaseNumbers([{ id: 3, display_number: 1 }]).caseIdByDisplayNumber;

    const { execCase, matchedBy, ambiguousWith } = resolveExecutedCase(
      both,
      { tcId: '1' },
      false,
      '0',
      index
    );
    expect(execCase.id).toBe(911);
    expect(matchedBy).toBe('display_number');
    expect(ambiguousWith.id).toBe(910);
  });

  test('an unambiguous match reports no ambiguity', () => {
    const { ambiguousWith } = resolveExecutedCase(
      casesAssigned,
      { tcId: '74002' },
      false,
      '0',
      caseIdByDisplayNumber
    );
    expect(ambiguousWith).toBeNull();
  });
});

describe('resolveExecutedCase — configurations', () => {
  const { caseIdByDisplayNumber } = indexTestCaseNumbers(CASES);
  const casesAssigned = [
    assignedCase(920, 1582490, 5),
    assignedCase(921, 1582490, 6)
  ];

  test('a business id is matched within the named configuration', () => {
    const { execCase } = resolveExecutedCase(
      casesAssigned,
      { tcId: '74002' },
      true,
      '6',
      caseIdByDisplayNumber
    );
    expect(execCase.id).toBe(921);
  });

  test('a business id in a configuration the run does not have matches nothing', () => {
    const { execCase } = resolveExecutedCase(
      casesAssigned,
      { tcId: '74002' },
      true,
      '7',
      caseIdByDisplayNumber
    );
    expect(execCase).toBeUndefined();
  });
});

describe('fetchTestCaseNumbers — reading the ids of a run', () => {
  test('asks for exactly the run\'s cases, scoped to the project', async () => {
    const calls = stubFetch([jsonResponse(CASES)]);
    const { caseIdByDisplayNumber } = await fetchTestCaseNumbers(BASE_URL, TOKEN, PROJECT_ID, [
      1582490,
      1582499
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`project=${PROJECT_ID}`);
    expect(calls[0].url).toContain('id_in=1582490');
    expect(calls[0].url).toContain('id_in=1582499');
    expect(caseIdByDisplayNumber.get('74002')).toBe('1582490');
  });

  test('makes no call when the run has no cases', async () => {
    const calls = stubFetch([]);
    const { caseIdByDisplayNumber } = await fetchTestCaseNumbers(BASE_URL, TOKEN, PROJECT_ID, []);
    expect(calls).toHaveLength(0);
    expect(caseIdByDisplayNumber.size).toBe(0);
  });

  test('a server that cannot answer leaves matching where it was, rather than failing the report', async () => {
    stubFetch([jsonResponse({ message: 'Unknown column' }, { ok: false, status: 500 })]);
    const { caseIdByDisplayNumber } = await fetchTestCaseNumbers(BASE_URL, TOKEN, PROJECT_ID, [1]);
    expect(caseIdByDisplayNumber.size).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });

  test('splits a large run into several queries', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const calls = stubFetch([jsonResponse([]), jsonResponse([]), jsonResponse([])]);
    await fetchTestCaseNumbers(BASE_URL, TOKEN, PROJECT_ID, ids);
    expect(calls).toHaveLength(3);
  });
});

describe('fetchCasesByMarker — resolving markers before a plan exists', () => {
  test('reads a marker as a business id first, then as an internal id', async () => {
    const calls = stubFetch([
      jsonResponse([CASES[0]]),
      jsonResponse([{ id: 1582499, display_number: 74011, title: 'Matched by internal id' }])
    ]);

    const byMarker = await fetchCasesByMarker(BASE_URL, TOKEN, PROJECT_ID, ['74002', '1582499']);

    expect(calls[0].url).toContain('display_number_in=74002');
    expect(calls[0].url).toContain('display_number_in=1582499');
    // Only the marker the first query could not explain is looked up as an id.
    expect(calls[1].url).toContain('id_in=1582499');
    expect(calls[1].url).not.toContain('id_in=74002');
    expect(byMarker.get('74002').id).toBe(1582490);
    expect(byMarker.get('1582499').id).toBe(1582499);
  });

  test('both queries are scoped to the project, so a marker cannot resolve to another project\'s case', async () => {
    const calls = stubFetch([jsonResponse([]), jsonResponse([])]);
    await fetchCasesByMarker(BASE_URL, TOKEN, PROJECT_ID, ['52']);
    calls.forEach((call) => expect(call.url).toContain(`project=${PROJECT_ID}`));
  });

  test('makes no second query when every marker is a business id', async () => {
    const calls = stubFetch([jsonResponse(CASES)]);
    const byMarker = await fetchCasesByMarker(BASE_URL, TOKEN, PROJECT_ID, ['74002', '74011']);
    expect(calls).toHaveLength(1);
    expect(byMarker.size).toBe(2);
  });

  test('a server that does not know business ids falls back to internal ids', async () => {
    const calls = stubFetch([
      jsonResponse({ message: 'Unknown column' }, { ok: false, status: 500 }),
      jsonResponse([{ id: 74002, title: 'A case whose internal id is 74002' }])
    ]);

    const byMarker = await fetchCasesByMarker(BASE_URL, TOKEN, PROJECT_ID, ['74002']);

    expect(calls).toHaveLength(2);
    expect(byMarker.get('74002').id).toBe(74002);
    expect(console.warn).toHaveBeenCalled();
  });

  test('a failed internal-id lookup throws, so auto-create cannot duplicate the cases it could not see', async () => {
    stubFetch([jsonResponse([]), jsonResponse({ message: 'boom' }, { ok: false, status: 500 })]);
    await expect(fetchCasesByMarker(BASE_URL, TOKEN, PROJECT_ID, ['74002'])).rejects.toThrow('boom');
  });

  test('makes no call when no test carries a marker', async () => {
    const calls = stubFetch([]);
    const byMarker = await fetchCasesByMarker(BASE_URL, TOKEN, PROJECT_ID, [null, undefined, '']);
    expect(calls).toHaveLength(0);
    expect(byMarker.size).toBe(0);
  });
});

describe('naming ids in the log', () => {
  test('a case is named by the id a user can look up', () => {
    const { displayNumberByCaseId } = indexTestCaseNumbers(CASES);
    expect(formatCaseLabel(1582490, displayNumberByCaseId)).toBe('TC-74002 (internal id 1582490)');
  });

  test('a case with no business id is still named', () => {
    expect(formatCaseLabel(1582490, new Map())).toBe('internal id 1582490');
  });

  test('a long list is cut short and says how much it left out', () => {
    const labels = Array.from({ length: 25 }, (_, i) => `TC-${i + 1}`);
    const formatted = formatIdList(labels);
    expect(formatted).toContain('TC-20');
    expect(formatted).toContain('and 5 more');
    expect(formatted).not.toContain('TC-21,');
  });

  test('a short list is printed whole', () => {
    expect(formatIdList(['TC-1', 'TC-2'])).toBe('TC-1, TC-2');
  });

  test('an empty run reads as none, not as an empty line', () => {
    expect(formatIdList([])).toBe('none');
  });
});
