# comfozi-studio

**comfozi를 처음부터 끝까지 직접 밟아보는 체험.**
`comfozi.pages.dev`(완성본)를, 여기서는 **raw 증빙 문서 → 파싱 → GBM 훈련 → 검수 인박스**까지 본인 손으로 돌려서, 마지막에 그 데모와 똑같은 화면에 **본인 데이터·본인 모델**로 도달합니다. 전부 로컬/컨테이너, 서버 0.

> 아래는 **전부 실제 명령**입니다(래퍼 없음). Codespace 터미널(또는 로컬)에서 **repo 루트**에서 그대로 치세요.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/crimson206/comfozi-studio)

---

## 1. 준비 (1회)

**기본 의존** — repo 루트에서 아래를 순서대로. 각 도구가 무엇인지 그대로 드러냅니다:
```bash
# ① 서브모듈(앱 3개 가져오기)
git submodule update --init --recursive
# ② uv — Python 런타임/패키지 매니저 (GBM 훈련용)
curl -LsSf https://astral.sh/uv/install.sh | sh
# ③ glpkg — tokenless 패키지 매니저 + @comfozi scope 매핑
npm i -g @glpkg/cli
glpkg config scope:set @comfozi blaybus2026-vibe
# ④ 앱 의존/빌드 + 파싱 CLI(node_modules)
( cd apps/comfozi.data-raw && glpkg install && npm run build )
glpkg install @comfozi/parse-fleet@^0.1.1 --source gitlab
( cd apps/comfozi.app && glpkg install )
# ⑤ GBM 훈련 환경
( cd apps/comfozi.approval-ml && uv sync )
```
> 위 ①~⑤를 한 번에: `bash scripts/setup.sh` (Codespaces는 `postCreate`로 자동 실행).
> 로컬 PC면 추가로 **Node 20 · Python 3.11 · [uv](https://docs.astral.sh/uv/) · 한글폰트**(`fonts-nanum fonts-noto-cjk`) 필요 — Codespace는 devcontainer가 자동.

**AI 파싱(이미지·스캔)까지 쓰려면** 추가로:
```bash
sudo apt-get install -y tmux                          # mac: brew install tmux
npm i -g @anthropic-ai/claude-code && claude login    # Claude Code + 로그인
npm i -g @microwiseai/snapshot && snapshot install @ist/beta   # isesh·imessenger·skit  (detector-agent ✗ 뜨면 무시)
skit install @comfozi/parse-fleet@0.1.1               # 파서 프로필/프롬프트 → ~/.ist/
```

---

## 2. 파이프라인 (실제 명령)

### ① 원본 증빙 문서 생성 → `work/raw/`
```bash
( cd apps/comfozi.data-raw && npm run fixtures -- 7 24 "$OLDPWD/work/raw" )
```
12형식(csv·xlsx·json·txt·eml·html·md·pdf-text·pdf-image·png·jpg·photo) × 난이도. *(본인 문서면 이 단계 건너뛰고 `work/raw/` 에 직접 넣기)*

### ② 파싱 — `comfozi-parse-fleet` CLI → `work/parsed.json`
```bash
npx comfozi-parse-fleet parse work/raw --mode auto --sessions 4 --batch 8 \
    --stream work/parsed.jsonl --out work/parsed.json --pretty
```
- 텍스트(csv·pdf-text 등) = **결정적**(pdfjs 텍스트레이어), 이미지·스캔(png·jpg·pdf-image·photo) = **AI vision**(로컬 Claude 세션).
- `--sessions` = 동시 세션 X, `--batch` = 요청당 파일 Y (한 세션에 여러 파일 → 장당 22.4s→5.8s, 3.8배). 진행 실시간: 다른 터미널 `tail -f work/parsed.jsonl`.
- **AI 없이** 텍스트만: `--mode deterministic` (위 AI 설치·로그인 불필요).
- 세션 상태/디버그: `isesh list` · `isesh attach <세션명>`. (AI 세션이 끝낼 때까지 대기 — 타임아웃 없음.)

### ③ GBM 훈련
```bash
( cd apps/comfozi.approval-ml && uv run export-gbm )
# 본인 승인이력으로: ( cd apps/comfozi.approval-ml && uv run export-gbm --input ../../sample-data/approval-history )
```
LightGBM 훈련 → `model.json` → **`apps/comfozi.app/public/gbm` 로 자동 복사**. *(첫 실행은 e5 임베딩 다운로드로 수 분)*

### ④ 검수 인박스 (= 데모 프론트)
```bash
cp work/parsed.json apps/comfozi.app/public/parsed.json
( cd apps/comfozi.app && npm run dev -- --host 0.0.0.0 )
```
**5173 포트**(Codespace 하단 PORTS 탭 → 🌐) → 상단 데이터 소스 **‘파싱 결과’** + `plugin:gbm-score` ON → **본인 데이터 + 본인 GBM**으로 `comfozi.pages.dev` 화면 도달.

---

## 동작 원리 (AI 파싱)
`comfozi-parse-fleet` 가 이미지/스캔을 **로컬 isesh 세션 풀**(Claude vision)에 분산 파싱합니다 — `isesh`(세션 러너)·`imessenger`(세션 메시징)·`skit`(프로필 설치)·`snapshot`(@ist/beta 일괄설치). **서버 0 · 본인 Claude 구독 · 전부 로컬.**
- 파서 계약 커스터마이즈: `node_modules/@comfozi/parse-fleet/profiles/comfozi-doc-parser.md` · `.../prompts/parser-session-contract.md`.

## 구조
```
apps/comfozi.data-raw/     원본 문서 생성기        (submodule · public)
apps/comfozi.approval-ml/  GBM 훈련·export (uv)    (submodule)
apps/comfozi.app/          검수 인박스 = 데모 프론트 (submodule) ← 최종 화면
@comfozi/parse-fleet       파싱 CLI (published · glpkg install → node_modules)
sample-data/               바로 써볼 raw 문서 + 승인이력 CSV
scripts/setup.sh           기본 의존 부트스트랩
```
`@comfozi/*` 는 public 레지스트리에서 tokenless(glpkg) 설치.

## 참고 / 정직성
- 문서: https://comfozi-docs-5ea764.gitlab.io/  ·  라이브 데모: https://comfozi.pages.dev/
- 합성/샘플 데이터로 **파이프라인·스케일 거동**을 보여줍니다. 실제 승인 정확도는 실제 라벨 이력이 있어야 하며 그 경로가 `export-gbm --input ...`.

## 문제 해결
- **파싱이 이미지에서 `failed`**: AI 세션 준비 확인 — `command -v tmux isesh claude` + `claude login` + `skit install @comfozi/parse-fleet@0.1.1`(프로필). `isesh list`/`attach`로 세션 직접 확인. (`detector-agent ✗` 는 무관.)
- **인박스 '파싱 결과'가 비어있음**: `cp work/parsed.json apps/comfozi.app/public/parsed.json` 했는지 확인.
- **`comfozi-parse-fleet: command not found`**: `glpkg install @comfozi/parse-fleet@^0.1.1 --source gitlab` (또는 `bash scripts/setup.sh`) 먼저.
