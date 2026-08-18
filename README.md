# comfozi-studio

**comfozi를 처음부터 끝까지 직접 밟아보는 체험.**
`comfozi.pages.dev`(완성본)를, 여기서는 **raw 증빙 문서 → 파싱 → GBM 훈련 → 검수 인박스**까지 본인 손으로 돌려서, 마지막에 그 데모와 똑같은 화면에 **본인 데이터·본인 모델**로 도달합니다. 전부 로컬/컨테이너, 서버 0.

> 이 repo는 **배포된 CLI를 이름으로 설치해서 실행**만 합니다(소스·서브모듈 없음). 각 단계는 독립 패키지의 CLI 한 줄입니다 — Codespace 터미널(또는 로컬)에서 **repo 루트**에서 그대로 치세요.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/crimson206/comfozi-studio)

| 단계 | CLI | 패키지 |
|---|---|---|
| ① 원본 증빙 문서 생성 | `comfozi-data-raw` | `@comfozi/data-raw` (npm) |
| ② 파싱 | `comfozi-parse-fleet` | `@comfozi/parse-fleet` (npm) |
| ③ GBM 훈련·export | `export-gbm` | `comfozi-approval-ml` (pypi) |
| ④ 검수 인박스(=데모 프론트) | `comfozi-app` | `@comfozi/app` (npm) |

---

## 1. 준비 (설치, 1회)

**glpkg(tokenless 패키지 매니저):**
```bash
npm i -g @glpkg/cli@0.12.0
```

**4개 CLI를 이름으로 설치:**
```bash
glpkg install -g @comfozi/data-raw    --group blaybus2026-vibe --source gitlab   # → comfozi-data-raw
glpkg install -g @comfozi/parse-fleet --group blaybus2026-vibe --source gitlab   # → comfozi-parse-fleet
glpkg install -g @comfozi/app         --group blaybus2026-vibe --source gitlab   # → comfozi-app
# ↑ 위 3개 전역 설치 후 같은 셸에선 방금 설치된 전역 bin이 안 잡힐 수 있음 → 새 터미널을 열거나 `hash -r`(또는 셸 재로그인)로 PATH 갱신 후 아래 ML 설치/파이프라인 실행
glpkg install comfozi-approval-ml --pypi --group blaybus2026-vibe   # → export-gbm (torch-free base)
```
> - `export-gbm`은 **Python 3.11**(`>=3.11,<3.12`) 필요 — Codespace devcontainer가 자동. 기본 설치는 **torch/CUDA 없음**(사전계산 임베딩으로 데모 훈련).
> - 로컬 PC면 추가로 **Node 20 · Python 3.11 · 한글폰트**(`fonts-nanum fonts-noto-cjk`) 필요 — Codespace는 devcontainer가 자동.

### AI 파싱 준비물 — Claude Code 하나면 끝 (headless 기본)

② 파싱은 이미지·스캔(png·jpg·사진·pdf-image)을 **본인 구독으로 로컬 vision 파싱**합니다. 엔진은 **headless**(`claude -p` 또는 `codex exec`)라 필요한 건 **AI CLI 설치 + 로그인**뿐입니다 — 파서 프로필은 `@comfozi/parse-fleet` 패키지에 **동봉**되어 직접 읽으므로 **별도 프로필 설치·세션 툴·승인 봇 전부 불필요**:

```bash
# 공통 사전요구: PDF→PNG 래스터화(pdftoppm)
sudo apt-get install -y poppler-utils                 # mac: brew install poppler — pdf 파싱에 필요

# Claude 구독 (기본) — --engine headless
npm i -g @anthropic-ai/claude-code && claude login    # 본인 Claude 구독으로 로컬 vision 파싱
```
> **이 데모는 headless 로 detector-agent 없이 끝까지 완주됩니다.** `claude -p`(print 모드)가 `[DOC-EXTRACT]` 요청마다 프롬프트 없이 1샷 응답·종료 → 파싱이 permission 대기로 멈추지 않습니다.

