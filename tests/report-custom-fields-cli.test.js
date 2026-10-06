import { jest } from '@jest/globals';

const report = jest.fn();
jest.unstable_mockModule('../src/commands/report.js', () => ({ report, TcApiClient: class {}, encodeComment: jest.fn() }));

it('passes repeated custom-field flags from the real CLI entry point to report', async () => {
  const originalArgv = process.argv;
  try {
    process.argv = [process.execPath, 'tc', 'report', '--project', '4', '--auto-create', '--format', 'junit', '--result-file', 'results.xml',
      '--custom-field', 'Environment=Staging', '--custom-field', 'Notes=a=b'];
    await import('../src/index.js');
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      project: '4', autoCreate: true, format: 'junit', resultFile: 'results.xml', customField: ['Environment=Staging', 'Notes=a=b']
    });
  } finally {
    process.argv = originalArgv;
  }
});
