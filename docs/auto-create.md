# Auto-Create Mode (`--auto-create`)

## Overview

The `--auto-create` flag for the `report` command enables a zero-setup CI experience. Instead of requiring a pre-existing test plan with assigned test cases, it parses your test result file and automatically creates everything needed in TestCollab: tags, test suites, test cases, a test plan folder, and a test plan — then uploads the results.

This is ideal for CI/CD pipelines where you want TestCollab to reflect your automated test results without manual setup.

## How It Works (Quick Summary)

```bash
tc-cli report --project 123 --format junit --result-file results.xml --auto-create
```

1. Parses your result file (JUnit XML or Mochawesome JSON)
2. Resolves the **build** when `--build` is passed (creating it from the version if no build records it yet)
3. Creates a **"CI Imported"** tag (if it doesn't exist)
4. Creates **test suites** from suite/class names in the results (if they don't exist)
5. Creates **test cases** from test names (if they don't exist), matching existing ones by title
6. Creates a **"CI" folder** for test plans (if it doesn't exist)
7. Creates a **test plan** (`CI Run: DD-MM-YYYY HH:MM`) under the CI folder, linked to the build
8. Adds all tagged test cases to the plan and assigns them to the current user
9. Uploads the test results

## Report Command Modes

The `report` command has three primary modes depending on how your test results and TestCollab are set up:

### Mode 1: Full Match (existing workflow)

```bash
tc-cli report --project 123 --test-plan-id 456 --format junit --result-file results.xml
```

- Test plan already exists in TestCollab
- Test cases already exist with TC IDs
- Result file test names contain TC IDs (e.g., `[TC-42] should login`)
- The command matches results to assigned cases and uploads statuses

### Mode 2: Auto-Create with TC IDs

```bash
tc-cli report --project 123 --format junit --result-file results.xml --auto-create
```

- **No test plan needed** — one is created automatically
- Test cases already exist in TestCollab
- Result file test names contain TC IDs (e.g., `[TC-42] should login`)
- The command verifies each TC ID exists, tags it with "CI Imported", creates a plan, and uploads

### Mode 3: Full Auto (no IDs, no plan)

```bash
tc-cli report --project 123 --format junit --result-file results.xml --auto-create
```

- **No test plan needed** — one is created automatically
- **No TC IDs in test names** — the command matches by title or creates new test cases
- Test names are plain strings (e.g., `should login with valid credentials`)
- The command creates suites, test cases, tags them, creates a plan, and uploads

### Mixed Mode

Auto-create handles mixed results seamlessly. If some tests have TC IDs and others don't:

- Tests with `[TC-42]` in the name → matched by ID
- Tests without IDs → matched by title within the same suite, or created new

## What Gets Created

| Resource | Name | When Created |
|----------|------|-------------|
| **Tag** | `CI Imported` | Once per project (reused on subsequent runs) |
| **Test Suites** | Humanized from suite/classname | Once per unique suite name |
| **Test Cases** | From test names in result file | Only when no match by ID or title exists |
| **Test Plan Folder** | `CI` | Once per project |
| **Test Plan** | `CI Run: DD-MM-YYYY HH:MM` | Every run creates a new plan |
| **Build** | The version passed to `--build` | Only when the value is not a build id and no build has that version |

## Linking Results to a Build

Results that come out of a pipeline belong to a version of the software that was deployed. Pass that version and the auto-created plan is linked to it, so the results roll up into the build's traceability view and into release readiness:

```bash
tc-cli report \
  --project 42 \
  --format junit \
  --result-file results.xml \
  --auto-create \
  --build 2.14.9 \
  --environment Staging
```

- **`--build <idOrVersion>`** — the build the results were run against, given as a build id or as the version the pipeline just deployed. Reading it the same way as `tc createTestPlan` (TCV-6788): a numeric value is looked up as an id first and retried as a version, so numeric versions and build numbers work too. A build is simply a record of a deployed version, so if the project has no build with that version yet, one is created from the version and `--environment`. An existing build is reused as-is, and `--environment` is ignored (with a warning) because the build already records its environment. If several builds share the version, the command stops and asks for an id rather than guessing, and an id belonging to another project stops the run rather than being recorded as a new version.
- **`--environment <name>`** — only meaningful alongside `--build`, and only used when the build is created.

`--build` requires `--auto-create`. A plan passed with `--test-plan-id` already exists and keeps whatever build it was given.

**Releases are never created.** The plan gets a release only when one of the project's releases has a version pattern that matches the build (e.g. pattern `2.14.*` matching build `2.14.9`); otherwise the plan has no release. A release is a planning decision someone makes in TestCollab, not something a pipeline should invent.

If the version is not resolved when the pipeline runs (an unset variable, so `--build ""`), the command fails rather than quietly uploading results with no build attached.

## Suite Name Humanization

Raw suite names from test runners are cleaned up before becoming TestCollab suite titles:

| Raw Name (from test runner) | Humanized Name (in TestCollab) |
|-----------------------------|-------------------------------|
| `com.foo.bar.LoginTests` | `Login` |
| `tests/auth/login.spec.ts` | `Login` |
| `UserProfileTests` | `User Profile` |
| `user_profile_spec` | `User Profile` |
| `my-component-test` | `My Component` |
| `LoginTests` | `Login` |
| *(empty)* | `Uncategorized` |

**Rules applied (in order):**
1. Strip Java-style package prefix (`com.foo.bar.` → keep last segment)
2. Strip file path prefix (everything before last `/` or `\`)
3. Strip test file extensions (`.spec.ts`, `.test.js`, etc.)
4. Strip common suffixes (`Tests`, `Test`, `Spec`, `Suite`)
5. Split camelCase, snake_case, and kebab-case into words
6. Title case each word

## Title Matching

When a test result has no TC ID, the command attempts to match it to an existing test case by title:

1. **Normalize** both titles: lowercase, trim, collapse whitespace
2. **Scope** the search to test cases in the same suite (reduces false positives)
3. **Exact match only** — no fuzzy matching to avoid wrong associations
4. If matched → reuse the existing test case
5. If not matched → create a new test case

**Example:** A result with title `Should login with valid credentials` will match a TestCollab test case titled `should login with valid credentials` (case-insensitive match within the same suite).

## Required Permissions

The API key used with `--auto-create` must have the following TestCollab permissions. These are typically available to users with the **Admin** or **Lead** role:

| Permission | Why Needed |
|------------|-----------|
| **Tag: Create** | To create the "CI Imported" tag |
| **Test Suite: Create** | To create suites for test organization |
| **Test Case: Create** | To create new test cases from result names |
| **Test Case: Edit** | To add the "CI Imported" tag to existing test cases |
| **Test Plan: Create** | To create the CI test plan |
| **Test Plan Folder: Create** | To create the "CI" folder |
| **Test Plan: Assign** | To assign test cases to the current user |
| **Build: View** | To find the build named by `--build` |
| **Build: Create** | To create the build when `--build` names a version that does not exist yet |
| **Project: Read** | Basic project access |

If any permission is missing, the command will fail with an error from the API. Check with your TestCollab admin to ensure your role has these permissions.

## CLI Reference

```
tc-cli report [options]

Options:
  --api-key <key>       TestCollab API key (or set TESTCOLLAB_TOKEN env var)
  --project <id>        TestCollab project ID (required)
  --test-plan-id <id>   Test Plan ID (required unless --auto-create)
  --format <type>       Result format: mochawesome or junit (required)
  --result-file <path>  Path to test result file (required)
  --api-url <url>       TestCollab API base URL (default: https://api.testcollab.io)
  --skip-missing        Mark unmatched plan cases as skipped (default: false)
  --auto-create         Auto-create all missing resources from result file
  --build <idOrVersion> Build the results were run against, by id or version
                        (requires --auto-create)
  --environment <name>  Environment recorded on the build when --build creates it
```

**Note:** `--test-plan-id` and `--auto-create` are mutually exclusive, and `--build` requires `--auto-create`.

## Examples

### Basic auto-create with JUnit

```bash
tc-cli report \
  --project 42 \
  --format junit \
  --result-file build/test-results/TEST-results.xml \
  --auto-create
```

### Auto-create with Mochawesome and custom API URL

```bash
tc-cli report \
  --project 42 \
  --format mochawesome \
  --result-file cypress/results/mochawesome.json \
  --auto-create \
  --api-url https://api.testcollab-dev.io
```

### CI pipeline (GitHub Actions)

```yaml
- name: Upload test results
  env:
    TESTCOLLAB_TOKEN: ${{ secrets.TESTCOLLAB_TOKEN }}
  run: |
    npx tc-cli report \
      --project 42 \
      --format junit \
      --result-file test-results.xml \
      --auto-create \
      --build ${{ github.sha }}
```

## Subsequent Runs

On subsequent runs with `--auto-create`:

- The **"CI Imported" tag** is reused (found by name)
- **Existing suites** are reused (matched by humanized title)
- **Existing test cases** are reused (matched by ID if present, or by normalized title within the same suite)
- An **existing build** with the same `--build` version is reused; a new version creates a new build
- A **new test plan** is created each time (`CI Run: {timestamp}`)
- New test cases (from new tests added to your codebase) are automatically created and included

## Limitations

- **Configurations come from the report, or not at all:** when the report's top-level test suites name a browser and a platform (Sauce Labs and other grid runners do), the auto-created plan gets one configuration per browser and each browser keeps its own result. Any other report still has no configurations, and all results go to the default one.
- **Title matching is exact:** Slight differences in test names (e.g., `"login test"` vs `"login tests"`) will result in duplicate test cases. Once created, add TC IDs to your test names for reliable matching.
- **One plan per run:** Each `--auto-create` invocation creates a new test plan. There is no "reuse last plan" option.
- **Suite nesting:** Auto-created suites are flat (parent_id: 0). Nested describe blocks or deep package hierarchies are collapsed to the innermost/last name.
