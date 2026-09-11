# TestCollab as a quality gate in Azure DevOps pipelines

Use a TestCollab **Test Plan** as a quality gate in an Azure DevOps YAML pipeline: a
build (or a deployment) passes or fails based on the plan's results. The minimum
gate is *a failing test case*; you can also gate on blocked cases, a maximum
failure count, a minimum pass rate, or full execution.

This is done with the `tc gate` command from [`@testcollab/cli`](../README.md), so
the exact same gate works unchanged in Jenkins, GitLab CI, GitHub Actions, or an
**Ansible Tower** job — anything that can run a shell command and read an exit code.

## How it works

1. `tc createTestPlan` creates a Test Plan from your CI-tagged cases and prints its
   **ID** (also written to `tmp/tc_test_plan`). Run it once, or fresh on every
   pipeline run — see [Create the Test Plan](#create-the-test-plan-one-command).
2. Your pipeline runs automated tests and produces a JUnit/xUnit (or Mochawesome)
   result file.
3. `tc report` pushes those results into that Test Plan.
4. `tc gate` reads the plan's **latest run** results via the REST API and exits:
   - `0` — gate passed (the pipeline step succeeds),
   - `1` — gate failed (Azure DevOps fails the step automatically),
   - `2` — usage/API error (bad token, plan not found, plan never run, …).

`tc gate` computes the result counts **live** from the run's executed test cases, so
it is correct immediately after the `tc report` step in the same pipeline (it does
not depend on any cached summary).

## Prerequisites

- A TestCollab **API token** — TestCollab → Account Settings → API Tokens. Store it
  as a **secret** pipeline variable (a variable group or Azure Key Vault), exposed to
  the gate step as the `TESTCOLLAB_TOKEN` environment variable.
- The **project ID** to work in.
- To create the plan from the pipeline: a **CI tag ID** (tag the cases you want in the
  plan) and an **assignee user ID**. If you instead gate an existing plan, you only
  need its **Test Plan ID**.
- Node.js available on the agent (`NodeTool@0`) to run the CLI.

## Create the Test Plan (one command)

`tc createTestPlan` creates a plan, fills it with the test cases carrying your CI tag,
assigns it, and prints the new **Test Plan ID**. It also writes the ID to
`tmp/tc_test_plan` in `KEY=VALUE` form, so a pipeline can read it back without parsing
stdout:

```bash
tc createTestPlan --project 45 --ci-tag-id 88 --assignee-id 12
#  → Test Plan ID: 123
#  → writes tmp/tc_test_plan   (contents: TESTCOLLAB_TEST_PLAN_ID=123)
```

Creating the plan also starts its **first run**, so `tc report` and `tc gate` can act
on it right away. Two ways to use it:

- **Fresh plan per pipeline run** (self-contained, one plan per build) — call
  `createTestPlan` in the pipeline and pass the captured ID to `report`/`gate`, as in
  Pattern A below.
- **One long-lived plan** — run `createTestPlan` once, then store the printed ID as a
  pipeline variable / `TC_PLAN` and reuse it across builds.

The plan is titled `CI Test: <date>`; edit `createTestPlan` args or the plan in the UI
if you need a different title or case selection.

## Pattern A — create the plan, run tests, report, and gate

One self-contained run: create the plan, capture its ID, run the tests, report them,
and gate on the result.

```yaml
trigger:
  branches: { include: [main] }

pool:
  vmImage: ubuntu-latest

variables:
  - group: testcollab        # holds TESTCOLLAB_TOKEN (secret)
  - name: TC_PROJECT
    value: '45'
  - name: TC_TAG
    value: '88'              # CI tag — which cases go into the plan
  - name: TC_ASSIGNEE
    value: '12'              # user the plan is assigned to

steps:
  - task: NodeTool@0
    inputs: { versionSpec: '22.x' }

  - script: npm install -g @testcollab/cli && npm ci
    displayName: Install CLI & deps

  # Create the plan and expose its ID to later steps as $(TC_PLAN).
  # createTestPlan writes tmp/tc_test_plan (TESTCOLLAB_TEST_PLAN_ID=<id>) on success.
  - script: |
      set -e
      tc createTestPlan --project $(TC_PROJECT) --ci-tag-id $(TC_TAG) --assignee-id $(TC_ASSIGNEE)
      source tmp/tc_test_plan
      echo "##vso[task.setvariable variable=TC_PLAN]$TESTCOLLAB_TEST_PLAN_ID"
    displayName: Create TestCollab test plan
    env: { TESTCOLLAB_TOKEN: $(TESTCOLLAB_TOKEN) }

  - script: npx playwright test --reporter=junit
    displayName: Run tests

  - script: >
      tc report --project $(TC_PROJECT) --test-plan-id $(TC_PLAN)
      --format junit --result-file results.xml
    displayName: Report results to TestCollab
    env: { TESTCOLLAB_TOKEN: $(TESTCOLLAB_TOKEN) }

  - script: >
      tc gate --project $(TC_PROJECT) --test-plan-id $(TC_PLAN)
      --fail-on failed --require-complete
    displayName: TestCollab quality gate
    env: { TESTCOLLAB_TOKEN: $(TESTCOLLAB_TOKEN) }
```

> Already have a plan? Skip the create step, drop the `TC_TAG`/`TC_ASSIGNEE` variables,
> and set `TC_PLAN` to the existing Test Plan ID.

## Pattern B — gate a deployment (hold the release until QA is green)

When the plan is executed by people (or by a separate job), have the gate **wait**
until the run is complete before evaluating. Put this step in the pipeline that
deploys — it blocks the deploy until the plan has no unexecuted cases and passes.

```yaml
  - script: >
      tc gate --project $(TC_PROJECT) --test-plan-id $(TC_PLAN)
      --fail-on failed --require-complete --wait 1800 --poll-interval 30
    displayName: Wait for QA sign-off (TestCollab)
    env: { TESTCOLLAB_TOKEN: $(TESTCOLLAB_TOKEN) }
```

`--wait 1800` polls for up to 30 minutes; when the run finishes (no unexecuted cases)
the gate evaluates and passes/fails the deployment.

## Gate criteria

| Flag | Default | Meaning |
|------|---------|---------|
| `--fail-on <statuses>` | `failed` | Comma-separated statuses that fail the gate — e.g. `failed,blocked`. User-defined project statuses are supported. |
| `--max-failed <n>` | `0` | Tolerate up to N cases in the `--fail-on` statuses before failing. |
| `--min-pass-rate <pct>` | — | Fail if the pass rate is below this percent. Pass rate = `passed / executed`, where `executed = total − unexecuted`. Pair with `--require-complete` to avoid a high rate on a partially-run plan. |
| `--require-complete` | off | Fail if any case in the run is still unexecuted. |
| `--config <id>` | — | Evaluate a single Test Plan configuration instead of the whole plan. |
| `--regression <id>` | latest | Evaluate a specific run/regression instead of the latest. |
| `--wait <seconds>` | `0` | Poll until the run has no unexecuted cases, up to this many seconds. |
| `--poll-interval <seconds>` | `15` | Seconds between polls when `--wait` is set. |

Examples:

```bash
# Minimum gate — any failing case fails the build
tc gate --project 45 --test-plan-id 123 --fail-on failed

# Fail on failed OR blocked, but tolerate up to 2 such cases
tc gate --project 45 --test-plan-id 123 --fail-on failed,blocked --max-failed 2

# Require the whole plan to be run and at least 95% passing
tc gate --project 45 --test-plan-id 123 --require-complete --min-pass-rate 95

# Gate a single configuration (e.g. "Chrome / Windows")
tc gate --project 45 --test-plan-id 123 --config 9
```

## Ansible Tower

Because the gate is a plain command with a meaningful exit code, the same step works
in an Ansible playbook run by Ansible Tower / AWX — a non-zero exit fails the task:

```yaml
- name: TestCollab quality gate
  hosts: localhost
  gather_facts: false
  environment:
    TESTCOLLAB_TOKEN: "{{ testcollab_token }}"   # from a Tower credential / vault
  tasks:
    - name: Install the TestCollab CLI
      community.general.npm:
        name: "@testcollab/cli"
        global: true

    - name: Gate on the TestCollab test plan
      ansible.builtin.command: >
        tc gate --project 45 --test-plan-id 123
        --fail-on failed --require-complete
      changed_when: false
```

## EU region

If your account is hosted in the EU, add `--api-url https://api-eu.testcollab.io` to
the `tc report` and `tc gate` commands, or set the `TESTCOLLAB_API_URL` environment
variable once for the pipeline.
