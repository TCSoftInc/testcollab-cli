/**
 * `tc --version` prints the installed version.
 *
 * The flag used to print a fixed "1.0.0" whichever version was installed, so
 * nobody could tell which CLI a machine or a pipeline ran. The release workflow
 * writes the tag's version into package.json before it publishes, so that file
 * is the one place that knows the version.
 */
import { describe, expect, test } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'src', 'index.js');
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
).version;

describe('tc --version', () => {
  test.each(['--version', '-V'])('%s prints the version from package.json', (flag) => {
    const output = execFileSync(process.execPath, [cliPath, flag], { encoding: 'utf8' });
    expect(output.trim()).toBe(packageVersion);
  });
});
