# 엔진 구조

three.js(렌더) + Rapier 0.21(물리, WASM) + Recast/Detour(내비, WASM) + Vite + TypeScript.

## 모듈

| 경로 | 역할 |
|---|---|
| `src/core/Engine.ts` | 렌더러, 월드·겹침(overlay) 씬, 고정 스텝 루프(60 Hz) + 렌더 보간, 리사이즈, `reset()`(같은 페이지 화면 전환), `afterNextRender` |
| `src/core/config.ts` | 상수(`FIXED_DT`, `MAX_FIXED_STEPS` …)와 사용자 설정(localStorage, `configureSettings({ storageKey })`) |
| `src/core/quality.ts` | 그래픽 품질 단계와 「자동」 렌더 배율 조절(`AutoQuality`) |
| `src/core/gpu.ts` | GPU 자원 장부: 화면을 바꿀 때 앞 화면이 올린 형상·재질·텍스처를 놓는다(`sweepGpu`) |
| `src/core/Input.ts` | 액션 바인딩(게임이 액션 표를 준다), 포인터 락, 엣지 입력, Ctrl 조합 처리, `simulate()` |
| `src/core/Assets.ts` | glb 캐시와 복제(스키닝 포함, 뼈대 공유). 없는 에셋은 null |
| `src/core/session.ts` | 판 수명: 화면이 끝날 때 모듈 상태·창 이벤트를 되돌린다 |
| `src/core/flow.ts` | `ScreenFlow`: 같은 페이지에서 화면 바꾸기(문서를 다시 읽지 않는다) |
| `src/render/toon.ts`, `loader.ts`, `variants.ts` | 툰 머티리얼, 인버티드 헐 외곽선, glb 로딩, 셰이더 프로그램 갈래 나누기 |
| `src/render/bake.ts`, `rigidMerge.ts` | 정적 메시 합치기(정점 색), 움직이는 부품 모델을 뼈 하나 가중치 1 스킨 메시로 합치기 |
| `src/render/staticMatrices.ts`, `hiddenMatrices.ts` | 움직이지 않는 묶음의 행렬 얼리기·화면 밖 구역 거르기, 숨은 물체 행렬 갱신 건너뛰기 |
| `src/render/warp.ts`, `logDepth.ts` | 화면 굴절(충격파·아지랑이), 로그 깊이 버퍼용 셰이더 패치 |
| `src/physics/Physics.ts` | Rapier 월드, 정적 박스·트라이메시, 레이캐스트, 콜라이더 → 소유자, 보이는 형상 레이(`visualRaycast`·`lineOfSight`) |
| `src/physics/RaycastGeometry.ts` | 렌더 메시 BVH(three-mesh-bvh): 레벨 정적 묶음 + 동적 뿌리. 종류는 `solid`(막음)·`pass`(유리·잎처럼 지나가며 모음) |
| `src/physics/colliderWatch.ts` | 콜라이더·몸 변경 도장(Wasm에서 읽은 값 캐시) |
| `src/physics/mirror/*` | 물리 거울 워커: 캐릭터 컨트롤러 이동을 워커의 같은 모양 월드에서 계산 |
| `src/audio/Audio.ts` | WebAudio 엔진: 버스(master·music·sfx·ui·voice), 버퍼 미리 로드, 노드 사슬 풀, 동시 재생 제한, 3D 패너, 잔향, 음악 크로스페이드 |
| `src/audio/music.ts` | 음악 감독: 큐표(`MusicCue`)로 곡·장면 음량을 푼다, 대사 덕킹 |
| `src/audio/footsteps.ts` | 캐릭터 발소리: 발밑 표면(보이는 형상 레이), 거리 예산 |
| `src/level/*` | glb 레벨 로더(노드 이름 규칙: [LEVELS.md](LEVELS.md)), 문, 트리거, 카메라 레일, 등 묶음, 나눠 읽기(`Slicer`) |
| `src/character/*` | 리그 캐릭터 컨트롤러(`Character`), 마커로 세우는 묶음(`CharacterSet`), 애니메이션 예산, 표정, 땅 붙이기, 손 IK, 자세 표 |
| `src/nav/*` | 타일 내비메시 굽기(워커), 동적 장애물, 뛰어내리기·넘기 링크, 조향 에이전트, 디버그 표시 |
| `src/cinematic/*` | 카메라 레일(카트멀롬), 연출 카메라(`CameraDirector`), 컷 실행기(`ShotRunner`), 점 입자 |
| `src/ui/*` | 닫힌 섀도 루트 UI(`uiRoot`), 스크린샷, 글꼴, 로딩 화면, 일시정지·설정 메뉴 |
| `src/i18n/*` | ko·en·ja 문자열 사전, 한국어 원문 카탈로그(`tx`), 언어 선택 화면 |

