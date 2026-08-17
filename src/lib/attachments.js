/**
 * attachments.js
 *
 * TCV-6853: test artefacts named by a JUnit `<system-out>` marker line, so a
 * failed automated result arrives with the same evidence a manual one carries.
 *
 * The marker convention comes from the Jenkins JUnit Attachments plugin (2012)
 * and is read by Azure DevOps too, so it is not tied to one CI system:
 *
 *   [[ATTACHMENT|screenshots/login-failure.png]]
 *   [[ATTACHMENT|screenshots/login-failure.png|{"name":"login failure"}]]
 *
 * `tc report` runs on the same agent as the tests, so the paths it names are
 * still on disk when we read them.
 */

import fs from 'fs';
import path from 'path';
import { decodeXmlEntities } from './xml.js';

// TCV-6853: guardrails. `tc report` runs immediately before `tc gate`, so a
// huge or numerous artefact set must not turn into a slow upload that holds up
// a release — anything past these limits is warned about and skipped.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_CASE = 10;

const SYSTEM_OUT_PATTERN = /<system-out\b[^>]*>([\s\S]*?)<\/system-out\s*>/gi;
const CDATA_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

// The marker must occupy a whole line. That is what stops a log line or an
// error message that merely quotes the syntax from being read as an artefact.
const MARKER_PATTERN = /^[ \t]*\[\[ATTACHMENT\|(.+?)\]\][ \t\r]*$/gim;

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.har': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4'
};

/**
 * Read a `<system-out>` body: CDATA sections are literal, everything outside
 * them is entity-encoded.
 */
function decodeSystemOut(raw) {
  let decoded = '';
  let cursor = 0;
  let section;

  CDATA_PATTERN.lastIndex = 0;
  while ((section = CDATA_PATTERN.exec(raw)) !== null) {
    decoded += decodeXmlEntities(raw.slice(cursor, section.index));
    decoded += section[1];
    cursor = CDATA_PATTERN.lastIndex;
  }
  decoded += decodeXmlEntities(raw.slice(cursor));

  return decoded;
}

/**
 * Split a marker payload into its file path, tolerating the optional third
 * part (`[[ATTACHMENT|file|{json}]]`) some runners emit. The metadata is
 * recognised only so it never ends up glued to the path.
 */
function markerPayloadToPath(payload) {
  const trimmed = String(payload || '').trim();
  const lastPipe = trimmed.lastIndexOf('|');

  if (lastPipe > 0) {
    const tail = trimmed.slice(lastPipe + 1).trim();
    if (tail.startsWith('{') && tail.endsWith('}')) {
      return trimmed.slice(0, lastPipe).trim();
    }
  }

  return trimmed;
}

/**
 * Collect the artefact paths named inside one `<testcase>` body.
 * Returns raw (un-resolved) paths in document order, without duplicates.
 */
export function extractAttachmentPaths(testCaseBody) {
  const body = String(testCaseBody || '');
  if (!body) {
    return [];
  }

  const paths = [];
  let systemOut;

  SYSTEM_OUT_PATTERN.lastIndex = 0;
  while ((systemOut = SYSTEM_OUT_PATTERN.exec(body)) !== null) {
    const text = decodeSystemOut(systemOut[1] || '');
    let marker;

    MARKER_PATTERN.lastIndex = 0;
    while ((marker = MARKER_PATTERN.exec(text)) !== null) {
      const filePath = markerPayloadToPath(marker[1]);
      if (filePath && !paths.includes(filePath)) {
        paths.push(filePath);
      }
    }
  }

  return paths;
}

export function guessMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Turn the paths a test named into files we can actually upload.
 *
 * `baseDirs` are tried in order for relative paths — the marker is written by
 * the test runner, so it may be relative to where the pipeline ran the tests or
 * to where it wrote the report.
 *
 * Returns `{ files, warnings }`; nothing here throws, because a missing or
 * oversized artefact must not stop the results from being reported.
 */
export function resolveAttachments(rawPaths, baseDirs = []) {
  const files = [];
  const warnings = [];
  const seen = new Set();

  for (const rawPath of rawPaths || []) {
    if (files.length >= MAX_ATTACHMENTS_PER_CASE) {
      warnings.push(
        `more than ${MAX_ATTACHMENTS_PER_CASE} attachments named; "${rawPath}" and any after it were skipped`
      );
      break;
    }

    const absPath = findExistingFile(rawPath, baseDirs);
    if (!absPath) {
      warnings.push(`attachment not found on disk: "${rawPath}"`);
      continue;
    }
    if (seen.has(absPath)) {
      continue;
    }

    let size;
    try {
      size = fs.statSync(absPath).size;
    } catch (error) {
      warnings.push(`attachment could not be read: "${rawPath}" (${error?.message || String(error)})`);
      continue;
    }

    if (size > MAX_ATTACHMENT_BYTES) {
      warnings.push(
        `attachment is larger than ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB and was skipped: "${rawPath}"`
      );
      continue;
    }

    seen.add(absPath);
    files.push({
      absPath,
      name: path.basename(absPath),
      size,
      mimeType: guessMimeType(absPath)
    });
  }

  return { files, warnings };
}

function findExistingFile(rawPath, baseDirs) {
  const candidate = String(rawPath || '').trim();
  if (!candidate) {
    return null;
  }

  const candidates = path.isAbsolute(candidate)
    ? [candidate]
    : (baseDirs || []).map(baseDir => path.resolve(baseDir, candidate));

  for (const absPath of candidates) {
    try {
      if (fs.statSync(absPath).isFile()) {
        return absPath;
      }
    } catch {
      // Not there — try the next base directory.
    }
  }

  return null;
}
