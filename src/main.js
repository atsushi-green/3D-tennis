/** 起動点。各ファイルを配線して、フレームループを回すだけ。 */
(function (RallyOne) {
  'use strict';

  const {
    PHYSICS, applyCpuLevel, applyCpuStyle, applySurface,
  } = RallyOne.config;
  const { sfx, unlock } = RallyOne.audio;

  const input = new RallyOne.Input();
  const hud = new RallyOne.Hud();
  const world = RallyOne.scene.createWorld();

  /** スタート画面で選んだCPU/AIの強さ。既定はNormal（未選択のまま開始した場合）。 */
  let cpuLevel = 'normal';
  /** スタート画面で選んだコートサーフェス。既定はハード（未選択のまま開始した場合）。 */
  let surface = 'hard';
  /** スタート画面で選んだCPU/AIのプレースタイル。既定はなし（未選択のまま開始した場合）。 */
  let cpuStyle = 'none';

  const game = new RallyOne.Game({
    input,
    hooks: {
      sound: (name, ...args) => sfx[name](...args),
      call: (big, sub, shot) => hud.showCall(big, sub, shot),
      clearCall: () => hud.hideCall(),
      score: () => hud.renderScore(game.match, game.server, game.stats),
      wind: (accel) => hud.setWind(accel),
      serveSpeed: (kmh) => hud.setServeSpeed(kmh),
    },
  });

  input.attach({
    isStarted: () => game.started,
    onStart: () => {
      unlock(); // AudioContext はユーザー操作の中でしか起こせない
      applyCpuLevel(cpuLevel);
      applyCpuStyle(cpuStyle); // 必ず applyCpuLevel() の後（config.js のコメント参照）
      applySurface(surface);
      hud.hideStartScreen();
      game.start(false);
    },
    onStartDoubles: () => {
      unlock();
      applyCpuLevel(cpuLevel);
      applyCpuStyle(cpuStyle);
      applySurface(surface);
      hud.hideStartScreen();
      game.start(true);
    },
    onChargeStart: (spin) => game.chargeStart(spin),
    onChargeRelease: () => game.chargeRelease(),
    onFormationNet: () => game.setYouMateFormation('net'),
    onFormationBack: () => game.setYouMateFormation('back'),
    onSelectDifficulty: (level) => {
      cpuLevel = level;
      hud.setDifficulty(level);
    },
    onSelectSurface: (level) => {
      surface = level;
      hud.setSurface(level);
      world.setSurface(level); // スタート画面の背後のコートも選択に合わせて塗り替える
    },
    onSelectStyle: (name) => {
      cpuStyle = name;
      hud.setStyle(name);
    },
    onAnyKey: () => world.skipReplay(),
  });

  hud.renderScore(game.match, game.server, game.stats);
  world.sync(game, 0); // スタート画面の後ろにも正しい配置で映しておく

  // 開発用：コンソールから RallyOne.game で状態を覗ける
  RallyOne.game = game;
  RallyOne.world = world;

  let prev = performance.now();
  let prevPhase = game.phase;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - prev) / 1000, PHYSICS.MAX_DT);
    prev = now;

    if (game.started) {
      game.update(dt);
      // ポイントが決まった瞬間（'rally'→'over'）を検知してリプレイを始める。game.js には
      // 一切手を入れず、公開済みの game.phase を読むだけ（表示側で完結させる）。
      if (game.phase === 'over' && prevPhase !== 'over') world.startReplay();
      prevPhase = game.phase;
      world.sync(game, dt);
      hud.setCharge(game.chargeMeter());
      hud.setSmashTip(game.smashHint);
    }
    world.render();
  }
  requestAnimationFrame(frame);
})(window.RallyOne = window.RallyOne || {});
