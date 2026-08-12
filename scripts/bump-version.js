import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');


// TCV-6794: the git tag is the source of truth for a release. Before this, the tag
// was ignored entirely: the script read package.json, asked npm for the latest
// published version and auto-bumped the minor, so releasing `v1.14` published
// whatever that arithmetic produced. Tags reached v1.14 while npm sat at 1.11.0.
//
// Exported for tests — the rest of this file is a script, not a module API.
export function resolveVersionFromTag(tagRef) {
  if (!tagRef) return null;
  // Accept `v1.14`, `1.14`, `refs/tags/v1.14.2`, `v1.14.2-rc1`.
  const tag = String(tagRef).trim().replace(/^refs\/tags\//, '');
  const withoutPrefix = tag.replace(/^v/i, '');
  if (!withoutPrefix) return null;

  const [core, ...rest] = withoutPrefix.split('-');
  const parts = core.split('.');
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((part) => part === '' || !/^\d+$/.test(part))) return null;

  // npm needs a full major.minor.patch, so `v1.14` means `1.14.0`.
  while (parts.length < 3) parts.push('0');
  const suffix = rest.length ? `-${rest.join('-')}` : '';
  return `${parts.join('.')}${suffix}`;
}

function parseVersion(version) {
  const cleanVersion = version.split('-')[0];
  const parts = cleanVersion.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return parts;
}

function compare(v1, v2) {
  const p1 = parseVersion(v1);
  const p2 = parseVersion(v2);
  for (let i = 0; i < 3; i += 1) {
    if (p1[i] > p2[i]) return 1;
    if (p1[i] < p2[i]) return -1;
  }
  return 0;
}

function bumpMinor(version) {
  const [maj, min] = parseVersion(version);
  return `${maj}.${min + 1}.0`;
}

function bumpPatch(version) {
  const [maj, min, pat] = parseVersion(version);
  return `${maj}.${min}.${pat + 1}`;
}

function npmView(pkg, token) {
  if (!token) {
    try {
      const v = execSync(`npm view ${pkg} version`, { encoding: 'utf8' }).trim();
      console.log(`Latest published version for ${pkg}: ${v}`);
      return v;
    } catch (error) {
      console.log(`Could not fetch version from npm for ${pkg} (might not exist yet).`);
      return undefined;
    }
  }

  const tmpRc = path.join(os.tmpdir(), `.npmrc-${Date.now()}-${Math.random()}`);
  try {
    fs.writeFileSync(tmpRc, `//registry.npmjs.org/:_authToken=${token}\n`, 'utf8');
    const v = execSync(`npm view ${pkg} version --userconfig ${tmpRc}`, { encoding: 'utf8' }).trim();
    console.log(`Latest published version for ${pkg} (auth): ${v}`);
    return v;
  } catch (error) {
    console.log(`Could not fetch version from npm for ${pkg} with auth (might not exist yet).`);
    return undefined;
  } finally {
    try {
      fs.unlinkSync(tmpRc);
    } catch (_) {
      // ignore cleanup errors
    }
  }
}

function readJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function writeJson(jsonPath, data) {
  fs.writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
}

function updateLockFile(lockPath, newVersion) {
  if (!fs.existsSync(lockPath)) return;

  const lockJson = readJson(lockPath);

  if (lockJson.version) {
    lockJson.version = newVersion;
  }

  if (lockJson.packages && lockJson.packages['']) {
    lockJson.packages[''].version = newVersion;
  }

  writeJson(lockPath, lockJson);
  console.log(`package-lock.json updated to ${newVersion}`);
}

// TCV-6794: only run when invoked as a script. Importing this module for its
// exported helpers must not rewrite package.json — a test that imports it would
// otherwise bump the version on every run, including in CI.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) try {
  const packageJsonPath = path.join(rootDir, 'package.json');
  const lockPath = path.join(rootDir, 'package-lock.json');

  const packageJson = readJson(packageJsonPath);
  const packageName = packageJson.name;
  const localVersion = packageJson.version;
  console.log(`Local package.json version: ${localVersion}`);

  const publishedVersion = npmView(packageName, process.env.NPM_TOKEN);
  const knownPublished = [publishedVersion].filter(Boolean);

  // A tagged release publishes exactly what the tag says. Nothing is inferred, and
  // a clash is a hard failure rather than a silent publish under another number —
  // a version mismatch between the GitHub release and npm is worse than a red build.
  const tagRef = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || '';
  const taggedVersion = resolveVersionFromTag(tagRef);
  if (tagRef && !taggedVersion) {
    throw new Error(
      `Release tag "${tagRef}" is not a version tag (expected v1.14, 1.14 or v1.14.2).`
    );
  }
  if (taggedVersion) {
    console.log(`Release tag ${tagRef} -> publishing ${taggedVersion}`);
    if (knownPublished.includes(taggedVersion)) {
      throw new Error(
        `Version ${taggedVersion} is already published to npm. ` +
          `Tag a new version rather than re-releasing ${tagRef}.`
      );
    }
    if (taggedVersion !== localVersion) {
      packageJson.version = taggedVersion;
      writeJson(packageJsonPath, packageJson);
      console.log(`package.json updated to ${taggedVersion}`);
    } else {
      console.log('package.json already matches the tag; no change needed.');
    }
    updateLockFile(lockPath, taggedVersion);
    process.exit(0);
  }
  console.log('No release tag in the environment; falling back to npm-derived versioning.');

  let baseVersion = localVersion;
  for (const version of knownPublished) {
    if (compare(version, baseVersion) === 1) {
      baseVersion = version;
    }
  }

  let newVersion;
  const localIsHighest = knownPublished.every(
    (version) => !version || compare(localVersion, version) === 1,
  );

  if (localIsHighest) {
    newVersion = localVersion;
    console.log(`Local version (${localVersion}) is highest; keeping it.`);
  } else {
    newVersion = bumpMinor(baseVersion);
    console.log(`Auto-incrementing minor from ${baseVersion} to ${newVersion}`);
  }

  const publishedSet = new Set(knownPublished);
  while (publishedSet.has(newVersion)) {
    const bumped = bumpPatch(newVersion);
    console.log(`Version ${newVersion} already published; bumping patch to ${bumped}`);
    newVersion = bumped;
  }

  if (newVersion !== localVersion) {
    packageJson.version = newVersion;
    writeJson(packageJsonPath, packageJson);
    console.log(`package.json updated to ${newVersion}`);
  } else {
    console.log('package.json version already at desired value; no change needed.');
  }

  updateLockFile(lockPath, newVersion);
} catch (error) {
  console.error('Error bumping version:', error);
  process.exit(1);
}
