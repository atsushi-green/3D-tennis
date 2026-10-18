/**
 * 3D 表示の組み立てと、ゲーム状態 → メッシュへの反映。
 * ここはゲームの状態を読むだけで、書き換えない（ロジックは game.js のみが持つ）。
 */
(function (RallyOne) {
  'use strict';

  const {
    CAMERA, EMOTION, FX, OFFICIALS, PLAYER, SPECIAL, SWING, THEME, REPLAY, HIGHLIGHT, HALF_L, LINE_CALL, BALL_MARK, SURFACE, MATCH_POINT, FINALE, NIGHT,
  } = RallyOne.config;
  const { lerp, clamp } = RallyOne.math;
  const scene3d = RallyOne.scene;
  const ease = (u) => u * u * (3 - 2 * u);

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
    const officials = scene3d.createOfficials();
    // クレーのボールマークも会場の側に置く＝チェンジエンズで会場と一緒に回り、コートに付いたまま
    const ballMarks = scene3d.createBallMarks();
    // 風向きの旗も会場の側（風は会場に吹いているので、回った後も会場に対して同じ向きになびく）
    const flags = scene3d.createFlags();
    // 観客（マッチポイントの演出・試合が決まった後に沸く。updateCrowd() に盛り上がりの度合いを渡す）
    const crowd = scene3d.createCrowd();
    // スコアボード（main.js が setScoreboard で中身を渡す）。会場と一緒に回る
    const scoreboards = scene3d.createScoreboards();
    venue.add(officials, ballMarks.group, crowd, flags, scoreboards.group, stage.sun);
    // ネットはコートと同じく点対称なので会場の側に入れない（ゲームの座標のまま揺らせる）
    const net = scene3d.createNet();
    scene.add(court, net, venue);
    // 時間帯と天候（照明塔・星・雨粒・コートのシート・濡れたコート）
    const weather = scene3d.createWeather(stage);

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
    // ナイトセッションの照明塔4基ぶんの薄い影（選手ごとに、それぞれの塔と反対側へずらして置く）
    const nightShadows = Object.fromEntries(['you', 'cpu', 'youMate', 'cpuMate'].map((key) => {
      const list = NIGHT.TOWERS.map(() => scene3d.createShadow(NIGHT.SHADOW.OPACITY));
      list.forEach((m) => { m.visible = false; scene.add(m); });
      return [key, list];
    }));

    /** その選手の影（syncPlayer で置き終えた後）に合わせて、ナイトの4方向の影を置く。 */
    function placeNightShadows(key, shadow) {
      const on = weather.isNight() && shadow.visible;
      nightShadows[key].forEach((m, i) => {
        m.visible = on;
        if (!on) return;
        const tower = NIGHT.TOWERS[i];
        const dx = shadow.position.x - tower.x;
        const dz = shadow.position.z - tower.z;
        const len = Math.hypot(dx, dz) || 1;
        m.position.set(
          shadow.position.x + (dx / len) * NIGHT.SHADOW.STRETCH, shadow.position.y,
          shadow.position.z + (dz / len) * NIGHT.SHADOW.STRETCH,
        );
        m.scale.copy(shadow.scale);
      });
    }
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

    // 視点（スタート画面の「視点」）。'first' の間、いつもの画面だけ自分の選手の目から映す
    let view = 'third';
    let viewChanged = false; // 切り替えた直後の1フレームは寄せずに瞬時に置く
    const fpEye = new THREE.Vector3();
    const fpLook = new THREE.Vector3();    // いま見ている点（寄せた後）
    const fpTarget = new THREE.Vector3();  // このフレームで見たい点
    const fpHead = new THREE.Vector3();
    const fpGlance = new THREE.Vector3(); // ポイントの間に見るもの（betweenPoints）
    const _dirA = new THREE.Vector3();
    const _dirB = new THREE.Vector3();
    const _ball = new THREE.Vector3();

    /**
     * 飛びつきボレーで体ごと飛び込んでいる度合い(0〜1)。飛び込みの形の効き（diveBody の legs）
     * そのもの：踏み切りから伸び、伏せている間は1、起き上がりで0へ戻る。技が出ていなければ0。
     */
    function diveWeight() {
      const body = you.userData.motion.dive;
      return body ? body.legs : 0;
    }

    /**
     * 一人称で効いている必殺技の演出の度合い（どれも0〜1。同時に2つは出ない）。
     * - dive：飛びつきボレー（diveWeight）
     * - tweener：ツイーナーで背を向けている度合い（scene/player.js#tweenerFlip）
     * - dunk：ダンクスマッシュの跳躍の高さ（頂点で1）。ダンクだけが通常のスマッシュの跳躍の
     *   上限（SWING.SMASH_JUMP_H）より高く跳ぶので、それで見分ける
     * - dunkHitT：ダンクで打ってからの秒数（打つ前は -1）
     */
    function firstPersonFx(state) {
      const p = state.you;
      const leap = p.leap;
      const dunking = !!leap && leap.kind === 'smash' && leap.lift > SWING.SMASH_JUMP_H + 1e-6;
      const hit = dunking && p.anim > 0 && p.stroke === 'smash';
      return {
        dive: diveWeight(),
        tweener: scene3d.tweenerFlip(p),
        dunk: dunking ? clamp(you.position.y / leap.lift, 0, 1) : 0,
        dunkHitT: hit ? PLAYER.SMASH_ANIM - p.anim : -1,
      };
    }

    /**
     * 一人称の目の位置（自分の選手の頭の少し後ろ。跳んだぶんだけ上がる）を fpEye に入れる。
     * 必殺技の間は体と一緒に動く：
     * - 飛びつきボレー：目を頭そのものへ寄せる＝球へ飛び込み、地面へ伏せ、起き上がる（DIVE）
     * - ツイーナー：背を向けて体を折り、股の下から覗く低い目へ（TWEENER）
     * - ダンクスマッシュ：跳躍よりさらに高く・前へ持ち上げる（DUNK）
     */
    function firstPersonEye(state, fx) {
      const F = CAMERA.FIRST_PERSON;
      fpEye.set(state.you.x, F.EYE_Y + you.position.y, state.you.z - F.BACK);
      if (fx.dive > 0) {
        const D = F.DIVE;
        you.userData.rig.head.getWorldPosition(fpHead); // このフレームのポーズは当て終わっている
        fpHead.y += D.EYE_UP;
        fpEye.lerp(fpHead, fx.dive);
        const p = scene3d.diveProgress(state.you);
        const s = p === null ? -1 : (p - SWING.DIVE.LAND) / D.JOLT_SPAN;
        if (s > 0 && s < 1) fpEye.y -= D.JOLT * Math.sin(Math.PI * s);
      }
      if (fx.tweener > 0) {
        const T = F.TWEENER;
        // 背を向けると頭は足元より自陣の奥（-z）側へ出る
        fpEye.y = lerp(fpEye.y, T.EYE_Y + you.position.y, fx.tweener);
        fpEye.z = lerp(fpEye.z, state.you.z - T.HEAD_FWD, fx.tweener);
      }
      if (fx.dunk > 0) {
        fpEye.y += F.DUNK.EYE_BOOST * fx.dunk;
        fpEye.z += F.DUNK.FWD * fx.dunk;
      }
      return fpEye;
    }

    /** ダンクスマッシュを打った瞬間の手応え（目の上下の揺れ(m)。寄せずにそのまま足す）。 */
    function dunkShake(fx) {
      const D = CAMERA.FIRST_PERSON.DUNK;
      if (fx.dunkHitT < 0 || fx.dunkHitT > D.SHAKE_T) return 0;
      const fade = 1 - fx.dunkHitT / D.SHAKE_T;
      return D.SHAKE * fade * fade * Math.sin(fx.dunkHitT * D.SHAKE_HZ * Math.PI * 2);
    }

    /**
     * 体と一緒に視界を傾ける（lookAt の後に呼ぶ）。
     * - 飛びつきボレー：体の倒れ込みと同じ向き。体の rotation.z はワールドの z（＝前）まわり、
     *   カメラのローカル z は後ろ向きなので符号を反転
     * - ツイーナー：股の下から覗くので、背を向けた度合いだけ逆さまへ
     */
    function rollWithBody(fx) {
      if (you.userData.motion.dive) camera.rotateZ(-you.rotation.z * CAMERA.FIRST_PERSON.DIVE.ROLL);
      if (fx.tweener > 0) camera.rotateZ(Math.PI * fx.tweener);
    }

    /**
     * 一人称の画角と近クリップ面。ラリー中は球を持っていないので近クリップ面を近づけ（RALLY_NEAR）、
     * 構えたラケットや前へ伸ばした逆手を映す。目のすぐ先に地面（伏せた飛びつきボレー）や自分の脚
     * （ツイーナー）があるときはさらに近づけ、ダンクスマッシュの跳躍の高さに応じて画角を広げる。
     */
    function firstPersonFov(state, fx) {
      const F = CAMERA.FIRST_PERSON;
      const base = state.phase === 'rally' ? F.RALLY_NEAR : F.NEAR;
      const near = Math.min(
        base,
        fx.dive > 0 ? lerp(base, F.DIVE.NEAR, fx.dive) : base,
        fx.tweener > 0 ? lerp(base, F.TWEENER.NEAR, fx.tweener) : base,
      );
      const fov = F.FOV + F.DUNK.FOV * fx.dunk;
      setFov(fov, near);
    }

    /**
     * 一人称の注視点。普段は相手コートの前方を見ていて、自分より前にある球は BALL_TRACK の
     * 割合だけ目で追う（背後へ抜けた球・トスで真上にある球では振り向かない）。
     * 高く上がった球だけは HIGH_TRACK の高さに応じて強く追い、ロブを見上げる。相手の打った
     * 高い球は頭上を少し越えても（HIGH_BEHIND まで）真上を見上げて追う（後ろへは振り向かない）。
     * 必殺技の間は球をいつもより強く追う（飛び込む球・股の下を抜ける球・叩き込んだ球）。
     * ポイントの間は、見るもの（betweenPoints）のほうへ首を回す。
     */
    function firstPersonLook(state, out, fx, glance) {
      const F = CAMERA.FIRST_PERSON;
      const p = state.you;
      const b = state.ball;
      out.set(p.x * (1 - F.LOOK_X), F.LOOK_Y, p.z + F.LOOK_AHEAD);
      if (b && ballMesh.visible) trackBall(out, p, b, fx);
      const D = F.DUNK;
      if (fx.dunkHitT >= 0 && fx.dunkHitT < D.NOD_T) out.y -= D.NOD * Math.sin(Math.PI * (1 - fx.dunkHitT / D.NOD_T) / 2);
      if (glance && glance.w > 0) turnToward(out, fpEye, glance.at, glance.w);
      return out;
    }

    function trackBall(out, p, b, fx) {
      const F = CAMERA.FIRST_PERSON;
      const H = F.HIGH_TRACK;
      const high = clamp((b.y - H.FROM_Y) / (H.FULL_Y - H.FROM_Y), 0, 1);
      const ahead = b.z > p.z + F.TRACK_MIN_Z;
      const overhead = high > 0 && b.last === 'cpu' && b.z > p.z - H.BEHIND;
      if (!ahead && !overhead) return;
      let track = lerp(F.BALL_TRACK, F.DIVE.BALL_TRACK, fx.dive);
      track = lerp(track, F.TWEENER.BALL_TRACK, fx.tweener);
      if (fx.dunkHitT >= 0) track = F.DUNK.TRACK;
      const w = lerp(track, H.WEIGHT, fx.dunkHitT >= 0 ? 0 : high);
      out.x = lerp(out.x, b.x, w);
      out.y = lerp(out.y, b.y, w);
      // 真上より後ろの点を見ると振り向いてしまうので、注視点は目より少し前に留める
      out.z = Math.max(lerp(out.z, b.z, w), fpEye.z + H.MIN_AHEAD);
      // 相手の球が向かってくる間は、近づくほど打点まで目で追う（INCOMING_TRACK）。点どうしを
      // 混ぜると遠くの注視点に引っ張られて視線がほとんど下がらないので、向きで寄せる
      const I = F.INCOMING_TRACK;
      if (ahead && b.last === 'cpu') {
        const near = clamp((I.FROM_D - Math.hypot(b.x - p.x, b.z - p.z)) / (I.FROM_D - I.FULL_D), 0, 1);
        if (near > 0) turnToward(out, fpEye, _ball.set(b.x, b.y, b.z), I.WEIGHT * near * near * (3 - 2 * near));
      }
    }

    /**
     * 注視点 out を、目 eye から見て target の方向へ w の割合だけ回す。点どうしを混ぜると
     * 真横・真後ろを向くとき目のすぐ近くを通って視界が跳ねるので、向き（左右・上下の角度）と
     * 距離で混ぜる。
     */
    function turnToward(out, eye, target, w) {
      _dirA.subVectors(out, eye);
      _dirB.subVectors(target, eye);
      const yawA = Math.atan2(_dirA.x, _dirA.z);
      const yawB = Math.atan2(_dirB.x, _dirB.z);
      const pitchA = Math.atan2(_dirA.y, Math.hypot(_dirA.x, _dirA.z));
      const pitchB = Math.atan2(_dirB.y, Math.hypot(_dirB.x, _dirB.z));
      const dYaw = Math.atan2(Math.sin(yawB - yawA), Math.cos(yawB - yawA));
      const yaw = yawA + dYaw * w;
      const pitch = lerp(pitchA, pitchB, w);
      const d = lerp(_dirA.length(), _dirB.length(), w);
      out.set(
        eye.x + Math.sin(yaw) * Math.cos(pitch) * d,
        eye.y + Math.sin(pitch) * d,
        eye.z + Math.cos(yaw) * Math.cos(pitch) * d,
      );
    }

    // --- ポイントの間（決着の直後に相手を見る・球を受け取る） ---
    let servePhaseT = -1;   // サーブ待ちになってからの秒数（サーブ待ちでなければ -1）
    let serveFeed = false;  // このサーブ待ちで、後ろのボールボーイが球を投げ渡すか
    let feedState = null;   // 投げ渡しの様子（ballPickup.update の戻り値）
    let feedCaughtT = -1;   // 球が手に届いてからの秒数

    /** 0→1（IN 秒）→そのまま（HOLD 秒）→0（OUT 秒）の重み。t は始まってからの秒数。 */
    function rampWindow(t, IN, HOLD, OUT) {
      if (t <= 0) return 0;
      if (t < IN) return ease(t / IN);
      if (t < IN + HOLD) return 1;
      return 1 - ease(clamp((t - IN - HOLD) / OUT, 0, 1));
    }

    /**
     * サーブ待ちの時計と、ボールボーイの投げ渡しを始めるかどうかを進める（生の state のときだけ）。
     * 投げ渡すのは一人称視点での自分のファーストサーブの番だけ。トスを上げたら、または
     * 一人称以外に切り替えたらそこで打ち切る（球はすぐサーバーの手に現れる）。
     */
    function tickServeWait(state, dt) {
      if (state.phase !== 'serve') {
        servePhaseT = -1;
        serveFeed = false;
        feedCaughtT = -1;
        return;
      }
      if (servePhaseT < 0) {
        servePhaseT = 0;
        serveFeed = view === 'first' && state.servingPlayer() === 'you' && state.serveNumber === 1
          && !state.practice;
        feedCaughtT = -1;
      } else {
        servePhaseT += dt;
      }
      if (state.tossActive || view !== 'first') serveFeed = false;
      if (feedState && feedState.caught) feedCaughtT = feedCaughtT < 0 ? 0 : feedCaughtT + dt;
    }

    /** ballPickup.update に渡す投げ渡しの指示（投げ渡していなければ null）。 */
    function feedRequest() {
      if (!serveFeed) return null;
      const t = servePhaseT - OFFICIALS.BALLKID.FEED.START;
      return t >= 0 ? { t, target: ballMesh.position } : null;
    }

    /**
     * ボールボーイの投げ渡しを切り上げる（Space）。球はすぐサーバーの手に現れ、目も前へ戻る。
     * @returns {boolean} 投げ渡しの最中だったか
     */
    function skipFeed() {
      if (!serveFeed) return false;
      serveFeed = false;
      return true;
    }

    /** 投げ渡しを待っている・飛んでいる間は、サーバーの手の本物の球を隠す。 */
    function feedHidesBall() {
      return serveFeed && !(feedState && feedState.caught);
    }

    /**
     * ポイントの間に一人称の目が見るもの（{at, w}。w＝首を回す割合。何もなければ null）。
     * - ダブルスで決着の直後：感情表現（EMOTION）をしているペアの胸元
     * - 自分のファーストサーブなら、続けて後ろのボールボーイと、投げ渡された球（BETWEEN.FEED）
     */
    function betweenPoints(state) {
      const B = CAMERA.FIRST_PERSON.BETWEEN;
      if (state.changeover || state.matchPointCut) return null;
      if (state.phase === 'over') {
        const mate = state.youMate;
        if (!state.doubles || !mate || !mate.mood) return null;
        const t = mate.mood.t - EMOTION.DELAY;
        const out = EMOTION.SPAN - B.MOOD_IN;
        fpGlance.set(mate.x, B.MOOD_Y, mate.z);
        return { at: fpGlance, w: rampWindow(t, B.MOOD_IN, out - B.MOOD_IN, B.MOOD_IN) };
      }
      if (state.phase !== 'serve' || servePhaseT < 0 || state.tossActive || state.aiTossActive) return null;
      const req = feedRequest();
      if (req && feedState) {
        const F = B.FEED;
        const flying = req.t >= OFFICIALS.BALLKID.FEED.WIND && !feedState.caught;
        fpGlance.copy(flying ? feedState.ball : feedState.kid);
        if (flying) fpGlance.lerp(feedState.kid, 1 - F.BALL_W);
        const w = feedState.caught ? 1 - ease(clamp(feedCaughtT / F.OUT, 0, 1)) : ease(clamp(req.t / F.IN, 0, 1));
        if (feedState.caught) fpGlance.copy(ballMesh.position); // 受け取った球を見下ろしてから前へ
        return { at: fpGlance, w };
      }
      return null;
    }

    function syncCamera(state, dt) {
      if (view === 'first') {
        const F = CAMERA.FIRST_PERSON;
        const fx = firstPersonFx(state);
        const glance = betweenPoints(state);
        firstPersonFov(state, fx);
        const eyeLerp = lerp(F.LERP, F.DIVE.LERP, fx.dive);
        const lookLerp = Math.max(
          lerp(F.LOOK_LERP, F.DIVE.LOOK_LERP, fx.dive),
          lerp(F.LOOK_LERP, F.TWEENER.LOOK_LERP, fx.tweener),
          fx.dunk > 0 ? F.DUNK.LOOK_LERP : 0,
        );
        // ツイーナー・ダンクの目は跳躍に合わせて一気に動くので、寄せずにその場へ置く
        if (fx.tweener > 0 || fx.dunk > 0) camera.position.copy(firstPersonEye(state, fx));
        else camera.position.lerp(firstPersonEye(state, fx), Math.min(1, dt * eyeLerp));
        fpLook.lerp(firstPersonLook(state, fpTarget, fx, glance), Math.min(1, dt * lookLerp));
        camera.lookAt(fpLook);
        rollWithBody(fx);
        camera.position.y += dunkShake(fx);
        return;
      }
      setFov(CAMERA.FOV);
      const player = state.you;
      const t = Math.min(1, dt * CAMERA.LERP);
      const follow = cameraFollowX(player.x);
      camera.position.x = lerp(camera.position.x, follow.pos, t);
      camera.position.y = lerp(camera.position.y, CAMERA.HEIGHT, t);
      camera.position.z = lerp(camera.position.z, -CAMERA.BACK, t);
      camera.lookAt(follow.look, CAMERA.LOOK_AT.y, CAMERA.LOOK_AT.z);
    }

    /**
     * 別のカット（リプレイ・マッチポイントの演出）から、いつもの画面へ瞬時に切り戻す
     * （lerp だと数フレームかけて振れながら戻り、その途中が見えてしまうため）。
     */
    function snapCamera(state) {
      if (view === 'first') {
        const fx = firstPersonFx(state);
        const glance = betweenPoints(state);
        firstPersonFov(state, fx);
        camera.position.copy(firstPersonEye(state, fx));
        fpLook.copy(firstPersonLook(state, fpTarget, fx, glance));
        camera.lookAt(fpLook);
        rollWithBody(fx);
        return;
      }
      setFov(CAMERA.FOV);
      const follow = cameraFollowX(state.you.x);
      camera.position.set(follow.pos, CAMERA.HEIGHT, -CAMERA.BACK);
      camera.lookAt(follow.look, CAMERA.LOOK_AT.y, CAMERA.LOOK_AT.z);
    }

    /**
     * その位置で鳴った音がカメラ（＝耳）からどう聞こえるか（audio.js#place に渡す）。
     * pan＝左右（-1 左〜1 右）、behind＝背後の度合い（0 前〜1 真後ろ）。
     * @param {{x:number, y:number, z:number}} at
     */
    const _ear = new THREE.Vector3();
    function earOf(at) {
      camera.updateMatrixWorld();
      camera.worldToLocal(_ear.set(at.x, at.y, at.z)); // カメラの座標：+x＝右、-z＝前
      const d = Math.hypot(_ear.x, _ear.z) || 1;
      return { pan: clamp(_ear.x / d, -1, 1), behind: clamp(_ear.z / d, 0, 1) };
    }

    /**
     * 視点を切り替える（'third'｜'first'）。次の sync() でいつもの画面へ瞬時に切り替わる
     * （三人称の高い位置から目の高さへ lerp で降りてくる途中を見せない）。
     */
    function setView(name) {
      if (view === name) return;
      view = name;
      viewChanged = true;
    }

    const BASE_NEAR = camera.near;
    /** 画角と近クリップ面（一人称だけ遠ざける。それ以外のカメラは作ったときの値に戻す）。 */
    function setFov(fov, near = BASE_NEAR) {
      if (camera.fov === fov && camera.near === near) return;
      camera.fov = fov;
      camera.near = near;
      camera.updateProjectionMatrix();
    }

    // --- マッチポイントの演出（game.matchPointCut。カメラを観客席へ切り替えて回す） ---
    // 試合が決まった後の締めのカット（game.finale.cut）も同じ切り替え・切り戻しを使う
    let cutShown = false; // 前のフレームで演出のカメラを映していたか（終わった瞬間に切り戻す）
    let crowdHype = 0;    // 観客の盛り上がり（0〜1。演出の間に上がり、終わると収まる）

    /**
     * コートの外周の楕円を回りながら、外側＝観客席を映すカメラ（MATCH_POINT.CAMERA）。
     * 位置は演出の経過時間（ゲームの時計）だけで決まる＝毎回同じ画になり、切り替わった
     * 最初のコマから lerp なしでその位置にいる（＝カットが切り替わって見える）。
     * スタンドは点対称なので、チェンジエンズで会場が回っていても同じ道筋でよい。
     * @param {{t:number}} cut game.matchPointCut
     */
    function placeMatchPointCamera(cut) {
      const C = MATCH_POINT.CAMERA;
      const u = clamp(cut.t / MATCH_POINT.DURATION, 0, 1);
      const angle = lerp(C.FROM, C.TO, lerp(u, u * u * (3 - 2 * u), C.EASE));
      const ahead = angle + C.LEAD;
      setFov(C.FOV);
      camera.position.set(C.RADIUS_X * Math.sin(angle), C.HEIGHT, C.RADIUS_Z * Math.cos(angle));
      camera.lookAt(C.LOOK_RADIUS_X * Math.sin(ahead), C.LOOK_Y, C.LOOK_RADIUS_Z * Math.cos(ahead));
    }

    /**
     * 試合が決まった後の締めのカット（game.finale.cut。FINALE.CAMERA）。勝った側（主力）の正面＝
     * ネット側から、少し回り込みながら引いて上がる。位置はカットの経過時間（ゲームの時計）と勝者の
     * 位置（カットの間は試合が止まっていて動かない）だけで決まる＝切り替わった最初のコマから
     * lerp なしでその位置にいる。
     * @param {{t:number, team:'you'|'cpu'}} finale game.finale
     */
    function placeFinaleCamera(finale, state) {
      const C = FINALE.CAMERA;
      const p = state[finale.team];
      const u = clamp(finale.t / FINALE.DURATION, 0, 1);
      const e = lerp(u, u * u * (3 - 2 * u), C.EASE);
      const at = (key) => lerp(C.FROM[key], C.TO[key], e);
      // ネットへ向かう向き（勝者の正面）。z=0 ちょうどにいることはまずないが、そのときはチームで決める
      const toNet = p.z === 0 ? (finale.team === 'you' ? 1 : -1) : -Math.sign(p.z);
      const angle = at('ANGLE') * toNet; // 勝者から見た右（相手側を向いて右）が＋になるよう向きで符号を揃える
      const dist = at('DIST');
      setFov(C.FOV);
      camera.position.set(
        p.x - Math.sin(angle) * dist,
        at('HEIGHT'),
        p.z + toNet * Math.cos(angle) * dist,
      );
      camera.lookAt(p.x, at('LOOK_Y'), p.z);
    }

    /**
     * プレイヤー1人ぶんの位置・スイング・歩行ポーズと影をまとめて反映する。
     * @param {object} frame 生の game state かリプレイの1コマ（ball・phase を読む）
     * @param {'hold'|'toss'|null} serve この選手がサーブを待っている／トス中か
     * @param {boolean} [cheer] 試合に勝った側か（両手を突き上げる。リプレイのコマでは渡さない）
     */
    function syncPlayer(mesh, shadow, state, maxSpeed, dt, frame, serve, cheer) {
      mesh.position.set(state.x, 0, state.z);
      scene3d.setSwingPose(mesh, state, {
        dt, ball: frame.ball, phase: frame.phase, serve, cheer: !!cheer,
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
     * @param {'you'|'cpu'|null} [winner] 試合に勝った側（両手を突き上げる。生の state のときだけ）
     */
    function applyFrame(state, dt, stages, winner) {
      syncPlayer(you, shadows.you, state.you, PLAYER.SPEED, dt, state, stages.you, winner === 'you');
      syncPlayer(cpu, shadows.cpu, state.cpu, PLAYER.CPU_CHASE, dt, state, stages.cpu, winner === 'cpu');

      youMate.visible = cpuMate.visible = shadows.youMate.visible = shadows.cpuMate.visible = state.doubles;
      if (state.doubles) {
        syncPlayer(youMate, shadows.youMate, state.youMate, PLAYER.CPU_CHASE, dt, state, stages.youMate,
          winner === 'you');
        syncPlayer(cpuMate, shadows.cpuMate, state.cpuMate, PLAYER.CPU_CHASE, dt, state, stages.cpuMate,
          winner === 'cpu');
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
      ['you', 'cpu', 'youMate', 'cpuMate'].forEach((key) => placeNightShadows(key, shadows[key]));
    }

    // --- 線審のコール（game.lineCall が変わったら、担当の線審が合図を出す） ---
    const lineJudges = officials.userData.lineJudges;
    let lastLineCall = null; // 最後に見た game.lineCall（コールのたびに新しいオブジェクトになるので参照で比べる）
    let judgeCall = null;    // { judge, kind, dir, recT }：合図を出している線審と、コールした録画時刻

    /**
     * そのコールを受け持つ線審と、会場の座標での「線から外へ」の向き。会場はチェンジエンズで
     * 180°回っている（venue.rotation.y）ので、ゲームの座標を会場の座標へ戻してから選ぶ。
     * ベースラインはその側の BASE、サイドラインはその側の SIDE、サービスライン・センター
     * サービスラインは落ちた半面にいる SIDE（officials.js#createLineJudges 参照）。
     */
    function pickLineJudge(call, swapped) {
      const k = swapped ? -1 : 1;
      const x = call.x * k;
      const z = call.z * k;
      const same = (a, b) => Math.sign(a) === Math.sign(b);
      const judge = lineJudges.find((j) => {
        if (call.line === 'base') return j.role === 'base' && same(j.z, z);
        if (call.line === 'side') return j.role === 'side' && same(j.x, x);
        return j.role === 'side' && same(j.z, z); // 'service' / 'center'
      });
      return judge ? { judge, dir: { x: call.out.x * k, z: call.out.z * k } } : null;
    }

    /** 合図の出し具合（0〜1）。コールから DELAY 遅れて上げ、HOLD だけ保って下ろす。 */
    function callWeight(age) {
      const ease = (u) => u * u * (3 - 2 * u);
      let t = age - LINE_CALL.DELAY;
      if (t <= 0) return 0;
      if (t < LINE_CALL.RAISE) return ease(t / LINE_CALL.RAISE);
      t -= LINE_CALL.RAISE + LINE_CALL.HOLD;
      if (t <= 0) return 1;
      return t < LINE_CALL.LOWER ? 1 - ease(t / LINE_CALL.LOWER) : 0;
    }

    function watchLineCall(state) {
      if (!state.lineCall || state.lineCall === lastLineCall) return;
      lastLineCall = state.lineCall;
      const picked = pickLineJudge(state.lineCall, state.endsSwapped);
      judgeCall = picked && {
        ...picked, kind: state.lineCall.kind, call: state.lineCall, recT: recClock,
      };
    }

    // --- ネットの揺れ（game.netHit が変わったら、当たった点から網を揺らす） ---
    let lastNetHit = null; // 最後に見た game.netHit（当たるたびに新しいオブジェクトになるので参照で比べる）
    let netShake = null;   // { hit, recT }：揺らしている当たりと、当たった録画時刻

    function watchNetHit(state) {
      if (!state.netHit || state.netHit === lastNetHit) return;
      lastNetHit = state.netHit;
      netShake = { hit: state.netHit, recT: recClock };
    }

    /**
     * 網を、録画の時計 clock の時点の形にする。shake はそのコマで最後に起きた当たり
     * （録画のコマにも添えてある＝試合後のハイライトでも、その1点の当たりで揺れる）。
     */
    function poseNet(shake, clock) {
      scene3d.shakeNet(net, shake && shake.hit, shake ? clock - shake.recT : 0);
    }

    // --- 決まった後の球（転がる・ボールボーイが拾う。game.netBallRest・looseBalls どおり。ballkid.js） ---
    const ballPickup = scene3d.createBallPickup(officials.userData, venue);

    // --- クレーのボールマーク（game.lastBounce が変わったら跡を1つ足す） ---
    let lastBounceSeen = null;
    let lastMark = null;     // 最後に残した跡 { bounce, shape }（リプレイの最後で映すかの判定に使う）
    let marksGame = null;    // 跡を残している試合（Game を作り直したら消す）
    let marksGames = 0;      // そのときのゲーム数の合計（減った＝セットが終わってブラシがかかった）

    function watchBallMarks(state) {
      const games = state.match.games.you + state.match.games.cpu;
      if (state !== marksGame || games < marksGames) {
        ballMarks.clear();
        lastMark = null;
        marksGame = state;
      }
      marksGames = games;
      const bounce = state.lastBounce;
      if (!bounce || bounce === lastBounceSeen) return;
      lastBounceSeen = bounce;
      if (BALL_MARK.SURFACES.indexOf(SURFACE.NAME) === -1) return;
      lastMark = { bounce, shape: ballMarks.add(bounce, state.endsSwapped) };
    }

    /**
     * 跡を真上近くから映すカメラ（クレーで際どいコールだったときの、主審の確認の代わり）。
     * 跡からコートの内側へ引いて、線をまたいで跡を見下ろす。
     * @param {{shape:{x:number, z:number}, n:{x:number, z:number}}} check
     */
    function placeMarkCamera(check) {
      const { shape, n } = check;
      const side = { x: -n.z, z: n.x }; // 線と平行な向き
      camera.position.set(
        shape.x - n.x * BALL_MARK.CHECK_CAM_BACK + side.x * BALL_MARK.CHECK_CAM_SIDE,
        BALL_MARK.CHECK_CAM_HEIGHT,
        shape.z - n.z * BALL_MARK.CHECK_CAM_BACK + side.z * BALL_MARK.CHECK_CAM_SIDE,
      );
      camera.lookAt(shape.x, 0, shape.z);
    }

    /**
     * 線審の腕を、録画の時計 clock の時点の合図にする。通常表示は今の録画時刻、リプレイは
     * 再生中のコマの録画時刻を渡す＝リプレイでも、球が着いた瞬間に同じ線審がコールする。
     */
    function poseLineJudges(clock) {
      const w = judgeCall ? callWeight(clock - judgeCall.recT) : 0;
      lineJudges.forEach((judge) => {
        if (judgeCall && judge === judgeCall.judge && w > 0) {
          scene3d.setLineJudgePose(judge, judgeCall.kind, judgeCall.dir, w);
        } else {
          scene3d.setLineJudgePose(judge, null, null, 0);
        }
      });
    }

    // --- ポイント終了後のリプレイ（表示側のみ。ゲームロジックには一切触れない） ---
    // 直近 REPLAY.WINDOW_SEC 秒ぶんのスナップショットをリングバッファに録り続け、
    // startReplay() が呼ばれた瞬間の中身をそのまま固定して再生する。
    let history = [];
    let recClock = 0; // 録画用の合成クロック（dt を足すだけ。壁時計には依存しない）
    let reel = [];
    let replaying = false;
    let replayClock = 0;
    let replayHold = REPLAY.HOLD_SEC; // 最後のコマで静止する長さ（線審のコールで終わる再生だけ長い）
    let markCheck = null; // リプレイの最後で映すボールマーク（{ shape, n }。映さないなら null）
    // startReplay(wait) で待っている間の予約（{ endT, wait, clipId }）。endT＝決着の瞬間の録画時刻
    let pendingReplay = null;
    // 試合後のハイライト用に残しておくポイントの録画（game.pointLog の id → { frames, swapped }）。
    // 残すかどうかは game.highlightKeep() を見て main.js が pruneClips() で間引く。
    const clips = new Map();
    // ハイライトの再生中だけ { queue:[{frames, swapped, point}], index }。
    let highlight = null;
    let swappedNow = false; // 最後に sync() した時点の会場の向き（録画に添える）

    /** state.you/cpu/youMate/cpuMate のうち、見た目の再現に必要な分だけを浅くコピーする */
    function snapshotPlayer(p) {
      return {
        x: p.x, z: p.z, anim: p.anim, stroke: p.stroke, prep: p.prep, spin: p.spin,
        chargeFrac: p.chargeFrac, swingCharge: p.swingCharge, speed: p.speed,
        // 人間だけ：溜めを離してから当たるまで（フォワードスイングを出すか・どちら向きか）
        charging: p.charging, swing: p.swing, chargeStroke: p.chargeStroke, chargeSpin: p.chargeSpin,
        // 必殺技（フォーム・ジャンプの高さ・倒れ込みに効く）と、縮地の残像。
        special: p.special || null,
        // 跳躍（打球のモーションとは別の時計。スマッシュ／ジャックナイフ／サーブ）。
        // lift（スマッシュで跳ぶ高さ）は当たるまで毎フレーム変わりうるので、コマごとに録る
        leap: p.leap ? {
          t: p.leap.t, kind: p.leap.kind, span: p.leap.span, rise: p.leap.rise, reach: p.leap.reach,
          lift: p.leap.lift, dunk: p.leap.dunk, t0: p.leap.t0, v0: p.leap.v0,
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
        netShake,
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

    /**
     * ポイントが決まった瞬間に main.js から呼ぶ。録れていなければ何もしない。
     * @param {number} [wait] 再生を始めるまでの秒数（線審のコールで決まったポイントは、通常の
     *   画面でコールを見せてから再生する。LINE_CALL.REPLAY_DELAY）。待っている間も録画は続くが、
     *   再生するのは呼ばれた瞬間（＝決着の瞬間）までのコマ。
     */
    function startReplay(wait = 0, clipId = null) {
      if (wait > 0) {
        pendingReplay = { endT: recClock, wait, clipId };
        return;
      }
      beginReplay(recClock, clipId);
    }

    /**
     * そのポイントのリプレイをどこから再生するか（録画時刻）。内容で長さを変える（REPLAY.SHOTS 参照）。
     * 打った瞬間は、球の「打たれてからの時間」(ball.age) が前のコマより戻ったコマで見分ける
     * （サーブもラリーの1打も age を0に戻す。トスの間は球が生きていないので age は進まない）。
     * segment の先頭はサーブの構えなので、最初に見つかる1打は必ずサーブ。
     * @param {Array<object>} segment 決着したサーブの構えから決着までのコマ
     */
    function replayStart(segment) {
      const endT = segment[segment.length - 1].t;
      const hits = [];
      for (let i = 1; i < segment.length; i++) {
        if (segment[i].ball.age < segment[i - 1].ball.age) hits.push(i);
      }
      let startT = endT - REPLAY.MIN_PLAY_SEC;
      if (hits.length) {
        const last = hits[hits.length - 1];
        // 決め球が届く前の球が一度も弾んでいない＝ボレー・スマッシュ（サーブそのものは除く）
        const atNet = hits.length > 1 && segment[last - 1].ball.bounces === 0;
        const first = Math.max(0, hits.length - (atNet ? REPLAY.NET_SHOTS : REPLAY.SHOTS));
        startT = segment[hits[first]].t - (first === 0 ? REPLAY.SERVE_LEAD_SEC : REPLAY.LEAD_SEC);
      }
      return clamp(startT, endT - REPLAY.MAX_PLAY_SEC, endT - REPLAY.MIN_PLAY_SEC);
    }

    /**
     * endT（録画時刻）までの、決着したサーブの構えから後のコマを切り出す（足りなければ null）。
     */
    function cutReel(endT) {
      const recorded = history.filter((f) => f.t <= endT);
      if (recorded.length < 2) return null;
      // 再生してよいのは、決着したサーブの構えに入ってから後のコマだけ。
      // 以前は直近 MAX_PLAY_SEC ぶんをそのまま切り出していたため、サーブで決まる短い
      // ポイント（特にダブルフォルト：CPU は構えてから打つまで2秒足らず）では、頭に
      // 1本目のフォールトの後始末（ネットに掛かって止まったボールなど）や前のポイントの
      // 終わりが混ざり、そこから beginServe() が選手とボールをスタンスへ瞬間移動させる
      // コマまで映っていた＝「アウトなのにネットに掛かる」「立ち位置が一瞬おかしい」。
      let from = recorded.length - 1; // 最後のコマ＝決着の瞬間（phase は 'over'）
      // ネットに掛かったポイントは、決着の後に球が落ちて着地するまでを末尾に含めて再生する
      // （main.js が着地の瞬間を endT にする）。その間のコマは既に 'over' なので先に遡っておく。
      while (from > 0 && recorded[from - 1].phase === 'over') from--;
      while (from > 0 && IN_POINT.has(recorded[from - 1].phase)) from--;
      const segment = recorded.slice(from);
      // MAX_PLAY_SEC で長さを絞るのは前側（リード）だけ。末尾は必ず history の最後の
      // コマ＝ポイントが決まった瞬間（アウトならボールが実際にベースラインを越えた
      // 座標）まで含める。ここを history.slice() のまま先頭から MAX_PLAY_SEC ぶんだけ
      // 再生していたときは、肝心の決着の瞬間が再生範囲の外に切り落とされ、
      // リプレイがボールの決着より手前で止まって見えていた。
      const startT = replayStart(segment);
      let cut = segment.filter((f) => f.t >= startT);
      if (cut.length < 2) cut = segment.slice(-2);
      return cut.length < 2 ? null : cut; // このサーブのコマが録れていない
    }

    /** そのポイントの録画をハイライト用に残す（clipId が無ければ何もしない）。 */
    function keepClip(clipId, frames) {
      if (clipId == null || !frames) return;
      clips.set(clipId, { frames, swapped: swappedNow });
    }

    /** 再生はせずに、いまの時点までをそのポイントの録画として残す（リプレイをスキップされたとき）。 */
    function captureClip(clipId, endT = recClock) {
      keepClip(clipId, cutReel(endT));
    }

    /** @param {Set<number>} keep game.highlightKeep() */
    function pruneClips(keep) {
      [...clips.keys()].forEach((id) => { if (!keep.has(id)) clips.delete(id); });
    }

    /** Game を作り直したとき（id が1から振り直される）に、前の Game の録画を捨てる。 */
    function resetClips() {
      clips.clear();
      highlight = null;
    }

    /** endT（録画時刻）までのコマを切り出して再生を始める。 */
    function beginReplay(endT, clipId = null) {
      const cut = cutReel(endT);
      if (!cut) return;
      keepClip(clipId, cut);
      reel = cut;
      replayClock = 0;
      replaying = true;
      // 決着の瞬間に線審がコールしていれば、静止している間にその合図を見せる
      const called = judgeCall && judgeCall.recT >= reel[0].t && judgeCall.recT <= reel[reel.length - 1].t;
      replayHold = called ? Math.max(REPLAY.HOLD_SEC, LINE_CALL.REPLAY_HOLD) : REPLAY.HOLD_SEC;
      // さらにクレーで際どいコールだったなら、合図の後で跡を映す（そのバウンドに跡が残っているときだけ）
      const call = called && judgeCall.call;
      markCheck = call && call.decisive && Math.abs(call.inside) <= BALL_MARK.CHECK_MARGIN
        && lastMark && lastMark.bounce.call === call
        ? { shape: lastMark.shape, n: call.out } : null;
      if (markCheck) replayHold = Math.max(replayHold, BALL_MARK.CHECK_AFTER + BALL_MARK.CHECK_HOLD);
    }

    /**
     * 試合後のハイライトを流し始める（game.highlightPicks() の記録を古い順に）。録画が残っている
     * 1点だけを流す。1本も残っていなければ false（main.js はそのままスタッツ画面を開く）。
     * 流し終えたら録画は捨てる（次の試合の id とは混ざらないが、持っていても使わない）。
     * @param {Array<{id:number}>} points
     */
    function playHighlights(points) {
      const queue = points.filter((p) => clips.has(p.id)).map((p) => ({ ...clips.get(p.id), point: p }));
      clips.clear();
      if (!queue.length) return false;
      highlight = { queue, index: 0 };
      playClip();
      return true;
    }

    function playClip() {
      reel = highlight.queue[highlight.index].frames;
      replayClock = 0;
      replaying = true;
      replayHold = HIGHLIGHT.HOLD_SEC;
      markCheck = null;
      // 前の1本の終わりからカメラを振って寄せない（別の場面なので切り替わって見せる）
      camera.position.z = clamp(reel[0].ball.z, -HALF_L, HALF_L);
    }

    /** ハイライトの再生中なら { index, total, point }（HUD の見出しに使う）。それ以外は null。 */
    function highlightInfo() {
      if (!replaying || !highlight) return null;
      return { index: highlight.index, total: highlight.queue.length, point: highlight.queue[highlight.index].point };
    }

    /** リプレイ中にキー操作があったら main.js から呼ぶ。即座に通常表示へ戻す（予約も取り消す）。 */
    function skipReplay() {
      // 待っている間に飛ばされたポイントも、ハイライトの候補としては録っておく
      if (pendingReplay) captureClip(pendingReplay.clipId, pendingReplay.endT);
      replaying = false;
      pendingReplay = null;
      highlight = null; // ハイライトは残りの本数ごと飛ばす
    }

    /** 再生の最後で、ボールマークを映している最中か（HUD の表示に使う）。 */
    function isCheckingMark() {
      return replaying && !!markCheck && replayClock > replayEnd() + BALL_MARK.CHECK_AFTER;
    }

    /** 再生する長さ（録画の秒。最後のコマで静止する時間は含まない）。 */
    function replayEnd() {
      return reel[reel.length - 1].t - reel[0].t;
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
      swappedNow = !!state.endsSwapped;
      // ハイライトは別の時点の1点なので、会場もその1点のときの向きで映す
      const swapped = replaying && highlight ? highlight.queue[highlight.index].swapped : swappedNow;
      venue.rotation.y = swapped ? Math.PI : 0;
      // 旗はリプレイ中も今の風でなびかせる（再生中は game.update() が止まっていて風も変わらない）。
      // game.wind/windZ はゲームの座標（人間のチームから見た向き）なので、180°回っている会場の
      // 座標へ戻して渡す＝チェンジエンズの瞬間に旗がくるりと向きを変えたりしない。
      const venueSide = state.endsSwapped ? -1 : 1;
      scene3d.updateFlags(flags, state.wind * venueSide, state.windZ * venueSide, dt);
      // 観客はマッチポイントの演出の間と、試合が決まってからスタッツ画面が出るまで総立ちで沸く。
      // スタッツ画面の番になったら（finale.done）、拍手が収まっていくのに合わせてゆっくり座る。
      const cut = state.matchPointCut;
      const finale = state.finale;
      const H = MATCH_POINT.CROWD;
      if (cut || (finale && !finale.done)) crowdHype = Math.min(1, crowdHype + dt * H.RISE);
      else crowdHype = Math.max(0, crowdHype - dt * (finale ? FINALE.CROWD_FALL : H.FALL));
      scene3d.updateCrowd(crowd, crowdHype, dt);
      weather.update(state, dt);
      // 録画は再生中も止めない：裏では game.update() が実際の試合を進め続けているので、
      // ここで録り漏らすと再生の直後に次のポイントがすぐ終わったとき history が
      // 足りず（history.length<2）、そのポイントのリプレイだけ出せなくなってしまう。
      recordFrame(state, dt);
      watchLineCall(state);
      watchNetHit(state);
      watchBallMarks(state);
      if (pendingReplay) {
        pendingReplay.wait -= dt;
        if (pendingReplay.wait <= 0) {
          const { endT, clipId } = pendingReplay;
          pendingReplay = null;
          beginReplay(endT, clipId);
        }
      }

      if (replaying) {
        replayClock += dt * (highlight ? HIGHLIGHT.SPEED : REPLAY.SPEED);
        // reel は startReplay() の時点で末尾（決着の瞬間）を必ず含む形に切り出し済みなので、
        // ここでは単純にその全長を再生し切ればよい。
        const playEnd = replayEnd();
        // playEnd を過ぎても HOLD_SEC の間は最後のコマを横視点のまま静止させる。
        // これがないと、再生終了と同時に裏で進んでいた本編（次のポイントの支度）が
        // 通常カメラへ lerp で戻る途中に映り込み、「戻りながら次が始まって見える」
        // 落ち着かない切り替わりになってしまう。
        if (replayClock <= playEnd + replayHold) {
          scene3d.setOwnView(you, false); // 一人称でもリプレイは外から映すので体を戻す
          const frame = frameAt(Math.min(replayClock, playEnd));
          applyFrame(frame, dt, frame.stages);
          // 静止している間（HOLD_SEC）も線審の時計だけは進める＝決着の瞬間のコールが見える
          poseLineJudges(reel[0].t + replayClock);
          poseNet(frame.netShake, reel[0].t + replayClock);
          ballPickup.update(state, dt, true);
          scene3d.updateTrail(trail, NO_TRAIL); // 再生そのものが「振り返り」なので軌跡は隠す
          scene3d.placeSmashHint(smashHint, null);
          scene3d.placeSwingGuide(swingGuide, null, state.you);
          // 跡を映している間は球と影を消す（最後のコマの球がちょうど跡の上に乗っていて隠すため。
          // 実際の中継でも、跡のアップは球が去った後の地面を映す）
          const checking = isCheckingMark();
          ballMesh.visible = shadows.ball.visible = !checking;
          if (checking) placeMarkCamera(markCheck);
          else placeReplayCamera(frame, dt, swapped ? -1 : 1);
          return;
        }
        if (highlight && highlight.index < highlight.queue.length - 1) {
          highlight.index++; // 次の1本へ（通常表示へは戻らない）
          playClip();
          return;
        }
        highlight = null;
        replaying = false; // 再生し終わったら通常表示へ戻る
        // 横視点で静止していた状態から通常カメラへは lerp させず瞬時に切り替える
        snapCamera(state);
      }

      // 雨天中断でシートが掛かっている間は、選手はコートを離れている（球も片付けてある）。
      // ダブルスの2人の表示は applyFrame() が決めるので、隠すのはその後
      const away = weather.isCovered(state);
      you.visible = cpu.visible = shadows.you.visible = shadows.cpu.visible = !away;
      applyFrame(state, dt, serveStages(state), finale && finale.team);
      if (away) {
        youMate.visible = cpuMate.visible = shadows.youMate.visible = shadows.cpuMate.visible = false;
        Object.keys(nightShadows).forEach((key) => nightShadows[key].forEach((m) => { m.visible = false; }));
      }
      tickServeWait(state, dt);
      feedState = ballPickup.update(state, dt, false, feedRequest());
      // 決まった後の球は、本物の球の代わりに ballkid.js の見た目だけの球を見せる（ネットに掛かって
      // 拾われるのを待つ球、片付け前の球へ動きを引き継いだ球 ball.parked）。サーバーへ投げ渡して
      // いる間も、手に持つ本物の球を隠す（投げた球が届いたら入れ替わる）
      ballMesh.visible = shadows.ball.visible = !away && !ballPickup.active(state) && !state.ball.parked
        && !feedHidesBall();
      poseLineJudges(recClock);
      poseNet(netShake, recClock);
      // 軌跡はラリーの決着がついた後（ポイント間の 'serve' 待ち・'over'）だけ見せる。
      // ラリー中に出しっぱなしだと本来の目的（アウトの結果を振り返る）を超えて
      // 「次にどこへ来るか」の手がかりになってしまうため。観客席や勝者を映す演出のカットでも
      // 隠す（コートの外から映すと、前のポイントの軌跡が線になって空に浮いて見える）。
      const cutting = cut || (finale && finale.cut) || away; // シートの上にも浮かせない
      scene3d.updateTrail(trail, state.phase === 'rally' || cutting ? NO_TRAIL : state.trail);
      // スマッシュの先回り地点。打てる球が来ていないフレームは state.smashHint が null になる。
      scene3d.placeSmashHint(smashHint, state.smashHint);
      // ガイド付きモードの「いま離したらここへ飛ぶ」。それ以外は state.swingGuide が null。
      scene3d.placeSwingGuide(swingGuide, state.swingGuide, state.you);
      // 練習モードの移動のレッスンの目印（それ以外は出さない）
      scene3d.placePracticeTarget(practiceTarget, state.practice && state.practice.target);

      // 一人称の間は、自分の体（前腕・手・ラケット以外）を隠す（目の位置から見ると頭の内側や
      // 首・胴が画面に入る）。外から映すカット（マッチポイントの演出・締めのカット）では戻す。
      const cutCamera = !!(cut || (finale && finale.cut));
      scene3d.setOwnView(you, view === 'first' && !cutCamera);
      // ツイーナーで背を向けたら、股の下から覗く絵になるよう脚と腰だけ映す
      if (view === 'first' && !cutCamera
        && scene3d.tweenerFlip(state.you) >= CAMERA.FIRST_PERSON.TWEENER.LEGS_FROM) scene3d.showOwnLegs(you);
      if (cut) {
        placeMatchPointCamera(cut);
        cutShown = true;
      } else if (finale && finale.cut) {
        placeFinaleCamera(finale, state);
        cutShown = true;
      } else if (cutShown || viewChanged) {
        cutShown = false;
        viewChanged = false;
        snapCamera(state);
      } else {
        syncCamera(state, dt);
      }
    }

    /** スタート画面でのサーフェス選択を、コートの見た目（テクスチャ色）へ反映する。 */
    function setSurface(surfaceName) {
      scene3d.setCourtSurface(court, surfaceName);
    }

    /** スタート画面の時間帯（'day'｜'night'）を、空・照明・照明塔へ反映する。 */
    function setSession(name) {
      weather.setSession(name);
    }

    return {
      sync, render: stage.render, scene, camera, setSurface, startReplay, skipReplay, isReplaying, skipFeed,
      setScoreboard: scoreboards.set,
      isCheckingMark, captureClip, pruneClips, resetClips, playHighlights, highlightInfo,
      setSession, setView, earOf, rainLevel: () => weather.rainLevel(),
    };
  };
})(window.RallyOne = window.RallyOne || {});
