<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/strawberry-cake-engine.svg">
    <img alt="STRAWBERRY CAKE ENGINE" src="brand/strawberry-cake-engine-light.svg" width="560">
  </picture>
</p>

[한국어](README.md) · **English** · [日本語](README.ja.md)

# strawberry-cake-engine

A small web 3D game engine built on three.js and Rapier. It has a fixed-step loop, physics, a navmesh baked at runtime with steering agents,
a rigged character controller, toon shading, a closed Shadow DOM UI, and i18n (ko, en, ja). Only genre-neutral parts are included.

## Modules

| Module | Contents |
|---|---|
| `core` | `Engine` (60 Hz fixed step + render interpolation, an overlay 3D layer, same-page screen changes via `reset`), settings, Auto render scale for graphics quality, a GPU resource ledger, input (action bindings, pointer lock), a glb asset cache, screen flow (`ScreenFlow`), run lifetime (`session`) |
| `render` | Toon materials and inverted-hull outlines, the glb loader, static mesh baking, merging moving parts (`rigidMerge`), matrix freezing and sector culling, skipping matrices of hidden objects, screen warp, a log-depth patch |
| `physics` | A Rapier wrapper, render-mesh BVH raycasts (`RaycastGeometry`, `visualRaycast`, `lineOfSight`), collider change stamps, and a physics mirror (`mirror`) that computes character movement in a worker |
| `audio` | A WebAudio engine (buses, preloading, pooling, 3D, reverb, music crossfades), a cue-table music director, surface-aware footsteps |
| `level` | A glb level loader driven by node-name rules (markers, doors, triggers, camera rails, lamps), loading sliced within a frame budget |
| `character` | A rigged character controller (poses, gestures, look-at, hand IK, faces, ground following), marker-placed character sets, an animation budget |
| `nav` | Tiled navmesh baked in workers (Recast/Detour), dynamic obstacles, drop and vault links, steering agents, a debug view |
| `cinematic` | Camera rails, a camera override director (`CameraDirector`), a shot runner (`ShotRunner`), point particles |
| `ui` | A closed Shadow DOM UI root (`uiRoot`, `adoptStyle`), screenshots (Ctrl+Alt+Shift+P), optional web fonts, a load screen, a pause and settings menu |
| `i18n` | A string dictionary, a source-text catalog and a language select screen |
| `intro` | A logo card intro (`Intro`). The first card is always "Produced by MONATIUM STUDIO · Powered by STRAWBERRY CAKE ENGINE"; a game adds its own cards after it |

Tools: a dialogue line editor (`npm run lines`), i18n check and fill (`npm run i18n:check`, `i18n:fill`), Playwright helpers for the Shadow DOM (`scripts/uiDom.mjs`),
a headless Blender → glb → screenshot pipeline (`npm run model`, `npm run shot`), and an example check (`npm run examplecheck`).

See [docs/ENGINE.md](docs/ENGINE.md) for the architecture, [docs/LEVELS.md](docs/LEVELS.md) for level node rules, [docs/I18N.md](docs/I18N.md) for i18n,
and [docs/ASSETS.md](docs/ASSETS.md) for the asset pipeline (the docs are in Korean).

## Quick start

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

No web font is bundled by default (system fonts). For a Korean UI, install a font such as [Pretendard](https://github.com/orioncactus/pretendard) (SIL OFL 1.1) yourself.

```ts
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { setUiFonts } from 'strawberry-cake-engine';
setUiFonts({ sansFaces: ["'Pretendard Variable'"], faces: { ko: ['Pretendard Variable'], en: ['Pretendard Variable'] } });
```

## Example

`examples/basic` is a scene made only of primitive geometry.

- A ground with obstacles, a ramp and a platform, and a toon-shaded knot spinning on a pedestal
- A navmesh baked at runtime in workers (press `N` to show it)
- Click the ground and a capsule (a Rapier character controller) walks there following a nav agent
- The closed Shadow DOM UI with a pause and settings menu (`Esc`: language, field of view, graphics)
- Korean and English

`npm run examplecheck` opens the example in headless Chrome, takes screenshots, clicks the ground and checks that the capsule arrives, that the language switches, and that the console has no errors.

## AI-generated material

The code and documents in this repository were written with the help of AI (Anthropic's Claude). Monatium Studio set the direction and reviewed the results.

## License

MIT. © 2026 Monatium Studio. See [LICENSE](LICENSE).

Notices for third-party code used or adapted here are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Logos

The logos in `brand/` and the intro's first card artwork (`src/intro/assets/`) identify Monatium Studio and this engine. The MIT license grants no trademark rights.
A game built on the engine should show the first intro card as it is. Please do not alter the logos or use them as marks for something else.

- The Strawberry Cake Engine logo is an original design by Monatium Studio.
- The gear mark in the Monatium Studio logo is a vector trace of the elf race icon from EPIDGames' Trickcal Revive. Trickcal, Trickcal:Revive and other derived brands are registered trademarks of EPIDGames.
- Logo type is outlined from Krona One, Michroma and Bagel Fat One (Google Fonts, SIL Open Font License). Generator: `tools/brand/gen_brand.py`

