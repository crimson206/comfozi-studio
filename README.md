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

**glpkg(tokenless 패키지 매니저) + `@comfozi` scope 매핑:**
```bash
npm i -g @glpkg/cli
glpkg config scope:set @comfozi blaybus2026-vibe
```

**4개 CLI를 이름으로 설치:**
```bash
glpkg install -g @comfozi/data-raw    --source gitlab   # → comfozi-data-raw
glpkg install -g @comfozi/parse-fleet --source gitlab   # → comfozi-parse-fleet
glpkg install -g @comfozi/app         --source gitlab   # → comfozi-app
glpkg install comfozi-approval-ml --pypi --group blaybus2026-vibe   # → export-gbm (torch-free base)
```
> - `export-gbm`은 **Python 3.11**(`>=3.11,<3.12`) 필요 — Codespace devcontainer가 자동. 기본 설치는 **torch/CUDA 없음**(사전계산 임베딩으로 데모 훈련).
> - 로컬 PC면 추가로 **Node 20 · Python 3.11 · 한글폰트**(`fonts-nanum fonts-noto-cjk`) 필요 — Codespace는 devcontainer가 자동.

### AI 파싱 준비물 (이미지·스캔)

② 파싱은 이미지·스캔(png·jpg·사진·pdf-image)을 **본인 Claude 구독으로 로컬 vision 파싱**합니다. 그래서 **② 파싱 전에 미리** 아래를 깔아둡니다 — `comfozi-parse-fleet`가 이미지를 **로컬 Claude 세션 풀**(vision)에 분산하는데, 그 세션을 `tmux`(세션 호스트) 위에서 **본인 Claude Code로 띄우고**(`claude login` — 서버 0, 본인 Claude 구독으로 로컬에서 vision 추론), 세션 러너/메시징/프로필(`isesh`·`imessenger`·`skit`)을 `snapshot`으로 받기 때문입니다.

```bash
sudo apt-get install -y tmux                          # mac: brew install tmux  — AI 세션 호스트
npm i -g @anthropic-ai/claude-code && claude login    # Claude Code 설치 + 로그인(본인 구독으로 로컬 vision 파싱)
npm i -g @microwiseai/snapshot && snapshot install @ist/beta   # isesh·imessenger·skit  (detector-agent ✗ 뜨면 무시)
skit install @comfozi/parse-fleet@0.1.1               # 파서 프로필/프롬프트 → ~/.ist/
```

---

## 2. 파이프라인 (실제 명령)

### ① 원본 증빙 문서 생성 → `work/raw/`
```bash
comfozi-data-raw gen --seed 7 --count 24 --out work/raw
```
12형식(csv·xlsx·json·txt·eml·html·md·pdf-text·pdf-image·png·jpg·photo) × 난이도. *(본인 문서면 이 단계 건너뛰고 `work/raw/`에 직접 넣기.)* 형식 목록: `comfozi-data-raw formats`.

### ② 파싱 → `work/parsed.json`
```bash
comfozi-parse-fleet parse work/raw --mode auto --out work/parsed.json --pretty
```
- 텍스트(csv·pdf-text 등) = **결정적**(pdfjs 텍스트레이어), 이미지·스캔(png·jpg·pdf-image·photo) = **AI vision**(로컬 Claude 세션 — 위 [AI 파싱 준비물](#ai-파싱-준비물-이미지스캔) 선행).
- `--mode auto`(기본, 자동 라우팅) · `--mode ai` · `--mode deterministic`(텍스트만 빠르게 볼 때, AI 불필요).
- `--concurrency <K>` lane/AI-pool 동시성(기본 2). `--ai-input vision|vision+ocr`(기본 vision).
- 세션 상태/디버그: `isesh list` · `isesh attach <세션명>`. (AI 세션이 끝낼 때까지 대기 — 타임아웃 없음.)

### ③ GBM 훈련·export → `work/gbm/`
```bash
export-gbm --out work/gbm
```
사전계산 e5 임베딩으로 LightGBM 훈련 → `work/gbm/`에 `model.json`·`embeddings_lookup.json`·`infer.js`·`feature-contract.md`. **torch 없이 동작**(base 설치).

**본인 승인이력으로 훈련(BYO)** — e5를 새로 뽑으므로 CPU torch가 필요:
```bash
export-gbm setup                                                   # uv로 CPU 전용 torch 설치(nvidia-cuda 0)
export-gbm --input sample-data/approval-history --out work/gbm     # <base>.input.csv + <base>.truth.csv
```

### ④ 검수 인박스 (= 데모 프론트)
```bash
comfozi-app --parsed work/parsed.json --gbm work/gbm --host 0.0.0.0
```
- `--parsed work/parsed.json` → 앱의 **‘파싱 결과’** 데이터 소스로 주입(내부적으로 `dist/parsed.json`).
- `--gbm work/gbm` → ③의 산출 디렉토리를 **`dist/gbm/`로 주입**(model.json·embeddings_lookup.json).
- **5173 포트**(Codespace 하단 PORTS 탭 → 🌐, `--port`로 변경) → 상단 데이터 소스 **‘파싱 결과’** + `plugin:gbm-score` ON → **본인 데이터 + 본인 GBM**으로 `comfozi.pages.dev` 화면 도달.

---

## 동작 원리 (AI 파싱)
`comfozi-parse-fleet`가 이미지/스캔을 **로컬 isesh 세션 풀**(Claude vision)에 분산 파싱합니다 — `isesh`(세션 러너)·`imessenger`(세션 메시징)·`skit`(프로필 설치)·`snapshot`(@ist/beta 일괄설치). **서버 0 · 본인 Claude 구독 · 전부 로컬.**
- 파서 계약 커스터마이즈: `skit install @comfozi/parse-fleet@0.1.1` 로 받은 `~/.ist/` 의 `comfozi-doc-parser` 프로필 / `parser-session-contract` 프롬프트.

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
- **`comfozi-*: command not found`**: 해당 설치 줄을 먼저 (`glpkg install -g @comfozi/… --source gitlab`, `export-gbm`은 `glpkg install comfozi-approval-ml --pypi --group blaybus2026-vibe`). 전역 npm bin이 PATH에 있는지 확인.
- **`export-gbm` 설치 실패(Requires-Python)**: Python이 3.11이어야 함(`>=3.11,<3.12`). Codespace는 자동, 로컬은 3.11 환경에서 설치.
- **파싱이 이미지에서 `failed`**: AI 세션 준비 확인 — `command -v tmux isesh claude` + `claude login` + `skit install @comfozi/parse-fleet@0.1.1`(프로필). `isesh list`/`attach`로 세션 직접 확인. (`detector-agent ✗`는 무관.)
- **인박스 ‘파싱 결과’가 비어있음**: `comfozi-app`을 `--parsed work/parsed.json`으로 실행했는지 확인.
- **BYO에서 `EmbedBackendMissing`(e5 필요)**: `export-gbm setup` 먼저(또는 `pip install 'comfozi-approval-ml[embed]'`).
