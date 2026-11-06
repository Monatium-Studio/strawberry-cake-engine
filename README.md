<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/strawberry-cake-engine.svg">
    <img alt="STRAWBERRY CAKE ENGINE" src="brand/strawberry-cake-engine-light.svg" width="560">
  </picture>
</p>

**한국어** · [English](README.en.md) · [日本語](README.ja.md)

# strawberry-cake-engine

three.js + Rapier로 만든 작은 웹 3D 게임 엔진입니다. 고정 스텝 루프, 물리, 실행 중에 굽는 내비메시와 에이전트, 리그 캐릭터 컨트롤러,
툰 셰이딩, 닫힌 섀도 루트 UI, 다국어(ko·en·ja)를 담았습니다. 장르를 가리지 않는 범용 부분만 모았습니다.

## 모듈

| 모듈 | 내용 |
|---|---|
| `core` | `Engine`(60 Hz 고정 스텝 + 렌더 보간, 겹침 3D 층, 같은 페이지 화면 전환 `reset`), 설정, 그래픽 품질 「자동」 렌더 배율, GPU 자원 장부, 입력(액션 바인딩·포인터 락), glb 에셋 캐시, 화면 흐름(`ScreenFlow`), 판 수명(`session`) |
| `render` | 툰 머티리얼·인버티드 헐 외곽선, glb 로더, 정적 메시 굽기, 움직이는 부품 합치기(`rigidMerge`), 행렬 얼리기·구역 거르기, 숨은 물체 행렬 건너뛰기, 화면 굴절, 로그 깊이 패치 |
| `physics` | Rapier 래퍼, 렌더 메시 BVH 레이캐스트(`RaycastGeometry`, `visualRaycast`·`lineOfSight`), 콜라이더 변경 도장, 캐릭터 이동을 워커에서 계산하는 물리 거울(`mirror`) |
| `audio` | WebAudio 엔진(버스·미리 로드·풀·3D·잔향·음악 크로스페이드), 큐표 음악 감독, 표면 인식 발소리 |
| `level` | 노드 이름 규칙으로 읽는 glb 레벨 로더(마커·문·트리거·카메라 레일·등), 프레임 예산 안에서 나눠 읽기 |
| `character` | 리그 캐릭터 컨트롤러(자세·몸짓·시선·손 IK·표정·땅 붙이기), 마커로 세우는 캐릭터 묶음, 애니메이션 예산 |
| `nav` | 워커로 굽는 타일 내비메시(Recast/Detour), 동적 장애물, 뛰어내리기·넘기 링크, 조향 에이전트, 디버그 표시 |
| `cinematic` | 카메라 레일, 연출 카메라(`CameraDirector`), 컷 실행기(`ShotRunner`), 점 입자 |
| `ui` | 닫힌 섀도 루트 UI(`uiRoot`·`adoptStyle`), 스크린샷(Ctrl+Alt+Shift+P), 웹 글꼴(선택), 로딩 화면, 일시정지·설정 메뉴 |
| `i18n` | 문자열 사전·원문 카탈로그·언어 선택 화면 |
| `intro` | 로고 카드 인트로(`Intro`). 첫 카드는 언제나 「Produced by MONATIUM STUDIO · Powered by STRAWBERRY CAKE ENGINE」이고, 게임은 그 뒤에 자기 카드를 붙입니다 |

도구: 대사집 편집기(`npm run lines`), 다국어 점검·채우기(`npm run i18n:check`, `i18n:fill`), 섀도 DOM용 Playwright 도우미(`scripts/uiDom.mjs`),
Blender 헤드리스 → glb → 스크린샷 파이프라인(`npm run model`, `npm run shot`), 예제 점검(`npm run examplecheck`).

자세한 구조는 [docs/ENGINE.md](docs/ENGINE.md), 레벨 노드 규칙은 [docs/LEVELS.md](docs/LEVELS.md), 다국어는 [docs/I18N.md](docs/I18N.md),
에셋 파이프라인은 [docs/ASSETS.md](docs/ASSETS.md).

