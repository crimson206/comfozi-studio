# comfozi-studio

**comfozi를 처음부터 끝까지 직접 밟아보는 체험 저장소.**
`comfozi.pages.dev` 는 "이미 다 돌아간 완성본"을 보여줍니다. 여기서는 **raw 증빙 문서 → 파싱 → GBM 훈련 → 검수 인박스**까지 한 단계씩 본인 손으로 돌려서, 마지막에 **그 데모와 똑같은 화면**에 본인 데이터·본인 모델로 도달합니다.

전부 **로컬/컨테이너에서** 돕니다(서버 0). CLI로 진행하고, 마지막 프론트만 우리 데모(`@comfozi/app`)를 그대로 씁니다.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/crimson206/comfozi-studio)

---

## 빠른 시작 (Codespaces 권장)

1. 위 **Open in Codespaces** 클릭 → 컨테이너가 뜨며 `postCreate`가 의존을 자동 설치(수 분).
2. 터미널에서:

```bash
make all          # 생성 → 파싱 → 훈련 → 인박스 한 번에
```

3. 5173 포트가 자동 포워딩 → 브라우저에 **검수 인박스**가 뜹니다. 상단에서 데이터 소스 **‘파싱 결과’** 선택 + `plugin:gbm-score` 켜면 → **본인이 방금 파싱한 데이터 + 방금 훈련한 GBM**으로 `comfozi.pages.dev` 화면에 도달.

> 로컬에서 직접 하려면: `git clone --recursive` 후 `make setup && make all`.
> 필요: Node 20 · Python 3.11 · [uv](https://docs.astral.sh/uv/). 한글 폰트(pdf/photo 렌더용)는 devcontainer가 설치.

---

## 단계별로 (하나씩 이해하며)

| 단계 | 명령 | 하는 일 |
|---|---|---|
| ① 원본 생성 | `make generate` | 12형식×난이도 증빙 문서를 `work/raw/` 에 생성 (`SEED`/`COUNT` 조절) |
| ② 파싱 | `make parse` | `work/raw` → `work/parsed.json` (결정적 파서; `MODE=ai`면 이미지까지 AI) |
| ③ GBM 훈련 | `make train` | LightGBM 훈련 → 브라우저 추론용 `model.json` → app 에 자동 배선 |
| ④ 인박스 | `make inbox` | 파싱 결과 + 모델을 검수 인박스에 올려 실행 (= 데모 화면) |

### 본인 데이터로 해보기
- **본인 문서로 파싱:** `make generate` 를 건너뛰고 `work/raw/` 에 **본인 증빙 파일**(csv/xlsx/pdf/이미지 등)을 넣은 뒤 `make parse`.
  - 이미지·스캔본까지 파싱하려면 `make parse MODE=ai` (본인 Claude 세션 `isesh` 사용, 전부 로컬).
- **본인 승인이력으로 훈련:** `make train INPUT=sample-data/approval-history`
  - 스키마: `sample-data/approval-history.input.csv`(9칸) + `.truth.csv`(`approved` 라벨). 본인 CSV를 같은 형식으로 두고 경로만 바꾸면 됩니다.
- **우리 생성기 데이터로 훈련:** 그냥 `make train` (내장 생성기).

---

## 구조

```
apps/
  comfozi.data-raw/     원본 문서 생성기        (submodule, public GitLab)
  comfozi.approval-ml/  GBM 훈련·export(uv)     (submodule)
  comfozi.app/          검수 인박스 = 데모 프론트 (submodule) ← 최종 화면
apps 의 @comfozi/* 라이브러리·플러그인은 public 레지스트리에서 glpkg 로 tokenless 설치.
vendor/parse-fleet/     파싱 오케스트레이터      (vendored)
sample-data/            바로 써볼 raw 문서 + 승인이력 CSV
scripts/ , Makefile     파이프라인 스텝
```

## 참고
- 문서 사이트: https://comfozi-docs-5ea764.gitlab.io/
- 라이브 데모(완성본): https://comfozi.pages.dev/
- 정직성: 이 파이프라인은 합성/샘플 데이터로 **파이프라인·스케일 거동**을 보여줍니다. 실제 승인 정확도는 실제 라벨 이력이 있어야 하며, 그 경로가 `make train INPUT=...` 입니다.