## 렌더 순서

1. world 씬을 `camera`로 그린다. 그리기 전에 얼린 노드 점검(`checkFrozen`)과 화면 밖 구역 숨기기(`cullSectors`).
2. 화면 굴절 효과가 살아 있으면 그린다 (world 깊이로 가려 가며).
3. overlay 씬에 조명 말고 그릴 것이 있으면 depth를 지우고 `overlayCamera`로 그린다 (1인칭 손에 든 물건처럼 벽에 묻히지 않는 3D 층. FOV를 따로 쓴다. 주광 방향은 매 프레임 카메라 공간으로 옮겨 월드와 맞춘다).
4. DOM 층(HUD·메뉴)은 닫힌 섀도 루트 안에서 캔버스 위에 얹힌다.

## 시간

- 고정 스텝 60 Hz(`FIXED_DT`)에 `System.fixedUpdate(dt)`, 매 렌더 프레임에 `System.update(dt, alpha)`.
- 한 프레임에 도는 고정 스텝은 `MAX_FIXED_STEPS`(4)까지. 넘친 몫은 버리고 프레임 dt에서도 빼서 스크립트 시계와 물리가 같이 느려진다.
- 고정 스텝이 한 번 이상 돈 프레임 끝에 `engine.onAfterFixed`(보통 `input.endFrame()`). 한 프레임에 고정 스텝이 두 번 돌면 `wasPressed`가 두 번 참이니 엣지는 프레임당 첫 스텝에서만 읽는다.
- `engine.timeScale`(슬로모션), `engine.paused`(고정 스텝 멈춤, 렌더는 계속).

## 성능 규칙

- **그리기 호출**: 움직이지 않는 부품은 `bakeStatic`으로 합친다. 색만 다른 툰 머티리얼은 흰 머티리얼 + 정점 색 하나로, 외곽선은 정점 색 외곽선 하나로. 움직이는 노드(keep)와 메시가 아닌 노드는 남는다. 움직이는 부품이 많은 모델은 `rigidMerge`.
- **셰이더 프로그램 재선택**: 머티리얼 하나를 갈래(스키닝·모프·정점색 성분 수)가 다른 메시가 같이 쓰거나, 투명 + 양면이면 three가 그릴 때마다 프로그램을 다시 고른다. `splitProgramVariants`가 모델을 읽을 때 나눈다.
- **행렬 갱신**: 레벨의 움직이지 않는 묶음은 얼린다(아래). 숨은 캐릭터 뿌리 아래는 렌더 행렬 갱신을 건너뛴다(`cullHiddenMatrices`).
- **스킨 뼈대**: `SkeletonUtils.clone`은 스킨 메시마다 Skeleton을 따로 만든다. `Assets.instance`가 `shareSkeletons`로 같은 뼈를 쓰는 메시를 Skeleton 하나로 묶는다. 다른 길로 복제하면 `shareSkeletons`를 같이 부른다.
- **애니메이션**: 캐릭터 자세 갱신은 `animBudget`(프레임당 1 ms, 화면 안 가까운 것은 매 프레임, 나머지는 중요도 순, 미룬 dt는 모아 넘김)을 거친다.
- **매 프레임 낭비**: DOM 크기를 매 프레임 읽지 않는다(레이아웃 강제). `getObjectByName`은 트리 전체를 뒤지니 한 번 찾아 둔다. CSS 애니메이션 다시 걸기는 `replayClass`(한 프레임 늦게 붙여 강제 레이아웃을 피한다).

## 정적 행렬 (`render/staticMatrices.ts`)

