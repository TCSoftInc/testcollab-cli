# Hermes Agent Integration

Use [Hermes Agent](https://github.com/NousResearch/hermes-agent) as an on-demand QA agent that executes TestCollab test plans against a running web app via browser automation.

## How it works

```
Human curates test plan (TestCollab UI)
         │
         ▼
tc getTestPlan → JSON with steps + expected results
         │
         ▼
Hermes Agent → drives browser, verifies each step
         │
         ▼
tc report → results uploaded to TestCollab
```

Humans decide **what** to test. Hermes handles **executing** it.

## Setup

### 1. Install Hermes Agent

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
hermes setup  # configure LLM provider
```

### 2. Install TestCollab CLI

```bash
npm install -g @testcollab/cli
```

### 3. Set your TestCollab API token

Get a token from TestCollab → Account Settings → API Tokens:

```bash
export TESTCOLLAB_TOKEN=your-token-here

# Or add to Hermes env for persistent access:
echo "TESTCOLLAB_TOKEN=your-token-here" >> ~/.hermes/.env
```

### 4. Install the TestCollab QA skill

From this repo:

```bash
bash hermes-skill/testcollab-qa/scripts/install.sh
```

This copies the skill to `~/.hermes/skills/software-development/testcollab-qa/`.

## Usage

### Interactive (chat with Hermes)

Start Hermes and ask it to run a test plan:

```bash
hermes
```

Then in the chat:

> Run the TestCollab test plan. Project ID is 16, test plan ID is 555.
> The app is running at http://localhost:3000.
> Login with user@example.com / password123.

Hermes will:
1. Fetch the test plan via `tc getTestPlan`
2. Open a browser and navigate to the app
3. Execute each test case step-by-step
4. Generate a JUnit XML result file
5. Upload results via `tc report`

### Scripted (one-shot)

Use the provided run script for CI or automation:

```bash
bash hermes-skill/testcollab-qa/scripts/run-qa.sh \
  --project 16 \
  --test-plan-id 555 \
  --url http://localhost:3000
```

### Non-interactive (Hermes prompt mode)

```bash
hermes --prompt "Execute the TestCollab test plan for project 16, plan 555 \
  against http://localhost:3000. Login: user@example.com / pass123. \
  Follow the testcollab-qa skill. Write results to /tmp/results.xml."
```

Then upload results:

```bash
tc report --project 16 --test-plan-id 555 --format junit --result-file /tmp/results.xml
```

## What Hermes does during execution

For each test case in the plan:

| Test step | Hermes action |
|-----------|---------------|
| "Navigate to /settings" | `browser_navigate` to the URL |
| "Click the Save button" | `browser_snapshot` → find element → `browser_click` |
| "Enter 'test@example.com'" | `browser_snapshot` → find input → `browser_type` |
| "Verify success message" | `browser_snapshot` → check accessibility tree for text |

Hermes uses accessibility trees (text-based page structure with reference IDs) rather than CSS selectors, making it resilient to UI changes.

## Result mapping

Results are mapped back to TestCollab test cases using the `[TC-ID]` convention in JUnit output:

```xml
<testcase classname="Login" name="[TC-42] User can log in with valid credentials"/>
<testcase classname="Login" name="[TC-43] Invalid password shows error">
  <failure message="Expected error message not found">
    Step: Enter wrong password. Expected: Error banner visible. Actual: Page reloaded without error.
  </failure>
</testcase>
```

## Tips

- **Keep test plans small.** 10-30 cases per plan works best. Larger plans risk context drift in the agent.
- **Write concrete expected results.** "Page loads correctly" is ambiguous. "URL changes to /dashboard and 'Welcome' heading is visible" is testable.
- **Provide credentials upfront.** Tell Hermes the login credentials in your prompt so it doesn't get stuck at authentication.
- **Use staging, not production.** Agent-driven testing can modify data. Point at a staging or local environment.

## Related

- [Agentic QA Guide](agentic-qa.md) — general agent-driven QA patterns (not Hermes-specific)
- [tc getTestPlan reference](../README.md#tc-gettestplan)
- [tc report reference](../README.md#tc-report)
