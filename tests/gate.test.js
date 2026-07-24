/**
 * Tests for the `tc gate` command's pure evaluation logic (TCV-6668).
 *
 * These cover the two pieces that decide pass/fail without any network I/O:
 *   - summarize()    — count executed test cases by status
 *   - evaluateGate() — apply the gate criteria to a result summary
 *   - parseFailOn()  — parse the --fail-on option
 */

import { summarize, evaluateGate, parseFailOn } from '../src/commands/gate.js';

describe('parseFailOn', () => {
  test('defaults to ["failed"] when unset', () => {
    expect(parseFailOn(undefined)).toEqual(['failed']);
    expect(parseFailOn(null)).toEqual(['failed']);
  });

  test('defaults to ["failed"] when blank/empty', () => {
    expect(parseFailOn('')).toEqual(['failed']);
    expect(parseFailOn('  ,  ')).toEqual(['failed']);
  });

  test('parses a single status', () => {
    expect(parseFailOn('blocked')).toEqual(['blocked']);
  });

  test('parses a comma list and trims whitespace', () => {
    expect(parseFailOn('failed, blocked')).toEqual(['failed', 'blocked']);
    expect(parseFailOn(' failed ,blocked ')).toEqual(['failed', 'blocked']);
  });
});

describe('summarize', () => {
  test('always returns the five system statuses, zeroed', () => {
    expect(summarize([])).toEqual({
      unexecuted: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      blocked: 0
    });
  });

  test('counts executed cases by status', () => {
    const cases = [
      { status: 'passed' },
      { status: 'passed' },
      { status: 'failed' },
      { status: 'blocked' },
      { status: 'skipped' }
    ];
    const s = summarize(cases);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.blocked).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.unexecuted).toBe(0);
  });

  test('treats missing/blank status as unexecuted', () => {
    const s = summarize([{ status: '' }, { status: '   ' }, {}, { status: null }]);
    expect(s.unexecuted).toBe(4);
  });

  test('preserves user-defined statuses under their own key', () => {
    const s = summarize([
      { status: 'needs_review' },
      { status: 'needs_review' },
      { status: 'passed' }
    ]);
    expect(s.needs_review).toBe(2);
    expect(s.passed).toBe(1);
  });

  test('handles non-array input safely', () => {
    expect(summarize(null).failed).toBe(0);
    expect(summarize(undefined).passed).toBe(0);
  });
});

describe('evaluateGate', () => {
  test('passes when there are no failing cases (default fail-on)', () => {
    const v = evaluateGate({ passed: 10, failed: 0, blocked: 0, skipped: 1, unexecuted: 0 }, {});
    expect(v.passed).toBe(true);
    expect(v.reasons).toHaveLength(0);
    expect(v.total).toBe(11);
    expect(v.executed).toBe(11);
  });

  test('fails on a single failing case (the minimum gate)', () => {
    const v = evaluateGate({ passed: 9, failed: 1 }, { failOn: ['failed'], maxFailed: 0 });
    expect(v.passed).toBe(false);
    expect(v.offending).toBe(1);
    expect(v.reasons[0]).toContain('failed');
  });

  test('--max-failed tolerates up to N failures', () => {
    const summary = { passed: 8, failed: 2 };
    expect(evaluateGate(summary, { maxFailed: 2 }).passed).toBe(true);
    expect(evaluateGate(summary, { maxFailed: 1 }).passed).toBe(false);
  });

  test('--fail-on can include blocked', () => {
    const summary = { passed: 5, failed: 0, blocked: 3 };
    expect(evaluateGate(summary, { failOn: ['failed'] }).passed).toBe(true);
    const v = evaluateGate(summary, { failOn: ['failed', 'blocked'] });
    expect(v.passed).toBe(false);
    expect(v.offending).toBe(3);
  });

  test('--require-complete fails when cases are unexecuted', () => {
    const summary = { passed: 5, failed: 0, unexecuted: 2 };
    expect(evaluateGate(summary, { requireComplete: false }).passed).toBe(true);
    const v = evaluateGate(summary, { requireComplete: true });
    expect(v.passed).toBe(false);
    expect(v.reasons[0]).toContain('unexecuted');
  });

  test('--min-pass-rate is computed over executed cases', () => {
    // 8 passed of 10 executed (2 failed) = 80%
    const summary = { passed: 8, failed: 2, unexecuted: 0 };
    expect(evaluateGate(summary, { failOn: ['x'], minPassRate: 75 }).passRate).toBeCloseTo(80);
    expect(evaluateGate(summary, { failOn: ['x'], minPassRate: 75 }).passed).toBe(true);
    expect(evaluateGate(summary, { failOn: ['x'], minPassRate: 90 }).passed).toBe(false);
  });

  test('--min-pass-rate excludes unexecuted from the denominator', () => {
    // 5 passed of 5 executed = 100%, even with 95 unexecuted
    const v = evaluateGate({ passed: 5, failed: 0, unexecuted: 95 }, { failOn: ['x'], minPassRate: 100 });
    expect(v.passRate).toBeCloseTo(100);
    expect(v.passed).toBe(true);
  });

  test('--min-pass-rate treats zero executed as 0% (fails)', () => {
    const v = evaluateGate({ passed: 0, failed: 0, unexecuted: 10 }, { failOn: ['x'], minPassRate: 1 });
    expect(v.passRate).toBe(0);
    expect(v.passed).toBe(false);
  });

  test('supports user-defined fail-on statuses', () => {
    const v = evaluateGate({ passed: 5, needs_review: 1 }, { failOn: ['needs_review'] });
    expect(v.passed).toBe(false);
    expect(v.offending).toBe(1);
  });

  test('accumulates multiple independent reasons', () => {
    const v = evaluateGate(
      { passed: 5, failed: 2, unexecuted: 3 },
      { failOn: ['failed'], maxFailed: 0, requireComplete: true, minPassRate: 100 }
    );
    expect(v.passed).toBe(false);
    // one for failures, one for unexecuted, one for pass rate
    expect(v.reasons.length).toBe(3);
  });
});
