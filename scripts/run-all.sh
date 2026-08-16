#!/usr/bin/env bash
# 전체 파이프라인 한 번에: 생성 → 파싱 → 훈련 → 인박스.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$ROOT/scripts/10-generate.sh" "${1:-7}" "${2:-24}"
bash "$ROOT/scripts/20-parse.sh" "${MODE:-deterministic}"
bash "$ROOT/scripts/30-train.sh" "${INPUT:-}"
bash "$ROOT/scripts/40-inbox.sh"