three는 렌더마다 모든 물체의 matrix·matrixWorld를 다시 곱고 보이는 물체를 모두 돌며 화면 거르기를 한다. 움직이지 않는 레벨 물체 수천 개도 매 프레임 그렇다.

- **나누기**: 레벨이 처음 붙을 때(`Level.attach` → `freezeStatic`) 뿌리 아래를 나눈다. 움직이는 노드가 하나도 없는 가장 큰 묶음을 얼린다: 행렬을 한 번 계산하고 묶음 뿌리의 `updateMatrixWorld`·`updateWorldMatrix`를 인스턴스 함수로 바꿔, 부모 matrixWorld가 바뀌었을 때만 묶음 전체를 다시 곱한다.
- `matrixAutoUpdate`·`matrixWorldAutoUpdate` 플래그는 건드리지 않는다. 얼린 노드를 복제해도 멀쩡하고 `getWorldPosition`·레이캐스트는 그대로 맞다.
- **움직이는 노드**(얼리지 않는다): 문(`DOOR_`), `drift`·`spin` 노드, 원경(`skyNode`), glb 애니메이션 대상, `MOVING_PROPS` 속성 노드, 뼈·스킨 메시·카메라, 코드가 matrix를 직접 쓰는 노드, 자기 `updateMatrixWorld`를 가진 노드. 노드 이름만으로 코드가 움직이는 것은 옮기기 전에 `unfreeze(node)`, 얼리기 전이면 `markDynamic(node)`. 얼린 노드에 자식을 붙일 때도 `unfreeze(부모)`.
- **안전망**: 그리기 전에 얼린 노드의 위치·회전·축척·자식 수를 얼릴 때 값과 비교한다. 바뀐 노드는 움직이는 노드로 바꾸고 그 묶음만 다시 나눈다. 개발 서버는 매 프레임 전부 보고 경고하고, 빌드는 레벨마다 프레임당 1,024개씩 돌아가며 본다.
- **화면 거르기 구역**: 그릴 것이 있는 얼린 묶음은 경계 구를 둔다. 그리기 직전 화면 밖 구역을 그 렌더 동안만 숨기고 렌더 뒤 바로 되돌린다. 조명·InstancedMesh·`frustumCulled = false`를 품은 묶음은 거르지 않는다.
- 끄기: `?staticmatrix=0`, `?sectors=0`.

## 보이는 형상 레이 (`physics/RaycastGeometry.ts`, `level/visual.ts`)

이동 충돌체(박스·볼록 껍질)는 걷기용이라 틈을 덮는다. 시야·클릭 지점·맞은 자리 연출·땅 높이처럼 보이는 면에 정확히 맞아야 하는 질의는 렌더 메시 BVH를 쓴다.

- 레벨 정적 묶음: 움직이지 않는 메시를 월드 좌표로 합친 BVH(종류별 `solid`, `pass`). 레벨 루트를 옮기면 레이를 만든 때의 좌표로 옮겨 찾는다.
- 동적 뿌리: 스크립트가 끄고 켜거나 옮기는 노드. 메시마다 로컬 BVH(같은 지오메트리는 한 번)를 두고 질의할 때의 matrixWorld·visible을 본다.
- 레벨 규칙(`classifyVisualMesh`): 외곽선 헐·UNLIT·반투명·연기·데칼(`_fine`)은 무시, 유리·잎 머티리얼은 `pass`, 노드 속성 `ray=0|pass|1`이 우선. 레벨의 이동 충돌체는 `setVisualProxy`로 보이는 형상 레이에서 빠진다.
- Rapier 월드와 따로 있어서 캐릭터 컨트롤러·내비 굽기는 이 형상을 보지 않는다.

## 내비게이션 (`src/nav`)

