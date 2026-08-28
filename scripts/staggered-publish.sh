#!/bin/bash
#
# Staggered Publish Script for the browsermesh Monorepo
#
# Publishes all 10 packages to npm in dependency order with delays
# to avoid rate limiting. No build step — every package ships plain ESM
# source directly (main/exports point at src/index.mjs).
#
# Usage:
#   ./scripts/staggered-publish.sh           # Full publish
#   ./scripts/staggered-publish.sh --dry-run # Dry run (no actual publish)
#
# Configuration:
#   DELAY_BETWEEN_PACKAGES - seconds between each package (default: 5)
#   DELAY_BETWEEN_BATCHES  - seconds between batches (default: 30)
#

set -e

DELAY_BETWEEN_PACKAGES=${DELAY_BETWEEN_PACKAGES:-5}
DELAY_BETWEEN_BATCHES=${DELAY_BETWEEN_BATCHES:-30}
DRY_RUN=false

if [[ "$1" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "DRY RUN MODE - No packages will be published"
  echo ""
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

TOTAL=0
SUCCESS=0
SKIPPED=0
FAILED=0
FAILED_PACKAGES=()

publish_package() {
  local pkg=$1
  TOTAL=$((TOTAL + 1))

  echo -e "${BLUE}[$TOTAL/10]${NC} Publishing ${YELLOW}$pkg${NC}..."

  if $DRY_RUN; then
    echo "  -> Would run: npm publish --workspace=$pkg --access public"
    SUCCESS=$((SUCCESS + 1))
  else
    local output
    if output=$(npm publish --workspace="$pkg" --access public 2>&1); then
      echo "$output"
      echo -e "  ${GREEN}Published successfully${NC}"
      SUCCESS=$((SUCCESS + 1))
    elif echo "$output" | grep -q "cannot publish over the previously published"; then
      echo -e "  ${YELLOW}Skipped (version already published)${NC}"
      SKIPPED=$((SKIPPED + 1))
    else
      echo "$output"
      echo -e "  ${RED}Failed to publish${NC}"
      FAILED=$((FAILED + 1))
      FAILED_PACKAGES+=("$pkg")
    fi
  fi
}

wait_between() {
  local seconds=$1
  if ! $DRY_RUN && [ "$seconds" -gt 0 ]; then
    echo -e "  ${BLUE}Waiting ${seconds}s...${NC}"
    sleep "$seconds"
  fi
}

publish_batch() {
  local batch_name=$1
  shift
  local packages=("$@")

  echo ""
  echo -e "${GREEN}================================================${NC}"
  echo -e "${GREEN}  Batch: $batch_name${NC}"
  echo -e "${GREEN}================================================${NC}"
  echo ""

  for pkg in "${packages[@]}"; do
    publish_package "$pkg"
    wait_between "$DELAY_BETWEEN_PACKAGES"
  done
}

echo ""
echo "browsermesh Staggered Publish Script"
echo "Publishing 10 packages in dependency order"

if [ ! -f "package.json" ]; then
  echo -e "${RED}Error: Must run from repository root${NC}"
  exit 1
fi

# ============================================================================
# BATCH 1: No internal dependencies
# ============================================================================
publish_batch "Foundations (no internal deps)" \
  "@johnhenry/browsermesh-primitives" \
  "@johnhenry/browsermesh-netway" \
  "@johnhenry/browsermesh-kernel"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 2: Depend only on browsermesh-primitives
# ============================================================================
publish_batch "Primitives Consumers" \
  "@johnhenry/browsermesh-core" \
  "@johnhenry/browsermesh-transport" \
  "@johnhenry/browsermesh-sync" \
  "@johnhenry/browsermesh-discovery" \
  "@johnhenry/browsermesh-pod"

wait_between "$DELAY_BETWEEN_BATCHES"

# ============================================================================
# BATCH 3: Depend on batch 2 packages
# ============================================================================
publish_batch "Runtime & Embed" \
  "@johnhenry/browsermesh-apps" \
  "@johnhenry/browsermesh-embed"

echo ""
echo "PUBLISH COMPLETE"
echo -e "  Total packages: ${BLUE}$TOTAL${NC}"
echo -e "  Successful:     ${GREEN}$SUCCESS${NC}"
echo -e "  Skipped:        ${YELLOW}$SKIPPED${NC} (already published)"
echo -e "  Failed:         ${RED}$FAILED${NC}"

if [ ${#FAILED_PACKAGES[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}Failed packages:${NC}"
  for pkg in "${FAILED_PACKAGES[@]}"; do
    echo -e "  - $pkg"
  done
  exit 1
fi

echo ""
echo -e "${GREEN}All packages published successfully!${NC}"
