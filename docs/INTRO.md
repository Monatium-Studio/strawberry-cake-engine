# 인트로: 로고 카드

`Intro`(`src/intro/Intro.ts`)는 페이지를 연 첫 화면에서 로고 카드를 차례로 보여 주고 타이틀로 넘어간다.

1. **엔진 카드** (언제나 첫 번째, 약 3.4초): 왼쪽 「PRODUCED BY / MONATIUM STUDIO」, 가운데 세로선, 오른쪽 「POWERED BY / STRAWBERRY CAKE ENGINE」
2. **게임 카드** (`cards`로 넘긴 순서대로): 퍼블리셔·위원회 같은 게임 쪽 로고
3. 타이틀로 페이드 (0.7초)

엔진 카드는 빼거나 뒤로 옮길 수 없다. 같은 id(`credits`)의 카드를 넘기면 무시한다.

## 쓰는 법

```ts
import { Intro, type IntroCard } from 'strawberry-cake-engine';

const myCard: IntroCard = {
  id: 'publisher',                 // CSS 클래스 sce-intro-card--publisher, onCue('publisher')
  label: 'ACME PUBLISHING',        // 화면 낭독기용
  stage: [1200, 560],              // 무대 좌표계
  layers: [
    { id: 'mark', url: '/intro/mark.svg', box: [500, 80, 200, 200], origin: [600, 180] },
    { id: 'word', url: '/intro/word.svg', box: [300, 320, 600, 120], origin: [600, 380] },
  ],
  sheen: '/intro/sheen-mask.svg',  // 선택: 무대 크기 마스크, 띠 움직임은 css에서
  holdMs: 3000,
  css: `.sce-intro-card--publisher { background: #101418; }
        .sce-intro-card--publisher.is-active .L-mark { animation: sce-intro-rise 0.8s ease-out 0.2s both; }`,
};

await new Intro(uiContainer(), { cards: [myCard], onCue: (cue) => audio.sting(cue) }).play();
```

- 레이어는 `<img>`로 불러 준비 단계(검은 화면, 최대 2.5초)에서 지금 화면 크기의 canvas로 미리 그린다. 조명 필터가 든 SVG도 카드 첫머리에서 끊기지 않는다.
- 애니메이션은 카드 CSS에서 레이어(`.L-<id>`)의 `transform`·`opacity`만 바꾼다. 기준점은 레이어의 `origin`이다.
- 공통 키프레임: `sce-intro-fade`(나타나기), `sce-intro-rise`(아래에서 떠오르기)
- 인트로를 틀지 말지는 게임이 정한다 (예: 같은 페이지 안에서 타이틀로 돌아올 때, `?nointro=1`, 자동 점검).

## 조작

| 항목 | 내용 |
|---|---|
| 클릭·아무 키 | 지금 카드를 넘긴다. 전환 중이면 다음 카드를 넘긴다. 키 반복은 무시하고 180 ms 디바운스 |
| Esc | 전부 건너뛴다 |
| 건드리지 않는 키 | Ctrl·Cmd·Alt 조합, F1~F12 |
| 움직임 줄이기 | `prefers-reduced-motion: reduce`이면 페이드만 |
| 음향 훅 | `onCue(카드 id)`가 카드가 나타날 때, `onCue('title')`이 타이틀로 넘어갈 때 |
| 점검 | `window.__intro.phase`, `window.__intro.waitFor(phase, ms)`, `cardIds` |

## 엔진 카드 그림

`tools/brand/gen_brand.py`가 만든다. 정적 로고(`brand/*.svg`)와 인트로 레이어(`src/intro/assets/credits-*.svg`, 배치 `src/intro/credits.layout.ts`)를 같은 원본에서 뽑는다.

```bash
python3 -I tools/brand/gen_brand.py . <fonts_dir>   # KronaOne-Regular.ttf, Michroma-Regular.ttf, BagelFatOne-Regular.ttf
```

| 파일 | 용도 |
|---|---|
| `brand/monatium-studio.svg`, `-light.svg` | 모나티엄 스튜디오 가로 로고 (어두운 바탕 / 밝은 바탕) |
| `brand/strawberry-cake-engine.svg`, `-light.svg` | 엔진 가로 로고 (어두운 바탕 / 밝은 바탕) |
| `brand/strawberry-cake-engine-mark.svg` | 엔진 마크만 (정사각형) |

엔진 마크: 딸기 조각 케이크. 잘린 면은 크림·스펀지·딸기 단면 띠이고, 위에 앉은 딸기의 꼭지가 8톱니 바퀴다 (엔진이라는 뜻, 모나티엄 스튜디오의 톱니와 짝).
연출: 톱니가 돌며 서고 → 케이크가 통통 놓이고 → 딸기가 떨어져 튀어 앉고 → 글자가 나오고 → 광택 띠가 왼쪽 로고에서 오른쪽 로고로 지나간다.
