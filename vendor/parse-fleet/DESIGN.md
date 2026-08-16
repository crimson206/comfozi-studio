# @comfozi/parse-fleet — DESIGN

병렬 문서 파싱 오케스트레이터. **결정적 우선 시도 → 저산출/저신뢰 문서만 AI 세션 풀 폴백**.
결정적 파싱은 `@comfozi/doc-import`, 검출은 `@comfozi/detectors`를 **재사용만** 한다(base 재구현 금지).
이 패키지가 소유하는 것: **라우팅 정책 · 동시성/백프레셔 · isesh 세션 수명주기**.

## 1. 데이터 흐름

```
DocRef[]                     (id, filename, format?, bytes[, path])
   │
   ▼  parseFleet()  ── mapLimit(K) ──►  routeOne(doc)          ← src/router.ts
   │                                        │
   │                    ┌───────────────────┴───────────────────┐
   │        (text/table 형식)                         (pixel: png/jpg/pdf-image/photo)
   │                    ▼                                         ▼
   │         deterministic lane                            AI lane (즉시)
   │         runDeterministicOne()                         SessionPool.submit()
   │         @comfozi/doc-import                           ← src/pool.ts
   │         runParserChainDetailed(                       isesh + imessenger
   │           [textParser, noisyTable, spaceTable])       + 파일드롭 수집
   │                    │
   │        auto: rows<floor 또는 conf<min ?  ── yes ──►  AI lane 폴백
   │                    │ no
   │                    ▼
   │              LaneOutput{ rows, minConfidence }
   ▼
laneRows[][]  ──►  aggregate()  ──►  @comfozi/detectors.analyze()   ← src/aggregate.ts
   ▼
FleetResult{ rows, analyses, routing[], stats }
```

## 2. 라우팅 정책 (src/router.ts)

| 입력 | mode=auto | mode=deterministic | mode=ai |
|---|---|---|---|
| pixel(png/jpg/pdf-image/photo) | AI 즉시 | det 시도(→ 대개 fail-candidate) | AI |
| text/table(csv/xlsx/json/txt/eml/html/md/pdf-text) | det 먼저 → thin이면 AI | det 고정 | AI |

- **thin 판정** `shouldFallback()`: `rows.length < detRowFloor`(기본 1) **또는** `minConfidence < minConfidence`(기본 0.5).
- `classifyFormat()`: `format` 힌트 우선, 없으면 확장자. `.pdf`는 모호 → `pdf-text`로 보고 det 시도(체인이 못 뽑으면 handled:false로 폴백).
- 라우터는 **파싱 로직 0**. 주입된 lane runner(`deterministic`, `ai`)에만 위임 → 타입 온리 모듈, 오프라인 유닛테스트 가능.

## 3. 동시성 / 백프레셔

- 단일 프리미티브 `mapLimit(items, K, worker)` (src/util/mapLimit.ts) — yeonseo `orchestrate.js`의 mapLimit을 타입화. 최대 K 동시, settle-don't-throw.
- 문서 배치는 `parseFleet`에서 `mapLimit(docs, K, routeOne)`으로 팬아웃.
- AI lane 내부는 `SessionPool`이 **K-슬롯 세마포어**(free 리스트 + waiter 큐)로 2차 백프레셔. 라우터가 K로 팬아웃하고 풀도 K면 슬롯은 항상 맞지만, 폴백이 몰릴 때 풀이 독립적으로 직렬화한다.

## 4. AI 세션 수명주기 (src/pool.ts)

yeonseo `bridge/extract.js`·`orchestrate.js`의 **파일드롭 프로토콜**을 그대로 채택:

1. **warm()** — `isesh start <prefix>-parser-i -w <cwd> -d [-p <profile>]` ×K, 각 세션에 `parser-session-contract` 프롬프트를 primer로 `imessenger send`.
2. **submit(doc)** — free 세션 lease → 바이트를 tmp `input-*`에 기록 → `imessenger send "<sess>" '[DOC-EXTRACT] {reqId,filename,inputPath,outPath}'` → **outPath를 폴링**(200ms, 크기 안정 2회 확인 후 read) → `{rows,unreadable}` 검증 → `normalizeAiRows`(applied_date→effective_date, null→'') → `stampParser(_, 'vision-pool')` → 세션 release.
3. **teardown()** — `isesh stop <sess>` ×K, tmp 삭제. `parseFleet`의 `finally`에서 항상 호출.

`PoolTransport{ start, stop, send, collect }`는 **주입 가능** — 기본은 `iseshTransport()`(isesh/imessenger/fs폴링), 테스트/오프라인은 fake 주입.

## 5. 주요 인터페이스 (src/types.ts)

