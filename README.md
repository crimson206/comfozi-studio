# comfozi-studio

**comfozi를 처음부터 끝까지 직접 밟아보는 체험 저장소.**
`comfozi.pages.dev` 는 "이미 다 돌아간 완성본"을 보여줍니다. 여기서는 **raw 증빙 문서 → 파싱 → GBM 훈련 → 검수 인박스**까지 한 단계씩 본인 손으로 돌려서, 마지막에 **그 데모와 똑같은 화면**에 본인 데이터·본인 모델로 도달합니다.

전부 **로컬/컨테이너에서** 돕니다(서버 0). CLI로 진행하고, 마지막 프론트만 우리 데모(`@comfozi/app`)를 그대로 씁니다.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/crimson206/comfozi-studio)

---

## 빠른 시작 (Codespaces 권장)

1. 위 **Open in Codespaces** 클릭 → 컨테이너가 뜨며 `postCreate`가 의존을 자동 설치.
   - **prebuild가 켜져 있으면** 준비까지 ~30초. (안 켜져 있으면 첫 설치에 torch/의존 다운로드로 수 분~십수 분)
   - 터미널 프롬프트가 뜨고 아래 `make` 가 먹으면 준비 완료.
2. 터미널에서 한 방에:
   ```bash
   make all
   ```
   또는 아래 **단계별로** 하나씩(영상용 권장).
3. 마지막에 **5173 포트**가 자동 포워딩됩니다. VS Code 하단 **PORTS** 탭 → 5173 의 🌐(Open in Browser) → **검수 인박스**.
   - 상단에서 데이터 소스 **‘파싱 결과’** 선택 + `plugin:gbm-score` 스위치 ON → **본인이 방금 파싱한 데이터 + 방금 훈련한 GBM**으로 `comfozi.pages.dev` 화면에 도달.

