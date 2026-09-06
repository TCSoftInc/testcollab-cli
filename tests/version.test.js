import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

describe('CLI version', () => {
  test('reports the package version', () => {
    const output = execFileSync(
      process.execPath,
      ['src/index.js', '--version'],
      { cwd: process.cwd(), encoding: 'utf8' }
    );

    expect(output.trim()).toBe(version);
  });
});
