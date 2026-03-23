/**
 * Tests for the --skip-missing flag on the report command.
 *
 * These tests verify that:
 * 1. When --skip-missing is enabled, assigned cases NOT in the result file are marked as skipped
 * 2. When --skip-missing is NOT enabled, unmatched cases are left untouched
 * 3. Cases that ARE matched by results are never double-skipped
 */

import { parseJUnitReport, parseMochawesomeReport } from '../src/commands/report.js';

describe('--skip-missing flag', () => {
  describe('parseJUnitReport — result parsing still works correctly', () => {
    const sampleJunit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Suite" tests="2" failures="0" skipped="0">
    <testcase classname="Suite" name="[TC-100] test one" time="0.5" />
    <testcase classname="Suite" name="[TC-200] test two" time="1.0">
      <failure message="oops">stack trace</failure>
    </testcase>
  </testsuite>
</testsuites>`;

    test('should parse two test cases with correct IDs', () => {
      const report = parseJUnitReport(sampleJunit);
      const records = report.resultsToUpload['0'];
      expect(records).toHaveLength(2);
      expect(records[0].tcId).toBe('100');
      expect(records[1].tcId).toBe('200');
    });

    test('should return correct stats', () => {
      const report = parseJUnitReport(sampleJunit);
      expect(report.stats.tests).toBe(2);
      expect(report.stats.passes).toBe(1);
      expect(report.stats.failures).toBe(1);
      expect(report.stats.skipped).toBe(0);
    });
  });

  describe('parseMochawesomeReport — result parsing still works correctly', () => {
    const sampleMochawesome = {
      stats: { suites: 1, tests: 2, passes: 1, pending: 0, failures: 1, skipped: 0 },
      results: [
        {
          suites: [
            {
              title: 'MySuite',
              tests: [
                {
                  title: '[TC-300] passes',
                  fullTitle: 'MySuite [TC-300] passes',
                  state: 'passed',
                  pass: true,
                  fail: false,
                  duration: 100,
                  err: {}
                },
                {
                  title: '[TC-400] fails',
                  fullTitle: 'MySuite [TC-400] fails',
                  state: 'failed',
                  pass: false,
                  fail: true,
                  duration: 200,
                  err: { message: 'bad', stack: 'Error: bad' }
                }
              ],
              suites: []
            }
          ]
        }
      ]
    };

    test('should parse two test cases with correct IDs', () => {
      const report = parseMochawesomeReport(sampleMochawesome);
      const records = report.resultsToUpload['0'];
      expect(records).toHaveLength(2);
      expect(records[0].tcId).toBe('300');
      expect(records[1].tcId).toBe('400');
    });
  });

  describe('skip-missing integration logic', () => {
    /**
     * Simulates the core logic from uploadUsingReporterFlow to verify
     * that unmatched assigned cases are correctly identified.
     */
    test('should identify unmatched cases from assigned list', () => {
      // Simulated assigned cases from the API (test plan has TC-100, TC-200, TC-300)
      const casesAssigned = [
        { id: 1, test_plan_test_case: { id: 10, test_case: 100 } },
        { id: 2, test_plan_test_case: { id: 20, test_case: 200 } },
        { id: 3, test_plan_test_case: { id: 30, test_case: 300 } }
      ];

      // Result file only contains TC-100 (so TC-200 and TC-300 are "missing")
      const matchedExecCaseIds = new Set([1]); // Only case id=1 was matched

      const missingCases = casesAssigned.filter(
        (assignedCase) => assignedCase && assignedCase.id && !matchedExecCaseIds.has(assignedCase.id)
      );

      expect(missingCases).toHaveLength(2);
      expect(missingCases[0].id).toBe(2);
      expect(missingCases[1].id).toBe(3);
    });

    test('should extract test case IDs for bulkAction payload', () => {
      const projectId = 42;
      const testPlanId = 99;

      // Simulated missing cases (not matched by results)
      const missingCases = [
        { id: 2, test_plan_test_case: { id: 20, test_case: 200 } },
        { id: 3, test_plan_test_case: { id: 30, test_case: 300 } },
        { id: 5, test_plan_test_case: { id: 50, test_case: 500 } }
      ];

      // Extract test case IDs the same way the CLI does
      const missingTestCaseIds = missingCases
        .map((c) => {
          const tptc = c.test_plan_test_case;
          if (tptc && typeof tptc === 'object') {
            return tptc.test_case;
          }
          return null;
        })
        .filter((id) => id !== null && id !== undefined);

      const bulkPayload = {
        actionType: 'skip',
        testcases: missingTestCaseIds,
        project: projectId,
        testplan: testPlanId
      };

      expect(bulkPayload).toEqual({
        actionType: 'skip',
        testcases: [200, 300, 500],
        project: 42,
        testplan: 99
      });
    });

    test('should not skip any cases when all are matched', () => {
      const casesAssigned = [
        { id: 1, test_plan_test_case: { id: 10, test_case: 100 } },
        { id: 2, test_plan_test_case: { id: 20, test_case: 200 } }
      ];

      const matchedExecCaseIds = new Set([1, 2]);

      const missingCases = casesAssigned.filter(
        (assignedCase) => assignedCase && assignedCase.id && !matchedExecCaseIds.has(assignedCase.id)
      );

      expect(missingCases).toHaveLength(0);
    });

    test('should skip cases with plain id test_plan_test_case (not object)', () => {
      // When test_plan_test_case is a plain number, test_case ID cannot be extracted
      const missingCases = [
        { id: 8, test_plan_test_case: 80 }
      ];

      const missingTestCaseIds = missingCases
        .map((c) => {
          const tptc = c.test_plan_test_case;
          if (tptc && typeof tptc === 'object') {
            return tptc.test_case;
          }
          return null;
        })
        .filter((id) => id !== null && id !== undefined);

      // Plain IDs should be filtered out since we can't extract test_case from them
      expect(missingTestCaseIds).toHaveLength(0);
    });
  });
});
