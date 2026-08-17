# CLAUDE.md

Rally One（3Dテニスゲーム）の規約。詳しい構成・依存関係は [README.md](./README.md) を参照。

## 絶対に守ること

- **ES モジュール（`import`/`export`）を使わない。** `index.html` はダブルクリックで（サーバーなしで）開ける必要がある。`file://` は ES モジュールの読み込みを CORS でブロックするため。
- 各 `src/*.js` は即時関数で包み、`window.RallyOne` に自分の分だけ足す。先頭の分割代入が import 相当、末尾の代入が export 相当。
  ```js
  (function (RallyOne) {
    'use strict';
    const { COURT, PHYSICS } = RallyOne.config;   // ← 依存
    ...
    RallyOne.physics = { netHeightAt, ... };       // ← 公開
  })(window.RallyOne = window.RallyOne || {});
  ```
- ファイルを追加したら `index.html` の `<script src>` にも依存順で1行足す。
- `src/game.js`・`src/physics.js`・`src/scoring.js`・`src/ai.js` は **three.js にも DOM にも触らない**。表示側との連絡は `hooks`（音・コール・スコア更新）経由。DOM に触るのは `src/hud.js` だけ。
- 難易度・寸法・演出のタイミングなど、あらゆるチューニング値は `src/config.js` に集約する。マジックナンバーを他ファイルに書かない。
- 依存の向きは `main → game → (physics/scoring/ai/config)` と `main → scene/*` の二方向のみ。循環させない。

## テスト

```sh
node tests/smoke.mjs
```

スコア計算・サーブの着地・フットフォルト境界・サーブコース選択・フルマッチシミュレーションを検証する（three.js も DOM も使わない純ロジックテスト）。変更を加えたら必ず通すこと。UI/描画の変更は headless Chrome か `claude-in-chrome` での目視確認も行う（テストではロジックしか検証できない）。

`predictLanding()` は 1/120s 刻みのため、境界値ちょうどを狙うテストには数cmのスラック（`STEP_SLACK`）を持たせる。実際の物理ステップは `PHYSICS.STEP = 1/240` でこれより精密。

## `/evolve`（自動実装ループ）について

`docs/ROADMAP.md` にタスクの優先順位付きバックログがある。`/evolve` skill（`.claude/skills/evolve/SKILL.md`）が `/loop` から定期的に呼ばれ、上から1件ずつ拾って実装・テスト・コミットする。手動で作業するときも、思いついたタスクは `ROADMAP.md` に積んでおくと後で拾われる。
