# @comfozi/parse-fleet

병렬 문서 파싱 오케스트레이터. **결정적 파서 우선 시도 → 저산출/저신뢰 문서만 AI 세션 풀로 폴백** →
`RawRow[]` 취합 + `@comfozi/detectors` 실행.

- 결정적 파싱: [`@comfozi/doc-import`](../comfozi.doc-import) 재사용 (base 재구현 금지)
- 검출: `@comfozi/detectors.analyze()` 재사용
- 소유 범위: **라우팅 정책 · 동시성/백프레셔 · isesh AI 세션 수명주기**

## CLI

```bash
comfozi-parse-fleet parse <dir|files...> \
  --concurrency 4 \
  --mode auto \          # auto | deterministic | ai
  --out result.json \
  --pretty
```

- `auto` (기본): 텍스트/표 형식은 결정적 우선, 산출행수 부족(`--` detRowFloor)·저신뢰면 AI 폴백.
  이미지/스캔(png/jpg/pdf-image/photo)은 곧바로 AI.
- `deterministic`: 결정적 lane 고정(오프라인, 세션 불필요).
- `ai`: 모든 문서를 AI 세션 풀로.

## 라이브러리

```ts
import { parseFleet } from '@comfozi/parse-fleet';

const result = await parseFleet(docs, { mode: 'auto', concurrency: 4 });
// result.rows      : ParsedRow[]  (provenance 포함)
// result.analyses  : RowAnalysis[] (detectors 결과)
// result.routing   : RouteDecision[] (문서별 어느 lane·왜)
// result.stats     : { documents, deterministic, ai, failed, totalRows }
```

테스트/오프라인에서는 `deterministicRunner`/`aiRunner`/`transport`를 주입해 세션 없이 흐름을 검증할 수 있다.

## 구조

| 파일 | 역할 | 런타임 의존 |
|---|---|---|
| `src/router.ts` | 형식 분류 + 결정적-우선/폴백 정책 | 타입 온리 (오프라인) |
| `src/util/mapLimit.ts` | K-동시성 백프레셔 | 없음 (오프라인) |
| `src/deterministic.ts` | doc-import 체인 in-process 래핑 | `@comfozi/doc-import` |
| `src/pool.ts` | isesh 세션 풀(파일드롭 프로토콜) | node + doc-import |
| `src/aggregate.ts` | 병합 + `analyze()` | `@comfozi/detectors` |
| `src/index.ts` / `src/cli.ts` | 공개 API / bin | 전체 |

설계 상세·블로커는 [DESIGN.md](./DESIGN.md).

## 개발

```bash
npm install     # @comfozi/* 는 glpkg 그룹 blaybus2026-vibe (설치=오너 게이트)
npm run build   # tsup → dist (index + cli, cli 셔뱅 보존)
npm test        # vitest — router/mapLimit 는 deps 없이도 통과
```

> ⚠️ 이 패키지는 아직 publish/설치 전 **스캐폴드** 상태다. build/online-test 는 `@comfozi/*` 설치 후 가능.
