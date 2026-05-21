#!/usr/bin/env bash
# Install the testcollab-qa skill into Hermes Agent.
# Works both ways:
#   curl -fsSL <raw-url>/install.sh | bash       # piped install (from anywhere)
#   bash install.sh                              # from a cloned repo

set -euo pipefail

SKILL_DIR="$HOME/.hermes/skills/software-development/testcollab-qa"
RAW_BASE="https://raw.githubusercontent.com/TCSoftInc/testcollab-cli/main/hermes-skill/testcollab-qa"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || echo "")"

echo "Installing testcollab-qa skill for Hermes Agent..."

if [ ! -d "$HOME/.hermes" ]; then
  echo "Error: Hermes Agent not found. Install it first:"
  echo "  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
  exit 1
fi

mkdir -p "$SKILL_DIR"

# If the SKILL.md is next to us locally (cloned repo), copy from disk.
# Otherwise, fetch from GitHub raw (piped install case).
if [ -n "$LOCAL_DIR" ] && [ -f "$LOCAL_DIR/SKILL.md" ]; then
  cp "$LOCAL_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
else
  curl -fsSL "$RAW_BASE/SKILL.md" -o "$SKILL_DIR/SKILL.md"
fi

echo "Skill installed to $SKILL_DIR"

if ! command -v tc &>/dev/null; then
  echo ""
  echo "Note: @testcollab/cli is not installed. Install it:"
  echo "  npm install -g @testcollab/cli"
fi

if [ -z "${TESTCOLLAB_TOKEN:-}" ] && [ ! -f "$HOME/.hermes/.env" ]; then
  echo ""
  echo "Note: TESTCOLLAB_TOKEN is not set. Add it to ~/.hermes/.env:"
  echo "  echo 'TESTCOLLAB_TOKEN=your-token-here' >> ~/.hermes/.env"
fi

echo ""
echo "Done. cd into your app's project dir, run 'hermes', then prompt naturally:"
echo "  Execute test plan <id> in project <id> against http://localhost:3000"
