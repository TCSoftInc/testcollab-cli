# Agentic QA Testing

Use AI agents to execute TestCollab test plans against a running web app via browser automation. This guide covers [Hermes Agent](https://github.com/NousResearch/hermes-agent), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), and [Codex](https://openai.com/index/codex/).

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

### Scripted

Use the provided runner for CI or automation. It detects the installed Hermes
CLI and uses `--oneshot` for newer versions or `--prompt` for older versions.

```bash
bash hermes-skill/testcollab-qa/scripts/run-qa.sh \
  --project 16 \
  --test-plan-id 555 \
  --url http://localhost:3000
```

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

### Non-interactive (one-shot)

For CI or automation, pass the prompt inline. Hermes auto-loads the installed `testcollab-qa` skill from its description:

```bash
hermes -z "Execute the TestCollab test plan for project 16, plan 555 \
  against http://localhost:3000. Login: user@example.com / pass123." \
  --accept-hooks
```

`hermes chat -q "..."` works the same way if you prefer the subcommand form.

Older Hermes versions may use `--prompt` instead of `--oneshot` / `-z`. The
provided `run-qa.sh` script checks the installed Hermes CLI and selects the
supported option automatically.

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

## Claude Code

Claude Code has built-in browser automation via `playwright-cli`. Install the TestCollab QA skill into Claude Code's user-global skills directory once:

```bash
bash claude-code-skill/testcollab-qa/scripts/install.sh
```

This copies `SKILL.md` to `~/.claude/skills/testcollab-qa/`.

### Run with Claude Code

From your app's project directory (**not** `testcollab-cli`):

```bash
cd ~/your-app
claude
```

Then prompt naturally:

```
Execute test plan 555 in project 16 against http://localhost:3000.
Login: user@example.com / pass123.
```

Claude Code matches the prompt to the `testcollab-qa` skill via its description and orchestrates `tc getTestPlan`, `playwright-cli`, JUnit XML generation, and `tc report` upload.

For CI: `claude -p "Execute test plan 555 in project 16 against http://staging.example.com. Login: ..."`

## Codex

Codex has full shell access and a skill system, so it can drive a browser the same way. Install the skill:

```bash
bash codex-skill/testcollab-qa/scripts/install.sh
```

This copies `SKILL.md` to `~/.codex/skills/testcollab-qa/`. Restart Codex to pick it up.

### Run with Codex

```bash
cd ~/your-app
codex
```

Then prompt naturally, same as the other two agents. For CI: `codex exec "Execute test plan 555 in project 16 against http://staging.example.com. ..."`

**Sandbox note:** Codex's default sandbox blocks new listening sockets, which `playwright-cli` needs to launch a browser. Run with `--full-auto` (or the equivalent escalation flag for your Codex version) so the browser process can start.

## Related

- [Agentic QA Guide](agentic-qa.md) — general agent-driven QA patterns
- [tc getTestPlan reference](../README.md#tc-gettestplan)
- [tc report reference](../README.md#tc-report)
