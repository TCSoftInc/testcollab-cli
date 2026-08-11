/**
 * Tests for test case id extraction from test names (TCV-6812).
 *
 * The bug: extractTestCaseIdFromTitle() ran a bare "trailing -<digits>" shortcut
 * BEFORE it consulted the explicit TC_ID_PATTERNS markers, so a name like
 * "[TC-1730] ... and UTF-8" resolved to case 8 and the [TC-1730] marker was
 * never examined. Results were then written to an unrelated test case.
 */

import { extractTestCaseIdFromTitle, parseJUnitReport } from '../src/commands/report.js';

describe('extractTestCaseIdFromTitle — explicit markers win (TCV-6812)', () => {
  test('bracketed marker beats a trailing -<digits> in the prose', () => {
    expect(
      extractTestCaseIdFromTitle('[TC-1730] Response declares HTML content type and UTF-8')
    ).toBe('1730');
  });

  test('marker at the end of the name beats a hyphenated number at the start', () => {
    expect(extractTestCaseIdFromTitle('SHA-256 hashing [TC-99]')).toBe('99');
  });

  test.each([
    ['[TC-1724] Deployed page returns HTTP 200', '1724'],
    ['[TC-1731] Digest uses SHA-256', '1731'],
    ['[TC-1732] Response is ISO-8601 timestamped', '1732'],
    ['[TC-1733] Payload survives base-64 round trip', '1733'],
    ['[TC-1734] Shows the top-10 results', '1734']
  ])('%s resolves to %s', (title, expected) => {
    expect(extractTestCaseIdFromTitle(title)).toBe(expected);
  });

  test('all documented marker forms still resolve', () => {
    expect(extractTestCaseIdFromTitle('[TC-123] Login should succeed')).toBe('123');
    expect(extractTestCaseIdFromTitle('TC-123 Login should succeed')).toBe('123');
    expect(extractTestCaseIdFromTitle('Login should succeed id-123')).toBe('123');
    expect(extractTestCaseIdFromTitle('Login should succeed testcase-123')).toBe('123');
  });
});

describe('extractTestCaseIdFromTitle — bare slug fallback', () => {
  test('a whole-title <slug>-<digits> name still resolves (unchanged behaviour)', () => {
    expect(extractTestCaseIdFromTitle('checkout-42')).toBe('42');
    expect(extractTestCaseIdFromTitle('login-flow-123')).toBe('123');
    expect(extractTestCaseIdFromTitle('user_profile-7')).toBe('7');
  });

  test('prose ending in a hyphenated number is NOT treated as an id', () => {
    expect(extractTestCaseIdFromTitle('Response declares content type and UTF-8')).toBeNull();
    expect(extractTestCaseIdFromTitle('Digest uses SHA-256')).toBeNull();
    expect(extractTestCaseIdFromTitle('Shows the top-10 results by score-5')).toBeNull();
  });

  test('dotted class names ending in a hyphenated number are not ids', () => {
    expect(extractTestCaseIdFromTitle('com.app.Encoding.UTF-8')).toBeNull();
    expect(extractTestCaseIdFromTitle('tests/encoding/utf-8')).toBeNull();
  });

  test('names with no id at all return null', () => {
    expect(extractTestCaseIdFromTitle('Login should succeed')).toBeNull();
    expect(extractTestCaseIdFromTitle('')).toBeNull();
    expect(extractTestCaseIdFromTitle(null)).toBeNull();
    expect(extractTestCaseIdFromTitle(undefined)).toBeNull();
  });
});

describe('parseJUnitReport — end-to-end reproduction (TCV-6812)', () => {
  test('a report whose names end in -<digits> maps every case to its marker', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Automated Checks" tests="3">
    <testcase classname="AutomatedChecks" name="[TC-1729] Deployed page returns HTTP 200" time="0.10" />
    <testcase classname="AutomatedChecks" name="[TC-1730] Response declares HTML content type and UTF-8" time="0.12" />
    <testcase classname="AutomatedChecks" name="[TC-1731] Digest uses SHA-256" time="0.08" />
  </testsuite>
</testsuites>`;

    const report = parseJUnitReport(xml);

    expect(report.allTests.map((t) => t.tcId)).toEqual(['1729', '1730', '1731']);
    expect(report.unresolvedIds).toEqual([]);

    // resultsToUpload is what actually reaches the API — the stray ids 8 and 256
    // must not appear there under any configuration key.
    const uploadedIds = Object.values(report.resultsToUpload).flat().map((r) => r.tcId);
    expect(uploadedIds.sort()).toEqual(['1729', '1730', '1731']);
    expect(uploadedIds).not.toContain('8');
    expect(uploadedIds).not.toContain('256');
  });
});