**Codex 구독만 있다면** — `--engine headless --backend codex` 로 `codex exec` vision 파싱(poppler 는 공통 사전요구):
```bash
sudo apt-get install -y poppler-utils                 # (공통) PDF→PNG 래스터화
codex login                                           # 본인 Codex(OpenAI) 구독 — codex CLI 설치 후 로그인
```
그다음 ②를 `--engine headless --backend codex` 로 실행합니다(아래 ② 파싱 참고). **codex 는 batch=1 고정이라 병렬은 `--concurrency` 로 냅니다**(예: `--concurrency 8`).

---

## 2. 파이프라인 (실제 명령)

> **데이터 흐름 — 두 갈래가 ④에서 만납니다.** ①·②의 `parse`는 **검수 대상 데이터**(`work/parsed.json` — 무엇을 볼지)를 만들고, ③의 `export-gbm`은 **승인/반려 라벨이 있는 승인이력**으로 GBM을 *따로* 훈련합니다. ④ 인박스에서 GBM이 그 검수 대상을 **점수화만** 합니다.
> - **`parsed.json`은 훈련 입력이 아닙니다** — 라벨(approved/review_result)이 없기 때문입니다. 스키마로 보면 `parsed.json ≈ 승인이력의 input 부분`(supplier·item·spec·price·date)이고, **빠진 건 truth 라벨**입니다.
> - ③ 훈련 데이터: 데모(인자 없음)=**합성 라벨 데이터**, BYO=`--input <base>`의 `base.input.csv` + `base.truth.csv`(승인/반려 라벨).
> - **본인 파싱 데이터로 훈련하려면**: ④ 인박스에서 사람이 승인/반려로 검수 → 그게 truth 라벨 → 그 라벨로 재훈련(**flywheel**). `parse → 바로 train`이 아닙니다.

### ① 원본 증빙 문서 생성 → `work/raw/`
```bash
comfozi-data-raw gen --seed 7 --count 24 --out work/raw
```
12형식(csv·xlsx·json·txt·eml·html·md·pdf-text·pdf-image·png·jpg·photo) × 난이도. *(본인 문서면 이 단계 건너뛰고 `work/raw/`에 직접 넣기.)* 형식 목록: `comfozi-data-raw formats`.

### ② 파싱 → `work/parsed.json`

**데모 2종 — 파싱에서 보여줄 2가지** (둘 다 headless·로컬·무프롬프트, `work/raw` → `work/parsed.json`, 하나만 골라 실행):
```bash
# ① claude headless (기본·권장) — Claude 구독
comfozi-parse-fleet parse work/raw --mode auto --engine headless --backend claude --concurrency 4 --out work/parsed.json --pretty

# ② codex headless — Codex 구독. batch 는 1 고정, 병렬은 --concurrency 로.
comfozi-parse-fleet parse work/raw --mode auto --engine headless --backend codex --concurrency 8 --out work/parsed.json --pretty
#   참고: codex --concurrency 8 → 37문서 약 3분. concurrency 올리면 빨라지나 rate limit 유의.
```

- **①(기본 권장) = `--engine headless --backend claude`**: 이미지·스캔을 `claude -p`(headless)로 파싱 → **프롬프트 없이 완주**(smon·detector-agent 불필요). 텍스트(csv·pdf-text 등)는 `--mode auto`가 **결정적**(pdfjs 텍스트레이어)으로 먼저 처리하고, 이미지·스캔(png·jpg·pdf-image·photo)만 headless AI vision으로 보냅니다.
- **② Codex 구독**이면 `--backend codex`(headless `codex exec`). 기본은 `--backend claude`. **codex 는 batch>1 미지원 → batch=1 고정**, 병렬은 `--concurrency` 로만 낸다.
- `--mode auto`(기본, 텍스트 결정적 우선 + 이미지 AI) · `--mode ai`(전부 AI) · `--mode deterministic`(텍스트만, AI 불필요).
- `--retry <n>` 실패 문서 자동 재시도(기본 1) — 일시적 실패에도 안정적으로 완주. `--concurrency <K>` 병렬(claude 기본 4·codex 예 8). `--model <name>` 모델 오버라이드. `--ai-input vision|vision+ocr`(기본 vision).

