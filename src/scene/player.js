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
   * スイングの残り時間から腕の角度を決める。3種類のポーズを軸を分けて切り替える：
   * - フォアハンド／バックハンド: rotation.y（横振り）。バックハンドは弧そのものを
   *   体の反対側（+π）へ丸ごと移すので、同じ弧を逆順になぞるだけだった以前と違い
   *   ラケットが実際に体の逆サイドで振られて見分けやすい。
   * - サーブ: rotation.z（縦振り）。トス中は構え、打った瞬間から真上→前へ振り下ろす。
   * @param {THREE.Group} player
   * @param {number} anim 残り時間（秒）。0 なら構え／トスの姿勢
   * @param {'forehand'|'backhand'|'serve'} [stroke]
   * @param {boolean} [tossing] トス中（打つ前）かどうか。サーブの構えを出す
   * @param {'forehand'|'backhand'|null} [prep] 打つ前のテイクバック。まだ振っていない
   *   （anim<=0）間、ボールがどちらの打点に来そうかに応じてラケットを引いておく。
   *   スイング開始時の角度（GROUND_START）と同じ角度なので、実際に振り始めても
   *   ポーズが飛ばずに繋がる。
   */
  scene3d.setSwingPose = function setSwingPose(player, anim, stroke, tossing, prep) {
    const arm = player.userData.arm;
    const torso = player.userData.gait.torso;

    if (anim <= 0) {
      if (tossing) {
        arm.rotation.y = 0;
        arm.rotation.z = SWING.SERVE_READY_Z;
      } else if (prep) {
        arm.rotation.y = (prep === 'backhand' ? Math.PI : 0) + SWING.GROUND_START;
        arm.rotation.z = 0;
      } else {
        arm.rotation.y = SWING.REST_Y;
        arm.rotation.z = 0;
      }
      torso.rotation.y = 0;
      return;
    }

    const progress = (ARM_SPAN - anim) / ARM_SPAN;

    if (stroke === 'serve') {
      arm.rotation.y = 0;
      arm.rotation.z = SWING.SERVE_START_Z + progress * (SWING.SERVE_FOLLOW_Z - SWING.SERVE_START_Z);
      torso.rotation.y = 0;
      return;
    }

    const backhand = stroke === 'backhand';
    // バックハンドは弧全体を π 回して体の反対サイドへ丸ごと移す（逆順になぞるだけにしない）
    const side = backhand ? Math.PI : 0;
    arm.rotation.y = side + SWING.GROUND_START + progress * SWING.GROUND_SWEEP;
    arm.rotation.z = 0;
    // sin カーブでひねって戻す（構え→打点→フォロースルーで元の向きに近づく）
    torso.rotation.y = (backhand ? -1 : 1) * SWING.TORSO_TWIST * Math.sin(progress * Math.PI);
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