## 빠른 시작

```bash
npm install
npm run dev        # http://127.0.0.1:5173/ → examples/basic
npm run typecheck
npm run build
```

```ts
import * as THREE from 'three';
import { Engine, Physics, Assets, buildLevel, buildNav, toonMaterial, applyOutlines, uiContainer } from 'strawberry-cake-engine';

const engine = new Engine(uiContainer());
const physics = await Physics.create();
const root = new THREE.Group();
root.add(new THREE.Mesh(new THREE.BoxGeometry(20, 1, 20), toonMaterial(0xf3e9d8)));
applyOutlines(root);
const level = await buildLevel({ engine, physics, assets: new Assets() }, root, { id: 'demo', path: 'code:demo' });
level.attach(engine);
engine.add(level);
engine.add({ fixedUpdate: () => physics.step() });
const nav = await buildNav(level, { traverse: false });
const agent = nav.createAgent(new THREE.Vector3(0, 0, 0), { mode: 'drive' });
agent.moveTo(new THREE.Vector3(5, 0, 5));
engine.add({ update: (dt) => agent.update(dt) });
engine.start();
```

웹 글꼴은 기본으로 싣지 않습니다(시스템 글꼴). 한글 UI라면 [Pretendard](https://github.com/orioncactus/pretendard)(SIL OFL 1.1) 같은 글꼴을 직접 설치해 쓰세요.

```ts
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { setUiFonts } from 'strawberry-cake-engine';
setUiFonts({ sansFaces: ["'Pretendard Variable'"], faces: { ko: ['Pretendard Variable'], en: ['Pretendard Variable'] } });
```

## 예제

`examples/basic`: 기본 도형만으로 만든 장면입니다.

- 바닥과 장애물, 경사로와 단, 받침대 위에서 도는 툰 셰이딩 매듭
- 실행 중에 워커로 굽는 내비메시 (`N`으로 보기)
- 땅을 클릭하면 캡슐(Rapier 캐릭터 컨트롤러)이 내비 에이전트를 따라 걷기
- 닫힌 섀도 루트 UI와 일시정지·설정 메뉴(`Esc`: 언어·시야각·그래픽)
- 한국어·영어

`npm run examplecheck`가 헤드리스 Chrome으로 예제를 띄워 스크린샷을 찍고, 땅을 클릭해 캡슐이 도착하는지, 언어가 바뀌는지, 콘솔 오류가 없는지 봅니다.

## AI 생성 자료

이 저장소의 코드와 문서는 AI(Anthropic의 Claude)를 활용해 작성되었습니다. Monatium Studio가 방향을 정하고 결과를 확인했습니다.

## 라이선스

MIT. © 2026 Monatium Studio. [LICENSE](LICENSE)

함께 쓰거나 옮겨 온 서드파티 코드의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.

## 로고

`brand/`의 로고와 인트로 첫 카드 그림(`src/intro/assets/`)은 Monatium Studio와 이 엔진을 나타내는 표장입니다. MIT 라이선스는 상표권을 주지 않습니다.
엔진을 쓰는 게임은 인트로 첫 카드를 그대로 보여 주면 됩니다. 로고를 고치거나 다른 표장처럼 쓰지 말아 주세요.

- 스트로베리 케이크 엔진 로고: Monatium Studio의 오리지널 디자인입니다.
- 모나티엄 스튜디오 로고의 톱니 마크: EPIDGames의 「트릭컬 리바이브」 엘프 종족 아이콘을 벡터로 따라 그렸습니다. Trickcal, Trickcal:Revive 및 기타 파생 브랜드는 EPIDGames의 등록상표입니다.
- 로고 글자: Krona One, Michroma, Bagel Fat One(Google Fonts, SIL Open Font License)의 윤곽선입니다. 생성기: `tools/brand/gen_brand.py`

