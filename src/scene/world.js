/**
 * 3D 表示の組み立てと、ゲーム状態 → メッシュへの反映。
 * ここはゲームの状態を読むだけで、書き換えない（ロジックは game.js のみが持つ）。
 */
(function (RallyOne) {
  'use strict';

  const {
    CAMERA, FX, PLAYER, THEME, REPLAY, HALF_L,
  } = RallyOne.config;
  const { lerp, clamp } = RallyOne.math;
  const scene3d = RallyOne.scene;

  scene3d.createWorld = function createWorld() {
    const stage = scene3d.createStage();
    const { scene, camera } = stage;

    const court = scene3d.createCourt();
    scene.add(court, scene3d.createNet(), scene3d.createOfficials(), scene3d.createCrowd());

    const you = scene3d.createPlayer(THEME.YOU);
    const cpu = scene3d.createPlayer(THEME.CPU);
    cpu.rotation.y = Math.PI; // CPU は手前を向く
    // ダブルスのパートナー。シングルスでは this.doubles===false の間 sync() で visible=false のまま。
    // 本人と同じ色だと見分けがつかないので、シャツ/短パンを入れ替えた配色(THEME.*_MATE)にする。
    const youMate = scene3d.createPlayer(THEME.YOU_MATE);
    const cpuMate = scene3d.createPlayer(THEME.CPU_MATE);
    cpuMate.rotation.y = Math.PI;
    const ballMesh = scene3d.createBall();
    const shadows = {
      ball: scene3d.createShadow(0.34),
      you: scene3d.createShadow(0.26),
      cpu: scene3d.createShadow(0.26),
      youMate: scene3d.createShadow(0.26),
      cpuMate: scene3d.createShadow(0.26),
    };
    const impactFlash = scene3d.createImpactFlash();
    const trail = scene3d.createTrail();
    const smashHint = scene3d.createSmashHint();
    scene.add(
      you, cpu, youMate, cpuMate, ballMesh,
      shadows.ball, shadows.you, shadows.cpu, shadows.youMate, shadows.cpuMate,
      impactFlash, trail, smashHint,
    );

    addEventListener('resize', stage.resize);

    const NO_TRAIL = []; // ラリー中は軌跡を隠す（毎フレーム確保しないよう使い回す）

    function syncCamera(player, dt) {
      const t = Math.min(1, dt * CAMERA.LERP);
      camera.position.x = lerp(camera.position.x, player.x * CAMERA.FOLLOW_X, t);
      camera.position.y = lerp(camera.position.y, CAMERA.HEIGHT, t);
      camera.position.z = lerp(camera.position.z, -CAMERA.BACK, t);
      camera.lookAt(player.x * CAMERA.LOOK_X, CAMERA.LOOK_AT.y, CAMERA.LOOK_AT.z);
    }

    /** プレイヤー1人ぶんの位置・スイング・歩行ポーズと影をまとめて反映する */
    function syncPlayer(mesh, shadow, state, maxSpeed, dt, tossing) {
      mesh.position.set(state.x, 0, state.z);
      scene3d.setSwingPose(mesh, state.anim, state.stroke, !!tossing, state.prep, state.chargeFrac, state.swingCharge);
      scene3d.setGaitPose(mesh, state.speed, maxSpeed, dt);
      // スマッシュのジャンプは歩行の後（同じ関節を上書きするため）。浮いた高さは影に渡す。
      const lift = scene3d.applySmashJump(mesh, state.anim, state.stroke);
      scene3d.placeGroundShadow(shadow, state, lift);
    }

    /**
     * 選手・ボールのメッシュへ反映する部分だけを、生の game state とリプレイの1コマの
     * 両方から呼べるよう切り出したもの（syncCamera・trail・smashHint は含まない：
     * それぞれ生の state とリプレイで振る舞いが違うため sync() 側で個別に扱う）。
     */
    function applyFrame(state, dt, tossing) {
      syncPlayer(you, shadows.you, state.you, PLAYER.SPEED, dt, tossing);
      syncPlayer(cpu, shadows.cpu, state.cpu, PLAYER.CPU_CHASE, dt, false);

      youMate.visible = cpuMate.visible = shadows.youMate.visible = shadows.cpuMate.visible = state.doubles;
      if (state.doubles) {
        syncPlayer(youMate, shadows.youMate, state.youMate, PLAYER.CPU_CHASE, dt, false);
        syncPlayer(cpuMate, shadows.cpuMate, state.cpuMate, PLAYER.CPU_CHASE, dt, false);
      }

      const ball = state.ball;
      ballMesh.position.set(ball.x, ball.y, ball.z);
      ballMesh.rotation.x += dt * 9;
      ballMesh.rotation.z += dt * 5;
      scene3d.applyImpactPunch(ballMesh, ball, FX);
      scene3d.placeImpact(impactFlash, ball, FX);
      scene3d.placeBallShadow(shadows.ball, ball);
    }

    // --- ポイント終了後のリプレイ（表示側のみ。ゲームロジックには一切触れない） ---
    // 直近 REPLAY.WINDOW_SEC 秒ぶんのスナップショットをリングバッファに録り続け、
    // startReplay() が呼ばれた瞬間の中身をそのまま固定して再生する。
    let history = [];
    let recClock = 0; // 録画用の合成クロック（dt を足すだけ。壁時計には依存しない）
    let reel = [];
    let replaying = false;
    let replayClock = 0;

    /** state.you/cpu/youMate/cpuMate のうち、見た目の再現に必要な分だけを浅くコピーする */
    function snapshotPlayer(p) {
      return {
        x: p.x, z: p.z, anim: p.anim, stroke: p.stroke, prep: p.prep,
        chargeFrac: p.chargeFrac, swingCharge: p.swingCharge, speed: p.speed,
      };
    }

    function recordFrame(state, dt) {
      recClock += dt;
      history.push({
        t: recClock,
        ball: {
          x: state.ball.x, y: state.ball.y, z: state.ball.z,
          impact: state.ball.impact, impactPower: state.ball.impactPower,
        },
        you: snapshotPlayer(state.you),
        cpu: snapshotPlayer(state.cpu),
        youMate: snapshotPlayer(state.youMate),
        cpuMate: snapshotPlayer(state.cpuMate),
        doubles: state.doubles,
      });
      while (history.length > 1 && recClock - history[0].t > REPLAY.WINDOW_SEC) history.shift();
    }

    /** reel の中から、再生開始からの経過時間 t にいちばん近い（それ以降で最初の）コマを返す */
    function frameAt(t) {
      const target = reel[0].t + t;
      for (let i = 0; i < reel.length; i++) {
        if (reel[i].t >= target) return reel[i];
      }
      return reel[reel.length - 1];
    }

    /** コート脇・低い位置からボールの深さを追う「ローアングルのリプレイカメラ」 */
    function placeReplayCamera(frame, dt) {
      const t = Math.min(1, dt * REPLAY.CAM_LERP);
      const z = clamp(frame.ball.z, -HALF_L, HALF_L);
      camera.position.x = lerp(camera.position.x, REPLAY.CAM_X, t);
      camera.position.y = lerp(camera.position.y, REPLAY.CAM_HEIGHT, t);
      camera.position.z = lerp(camera.position.z, z, t);
      camera.lookAt(0, REPLAY.CAM_LOOK_Y, z);
    }

    /** ポイントが決まった瞬間に main.js から呼ぶ。録れていなければ何もしない。 */
    function startReplay() {
      if (history.length < 2) return;
      // MAX_PLAY_SEC で長さを絞るのは前側（リード）だけ。末尾は必ず history の最後の
      // コマ＝ポイントが決まった瞬間（アウトならボールが実際にベースラインを越えた
      // 座標）まで含める。ここを history.slice() のまま先頭から MAX_PLAY_SEC ぶんだけ
      // 再生していたときは、肝心の決着の瞬間が再生範囲の外に切り落とされ、
      // リプレイがボールの決着より手前で止まって見えていた。
      const endT = history[history.length - 1].t;
      const startT = endT - REPLAY.MAX_PLAY_SEC;
      reel = history.filter((f) => f.t >= startT);
      if (reel.length < 2) reel = history.slice(-2);
      replayClock = 0;
      replaying = true;
    }

    /** リプレイ中にキー操作があったら main.js から呼ぶ。即座に通常表示へ戻す。 */
    function skipReplay() {
      replaying = false;
    }

    /**
     * 再生中かどうか。main.js はこれが true の間 `game.update()` を止める
     * （＝裏で次のポイントが進んでしまい、再生中に startReplay() が再び呼ばれて
     * 今の再生が途中で上書きされる、という事故を防ぐ）。
     */
    function isReplaying() {
      return replaying;
    }

    /** @param {{ball:object, you:object, cpu:object, youMate:object, cpuMate:object, doubles:boolean}} state */
    function sync(state, dt) {
      // 録画は再生中も止めない：裏では game.update() が実際の試合を進め続けているので、
      // ここで録り漏らすと再生の直後に次のポイントがすぐ終わったとき history が
      // 足りず（history.length<2）、そのポイントのリプレイだけ出せなくなってしまう。
      recordFrame(state, dt);

      if (replaying) {
        replayClock += dt * REPLAY.SPEED;
        // reel は startReplay() の時点で末尾（決着の瞬間）を必ず含む形に切り出し済みなので、
        // ここでは単純にその全長を再生し切ればよい。
        const playEnd = reel[reel.length - 1].t - reel[0].t;
        // playEnd を過ぎても HOLD_SEC の間は最後のコマを横視点のまま静止させる。
        // これがないと、再生終了と同時に裏で進んでいた本編（次のポイントの支度）が
        // 通常カメラへ lerp で戻る途中に映り込み、「戻りながら次が始まって見える」
        // 落ち着かない切り替わりになってしまう。
        if (replayClock <= playEnd + REPLAY.HOLD_SEC) {
          const frame = frameAt(Math.min(replayClock, playEnd));
          applyFrame(frame, dt, false);
          scene3d.updateTrail(trail, NO_TRAIL); // 再生そのものが「振り返り」なので軌跡は隠す
          scene3d.placeSmashHint(smashHint, null);
          placeReplayCamera(frame, dt);
          return;
        }
        replaying = false; // 再生し終わったら通常表示へ戻る
        // 横視点で静止していた状態から通常カメラへは lerp させず瞬時に切り替える
        // （lerp だと数フレームかけて振れながら戻り、本編がその途中で見えてしまうため）
        camera.position.set(state.you.x * CAMERA.FOLLOW_X, CAMERA.HEIGHT, -CAMERA.BACK);
        camera.lookAt(state.you.x * CAMERA.LOOK_X, CAMERA.LOOK_AT.y, CAMERA.LOOK_AT.z);
      }

      applyFrame(state, dt, state.tossActive === true && state.server === 'you');
      // 軌跡はラリーの決着がついた後（ポイント間の 'serve' 待ち・'over'）だけ見せる。
      // ラリー中に出しっぱなしだと本来の目的（アウトの結果を振り返る）を超えて
      // 「次にどこへ来るか」の手がかりになってしまうため。
      scene3d.updateTrail(trail, state.phase === 'rally' ? NO_TRAIL : state.trail);
      // スマッシュの先回り地点。打てる球が来ていないフレームは state.smashHint が null になる。
      scene3d.placeSmashHint(smashHint, state.smashHint);

      syncCamera(state.you, dt);
    }

    /** スタート画面でのサーフェス選択を、コートの見た目（テクスチャ色）へ反映する。 */
    function setSurface(surfaceName) {
      scene3d.setCourtSurface(court, surfaceName);
    }

    return {
      sync, render: stage.render, scene, camera, setSurface, startReplay, skipReplay, isReplaying,
    };
  };
})(window.RallyOne = window.RallyOne || {});
