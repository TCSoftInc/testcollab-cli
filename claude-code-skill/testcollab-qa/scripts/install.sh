#!/usr/bin/env bash
# Install the testcollab-qa skill into Claude Code (user-global).
# Works both ways:
#   curl -fsSL <raw-url>/install.sh | bash       # piped install (from anywhere)
#   bash install.sh                              # from a cloned repo

set -euo pipefail

SKILL_DIR="$HOME/.claude/skills/testcollab-qa"
TARGET="$SKILL_DIR/SKILL.md"
RAW_URL="https://raw.githubusercontent.com/TCSoftInc/testcollab-cli/main/claude-code-skill/testcollab-qa/SKILL.md"
LOCAL_FILE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || echo "")/SKILL.md"

echo "Installing testcollab-qa skill for Claude Code..."

mkdir -p "$SKILL_DIR"

# Prefer local file if running from a cloned repo; otherwise fetch from GitHub raw.
if [ -f "$LOCAL_FILE" ]; then
  cp "$LOCAL_FILE" "$TARGET"
else
  curl -fsSL "$RAW_URL" -o "$TARGET"
fi

echo "Skill installed to $TARGET"

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
echo "Done. cd into your app's project dir, run 'claude', then prompt naturally:"
echo "  Execute test plan <id> in project <id> against http://localhost:3000"
