/**
 * 選手のメッシュ（胴・頭・脚・ラケットを持つ腕・逆手）とポーズ制御。
 * - スイング（打つ動作）: setSwingPose() が担当。ラケット側の腕を rotation.y で振る。
 * - 歩行/走行: setGaitPose() が担当。股関節・膝・逆手の腕・体幹を rotation.x で動かす。
 *   軸を分けているので、打ちながら走っていても振り付けが喧嘩しない。
 * 真のIK（目標位置からの逆算）ではなく、速度に応じて角度を数式で生成する簡易版。
 */
(function (RallyOne) {
  'use strict';

  const { GAIT, PLAYER, SPECIAL, SWING, THEME } = RallyOne.config;
  const { clamp, lerp } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  const TWO_PI = Math.PI * 2;
  const ARM_SPAN = PLAYER.SERVE_ANIM; // アニメーションの基準時間
  /**
   * ラケットを持つ腕がモデルのローカルのどちら側にあるか。**-1 ＝ 右利き**（-x 側）。
   * 振り付け（config.SWING の角度）は昔からすべて「腕が +x 側にある」前提で書かれているので、
   * ポーズを作り終えた後に mirrorHanded() で左右を鏡映しして右利きに直す。
   * game.js の RACKET_SIDE（当たり判定のフォア/バック）と必ず同じ向きにすること
   * （ずれると「フォアと判定された球を逆の手で振る」ことになる）。
   */
  const HAND = -1;

  function createRacketArm(shirt, mat) {
    const arm = new THREE.Group();

    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.5, 8), mat(shirt));
    upper.rotation.z = -Math.PI / 2;
    upper.position.x = HAND * 0.28;

    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 8, 20), mat(THEME.BALL));
    frame.position.set(HAND * 0.72, 0, 0);

    const strings = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.14, side: THREE.DoubleSide,
      }),
    );
    strings.position.set(HAND * 0.72, 0, 0);

    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.2, 8), mat(THEME.GRIP));
    grip.rotation.z = Math.PI / 2;
    grip.position.set(HAND * 0.53, 0, 0);

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
    // この選手が普段向いている方向（world.js が cpu 側に Math.PI を入れる）。ツイーナーで
    // 体ごと反転させたあと、確実に元の向きへ戻すために基準として持っておく。
    group.userData.facing = 0;
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
   * 球種（フラット／トップスピン／スライス／ドロップ）ごとの振り付けを返す。
   * 未知の球種（サーブ用の値など）はフラット扱い。
   */
  function spinForm(spin) {
    return SWING.SPIN_FORM[spin] || SWING.SPIN_FORM.flat;
  }

  /**
   * スイングの残り時間から腕の角度を決める。5種類のポーズを軸を分けて切り替える：
   * - フォアハンド／バックハンド: rotation.y（横振り）。mirrorGroundAngle() で左右だけを
   *   鏡映しするので、バックハンドでもテイクバック→打点→フォロースルーが正しい前後の
   *   向きのまま、体の逆サイドで振られる。さらに球種（state.spin）で振り付けが変わる：
   *   腕の仰角 rotation.z を下から上へ通せばトップスピン、上から下へ通せばスライス、
   *   ほぼ水平に通せばフラット（差分は SWING.SPIN_FORM）。横振りの弧と体幹のひねりの
   *   深さも球種ごとに増減する。
   * - サーブ: rotation.z（縦振り）。トス中は構え、打った瞬間から真上→前へ振り下ろす。
   * - スマッシュ: 仰角(rotation.z)と前後の傾き(rotation.x)を同時に動かし、頭の後ろに
   *   振りかぶった位置から真上（打点）を通って体の前へ振り下ろす（フォア/バックの区別は
   *   ない）。跳んで打つので、体の浮き・脚のはさみ跳びは applySmashJump() が受け持つ。
   * - ボレー: フォア/バックと同じ rotation.y だが、テイクバックがほとんどない短いパンチ。
   * @param {THREE.Group} player
   * @param {object} state その選手の見た目に関わる状態。ゲーム側の生の state と
   *   リプレイのコマ（world.js#snapshotPlayer）の両方が同じ形をしている：
   *   - anim {number} スイングの残り時間（秒）。0 なら構え／トスの姿勢
   *   - stroke {'forehand'|'backhand'|'serve'|'smash'|'volley-forehand'|'volley-backhand'}
   *   - prep {'forehand'|'backhand'|'smash'|null} 打つ前のテイクバック。まだ振って
   *     いない（anim<=0）間、ボールがどちらの打点に来そうかに応じてラケットを引いておく。
   *     'smash' は高い球を溜めているとき＝頭の後ろに担いだ振りかぶりの構え。
   *   - spin {'flat'|'top'|'slice'|'drop'} テイクバック中／スイング中の球種。
   *     グラウンドストロークのフォームだけを切り替える（SWING.SPIN_FORM）。
   *   - chargeFrac {number} 溜めている間だけ 0〜1 で伸びる値。溜めるほど GROUND_START から
   *     さらに CHARGE_PULL だけ深くテイクバックし、離した瞬間との落差で「今しっかり
   *     溜めている」ことが分かるようにする。
   *   - swingCharge {number} 振り始めた瞬間に固定される溜め量(0〜1)。スイング中（anim>0）は、
   *     テイクバックが実際にどこまで深く入っていたか（＝chargeFrac の最終値）から弧を
   *     始めるのに使う。ここを chargeFrac にすると振っている間に charging が false に
   *     戻って 0 に落ち、テイクバック位置に飛んで見えてしまうため、release() の瞬間に
   *     固定される swingCharge を使い続ける。
   * @param {boolean} [tossing] トス中（打つ前）かどうか。サーブの構えを出す
   */
  /** 0→1 を滑らかに立ち上げる（両端で速度0）。振り向きのカクつきを消すのに使う */
  function ease(t) {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
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

  function poseArm(player, state, tossing) {
    const { anim, stroke, prep, spin, chargeFrac, swingCharge } = state;
    const arm = player.userData.arm;
    const torso = player.userData.gait.torso;
    // ツイーナー（股抜き）の間だけ、体ごと相手に背を向ける。ラケット腕はモデルの
    // ローカル +x 側に作られているので、向きを反転させればそのまま「背中側の球を
    // 股の下から打つ」形になる（普段の向きは userData.facing に控えてある）。
    player.rotation.y = (player.userData.facing || 0) + tweenerTurn(anim, stroke);

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
        // 球種ぶんの差分（START）を足したところからテイクバックし、ラケットの高さ
        // （Z_READY）も球種で変える＝振り出す前に何を打とうとしているかが分かる。
        const form = spinForm(spin);
        const pullBack = SWING.GROUND_START + form.START + (chargeFrac || 0) * SWING.CHARGE_PULL;
        arm.rotation.y = mirrorGroundAngle(pullBack, prep === 'backhand');
        arm.rotation.z = form.Z_READY;
        arm.rotation.x = 0;
      } else {
        arm.rotation.y = SWING.REST_Y;
        arm.rotation.z = 0;
        arm.rotation.x = 0;
      }
      torso.rotation.y = 0;
      return;
    }

    // スマッシュとツイーナーはモーションが長い（PLAYER.SMASH_ANIM / SPECIAL.TWEENER.ANIM）
    // ので、進行度もその長さで割る。他のストロークは従来どおり ARM_SPAN 基準
    // （＝既存の振り付けを変えない）。
    const span = stroke === 'smash' ? PLAYER.SMASH_ANIM
      : stroke === 'tweener' ? SPECIAL.TWEENER.ANIM
        : stroke === 'jackknife' ? SPECIAL.JACK.ANIM
          : ARM_SPAN;
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

    if (stroke === 'tweener') {
      // ツイーナー（股抜き）。体は相手に背を向けたまま、ラケットだけを股の下へ落として
      // 下から上へ振り抜く：横振り(rotation.y)はほぼ使わず、仰角(rotation.z)を
      // 真下から前方へ通す。前後の傾き(rotation.x)で腕を体の内側（股の下）へ入れる。
      const S = SWING.TWEENER;
      arm.rotation.y = S.Y;
      arm.rotation.z = lerp(S.Z_START, S.Z_END, progress);
      arm.rotation.x = S.X;
      torso.rotation.y = 0;
      return;
    }

    if (stroke === 'jackknife') {
      // ジャックナイフ。高い打点をフラットのバックハンドで叩くので、横振り(rotation.y)は
      // グラウンドストロークと同じ系統のまま、仰角(rotation.z)を肩の高さ（Z_START）から
      // 体の前（Z_END）へ下ろす＝上から叩き込む弧になる。必ずバックハンド側に振る。
      // **進行度0がそのまま打点**（Y_START/Z_START）で、そこから振り抜く：跳躍も
      // 打点が頂点なので、1コマ目が「跳んだ一番高いところで球を捉えた絵」になる。
      const J = SWING.JACK;
      arm.rotation.y = mirrorGroundAngle(lerp(J.Y_START, J.Y_END, progress), true);
      arm.rotation.z = lerp(J.Z_START, J.Z_END, progress);
      arm.rotation.x = 0;
      // 跳びながら体をひねって振り抜く（通常のバックハンドより深くひねる）
      torso.rotation.y = -J.TORSO_TWIST * Math.sin(progress * Math.PI);
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
    const form = spinForm(spin);
    // テイクバックが溜め量ぶん深く入っていた分だけ、始点をそこに合わせて弧を広げる
    // （終点＝フォロースルーは GROUND_START+GROUND_SWEEP のまま揃える）。
    // 球種ぶんの差分（START/SWEEP）は溜めとは独立に足す＝どの球種でも溜めの効き方は同じ。
    const start = SWING.GROUND_START + form.START + (swingCharge || 0) * SWING.CHARGE_PULL;
    const sweep = SWING.GROUND_SWEEP + form.SWEEP - (swingCharge || 0) * SWING.CHARGE_PULL;
    arm.rotation.y = mirrorGroundAngle(start + progress * sweep, backhand);
    // 腕の仰角。トップスピンは下から上へ、スライスは上から下へ、フラットはほぼ水平に
    // 通る（左右は mirrorGroundAngle() が反転させるが、上下はバックハンドでも同じ）。
    arm.rotation.z = lerp(form.Z_START, form.Z_END, progress);
    arm.rotation.x = 0;
    // sin カーブでひねって戻す（構え→打点→フォロースルーで元の向きに近づく）。
    // ひねりの深さも球種で変える（大きく擦り上げるトップスピンがいちばん深い）。
    torso.rotation.y = (backhand ? -1 : 1) * SWING.TORSO_TWIST * form.TWIST
      * Math.sin(progress * Math.PI);
  }

  /**
   * 利き手に合わせて左右を鏡映しする（HAND 参照）。x で鏡映しすると、y 軸まわりと
   * z 軸まわりの回転だけ符号が反転し、x 軸まわりの傾きは変わらない。ポーズを作る側
   * （poseArm）は「腕が +x 側」前提のままでよく、左右の違いはここ1箇所に閉じる。
   */
  function mirrorHanded(player) {
    if (HAND > 0) return;
    const arm = player.userData.arm;
    arm.rotation.y *= -1;
    arm.rotation.z *= -1;
    player.userData.gait.torso.rotation.y *= -1;
  }

  /**
   * スイング（と構え）のポーズを1人ぶん反映する。振り付けそのものは poseArm()、
   * 利き手ぶんの左右反転は mirrorHanded() が受け持つ。
   * 引数は poseArm() のドキュメントを参照。
   */
  scene3d.setSwingPose = function setSwingPose(player, state, tossing) {
    poseArm(player, state, tossing);
    mirrorHanded(player);
  };

  /**
   * 跳躍の進み具合(0〜1)。0＝踏み切り、1＝着地。跳んでいなければ null。
   * **打球のモーション（anim）とは別の時計**（state.leap）で動く：anim は「当たった
   * 瞬間」からしか始められないので、そこに跳躍を乗せると跳ぶのと打つのが同時に見える。
   * leap は game.js#tickLeap が「もうすぐ球が届く」ところで、まだ離していなくても
   * 始める＝当たるころには頂点にいて、空中で振り始める絵になる。
   * @param {object} state その選手の見た目に関わる状態
   * @param {'smash'|'jackknife'} kind この関数が受け持つ跳び方
   */
  function leapProgress(state, kind) {
    const leap = state.leap;
    if (!leap || leap.kind !== kind || leap.t <= 0) return null;
    const span = kind === 'jackknife' ? SPECIAL.JACK.LEAP_T : PLAYER.SMASH_LEAP_T;
    return clamp((span - leap.t) / span, 0, 1);
  }

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
   * 一切影響しない。ダンクスマッシュ（必殺技）だけは同じ振り付けのままもっと高く跳ぶ。
   */
  function smashLift(state) {
    const u = leapProgress(state, 'smash');
    if (u === null) return 0;
    const height = SWING.SMASH_JUMP_H
      * (state.special === 'dunkSmash' ? SPECIAL.DUNK.JUMP_MULT : 1);
    return height * leapArc(u, PLAYER.SMASH_LEAP_RISE);
  }

  /**
   * スマッシュの「跳んでいる体」。setGaitPose() の後に呼ぶこと（歩行が同じ関節を
   * 毎フレーム書くので、その上から浮いている量ぶんだけ上書きする）。
   * - 体そのものを浮かせる（メッシュの y。ゲーム側の座標は動かさない＝表示だけ）
   * - はさみ跳び：ラケット側の脚を後ろへ蹴り上げ、逆脚を前へ振り出す
   * - 体幹：打点では反り、振り下ろしに合わせて前へ折る
   * @param {object} state その選手の見た目に関わる状態（setSwingPose と同じもの）
   * @returns {number} 浮いた高さ(m)。影を小さくするのに使う（world.js 参照）
   */
  scene3d.applySmashJump = function applySmashJump(player, state) {
    const { anim, stroke, special } = state;
    const lift = smashLift(state);
    player.position.y = lift;
    if (lift <= 0) return 0;

    const gait = player.userData.gait;
    // 浮いているほど強くポーズを効かせる（ダンクで高さが伸びても効き方は同じになるよう、
    // 分母にもジャンプの倍率を掛けて正規化する）。
    const peak = SWING.SMASH_JUMP_H * (special === 'dunkSmash' ? SPECIAL.DUNK.JUMP_MULT : 1);
    const air = clamp(lift / peak, 0, 1);
    // 体幹は打球のモーション側の進み具合で折る：当たる前（anim=0）は反ったまま跳び上がり、
    // 当たってから振り下ろしに合わせて前へ折れる。
    const progress = stroke === 'smash' && anim > 0
      ? clamp((PLAYER.SMASH_ANIM - anim) / PLAYER.SMASH_ANIM, 0, 1)
      : 0;
    // はさみ跳びは「ラケット側の脚を後ろへ蹴り上げる」。legs[0] がローカル -x 側、
    // legs[1] が +x 側なので、利き手（HAND）でどちらがラケット側かを選ぶ。
    const back = gait.legs[HAND < 0 ? 0 : 1];
    const front = gait.legs[HAND < 0 ? 1 : 0];

    back.hip.rotation.x = lerp(back.hip.rotation.x, SWING.SMASH_LEG_SPLIT, air);
    back.knee.rotation.x = lerp(back.knee.rotation.x, -SWING.SMASH_KNEE_TUCK, air);
    front.hip.rotation.x = lerp(front.hip.rotation.x, -SWING.SMASH_LEG_SPLIT * 0.6, air);
    front.knee.rotation.x = lerp(front.knee.rotation.x, -SWING.SMASH_KNEE_TUCK * 0.25, air);
    gait.offArm.rotation.x = lerp(gait.offArm.rotation.x, -SWING.SMASH_LEG_SPLIT * 0.5, air);
    gait.torso.rotation.x = lerp(SWING.SMASH_TORSO_ARCH, SWING.SMASH_TORSO_X, progress * progress);
    return lift;
  };

  /**
   * 飛びつきボレー（必殺技）の倒れ込み。applySmashJump() と同じ考え方で、歩行ポーズの
   * 後に上から重ねる（浮いている量ぶんだけ上書きする）。体ごと打つ側へ倒し、脚を後ろへ
   * 流して「飛び込んだ」形にする。倒れる向きはフォア/バックで決める：フォアならラケット側
   * （ローカルの HAND 側）、バックならその逆へ倒れ込むのが自然。
   * @returns {number} 浮いた高さ(m)。スマッシュのジャンプと同じく影を小さくするのに使う
   */
  scene3d.applyDiveLean = function applyDiveLean(player, state) {
    const { anim, stroke, special } = state;
    if (special !== 'divingVolley' || anim <= 0) {
      player.rotation.z = 0; // 前の1打の倒れ込みを残さない
      return 0;
    }
    const D = SPECIAL.DIVE;
    // 飛び出し（0）→ 一番伸びきったところ（0.5）→ 着地（1）の山
    const arc = Math.sin(clamp((PLAYER.SWING_ANIM - anim) / PLAYER.SWING_ANIM, 0, 1) * Math.PI);
    // 倒れ込む先（ローカルx）。rotation.z を正にすると体は -x 側へ傾くので符号を反転させる。
    const toward = (String(stroke).indexOf('backhand') !== -1 ? -1 : 1) * HAND;
    player.rotation.z = -toward * D.LEAN * arc;
    const lift = D.LIFT * arc;
    player.position.y = lift;

    const gait = player.userData.gait;
    gait.legs.forEach(({ hip, knee }) => {
      hip.rotation.x = lerp(hip.rotation.x, -SWING.DIVE_LEG_TRAIL, arc);
      knee.rotation.x = lerp(knee.rotation.x, -SWING.DIVE_KNEE_TUCK, arc);
    });
    gait.torso.rotation.x = lerp(gait.torso.rotation.x, SWING.DIVE_TORSO_X, arc);
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
      knee.rotation.x = lerp(knee.rotation.x, -T.KNEE_TUCK, air);
    });
    gait.offArm.rotation.x = lerp(gait.offArm.rotation.x, T.OFF_ARM_X, air);
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
   * leap は**溜めを離した瞬間**（game.js#chargeRelease）から数え始めるので、
   * 跳ぶ → ボールが来る → 振り抜く → 着地、の順に読める。
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
    gait.offArm.rotation.x = lerp(gait.offArm.rotation.x, -J.LEG_FOLD * 0.4, air);
    gait.torso.rotation.x = lerp(gait.torso.rotation.x, J.TORSO_X, air);
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
