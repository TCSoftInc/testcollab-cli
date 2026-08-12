/**
 * TCV-6794 — the release tag decides the published version.
 *
 * Before this, scripts/bump-version.js ignored the tag completely: it read
 * package.json, asked npm for the latest published version, and auto-bumped the
 * minor. Releasing `v1.14` therefore published whatever that arithmetic produced —
 * which is how the repo reached tag v1.14 while npm sat at 1.11.0.
 */
import { describe, expect, test } from '@jest/globals';

import { resolveVersionFromTag } from '../scripts/bump-version.js';

describe('resolveVersionFromTag', () => {
  test('reads a plain v-prefixed tag', () => {
    expect(resolveVersionFromTag('v1.14.2')).toBe('1.14.2');
  });

  test('accepts a fully qualified ref', () => {
    expect(resolveVersionFromTag('refs/tags/v2.0.1')).toBe('2.0.1');
  });

  test('accepts a tag without the v prefix', () => {
    expect(resolveVersionFromTag('3.1.4')).toBe('3.1.4');
  });

  test('pads a two-part tag, because npm requires major.minor.patch', () => {
    // This is the shape the repo actually uses — v1.12, v1.13, v1.14.
    expect(resolveVersionFromTag('v1.14')).toBe('1.14.0');
  });

  test('keeps a prerelease suffix', () => {
    expect(resolveVersionFromTag('v1.15.0-rc1')).toBe('1.15.0-rc1');
    expect(resolveVersionFromTag('v1.15-rc1')).toBe('1.15.0-rc1');
  });

  test('rejects tags that are not versions, so they cannot publish something odd', () => {
    ['support', 'latest', 'v', 'release-candidate', 'v1', 'v1.2.3.4', 'vx.y.z'].forEach(
      (tag) => expect(resolveVersionFromTag(tag)).toBeNull()
    );
  });

  test('returns null when there is no tag at all', () => {
    expect(resolveVersionFromTag('')).toBeNull();
    expect(resolveVersionFromTag(undefined)).toBeNull();
    expect(resolveVersionFromTag(null)).toBeNull();
  });
});