> `work/parsed.json`은 ④ 인박스의 **검수 대상 데이터**입니다 — ③ GBM의 훈련 입력이 아닙니다(라벨 없음).

### ③ GBM 훈련·export → `work/gbm/`
```bash
export-gbm --out work/gbm
```
**승인/반려 라벨이 있는 승인이력**으로 LightGBM을 훈련합니다(②의 `parsed.json`이 아님 — 라벨이 없어 그대로는 훈련 불가). 인자 없이 실행하면 **합성 라벨 데이터**로 훈련하고, 사전계산 e5 임베딩을 써 **torch 없이 동작**(base 설치)합니다. 산출: `work/gbm/`에 `model.json`·`embeddings_lookup.json`·`infer.js`·`feature-contract.md`.

**본인 승인이력으로 훈련(BYO)** — 라벨된 이력(`base.input.csv` 특징 + `base.truth.csv` 승인/반려)이 필요하고, 신규 어휘 e5를 새로 뽑으므로 CPU torch가 필요:
```bash
export-gbm setup                                                   # uv로 CPU 전용 torch 설치(nvidia-cuda 0)
export-gbm --input sample-data/approval-history --out work/gbm     # <base>.input.csv(특징) + <base>.truth.csv(라벨)
```

### ④ 검수 인박스 (= 데모 프론트)
```bash
comfozi-app --parsed work/parsed.json --gbm work/gbm --host 0.0.0.0
```
- `--parsed work/parsed.json` → 앱의 **‘파싱 결과’**(②의 검수 대상 데이터) 소스로 주입(내부적으로 `dist/parsed.json`).
- `--gbm work/gbm` → ③의 산출(라벨된 이력으로 훈련된 GBM)을 **`dist/gbm/`로 주입**(model.json·embeddings_lookup.json).
- **여기서 두 갈래가 만납니다**: `plugin:gbm-score` ON → GBM이 ‘파싱 결과’의 각 행을 **점수화**(승인 확률)합니다. 사람이 승인/반려로 검수하면 그 라벨이 다음 훈련의 truth가 됩니다(flywheel).
- **5173 포트**(Codespace 하단 PORTS 탭 → 🌐, `--port`로 변경) → 상단 데이터 소스 **‘파싱 결과’** 선택 → **본인 데이터 + 본인 GBM**으로 `comfozi.pages.dev` 화면 도달.

---

## 동작 원리 (AI 파싱)
`comfozi-parse-fleet`가 이미지/스캔을 **본인 구독으로 로컬 vision 파싱**합니다. 엔진은 **headless** — `[DOC-EXTRACT]` 요청마다 `claude -p`(claude) 또는 `codex exec`(codex)를 1샷 띄워 **패키지에 동봉된 파서 계약**(`comfozi-doc-parser*` 프로필)을 system prompt로 주고, 이미지를 읽어 RawRow JSON을 씁니다 — 프롬프트 없이 응답·종료. **서버 0 · 전부 로컬.** 별도 프로필 설치·세션·smon·detector-agent 전부 불필요.

**엔진 × 백엔드 매트릭스** — `--engine headless` × `--backend`(claude|codex). `--model <name>`로 모델 오버라이드, 병렬은 `--concurrency`:

| `--engine` | `--backend` | 실행 방식 | 승인 / 병렬 |
|---|---|---|---|
| `headless` | `claude` (기본) | `claude -p` 1샷 | 무프롬프트 · 병렬 `--concurrency`(기본 4) |
| `headless` | `codex` | `codex exec` | 무프롬프트 · **batch=1 고정**, 병렬 `--concurrency`(예 8) |