> **로컬 PC(Codespaces 아닐 때):** Codespaces는 devcontainer가 아래를 자동 설치하지만, 로컬에선 **직접 준비**해야 합니다.
> 1. 사전 도구: **Node 20 · Python 3.11 · [uv](https://docs.astral.sh/uv/) · git**
> 2. **한글 폰트**(data-raw의 pdf/photo 렌더용, 없으면 이미지 생성이 깨짐):
>    · Ubuntu/Debian: `sudo apt install -y fonts-nanum fonts-noto-cjk`
>    · macOS: NanumGothic·NotoSansKR 설치 — 또는 `export COMFOZI_KR_FONT=/경로/폰트.ttf`
> 3. 실행: `git clone --recursive https://github.com/crimson206/comfozi-studio && cd comfozi-studio && make setup && make all`
>
> (`make setup`이 glpkg·submodule·의존을 깔지만, 위 **도구·폰트는 OS별로 직접** 준비해야 합니다 — 이게 Codespaces에서 devcontainer가 대신 해주던 부분입니다.)

---

## 단계별 워크스루 (영상용 — 각 단계 "확인 포인트" 포함)

### ① 원본 증빙 문서 생성 — `make generate`
파싱 前 원본 문서를 12형식(csv·xlsx·json·txt·eml·html·md·pdf-text·pdf-image·png·jpg·photo) × 난이도로 생성.
```bash
make generate            # 기본 seed=7, count=24
make generate SEED=1 COUNT=48
```
**✅ 확인:** `work/raw/` 에 문서 파일들 + `manifest.json` 이 생김. 콘솔에 형식×난이도 표가 출력.
**본인 문서로 하려면:** 이 단계를 건너뛰고 `work/raw/` 에 본인 증빙 파일을 넣으세요.

### ② 파싱 — `make parse`
`work/raw` → `work/parsed.json` (행 + provenance + detector). **모드 2가지:**

**(a) deterministic (기본 — 설치·로그인 0):**
```bash
make parse               # csv·xlsx·json·txt·eml·html·md·pdf-text 파싱 (이미지는 "파싱 실패 후보")
```

**(b) AI 파싱 (이미지·스캔까지 + 빠른 2D 병렬) — ⚠ 먼저 아래 설치·로그인 1회:**
```bash
# 1) tmux + Claude Code (직접 설치)
sudo apt-get install -y tmux                  # mac: brew install tmux
npm i -g @anthropic-ai/claude-code
claude login                                  # Claude 로그인
# 2) isesh 툴체인(@ist) — snapshot 으로
npm i -g @microwiseai/snapshot
snapshot install @ist/beta                    # isesh · imessenger · skit  (detector-agent ✗ 뜨면 무시 — 파싱에 불필요)
# 3) parse-fleet 파서 프로필(배치 계약) → ~/.ist/ 에 설치 (vendored, 배포 불필요)
make install-parser
```
설치 후 실행 (**X세션 × Y파일 = 2D 병렬**):
```bash
make parse MODE=auto SESSIONS=4 BATCH=8        # 권장: 이미지만 AI, 4세션 × 8파일/요청
make parse MODE=ai   SESSIONS=8 BATCH=8        # 전부 AI
tail -f work/parsed.jsonl                      # (다른 터미널) 실시간 진행 — 이상하면 바로 중단
```
> **왜 빠른가:** 한 세션에 여러 파일 경로를 한 번에(이미지 합치기 X, 각 원본 풀해상도) → **장당 22.4s→5.8s (3.8배, 실측)** + 세션 수(X)로 추가 병렬. 동작 원리·설정파일은 아래 **"AI 파싱 세부"**.

**✅ 확인:** `comfozi-parse-fleet: done — rows=… failed=0`, `work/parsed.json`(+ `work/parsed.jsonl` 스트림). **AI인데 `failed=전체`면** 설치 확인: `command -v tmux isesh claude` + `claude login` 여부.

### ③ GBM 훈련 — `make train`
LightGBM 훈련 → 브라우저 추론용 `model.json` → 검수 앱에 **자동 배선**.
```bash
make train                                   # 내장 생성기 데이터로 훈련
make train INPUT=sample-data/approval-history  # 본인 승인이력으로 훈련
```
**✅ 확인:** `[export] PARITY raw=0 proba=0` (파이썬 booster ↔ 브라우저 JSON 정확 일치), `auc(train)=0.9x`, `→ apps/comfozi.app/public/gbm` 로 4파일 복사.
> 첫 실행은 e5 임베딩 모델(~470MB) 다운로드로 수 분 걸릴 수 있음(이후 캐시).
> **본인 데이터 스키마:** `sample-data/approval-history.input.csv`(9칸) + `.truth.csv`(`approved` 라벨). 본인 CSV를 같은 형식으로 두고 `INPUT=<경로base>` 만 바꾸면 됩니다.

### ④ 검수 인박스 — `make inbox`
파싱 결과 + 훈련 모델을 우리 데모 프론트에 올려 실행.
```bash
make inbox
```
**✅ 확인:** `http://localhost:5173` (Codespaces면 PORTS 탭 5173). 인박스에서:
- 상단 데이터 소스 **‘파싱 결과’** → 방금 파싱한 행들이 인박스에 뜸
- `plugin:gbm-score` ON → 카드에 **승인 확률·트리아지 버킷·상위 사유**
- `diff-view`/`explain-card`/`triage-toolbar` 등 토글 → `comfozi.pages.dev` 와 동일 화면
- 카드 인라인 수정 → **승인/반려** → 우측 **export 미리보기**(JSON/CSV)

---

## AI 파싱 세부 (동작 원리 · 설정)
> 설치·실행은 위 **스텝 ②(b)** 에 순서대로 있습니다. 이 절은 원리/커스터마이즈 참고용.

이미지·스캔(png·jpg·pdf-image·photo)까지 AI로 파싱하는 `MODE=ai`/`MODE=auto`는 parse-fleet이 **로컬 isesh 세션**(Claude vision)으로 처리 — 본인 Claude 구독, 전부 로컬.

### 어떻게 동작하나 — comfozi가 쓰는 세션 도구(@ist)
AI 파싱은 "서버 없이, 본인 Claude 구독으로" 돌리기 위해 우리 세션 툴체인을 씁니다. parse-fleet이 문서 배치를 받아 **여러 개의 Claude vision 세션에 분산**시켜 파싱합니다:

| 도구 | 역할 |
|---|---|
| **isesh** | 통합 세션 러너. `isesh start -p <profile>` 로 Claude/Codex CLI를 **백그라운드 워커 세션**으로 띄우고 관리. parse-fleet이 문서마다 `comfozi-doc-parser` 세션을 스폰해 vision 추출. |
| **imessenger** | 세션↔세션 메시징. 파서 세션에 `[DOC-EXTRACT]` 요청을 보내고, 세션이 Write한 결과 JSON을 파일드롭으로 수거. |
| **skit** | 프롬프트/프로필/CLI 설치기. `comfozi-doc-parser` 프로필 + 계약 프롬프트를 `~/.ist/` 에 설치. |
| **snapshot** | 스냅샷(`@ist/beta`)으로 위 툴체인을 **한 번에 설치**. |

> 그래서 **서버 0 · 본인 Claude 구독 · 전부 로컬**. 결정적 파서로 안 되는 이미지/스캔만 이 세션 풀로 넘어갑니다.
>
> **왜 세션 풀?** 문서마다 Claude를 콜드스타트하면 대량(수백 건)에서 느리고 낭비됩니다 → isesh가 **warm 세션 K개를 재사용**하며 `[DOC-EXTRACT]` 요청을 백프레셔로 흘려보냅니다(동시성 = `--concurrency K`, 기본 2). **comfozi 실제 제품이 쓰는 세션 인프라 그대로**라, AI 파싱을 돌려보는 것 자체가 우리 도구 실물 체험이 됩니다.

> ⚠️ **설치·실행은 위 스텝 ②(b) 참고.** `@ist/beta`는 tokenless로 설치됩니다(그중 `detector-agent`만 인증 필요한데 **파싱엔 안 쓰니 실패해도 무시**). 필요한 건 `claude login`뿐.

**세부 옵션 (CLI 직접):**
```bash
node vendor/parse-fleet/dist/cli.js parse work/raw --mode auto --sessions 8 --batch 8 \
  --ai-input vision+ocr --stream work/parsed.jsonl --out work/parsed.json --pretty
```
`--sessions`=동시 세션 X · `--batch`=요청당 파일 Y · `--ai-input vision+ocr`=OCR 초벌 교차검증 · `--stream`=실시간 append.

**설정 파일 (커스터마이즈):**
- `vendor/parse-fleet/profiles/comfozi-doc-parser.md` — AI 파서 세션 프로필(모델=Claude vision, 도구 Read/Glob/Write, `[DOC-EXTRACT]` 추출 계약)
- `vendor/parse-fleet/prompts/parser-session-contract.md` — 세션 계약 프롬프트
- `vendor/parse-fleet/skit.json` — 위 등록 + 설치 경로

## 본인 데이터로 하는 3가지
- **본인 문서 파싱:** `work/raw/` 에 본인 파일 → `make parse` (이미지까지면 `MODE=ai`)
- **본인 승인이력 훈련:** `make train INPUT=<base>` (`<base>.input.csv` + `<base>.truth.csv`)
- **우리 생성기 데이터:** 그냥 `make generate` / `make train`

## 구조
```
apps/comfozi.data-raw/     원본 문서 생성기        (submodule · public GitLab)
apps/comfozi.approval-ml/  GBM 훈련·export (uv)    (submodule)
apps/comfozi.app/          검수 인박스 = 데모 프론트 (submodule) ← 최종 화면
vendor/parse-fleet/        파싱 오케스트레이터
sample-data/               바로 써볼 raw 문서 + 승인이력 CSV
scripts/ , Makefile        파이프라인 스텝
```
`@comfozi/*` 라이브러리·플러그인은 public 레지스트리에서 **glpkg 로 tokenless** 설치(scope 매핑은 setup.sh가 처리).

## 참고 / 정직성
- 문서: https://comfozi-docs-5ea764.gitlab.io/  ·  라이브 데모(완성본): https://comfozi.pages.dev/
- 이 파이프라인은 합성/샘플 데이터로 **파이프라인·스케일 거동**을 보여줍니다. 실제 승인 정확도는 실제 라벨 이력이 있어야 하며, 그 경로가 `make train INPUT=...` 입니다.

## 문제 해결
- `make` 가 "command not found @comfozi/…": `make setup` 을 먼저(또는 postCreate 완료 대기).
- 파싱에서 이미지가 다 실패 후보: 정상(기본 deterministic). 이미지 파싱은 `MODE=ai`.
- **`make parse MODE=ai` 가 `failed=전체`(ai=0):** `command -v tmux isesh claude`(빠지면 각각 설치) · `snapshot install @ist/beta` · `make install-parser`(파서 프로필) · `claude login` 확인. (`detector-agent ✗` 는 무관.)
- 인박스 '파싱 결과'가 비어있음: `make parse` 후 `make inbox` 순서인지 확인(`work/parsed.json` → app/public 복사됨).