- **굽기**: `buildNav(level, opts)`. 레벨의 정적 충돌체를 삼각형으로 모아(`levelGeometry`) 타일 캐시로 굽는다. 층 굽기(복셀화)는 워커(`bake.worker.ts`, 기본 코어 수 − 2, 1~4개)에서 하고 타일 캐시 조립은 메인 스레드에서 프레임 예산(`Slicer`) 안에 나눠 한다.
- **씨앗과 가지치기**: `SPAWN_`·`WP_`·`MARK_`·`TRIG_` 마커가 있으면 그 자리에서 이어지지 않는 섬(상자 윗면 등)을 뺀다. 마커가 없으면 전체를 남긴다.
- **링크**: 낮은 턱에서 뛰어내리는 한 방향 링크(`dropLinks`), 넘기·오르기 링크(`traverse`, 높이는 `TRAVERSE` 설정). 노드 속성 `climb=0`, 막는 부피(`addTraverseBlocker`), 넘지 않는 메시 이름 규칙(`climbRules.noClimbMesh`).
- **동적 장애물**: 문(`DOOR_`)과 움직이는 장애물(`MovingObstacle`)의 발자국을 타일 캐시 장애물로 깎는다. 넣기·빼기는 고정 스텝당 몇 개씩, 타일 다시 만들기는 `NavWorld.update(maxTiles, maxMs)` 예산 안에서.
- **에이전트**: `nav.createAgent(pos, { mode })`. `steer`는 원하는 수평 속도를 돌려주고 위치는 캐릭터(예: Rapier 캐릭터 컨트롤러)가 정한다. `drive`는 물리 없이 내비메시 위를 스스로 걷는다. 앞보기로 매끄럽게, 다른 에이전트와 비키기, 막히면 다시 찾기.
- **WASM 메모리**: recast-navigation 0.44 생성기의 누수 수정과 같은 것을 우리 굽기(`generate.ts`)에 넣었다. 같은 레벨을 다시 구워도 힙이 늘지 않는다.

## 물리 거울 워커 (`physics/mirror`)

캐릭터 컨트롤러 이동(`computeColliderMovement`)을 워커의 거울 월드에서 계산할 수 있다. 캐릭터가 많아 메인 스레드 Rapier 시간이 클 때 쓴다.

- **기록** (`recorder.ts`): `Physics.create({ mirror: { queryGroups } })`로 만든 월드만. Rapier `World`·`RigidBody`·`Collider` 프로토타입의 생성·제거·자세·켜짐·센서·그룹·모양 메서드를 한 번 감싸 바뀐 handle만 모으고, 고정 스텝마다 그 순간 상태를 스냅샷으로 낸다. 콜라이더 분류(`CLS_*`)는 게임이 소유자로 정한다(`recorder.classify`).
- **거울 월드** (`core.ts`, `mirror.worker.ts`): 같은 몸 종류·모양·밀도·그룹·센서·켜짐. 키네마틱 몸은 다음 자세로만 옮겨 움직이는 발판이 메인과 같게 캐릭터를 실어 나른다. 거르기도 메인과 같게 그룹 + 술어(분류표).
- **주의**: 정확히 겹친 캡슐처럼 Rapier 결과가 BVH 열거 순서에 달린 경우 거울과 메인이 드물게 다르다. 게임이 늦은 답·실패 때 메인에서 바로 계산하는 길을 둔다.

## 캐릭터 땅 붙이기 (`character/ground.ts`)

걷는 캐릭터(`Character.walk`)는 경로점 사이를 수평으로 곧게 가고 높이는 땅에서 얻는다.

- **질의**: 보기만 하는 세트는 `MeshGround`(보이는 solid 메시, 메시마다 BVH), 게임 레벨은 `RapierGround`(고정 충돌체만, 센서 제외). 할당 없음.
- **걷기**: 0.25 m 앞을 표본으로 찍어 지난 표본과 잇는다. 레이는 발 바로 위에서 쏜다. 표본 하나에 크게 오르는 면(길이 지나가는 상자)에는 올라서지 않는다. 가파른 구간(사다리)은 경로점 높이.
- **계단**: 표본 둘의 높이 차가 4 cm를 넘으면 0.1 m 간격으로 다시 찍는다. 계단 충돌체가 단 코를 잇는 경사판이면 `RapierGround`가 보이는 디딤판 높이를 다시 찾는다.
- 캐릭터 컨트롤러로 걷는 캡슐은 `TreadFeet`로 보이는 모델만 발밑 땅에 맞춘다.

