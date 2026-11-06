// 생성 파일: tools/brand/gen_brand.py. 손으로 고치지 않는다.
import type { IntroLayer } from './Intro';

export const CREDITS_STAGE: [number, number] = [1800, 460];

export const CREDITS_LAYERS: IntroLayer[] = [
  { id: 'divider', url: new URL('./assets/credits-divider.svg', import.meta.url).href, box: [898.0, 110, 4, 290], origin: [900.0, 255] },
  { id: 'ms-gear-shadow', url: new URL('./assets/credits-ms-gear-shadow.svg', import.meta.url).href, box: [107.48, 173.26, 182.7, 185.44], origin: [198.59, 268.56] },
  { id: 'ms-gear', url: new URL('./assets/credits-ms-gear.svg', import.meta.url).href, box: [124.7, 190.47, 148.26, 143.05], origin: [198.59, 264.43] },
  { id: 'ms-word', url: new URL('./assets/credits-ms-word.svg', import.meta.url).href, box: [291.81, 214.15, 487.47, 73.7], origin: [535.54, 251.0] },
  { id: 'ms-sub', url: new URL('./assets/credits-ms-sub.svg', import.meta.url).href, box: [289.53, 286.02, 488.42, 37.23], origin: [533.74, 304.63] },
  { id: 'en-cake', url: new URL('./assets/credits-en-cake.svg', import.meta.url).href, box: [1035.11, 235.84, 147.86, 106.72], origin: [1099.4, 320.69] },
  { id: 'en-berry', url: new URL('./assets/credits-en-berry.svg', import.meta.url).href, box: [1095.42, 182.73, 56.83, 75.22], origin: [1123.83, 251.26] },
  { id: 'en-word', url: new URL('./assets/credits-en-word.svg', import.meta.url).href, box: [1188.97, 216.8, 483.63, 53.11], origin: [1430.79, 243.35] },
  { id: 'en-sub', url: new URL('./assets/credits-en-sub.svg', import.meta.url).href, box: [1196.64, 279.25, 472.11, 25.38], origin: [1432.69, 291.94] },
  { id: 'lbl-produced', url: new URL('./assets/credits-lbl-produced.svg', import.meta.url).href, box: [127.44, 110.52, 237.57, 23.72], origin: [133.44, 122.38] },
  { id: 'lbl-powered', url: new URL('./assets/credits-lbl-powered.svg', import.meta.url).href, box: [1033.84, 110.52, 220.66, 23.72], origin: [1039.84, 122.38] },
];

export const CREDITS_SHEEN = new URL('./assets/credits-sheen-mask.svg', import.meta.url).href;
