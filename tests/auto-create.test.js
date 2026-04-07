/**
 * Tests for the --auto-create flag on the report command.
 *
 * These tests verify:
 * 1. humanizeSuiteName() correctly transforms raw suite names
 * 2. normalizeTitle() correctly normalizes test case titles
 * 3. Parsers return allTests array with suite tracking
 */

import {
  humanizeSuiteName,
  normalizeTitle,
  parseJUnitReport,
  parseMochawesomeReport
} from '../src/commands/report.js';

describe('humanizeSuiteName', () => {
  test('strips Java package prefix', () => {
    expect(humanizeSuiteName('com.foo.bar.LoginTests')).toBe('Login');
  });

  test('strips deeply nested Java package', () => {
    expect(humanizeSuiteName('org.example.app.tests.UserProfileTests')).toBe('User Profile');
  });

  test('strips file path with forward slashes', () => {
    expect(humanizeSuiteName('tests/auth/login.spec.ts')).toBe('Login');
  });

  test('strips file path with backslashes', () => {
    expect(humanizeSuiteName('tests\\auth\\login.spec.ts')).toBe('Login');
  });

  test('strips .spec.ts extension', () => {
    expect(humanizeSuiteName('login.spec.ts')).toBe('Login');
  });

  test('strips .test.js extension', () => {
    expect(humanizeSuiteName('login.test.js')).toBe('Login');
  });

  test('strips .test.tsx extension', () => {
    expect(humanizeSuiteName('UserProfile.test.tsx')).toBe('User Profile');
  });

  test('strips .spec.py extension', () => {
    expect(humanizeSuiteName('login_spec.spec.py')).toBe('Login');
  });

  test('strips Tests suffix', () => {
    expect(humanizeSuiteName('LoginTests')).toBe('Login');
  });

  test('strips Test suffix', () => {
    expect(humanizeSuiteName('LoginTest')).toBe('Login');
  });

  test('strips Spec suffix', () => {
    expect(humanizeSuiteName('LoginSpec')).toBe('Login');
  });

  test('strips Suite suffix', () => {
    expect(humanizeSuiteName('LoginSuite')).toBe('Login');
  });

  test('splits camelCase', () => {
    expect(humanizeSuiteName('UserProfile')).toBe('User Profile');
  });

  test('splits snake_case', () => {
    expect(humanizeSuiteName('user_profile')).toBe('User Profile');
  });

  test('splits kebab-case', () => {
    expect(humanizeSuiteName('my-component')).toBe('My Component');
  });

  test('handles combined: camelCase + Tests suffix', () => {
    expect(humanizeSuiteName('UserProfileTests')).toBe('User Profile');
  });

  test('handles combined: snake_case + spec suffix', () => {
    expect(humanizeSuiteName('user_profile_spec')).toBe('User Profile');
  });

  test('handles combined: kebab-case + test suffix', () => {
    expect(humanizeSuiteName('my-component-test')).toBe('My Component');
  });

  test('handles combined: file path + camelCase + extension', () => {
    expect(humanizeSuiteName('src/components/UserProfile.spec.ts')).toBe('User Profile');
  });

  test('returns Uncategorized for empty string', () => {
    expect(humanizeSuiteName('')).toBe('Uncategorized');
  });

  test('returns Uncategorized for null', () => {
    expect(humanizeSuiteName(null)).toBe('Uncategorized');
  });

  test('returns Uncategorized for undefined', () => {
    expect(humanizeSuiteName(undefined)).toBe('Uncategorized');
  });

  test('leaves clean names untouched (except title casing)', () => {
    expect(humanizeSuiteName('Login Page')).toBe('Login Page');
  });

  test('title cases single word', () => {
    expect(humanizeSuiteName('authentication')).toBe('Authentication');
  });
});

