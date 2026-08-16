# comfozi-studio

**comfozi를 처음부터 끝까지 직접 밟아보는 체험.**
`comfozi.pages.dev`(완성본)를, 여기서는 **raw 증빙 문서 → 파싱 → GBM 훈련 → 검수 인박스**까지 본인 손으로 돌려서, 마지막에 그 데모와 똑같은 화면에 **본인 데이터·본인 모델**로 도달합니다. 전부 로컬/컨테이너, 서버 0.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/crimson206/comfozi-studio)

---

## 1. 준비 — 직접 설치 (1회)

Codespace를 열거나(위 배지) 로컬이면 `git clone --recursive https://github.com/crimson206/comfozi-studio && cd comfozi-studio && make setup`, 그다음:

```bash
# tmux + Claude Code
sudo apt-get install -y tmux                 # mac: brew install tmux
npm i -g @anthropic-ai/claude-code
claude login                                 # Claude 로그인

# isesh 툴체인(@ist) + 파서 프로필
npm i -g @microwiseai/snapshot
snapshot install @ist/beta                   # isesh · imessenger · skit  (detector-agent ✗ 뜨면 무시)
make install-parser                          # comfozi-doc-parser 프로필 → ~/.ist/ (published 패키지에서)
```

> **로컬 PC**면 추가로 **Node 20 · Python 3.11 · [uv](https://docs.astral.sh/uv/) · 한글폰트**(`fonts-nanum fonts-noto-cjk`)도 필요 — Codespace는 devcontainer가 자동 설치.

---

## 2. 파이프라인

### ① 원본 증빙 문서 생성
```bash
make generate
```
→ `work/raw/` 에 12형식(csv·xlsx·json·txt·eml·html·md·pdf-text·pdf-image·png·jpg·photo) × 난이도 문서. *(본인 문서로 하려면 이 단계 건너뛰고 `work/raw/` 에 넣기)*

### ② 파싱 — 4세션 × 8파일 (2D 병렬)
```bash
make parse MODE=auto SESSIONS=4 BATCH=8
tail -f work/parsed.jsonl                     # (다른 터미널) 실시간 진행
```
텍스트(csv·pdf-text 등)는 **결정적 파서**(pdfjs 텍스트레이어)로 빠르게, 이미지·스캔(png·jpg·pdf-image·photo)은 **AI vision**(로컬 Claude 세션)으로. 한 세션에 여러 파일을 한 번에 + 세션 여러 개 = **장당 22.4s→5.8s(3.8배)**.
→ `work/parsed.json` (+ 실시간 `work/parsed.jsonl`)

### ③ GBM 훈련
```bash
make train                                    # 내장 생성기 데이터로 훈련
# make train INPUT=sample-data/approval-history   # 본인 승인이력(input+truth CSV)으로
```
LightGBM 훈련 → 브라우저 추론용 `model.json` → 검수 앱에 **자동 배선**. *(첫 실행은 e5 임베딩 다운로드로 수 분)*

### ④ 검수 인박스 (= 데모 프론트)
```bash
make inbox
```
**5173 포트**(Codespace 하단 PORTS 탭 → 🌐) → 상단 데이터 소스 **‘파싱 결과’** + `plugin:gbm-score` 스위치 ON → **본인이 방금 파싱한 데이터 + 방금 훈련한 GBM**으로 `comfozi.pages.dev` 화면에 도달.

---

## 동작 원리 (AI 파싱)
parse-fleet이 이미지/스캔을 **로컬 isesh 세션 풀**(Claude vision)에 분산 파싱합니다 — `isesh`(세션 러너)·`imessenger`(세션 메시징)·`skit`(프로필 설치)·`snapshot`(@ist/beta 일괄설치). **서버 0 · 본인 Claude 구독 · 전부 로컬.** comfozi 실제 제품이 쓰는 세션 인프라 그대로입니다.
- 커스터마이즈: `node_modules/@comfozi/parse-fleet/profiles/comfozi-doc-parser.md`(파서 계약) · `.../prompts/parser-session-contract.md`.

## 구조
```
apps/comfozi.data-raw/     원본 문서 생성기        (submodule · public)
apps/comfozi.approval-ml/  GBM 훈련·export (uv)    (submodule)
apps/comfozi.app/          검수 인박스 = 데모 프론트 (submodule) ← 최종 화면
@comfozi/parse-fleet       파싱 CLI (published 패키지 · glpkg install → node_modules)
sample-data/               바로 써볼 raw 문서 + 승인이력 CSV
```
`@comfozi/*` 는 public 레지스트리에서 tokenless(glpkg) 설치.

## 참고 / 정직성
- 문서: https://comfozi-docs-5ea764.gitlab.io/  ·  라이브 데모: https://comfozi.pages.dev/
- 합성/샘플 데이터로 **파이프라인·스케일 거동**을 보여줍니다. 실제 승인 정확도는 실제 라벨 이력이 있어야 하며 그 경로가 `make train INPUT=...`.

## 문제 해결
- **`make parse` 가 이미지에서 `failed`**: AI 세션 준비 확인 — `command -v tmux isesh claude` + `claude login` + `make install-parser`(프로필). (`detector-agent ✗` 는 무관.)
- **인박스 '파싱 결과'가 비어있음**: `make parse` → `make inbox` 순서 확인(`work/parsed.json` → app 으로 복사됨).
- **`command not found @comfozi/…`**: `make setup` 먼저(또는 Codespace postCreate 완료 대기).
