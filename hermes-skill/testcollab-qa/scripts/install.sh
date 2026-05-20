#!/usr/bin/env bash
# Install the testcollab-qa skill into Hermes Agent
# Usage: bash install.sh

set -euo pipefail

SKILL_DIR="$HOME/.hermes/skills/software-development/testcollab-qa"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Installing testcollab-qa skill for Hermes Agent..."

if [ ! -d "$HOME/.hermes" ]; then
  echo "Error: Hermes Agent not found. Install it first:"
  echo "  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
  exit 1
fi

mkdir -p "$SKILL_DIR"
cp "$SCRIPT_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"

echo "Skill installed to $SKILL_DIR"

if ! command -v tc &>/dev/null; then
  echo ""
  echo "Note: @testcollab/cli is not installed. Install it:"
  echo "  npm install -g @testcollab/cli"
fi

if [ -z "${TESTCOLLAB_TOKEN:-}" ]; then
  echo ""
  echo "Note: TESTCOLLAB_TOKEN is not set. Add it to ~/.hermes/.env:"
  echo "  echo 'TESTCOLLAB_TOKEN=your-token-here' >> ~/.hermes/.env"
fi

echo ""
echo "Done. Start Hermes and say: 'Run the test plan for project X, plan Y against http://localhost:3000'"
