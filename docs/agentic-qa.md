# Agentic QA Guide

How to use the TestCollab CLI as building blocks for **agent-driven QA** — where humans curate test plans in TestCollab and an AI coding agent (Claude Code, Cursor, Codex, etc.) executes them against a running application using browser automation.

## Why this exists

Hand-written E2E suites are expensive to maintain. Manual QA is slow. Agents can now drive a real browser reliably — but they need a **structured plan** of what to test and a **structured way to report** what happened.

The CLI gives you both:

- [`tc getTestPlan`](../README.md#tc-gettestplan) — agent reads a curated plan as JSON
- [`tc reportCase`](../README.md#tc-reportcase) — agent reports each result immediately
- [`tc report`](../README.md#tc-report) — bulk import fallback for completed result files

Humans stay in control of *what* to test (in TestCollab's UI). Agents handle *executing* it.

## The loop

```
   ┌─────────────────────┐
   │ Human curates plan  │  ← in TestCollab UI (or via tc createTestPlan)
   └──────────┬──────────┘
              │
              ▼
   ┌─────────────────────┐
   │ tc getTestPlan      │  → JSON: test cases, steps, expected results
   └──────────┬──────────┘
              │
              ▼
   ┌─────────────────────┐
   │ Agent executes      │  → via Playwright MCP, computer use, etc.
   └──────────┬──────────┘
              │
              ▼
   ┌─────────────────────┐
   │ tc reportCase       │  → each result visible immediately in TestCollab
   └─────────────────────┘
```

Every step is scriptable, so the whole loop can run in CI on a schedule, on every deploy, or on demand from a chat tool.

## Building blocks

| Command | Role in the loop |
|---------|------------------|
| [`tc createTestPlan`](../README.md#tc-createtestplan) | Pre-create a plan in CI from a CI tag — useful when you want the agent to execute a fresh plan per build |
| [`tc getTestPlan`](../README.md#tc-gettestplan) | **The agent's input.** Returns the plan as agent-friendly JSON with stripped HTML, mapped statuses, and per-configuration breakdowns |
| [`tc reportCase`](../README.md#tc-reportcase) | **The agent's live output.** Report one exact execution, its evidence, and duration as soon as it finishes |
| [`tc report`](../README.md#tc-report) | Bulk-import a completed JUnit or Mochawesome file |
| [`tc sync`](../README.md#tc-sync) | Keep TestCollab in sync with `.feature` files committed in Git — close the loop if you maintain test cases as code |

## End-to-end example

A nightly cron that asks an agent to run regression tests against staging and post results to TestCollab.

### 1. Curate the plan (one-time, in TestCollab UI)

Create a test plan called "Nightly Regression" with the test cases you want covered. Note the plan ID — say it's `555`.

### 2. Fetch the plan for the agent

```bash
export TESTCOLLAB_TOKEN=$TC_TOKEN

tc getTestPlan \
  --project 16 \
  --test-plan-id 555 \
  --test-plan-run-id 88 \
  --output /tmp/plan.json
```

This produces JSON like:

```json
{
  "testPlan": { "id": 555, "title": "Nightly Regression", "totalCases": 12, ... },
  "testCases": [
    {
      "id": 42,
      "testPlanTestCaseId": 789,
      "title": "Regular user cannot access admin settings",
      "priority": "high",
      "suite": "Permissions",
      "steps": [
        { "step": "Log in as testuser@example.com", "expectedResult": "Dashboard is displayed" },
        { "step": "Navigate to /admin/settings", "expectedResult": "403 page is shown" }
      ]
    }
  ]
}
```

The output's `executions` array contains the exact execution ids assigned to the
authenticated Agent in run `88`, and `statuses` lists the active system and
custom status names it may report.

### 3. Have the agent execute and report the plan

Feed `/tmp/plan.json` to an agent with browser automation. After it finishes one
entry from `executions`, have it report that entry before moving on:

```bash
tc reportCase \
  --project 16 \
  --test-plan-run-id 88 \
  --executed-test-case-id 17922 \
  --status failed \
  --comment "Expected redirect to /admin but got 500" \
  --attachment /tmp/screenshots/admin-500.png
```

The result appears in TestCollab immediately. If the Agent crashes on a later
case, this result stays durable. `tc report` is still useful when a framework
already emits one completed result file, but it is not needed for this loop.

## Sample agent prompt

A starting prompt to feed an agent that has access to a browser automation tool. Adapt to your stack.

> You are a QA agent. Read the test plan at `/tmp/plan.json`. For each entry in `executions`:
>
> 1. Use the browser tool to perform the steps in order, starting from `https://staging.example.com`.
> 2. For each step, the `expectedResult` is what should be observable after the step is performed.
> 3. Determine pass/fail based on whether the final state matches the last step's `expectedResult`.
> 4. If you cannot perform a step (e.g. login fails before you can test admin access), mark the case as `skipped` with a reason.
>
> Immediately run `tc reportCase` with that entry's exact `id`, the plan run id,
> and an active status `systemName`. Include comments, time, and evidence files
> from this execution. If reporting fails, stop and exit non-zero.

A few things to call out in the prompt:

- The `executions[].id` value is the executed-test-case id. Do not substitute the test case id or test-plan-test-case id.
- Tell the agent explicitly **what counts as pass vs. fail**. Agents will rationalize ambiguous outcomes if you don't define them.
- Give the agent a clear environment (URL, credentials, what's seeded) so test cases don't depend on hidden setup.

## Multi-configuration test plans

If your TestCollab plan uses configurations (e.g. Browser × OS, or Free Plan × Paid Plan), each test case in the JSON includes a `configResults` array:

```json
{
  "id": 42,
  "title": "Checkout flow completes",
  "configResults": [
    { "configId": 1, "configLabel": "Browser: Chrome, OS: macOS", "status": "unexecuted" },
    { "configId": 2, "configLabel": "Browser: Safari, OS: macOS", "status": "unexecuted" },
    { "configId": 3, "configLabel": "Browser: Firefox, OS: Windows", "status": "unexecuted" }
  ]
}
```

To run the same test against each configuration:

- Loop the agent over `configResults` per test case
- Set up the matching environment (launch the right browser, switch the plan, etc.)
- Report each configuration's own `executions[].id`; no title convention is needed for `tc reportCase`.

## Keeping BDD specs in sync

If you maintain test cases as `.feature` files in Git, [`tc sync`](../README.md#tc-sync) keeps TestCollab updated on every push:

```bash
tc sync --project 16
```

This makes the agentic loop fully Git-driven: edits to `.feature` files flow to TestCollab → next agent run picks them up via `tc getTestPlan`.

## Tips

- **Pick the right plan size.** Agents handle 10-30 test cases per run reliably. Larger plans risk context drift; split into multiple plans by suite.
- **Make expected results concrete.** "User sees dashboard" is ambiguous. "URL is `/dashboard` and an element with text 'Welcome' is visible" is testable.
- **Pin a seed user / data.** Tests that depend on "whatever's in staging" go flaky fast. Use a fixture user with known state.
- **Capture artifacts.** Have the agent save screenshots or DOM snapshots on failure — agents tend to lose nuance describing UI bugs in prose.
- **Re-run flakes manually.** Agents will sometimes mis-classify a slow page load as a failure. Don't bake retries into the agent loop; let humans review.

## What this isn't

- **A replacement for unit tests.** This loop is for browser-driven E2E and high-level acceptance tests, not function-level coverage.
- **Deterministic.** Agent runs vary. Use it for regression confidence and bug discovery, not as a release gate without human review.
- **Free.** Each run consumes agent inference time. Budget accordingly when scheduling.

## Related

- [`tc getTestPlan` reference](../README.md#tc-gettestplan)
- [`tc reportCase` reference](../README.md#tc-reportcase)
- [`tc report` reference](../README.md#tc-report)
- [Framework setup for `tc report`](frameworks.md)
