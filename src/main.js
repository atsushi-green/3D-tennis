/** 起動点。各ファイルを配線して、フレームループを回すだけ。 */
(function (RallyOne) {
  'use strict';

  const {
    PHYSICS, applyCpuLevel, applyCpuStyle, applySurface, TOSS,
    setRating, resetRatings, randomizeRatings,
    SPECIAL_MOVES, SPECIAL_PRESET, PRACTICE, LINE_CALL,
  } = RallyOne.config;
  const { clamp } = RallyOne.math;
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
  /** スタート画面で選んだ試合形式。true ＝ ダブルス（既定はシングルス）。 */
  let doubles = false;
  /** スタート画面で選んだガイド付きモード。true ＝ 打つ方向のガイドを出す（既定は なし）。 */
  let guide = false;
  /**
   * スタート画面で選んだ必殺技（config.SPECIAL_MOVES の key の配列）。
   * 既定は空＝必殺技なし＝これまでと完全に同じゲーム。複数選べる。
   */
  let specials = [];
  /** Z キー／プリセットボタンで選べる組み合わせ。 */
  const SPECIAL_PRESETS = {
    none: [],
    preset: SPECIAL_PRESET.slice(),
    all: SPECIAL_MOVES.map((m) => m.key),
  };
  const sameSpecials = (a, b) => a.length === b.length && a.every((k) => b.indexOf(k) !== -1);
  /** トス（コイントス）に人間が勝ち、サーブ/レシーブの選択を待っている間だけ true。 */
  let awaitingToss = false;
  /** トスを始めた時点で選ばれていたダブルスの有無（トスの選択後にそのまま渡す）。 */
  let doublesPending = false;
  /** hooks.matchEnd で受け取った、まだ画面に出していないスタッツ（出したら null に戻す）。 */
  let pendingSummary = null;
  /** 試合後のスタッツ画面を開いている間だけ true。この間は試合の進行を止める。 */
  let matchStatsOpen = false;
  /** 練習モードのレッスン一覧を開いている間だけ true（スタート画面の上で、#menuBody と差し替え）。 */
  let lessonMenuOpen = false;
  /** レッスン一覧で選んでいる行（config.PRACTICE.LESSONS の添字）。 */
  let lessonCursor = 0;
  /** このページを開いてからクリアしたレッスンの key（一覧に ✓ を付ける）。 */
  const clearedLessons = new Set();

  /**
   * Game を作る。練習モードでレッスンを替える／スタート画面へ戻るときは作り直す
   * （Game#start / startPractice は1つの Game で1回だけ）。hooks は下の `game` を
   * その都度読むので、作り直した後も新しい Game を指す。
   */
  const createGame = () => new RallyOne.Game({
    input,
    hooks: {
      sound: (name, ...args) => sfx[name](...args),
      call: (big, sub, shot) => hud.showCall(big, sub, shot),
      clearCall: () => hud.hideCall(),
      score: () => hud.renderScore(game.match, game.server, game.stats),
      wind: (x, z) => hud.setWind(x, z),
      serveSpeed: (kmh) => hud.setServeSpeed(kmh),
      // 1セットが終わって振り返りを出す番になった（game.js が TIMING.MATCH_STATS 後に呼ぶ）。
      // ここでは受け取っておくだけで、実際に出すのはフレームループ（リプレイ再生中に
      // 割り込まないよう、再生が終わってから開く）。
      matchEnd: (summary) => { pendingSummary = summary; },
    },
  });
  let game = createGame();

  /** applyCpuLevel/Style/Surface を適用してから実際に試合を始める（トスの結果が決まった後）。 */
  function beginMatch(wantDoubles, initialServer) {
    applyCpuLevel(cpuLevel);
    applyCpuStyle(cpuStyle); // 必ず applyCpuLevel() の後（config.js のコメント参照）
    applySurface(surface);
    hud.hideStartScreen();
    hud.setMatchLevel(cpuLevel);
    game.setGuide(guide);
    game.setSpecials(specials);
    game.start(wantDoubles, initialServer);
  }

  /**
   * 試合開始時のトス（コイントス）。実際の試合と同じく、勝った側がサーブ／レシーブを選ぶ。
   * 人間が勝ったらスタート画面で選ばせ（onSelectToss を待つ）、CPUが勝ったら
   * TOSS.CPU_SERVE_CHANCE の確率で自動的に選んで、選んだ側の結果でそのまま試合を始める。
   */
  /* ------------------------------------------------------------ 練習モード */

  function openLessons() {
    lessonMenuOpen = true;
    hud.showLessons(lessonCursor, clearedLessons);
  }

  function closeLessons() {
    lessonMenuOpen = false;
    hud.hideLessons();
  }

  /** @param {number} step 一覧は2列：←→ が ∓1、↑↓ が ∓2（input.js） */
  function moveLessonCursor(step) {
    lessonCursor = clamp(lessonCursor + step, 0, PRACTICE.LESSONS.length - 1);
    hud.renderLessons(lessonCursor, clearedLessons);
  }

  /**
   * いまの Game を捨てて、まっさらな Game に差し替える。クリアしたレッスンは覚えておく。
   * 前の Game で握っていた溜めキー・再生中のリプレイも持ち越さない。
   */
  function replaceGame() {
    if (game.practice && game.practice.cleared) clearedLessons.add(game.practice.lesson.key);
    input.resetCharge();
    game = createGame();
    RallyOne.game = game;
    world.skipReplay();
    prevPhase = game.phase;
    pendingSummary = null;
    matchStatsOpen = false;
  }

  /** @param {number} index config.PRACTICE.LESSONS の添字 */
  function beginPractice(index) {
    unlock(); // AudioContext はユーザー操作の中でしか起こせない
    if (game.started) replaceGame();
    lessonCursor = index;
    closeLessons();
    // 難易度（レシーブの練習の CPU のサーブ）とサーフェス（球の弾み方）はスタート画面の選択どおり
    applyCpuLevel(cpuLevel);
    applyCpuStyle(cpuStyle);
    applySurface(surface);
    hud.hideStartScreen();
    game.setGuide(guide);
    game.startPractice(PRACTICE.LESSONS[index].key);
  }

  /** 練習中の Esc：スタート画面のレッスン一覧へ戻る（クリアしていたら次のレッスンを選んでおく）。 */
  function backToLessons() {
    const at = PRACTICE.LESSONS.indexOf(game.practice.lesson);
    if (game.practice.cleared) lessonCursor = Math.min(at + 1, PRACTICE.LESSONS.length - 1);
    replaceGame();
    hud.showStartScreen();
    world.sync(game, 0); // 背後のコートも立ち位置・会場の向きを初期へ戻す
    openLessons();
  }

  /** 練習中の N：次のレッスンへ（最後のレッスンの次は一覧へ戻る）。 */
  function nextLesson() {
    const next = PRACTICE.LESSONS.indexOf(game.practice.lesson) + 1;
    if (next >= PRACTICE.LESSONS.length) backToLessons();
    else beginPractice(next);
  }

  function beginToss(wantDoubles) {
    unlock(); // AudioContext はユーザー操作の中でしか起こせない
    doublesPending = wantDoubles;
    if (Math.random() < 0.5) {
      awaitingToss = true;
      hud.showTossChoice();
      return;
    }
    beginMatch(wantDoubles, Math.random() < TOSS.CPU_SERVE_CHANCE ? 'cpu' : 'you');
  }

  // スタート画面の選択。マウス（hud のボタン）とキーボード（input）の両方から同じ関数を
  // 呼ぶので、どちらで操作しても状態と表示が必ず揃う。表示の更新は hud、実際の適用は
  // beginMatch() の applyCpuLevel/Style/Surface が行う（config が値の持ち主）。
  const menu = {
    onSelectMode: (wantDoubles) => {
      doubles = wantDoubles;
      hud.setMode(wantDoubles);
    },
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
    // ガイド付きモードは試合中でも切り替わって困らない（表示専用）ので、選んだ時点で
    // そのまま game へ渡す。次の試合にもそのまま引き継がれる。
    onSelectGuide: (on) => {
      guide = on;
      hud.setGuide(on);
      game.setGuide(on);
    },
    onToggleGuide: () => menu.onSelectGuide(!guide),
    // 必殺技は複数選択。押した技だけを入/切する（他の設定行のような排他選択ではない）。
    // ガイドと同じく、選んだ時点でそのまま game へ渡す＝試合中に変えても壊れない。
    onToggleSpecial: (key) => {
      const at = specials.indexOf(key);
      if (at === -1) specials = specials.concat([key]);
      else specials = specials.filter((k) => k !== key);
      hud.setSpecials(specials);
      game.setSpecials(specials);
    },
    onSpecialPreset: (name) => {
      specials = (SPECIAL_PRESETS[name] || []).slice();
      hud.setSpecials(specials);
      game.setSpecials(specials);
    },
    // Z キー：なし → おすすめ → すべて → なし。個別の入/切はマウスで行う。
    onCycleSpecials: () => {
      const next = specials.length === 0 ? 'preset'
        : sameSpecials(specials, SPECIAL_PRESETS.preset) ? 'all' : 'none';
      menu.onSpecialPreset(next);
    },
    onPlay: () => beginToss(doubles),
    onSelectToss: (choice) => {
      awaitingToss = false;
      beginMatch(doublesPending, choice === 'serve' ? 'you' : 'cpu');
    },
  };

  // スタート画面の「選手設定」パネル。値を持つのは config で、hud は表示とマウス操作の
  // 受け付けだけ、実際の適用（setRating 等）はここで行う＝難易度・サーフェスの選択と同じ流れ。
  hud.buildRoster({
    onChange: (who, key, value) => setRating(who, key, value),
    onReset: () => resetRatings(),
    onRandom: () => randomizeRatings(),
  });
  hud.buildMenu(menu);
  hud.buildSpecials({ onToggle: menu.onToggleSpecial, onPreset: menu.onSpecialPreset });
  hud.setSpecials(specials);
  // 試合後のスタッツ画面の「次の試合へ」。キーボード（Space/Enter）側は input.js が
  // 同じ closeMatchStats() を呼ぶ＝マウスとキーで挙動がずれない。
  hud.buildMatchStats({ onClose: () => closeMatchStats() });
  hud.buildLessons({
    onOpen: () => openLessons(),
    onSelect: (index) => beginPractice(index),
    onBack: () => closeLessons(),
  });

  input.attach({
    isStarted: () => game.started,
    isAwaitingToss: () => awaitingToss,
    onStart: () => beginToss(doubles), // 何かキーを押したら、選んである形式で開始
    // S / D は「その形式を選んでそのまま開始」。ボタンで選んでから開始するのと同じ結果になる
    // （Space など他のキーは「いま選ばれている形式で開始」なので、形式の指定にはならない）。
    onStartSingles: () => {
      menu.onSelectMode(false);
      beginToss(false);
    },
    onStartDoubles: () => {
      menu.onSelectMode(true);
      beginToss(true);
    },
    onSelectToss: menu.onSelectToss,
    onChargeStart: (spin) => game.chargeStart(spin),
    // キックサーブはトップスピンのトスとして上げる（serve() が球種もキック用に決める）
    onKickStart: () => game.chargeStart('top', true),
    onChargeRelease: () => game.chargeRelease(),
    onFormationNet: () => game.setYouMateFormation('net'),
    onFormationBack: () => game.setYouMateFormation('back'),
    onStandNet: () => game.setYouFormation('net'),
    onStandBack: () => game.setYouFormation('back'),
    onSelectDifficulty: menu.onSelectDifficulty,
    onSelectSurface: menu.onSelectSurface,
    onSelectStyle: menu.onSelectStyle,
    onToggleGuide: () => menu.onToggleGuide(),
    onCycleSpecials: () => menu.onCycleSpecials(),
    // リプレイのスキップは Space だけ（以前はどのキーでも飛んでしまい、ラリー用の
    // キーに触れただけで意図せずスキップされていた）。チェンジエンズの休憩も同じ Space で
    // 切り上げる。リプレイ中は game.update() が止まっていて休憩はまだ始まっていないので、
    // 1回の押下で両方が飛ぶことはない。
    onSkipReplay: () => {
      world.skipReplay();
      game.skipChangeover();
      game.skipMatchPointCut();
    },
    isMatchStatsOpen: () => matchStatsOpen,
    onCloseMatchStats: () => closeMatchStats(),
    onOpenPractice: () => openLessons(),
    isLessonMenuOpen: () => lessonMenuOpen,
    onLessonCursor: (step) => moveLessonCursor(step),
    onLessonStart: () => beginPractice(lessonCursor),
    onLessonBack: () => closeLessons(),
    isPracticing: () => !!game.practice,
    onNextLesson: () => nextLesson(),
    onBackToMenu: () => backToLessons(),
  });

  /**
   * 試合後のスタッツ画面を閉じる。止めていた進行が再開し、game.js が仕掛けてある
   * TIMING.NEXT_MATCH のタイマーの残りぶんだけ待って次のマッチが始まる。
   */
  function closeMatchStats() {
    if (!matchStatsOpen) return;
    matchStatsOpen = false;
    hud.hideMatchStats();
  }

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
      // リプレイが終わっていて、まだ出していないスタッツがあれば、ここで開く
      // （最後のポイントの再生に割り込まないよう、必ず再生が終わってから）。
      if (pendingSummary && !world.isReplaying()) {
        hud.showMatchStats(pendingSummary);
        pendingSummary = null;
        matchStatsOpen = true;
      }
      // リプレイ中とスタッツ画面を開いている間は、試合の進行そのものを止める（＝「見て
      // いるぶんだけ待つ」）。止めないと裏で次のポイントが進んでしまい、再生が途中で
      // 上書きされたり、振り返りを読んでいる間に次の試合が始まったりする。game.js には
      // 手を入れず、main.js が update() を呼ぶかどうかだけで制御する（タイマーは
      // Game#update の中で数えているので、止めれば待ち時間もそこで止まる）。
      let pointJustEnded = false;
      if (!world.isReplaying() && !matchStatsOpen) {
        game.update(dt);
        // ポイントが決まった瞬間（'rally'→'over'）を検知してリプレイを始める。game.js には
        // 一切手を入れず、公開済みの game.phase を読むだけ（表示側で完結させる）。
        pointJustEnded = game.phase === 'over' && prevPhase !== 'over';
        prevPhase = game.phase;
      }
      // 決着の瞬間のコマ（アウトならボールが実際に地面へ着いた座標）は、この game.update()
      // の中で作られる。録画しているのは world.sync() なので、ここで startReplay() を先に
      // 呼んでしまうと、その1コマがまだ録れていない＝リプレイの最後のコマが「着地する
      // 1フレーム前（＝ボールが地面のわずかに上で止まって見える）」になってしまっていた。
      // 速い球ほど1フレームぶんの移動が大きく、着地の直前で終わって見える。sync() で
      // そのコマを録ってから切り出す。
      world.sync(game, dt);
      // 練習モードはリプレイを挟まない（1本ごとに止まると反復練習のテンポが崩れる）
      // 線審のコール（アウト／ダブルフォルト）で決まったポイントは、通常の画面でコールを
      // 見せてからリプレイへ移る（実際の中継と同じ順番。LINE_CALL.REPLAY_DELAY 参照）。
      if (pointJustEnded && !game.practice) {
        world.startReplay(game.lineCall && game.lineCall.decisive ? LINE_CALL.REPLAY_DELAY : 0);
      }
      hud.setReplay(world.isReplaying(), world.isCheckingMark());
      // 観客のざわめきはポイントの合間だけ。サーブの構えに入ると静まり、ラリー中は無音。
      // 1本目のフォールトからセカンドサーブまでの間も静かなまま（'fault' は含めない）
      // マッチポイントの演出の間も、沸いているスタンドを映しているのでざわめきは消さない
      sfx.murmur(!game.practice && (world.isReplaying() || matchStatsOpen || !!game.changeover
        || !!game.matchPointCut || game.phase === 'over'));
      hud.setShade(game.changeoverShade());
      hud.setCinema(!!game.matchPointCut);
      hud.setPractice(game.practice);
      // いま Space を押していて技が出る状態なら、溜めバーも金色にする（＝離した瞬間に
      // 何が起きるかが、視線を動かさずにバーだけで分かる）。
      const armed = game.specialArmed;
      hud.setCharge(
        game.chargeMeter(), game.isServeCharging(), !!(armed && armed.move), game.isServeOvercharged(),
      );
      hud.setSpecialTip(armed);
      hud.setSpecialUses(game.specials, game.specialUses);
      hud.setStakes(game.stakes);
      hud.setSmashTip(game.smashHint);
      hud.setSwingGuide(game.swingGuide, game.you.x);
      syncStamina();
    } else {
      sfx.murmur(false); // 試合を作り直してスタート画面／レッスン一覧へ戻った
    }
    world.render();
  }
  requestAnimationFrame(frame);
})(window.RallyOne = window.RallyOne || {});