## 화면 전환: 같은 페이지 (`core/flow.ts`, `core/session.ts`)

새 문서는 사용자 제스처가 없어 AudioContext가 잠긴 채 시작하고 클릭할 때까지 소리가 안 난다. 그래서 화면(메뉴 ↔ 레벨, 처음부터)은 같은 `Engine` 위에서 바꾸고 주소는 `history.replaceState`로만 바꾼다.

- `ScreenFlow.go(name, params)`: 떠나는 화면의 걷기 → `endSession()` → `Engine.reset()` → 다음 화면.
- `Engine.reset()`: 시스템·월드를 비우고 조명·안개·카메라·렌더러 값을 처음으로 되돌리고, 앞 화면이 GPU에 올린 것을 모두 놓는다.
- **모듈 수준 상태는 판이 끝나면 처음으로 되돌린다**: 상태 객체는 `const S = sessionState(() => ({ … }))`, 그 밖의 캐시·플래그는 `onSessionEnd(() => …)`, 창·문서 이벤트는 `{ signal: sessionSignal() }`, `onLangChange`의 구독도 판이 끝나면 뗀다.
- 캐시 열쇠에 불러온 템플릿의 `uuid`나 객체 자체를 쓰면 그 판 안에서만 맞는다: 원본에 약하게 묶거나(`WeakMap`) 판 끝에 비운다(`clearBakeCaches`·`clearRigidMergeCaches`).
- 라이브러리 안쪽 캐시도 본다: Recast(emscripten)는 포인터마다 만든 래퍼를 클래스의 `__cache__`에 영영 두어 판 끝에 비운다(`nav/index.ts`).
- `<audio>` + `MediaElementAudioSourceNode`는 AudioContext가 살아 있는 동안 놓이지 않는다: 음악 데크는 요소를 버리지 않고 다시 쓴다.

## 오디오 (`src/audio`)

- **깨우기**: 브라우저는 입력 전 AudioContext를 멈춰 둔다. 첫 pointerdown·keydown(Esc 제외)에서 깨운다(`autoUnlock`).
- **버스**: `music`, `sfx`, `ui`, `voice` → `master`. 볼륨은 `Settings.*Volume`.
- **효과음**: 버퍼는 묶음(`group`)으로 미리 디코드한다. 재생마다 변형 파일 무작위 선택, 피치·볼륨 흔들기, 큐별 동시 재생 상한, 최소 간격. 노드 사슬은 풀에서 다시 쓴다.
- **3D**: `spatial` 큐는 `PannerNode`(equalpower, inverse). 리스너는 게임이 매 프레임 카메라에 맞춘다.
- **음악**: `<audio>` 스트리밍 + `MediaElementSource`, 곡 끝을 처음과 겹쳐 반복, 크로스페이드. 음악 감독(`MusicDirector`)이 큐표로 푼다.
- **탭 숨김**: AudioContext와 음악을 멈췄다가 돌아오면 다시 켠다.

## UI (`src/ui`)

- 모든 UI DOM은 문서의 호스트(`#game`)에 단 닫힌 섀도 루트 안(`uiContainer()`)에 둔다. 번역기·광고 차단 같은 확장의 MutationObserver가 매 프레임 바뀌는 HUD를 보지 않는다.
- UI CSS는 `adoptStyle(id, css)`로 그 루트에 붙인다(`?inline` 가져오기). 문서에는 페이지 자체(html·body·호스트)와 @font-face만.
- DOM 찾기·포커스는 `uiRoot()`로, 점검 스크립트는 `window.__ui`로(`scripts/uiDom.mjs`). 창에 건 리스너는 섀도 안 이벤트의 target을 호스트로 받으니 진짜 요소는 `e.composedPath()[0]`.
- 스크린샷(Ctrl+Alt+Shift+P, 맥 ⌘⌥⇧P): 렌더 직후 3D를 옮기고 같은 프레임에 DOM 층을 복제해(modern-screenshot, 처음 쓸 때 불러옴) 합친다. PNG 인코딩은 워커.
- 글꼴: 기본은 시스템 글꼴. 웹 글꼴은 게임이 CSS를 불러오고 `setUiFonts`로 앞에 둔다(README).
