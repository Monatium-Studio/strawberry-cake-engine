<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/strawberry-cake-engine.svg">
    <img alt="STRAWBERRY CAKE ENGINE" src="brand/strawberry-cake-engine-light.svg" width="560">
  </picture>
</p>

[한국어](README.md) · [English](README.en.md) · **日本語**

# strawberry-cake-engine

three.js と Rapier で作った小さな Web 3D ゲームエンジンです。固定ステップのループ、物理、実行時に焼くナビメッシュとエージェント、
リグ付きキャラクターコントローラー、トゥーンシェーディング、クローズドな Shadow DOM の UI、多言語対応（ko・en・ja）を備えています。ジャンルを問わない汎用部分だけをまとめました。

## モジュール

| モジュール | 内容 |
|---|---|
| `core` | `Engine`（60 Hz 固定ステップ + 描画補間、重ね描きの 3D レイヤー、同じページでの画面切り替え `reset`）、設定、グラフィック品質の「自動」描画倍率、GPU リソース台帳、入力（アクションバインド・ポインターロック）、glb アセットキャッシュ、画面フロー（`ScreenFlow`）、プレイ単位の寿命（`session`） |
| `render` | トゥーンマテリアルと反転ハル輪郭線、glb ローダー、静的メッシュのベイク、動く部品の結合（`rigidMerge`）、行列の凍結と区画カリング、隠れた物体の行列更新スキップ、画面の屈折、対数深度パッチ |
| `physics` | Rapier ラッパー、描画メッシュ BVH のレイキャスト（`RaycastGeometry`、`visualRaycast`・`lineOfSight`）、コライダー変更スタンプ、キャラクター移動をワーカーで計算する物理ミラー（`mirror`） |
| `audio` | WebAudio エンジン（バス・プリロード・プール・3D・残響・音楽クロスフェード）、キュー表の音楽ディレクター、路面を判別する足音 |
| `level` | ノード名ルールで読む glb レベルローダー（マーカー・ドア・トリガー・カメラレール・灯り）、フレーム予算内での分割読み込み |
| `character` | リグ付きキャラクターコントローラー（ポーズ・ジェスチャー・視線・手の IK・表情・地面追従）、マーカーで配置するキャラクター群、アニメーション予算 |
| `nav` | ワーカーで焼くタイル型ナビメッシュ（Recast/Detour）、動的障害物、飛び降り・乗り越えリンク、ステアリングエージェント、デバッグ表示 |
| `cinematic` | カメラレール、演出カメラ（`CameraDirector`）、カット実行器（`ShotRunner`）、点パーティクル |
| `ui` | クローズドな Shadow DOM の UI ルート（`uiRoot`・`adoptStyle`）、スクリーンショット（Ctrl+Alt+Shift+P）、Web フォント（任意）、ロード画面、ポーズ・設定メニュー |
| `i18n` | 文字列辞書・原文カタログ・言語選択画面 |
| `intro` | ロゴカードのイントロ（`Intro`）。最初のカードは常に「Produced by MONATIUM STUDIO · Powered by STRAWBERRY CAKE ENGINE」で、ゲームはその後ろに自分のカードを追加します |

ツール：台詞集エディター（`npm run lines`）、多言語チェック・補完（`npm run i18n:check`、`i18n:fill`）、Shadow DOM 用の Playwright ヘルパー（`scripts/uiDom.mjs`）、
Blender ヘッドレス → glb → スクリーンショットのパイプライン（`npm run model`、`npm run shot`）、サンプルのチェック（`npm run examplecheck`）。

詳しい構成は [docs/ENGINE.md](docs/ENGINE.md)、レベルのノード規則は [docs/LEVELS.md](docs/LEVELS.md)、多言語は [docs/I18N.md](docs/I18N.md)、
アセットパイプラインは [docs/ASSETS.md](docs/ASSETS.md) を参照してください（ドキュメントは韓国語です）。

## クイックスタート

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

Web フォントは既定では同梱しません（システムフォント）。韓国語や日本語の UI には [Pretendard](https://github.com/orioncactus/pretendard)（SIL OFL 1.1）などのフォントを各自インストールして使ってください。

```ts
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { setUiFonts } from 'strawberry-cake-engine';
setUiFonts({ sansFaces: ["'Pretendard Variable'"], faces: { ko: ['Pretendard Variable'], en: ['Pretendard Variable'] } });
```

## サンプル

`examples/basic` は基本図形だけで作ったシーンです。

- 地面と障害物、スロープと台、台座の上で回るトゥーンシェーディングの結び目
- 実行時にワーカーで焼くナビメッシュ（`N` で表示）
- 地面をクリックすると、カプセル（Rapier のキャラクターコントローラー）がナビエージェントに沿って歩く
- クローズドな Shadow DOM の UI とポーズ・設定メニュー（`Esc`：言語・視野角・グラフィック）
- 韓国語・英語

`npm run examplecheck` はヘッドレス Chrome でサンプルを開いてスクリーンショットを撮り、地面をクリックしてカプセルが到着するか、言語が切り替わるか、コンソールエラーがないかを確かめます。

## AI生成物

このリポジトリのコードと文書はAI(AnthropicのClaude)を活用して作成されました。Monatium Studioが方針を決め、結果を確認しました。

## ライセンス

MIT。© 2026 Monatium Studio。[LICENSE](LICENSE)

使用・移植したサードパーティーコードの告知は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。

## ロゴ

`brand/` のロゴとイントロ最初のカードの画像（`src/intro/assets/`）は、Monatium Studio とこのエンジンを示す標章です。MIT ライセンスは商標権を付与しません。
エンジンを使うゲームは、イントロ最初のカードをそのまま表示してください。ロゴを改変したり、別の標章として使ったりしないでください。

- ストロベリーケーキエンジンのロゴ：Monatium Studio のオリジナルデザインです。
- モナティウムスタジオのロゴの歯車マーク：EPIDGames『トリッカル・リバイブ』のエルフ種族アイコンをベクターでトレースしたものです。Trickcal、Trickcal:Revive およびその他の派生ブランドは EPIDGames の登録商標です。
- ロゴの文字：Krona One、Michroma、Bagel Fat One（Google Fonts、SIL Open Font License）のアウトラインです。生成スクリプト：`tools/brand/gen_brand.py`

