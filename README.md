# Rally One — 3D Tennis

ブラウザで動く3Dテニス。ビルド不要、サーバー不要、ネット接続も不要。

## 動かす

**`index.html` をダブルクリックするだけ。** ブラウザが開いたら Space かクリックで開始。

（three.js は `vendor/three.min.js` に同梱してあるので、オフラインでも動きます）

## 操作

| キー | 動作 |
| --- | --- |
| ←→ | 左右移動 ／ 打つ方向の指定 |
| ↑↓ | 前後移動 |
| Space | サーブ・スイング（クリックでも可） |
| Shift | ロブ |

1セットマッチ（6ゲーム先取、2ゲーム差）。

## 構成

```
index.html          DOM（HUD とスタート画面）と script の読み込み順
styles/main.css     HUD のスタイル
vendor/three.min.js three.js r128（同梱）
src/
  config.js         寸法・物理・難易度などのチューニング値
  math.js           clamp / rand / approach など
  physics.js        弾道の積分、落下点の予測、初速の逆算（純粋関数）
  scoring.js        ポイント表記とゲーム／セットの成立判定（純粋）
  ai.js             CPU の位置取りと狙い先
  game.js           ルールと状態遷移（three.js にも DOM にも触らない）
  input.js          キーボード／ポインタ入力
  hud.js            スコアボードとコール表示（DOM に触る唯一の場所）
  audio.js          Web Audio による効果音
  scene/
    renderer.js     レンダラー・カメラ・ライト
    court.js        コート面（ラインは CanvasTexture）とスタンド
    net.js          ネットとポスト
    player.js       選手のメッシュとスイングのポーズ
    ball.js         ボール・影・着地マーカー
    world.js        シーンの組み立てと「状態 → メッシュ」の反映
  main.js           起動点。配線とフレームループだけ
```

各ファイルは即時関数で包まれていて、`window.RallyOne` に自分の分だけを足していきます。
先頭で使うものを分割代入しているので、そこがそのファイルの依存一覧です。

```js
(function (RallyOne) {
  'use strict';
  const { COURT, PHYSICS } = RallyOne.config;  // ← これが import 相当
  ...
  RallyOne.physics = { netHeightAt, ... };     // ← これが export 相当
})(window.RallyOne = window.RallyOne || {});
```

`index.html` の `<script>` は依存順に並んでいるので、**ファイルを追加したらここにも1行足す**こと。

依存の向きは `main → game → (physics / scoring / ai / config)` と `main → scene/*` の二方向で、
ゲームロジック側は three.js も DOM も参照しません（= Node でそのままテストできる）。

## 開発メモ

- コンソールから `RallyOne.game` で現在の状態（ボール、選手、スコア）を覗ける。
- `game.js` は `hooks`（音・コール・スコア更新）を注入される。表示を変えたいときはここを差し替える。
- 難易度は `config.js` の `CPU` と `PLAYER` を触る。
- ポイント間の待ち時間は `setTimeout` ではなくゲームループ内のタイマー（`Game#after`）で数えているので、
  ポイントがリセットされると必ず破棄される。
- ES モジュール（`import`/`export`）は使っていない。`file://` で開けなくなるため。
