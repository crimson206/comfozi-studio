#!/usr/bin/env bash
# 스테이지 1 — 원본(파싱 前) 증빙 문서 생성. 12형식(csv…pdf-image…photo) × 난이도(clean/noisy/hard).
# 본인 문서로 하려면 이 단계를 건너뛰고 work/raw/ 에 직접 파일을 넣으면 된다.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED="${1:-7}"; COUNT="${2:-24}"; OUT="$ROOT/work/raw"
mkdir -p "$OUT"
echo "▶ 원본 문서 생성: seed=$SEED count=$COUNT → work/raw"
( cd "$ROOT/apps/comfozi.data-raw" && npm run fixtures -- "$SEED" "$COUNT" "$OUT" )
echo "✅ work/raw ($(ls "$OUT" | grep -v manifest.json | wc -l) docs)  ·  본인 문서를 쓰려면 work/raw 에 넣고 스테이지 2로."
