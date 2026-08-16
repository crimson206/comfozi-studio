# comfozi-studio — raw문서 파싱 → GBM 훈련 → 검수 인박스까지 직접 밟아보는 파이프라인.
# 값: SEED/COUNT(생성), MODE(파싱: deterministic|ai|auto), INPUT(본인 승인이력 base 경로)
SEED  ?= 7
COUNT ?= 24
MODE  ?= deterministic
SESSIONS ?= 4
INPUT ?=

.PHONY: setup generate parse train inbox all clean help

help:
	@echo "make setup     # 의존 설치(=Codespace postCreate 자동)"
	@echo "make generate  # 스테이지1 원본 문서 생성 (SEED=.. COUNT=..) / 또는 work/raw 에 본인 문서"
	@echo "make parse     # 스테이지2 파싱 (MODE=deterministic|ai|auto)"
	@echo "make train     # 스테이지3 GBM 훈련 (INPUT=sample-data/approval-history 로 본인 데이터)"
	@echo "make inbox     # 스테이지4 검수 인박스 실행 (= comfozi.pages.dev 화면)"
	@echo "make all       # 1→2→3→4 한 번에"

setup:
	bash scripts/setup.sh

generate:
	bash scripts/10-generate.sh $(SEED) $(COUNT)

parse:
	SESSIONS=$(SESSIONS) bash scripts/20-parse.sh $(MODE)

train:
	bash scripts/30-train.sh $(INPUT)

inbox:
	bash scripts/40-inbox.sh

all:
	MODE=$(MODE) INPUT=$(INPUT) bash scripts/run-all.sh $(SEED) $(COUNT)

clean:
	rm -rf work/* apps/comfozi.app/public/parsed.json
