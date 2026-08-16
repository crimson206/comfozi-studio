#!/usr/bin/env bash
# 스테이지 4 — 파싱 결과 + 훈련 모델을 검수 인박스(우리 데모 프론트 = comfozi.pages.dev)에 올려 실행.
# 브라우저에서: 데이터 소스 '파싱 결과' 토글 + plugin:gbm-score 켜면 comfozi.pages.dev 화면에 도달.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/work/parsed.json" ]; then
  cp "$ROOT/work/parsed.json" "$ROOT/apps/comfozi.app/public/parsed.json"
  echo "▶ work/parsed.json → app/public (인박스 상단 '파싱 결과' 소스로 확인)"
fi
cd "$ROOT/apps/comfozi.app"
echo "▶ 검수 인박스 실행 → http://localhost:5173/?plugins=gbm-score,diff-view,explain-card,triage-toolbar"
npm run dev -- --host 0.0.0.0
