/**
 * 3D 表示の組み立てと、ゲーム状態 → メッシュへの反映。
 * ここはゲームの状態を読むだけで、書き換えない（ロジックは game.js のみが持つ）。
 */
(function (RallyOne) {
  'use strict';

  const {
    CAMERA, FX, PLAYER, SPECIAL, THEME, REPLAY, HALF_L,
  } = RallyOne.config;
  const { lerp, clamp } = RallyOne.math;
  const scene3d = RallyOne.scene;

  /**
   * 通常カメラの横位置（本体 pos・注視点 look）。ダブルスサイドラインの内側では
   * FOLLOW_X／LOOK_X の割合だけ追い、FOLLOW_FULL_X より外へはみ出したぶんはそのまま足す。
   */
  function cameraFollowX(playerX) {
    const inner = clamp(playerX, -CAMERA.FOLLOW_FULL_X, CAMERA.FOLLOW_FULL_X);
    const beyond = playerX - inner;
    return { pos: inner * CAMERA.FOLLOW_X + beyond, look: inner * CAMERA.LOOK_X + beyond };
  }

  scene3d.createWorld = function createWorld() {
    const stage = scene3d.createStage();
    const { scene, camera } = stage;

    const court = scene3d.createCourt();
    // 会場（審判台・線審・ボールボーイ・観客・太陽）。ゲームの座標は常に人間のチームが手前の
    // ままなので、チェンジエンズ（game.endsSwapped）はこちらを180°回して映す。コート面・
    // ライン・ネット・スタンドの壁は点対称なので回さなくても見え方は変わらない。
    const venue = new THREE.Group();
    venue.add(scene3d.createOfficials(), scene3d.createCrowd(), stage.sun);
    scene.add(court, scene3d.createNet(), venue);

    const you = scene3d.createPlayer(THEME.YOU, 'you');
    const cpu = scene3d.createPlayer(THEME.CPU, 'cpu');
    cpu.rotation.y = Math.PI; // CPU は手前を向く
    cpu.userData.facing = Math.PI; // 普段の向き（setSwingPose がツイーナー後に戻す基準）
    // ダブルスのパートナー。シングルスでは this.doubles===false の間 sync() で visible=false のまま。
    // 本人と同じ色だと見分けがつかないので、シャツ/短パンを入れ替えた配色(THEME.*_MATE)にする。
    const youMate = scene3d.createPlayer(THEME.YOU_MATE, 'youMate');
    const cpuMate = scene3d.createPlayer(THEME.CPU_MATE, 'cpuMate');
    cpuMate.rotation.y = Math.PI;
    cpuMate.userData.facing = Math.PI;
    const ballMesh = scene3d.createBall();
    const shadows = {
      ball: scene3d.createShadow(0.34),
      you: scene3d.createShadow(0.26),
      cpu: scene3d.createShadow(0.26),
      youMate: scene3d.createShadow(0.26),
      cpuMate: scene3d.createShadow(0.26),
    };
    // 縮地（必殺技）の残像。跳ぶ前に立っていた位置へ置いて薄れさせるだけなので、
    // 選手と同じメッシュのマテリアルを半透明の金色1枚に差し替えて使い回す。
    // 人間だけでなく AI も縮地を使う（難易度 Extreme）ので、4人ぶん用意する。
    // マテリアルは1人1枚：同じフレームに2人が跳ぶと、共有していると薄れ方が混ざる。
    function createGhost(facing) {
      const mesh = scene3d.createPlayer(THEME.YOU);
      const material = new THREE.MeshBasicMaterial({
        color: THEME.DASH_GHOST, transparent: true, opacity: 0, depthWrite: false,
      });
      mesh.traverse((o) => { if (o.isMesh) o.material = material; });
      mesh.rotation.y = facing;
      mesh.visible = false;
      return { mesh, material };
    }
    const dashGhosts = {
      you: createGhost(0),
      youMate: createGhost(0),
      cpu: createGhost(Math.PI),
      cpuMate: createGhost(Math.PI),
    };
    const GHOST_KEYS = Object.keys(dashGhosts);

    const impactFlash = scene3d.createImpactFlash();
    const trail = scene3d.createTrail();
    const smashHint = scene3d.createSmashHint();
    const swingGuide = scene3d.createSwingGuide();
    const practiceTarget = scene3d.createPracticeTarget();
    scene.add(practiceTarget);
    scene.add(
      you, cpu, youMate, cpuMate, ballMesh,
      ...GHOST_KEYS.map((key) => dashGhosts[key].mesh),
      shadows.ball, shadows.you, shadows.cpu, shadows.youMate, shadows.cpuMate,
      impactFlash, trail, smashHint, swingGuide,
    );

    addEventListener('resize', stage.resize);

    const NO_TRAIL = []; // ラリー中は軌跡を隠す（毎フレーム確保しないよう使い回す）

    function syncCamera(player, dt) {
      const t = Math.min(1, dt * CAMERA.LERP);
      const follow = cameraFollowX(player.x);
      camera.position.x = lerp(camera.position.x, follow.pos, t);
      camera.position.y = lerp(camera.position.y, CAMERA.HEIGHT, t);
      camera.position.z = lerp(camera.position.z, -CAMERA.BACK, t);
      camera.lookAt(follow.look, CAMERA.LOOK_AT.y, CAMERA.LOOK_AT.z);
    }

    /**
     * プレイヤー1人ぶんの位置・スイング・歩行ポーズと影をまとめて反映する。
     * @param {object} frame 生の game state かリプレイの1コマ（ball・phase を読む）
     * @param {'hold'|'toss'|null} serve この選手がサーブを待っている／トス中か
     */
    function syncPlayer(mesh, shadow, state, maxSpeed, dt, frame, serve) {
      mesh.position.set(state.x, 0, state.z);
      scene3d.setSwingPose(mesh, state, {
        dt, ball: frame.ball, phase: frame.phase, serve,
      });
      scene3d.setGaitPose(mesh, state.speed, maxSpeed, dt);
      // スマッシュ・サーブのジャンプ・飛びつきボレーの倒れ込み・ツイーナーの跳躍は歩行の後
      // （同じ関節を上書きするため）。同時に起きることはないので、浮いた高さは
      // 足し合わせて影に渡す。飛びつきボレーはツイーナーより後：どちらも股関節の
      // rotation.z（脚の開き）を使い、ツイーナーは技が出ていない間それを0へ戻すため。
      const lift = scene3d.applySmashJump(mesh, state)
        + scene3d.applyTweenerHop(mesh, state)
        + scene3d.applyDiveLean(mesh, state)
        + scene3d.applyJackknifeLeap(mesh, state)
        + scene3d.applyServeJump(mesh, state);
      // 腕のIKは最後（体幹の傾き・体の浮きがすべて決まってから。トスの左手はボールを追う）
      scene3d.finishPose(mesh, frame.ball);
      scene3d.placeGroundShadow(shadow, state, lift);
    }

    /**
     * サーブを待っている（'hold'）／トス中（'toss'）の選手。サーブの構え・トスの左手に使う。
     * リプレイのコマにも同じ形で録る（recordFrame）。
     */
    function serveStages(state) {
      const stages = { you: null, cpu: null, youMate: null, cpuMate: null };
      if (state.phase === 'serve') {
        stages[state.servingPlayer()] = state.tossActive || state.aiTossActive ? 'toss' : 'hold';
      }
      return stages;
    }

    /**
     * 選手・ボールのメッシュへ反映する部分だけを、生の game state とリプレイの1コマの
     * 両方から呼べるよう切り出したもの（syncCamera・trail・smashHint は含まない：
     * それぞれ生の state とリプレイで振る舞いが違うため sync() 側で個別に扱う）。
     */
    function applyFrame(state, dt, stages) {
      syncPlayer(you, shadows.you, state.you, PLAYER.SPEED, dt, state, stages.you);
      syncPlayer(cpu, shadows.cpu, state.cpu, PLAYER.CPU_CHASE, dt, state, stages.cpu);

      youMate.visible = cpuMate.visible = shadows.youMate.visible = shadows.cpuMate.visible = state.doubles;
      if (state.doubles) {
        syncPlayer(youMate, shadows.youMate, state.youMate, PLAYER.CPU_CHASE, dt, state, stages.youMate);
        syncPlayer(cpuMate, shadows.cpuMate, state.cpuMate, PLAYER.CPU_CHASE, dt, state, stages.cpuMate);
      }

      // 縮地の残像（跳ぶ前の位置に一瞬だけ残る分身）。リプレイでも同じように出したいので、
      // 生の state とリプレイのコマの両方が通る applyFrame() の中で面倒を見る。
      // ダブルスの2人（youMate/cpuMate）はシングルスでは state にいてもコートに出ていないので、
      // 本体と同じく doubles のときだけ出す。
      GHOST_KEYS.forEach((key) => {
        const ghost = dashGhosts[key];
        const dash = state[key] && (state.doubles || key === 'you' || key === 'cpu')
          ? state[key].dash : null;
        ghost.mesh.visible = !!dash;
        if (!dash) return;
        ghost.mesh.position.set(dash.x, 0, dash.z);
        ghost.material.opacity = SPECIAL.DASH.FX_OPACITY
          * clamp(dash.t / SPECIAL.DASH.FX_T, 0, 1);
      });

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
        x: p.x, z: p.z, anim: p.anim, stroke: p.stroke, prep: p.prep, spin: p.spin,
        chargeFrac: p.chargeFrac, swingCharge: p.swingCharge, speed: p.speed,
        // 人間だけ：溜めを離してから当たるまで（フォワードスイングを出すか・どちら向きか）
        charging: p.charging, swing: p.swing, chargeStroke: p.chargeStroke, chargeSpin: p.chargeSpin,
        // 必殺技（フォーム・ジャンプの高さ・倒れ込みに効く）と、縮地の残像。
        special: p.special || null,
        // 跳躍（打球のモーションとは別の時計。スマッシュ／ジャックナイフ／サーブ）
        leap: p.leap ? {
          t: p.leap.t, kind: p.leap.kind, span: p.leap.span, rise: p.leap.rise, reach: p.leap.reach,
        } : null,
        dash: p.dash ? { x: p.dash.x, z: p.dash.z, t: p.dash.t } : null,
        // 飛びつきボレーの、打つ前の飛び込み（飛ぶ先の足元・打点・向き）
        dive: p.dive ? {
          t: p.dive.t, span: p.dive.span, x1: p.dive.x1, z1: p.dive.z1, stroke: p.dive.stroke,
          ball: { x: p.dive.ball.x, y: p.dive.ball.y, z: p.dive.ball.z },
        } : null,
      };
    }

    function recordFrame(state, dt) {
      recClock += dt;
      history.push({
        t: recClock,
        // startReplay() が「今のサーブの構えより前」を切り落とすのに使う（IN_POINT 参照）
        phase: state.phase,
        ball: {
          x: state.ball.x, y: state.ball.y, z: state.ball.z,
          impact: state.ball.impact, impactPower: state.ball.impactPower,
          // 振り付け（scene/player.js）が「あと何秒で届くか」を見積もるのに使う
          vx: state.ball.vx, vy: state.ball.vy, vz: state.ball.vz,
          live: state.ball.live, last: state.ball.last, bounces: state.ball.bounces, age: state.ball.age,
        },
        you: snapshotPlayer(state.you),
        cpu: snapshotPlayer(state.cpu),
        youMate: snapshotPlayer(state.youMate),
        cpuMate: snapshotPlayer(state.cpuMate),
        doubles: state.doubles,
        stages: serveStages(state),
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

    /**
     * コート脇・低い位置からボールの深さを追う「ローアングルのリプレイカメラ」。
     * 中継のカメラと同じく会場に据え付けてあるので、コートを入れ替わった後は反対の脇から映る。
     * @param {number} side 会場の向き（入れ替わっていなければ 1、入れ替わった後は -1）
     */
    function placeReplayCamera(frame, dt, side) {
      const t = Math.min(1, dt * REPLAY.CAM_LERP);
      const z = clamp(frame.ball.z, -HALF_L, HALF_L);
      camera.position.x = lerp(camera.position.x, REPLAY.CAM_X * side, t);
      camera.position.y = lerp(camera.position.y, REPLAY.CAM_HEIGHT, t);
      camera.position.z = lerp(camera.position.z, z, t);
      camera.lookAt(0, REPLAY.CAM_LOOK_Y, z);
    }

    /**
     * 1本のサーブの構え（beginServe() で phase が 'serve' になる）から決着までの間の phase。
     * これ以外（'fault'・'over' など）のコマは、別のサーブ／前のポイントのもの。
     */
    const IN_POINT = new Set(['serve', 'rally']);

    /** ポイントが決まった瞬間に main.js から呼ぶ。録れていなければ何もしない。 */
    function startReplay() {
      if (history.length < 2) return;
      // 再生してよいのは、決着したサーブの構えに入ってから後のコマだけ。
      // 以前は直近 MAX_PLAY_SEC ぶんをそのまま切り出していたため、サーブで決まる短い
      // ポイント（特にダブルフォルト：CPU は構えてから打つまで2秒足らず）では、頭に
      // 1本目のフォールトの後始末（ネットに掛かって止まったボールなど）や前のポイントの
      // 終わりが混ざり、そこから beginServe() が選手とボールをスタンスへ瞬間移動させる
      // コマまで映っていた＝「アウトなのにネットに掛かる」「立ち位置が一瞬おかしい」。
      let from = history.length - 1; // 最後のコマ＝決着の瞬間（phase は 'over'）
      while (from > 0 && IN_POINT.has(history[from - 1].phase)) from--;
      const segment = history.slice(from);
      // MAX_PLAY_SEC で長さを絞るのは前側（リード）だけ。末尾は必ず history の最後の
      // コマ＝ポイントが決まった瞬間（アウトならボールが実際にベースラインを越えた
      // 座標）まで含める。ここを history.slice() のまま先頭から MAX_PLAY_SEC ぶんだけ
      // 再生していたときは、肝心の決着の瞬間が再生範囲の外に切り落とされ、
      // リプレイがボールの決着より手前で止まって見えていた。
      const endT = history[history.length - 1].t;
      const startT = endT - REPLAY.MAX_PLAY_SEC;
      reel = segment.filter((f) => f.t >= startT);
      if (reel.length < 2) reel = segment.slice(-2);
      if (reel.length < 2) return; // このサーブのコマが録れていない
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
      // 入れ替わるのは game の時計で暗転しきった瞬間（game.changeoverShade() が1の間）だけ。
      // リプレイは update() を止めて再生するので、再生中に向きが変わることはない。
      venue.rotation.y = state.endsSwapped ? Math.PI : 0;
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
          applyFrame(frame, dt, frame.stages);
          scene3d.updateTrail(trail, NO_TRAIL); // 再生そのものが「振り返り」なので軌跡は隠す
          scene3d.placeSmashHint(smashHint, null);
          scene3d.placeSwingGuide(swingGuide, null, state.you);
          placeReplayCamera(frame, dt, state.endsSwapped ? -1 : 1);
          return;
        }
        replaying = false; // 再生し終わったら通常表示へ戻る
        // 横視点で静止していた状態から通常カメラへは lerp させず瞬時に切り替える
        // （lerp だと数フレームかけて振れながら戻り、本編がその途中で見えてしまうため）
        const follow = cameraFollowX(state.you.x);
        camera.position.set(follow.pos, CAMERA.HEIGHT, -CAMERA.BACK);
        camera.lookAt(follow.look, CAMERA.LOOK_AT.y, CAMERA.LOOK_AT.z);
      }

      applyFrame(state, dt, serveStages(state));
      // 軌跡はラリーの決着がついた後（ポイント間の 'serve' 待ち・'over'）だけ見せる。
      // ラリー中に出しっぱなしだと本来の目的（アウトの結果を振り返る）を超えて
      // 「次にどこへ来るか」の手がかりになってしまうため。
      scene3d.updateTrail(trail, state.phase === 'rally' ? NO_TRAIL : state.trail);
      // スマッシュの先回り地点。打てる球が来ていないフレームは state.smashHint が null になる。
      scene3d.placeSmashHint(smashHint, state.smashHint);
      // ガイド付きモードの「いま離したらここへ飛ぶ」。それ以外は state.swingGuide が null。
      scene3d.placeSwingGuide(swingGuide, state.swingGuide, state.you);
      // 練習モードの移動のレッスンの目印（それ以外は出さない）
      scene3d.placePracticeTarget(practiceTarget, state.practice && state.practice.target);

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
