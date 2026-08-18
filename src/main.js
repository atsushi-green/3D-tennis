/** 起動点。各ファイルを配線して、フレームループを回すだけ。 */
(function (RallyOne) {
  'use strict';

  const { CHARGE, PHYSICS } = RallyOne.config;
  const { sfx, unlock } = RallyOne.audio;

  const input = new RallyOne.Input();
  const hud = new RallyOne.Hud();
  const world = RallyOne.scene.createWorld();

  const game = new RallyOne.Game({
    input,
    hooks: {
      sound: (name, ...args) => sfx[name](...args),
      call: (big, sub) => hud.showCall(big, sub),
      clearCall: () => hud.hideCall(),
      score: () => hud.renderScore(game.match, game.server),
    },
  });

  input.attach({
    isStarted: () => game.started,
    onStart: () => {
      unlock(); // AudioContext はユーザー操作の中でしか起こせない
      hud.hideStartScreen();
      game.start(false);
    },
    onStartDoubles: () => {
      unlock();
      hud.hideStartScreen();
      game.start(true);
    },
    onChargeStart: () => game.chargeStart(),
    onChargeRelease: () => game.chargeRelease(),
  });

  hud.renderScore(game.match, game.server);
  world.sync(game, 0); // スタート画面の後ろにも正しい配置で映しておく

  // 開発用：コンソールから RallyOne.game で状態を覗ける
  RallyOne.game = game;
  RallyOne.world = world;

  let prev = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - prev) / 1000, PHYSICS.MAX_DT);
    prev = now;

    if (game.started) {
      game.update(dt);
      world.sync(game, dt);
      hud.setCharge(game.you.charging ? game.you.chargeTime / CHARGE.MAX_TIME : 0);
    }
    world.render();
  }
  requestAnimationFrame(frame);
})(window.RallyOne = window.RallyOne || {});
