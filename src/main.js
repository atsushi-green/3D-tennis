/** 起動点。各ファイルを配線して、フレームループを回すだけ。 */
(function (RallyOne) {
  'use strict';

  const {
    PHYSICS, applyCpuLevel, applyCpuStyle, applySurface, TOSS,
    setRating, resetRatings, randomizeRatings,
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
  /** トス（コイントス）に人間が勝ち、サーブ/レシーブの選択を待っている間だけ true。 */
  let awaitingToss = false;
  /** トスを始めた時点で選ばれていたダブルスの有無（トスの選択後にそのまま渡す）。 */
  let doublesPending = false;

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

  /** applyCpuLevel/Style/Surface を適用してから実際に試合を始める（トスの結果が決まった後）。 */
  function beginMatch(doubles, initialServer) {
    applyCpuLevel(cpuLevel);
    applyCpuStyle(cpuStyle); // 必ず applyCpuLevel() の後（config.js のコメント参照）
    applySurface(surface);
    hud.hideStartScreen();
    game.start(doubles, initialServer);
  }

  /**
   * 試合開始時のトス（コイントス）。実際の試合と同じく、勝った側がサーブ／レシーブを選ぶ。
   * 人間が勝ったらスタート画面で選ばせ（onSelectToss を待つ）、CPUが勝ったら
   * TOSS.CPU_SERVE_CHANCE の確率で自動的に選んで、選んだ側の結果でそのまま試合を始める。
   */
  function beginToss(doubles) {
    unlock(); // AudioContext はユーザー操作の中でしか起こせない
    doublesPending = doubles;
    if (Math.random() < 0.5) {
      awaitingToss = true;
      hud.showTossChoice();
      return;
    }
    beginMatch(doubles, Math.random() < TOSS.CPU_SERVE_CHANCE ? 'cpu' : 'you');
  }

  // スタート画面の「選手設定」パネル。値を持つのは config で、hud は表示とクリックの
  // 受け付けだけ、実際の適用（setRating 等）はここで行う＝難易度・サーフェスの選択と同じ流れ。
  hud.buildRoster({
    onChange: (who, key, value) => setRating(who, key, value),
    onReset: () => resetRatings(),
    onRandom: () => randomizeRatings(),
  });

  input.attach({
    isStarted: () => game.started,
    // 選手設定パネルの中のクリックは「クリックで開始」に使わない（能力値をいじるための
    // クリックで試合が始まってしまわないように）。DOM の判定は hud 側に任せる。
    isUiClick: (target) => hud.isRosterClick(target),
    isAwaitingToss: () => awaitingToss,
    onStart: () => beginToss(false),
    onStartDoubles: () => beginToss(true),
    onSelectToss: (choice) => {
      awaitingToss = false;
      beginMatch(doublesPending, choice === 'serve' ? 'you' : 'cpu');
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
    // リプレイのスキップは Space だけ（以前はどのキーでも飛んでしまい、ラリー用の
    // キーに触れただけで意図せずスキップされていた）。
    onSkipReplay: () => world.skipReplay(),
  });

  /** hud.setStamina() に渡す4人ぶんの残量をそのつど組み立てる。 */
  function syncStamina() {
    hud.setStamina({
      you: game.you.stamina,
      cpu: game.cpu.stamina,
      youMate: game.youMate.stamina,
      cpuMate: game.cpuMate.stamina,
    }, game.doubles);
  }

  hud.renderScore(game.match, game.server, game.stats);
  syncStamina();
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
      // リプレイ中は試合の進行を止める（＝「再生ぶんだけ待つ」）。止めないと裏で次の
      // ポイントが決まってしまい、再生中に startReplay() がもう一度呼ばれて今の再生が
      // 途中で上書きされる（＝「次のプレーが勝手に始まる」「再生が途中で途切れる」）。
      // game.js 自体には触れず、main.js が update() を呼ぶかどうかだけで制御する。
      if (!world.isReplaying()) {
        game.update(dt);
        // ポイントが決まった瞬間（'rally'→'over'）を検知してリプレイを始める。game.js には
        // 一切手を入れず、公開済みの game.phase を読むだけ（表示側で完結させる）。
        if (game.phase === 'over' && prevPhase !== 'over') world.startReplay();
        prevPhase = game.phase;
      }
      world.sync(game, dt);
      hud.setReplay(world.isReplaying());
      hud.setCharge(game.chargeMeter());
      hud.setSmashTip(game.smashHint);
      syncStamina();
    }
    world.render();
  }
  requestAnimationFrame(frame);
})(window.RallyOne = window.RallyOne || {});
