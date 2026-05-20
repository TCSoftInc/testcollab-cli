#!/usr/bin/env bash
# Install the testcollab-qa /run-qa slash command into Claude Code (user-global).
# Works both ways:
#   curl -fsSL <raw-url>/install.sh | bash       # piped install (from anywhere)
#   bash install.sh                              # from a cloned repo

set -euo pipefail

COMMANDS_DIR="$HOME/.claude/commands"
TARGET="$COMMANDS_DIR/run-qa.md"
RAW_URL="https://raw.githubusercontent.com/TCSoftInc/testcollab-cli/main/claude-code-skill/testcollab-qa/run-qa.md"
LOCAL_FILE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || echo "")/run-qa.md"

echo "Installing /run-qa slash command for Claude Code..."

mkdir -p "$COMMANDS_DIR"

# Prefer local file if running from a cloned repo; otherwise fetch from GitHub raw.
if [ -f "$LOCAL_FILE" ]; then
  cp "$LOCAL_FILE" "$TARGET"
else
  curl -fsSL "$RAW_URL" -o "$TARGET"
fi

echo "Slash command installed to $TARGET"

if ! command -v claude &>/dev/null; then
  echo ""
  echo "Note: Claude Code is not installed. Install it from:"
  echo "  https://docs.anthropic.com/en/docs/claude-code"
fi

if ! command -v tc &>/dev/null; then
  echo ""
  echo "Note: @testcollab/cli is not installed. Install it:"
  echo "  npm install -g @testcollab/cli"
fi

if [ -z "${TESTCOLLAB_TOKEN:-}" ]; then
  echo ""
  echo "Note: TESTCOLLAB_TOKEN is not set. Add it to your shell profile:"
  echo "  echo 'export TESTCOLLAB_TOKEN=your-token-here' >> ~/.zshrc"
fi

echo ""
echo "Done. cd into your app's project dir, run 'claude', then:"
echo "  /run-qa --project <id> --test-plan-id <id> --url http://localhost:3000"
