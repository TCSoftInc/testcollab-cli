/**
 * Tests for the JUnit `[[ATTACHMENT|path]]` support in `tc report` (TCV-6853).
 *
 *   - extractAttachmentPaths() — reading the marker out of <system-out>
 *   - resolveAttachments()     — turning those paths into uploadable files,
 *                                and the size/count guardrails
 *   - parseJUnitReport()       — the paths reaching the per-case run records
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  extractAttachmentPaths,
  resolveAttachments,
  guessMimeType,
  MAX_ATTACHMENTS_PER_CASE,
  MAX_ATTACHMENT_BYTES
} from '../src/lib/attachments.js';
import { parseJUnitReport } from '../src/commands/report.js';

describe('extractAttachmentPaths', () => {
  test('reads a marker from <system-out>', () => {
    const body = '<system-out>[[ATTACHMENT|screenshots/login.png]]</system-out>';
    expect(extractAttachmentPaths(body)).toEqual(['screenshots/login.png']);
  });

  test('reads several markers, in document order, from surrounding log noise', () => {
    const body = `
      <system-out>
running login spec
[[ATTACHMENT|shots/one.png]]
some more output
[[ATTACHMENT|/var/logs/run.log]]
done
      </system-out>`;
    expect(extractAttachmentPaths(body)).toEqual(['shots/one.png', '/var/logs/run.log']);
  });

  test('tolerates the optional third part without gluing it to the path', () => {
    const body = '<system-out>[[ATTACHMENT|shots/one.png|{"name":"login failure","type":"image"}]]</system-out>';
    expect(extractAttachmentPaths(body)).toEqual(['shots/one.png']);
  });

  test('keeps a trailing pipe segment that is not JSON as part of the path', () => {
    const body = '<system-out>[[ATTACHMENT|odd|name.png]]</system-out>';
    expect(extractAttachmentPaths(body)).toEqual(['odd|name.png']);
  });

  test('reads markers inside CDATA', () => {
    const body = `<system-out><![CDATA[
[[ATTACHMENT|shots/cdata.png]]
]]></system-out>`;
    expect(extractAttachmentPaths(body)).toEqual(['shots/cdata.png']);
  });

  test('decodes XML entities outside CDATA', () => {
    const body = '<system-out>[[ATTACHMENT|shots/a&amp;b.png]]</system-out>';
    expect(extractAttachmentPaths(body)).toEqual(['shots/a&b.png']);
  });

  test('ignores a marker that does not occupy a whole line', () => {
    const body = '<system-out>emit [[ATTACHMENT|shots/one.png]] to attach a file</system-out>';
    expect(extractAttachmentPaths(body)).toEqual([]);
  });

  test('accepts a marker line padded with whitespace and CRLF line endings', () => {
    const body = '<system-out>first line\r\n   [[ATTACHMENT|shots/one.png]]   \r\nlast line</system-out>';
    expect(extractAttachmentPaths(body)).toEqual(['shots/one.png']);
  });

  test('ignores markers outside <system-out> (e.g. in a failure message)', () => {
    const body = '<failure message="boom">\n[[ATTACHMENT|shots/one.png]]\n</failure>';
    expect(extractAttachmentPaths(body)).toEqual([]);
  });

  test('de-duplicates a path named twice', () => {
    const body = '<system-out>\n[[ATTACHMENT|a.png]]\n[[ATTACHMENT|a.png]]\n</system-out>';
    expect(extractAttachmentPaths(body)).toEqual(['a.png']);
  });

  test('collects across multiple <system-out> elements', () => {
    const body = '<system-out>[[ATTACHMENT|a.png]]</system-out><system-out>[[ATTACHMENT|b.png]]</system-out>';
    expect(extractAttachmentPaths(body)).toEqual(['a.png', 'b.png']);
  });

  test('returns nothing for a body with no markers', () => {
    expect(extractAttachmentPaths('<system-out>all good</system-out>')).toEqual([]);
    expect(extractAttachmentPaths('')).toEqual([]);
    expect(extractAttachmentPaths(null)).toEqual([]);
  });
});

describe('guessMimeType', () => {
  test('names the common artefact types so they render in TestCollab', () => {
    expect(guessMimeType('shots/login.PNG')).toBe('image/png');
    expect(guessMimeType('run.log')).toBe('text/plain');
    expect(guessMimeType('trace.zip')).toBe('application/zip');
  });

  test('falls back to a generic type for anything else', () => {
    expect(guessMimeType('artefact.unknownext')).toBe('application/octet-stream');
    expect(guessMimeType('noextension')).toBe('application/octet-stream');
  });
});

describe('resolveAttachments', () => {
  let tmpDir;
  let otherDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-attachments-'));
    otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-attachments-alt-'));
    fs.writeFileSync(path.join(tmpDir, 'one.png'), 'png-bytes');
    fs.writeFileSync(path.join(otherDir, 'two.log'), 'log-bytes');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  test('resolves an absolute path without consulting the base directories', () => {
    const { files, warnings } = resolveAttachments([path.join(tmpDir, 'one.png')], []);
    expect(warnings).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('one.png');
    expect(files[0].mimeType).toBe('image/png');
    expect(files[0].size).toBe('png-bytes'.length);
  });

  test('resolves a relative path against the first base directory that has it', () => {
    const { files, warnings } = resolveAttachments(['two.log'], [tmpDir, otherDir]);
    expect(warnings).toEqual([]);
    expect(files.map(f => f.absPath)).toEqual([path.join(otherDir, 'two.log')]);
  });

  test('warns instead of throwing when the artefact is not on disk', () => {
    const { files, warnings } = resolveAttachments(['gone.png'], [tmpDir]);
    expect(files).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not found on disk');
    expect(warnings[0]).toContain('gone.png');
  });

  test('warns and skips a directory named as an attachment', () => {
    const { files, warnings } = resolveAttachments([tmpDir], []);
    expect(files).toEqual([]);
    expect(warnings[0]).toContain('not found on disk');
  });

  test('de-duplicates two paths that resolve to the same file', () => {
    const { files } = resolveAttachments(['one.png', path.join(tmpDir, 'one.png')], [tmpDir]);
    expect(files).toHaveLength(1);
  });

  test('caps the number of attachments per test case and says what it dropped', () => {
    const names = [];
    for (let i = 0; i < MAX_ATTACHMENTS_PER_CASE + 3; i++) {
      const name = `capped-${i}.txt`;
      fs.writeFileSync(path.join(tmpDir, name), 'x');
      names.push(name);
    }

    const { files, warnings } = resolveAttachments(names, [tmpDir]);
    expect(files).toHaveLength(MAX_ATTACHMENTS_PER_CASE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`more than ${MAX_ATTACHMENTS_PER_CASE} attachments`);
  });

  test('caps the size of a single attachment', () => {
    const bigName = 'huge.bin';
    fs.writeFileSync(path.join(tmpDir, bigName), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));

    const { files, warnings } = resolveAttachments([bigName], [tmpDir]);
    expect(files).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('larger than');

    fs.rmSync(path.join(tmpDir, bigName));
  });

  test('handles an empty or missing list', () => {
    expect(resolveAttachments([], [tmpDir])).toEqual({ files: [], warnings: [] });
    expect(resolveAttachments(undefined, [tmpDir])).toEqual({ files: [], warnings: [] });
  });
});

describe('parseJUnitReport with attachments', () => {
  test('carries each case its own artefact paths', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Checkout">
    <testcase name="[TC-101] pays with a card" classname="Checkout" time="1.5">
      <system-out><![CDATA[
[[ATTACHMENT|shots/pass.png]]
]]></system-out>
    </testcase>
    <testcase name="[TC-102] rejects an expired card" classname="Checkout" time="2">
      <failure message="expected 200">at checkout.spec.ts:14</failure>
      <system-out>
[[ATTACHMENT|shots/fail.png]]
[[ATTACHMENT|logs/browser.log|{"name":"console"}]]
      </system-out>
    </testcase>
    <testcase name="[TC-103] no artefacts" classname="Checkout" time="1" />
  </testsuite>
</testsuites>`;

    const parsed = parseJUnitReport(xml);
    const records = parsed.resultsToUpload['0'];

    expect(records.map(r => r.tcId)).toEqual(['101', '102', '103']);
    expect(records[0].attachmentPaths).toEqual(['shots/pass.png']);
    expect(records[1].attachmentPaths).toEqual(['shots/fail.png', 'logs/browser.log']);
    expect(records[2].attachmentPaths).toEqual([]);

    // --auto-create rebuilds the run records from allTests, so the paths have to
    // survive on that side too.
    expect(parsed.allTests[1].attachmentPaths).toEqual(['shots/fail.png', 'logs/browser.log']);
  });

  test('a report with no markers still parses exactly as before', () => {
    const xml = `<testsuite name="Checkout">
      <testcase name="[TC-1] works" classname="Checkout" time="1"><system-out>plain output</system-out></testcase>
    </testsuite>`;

    const parsed = parseJUnitReport(xml);
    expect(parsed.resultsToUpload['0'][0].attachmentPaths).toEqual([]);
    expect(parsed.stats).toEqual({ tests: 1, passes: 1, failures: 0, skipped: 0 });
  });
});
