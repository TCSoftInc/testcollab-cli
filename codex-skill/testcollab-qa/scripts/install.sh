#!/usr/bin/env bash
# Install the testcollab-qa skill into Codex CLI.
# Works both ways:
#   curl -fsSL <raw-url>/install.sh | bash       # piped install (from anywhere)
#   bash install.sh                              # from a cloned repo

set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SKILL_DIR="$CODEX_HOME/skills/testcollab-qa"
RAW_BASE="https://raw.githubusercontent.com/TCSoftInc/testcollab-cli/main/codex-skill/testcollab-qa"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || echo "")"

echo "Installing testcollab-qa skill for Codex CLI..."

if [ ! -d "$CODEX_HOME" ]; then
  echo "Error: Codex CLI not found at $CODEX_HOME. Install it first:"
  echo "  npm install -g @openai/codex"
  echo "  (or see https://github.com/openai/codex for the latest install instructions)"
  exit 1
fi

mkdir -p "$SKILL_DIR/scripts"

# Prefer local files if running from a cloned repo; otherwise fetch from GitHub raw.
if [ -n "$LOCAL_DIR" ] && [ -f "$LOCAL_DIR/SKILL.md" ]; then
  cp "$LOCAL_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
else
  curl -fsSL "$RAW_BASE/SKILL.md" -o "$SKILL_DIR/SKILL.md"
fi

echo "Skill installed to $SKILL_DIR"

if ! command -v codex &>/dev/null; then
  echo ""
  echo "Note: Codex CLI is not installed. Install it:"
  echo "  npm install -g @openai/codex"
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
echo "Done. Restart Codex to pick up the new skill, then say:"
echo "  Run the testcollab-qa skill — project <id>, test plan <id>, url http://localhost:3000"
