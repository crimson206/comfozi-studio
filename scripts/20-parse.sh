#!/usr/bin/env bash
# 스테이지 2 — 파싱. 결정적 파서 우선, 이미지/저신뢰는 AI 폴백(로컬 isesh 세션).
#   mode=deterministic  오프라인·세션 불필요(기본, Codespace 심사용 권장)
#   mode=ai / auto       이미지까지 AI 파싱 — 본인 Claude 세션(isesh) 필요, 전부 로컬
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-deterministic}"; SRC="${2:-$ROOT/work/raw}"
mkdir -p "$ROOT/work"
echo "▶ 파싱: $SRC (mode=$MODE) → work/parsed.json"
node "$ROOT/vendor/parse-fleet/dist/cli.js" parse "$SRC" --mode "$MODE" --out "$ROOT/work/parsed.json" --pretty
echo "✅ work/parsed.json"
