/**
 * 選手のメッシュ（胴・頭・両腕・両脚・ラケット）とポーズ制御。全員右利き。
 *
 * - 腕は肩→肘→手の2関節。振り付けは「手をどこに置き、ラケットをどちらへ向けるか」の
 *   キーポーズ（config の MOTION）で書き、肘の角度は solveArm()（2関節のIK）が逆算する。
 * - 1打は φ という1本の時間軸（0＝テイクバック、1＝打点、2＝振り終わり）に沿って
 *   キーポーズの間を補間する（evalClip）。打点より前はボールが届くまでの残り時間
 *   （ballApproach）や跳躍の上昇から、打点より後ろは anim から φ を進める（chooseMotion）。
 * - 逆手（左手）はトスを上げ、構えではスロートに添え、両手打ちのバックハンドでは
 *   グリップを握る。走るときは前後に振る。
 * - 違う振り付けへ移るとき（構え→テイクバック、振り終わり→構え）は、直前の形から短い
 *   時間で寄せる（setSwingPose のクロスフェード）。
 * - 歩行/走行は setGaitPose()（脚・体幹の上下ゆれ・前傾と、ポーズの膝の沈み込み）。
 *   跳んで打つ1打の体（跳躍・脚）は apply*() が歩行の上から重ねる。
 *
 * world.js#syncPlayer から毎フレーム setSwingPose → setGaitPose → apply* → finishPose の
 * 順に呼ぶ。腕のIKは体幹の最終的な傾きが決まってから解く（トスの左手はボールの
 * ワールド座標を追う）ので、最後の finishPose() が受け持つ。
 */