describe('normalizeTitle', () => {
  test('lowercases', () => {
    expect(normalizeTitle('Should Login')).toBe('should login');
  });

  test('trims', () => {
    expect(normalizeTitle('  hello world  ')).toBe('hello world');
  });

  test('collapses whitespace', () => {
    expect(normalizeTitle('should   login   successfully')).toBe('should login successfully');
  });

  test('handles empty string', () => {
    expect(normalizeTitle('')).toBe('');
  });

  test('handles null', () => {
    expect(normalizeTitle(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(normalizeTitle(undefined)).toBe('');
  });

  test('handles tabs and newlines', () => {
    expect(normalizeTitle('should\n\tlogin')).toBe('should login');
  });
});

describe('parseJUnitReport — allTests output', () => {
  const sampleJunit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="AuthSuite" tests="3" failures="1" skipped="0">
    <testcase classname="com.app.AuthTests" name="[TC-100] should login" time="0.5" />
    <testcase classname="com.app.AuthTests" name="should register" time="1.0">
      <failure message="oops">stack trace</failure>
    </testcase>
    <testcase classname="UserTests" name="[TC-200] should view profile" time="0.3" />
  </testsuite>
</testsuites>`;

  test('should include allTests array in parsed result', () => {
    const report = parseJUnitReport(sampleJunit);
    expect(report.allTests).toBeDefined();
    expect(Array.isArray(report.allTests)).toBe(true);
  });

  test('allTests should contain all tests including those without TC IDs', () => {
    const report = parseJUnitReport(sampleJunit);
    expect(report.allTests).toHaveLength(3);
  });

  test('allTests entries should have suite field from classname', () => {
    const report = parseJUnitReport(sampleJunit);
    expect(report.allTests[0].suite).toBe('com.app.AuthTests');
    expect(report.allTests[1].suite).toBe('com.app.AuthTests');
    expect(report.allTests[2].suite).toBe('UserTests');
  });

  test('allTests entries should have tcId (null if missing)', () => {
    const report = parseJUnitReport(sampleJunit);
    expect(report.allTests[0].tcId).toBe('100');
    expect(report.allTests[1].tcId).toBeNull();
    expect(report.allTests[2].tcId).toBe('200');
  });

  test('allTests entries should have title', () => {
    const report = parseJUnitReport(sampleJunit);
    expect(report.allTests[0].title).toBe('[TC-100] should login');
    expect(report.allTests[1].title).toBe('should register');
  });

  test('allTests entries should have status', () => {
    const report = parseJUnitReport(sampleJunit);
    // 1 = pass, 2 = fail
    expect(report.allTests[0].status).toBe(1);
    expect(report.allTests[1].status).toBe(2);
  });

  test('existing resultsToUpload still works (backward compat)', () => {
    const report = parseJUnitReport(sampleJunit);
    const records = report.resultsToUpload['0'];
    // Only 2 records (the ones with TC IDs)
    expect(records).toHaveLength(2);
    expect(records[0].tcId).toBe('100');
    expect(records[1].tcId).toBe('200');
  });

  test('unresolvedIds still contains tests without TC IDs', () => {
    const report = parseJUnitReport(sampleJunit);
    expect(report.unresolvedIds).toContain('should register');
  });
});

describe('parseMochawesomeReport — allTests output', () => {
  const sampleMochawesome = {
    results: [
      {
        suites: [
          {
            title: 'Login Page',
            tests: [
              {
                title: '[TC-50] should display form',
                fullTitle: 'Login Page [TC-50] should display form',
                state: 'passed',
                duration: 120,
                err: {}
              },
              {
                title: 'should show error on invalid password',
                fullTitle: 'Login Page should show error on invalid password',
                state: 'failed',
                duration: 200,
                err: { message: 'expected true to be false', stack: 'Error: expected true to be false\n    at Context.<anonymous>' }
              }
            ],
            suites: []
          }
        ]
      }
    ]
  };

  test('should include allTests array in parsed result', () => {
    const report = parseMochawesomeReport(sampleMochawesome);
    expect(report.allTests).toBeDefined();
    expect(Array.isArray(report.allTests)).toBe(true);
  });

  test('allTests should contain all tests including those without TC IDs', () => {
    const report = parseMochawesomeReport(sampleMochawesome);
    expect(report.allTests).toHaveLength(2);
  });

  test('allTests entries should have suite field from describe block title', () => {
    const report = parseMochawesomeReport(sampleMochawesome);
    expect(report.allTests[0].suite).toBe('Login Page');
    expect(report.allTests[1].suite).toBe('Login Page');
  });

  test('allTests entries should have tcId (null if missing)', () => {
    const report = parseMochawesomeReport(sampleMochawesome);
    expect(report.allTests[0].tcId).toBe('50');
    expect(report.allTests[1].tcId).toBeNull();
  });

  test('allTests entries should have error details for failures', () => {
    const report = parseMochawesomeReport(sampleMochawesome);
    expect(report.allTests[0].errDetails).toBeNull();
    expect(report.allTests[1].errDetails).toContain('expected true to be false');
  });

  test('existing resultsToUpload still works (backward compat)', () => {
    const report = parseMochawesomeReport(sampleMochawesome);
    const records = report.resultsToUpload['0'];
    // Only 1 record (the one with TC ID)
    expect(records).toHaveLength(1);
    expect(records[0].tcId).toBe('50');
  });
});

describe('parseMochawesomeReport — nested suite hierarchy (TCV-6492)', () => {
  // Mirrors the structure reported in TCV-6492: MCP suite with Claude and
  // Codex as child suites, plus a test directly under MCP.
  const nestedMochawesome = {
    results: [
      {
        suites: [
          {
            title: '[TS-92956] MCP',
            tests: [
              {
                title: '[TC-847988] Verify MCP init',
                fullTitle: '[TS-92956] MCP [TC-847988] Verify MCP init',
                state: 'passed',
                duration: 2000,
                err: {}
              }
            ],
            suites: [
              {
                title: '[TS-92957] Claude',
                tests: [
                  {
                    title: '[TC-847994] Verify account creation',
                    fullTitle: '[TS-92956] MCP [TS-92957] Claude [TC-847994] Verify account creation',
                    state: 'passed',
                    duration: 1000,
                    err: {}
                  }
                ],
                suites: []
              },
              {
                title: '[TS-92955] Codex',
                tests: [
                  {
                    title: '[TC-847987] Verify Codex generation',
                    fullTitle: '[TS-92956] MCP [TS-92955] Codex [TC-847987] Verify Codex generation',
                    state: 'passed',
                    duration: 2000,
                    err: {}
                  }
                ],
                suites: []
              }
            ]
          }
        ]
      }
    ]
  };

  test('each test carries its full suite path from root to leaf', () => {
    const report = parseMochawesomeReport(nestedMochawesome);
    expect(report.allTests).toHaveLength(3);

    const byTcId = Object.fromEntries(report.allTests.map(t => [t.tcId, t]));

    expect(byTcId['847988'].suitePath).toEqual(['[TS-92956] MCP']);
    expect(byTcId['847994'].suitePath).toEqual(['[TS-92956] MCP', '[TS-92957] Claude']);
    expect(byTcId['847987'].suitePath).toEqual(['[TS-92956] MCP', '[TS-92955] Codex']);
  });

  test('innermost suite name is still exposed via the suite field', () => {
    const report = parseMochawesomeReport(nestedMochawesome);
    const byTcId = Object.fromEntries(report.allTests.map(t => [t.tcId, t]));

    expect(byTcId['847988'].suite).toBe('[TS-92956] MCP');
    expect(byTcId['847994'].suite).toBe('[TS-92957] Claude');
    expect(byTcId['847987'].suite).toBe('[TS-92955] Codex');
  });
});

describe('parseJUnitReport — suitePath (TCV-6492)', () => {
  const sampleJunit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="AuthSuite">
    <testcase classname="com.app.AuthTests" name="[TC-100] login" time="0.5" />
  </testsuite>
</testsuites>`;

  test('junit allTests entries carry a single-element suitePath', () => {
    const report = parseJUnitReport(sampleJunit);
    expect(report.allTests[0].suitePath).toEqual(['com.app.AuthTests']);
  });
});
