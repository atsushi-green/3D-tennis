/**
 * 選手のメッシュ（胴・頭・脚・ラケットを持つ腕・逆手）とポーズ制御。
 * - スイング（打つ動作）: setSwingPose() が担当。ラケット側の腕を rotation.y で振る。
 * - 歩行/走行: setGaitPose() が担当。股関節・膝・逆手の腕・体幹を rotation.x で動かす。
 *   軸を分けているので、打ちながら走っていても振り付けが喧嘩しない。
 * 真のIK（目標位置からの逆算）ではなく、速度に応じて角度を数式で生成する簡易版。
 */
(function (RallyOne) {
  'use strict';

  const { GAIT, PLAYER, SWING, THEME } = RallyOne.config;
  const { clamp, lerp } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  const TWO_PI = Math.PI * 2;
  const ARM_SPAN = PLAYER.SERVE_ANIM; // アニメーションの基準時間

  function createRacketArm(shirt, mat) {
    const arm = new THREE.Group();

    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.5, 8), mat(shirt));
    upper.rotation.z = -Math.PI / 2;
    upper.position.x = 0.28;

    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 8, 20), mat(THEME.BALL));
    frame.position.set(0.72, 0, 0);

    const strings = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.14, side: THREE.DoubleSide,
      }),
    );
    strings.position.set(0.72, 0, 0);

    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.2, 8), mat(THEME.GRIP));
    grip.rotation.z = Math.PI / 2;
    grip.position.set(0.53, 0, 0);

    arm.add(upper, frame, strings, grip);
    return arm;
  }

  /** ラケットを持たない方の腕。歩行時のカウンタースイングだけを担当する簡素な1本。 */
  function createOffArm(shirt, mat) {
    const arm = new THREE.Group();
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.46, 8), mat(shirt));
    upper.position.y = -0.23;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), mat(THEME.SKIN));
    hand.position.y = -0.46;
    arm.add(upper, hand);
    return arm;
  }

  /** 股関節(hip)→膝(knee)→足先、の2関節チェーンを1本作る。 */
  function createLeg(sign, shorts, skin, mat) {
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
      mat(skin),
    );
    shin.position.y = -GAIT.SHIN_LEN / 2;
    knee.add(shin);

    const foot = new THREE.Mesh(new THREE.BoxGeometry(...GAIT.FOOT), mat(0x1c2531));
    foot.position.set(0, -GAIT.SHIN_LEN, GAIT.FOOT[2] * 0.28);
    knee.add(foot);

    return { hip, knee };
  }

  /**
   * @param {{shirt:number, shorts:number}} colors
   * @returns {THREE.Group} userData に arm（ラケット腕）／gait（歩行リグ一式）が入る
   */
  scene3d.createPlayer = function createPlayer({ shirt, shorts }) {
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

    const leftLeg = createLeg(-1, shorts, THEME.SKIN, mat);
    const rightLeg = createLeg(1, shorts, THEME.SKIN, mat);
    group.add(leftLeg.hip, rightLeg.hip);

    // 体幹（胴・頭・両腕）はここだけ上下ゆれ・前傾させる。脚は接地したまま揺らさない。
    const torso = new THREE.Group();
    torso.position.y = GAIT.HIP_Y;
    group.add(torso);

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.27, 0.68, 12), mat(shirt));
    body.position.y = 0.34;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), mat(THEME.SKIN));
    head.position.y = 0.81;
    torso.add(body, head);

    const arm = createRacketArm(shirt, mat);
    arm.position.set(0, 0.46, 0);
    torso.add(arm);

    const offArm = createOffArm(shirt, mat);
    offArm.position.set(0, 0.46, 0);
    torso.add(offArm);

    group.userData.arm = arm;
    group.userData.gait = {
      torso, offArm, phase: 0, blend: 0,
      legs: [
        { hip: leftLeg.hip, knee: leftLeg.knee, offset: 0 },
        { hip: rightLeg.hip, knee: rightLeg.knee, offset: Math.PI },
      ],
    };
    return group;
  };

  /**
   * フォアハンドの弧の角度（0=横向き、正=プレイヤー視点で後ろ＝テイクバック、
   * 負=プレイヤー視点で前＝フォロースルー）をバックハンド用に鏡映しする。+π を足す
   * （＝原点を中心に180°回す点対称）と前後の向きまで反転してしまい、テイクバックの
   * はずが前を向き、フォロースルーのはずが後ろを向く、という時間順序が壊れたスイングに
   * なる。π−angle（＝左右の軸で折り返す線対称）なら前後の向きは保ったまま左右だけ
   * 入れ替わるので、テイクバック→打点→フォロースルーの流れは崩れない。
   */
  function mirrorGroundAngle(angle, backhand) {
    return backhand ? Math.PI - angle : angle;
  }

  /**
   * スイングの残り時間から腕の角度を決める。5種類のポーズを軸を分けて切り替える：
   * - フォアハンド／バックハンド: rotation.y（横振り）。mirrorGroundAngle() で左右だけを
   *   鏡映しするので、バックハンドでもテイクバック→打点→フォロースルーが正しい前後の
   *   向きのまま、体の逆サイドで振られる。
   * - サーブ: rotation.z（縦振り）。トス中は構え、打った瞬間から真上→前へ振り下ろす。
   * - スマッシュ: 仰角(rotation.z)と前後の傾き(rotation.x)を同時に動かし、頭の後ろに
   *   振りかぶった位置から真上（打点）を通って体の前へ振り下ろす（フォア/バックの区別は
   *   ない）。跳んで打つので、体の浮き・脚のはさみ跳びは applySmashJump() が受け持つ。
   * - ボレー: フォア/バックと同じ rotation.y だが、テイクバックがほとんどない短いパンチ。
   * @param {THREE.Group} player
   * @param {number} anim 残り時間（秒）。0 なら構え／トスの姿勢
   * @param {'forehand'|'backhand'|'serve'|'smash'|'volley-forehand'|'volley-backhand'} [stroke]
   * @param {boolean} [tossing] トス中（打つ前）かどうか。サーブの構えを出す
   * @param {'forehand'|'backhand'|'smash'|null} [prep] 打つ前のテイクバック。まだ振って
   *   いない（anim<=0）間、ボールがどちらの打点に来そうかに応じてラケットを引いておく。
   *   'smash' は高い球を溜めているとき＝頭の後ろに担いだ振りかぶりの構え。
   * @param {number} [chargeFrac] Space を溜めている間だけ 0〜1 で伸びる値。溜めるほど
   *   GROUND_START からさらに CHARGE_PULL だけ深くテイクバックし、離した瞬間との
   *   落差で「今しっかり溜めている」ことが分かるようにする。
   * @param {number} [swingCharge] 振り始めた瞬間に固定される溜め量(0〜1)。スイング中
   *   （anim>0）は、テイクバックが実際にどこまで深く入っていたか（＝chargeFrac の最終値）
   *   から弧を始めるのに使う。ここを chargeFrac にすると振っている間に charging が
   *   false に戻って 0 に落ち、テイクバック位置に飛んで見えてしまうため、release() の
   *   瞬間に固定される swingCharge を使い続ける。
   */
  scene3d.setSwingPose = function setSwingPose(player, anim, stroke, tossing, prep, chargeFrac, swingCharge) {
    const arm = player.userData.arm;
    const torso = player.userData.gait.torso;

    if (anim <= 0) {
      if (tossing) {
        arm.rotation.y = 0;
        arm.rotation.z = SWING.SERVE_READY_Z;
        arm.rotation.x = 0;
      } else if (prep === 'smash') {
        // 高い球を溜めている間は、頭の後ろにラケットを担いだ振りかぶりの構え。
        // 溜めるほど深く担いで、離した瞬間の振り下ろしとの落差を大きくする。
        arm.rotation.y = 0;
        arm.rotation.z = SWING.SMASH_READY_Z;
        arm.rotation.x = SWING.SMASH_READY_X * (1 + (chargeFrac || 0) * 0.35);
      } else if (prep) {
        const pullBack = SWING.GROUND_START + (chargeFrac || 0) * SWING.CHARGE_PULL;
        arm.rotation.y = mirrorGroundAngle(pullBack, prep === 'backhand');
        arm.rotation.z = 0;
        arm.rotation.x = 0;
      } else {
        arm.rotation.y = SWING.REST_Y;
        arm.rotation.z = 0;
        arm.rotation.x = 0;
      }
      torso.rotation.y = 0;
      return;
    }

    // スマッシュだけはモーションが長い（PLAYER.SMASH_ANIM）ので、進行度もその長さで割る。
    // 他のストロークは従来どおり ARM_SPAN 基準（＝既存の振り付けを変えない）。
    const span = stroke === 'smash' ? PLAYER.SMASH_ANIM : ARM_SPAN;
    const progress = clamp((span - anim) / span, 0, 1);

    if (stroke === 'serve') {
      arm.rotation.y = 0;
      arm.rotation.z = SWING.SERVE_START_Z + progress * (SWING.SERVE_FOLLOW_Z - SWING.SERVE_START_Z);
      arm.rotation.x = 0;
      torso.rotation.y = 0;
      return;
    }

    if (stroke === 'smash') {
      // 仰角と前後の傾きを同時に動かして、真上（打点）から体の前へ振り下ろす弧を作る。
      // 振り始め（打点）を長く見せたいので、進行度を後半ほど速く進む曲線に乗せる
      // （＝打った瞬間の「腕が上がりきった絵」が一瞬でも読み取れる）。
      const swing = progress * progress;
      arm.rotation.y = 0;
      arm.rotation.z = lerp(SWING.SMASH_START_Z, SWING.SMASH_FOLLOW_Z, swing);
      arm.rotation.x = lerp(SWING.SMASH_START_X, SWING.SMASH_FOLLOW_X, swing);
      torso.rotation.y = 0;
      return;
    }

    if (stroke === 'volley-forehand' || stroke === 'volley-backhand') {
      // グラウンドストロークと同じ横振り(rotation.y)の系統だが、テイクバックをほとんど
      // 取らない短いパンチ（VOLLEY_START/SWEEP は GROUND_START/SWEEP よりずっと小さい）。
      const backhandVolley = stroke === 'volley-backhand';
      arm.rotation.y = mirrorGroundAngle(
        SWING.VOLLEY_START + progress * SWING.VOLLEY_SWEEP, backhandVolley,
      );
      arm.rotation.z = 0;
      arm.rotation.x = 0;
      // 通常のグラウンドストロークより体幹のひねりも控えめ（コンパクトな動作のため）
      torso.rotation.y = (backhandVolley ? -1 : 1) * SWING.TORSO_TWIST * 0.5 * Math.sin(progress * Math.PI);
      return;
    }

    const backhand = stroke === 'backhand';
    // テイクバックが溜め量ぶん深く入っていた分だけ、始点をそこに合わせて弧を広げる
    // （終点＝フォロースルーは GROUND_START+GROUND_SWEEP のまま揃える）。
    const start = SWING.GROUND_START + (swingCharge || 0) * SWING.CHARGE_PULL;
    const sweep = SWING.GROUND_SWEEP - (swingCharge || 0) * SWING.CHARGE_PULL;
    arm.rotation.y = mirrorGroundAngle(start + progress * sweep, backhand);
    arm.rotation.z = 0;
    arm.rotation.x = 0;
    // sin カーブでひねって戻す（構え→打点→フォロースルーで元の向きに近づく）
    torso.rotation.y = (backhand ? -1 : 1) * SWING.TORSO_TWIST * Math.sin(progress * Math.PI);
  };

  /**
   * スマッシュのジャンプの高さ(m)。打点の瞬間には既に跳び上がっていて
   * （SMASH_JUMP_START の高さ）、SMASH_JUMP_PEAK の進行度で頂点、振り終わりで着地する。
   * sin カーブに乗せているので、頂点付近でふわりと粘り、着地は滑らかに0へ収束する。
   * 見た目だけの値で、当たり判定（PLAYER.REACH_Y）には一切影響しない。
   */
  function smashLift(anim, stroke) {
    if (stroke !== 'smash' || anim <= 0) return 0;
    const progress = clamp((PLAYER.SMASH_ANIM - anim) / PLAYER.SMASH_ANIM, 0, 1);
    const rise = Math.asin(clamp(SWING.SMASH_JUMP_START, 0, 1)); // 打点の瞬間の位相
    const peak = SWING.SMASH_JUMP_PEAK;
    const phase = progress < peak
      ? lerp(rise, Math.PI / 2, progress / peak)               // 打点 → 頂点
      : lerp(Math.PI / 2, Math.PI, (progress - peak) / (1 - peak)); // 頂点 → 着地
    return SWING.SMASH_JUMP_H * Math.sin(phase);
  }

  /**
   * スマッシュの「跳んでいる体」。setGaitPose() の後に呼ぶこと（歩行が同じ関節を
   * 毎フレーム書くので、その上から浮いている量ぶんだけ上書きする）。
   * - 体そのものを浮かせる（メッシュの y。ゲーム側の座標は動かさない＝表示だけ）
   * - はさみ跳び：ラケット側の脚を後ろへ蹴り上げ、逆脚を前へ振り出す
   * - 体幹：打点では反り、振り下ろしに合わせて前へ折る
   * @returns {number} 浮いた高さ(m)。影を小さくするのに使う（world.js 参照）
   */
  scene3d.applySmashJump = function applySmashJump(player, anim, stroke) {
    const lift = smashLift(anim, stroke);
    player.position.y = lift;
    if (lift <= 0) return 0;

    const gait = player.userData.gait;
    const air = clamp(lift / SWING.SMASH_JUMP_H, 0, 1); // 浮いているほど強くポーズを効かせる
    const progress = clamp((PLAYER.SMASH_ANIM - anim) / PLAYER.SMASH_ANIM, 0, 1);
    const [front, back] = gait.legs; // legs[1] がラケット側（モデルのローカル +x）

    back.hip.rotation.x = lerp(back.hip.rotation.x, SWING.SMASH_LEG_SPLIT, air);
    back.knee.rotation.x = lerp(back.knee.rotation.x, -SWING.SMASH_KNEE_TUCK, air);
    front.hip.rotation.x = lerp(front.hip.rotation.x, -SWING.SMASH_LEG_SPLIT * 0.6, air);
    front.knee.rotation.x = lerp(front.knee.rotation.x, -SWING.SMASH_KNEE_TUCK * 0.25, air);
    gait.offArm.rotation.x = lerp(gait.offArm.rotation.x, -SWING.SMASH_LEG_SPLIT * 0.5, air);
    gait.torso.rotation.x = lerp(SWING.SMASH_TORSO_ARCH, SWING.SMASH_TORSO_X, progress * progress);
    return lift;
  };

  /**
   * 実際の移動速度から歩行/走行のポーズを毎フレーム更新する。
   * @param {THREE.Group} player
   * @param {number} speed 実速度(m/s)。壁際でクランプされた分は含めない想定
   * @param {number} maxSpeed この選手が出しうる速度の目安（歩き⇔走りのブレンドを正規化する基準）
   * @param {number} dt
   */
  scene3d.setGaitPose = function setGaitPose(player, speed, maxSpeed, dt) {
    const g = player.userData.gait;
    const moving = speed > GAIT.MIN_SPEED;
    const target = moving ? 1 : 0;
    g.blend += Math.sign(target - g.blend) * Math.min(Math.abs(target - g.blend), GAIT.BLEND_RATE * dt);

    const speedFrac = Math.min(speed / Math.max(maxSpeed, 0.001), 1);
    const hz = GAIT.WALK_HZ + (GAIT.RUN_HZ - GAIT.WALK_HZ) * speedFrac;
    if (moving || g.blend > 0.001) g.phase = (g.phase + hz * TWO_PI * dt * g.blend) % TWO_PI;

    const thighAmp = (GAIT.WALK_SWING + (GAIT.RUN_SWING - GAIT.WALK_SWING) * speedFrac) * g.blend;
    const kneeAmp = GAIT.KNEE_BEND * g.blend;
    const armAmp = GAIT.ARM_SWING * g.blend;

    g.legs.forEach(({ hip, knee, offset }) => {
      const p = g.phase + offset;
      hip.rotation.x = thighAmp * Math.sin(p);
      // 脚が前へ振り出される半サイクルだけ膝を曲げ、足先を地面から浮かせる
      knee.rotation.x = -kneeAmp * Math.max(0, Math.sin(p + Math.PI / 2));
    });

    g.offArm.rotation.x = -armAmp * Math.sin(g.phase);
    g.torso.position.y = GAIT.HIP_Y + GAIT.BOB_AMP * Math.abs(Math.sin(g.phase)) * g.blend;
    g.torso.rotation.x = GAIT.LEAN_MAX * speedFrac * g.blend;
  };
})(window.RallyOne = window.RallyOne || {});
