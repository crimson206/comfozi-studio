#!/usr/bin/env bash
# 원클릭 셋업 — Codespace postCreate 에서 자동 실행되고, 로컬에서도 그대로 돌아간다.
# 전부 tokenless: @comfozi/* 는 public GitLab 레지스트리에서 glpkg 로 설치(토큰 불필요, scope 매핑만).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"

echo "▶ (1/5) submodules"
git submodule update --init --recursive

echo "▶ (2/5) uv (python 패키지/런타임)"
if ! command -v uv >/dev/null 2>&1; then curl -LsSf https://astral.sh/uv/install.sh | sh; fi
export PATH="$HOME/.local/bin:$PATH"

echo "▶ (3/5) glpkg + @comfozi scope 매핑 (tokenless public)"
npm i -g @glpkg/cli >/dev/null 2>&1 || sudo npm i -g @glpkg/cli
glpkg config scope:set @comfozi blaybus2026-vibe

echo "▶ (4/5) JS 의존 설치 + 빌드 (data-raw / parse-fleet / app)"
( cd apps/comfozi.data-raw    && rm -f package-lock.json glpkg.lock.json && glpkg install && npm run build )
( cd vendor/parse-fleet       && rm -f package-lock.json glpkg.lock.json && glpkg install )
( cd apps/comfozi.app         && rm -f package-lock.json glpkg.lock.json && glpkg install )

echo "▶ (5/5) python 의존 (approval-ml, GBM 훈련)"
( cd apps/comfozi.approval-ml && uv sync )

# glpkg 가 남긴 레지스트리 .npmrc 정리 — 설치 끝나면 불필요(런타임/파싱/훈련은 glpkg 미사용).
# 남겨두면 작업트리에 파일이 보이고, 재실행 시 "pre-existing .npmrc" 풋건 유발.
rm -f "$ROOT/.npmrc" apps/*/.npmrc vendor/*/.npmrc 2>/dev/null || true

echo ""
echo "✅ 셋업 완료. 다음 중 하나:"
echo "   make all              # 생성→파싱→훈련→인박스 한 번에"
echo "   또는 README 의 스텝을 하나씩 (make generate / parse / train / inbox)"