- `DocRef extends DocInput` — doc-import의 DocInput 슈퍼셋(+`path`).
- `FleetOptions` — `mode, concurrency(K), detRowFloor, minConfidence, transport?, deterministicRunner?, aiRunner?, now?, log?`.
- `LaneRunner = (doc, opts) => Promise<LaneOutput{rows, minConfidence?}>` — det/ai 공통 시그니처, 주입 seam.
- `FleetResult` — `rows(ParsedRow[]), analyses(RowAnalysis[]), routing(RouteDecision[]), stats`.

## 6. 오프라인/온라인 경계 (테스트 전략)

- **오프라인 (deps 미설치로도 검증)**: `router.ts`, `util/mapLimit.ts`는 값 런타임 의존이 0(타입 온리 import) → `test/router.test.ts`, `test/mapLimit.test.ts`가 fake runner/transport로 라우팅·동시성 로직 전부 검증.
- **온라인 (glpkg 설치 필요)**: `deterministic.ts`(doc-import 값 import), `pool.ts`(node + doc-import), `aggregate.ts`(detectors), `index.ts`, `cli.ts`는 빌드/실행에 `@comfozi/*` 설치 필요.

## 7. 미해결 이슈 / 블로커

1. **[RESOLVED] isesh 세션 프로그래매틱 spawn/collect** — yeonseo 브리지의 파일드롭+폴링 방식 채택, 실세션 E2E로 검증(PNG 스캔 1건 → vision → RawRow 회신, truth 일치).
   - **파서 프로파일 자기완결화**: `profiles/comfozi-doc-parser.md`를 skit이 직접 소유(components.profiles → `~/.ist/profiles/`). vision(claude 100), bypassPermissions, 최소 도구(Read/Glob/Write). `isesh start -p comfozi-doc-parser`로 기동.
   - **[RESOLVED] 준비완료 레이스**: `isesh start`는 tmux/에이전트 프로세스가 뜨면 즉시 반환하지만 Claude Code 에이전트는 ~20-30s 더 지나야 imessenger 턴을 소비함. 이 창에 보낸 `[DOC-EXTRACT]`는 조용히 유실(초기 타임아웃 원인). → `warm()`에 **READY 핸드셰이크** 도입: ready-file을 Write하라는 프로브를 12s 주기로 재전송하며 파일 출현까지 폴링(기본 120s). 재전송이 busy(exit 6)를 자연스럽게 흡수.
   - **남은 TODO**: `imessenger` busy(6)/승인대기(5) 코드의 **명시적** 재시도/백오프는 submit 경로엔 아직 미도입(readiness가 세션을 idle 보장하므로 실무상 충분). 다건/고동시성에서 강화 여지.
2. **[RESOLVED] PDF/이미지 rasterization** — `rasterizePdf()`가 `pdftoppm -r 150 -png`로 페이지 팬아웃 → `imagePaths:[{path,page}]` payload. PNG/JPG는 `imagePath` 단건. (poppler 필요)
3. **normalizeAiRows는 최소 포트** — extract.js `validateRows`의 엄격 검증(단위 화이트리스트, 날짜 정규식, confidence 모순 체크 등)을 축약. 알 수 없는 키(예: 에이전트가 추가한 `source_type_hint_in_doc`)는 무시. 데모 전 강화 여지.
4. **결정적 체인 구성 확정 필요** — `[deterministicTextParser, noisyTableParser, spaceTableParser]` 선택은 doc-import export 기준 추정. `buildChain()`/`defaultChain`이 더 정확한 조합일 수 있음(defaultChain은 vision 포함 가능성 → 결정적 lane에선 배제 필요).
5. **provenance row 재스탬프** — aggregate가 물리 행번호를 최종 위치로 덮어씀. doc별 원본 행번호 보존이 필요하면 정책 재검토.
6. **의존성 설치(glpkg)** — `@comfozi/contract|detectors|doc-import`는 glpkg 그룹 `blaybus2026-vibe`. build/online-test 전에 설치 필요(오너 게이트).

## 8. 1차 구현 범위 (이 스캐폴드)

- ✅ 라우터 골격(정책·분류·폴백) + 오프라인 테스트 통과 목표
- ✅ 결정적 lane: doc-import 실제 API 래핑(설치 후 동작)
- ✅ AI 풀 인터페이스: 세마포어·파일드롭·수명주기 + 주입형 transport(오프라인 stub 가능)
- ✅ aggregate + detectors 배선
- ✅ CLI(parse), skit.json(cli+prompt), 세션 계약 프롬프트
- ⏳ 실제 isesh 세션 E2E, PDF rasterization, 엄격 검증 강화, 프로필 설치 = 데모타임/후속
