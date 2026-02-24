#!/usr/bin/env bash
# OpSpawn × CRE — Full E2E Demo
# Usage: ./scripts/demo.sh [PAYER_PRIVATE_KEY]
#
# Runs the complete 8-step demo:
#   1. Install dependencies (if needed)
#   2. Build TypeScript
#   3. Run E2E demo: discover → pay → invoke → reject
#
# Optional: pass a Base Sepolia private key to enable real EIP-712 signing:
#   ./scripts/demo.sh 0x<your-private-key>
#   PAYER_PRIVATE_KEY=0x<key> ./scripts/demo.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Use first arg as private key if provided
if [ -n "$1" ]; then
  export PAYER_PRIVATE_KEY="$1"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║      OpSpawn × CRE — x402 Payment Gateway Demo              ║"
echo "║      Chainlink Convergence Hackathon                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Install dependencies if node_modules missing
if [ ! -d "node_modules" ]; then
  echo "→ Installing dependencies..."
  npm install
  echo ""
fi

# Build TypeScript
echo "→ Building TypeScript..."
npm run build
echo ""

# Run the demo
echo "→ Starting E2E demo..."
echo ""
node dist/demo/run-demo.js
