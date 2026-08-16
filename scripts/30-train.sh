#!/usr/bin/env bash
# 스테이지 3 — GBM 훈련 + 브라우저 추론용 export(model.json). 로컬/CPU/서버리스.
#   인자 없음        내장 생성기 데이터로 훈련 (우리 data 생성기)
#   인자 <base>      본인 승인이력으로 훈련: <base>.input.csv (+ <base>.truth.csv 라벨)
#                    스키마: sample-data/approval-history.input.csv 참고
# 산출 모델은 apps/comfozi.app/public/gbm/ 로 자동 복사되어 gbm-score 플러그인이 추론에 사용.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"   # uv 가 로그인 셸 밖에서도 잡히도록(안전)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/apps/comfozi.approval-ml"
if [ -n "${1:-}" ]; then
  echo "▶ GBM 훈련 (본인 데이터: $1)"
  uv run export-gbm --input "$1"
else
  echo "▶ GBM 훈련 (생성기 데이터)"
  uv run export-gbm
fi
echo "✅ 모델 → apps/comfozi.app/public/gbm/  (첫 실행은 e5 임베딩 모델 다운로드로 수 분 소요될 수 있음)"
