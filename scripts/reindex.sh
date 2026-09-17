#!/usr/bin/env bash
# Rebuild the context index from the fleet's markdown (docs/CONTEXT.md).
# The runner keeps the index fresh around every run; this is for hand-edits
# to shared files and for a cold start. --force re-reads unchanged files.
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"
exec npm run --silent context -- reindex "$@"
