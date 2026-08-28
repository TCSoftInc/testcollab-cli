import { buildExecutionEntries } from '../src/commands/getTestPlan.js';

test('maps assigned run rows to exact execution ids and plan case details', () => {
  const entries = buildExecutionEntries(
    [
      {
        id: 17922,
        testPlanTestCase: { id: 901 },
        testPlanConfig: { id: 8 },
        assignedTo: { id: 77 },
        status: 'unexecuted',
      },
    ],
    [
      {
        id: 901,
        testCase: { id: 123, title: 'Checkout succeeds' },
      },
    ],
    {
      8: {
        id: 8,
        parameters: [
          { field: 'Browser', value: 'Chrome' },
          { field: 'OS', value: 'Linux' },
        ],
      },
    }
  );

  expect(entries).toEqual([
    {
      id: 17922,
      testPlanTestCaseId: 901,
      testCaseId: 123,
      title: 'Checkout succeeds',
      configId: 8,
      configLabel: 'Browser: Chrome, OS: Linux',
      status: 'unexecuted',
      assignedTo: 77,
    },
  ]);
});