(function (RallyOne) {
  'use strict';

  const {
    COURT, GAIT, MOTION, PHYSICS, PLAYER, SERVE, SPECIAL, SWING, THEME,
  } = RallyOne.config;
  const { clamp, lerp } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  const TWO_PI = Math.PI * 2;
  /**
   * ラケットを持つ腕がモデルのローカルのどちら側にあるか。**-1 ＝ 右利き**（-x 側）。
   * MOTION の振り付けは「+x ＝ ラケット側」で書いてあり、x 成分とひねり・傾きにこれを
   * 掛けてモデルの座標へ移す。game.js の RACKET_SIDE（当たり判定のフォア/バック）と
   * 必ず同じ向きにすること（ずれると「フォアと判定された球を逆の手で振る」ことになる）。
   */
  const HAND = -1;
  const RIG = MOTION.RIG;
  const RACKET = MOTION.RACKET;
  const G = Math.abs(PHYSICS.GRAVITY);
  /** トスの初速（game.js#tossBall と同じ）。トスの進み具合をボールの上向きの速さから読む */
  const TOSS_VY = Math.sqrt(2 * G * (SERVE.TOSS_PEAK - SERVE.BALL_Y));

  /* ------------------------------------------------------------ メッシュ */

  function mat(color) {
    return new THREE.MeshLambertMaterial({ color });
  }

  /** ラケット（手のローカル。−y がヘッド、面の法線が +z）。MOTION.RACKET の寸法 */
  function createRacket() {
    const racket = new THREE.Group();
    const frameMat = mat(THEME.BALL);

    const grip = new THREE.Mesh(
      new THREE.CylinderGeometry(RACKET.GRIP_R, RACKET.GRIP_R * 1.12, RACKET.BUTT + RACKET.GRIP, 8),
      mat(THEME.GRIP),
    );
    grip.position.y = (RACKET.BUTT - RACKET.GRIP) / 2;
    racket.add(grip);

    // スロート：グリップの上端からヘッドの下端の左右へ、細い2本の V 字
    const headBottom = RACKET.HEAD_Y - RACKET.HEAD_L;
    [-1, 1].forEach((s) => {
      const dx = s * RACKET.HEAD_W * 0.55;
      const dy = headBottom - RACKET.GRIP;
      const bar = new THREE.Mesh(
        new THREE.CylinderGeometry(RACKET.THROAT_R, RACKET.THROAT_R, Math.hypot(dx, dy), 6),
        frameMat,
      );
      bar.position.set(dx / 2, -(RACKET.GRIP + dy / 2), 0);
      bar.rotation.z = Math.atan2(dx, dy);
      racket.add(bar);
    });

    // ヘッド：楕円のフレーム（輪をつぶすと太さまでつぶれるので、楕円の線に沿って管を作る）
    const ring = [];
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * TWO_PI;
      ring.push(new THREE.Vector3(RACKET.HEAD_W * Math.cos(a), RACKET.HEAD_L * Math.sin(a), 0));
    }
    const frame = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ring, true), 40, RACKET.TUBE, 6, true),
      frameMat,
    );
    frame.position.y = -RACKET.HEAD_Y;
    const strings = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: RACKET.STRING_OPACITY, side: THREE.DoubleSide,
      }),
    );
    strings.scale.set(RACKET.HEAD_W, RACKET.HEAD_L, 1);
    strings.position.y = -RACKET.HEAD_Y;
    racket.add(frame, strings);
    return racket;
  }

  /**
   * 腕1本（肩→肘→手）。肩・肘・手はそれぞれ Group で、骨はローカル −y へ伸びる。
   * 向きは毎フレーム solveArm() が決める。
   * @param {number} side 肩がモデルのローカル x のどちら側か
   */
  function createArm(side, shirt, withRacket) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * RIG.SHOULDER_X, RIG.SHOULDER_Y, 0);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(RIG.UPPER_R * 1.35, 10, 8), mat(shirt));
    const sleeveLen = RIG.UPPER * RIG.SLEEVE;
    const sleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(RIG.UPPER_R * 1.3, RIG.UPPER_R * 1.2, sleeveLen, 10),
      mat(shirt),
    );
    sleeve.position.y = -sleeveLen / 2;
    const upper = new THREE.Mesh(
      new THREE.CylinderGeometry(RIG.UPPER_R, RIG.FORE_R * 1.1, RIG.UPPER, 8),
      mat(THEME.SKIN),
    );
    upper.position.y = -RIG.UPPER / 2;
    shoulder.add(cap, sleeve, upper);

    const elbow = new THREE.Group();
    elbow.position.y = -RIG.UPPER;
    const foreLen = RIG.FORE - RIG.HAND_R;
    const fore = new THREE.Mesh(
      new THREE.CylinderGeometry(RIG.FORE_R * 1.1, RIG.FORE_R * 0.8, foreLen, 8),
      mat(THEME.SKIN),
    );
    fore.position.y = -foreLen / 2;
    elbow.add(new THREE.Mesh(new THREE.SphereGeometry(RIG.FORE_R * 1.15, 8, 6), mat(THEME.SKIN)), fore);
    shoulder.add(elbow);

    const hand = new THREE.Group();
    hand.position.y = -RIG.FORE;
    hand.add(new THREE.Mesh(new THREE.SphereGeometry(RIG.HAND_R, 10, 8), mat(THEME.SKIN)));
    if (withRacket) hand.add(createRacket());
    elbow.add(hand);

    return {
      shoulder, elbow, hand,
      // IK の結果（体幹ローカル）。finishPose が逆手の目標（グリップ）を作るのに使う
      reached: new THREE.Vector3(),
      upperQ: new THREE.Quaternion(),
      foreQ: new THREE.Quaternion(),
    };
  }

  /** 股関節(hip)→膝(knee)→足首(ankle)、の3関節チェーンを1本作る。 */
  function createLeg(sign, shorts) {
    const hip = new THREE.Group();
    hip.position.set(sign * GAIT.HIP_X, GAIT.HIP_Y, 0);

    const thigh = new THREE.Mesh(
      new THREE.CylinderGeometry(GAIT.THIGH_R[0], GAIT.THIGH_R[1], GAIT.THIGH_LEN, 10),
      mat(shorts),
    );
    thigh.position.y = -GAIT.THIGH_LEN / 2;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -GAIT.THIGH_LEN;
    hip.add(knee);

    const shin = new THREE.Mesh(
      new THREE.CylinderGeometry(GAIT.SHIN_R[0], GAIT.SHIN_R[1], GAIT.SHIN_LEN, 10),
      mat(THEME.SKIN),
    );
    shin.position.y = -GAIT.SHIN_LEN / 2;
    knee.add(shin);

    // 足首（膝を曲げても足裏を地面と平行に保つため。finishPose が角度を入れる）
    const ankle = new THREE.Group();
    ankle.position.y = -GAIT.SHIN_LEN;
    knee.add(ankle);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(...GAIT.FOOT), mat(0x1c2531));
    foot.position.set(0, 0, GAIT.FOOT[2] * 0.28);
    ankle.add(foot);

    return { hip, knee, ankle };
  }

  /** 頭と帽子（つば）。頭は球なので、つばが無いとどちらを向いているか読めない */
  function createHead(cap) {
    const head = new THREE.Group();
    head.position.y = RIG.HEAD_Y;
    head.add(new THREE.Mesh(new THREE.SphereGeometry(RIG.HEAD_R, 16, 12), mat(THEME.SKIN)));
    const crown = new THREE.Mesh(
      new THREE.SphereGeometry(RIG.HEAD_R * 1.05, 16, 8, 0, TWO_PI, 0, Math.PI * 0.42),
      mat(cap),
    );
    const brim = new THREE.Mesh(new THREE.BoxGeometry(RIG.HEAD_R * 1.25, 0.014, RIG.HEAD_R * 0.8), mat(cap));
    brim.position.set(0, RIG.HEAD_R * 0.42, RIG.HEAD_R * 0.95);
    head.add(crown, brim);
    return head;
  }

  /* ------------------------------------------------------------ ポーズ（数値の配列） */

  // 1フレームぶんの上半身の形を数値の配列で持つ。補間もクロスフェードもチャンネルごとの
  // 線形演算だけで済む。座標は MOTION の座標系（+x＝ラケット側、ひねる前）。
  const C = {
    HAND: 0, DIR: 3, FACE: 6, ELBOW: 9, OFF: 12, OFF_ELBOW: 15,
    W_GRIP: 18, W_THROAT: 19, W_BALL: 20,
    TWIST: 21, HIPS: 22, BEND: 23, CROUCH: 24, LEAN: 25, SWAY: 26,
  };
  const CHANNELS = 27;
  /** サーブを待つ間のボールの位置（MOTION の座標）。game.js#placeServeBall と同じ置き方 */
  const BALL_HOLD = [0, SERVE.BALL_Y - GAIT.HIP_Y, 0.4];

  function unit(v) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  function setVec(p, at, v) {
    p[at] = v[0];
    p[at + 1] = v[1];
    p[at + 2] = v[2];
  }

  /**
   * 逆手の指定（MOTION のコメント参照）を、3つの重み（グリップ／スロート／ボール）と
   * 自由な位置（残りの重み）に直す。自由な位置を指定しなかったポーズにも、その
   * ポーズで握る・添える位置を入れておく：別の指定のキーと補間するとき、自由な位置の
   * 側もそこから寄っていくように。
   */
  function setOff(p, off) {
    let spec = off;
    if (typeof off === 'string') spec = { [off]: 1 };
    else if (Array.isArray(off)) spec = { at: off };
    p[C.W_GRIP] = spec.grip || 0;
    p[C.W_THROAT] = spec.throat || 0;
    p[C.W_BALL] = spec.ball || 0;
    let at = spec.at;
    if (!at && spec.ball) at = BALL_HOLD;
    if (!at) {
      const along = spec.grip ? RACKET.TWO_HAND_AT : RACKET.THROAT_AT;
      at = [0, 1, 2].map((i) => p[C.HAND + i] + p[C.DIR + i] * along);
    }
    setVec(p, C.OFF, at);
  }

  /** MOTION のポーズ1つを配列にする。書いていない項目は prev から引き継ぐ */
  function compilePose(def, prev) {
    const p = prev ? Float64Array.from(prev) : new Float64Array(CHANNELS);
    if (def.hand) setVec(p, C.HAND, def.hand);
    if (def.dir) setVec(p, C.DIR, unit(def.dir));
    if (def.face) setVec(p, C.FACE, unit(def.face));
    if (def.elbow) setVec(p, C.ELBOW, unit(def.elbow));
    if (def.offElbow) setVec(p, C.OFF_ELBOW, unit(def.offElbow));
    if (def.twist !== undefined) {
      p[C.TWIST] = def.twist;
      if (def.hips === undefined) p[C.HIPS] = def.twist * MOTION.HIPS_FOLLOW;
    }
    if (def.hips !== undefined) p[C.HIPS] = def.hips;
    if (def.bend !== undefined) p[C.BEND] = def.bend;
    if (def.crouch !== undefined) p[C.CROUCH] = def.crouch;
    if (def.lean !== undefined) p[C.LEAN] = def.lean;
    if (def.sway !== undefined) p[C.SWAY] = def.sway;
    if (def.off !== undefined) setOff(p, def.off); // 手とラケットの向きが決まってから
    return p;
  }

  function compileKeys(defs, base) {
    let prev = base;
    return defs.map((def) => {
      prev = compilePose(def, prev);
      return { phi: def.phi, pose: prev };
    });
  }

  /** 球種ごとの差分（keys と同じ並び。null はそのまま）を重ねた別の振り付け */
  function varyKeys(keys, overrides) {
    return keys.map((k, i) => ({
      phi: k.phi,
      pose: overrides && overrides[i] ? compilePose(overrides[i], k.pose) : k.pose,
    }));
  }

  /** 膝を crouch(0〜1) だけ沈めたとき、腰が下がる量(m) */
  function crouchDrop(crouch) {
    return (GAIT.THIGH_LEN + GAIT.SHIN_LEN) * (1 - Math.cos(clamp(crouch, 0, 1) * MOTION.CROUCH.THIGH));
  }

  /** crouchDrop() の逆：腰を drop(m) 下げるのに要る crouch(0〜1) */
  function crouchFor(drop) {
    const c = 1 - drop / (GAIT.THIGH_LEN + GAIT.SHIN_LEN);
    return clamp(Math.acos(clamp(c, -1, 1)) / MOTION.CROUCH.THIGH, 0, 1);
  }

  /**
   * 1つの振り付け（キーの並び）。
   * @param {string} id クロスフェードの判定に使う名前（同じ id の間は補間が続く）
   * @param {object} [opts] pull＝フル溜めの形（keys[pullAt] から溜め量ぶん寄せる）、
   *   adapt＝打点でラケットを実際の球へ寄せるか（reachForBall）、easeIn＝打点の直後を
   *   ゆっくり進めるか
   */
  function makeClip(id, keys, opts = {}) {
    const pullAt = opts.pullAt || 0;
    const contactKey = keys.find((k) => k.phi === 1);
    // 振り付けどおりに振ったときの打点でのヘッドの横の向き（＋＝ラケット側＝フォア）。
    // 遠い球へ体幹を傾ける向きに使う。
    const side = contactKey && contactKey.pose[C.HAND] + contactKey.pose[C.DIR] * RACKET.HEAD_Y < 0 ? -1 : 1;
    return {
      id,
      keys,
      pull: opts.pull ? compilePose(opts.pull, keys[pullAt].pose) : null,
      pullAt,
      adapt: opts.adapt !== false && !!contactKey,
      side,
      easeIn: !!opts.easeIn,
    };
  }

  const READY = compilePose(MOTION.READY, null);
  const IDLE = compilePose(MOTION.IDLE, null);
  const CHEER = compilePose(MOTION.CHEER, IDLE);

  const CLIPS = (() => {
    const fh = compileKeys(MOTION.FOREHAND.keys, READY);
    const fhTop = varyKeys(fh, MOTION.FOREHAND.spin.top);
    const fhSlice = compileKeys(MOTION.FOREHAND_SLICE.keys, READY);
    const fhPull = MOTION.FOREHAND.pull;
    const topContact = fhTop.find((k) => k.phi === 1).pose;
    const fhBuggy = fhTop.filter((k) => k.phi <= 1).concat(compileKeys(MOTION.FOREHAND_BUGGY, topContact));

    const bh2 = compileKeys(MOTION.BACKHAND2.keys, READY);
    const bh1 = compileKeys(MOTION.BACKHAND1.keys, READY);
    const bhSlice = compileKeys(MOTION.BACKHAND_SLICE.keys, READY);

    const serve = compileKeys(MOTION.SERVE.keys, READY);
    const smash = compileKeys(MOTION.SMASH.keys, READY);
    return {
      fh: {
        flat: makeClip('fh:flat', fh, { pull: fhPull }),
        top: makeClip('fh:top', fhTop, { pull: fhPull }),
        slice: makeClip('fh:slice', fhSlice),
        drop: makeClip('fh:drop', varyKeys(fhSlice, MOTION.FOREHAND_SLICE.spin.drop)),
      },
      fhBuggy: makeClip('fh:buggy', fhBuggy, { pull: fhPull }),
      bh2: {
        flat: makeClip('bh2:flat', bh2, { pull: MOTION.BACKHAND2.pull }),
        top: makeClip('bh2:top', varyKeys(bh2, MOTION.BACKHAND2.spin.top), { pull: MOTION.BACKHAND2.pull }),
      },
      bh1: {
        flat: makeClip('bh1:flat', bh1, { pull: MOTION.BACKHAND1.pull }),
        top: makeClip('bh1:top', varyKeys(bh1, MOTION.BACKHAND1.spin.top), { pull: MOTION.BACKHAND1.pull }),
        slice: makeClip('bh1:slice', bhSlice),
        drop: makeClip('bh1:drop', varyKeys(bhSlice, MOTION.BACKHAND_SLICE.spin.drop)),
      },
      vfh: makeClip('v:fh', compileKeys(MOTION.VOLLEY_FH, READY)),
      vbh: makeClip('v:bh', compileKeys(MOTION.VOLLEY_BH, READY)),
      serve: makeClip('serve', serve, {
        pull: MOTION.SERVE.pull,
        pullAt: serve.findIndex((k) => k.phi === MOTION.SERVE.PULL_AT),
        adapt: false,
      }),
      smash: makeClip('smash', smash, { pull: MOTION.SMASH.pull, adapt: false, easeIn: true }),
      jack: makeClip('jack', compileKeys(MOTION.JACK, READY), { adapt: false }),
      tweener: makeClip('tweener', compileKeys(MOTION.TWEENER, READY), { adapt: false }),
    };
  })();
  const DIVE_REACH = {
    fh: compilePose(MOTION.DIVE.FH, READY),
    bh: compilePose(MOTION.DIVE.BH, READY),
  };

  function catmull(p0, p1, p2, p3, t) {
    const t2 = t * t;
    return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
      + (3 * p1 - p0 - 3 * p2 + p3) * t2 * t);
  }

  const pulledKey = new Float64Array(CHANNELS);
  /** i 番目のキー。溜めの対象のキーだけ、溜め量ぶんフル溜めの形へ寄せたもの */
  function keyPose(clip, i, charge) {
    const pose = clip.keys[i].pose;
    if (!clip.pull || i !== clip.pullAt || !(charge > 0)) return pose;
    const k = Math.min(charge, 1);
    for (let c = 0; c < CHANNELS; c++) pulledKey[c] = lerp(pose[c], clip.pull[c], k);
    return pulledKey;
  }

  /** 振り付けの φ の位置のポーズを out に書く（キーの間は Catmull-Rom） */
  function evalClip(clip, phi, charge, out) {
    const { keys } = clip;
    const n = keys.length;
    if (n === 1 || phi <= keys[0].phi) return out.set(keyPose(clip, 0, charge));
    if (phi >= keys[n - 1].phi) return out.set(keyPose(clip, n - 1, charge));
    let i = 0;
    while (phi >= keys[i + 1].phi) i++;
    const s = (phi - keys[i].phi) / (keys[i + 1].phi - keys[i].phi);
    const p0 = keyPose(clip, Math.max(i - 1, 0), charge);
    const p1 = keyPose(clip, i, charge);
    const p2 = keyPose(clip, i + 1, charge);
    const p3 = keyPose(clip, Math.min(i + 2, n - 1), charge);
    for (let c = 0; c < CHANNELS; c++) out[c] = catmull(p0[c], p1[c], p2[c], p3[c], s);
    return out;
  }

  /* ------------------------------------------------------------ 時間軸（φ）を決める */

  /** 0→1 を滑らかに立ち上げる（両端で速度0） */
  function ease(t) {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  /** 0→1 を「出だしが速く、終わりがゆっくり」で進める */
  function easeOut(t) {
    const x = clamp(t, 0, 1);
    return 1 - (1 - x) * (1 - x);
  }

  /** ツイーナーのモーションの進行度（0＝打点、1＝振り終わり）。それ以外は null */
  function tweenerProgress(anim, stroke) {
    if (stroke !== 'tweener' || anim <= 0) return null;
    const span = SPECIAL.TWEENER.ANIM;
    return clamp((span - anim) / span, 0, 1);
  }

  /**
   * ツイーナーの「体ごとの振り向き」(rad)。打った瞬間にはもう背を向けているが、
   * 1フレームで π 回すとカクッと入れ替わって見えるので、ごく短い時間（TURN_IN）で
   * 回し切り、振り終わりにかけて（TURN_OUT 以降）正面へ戻す。
   */
  function tweenerTurn(anim, stroke) {
    const progress = tweenerProgress(anim, stroke);
    if (progress === null) return 0;
    const T = SWING.TWEENER;
    const frac = progress < T.TURN_IN
      ? progress / T.TURN_IN
      : (progress < T.TURN_OUT ? 1 : 1 - (progress - T.TURN_OUT) / (1 - T.TURN_OUT));
    return Math.PI * ease(frac);
  }

  /**
   * 飛びつきボレーのモーションの進行度（0＝打点、1＝起き上がり終わり）。それ以外は null。
   * 空振り（missSwing）は技が乗っていてもボレーの形にならないので、ここでも拾わない。
   */
  function diveProgress(state) {
    const { anim, stroke, special } = state;
    if (special !== 'divingVolley' || anim <= 0 || String(stroke).indexOf('volley') !== 0) return null;
    const span = SPECIAL.DIVE.RECOVER;
    return clamp((span - anim) / span, 0, 1);
  }

  /**
   * 選手の足元 (fx, fz) から見たワールドの点 (wx, wy, wz) を、選手の普段の向き（facing）の
   * 座標へ移す（+x＝モデルのローカル x、+z＝前、y は地面からの高さ）。contactPoint() と同じ置き方。
   */
  function facingPoint(player, wx, wy, wz, fx, fz) {
    const f = player.userData.facing || 0;
    const c = Math.cos(f);
    const s = Math.sin(f);
    const dx = wx - fx;
    const dz = wz - fz;
    return { x: dx * c - dz * s, y: wy, z: dx * s + dz * c };
  }

  /**
   * 飛びつきボレーで打点（point）に届く体の形。足元を支点に、
   * - yaw：倒れ込む側（フォアならラケット側、バックならその逆）が球の方向を向くよう体ごと回す
   * - roll：その側へ倒す角度。肩から打点までが腕＋ラケットで届く距離（ARM_SLACK だけ余裕を
   *   残す）に入り、かつ近すぎない（肘を ARM_MIN より畳まなくても届く）角度の範囲を、立った
   *   ところから倒していって最初に見つかったひとつながりの区間のうち、ROLL_PICK の位置
   *   （0＝いちばん立てた、1＝いちばん倒した）を選ぶ。近い球を倒しすぎると肩が球に
   *   近づきすぎ、腕を畳みきれずにラケットが球を通り越す。どの角度もだめなら、いちばん
   *   その範囲に近い角度
   * - lift：足元の浮き。倒すほど高く（LIFT_ROLL まで倒したところで SPECIAL.DIVE.CONTACT_LIFT）
   * ゲーム側（game.js#startDive）は伸ばした体で届くところまで足元を寄せてあるので、
   * ふつうは打点がこの範囲に入る。
   * @param {{x:number, y:number, z:number}} point 打点（facingPoint の座標）
   * @param {boolean} backhand
   * @returns {{toward:number, yaw:number, roll:number, lift:number}} toward＝倒れ込む先
   *   （モデルのローカル x の符号）
   */
  function diveGeometry(point, backhand) {
    const D = SWING.DIVE;
    const toward = backhand ? -HAND : HAND;
    const yaw = clamp(Math.atan2(-toward * point.z, toward * point.x), -D.YAW_MAX, D.YAW_MAX);
    // 回した後の座標での打点
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const bx = point.x * c - point.z * s;
    const bz = point.x * s + point.z * c;
    // 伏せていく形（MOTION.DIVE）でのラケット側の肩：体幹の前傾（TORSO_X）まで入れて、
    // モデルの座標（足元が原点）へ
    const pose = DIVE_REACH[backhand ? 'bh' : 'fh'];
    const sh = shoulderAt(pose[C.TWIST], pose[C.BEND]);
    const shx = HAND * sh[0];
    const shy = GAIT.HIP_Y + sh[1] * Math.cos(D.TORSO_X) - sh[2] * Math.sin(D.TORSO_X);
    const shz = sh[1] * Math.sin(D.TORSO_X) + sh[2] * Math.cos(D.TORSO_X);
    const far = ARM_REACH + RACKET.HEAD_Y - D.ARM_SLACK;
    const near = D.ARM_MIN + RACKET.HEAD_Y;
    const liftAt = (roll) => SPECIAL.DIVE.CONTACT_LIFT * Math.min(1, roll / D.LIFT_ROLL);
    const steps = 72;
    let first = null; // 届く角度のひとつながりの区間の両端
    let last = null;
    let nearest = 0;
    let nearestMiss = Infinity;
    for (let i = 0; i <= steps; i++) {
      const roll = (D.ROLL_MAX * i) / steps;
      const phi = -toward * roll; // rotation.z（正にすると体は -x 側へ倒れる）
      const x = shx * Math.cos(phi) - shy * Math.sin(phi);
      const y = shx * Math.sin(phi) + shy * Math.cos(phi) + liftAt(roll);
      const d = Math.hypot(bx - x, point.y - y, bz - shz);
      const miss = Math.max(d - far, near - d, 0);
      if (miss < nearestMiss) { nearestMiss = miss; nearest = roll; }
      if (miss === 0) {
        if (first === null) first = roll;
        last = roll;
      } else if (first !== null) {
        break; // 区間を抜けた
      }
    }
    const roll = first === null ? nearest : lerp(first, last, D.ROLL_PICK);
    return {
      toward, yaw, roll, lift: liftAt(roll),
    };
  }

  /**
   * 飛びつきボレーの体の形（1フレームぶん）。打つ前の飛び込み（state.dive）と、当たって
   * から伏せて起き上がるまで（diveProgress）の両方を受け持つ。飛びつきボレーでなければ null。
   * 腕（chooseMotion）・体の傾き（applyDiveLean）・向き（setSwingPose）が同じ形を見るよう、
   * setSwingPose が1回だけ求めて motion.dive に置く。
   * - 飛び込み：踏み切ってから打点まで（足元はゲーム側が球のほうへ動かしている）。
   *   打点で diveGeometry() の形になるよう、倒れ込み・浮き・向きを寄せていく
   * - 打った後：その形から地面へ伏せ（〜LAND）、伏せたまま（〜RISE）、起き上がる（〜1）
   * @returns {{toward:number, backhand:boolean, yaw:number, roll:number, lift:number,
   *   legs:number, getup:number, aim:number, ready:number, point:object}|null}
   *   legs＝脚・体幹の飛び込みの形の効き(0〜1)、getup＝起き上がりで膝をつく深さ(0〜1)、
   *   aim＝腕を point へ伸ばす効き(0〜1)、ready＝構えへ戻す効き(0〜1)、
   *   point＝ラケットの先を向ける点（facingPoint の座標。いまの足元が原点）。打つまでは
   *   打点、打った後は伏せたときの置き場所（打点の方向の地面のすぐ上）へ下ろしていく
   */
  function diveBody(player, state) {
    const D = SWING.DIVE;
    const dive = state.dive;
    if (dive) {
      const backhand = dive.stroke === 'backhand';
      const b = dive.ball;
      // 形は飛び込んだ先の足元から決め、腕はいまの足元から打点へ伸ばす
      const g = diveGeometry(facingPoint(player, b.x, b.y, b.z, dive.x1, dive.z1), backhand);
      const u = dive.span > 0 ? clamp(dive.t / dive.span, 0, 1) : 1;
      const k = Math.sin((u * Math.PI) / 2); // 踏み切りで一気に出て、打点で伸びきる
      return {
        toward: g.toward,
        backhand,
        yaw: g.yaw * ease(u * D.YAW_IN),
        roll: g.roll * k,
        lift: g.lift * k,
        legs: ease(u),
        getup: 0,
        aim: 1,
        ready: 0,
        point: facingPoint(player, b.x, b.y, b.z, state.x, state.z),
      };
    }
    const p = diveProgress(state);
    const point = player.userData.motion.contact;
    if (p === null || !point) return null;
    const backhand = state.stroke === 'volley-backhand';
    const g = diveGeometry(point, backhand);
    // 伏せている間のラケットの先：打点の方向へ伸ばしきり、地面のすぐ上に置く。振り付けの形
    // （MOTION.DIVE）のまま倒すと、ラケット側を下にして伏せるフォアでは手とラケットが
    // 地面の下へ潜ってしまう。
    const h = Math.hypot(point.x, point.z) || 1;
    const rest = { x: (point.x / h) * D.REST_REACH, y: D.REST_HEAD_Y, z: (point.z / h) * D.REST_REACH };
    const base = {
      toward: g.toward, backhand, yaw: g.yaw, getup: 0, ready: 0,
    };
    if (p < D.LAND) {
      const s = ease(p / D.LAND);
      // 打点の形から、地面へ伏せる形（LEAN・REST）へ。ラケットは打点から地面へ振り下ろす
      return {
        ...base,
        roll: lerp(g.roll, D.LEAN, easeOut(p / D.LAND)),
        lift: lerp(g.lift, D.REST, s),
        legs: 1,
        aim: 1,
        point: { x: lerp(point.x, rest.x, s), y: lerp(point.y, rest.y, s), z: lerp(point.z, rest.z, s) },
      };
    }
    if (p < D.RISE) {
      return {
        ...base, roll: D.LEAN, lift: D.REST, legs: 1, aim: 1, point: rest,
      };
    }
    const q = ease((p - D.RISE) / (1 - D.RISE));
    return {
      ...base,
      yaw: g.yaw * (1 - q),
      roll: D.LEAN * (1 - q),
      lift: D.REST * (1 - q),
      legs: 1 - q,
      getup: Math.sin(Math.PI * q),
      aim: 1 - q,
      ready: q,
      point: rest,
    };
  }

  /**
   * 跳躍の進み具合(0〜1)。0＝踏み切り、1＝着地。跳んでいなければ null。
   * **打球のモーション（anim）とは別の時計**（state.leap）で動く：anim は「当たった
   * 瞬間」からしか始められないので、そこに跳躍を乗せると跳ぶのと打つのが同時に見える。
   * leap は game.js#tickLeap が「もうすぐ球が届く」ところで、まだ離していなくても
   * 始める＝当たるころには頂点にいて、空中で振り始める絵になる。
   * @param {object} state その選手の見た目に関わる状態
   * @param {'smash'|'jackknife'|'serve'} kind この関数が受け持つ跳び方
   */
  function leapProgress(state, kind) {
    const leap = state.leap;
    if (!leap || leap.kind !== kind || leap.t <= 0) return null;
    // 長さは leap 自身が持つ（サーブの跳躍は毎回、球が打点に届くまでの時間から決まる）
    return clamp((leap.span - leap.t) / leap.span, 0, 1);
  }

  /** 跳躍の上昇の進み具合(0〜1)。1 で頂点＝球に当たる瞬間。跳んでいなければ null */
  function leapRise(state, kind) {
    const u = leapProgress(state, kind);
    if (u === null) return null;
    const rise = kind === 'serve' ? state.leap.rise
      : kind === 'smash' ? PLAYER.SMASH_LEAP_RISE
        : SPECIAL.JACK.LEAP_RISE;
    return rise > 0 ? clamp(u / rise, 0, 1) : 1;
  }

  /**
   * ボールがこの選手の打点（体の CONTACT_AHEAD 前）に届くまでの見積もり。相手が打った
   * 球が自分のほうへ向かっていなければ null。
   * @returns {{tc:number, x:number, cx:number, y:number, bounceFirst:boolean}|null}
   *   tc＝届くまでの秒数（負なら通り過ぎた）、x＝体の横を通るときの横の位置（モデルの
   *   ローカル x。game.js#classifyStroke と同じく体の位置の面で測る）、cx・y＝打点
   *   （体の CONTACT_AHEAD 前）に届くときの横の位置・高さ、bounceFirst＝それまでに一度弾むか
   */
  function ballApproach(player, state, ball) {
    const team = player.userData.team;
    if (!ball || !ball.live || !team || ball.last === team) return null;
    const f = player.userData.facing || 0;
    const c = Math.cos(f);
    const s = Math.sin(f);
    const dx = ball.x - state.x;
    const dz = ball.z - state.z;
    const vx = ball.vx || 0;
    const vz = ball.vz || 0;
    const towards = vx * s + vz * c; // モデルのローカル +z（前）向きの速さ
    if (!(towards < -1)) return null;
    const ahead = dx * s + dz * c;
    const tc = (ahead - MOTION.CONTACT_AHEAD) / -towards;
    if (tc < -MOTION.PASS_T) return null;
    const t = Math.max(tc, 0);
    const vy = ball.vy || 0;
    let y = ball.y + vy * t - 0.5 * G * t * t;
    let bounceFirst = false;
    if (y < PHYSICS.BALL_R) {
      // 先に一度弾む。反発係数で跳ね返した山なりの、届くときの高さ（回転は無視した目安）
      bounceFirst = true;
      const tb = (vy + Math.sqrt(Math.max(vy * vy + 2 * G * (ball.y - PHYSICS.BALL_R), 0))) / G;
      const up = (G * tb - vy) * PHYSICS.RESTITUTION;
      const after = t - tb;
      y = PHYSICS.BALL_R + up * after - 0.5 * G * after * after;
    }
    const lx = dx * c - dz * s;
    const lvx = vx * c - vz * s;
    return {
      tc,
      x: lx + lvx * Math.max(ahead / -towards, 0),
      cx: lx + lvx * t,
      y: Math.max(y, PHYSICS.BALL_R),
      bounceFirst,
    };
  }

  /** フォワードスイングの進み具合(0〜1)。届く FWD_T 秒前から、届いた瞬間に1 */
  function forwardAmount(tc) {
    return tc >= 0 ? clamp(1 - tc / MOTION.FWD_T, 0, 1) : clamp(1 + tc / MOTION.PASS_T, 0, 1);
  }

  /** ネット際にいてノーバウンドで返す位置か（game.js#naturalStroke と同じ線引き） */
  function atNet(player, state) {
    return player.userData.who === 'you'
      ? Math.abs(state.z) < COURT.SERVICE
      : Math.abs(state.z) <= PLAYER.VOLLEY_Z;
  }

  function backhandClip(spin, style) {
    // 両手打ちの選手もスライス・ドロップは片手（実際の両手打ちの選手と同じ）
    if (spin === 'slice' || spin === 'drop') return CLIPS.bh1[spin];
    const set = style === 'two' ? CLIPS.bh2 : CLIPS.bh1;
    return set[spin] || set.flat;
  }

  /** 振っている最中（anim>0）の振り付け */
  function strokeClip(player, state) {
    switch (state.stroke) {
      case 'serve': return CLIPS.serve;
      case 'smash': return CLIPS.smash;
      case 'tweener': return CLIPS.tweener;
      case 'jackknife': return CLIPS.jack;
      case 'volley-forehand': return CLIPS.vfh;
      case 'volley-backhand': return CLIPS.vbh;
      case 'backhand': return backhandClip(state.spin, player.userData.backhand);
      default:
        return state.special === 'buggyWhip' ? CLIPS.fhBuggy : (CLIPS.fh[state.spin] || CLIPS.fh.flat);
    }
  }

  /**
   * 振る前（anim<=0）に何を構えるか。ゲーム側のテイクバック（state.prep）があればそれ、
   * 人間が溜めを離して球を待っているなら溜めていた向き、CPU/AI はボールが届く少し前から
   * 横向きになる（MOTION.UNIT_TURN_T）。committed＝もう振ると決まっている（＝ボールが
   * 届くのに合わせてフォワードスイングを始めてよい）。人間は離した後だけ：溜めている間や
   * 何も押していない間に勝手に振り出すと、操作と違う絵になる。
   */
  function prepIntent(player, state, ctx) {
    const ud = player.userData;
    const isYou = ud.who === 'you';
    const app = ballApproach(player, state, ctx.ball);
    const classify = (a) => (a.x * HAND > 0 ? 'forehand' : 'backhand');
    let side = state.prep;
    const committed = isYou ? state.swing > 0 : true;
    if (!side && isYou && committed) side = state.chargeStroke || (app && classify(app));
    if (!side && !isYou && app && app.tc <= MOTION.UNIT_TURN_T && Math.abs(app.x) <= MOTION.UNIT_TURN_REACH) {
      side = Math.abs(app.x) < MOTION.UNIT_TURN_MIN_X ? 'forehand' : classify(app);
    }
    if (!side) return null;
    const swingsAt = committed && app && (isYou || state.prep || Math.abs(app.x) <= MOTION.FWD_REACH);
    return {
      side,
      volley: side !== 'smash' && (app
        ? ctx.ball.bounces === 0 && !app.bounceFirst && atNet(player, state)
        : atNet(player, state)),
      fwd: swingsAt ? forwardAmount(app.tc) : 0,
      // 打点の見積もり（モデルのローカル座標。y は地面からの高さ）
      point: app ? { x: app.cx, y: app.y, z: MOTION.CONTACT_AHEAD } : null,
      // 人間：溜めている間は押している球種、離した後は溜めていた球種（離すと state.spin は
      // 一旦 'flat' に戻るので chargeSpin を見る）。CPU/AI は打つまで分からない＝フラット。
      spin: isYou && !state.charging && state.swing > 0 ? (state.chargeSpin || state.spin) : state.spin,
    };
  }

  /** MOTION の座標（+x＝ラケット側、ひねる前）でのラケット側の肩の位置 */
  function shoulderAt(twist, bend) {
    const x = RIG.SHOULDER_X * Math.cos(bend) - RIG.SHOULDER_Y * Math.sin(bend);
    return [x * Math.cos(twist), RIG.SHOULDER_X * Math.sin(bend) + RIG.SHOULDER_Y * Math.cos(bend), -x * Math.sin(twist)];
  }

  const ARM_REACH = RIG.UPPER + RIG.FORE - 0.01;

  /** 打点のまわり（φ≒0.3〜1.6）でだけ効かせる重み。打点の前後で 1、離れるほど 0 */
  function contactWeight(phi) {
    return phi < 1
      ? ease((phi - 0.3) / (MOTION.FWD_MAX - 0.3))
      : 1 - ease((phi - 1.15) / 0.45);
  }

  // スマッシュの打点（φ=1）での、ラケット側の肩から見たヘッドの中心（y＝上、z＝前）。
  // 低い打点で腕を前へ倒す角度（lowerSmash）をここから逆算する。
  const SMASH_HEAD = (() => {
    const p = CLIPS.smash.keys.find((k) => k.phi === 1).pose;
    const sh = shoulderAt(p[C.TWIST], p[C.BEND]);
    const y = p[C.HAND + 1] + p[C.DIR + 1] * RACKET.HEAD_Y - sh[1];
    const z = p[C.HAND + 2] + p[C.DIR + 2] * RACKET.HEAD_Y - sh[2];
    return { y, len: Math.hypot(y, z), angle: Math.atan2(z, y) };
  })();

  /** pose の向き（3成分）を、x 軸まわりに前（+z）へ t(rad) 倒す。from は回す中心 */
  function tiltForward(out, at, t, from) {
    const o = from || [0, 0, 0];
    const y = out[at + 1] - o[1];
    const z = out[at + 2] - o[2];
    out[at + 1] = o[1] + y * Math.cos(t) - z * Math.sin(t);
    out[at + 2] = o[2] + y * Math.sin(t) + z * Math.cos(t);
  }

  /**
   * 跳ばずに届く高さ（SWING.SMASH_STAND_Y）より低い打点のスマッシュで、ラケットを球まで
   * 下げる。スマッシュの振り付けは真上へ伸ばしきった1つの形で、reachForBall でも寄せない
   * （adapt:false。真上で叩く形を崩さないため）ので、そのままだと低い打点ほどラケットが
   * 球の上を素通りする（打点 1.8m で 0.37m 上）。
   * 1) まず膝を沈める（SWING.SMASH_LOW.CROUCH_MAX まで）
   * 2) 足りないぶんは、肩を支点に腕とラケットを前へ倒す（＝体の前で叩く形）
   * 打点より高い球は跳んで届かせる（game.js#smashLift）ので、ここでは何もしない。
   * 効かせるのは打点のまわりだけ（contactWeight）。
   * @param {number} contactY 打点の高さ(m。地面から)
   */
  function lowerSmash(out, phi, contactY) {
    const need = SWING.SMASH_STAND_Y - contactY;
    const w = contactWeight(phi);
    if (!(need > 0) || w <= 0) return;
    const L = SWING.SMASH_LOW;
    // 振り付けの打点は膝を伸ばしきっている（crouch 0）ので、沈めたい深さをそのまま足す
    const knees = Math.min(need, crouchDrop(L.CROUCH_MAX));
    out[C.CROUCH] = clamp(out[C.CROUCH] + crouchFor(knees) * w, 0, 1);
    const rest = need - knees;
    if (rest <= 0) return;
    const H = SMASH_HEAD;
    const t = clamp(Math.acos(clamp((H.y - rest) / H.len, -1, 1)) - H.angle, 0, L.TILT_MAX) * w;
    tiltForward(out, C.HAND, t, shoulderAt(out[C.TWIST], out[C.BEND]));
    tiltForward(out, C.DIR, t);
    tiltForward(out, C.FACE, t);
    tiltForward(out, C.ELBOW, t);
  }

  /**
   * 打点のまわり（φ≒0.3〜1.6）だけ、ラケットのヘッドを実際の球の位置へ寄せる。振り付けの
   * 打点はヘッドが体の横 ≒1m にあるが、実際の打点は届く範囲（PLAYER.REACH 1.55m）の
   * どこにでも来るので、寄せないと遠い球ほどラケットと球が離れて見える。
   * 1) 低い球は膝を沈め、さらに低ければ上体を前へ倒す
   * 2) 手ごと球のほうへ動かす（ヘッドの向きはそのまま）。遠い球には体ごと（足元から）、
   *    さらに体幹をその側へ傾ける
   * 3) 腕を伸ばしても届かなければ、さらに体幹を傾ける。両手打ちはそれでも届かなければ
   *    逆手を離して片手で伸ばす
   * 4) 伸ばしきった手から、ラケットの先を球へ向ける
   * 値は MOTION.CONTACT。
   * @param {{x:number, y:number, z:number}|null} point 打点（モデルのローカル座標。
   *   y は地面からの高さ）
   */
  function reachForBall(out, clip, phi, point) {
    if (!point || !clip.adapt) return;
    const w = contactWeight(phi);
    if (w <= 0) return;
    const K = MOTION.CONTACT;
    const R = RACKET.HEAD_Y;
    const side = clip.side;
    const hand = [out[C.HAND], out[C.HAND + 1], out[C.HAND + 2]];
    const dir = [out[C.DIR], out[C.DIR + 1], out[C.DIR + 2]];
    const head = [0, 1, 2].map((i) => hand[i] + dir[i] * R);

    // 1) 低い球：膝を沈め（下がったぶん体幹ごと低くなる）、さらに低ければ上体を前へ倒す。
    // 体幹の原点の高さと前傾が決まってから球の位置を測る。
    const crouch0 = clamp(out[C.CROUCH], 0, 1);
    const below = GAIT.HIP_Y - crouchDrop(crouch0) + head[1] - point.y;
    const crouch = clamp(crouch0 + clamp(below, 0, -K.H_MIN) * K.CROUCH * w, 0, 1);
    out[C.CROUCH] = crouch;
    out[C.LEAN] += clamp((below - K.LEAN_FROM) * K.LEAN_PER_M, 0, K.LEAN_MAX) * w;

    // 球を MOTION の座標へ：足元を支点にした体ごとの傾き（sway）を戻し、体幹の原点
    // （腰の高さ）から測り、+x をラケット側にし、振り付けの前傾（lean）を戻す（体ごと・
    // 体幹ごと傾けるので、目標もその前の座標で書く）。
    const lean = out[C.LEAN];
    const hipY = GAIT.HIP_Y - crouchDrop(crouch);
    const toBody = (sway) => {
      const px = HAND * point.x;
      const sx = px * Math.cos(sway) - point.y * Math.sin(sway);
      const by = px * Math.sin(sway) + point.y * Math.cos(sway) - hipY;
      return [sx, by * Math.cos(lean) + point.z * Math.sin(lean), -by * Math.sin(lean) + point.z * Math.cos(lean)];
    };
    let ball = toBody(out[C.SWAY]);

    // 2) 外へ遠い球ほど、まず体ごとその側へ傾く（足元から。腰だけを折るより自然に見える）
    const outward = side * (ball[0] - head[0]);
    out[C.SWAY] += side * clamp(outward * K.SWAY_PER_M, 0, K.SWAY_MAX) * w;
    ball = toBody(out[C.SWAY]);

    // ヘッドから球までのずれ（体の内側へ・外へ・前後・上下それぞれ寄せすぎない）だけ手を
    // 動かし、外へ遠い球ほどその側へ体幹も傾ける（bend は ＋＝ラケット側の肩が上がる）
    const gap = [ball[0] - head[0], ball[1] - head[1], ball[2] - head[2]];
    gap[0] = side * clamp(side * gap[0], -K.IN_MAX, K.OUT_MAX);
    gap[1] = clamp(gap[1], K.H_MIN, K.H_MAX);
    gap[2] = clamp(gap[2], -K.BACK_MAX, K.AHEAD_MAX);
    out[C.BEND] -= side * clamp(side * gap[0] * K.SIDE_BEND, 0, K.BEND_MAX) * w;
    const want = [0, 1, 2].map((i) => hand[i] + gap[i] * w);

    // 腕の長さより遠ければ、肩から届くところで止める
    const reachFrom = () => {
      const sh = shoulderAt(out[C.TWIST], out[C.BEND]);
      const arm = [want[0] - sh[0], want[1] - sh[1], want[2] - sh[2]];
      const len = Math.hypot(arm[0], arm[1], arm[2]);
      const k = len > ARM_REACH ? ARM_REACH / len : 1;
      for (let i = 0; i < 3; i++) hand[i] = sh[i] + arm[i] * k;
      return Math.hypot(ball[0] - hand[0], ball[1] - hand[1], ball[2] - hand[2]) - R;
    };
    let short = reachFrom();

    // 3) 届かないぶん、さらに体幹を傾けて肩ごと寄る。両手打ちはそれでも届かなければ
    // 逆手を離して片手で伸ばす（離した逆手は後ろへ広げてバランスを取る）。
    if (short > 0) {
      out[C.BEND] -= side * Math.min(short * K.STRETCH_BEND, K.STRETCH_BEND_MAX) * w;
      short = reachFrom();
    }
    if (short > K.RELEASE_FROM && out[C.W_GRIP] > 0) {
      const release = clamp((short - K.RELEASE_FROM) / 0.25, 0, 1) * w;
      out[C.W_GRIP] *= 1 - release;
      for (let i = 0; i < 3; i++) out[C.OFF + i] = lerp(out[C.OFF + i], K.STRETCH_OFF[i], release);
    }

    // 4) 止まった手から、ラケットの先を球へ向ける（届いていれば元の向きのまま）
    const aim = [ball[0] - hand[0], ball[1] - hand[1], ball[2] - hand[2]];
    const aimLen = Math.hypot(aim[0], aim[1], aim[2]);
    if (aimLen > 1e-3) {
      for (let i = 0; i < 3; i++) dir[i] = lerp(dir[i], aim[i] / aimLen, w);
      const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      for (let i = 0; i < 3; i++) out[C.DIR + i] = dir[i] / dl;
    }
    for (let i = 0; i < 3; i++) out[C.HAND + i] = hand[i];
  }

  /**
   * 飛びつきボレーの腕：肩から打点へ腕を伸ばし、ラケットの先を打点へ向ける（body.aim の
   * 効きだけ寄せる）。打点を、体の向き（yaw）・足元からの倒れ込み（roll）・浮き（lift）・
   * 体幹の前傾を順に打ち消して MOTION の座標へ移してから伸ばす。腕＋ラケットより遠ければ
   * 伸ばしきって打点を指し、近ければ肘を曲げてヘッドを打点に置く。
   * @param {object} body diveBody() の結果
   */
  function aimDive(out, body) {
    const w = body.aim;
    if (w <= 0) return;
    const D = SWING.DIVE;
    const { point } = body;
    const cy = Math.cos(body.yaw);
    const sy = Math.sin(body.yaw);
    let x = point.x * cy - point.z * sy;
    const z = point.x * sy + point.z * cy;
    let y = point.y - body.lift;
    const phi = -body.toward * body.roll; // rotation.z
    const cr = Math.cos(phi);
    const sr = Math.sin(phi);
    [x, y] = [x * cr + y * sr, -x * sr + y * cr];
    y -= GAIT.HIP_Y - crouchDrop(out[C.CROUCH]);
    // 体幹の前傾（applyDiveLean が飛び込みの形の効きぶん TORSO_X へ寄せる）
    const lean = lerp(out[C.LEAN], D.TORSO_X, body.legs);
    const cl = Math.cos(lean);
    const sl = Math.sin(lean);
    const ball = [HAND * x, y * cl + z * sl, -y * sl + z * cl];

    const sh = shoulderAt(out[C.TWIST], out[C.BEND]);
    const v = [ball[0] - sh[0], ball[1] - sh[1], ball[2] - sh[2]];
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    const arm = clamp(len - RACKET.HEAD_Y, D.ARM_MIN, ARM_REACH);
    const hand = [0, 1, 2].map((i) => sh[i] + (v[i] / len) * arm);
    const dir = unit([ball[0] - hand[0], ball[1] - hand[1], ball[2] - hand[2]]);
    for (let i = 0; i < 3; i++) {
      out[C.HAND + i] = lerp(out[C.HAND + i], hand[i], w);
      out[C.DIR + i] = lerp(out[C.DIR + i], dir[i], w);
    }
    const d = unit([out[C.DIR], out[C.DIR + 1], out[C.DIR + 2]]);
    for (let i = 0; i < 3; i++) out[C.DIR + i] = d[i];
  }

  /** 打った後（anim>0）の φ。FINISH_AT まで進んだら振り終わりの形を保つ */
  function afterContactPhi(clip, progress) {
    const p = clamp(progress / MOTION.FINISH_AT, 0, 1);
    // スマッシュは打点（腕が伸びきった絵）を長めに見せる（後半ほど速く振り下ろす）
    return 1 + (clip.easeIn ? p * p : easeOut(p));
  }

  /**
   * いまの状態から目標のポーズを out に書き、その出どころ（振り付けの名前）を返す。
   * 名前が変わったら setSwingPose がクロスフェードする。
   * @returns {{key:string, kind:'swing'|'prep'|'rest'}}
   */
  function chooseMotion(player, state, ctx, out) {
    const ud = player.userData;
    const mem = ud.motion;
    const { anim, stroke } = state;

    const dive = mem.dive;
    if (dive) {
      // 飛びつきボレー。腕を頭の先へ伸ばした形（MOTION.DIVE。体ごと倒すので、伸ばした腕が
      // 倒れ込む先を向く）をもとに、肩から球へ腕を伸ばしてラケットの先を球に届かせ
      // （aimDive）、打った後は伏せていく間に地面のすぐ上へ下ろす。起き上がりでは構えへ戻す。
      const reach = DIVE_REACH[dive.backhand ? 'bh' : 'fh'];
      for (let c = 0; c < CHANNELS; c++) out[c] = lerp(reach[c], READY[c], dive.ready);
      aimDive(out, dive);
      return { key: 'dive', kind: 'swing' };
    }

    if (anim > 0) {
      const clip = strokeClip(player, state);
      // anim を入れた長さ（game.js#hit／serve()）で割る＝当たった瞬間がちょうど φ=1
      const span = stroke === 'smash' ? PLAYER.SMASH_ANIM
        : stroke === 'tweener' ? SPECIAL.TWEENER.ANIM
          : stroke === 'jackknife' ? SPECIAL.JACK.ANIM
            : stroke === 'serve' ? PLAYER.SERVE_ANIM
              : PLAYER.SWING_ANIM;
      const phi = afterContactPhi(clip, (span - anim) / span);
      evalClip(clip, phi, state.swingCharge || 0, out);
      reachForBall(out, clip, phi, mem.contact);
      if (clip === CLIPS.smash && mem.contact) lowerSmash(out, phi, mem.contact.y);
      return { key: clip.id, kind: 'swing' };
    }

    if (ctx.cheer) {
      // 試合に勝った：両手を突き上げ、そのまま拳を上下させる（打ち終わるまでは上の振り付けが先）
      mem.cheerT += ctx.dt || 0;
      out.set(CHEER);
      const pump = MOTION.CHEER_PUMP * Math.sin(mem.cheerT * TWO_PI * MOTION.CHEER_PUMP_HZ);
      out[C.HAND + 1] += pump;
      out[C.OFF + 1] += pump;
      return { key: 'cheer', kind: 'cheer' };
    }
    mem.cheerT = 0;

    if (ctx.serve) {
      // サーブ：構え → トス（両腕を下げてから、逆手を上げ、ラケットを担ぐ）→ 跳んで打点へ。
      // トス中の進み具合はボールの上向きの速さ（＝トスを上げてからの時間）で読む。
      const rise = leapRise(state, 'serve');
      let phi = -1;
      if (rise !== null) phi = rise;
      else if (ctx.serve === 'toss') phi = -1 + clamp(1 - (ctx.ball.vy || 0) / TOSS_VY, 0, 1);
      evalClip(CLIPS.serve, phi, state.chargeFrac || 0, out);
      return { key: 'serve', kind: 'prep' };
    }

    // 跳んで打つ1打は、跳び上がる間にラケットを振り出す（人間は当たる前から跳んでいる）。
    // 振り終わった後もまだ宙にいる（跳躍の時計のほうが長い）ときは、もう打ったので戻さない。
    const smashRise = mem.leapSwung ? null : leapRise(state, 'smash');
    const jackRise = mem.leapSwung ? null : leapRise(state, 'jackknife');
    if (jackRise !== null || smashRise !== null) {
      const clip = jackRise !== null ? CLIPS.jack : CLIPS.smash;
      const phi = MOTION.FWD_MAX * ease(jackRise !== null ? jackRise : smashRise);
      evalClip(clip, phi, state.chargeFrac || 0, out);
      const app = clip === CLIPS.smash && ballApproach(player, state, ctx.ball);
      if (app) lowerSmash(out, phi, app.y);
      return { key: clip.id, kind: 'prep' };
    }

    const intent = prepIntent(player, state, ctx);
    if (intent) {
      const clip = intent.side === 'smash' ? CLIPS.smash
        : intent.volley ? (intent.side === 'forehand' ? CLIPS.vfh : CLIPS.vbh)
          : intent.side === 'forehand' ? (CLIPS.fh[intent.spin] || CLIPS.fh.flat)
            : backhandClip(intent.spin, ud.backhand);
      const phi = MOTION.FWD_MAX * ease(intent.fwd);
      // 溜めている間は溜め量ぶん、離した後は離した瞬間の溜め量ぶん深く引いたまま
      const charge = state.chargeFrac || (state.swing > 0 ? state.swingCharge : 0) || 0;
      evalClip(clip, phi, charge, out);
      reachForBall(out, clip, phi, intent.point);
      if (clip === CLIPS.smash && intent.point) lowerSmash(out, phi, intent.point.y);
      return { key: clip.id, kind: 'prep' };
    }

    const ready = ctx.phase === 'rally' || ctx.phase === 'serve';
    out.set(ready ? READY : IDLE);
    return { key: ready ? 'ready' : 'idle', kind: 'rest' };
  }

  /**
   * 当たった瞬間の打点（モデルのローカル座標。y は地面からの高さ）。当たった物理の刻みの
   * 後もそのフレームの残りぶん球は飛んでいる（ball.age＝打たれてからの時間）ので、
   * その分を巻き戻す。
   */
  function contactPoint(player, state, ball) {
    if (!ball) return null;
    const age = ball.age || 0;
    const f = player.userData.facing || 0;
    const c = Math.cos(f);
    const s = Math.sin(f);
    const dx = ball.x - (ball.vx || 0) * age - state.x;
    const dz = ball.z - (ball.vz || 0) * age - state.z;
    return {
      x: dx * c - dz * s,
      y: ball.y - (ball.vy || 0) * age - 0.5 * G * age * age,
      z: dx * s + dz * c,
    };
  }

  function blendTime(from, to) {
    const B = MOTION.BLEND;
    if (to === 'cheer') return B.TO_CHEER;
    if (to === 'swing') return B.TO_SWING;
    if (to === 'prep') return B.TO_PREP;
    if (from === 'swing' || (from === 'rest' && to === 'rest')) return B.FROM_SWING;
    return B.DEFAULT;
  }

  /**
   * スイング（と構え）のポーズを1人ぶん決める。腕のIKは finishPose() で解く。
   * @param {THREE.Group} player
   * @param {object} state その選手の見た目に関わる状態。ゲーム側の生の state と
   *   リプレイのコマ（world.js#snapshotPlayer）の両方が同じ形をしている：
   *   - anim {number} スイングの残り時間（秒）。0 なら構え
   *   - stroke {'forehand'|'backhand'|'serve'|'smash'|'volley-forehand'|'volley-backhand'|'tweener'|'jackknife'}
   *   - prep {'forehand'|'backhand'|'smash'|null} 打つ前のテイクバック（game.js#updatePrep）
   *   - spin {'flat'|'top'|'slice'|'drop'} テイクバック中／スイング中の球種
   *   - chargeFrac {number} 溜めている間だけ 0〜1 で伸びる値。溜めるほど深く引く
   *   - swingCharge {number} 振り始めた瞬間に固定される溜め量(0〜1)
   *   - swing / chargeStroke / chargeSpin（人間だけ）溜めを離してから当たるまでの状態
   *   - leap / special 跳躍の時計と必殺技
   * @param {{dt:number, ball:object, phase:string, serve:'hold'|'toss'|null, cheer?:boolean}} ctx
   *   ball＝ボール（位置・速度・live・last・bounces）、phase＝試合の局面、
   *   serve＝この選手がサーブを待っている（'hold'）／トス中（'toss'）か、
   *   cheer＝試合に勝った側か（両手を突き上げる。MOTION.CHEER）
   */
  scene3d.setSwingPose = function setSwingPose(player, state, ctx) {
    const ud = player.userData;
    const mem = ud.motion;

    // 新しい1打が始まった（当たった）瞬間の打点を覚えておく（打ち終わりまでラケットを
    // 打点へ寄せるのに使う。球はもう飛んでいってしまうので、その瞬間に控える）
    const newSwing = state.anim > 0 && (mem.lastAnim <= 0 || state.anim > mem.lastAnim + 1e-4);
    if (newSwing) mem.contact = contactPoint(player, state, ctx.ball);
    mem.lastAnim = state.anim;
    // 飛びつきボレーの体の形（腕・体の傾き・向きが同じものを見る）
    mem.dive = diveBody(player, state);

    // ツイーナー（股抜き）の間だけ、体ごと相手に背を向ける（普段の向きは userData.facing）。
    // 飛びつきボレーの間は、倒れ込む側が球を向くよう体ごと回す。
    player.rotation.y = (ud.facing || 0) + tweenerTurn(state.anim, state.stroke)
      + (mem.dive ? mem.dive.yaw : 0);
    // この跳躍の間にもう振ったか（跳んで打つ1打の、打つ前の振り出しを出し直さないため）
    if (!state.leap) mem.leapSwung = false;
    else if (state.anim > 0) mem.leapSwung = true;

    const pick = chooseMotion(player, state, ctx, mem.target);
    // 振り付けが変わったら、いま見えている形から寄せる。振っている途中に次の1打が
    // 始まったとき（ボレーの打ち合いなど）も、同じ振り付けの頭へ飛ぶので寄せる。
    // 飛びつきボレーだけは、飛び込みから打った後まで1つの続いた形なので、当たった瞬間に
    // 寄せ直さない（寄せ直すと、球に届いていたラケットが打点で離れる）。飛び込みへ寄せる
    // 時間も、当たるまでの残りより長くしない（飛び込む間が短い球でも、打点では届いている）。
    const dive = pick.key === 'dive';
    if (pick.key !== mem.key || (newSwing && mem.kind === 'swing' && !dive)) {
      mem.from.set(mem.pose);
      mem.t = 0;
      mem.dur = blendTime(mem.kind, pick.kind);
      if (dive) mem.dur = Math.min(mem.dur, state.dive ? (state.dive.span - state.dive.t) / 2 : 0);
      mem.key = pick.key;
    }
    mem.kind = pick.kind;
    mem.t += ctx.dt || 0;
    const k = mem.dur > 0 ? ease(mem.t / mem.dur) : 1;
    for (let c = 0; c < CHANNELS; c++) mem.pose[c] = lerp(mem.from[c], mem.target[c], k);

    // 体幹のひねりと左右の傾き（前傾 rotation.x は setGaitPose が歩行の前傾と足して入れる）。
    // 頭はひねりの一部を戻す＝胴を回しても顔はボールのほうを見ている。
    const rig = ud.rig;
    rig.torso.rotation.y = HAND * mem.pose[C.TWIST];
    rig.torso.rotation.z = HAND * mem.pose[C.BEND];
    rig.head.rotation.y = -HAND * mem.pose[C.TWIST] * RIG.HEAD_FOLLOW;
  };

  /* ------------------------------------------------------------ IK */

  const _d = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _u = new THREE.Vector3();
  const _f = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _x = new THREE.Vector3();
  const _y = new THREE.Vector3();
  const _z = new THREE.Vector3();
  const _elbow = new THREE.Vector3();
  const _m = new THREE.Matrix4();

  /** 骨（ローカル −y 方向へ伸びる）を、向き along・回転軸 axis（ローカル x）に合わせる */
  function boneQuat(axis, along, out) {
    _y.copy(along).negate();
    _z.crossVectors(axis, _y);
    _m.makeBasis(axis, _y, _z);
    return out.setFromRotationMatrix(_m);
  }

  /** ラケット（−y がヘッド、+z が面）を、ヘッドの向き dir・面の向き face に合わせる */
  function racketQuat(dir, face, out) {
    _y.copy(dir).negate();
    _z.copy(face).addScaledVector(dir, -face.dot(dir));
    if (_z.lengthSq() < 1e-8) _z.set(dir.y, -dir.x, 0); // 面の向きがヘッドと同じ向きなら適当な直交方向
    if (_z.lengthSq() < 1e-8) _z.set(0, dir.z, -dir.y);
    _z.normalize();
    _x.crossVectors(_y, _z);
    _m.makeBasis(_x, _y, _z);
    return out.setFromRotationMatrix(_m);
  }

  /**
   * 2関節のIK。肩（固定）から target へ手を伸ばし、肘を pole の向きへ張り出す。
   * 届かない目標なら腕を伸ばしきってその方向を指す。座標はすべて体幹ローカル。
   * @returns {THREE.Vector3} 実際に手が届いた位置（arm.reached）
   */
  function solveArm(arm, target, pole) {
    const a = RIG.UPPER;
    const b = RIG.FORE;
    const S = arm.shoulder.position;
    _d.subVectors(target, S);
    let len = _d.length();
    if (len < 1e-6) _d.set(0, -1, 0);
    else _d.divideScalar(len);
    len = clamp(len, Math.abs(a - b) + 0.02, a + b - 1e-4);
    // ポールのうち、肩→目標の向きと直交する成分＝肘が張り出す向き
    _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
    if (_p.lengthSq() < 1e-8) _p.set(0, 0, -1).addScaledVector(_d, _d.z);
    _p.normalize();
    const cosA = clamp((a * a + len * len - b * b) / (2 * a * len), -1, 1);
    _u.copy(_d).multiplyScalar(cosA).addScaledVector(_p, Math.sqrt(1 - cosA * cosA)); // 上腕の向き
    _elbow.copy(S).addScaledVector(_u, a);
    arm.reached.copy(S).addScaledVector(_d, len);
    _f.subVectors(arm.reached, _elbow).normalize(); // 前腕の向き
    _n.crossVectors(_d, _p).normalize();            // 腕を曲げる面の法線（肘はこの軸だけで曲がる）
    boneQuat(_n, _u, arm.upperQ);
    boneQuat(_n, _f, arm.foreQ);
    arm.shoulder.quaternion.copy(arm.upperQ);
    arm.elbow.quaternion.copy(arm.upperQ).invert().multiply(arm.foreQ);
    return arm.reached;
  }

  const _qTorso = new THREE.Quaternion();
  const _qHand = new THREE.Quaternion();
  const _euler = new THREE.Euler();
  const _hand = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _face = new THREE.Vector3();
  const _pole = new THREE.Vector3();
  const _off = new THREE.Vector3();
  const _offPole = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const runOff = [0, 0, 0];

  /** MOTION の座標（+x＝ラケット側、ひねる前）の点・向きを、体幹ローカルへ移す */
  function toTorso(pose, at, out) {
    return out.set(HAND * pose[at], pose[at + 1], pose[at + 2]).applyQuaternion(_qTorso);
  }

  /**
   * 腕のIKと足首。歩行・跳躍の上書き（setGaitPose・apply*）がすべて済んでから呼ぶ。
   * @param {THREE.Group} player
   * @param {{x:number, y:number, z:number}|null} ball トス・スマッシュで逆手が追うボール
   */
  scene3d.finishPose = function finishPose(player, ball) {
    const ud = player.userData;
    const { rig, gait } = ud;
    const mem = ud.motion;
    const pose = mem.pose;

    // 足首：膝を曲げても足裏を地面と平行に保つ（走っている間は蹴り出しが見えるよう弱める）
    const flat = lerp(MOTION.ANKLE_FLAT, MOTION.ANKLE_FLAT_RUN, gait.blend);
    gait.legs.forEach(({ hip, knee, ankle }) => {
      ankle.rotation.x = -(hip.rotation.x + knee.rotation.x) * flat;
    });

    // MOTION の座標は「ひねる前」なので、体幹のひねり・傾きを打ち消して体幹ローカルへ移す
    _euler.set(0, HAND * pose[C.TWIST], HAND * pose[C.BEND], 'XYZ');
    _qTorso.setFromEuler(_euler).invert();
    toTorso(pose, C.HAND, _hand);
    toTorso(pose, C.DIR, _dir).normalize();
    toTorso(pose, C.FACE, _face);
    toTorso(pose, C.ELBOW, _pole);
    // 構え・ポイント間に走るときは、ラケットを持つ手も前後に振る
    const run = mem.kind === 'rest' ? gait.blend : 0;
    _hand.z -= GAIT.ARM_SWING * 0.5 * Math.sin(gait.phase) * run;

    const racketArm = rig.racket;
    const reached = solveArm(racketArm, _hand, _pole);
    racketQuat(_dir, _face, _qHand);
    racketArm.hand.quaternion.copy(racketArm.foreQ).invert().multiply(_qHand);

    // 逆手：自由な位置・グリップ・スロート・ボールを重みで混ぜた点へ伸ばす。
    // 構えのまま走り出したら、スロートから手を離して腰の横で腕を振る（RUN_OFF）。
    const release = run * MOTION.RUN_RELEASE;
    let wGrip = clamp(pose[C.W_GRIP], 0, 1);
    let wThroat = clamp(pose[C.W_THROAT], 0, 1) * (1 - release);
    let wBall = clamp(pose[C.W_BALL], 0, 1);
    const sum = wGrip + wThroat + wBall;
    if (sum > 1) {
      wGrip /= sum;
      wThroat /= sum;
      wBall /= sum;
    }
    const wFree = Math.max(0, 1 - wGrip - wThroat - wBall);
    _off.set(0, 0, 0);
    if (wFree > 0) {
      for (let i = 0; i < 3; i++) runOff[i] = lerp(pose[C.OFF + i], MOTION.RUN_OFF[i], release);
      toTorso(runOff, 0, _tmp);
      _tmp.z += GAIT.ARM_SWING * Math.sin(gait.phase) * gait.blend; // 走るときの腕振り
      _off.addScaledVector(_tmp, wFree);
    }
    if (wGrip > 0) _off.addScaledVector(_tmp.copy(reached).addScaledVector(_dir, RACKET.TWO_HAND_AT), wGrip);
    if (wThroat > 0) _off.addScaledVector(_tmp.copy(reached).addScaledVector(_dir, RACKET.THROAT_AT), wThroat);
    if (wBall > 0) {
      if (ball) {
        rig.torso.updateWorldMatrix(true, false);
        rig.torso.worldToLocal(_tmp.set(ball.x, ball.y, ball.z));
      } else {
        _tmp.set(HAND * BALL_HOLD[0], BALL_HOLD[1], BALL_HOLD[2]).applyQuaternion(_qTorso);
      }
      _off.addScaledVector(_tmp, wBall);
    }
    toTorso(pose, C.OFF_ELBOW, _offPole);
    solveArm(rig.off, _off, _offPole);
  };

  /* ------------------------------------------------------------ 組み立て */

  /**
   * @param {{shirt:number, shorts:number}} colors
   * @param {'you'|'cpu'|'youMate'|'cpuMate'} [who] どの選手か（バックハンドの打ち方・
   *   チームの判定に使う）。縮地の残像のように誰でもないメッシュは省略
   * @returns {THREE.Group} userData に rig（関節）／gait（歩行リグ）／motion（ポーズ）が入る
   */
  scene3d.createPlayer = function createPlayer({ shirt, shorts }, who) {
    const group = new THREE.Group();

    // 腰から下（脚・腰回り）。腰のひねりと膝の沈み込みはこの Group ごと動かす
    const hips = new THREE.Group();
    group.add(hips);
    const rightLeg = createLeg(HAND, shorts); // ラケット側の脚
    const leftLeg = createLeg(-HAND, shorts);
    const pelvis = new THREE.Mesh(
      new THREE.CylinderGeometry(RIG.PELVIS_R * 0.95, RIG.PELVIS_R, RIG.PELVIS_H, 14),
      mat(shorts),
    );
    pelvis.position.y = GAIT.HIP_Y - RIG.PELVIS_H * 0.3;
    pelvis.scale.z = 0.72;
    hips.add(rightLeg.hip, leftLeg.hip, pelvis);

    // 体幹（胴・頭・両腕）はここだけ上下ゆれ・前傾・ひねりを入れる。
    const torso = new THREE.Group();
    torso.position.y = GAIT.HIP_Y;
    group.add(torso);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(RIG.BODY_TOP_R, RIG.BODY_BOTTOM_R, RIG.BODY_H, 14),
      mat(shirt),
    );
    body.position.y = RIG.BODY_H / 2;
    body.scale.z = RIG.BODY_DEPTH;
    const head = createHead(shorts);
    const racketArm = createArm(HAND, shirt, true);
    const offArm = createArm(-HAND, shirt, false);
    torso.add(body, head, racketArm.shoulder, offArm.shoulder);

    // legs[0] がローカル -x 側、legs[1] が +x 側（apply* が左右の向きを決めるのに使う）
    const legs = HAND < 0 ? [rightLeg, leftLeg] : [leftLeg, rightLeg];
    group.userData = {
      who: who || null,
      team: who ? (who.indexOf('cpu') === 0 ? 'cpu' : 'you') : null,
      backhand: (who && MOTION.BACKHAND[who]) || 'two',
      // この選手が普段向いている方向（world.js が cpu 側に Math.PI を入れる）。ツイーナーで
      // 体ごと反転させたあと、確実に元の向きへ戻すために基準として持っておく。
      facing: 0,
      rig: {
        torso, head, hips, racket: racketArm, off: offArm,
      },
      gait: {
        torso, hips, phase: 0, blend: 0,
        legs: [
          { ...legs[0], offset: 0 },
          { ...legs[1], offset: Math.PI },
        ],
      },
      motion: {
        pose: Float64Array.from(IDLE),
        from: Float64Array.from(IDLE),
        target: new Float64Array(CHANNELS),
        key: null,
        kind: 'rest',
        t: 0,
        dur: 0,
        lastAnim: 0,
        leapSwung: false,
        contact: null,
        cheerT: 0, // 両手を突き上げてからの秒数（拳を上下させる時計）
      },
    };
    // 一度もポーズを当てないメッシュ（縮地の残像）でも、腕が付け根から垂れた形にしておく
    scene3d.finishPose(group, null);
    return group;
  };

  /* ------------------------------------------------------------ 跳躍・飛び込み（体の側） */

  /**
   * 上昇（0〜π/2）→ 下降（π/2〜π）の sin カーブ。頂点付近は sin が寝るので滞空感が出る。
   * @param {number} u 跳躍の進み具合(0〜1)
   * @param {number} riseFrac そのうち上昇に使う割合
   */
  function leapArc(u, riseFrac) {
    const phase = u < riseFrac
      ? (u / riseFrac) * (Math.PI / 2)
      : Math.PI / 2 + ((u - riseFrac) / (1 - riseFrac)) * (Math.PI / 2);
    return Math.sin(phase);
  }

  /**
   * スマッシュのジャンプの高さ(m)。見た目だけの値で、当たり判定（PLAYER.REACH_Y）には
   * 一切影響しない。頂点の高さ（state.leap.lift）は game.js#smashLift が打点から決める：
   * 立ったままラケットが届く打点なら 0（跳ばずに打つ）、ダンクスマッシュは高く跳ぶ。
   */
  function smashLift(state) {
    const u = leapProgress(state, 'smash');
    if (u === null) return 0;
    return (state.leap.lift || 0) * leapArc(u, PLAYER.SMASH_LEAP_RISE);
  }

  /**
   * スマッシュの「跳んでいる体」。setGaitPose() の後に呼ぶこと（歩行が同じ関節を
   * 毎フレーム書くので、その上から浮いている量ぶんだけ上書きする）。
   * - 体そのものを浮かせる（メッシュの y。ゲーム側の座標は動かさない＝表示だけ）
   * - はさみ跳び：ラケット側の脚を後ろへ蹴り上げ、逆脚を前へ振り出す
   * 体幹の反り→前への折れは振り付け（MOTION.SMASH の lean）が受け持つ。
   * @param {object} state その選手の見た目に関わる状態（setSwingPose と同じもの）
   * @returns {number} 浮いた高さ(m)。影を小さくするのに使う（world.js 参照）
   */
  scene3d.applySmashJump = function applySmashJump(player, state) {
    const lift = smashLift(state);
    player.position.y = lift;
    if (lift <= 0) return 0;

    const gait = player.userData.gait;
    // 浮いているほど強くポーズを効かせる。分母は普通のスマッシュの上限の高さ：打点に
    // 合わせた小さな跳躍では脚もそのぶん小さく開く。それより高く跳ぶダンクスマッシュは
    // 頂点で開ききるよう、その跳躍の頂点で割る。
    const peak = Math.max(state.leap.lift, SWING.SMASH_JUMP_H);
    const air = clamp(lift / peak, 0, 1);
    // はさみ跳びは「ラケット側の脚を後ろへ蹴り上げる」。legs[0] がローカル -x 側、
    // legs[1] が +x 側なので、利き手（HAND）でどちらがラケット側かを選ぶ。
    const back = gait.legs[HAND < 0 ? 0 : 1];
    const front = gait.legs[HAND < 0 ? 1 : 0];

    back.hip.rotation.x = lerp(back.hip.rotation.x, SWING.SMASH_LEG_SPLIT, air);
    back.knee.rotation.x = lerp(back.knee.rotation.x, SWING.SMASH_KNEE_TUCK, air);
    front.hip.rotation.x = lerp(front.hip.rotation.x, -SWING.SMASH_LEG_SPLIT * 0.6, air);
    front.knee.rotation.x = lerp(front.knee.rotation.x, SWING.SMASH_KNEE_TUCK * 0.5, air);
    return lift;
  };

  /**
   * 飛びつきボレー（必殺技）の飛び込み。applySmashJump() と同じ考え方で、歩行ポーズの
   * 後に上から重ねる。形は setSwingPose が求めた motion.dive（diveBody）：打つ前から
   * 球のほうへ体ごと飛び出し、伸ばしたラケットが球に届いたところで当たり、そのまま地面へ
   * 伏せる。硬直（SPECIAL.DIVE.RECOVER）が解ける頃に膝をついて起き上がる。
   * 倒れる側はフォア/バックで決める：フォアならラケット側（ローカルの HAND 側）、
   * バックならその逆。その側が球を向くよう体ごと回すのは setSwingPose（rotation.y）。
   * - 体は足元を支点に倒す（足元そのものはゲーム側が球のほうへ動かしている）
   * - 飛んでいる間・伏せている間は脚を開いて膝を曲げ、足先を宙へ上げる。ラケット腕は
   *   chooseMotion() が球へ伸ばす（aimDive）／頭の先へ伸ばす（MOTION.DIVE）
   * - 起き上がりは上体を先に起こし、膝を抱え込んでから立つ
   * 股関節の rotation.y（ひねり）・rotation.z（開き）と体幹の rotation.z は歩行
   * （setGaitPose）が触らない軸なので、技が終わったら自分で戻す。体幹の rotation.z は
   * 振り付けの傾き（bend）も使うので、技が出ていない間は触らない。股関節の
   * rotation.z はツイーナーも使うので、world.js ではこちらを applyTweenerHop() より後に呼ぶ。
   * @returns {number} 浮いた高さ(m)。スマッシュのジャンプと同じく影を小さくするのに使う
   */
  scene3d.applyDiveLean = function applyDiveLean(player) {
    const gait = player.userData.gait;
    const body = player.userData.motion.dive;
    if (!body) {
      // 前の1打の倒れ込みを残さない。代わりに、遠い球へ寄るときの体ごとの傾き
      // （振り付けの sway。正＝ラケット側＝モデルのローカル HAND 側）を入れる。
      // rotation.z を正にすると体は -x 側へ傾く。
      player.rotation.z = -HAND * player.userData.motion.pose[C.SWAY];
      gait.legs.forEach(({ hip }) => { hip.rotation.y = 0; });
      return 0;
    }
    const D = SWING.DIVE;
    const {
      toward, roll, lift, legs, getup,
    } = body;
    // 倒れ込む先（ローカル x の符号 toward）。rotation.z を正にすると体は -x 側へ傾くので反転。
    player.rotation.z = -toward * roll;
    player.position.y = lift;
    // 起き上がりでは上体を先に起こす（体全体の倒れ込みを打ち消す向きに体幹だけ曲げる）。
    gait.torso.rotation.z += toward * D.GETUP_TORSO * getup;

    // 脚のひねりは倒れ込む先と同じ符号（ローカル y まわり）＝膝が上を向く。
    const twist = toward * D.LEG_ROLL * legs;
    gait.legs.forEach(({ hip, knee }, i) => {
      const outward = i === 0 ? -1 : 1; // legs[0] がローカル -x 側（applyTweenerHop 参照）
      hip.rotation.x = lerp(hip.rotation.x, D.LEG_TRAIL, legs) + D.GETUP_HIP * getup;
      hip.rotation.y = twist;
      hip.rotation.z = outward * D.LEG_SPLAY * legs;
      knee.rotation.x = lerp(knee.rotation.x, D.KNEE_TUCK, legs) + D.GETUP_KNEE * getup;
    });
    gait.torso.rotation.x = lerp(gait.torso.rotation.x, D.TORSO_X, legs);
    return lift;
  };

  /**
   * ツイーナー（必殺技の股抜き）の跳躍と股割り。applySmashJump() と同じ考え方で、
   * 歩行ポーズの後に上から重ねる。
   * - 体を浮かせる（打点の瞬間にはもう跳び上がっていて、振り終わりで着地する）
   * - 股を**左右**に割る：カメラは選手の真後ろにあるので、前後に開いても奥行き方向に
   *   しか動かず「股を抜いた」ことが読めない。左右に開いた脚の間をラケットが通る
   * - 体幹を前へ折って、股の下を覗き込む形にする
   * 股割りに使う hip の rotation.z は setGaitPose() が触らない軸なので、技が終わった
   * フレームで自分で0へ戻す（戻さないと開いたまま走り続ける）。
   * @param {object} state その選手の見た目に関わる状態（setSwingPose と同じもの）
   * @returns {number} 浮いた高さ(m)。影を小さくするのに使う（world.js 参照）
   */
  scene3d.applyTweenerHop = function applyTweenerHop(player, state) {
    const gait = player.userData.gait;
    const progress = tweenerProgress(state.anim, state.stroke);
    if (progress === null) {
      gait.legs.forEach(({ hip }) => { hip.rotation.z = 0; });
      return 0;
    }
    const T = SWING.TWEENER;
    // 打点（progress=0）の時点で既に HOP_START の高さまで上がっている → 頂点 → 着地
    const rise = Math.asin(clamp(T.HOP_START, 0, 1));
    const phase = progress < T.HOP_PEAK
      ? lerp(rise, Math.PI / 2, progress / T.HOP_PEAK)
      : lerp(Math.PI / 2, Math.PI, (progress - T.HOP_PEAK) / (1 - T.HOP_PEAK));
    const lift = T.HOP_H * Math.sin(phase);
    player.position.y = lift;

    // 浮いているほど強くポーズを効かせる（着地に向けて自然に歩行ポーズへ戻る）
    const air = clamp(lift / T.HOP_H, 0, 1);
    // legs[0] がローカル -x 側、legs[1] が +x 側。hip.rotation.z を正にすると足先が
    // +x 側へ振れるので、外側へ開くには -x 側の脚を負・+x 側の脚を正にする。
    gait.legs.forEach(({ hip, knee }, i) => {
      const outward = i === 0 ? -1 : 1;
      hip.rotation.z = lerp(0, outward * T.LEG_SPLAY, air);
      hip.rotation.x = lerp(hip.rotation.x, outward * T.LEG_KICK, air);
      knee.rotation.x = lerp(knee.rotation.x, T.KNEE_TUCK, air);
    });
    gait.torso.rotation.x = lerp(gait.torso.rotation.x, T.TORSO_X, air);
    return lift;
  };

  /**
   * ジャックナイフ（必殺技）の跳躍。applySmashJump() と同じく歩行ポーズの後に上から
   * 重ねる。高い打点へ跳び上がり、**両脚をそろえて後ろへ折りたたむ**（＝体が折りたたみ
   * ナイフのように「くの字」になる、技の名前そのものの形）。
   *
   * **跳躍だけは打球のモーション（anim）ではなく専用の時計（state.leap）で動く。**
   * anim は「当たった瞬間」からしか始められないので、そこに跳躍も乗せると跳ぶのと
   * 振るのが同時になり、「打ってから跳んだ」ように見えてしまう（ユーザー報告）。
   * 踏み切り（LEAP_RISE）で上がり、頂点でふわりと粘ってから着地する。
   * @param {object} state その選手の見た目に関わる状態（setSwingPose と同じもの）
   * @returns {number} 浮いた高さ(m)。影を小さくするのに使う（world.js 参照）
   */
  scene3d.applyJackknifeLeap = function applyJackknifeLeap(player, state) {
    const u = leapProgress(state, 'jackknife');
    if (u === null) return 0;
    const J = SWING.JACK;
    const lift = J.JUMP_H * leapArc(u, SPECIAL.JACK.LEAP_RISE);
    player.position.y = lift;

    const gait = player.userData.gait;
    const air = clamp(lift / J.JUMP_H, 0, 1);
    // 両脚そろえて後ろへ折る（はさみ跳びのスマッシュと違い、左右で開かない）。
    // 膝は**カメラ側（選手の後ろ）へ**折りたたむ：カメラは選手の真後ろにあるので、
    // 逆へ折ると体に隠れて「折りたたんだ」ことが見えない。靴の裏が見えるのが正解。
    gait.legs.forEach(({ hip, knee }) => {
      hip.rotation.x = lerp(hip.rotation.x, J.LEG_FOLD, air);
      knee.rotation.x = lerp(knee.rotation.x, J.KNEE_TUCK, air);
    });
    gait.torso.rotation.x = lerp(gait.torso.rotation.x, J.TORSO_X, air);
    return lift;
  };

  /**
   * サーブのジャンプ。applySmashJump() と同じく歩行ポーズの後に上から重ねる。
   * トスが打点（state.leap.reach）まで落ちてくるのに合わせて跳び、頂点でラケットを
   * 伸ばしきって当てる（頂点＝当たる瞬間になるよう game.js#tickServeSwing が踏み切る）。
   * - 上がる間は両脚をそろえて伸ばす（トロフィーで曲げた膝を伸ばして跳ぶ）
   * - 打ったあとは振り下ろしに合わせて、ラケット側の脚を後ろへ蹴り上げる
   * 体幹の反り→前への折れは振り付け（MOTION.SERVE の lean）が受け持つ。
   * @param {object} state その選手の見た目に関わる状態（setSwingPose と同じもの）
   * @returns {number} 浮いた高さ(m)。影を小さくするのに使う（world.js 参照）
   */
  scene3d.applyServeJump = function applyServeJump(player, state) {
    const u = leapProgress(state, 'serve');
    if (u === null) return 0;
    // SERVE_JUMP_H は人間の打点（SERVE.CONTACT_Y）に届く高さ。打点が低い CPU/AI
    // （SERVE.AI_CONTACT_Y）はその差だけ低く跳ぶ＝同じ伸ばしきった腕で球に届く。
    const peak = Math.max(0, SWING.SERVE_JUMP_H + state.leap.reach - SERVE.CONTACT_Y);
    const lift = peak * leapArc(u, state.leap.rise);
    player.position.y = lift;
    if (peak <= 0) return 0;

    const gait = player.userData.gait;
    const air = clamp(lift / peak, 0, 1);
    // 打ってからの振り下ろしの進み具合（当たる前は 0）
    const progress = state.stroke === 'serve' && state.anim > 0
      ? clamp((PLAYER.SERVE_ANIM - state.anim) / PLAYER.SERVE_ANIM, 0, 1)
      : 0;
    gait.legs.forEach(({ hip, knee }) => {
      hip.rotation.x = lerp(hip.rotation.x, 0, air);
      knee.rotation.x = lerp(knee.rotation.x, 0, air);
    });
    const back = gait.legs[HAND < 0 ? 0 : 1];
    const kick = air * progress;
    back.hip.rotation.x = lerp(back.hip.rotation.x, SWING.SERVE_LEG_KICK, kick);
    back.knee.rotation.x = lerp(back.knee.rotation.x, SWING.SERVE_KNEE_TUCK, kick);
    return lift;
  };

  /* ------------------------------------------------------------ 歩行 */

  /**
   * 実際の移動速度から歩行/走行のポーズを毎フレーム更新する。ポーズの膝の沈み込み
   * （crouch）・腰のひねり（hips）・前傾（lean）もここで脚と体幹に入れる。
   * @param {THREE.Group} player
   * @param {number} speed 実速度(m/s)。壁際でクランプされた分は含めない想定
   * @param {number} maxSpeed この選手が出しうる速度の目安（歩き⇔走りのブレンドを正規化する基準）
   * @param {number} dt
   */
  scene3d.setGaitPose = function setGaitPose(player, speed, maxSpeed, dt) {
    const g = player.userData.gait;
    const pose = player.userData.motion.pose;
    const moving = speed > GAIT.MIN_SPEED;
    const target = moving ? 1 : 0;
    g.blend += Math.sign(target - g.blend) * Math.min(Math.abs(target - g.blend), GAIT.BLEND_RATE * dt);

    const speedFrac = Math.min(speed / Math.max(maxSpeed, 0.001), 1);
    const hz = GAIT.WALK_HZ + (GAIT.RUN_HZ - GAIT.WALK_HZ) * speedFrac;
    if (moving || g.blend > 0.001) g.phase = (g.phase + hz * TWO_PI * dt * g.blend) % TWO_PI;

    const thighAmp = (GAIT.WALK_SWING + (GAIT.RUN_SWING - GAIT.WALK_SWING) * speedFrac) * g.blend;
    const kneeAmp = GAIT.KNEE_BEND * g.blend;
    // 膝の沈み込み：太ももを前へ、すねをその倍だけ後ろへ折る（足先が股関節の真下に残る）
    const crouch = clamp(pose[C.CROUCH], 0, 1);
    const sink = crouch * MOTION.CROUCH.THIGH;

    g.legs.forEach(({ hip, knee, offset }) => {
      const p = g.phase + offset;
      hip.rotation.x = thighAmp * Math.sin(p) - sink; // 正＝太ももを後ろへ
      // 膝は脚を前へ振り出す間（太ももが後ろから前へ戻る半周期＝cos が負）だけ大きく
      // 曲げて踵を跳ね上げ、着地している間もわずかに曲げておく。正＝曲げる。
      knee.rotation.x = kneeAmp * Math.max(0, -Math.cos(p)) + GAIT.STANCE_KNEE * g.blend + 2 * sink;
    });

    const drop = crouchDrop(crouch);
    g.hips.position.y = -drop;
    g.hips.rotation.y = HAND * pose[C.HIPS] * (1 - MOTION.HIPS_RUN_DAMP * g.blend);
    g.torso.position.y = GAIT.HIP_Y - drop + GAIT.BOB_AMP * Math.abs(Math.sin(g.phase)) * g.blend;
    g.torso.rotation.x = GAIT.LEAN_MAX * speedFrac * g.blend + pose[C.LEAN];
  };
})(window.RallyOne = window.RallyOne || {});
