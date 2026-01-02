## TODO
- [x] Wire `specgen` command with structured-output feature generation.
- [x] Add AI-assisted discovery (cached to `.testcollab/specgen.json`).
- [x] Support Gemini/Claude provider selection and document key requirements.
- [x] Update `package-lock.json` after installing new deps (Gemini SDK).
- [ ] Smoke-test both providers with real keys; add tests for provider selection/discovery parsing/error handling.
- [ ] Expand CLI help with model examples and first-run vs cached behavior.

`specgen` crawls your source code and generates `.feature` files with ready-to-run scenarios.

## Terminology

- **Target family:** A domain bucket (e.g., QA Copilot, Billing, BDD) that groups related code paths and sets defaults like parsing strategy, priority, and output folder.

- **Target:** A concrete unit inside a family (e.g., `ChatPanel.tsx`, `qacconversationthread` API handler, `testplan` service). Each target has entry files, supporting context, and its own `.feature` output path.

### Attributes
- **Target family:** `name`, `kind` (backend/ui/cli/job), `paths` (globs), `priority`, `owner` (optional), `notes`/exclusions, `output_root` for the family.
- **Target:** `id`, `family`, `type` (api_controller/model/ui_component/job/cli_command), `entry` files, `context` (supporting code/docs/tests), `routes/events` or `states/flows`, `priority`, `confidence_flags` (e.g., low-context), `output_path` for the `.feature` file.

### JSON shapes
Target family
```json
{
  "name": "qa_copilot",
  "kind": "backend",
  "paths": ["api/qacopilot/**", "api/qacconversation*/**"],
  "priority": "high",
  "owner": "team-copilot",
  "notes": "skip legacy/v1 controllers",
  "output_root": "features/qa_copilot"
}
```

Target
```json
{
  "id": "qacconversationthread",
  "family": "qa_copilot",
  "type": "api_controller",
  "entry": ["api/qacconversationthread/controllers/qacconversationthread.js"],
  "context": ["api/qacconversationthread/services/**", "tests/qacconversationthread/**"],
  "routes": ["GET /qacconversationthreads", "POST /qacconversationthreads"],
  "priority": "core",
  "confidence_flags": ["low-context"],
  "output_path": "features/qa_copilot/qacconversationthread.feature"
}
```

## State/cache
- Discovered target families/targets and their output paths are cached in `.testcollab/specgen.json` at repo root. Commit it for reproducible runs, or add it to `.gitignore` if you prefer ephemeral caching.

## How to run it
Requires an AI key:
- Claude models (default): set `ANTHROPIC_API_KEY`.
- Gemini 3 models: set `GOOGLE_GENAI_API_KEY` (or `GEMINI_API_KEY`).

1) From your project root, run `tc specgen --src ./src --out ./features` (or `npx tc specgen ...` if installed locally). If you omit `--out`, it defaults to `./features`.  
2) Point `--src` at the codebase you want crawled; point `--out` at where you want the generated `.feature` files to land.  
3) Review the generated Gherkin, adjust wording/step names to match your domain language, then commit.

### Dev workspace example
From a workspace root with `tc-cli` installed locally:
```bash
cd tc-cli
ANTHROPIC_API_KEY=... node ./src/index.js specgen --src ../qac_widget/src --out ../qac_widget/features --cache ../qac_widget/.testcollab/specgen.json --model claude-opus-4-5-20251101
```
Swap `--model` to a Gemini model (e.g., `gemini-2.0-pro`) and set `GOOGLE_GENAI_API_KEY` instead if you prefer Gemini.

## Quality checks

- **Small codebase (20–30 project files):** Quick skim of every generated `.feature` file, remove obvious duplicates, tighten scenario names, and ensure steps mirror the real user flows.

- **Medium & large (30+ source files):** Generate per module/folder to control noise, spot-check high-traffic paths first, dedupe cross-module scenarios, and keep a short backlog of follow-up edits for any low-confidence sections marked by the generator.

    "@anthropic-ai/sdk": "^0.71.0",
    "@google/generative-ai": "^0.11.0",