## 구조 (thin repo)
```
comfozi-data-raw       원본 문서 생성기 CLI       @comfozi/data-raw   (npm · glpkg -g)
comfozi-parse-fleet    파싱 CLI                   @comfozi/parse-fleet(npm · glpkg -g)
export-gbm             GBM 훈련·export CLI        comfozi-approval-ml (pypi · glpkg --pypi, torch-free)
comfozi-app            검수 인박스 = 데모 프론트   @comfozi/app        (npm · glpkg -g, 빌드된 dist 동봉)
sample-data/           바로 써볼 raw 문서 + 승인이력 CSV(BYO 예시)
work/                  파이프라인 산출물(gitignore): raw/ · parsed.json · gbm/
```
`@comfozi/*`(npm)·`comfozi-approval-ml`(pypi) 모두 public 레지스트리에서 tokenless(glpkg) 설치. 각 소스는 GitLab `blaybus2026-vibe` 그룹.

## 참고 / 정직성
- 문서: https://comfozi-docs-5ea764.gitlab.io/  ·  라이브 데모: https://comfozi.pages.dev/
- 합성/샘플 데이터로 **파이프라인·스케일 거동**을 보여줍니다. 실제 승인 정확도는 실제 라벨 이력이 있어야 하며 그 경로가 `export-gbm --input ...`.

## 문제 해결
- **`comfozi-*: command not found`**: 해당 설치 줄을 먼저 (`glpkg install -g @comfozi/… --group blaybus2026-vibe --source gitlab`, `export-gbm`은 `glpkg install comfozi-approval-ml --pypi --group blaybus2026-vibe`). 전역 npm bin이 PATH에 있는지 확인. 방금 전역 설치를 마친 **같은 셸**이면 새로 깐 bin이 PATH/셸 해시에 아직 안 잡힐 수 있음 → 새 터미널을 열거나 `hash -r`로 갱신.
- **PDF 변환/파싱 실패**: `poppler-utils`(pdftoppm) 미설치일 수 있음 → `sudo apt-get install -y poppler-utils` (mac: `brew install poppler`).
- **`export-gbm` 설치 실패**: ① Python이 **3.11**이어야 함(`>=3.11,<3.12`). ② 시스템 파이썬이 externally-managed(**PEP 668**)면 `glpkg … --pypi`가 거부될 수 있음 — venv에서 설치하세요: `python3 -m venv .venv && . .venv/bin/activate` 후 `glpkg install comfozi-approval-ml --pypi --group blaybus2026-vibe`. (Codespace devcontainer는 해당 없음.)
- **파싱이 이미지에서 `failed`**: `claude login`(codex 백엔드면 `codex login`) + `command -v claude`/`codex` 확인. **root로 실행하지 마세요** — `claude -p`가 root/sudo에서 `--dangerously-skip-permissions`를 거부합니다(일반 사용자로 실행).
- **codex 파싱이 느리거나 rate limit**: `--concurrency` 로 병렬 조절(예: 8). codex 는 **batch=1 고정**이라 배치 크기로는 못 올립니다.
- **`comfozi-app` 실행 시 `EACCES … dist/parsed.json`**: 전역 설치 위치가 root 소유일 때(예: `sudo npm i -g`), **설치한 사용자로** `comfozi-app`을 실행하세요(전역 패키지의 `dist/`에 주입하므로). Codespace(사용자 소유 전역)는 해당 없음.
- **인박스 ‘파싱 결과’가 비어있음**: `comfozi-app`을 `--parsed work/parsed.json`으로 실행했는지 확인.
- **BYO에서 `EmbedBackendMissing`(e5 필요)**: `export-gbm setup` 먼저(또는 `pip install 'comfozi-approval-ml[embed]'`).
