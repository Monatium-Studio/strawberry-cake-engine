import type { IntroCard } from './Intro';
import { CREDITS_LAYERS, CREDITS_SHEEN, CREDITS_STAGE } from './credits.layout';
import creditsCss from './credits.css?inline';

/**
 * 엔진 인트로의 첫 카드: 왼쪽 「PRODUCED BY / MONATIUM STUDIO」, 오른쪽 「POWERED BY / STRAWBERRY CAKE ENGINE」.
 * 레이어 그림과 배치(credits.layout.ts, assets/credits-*.svg)는 tools/brand/gen_brand.py가 만든다.
 */
export function creditsCard(): IntroCard {
  return {
    id: 'credits',
    label: 'Produced by MONATIUM STUDIO · Powered by STRAWBERRY CAKE ENGINE',
    stage: CREDITS_STAGE,
    layers: CREDITS_LAYERS,
    sheen: CREDITS_SHEEN,
    holdMs: 3400,
    height: 'min(46cqh, 23cqw)',
    css: creditsCss,
  };
}
