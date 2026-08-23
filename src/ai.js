/**
 * CPU の判断だけを集めたファイル。難易度を触りたいときはここと config の CPU を見る。
 * 状態は持たず、入力から目標値を返すだけ。
 */
(function (RallyOne) {
  'use strict';

  const {
    CPU, DOUBLES, HALF_L, HALF_W, PHYSICS, PLAYER,
  } = RallyOne.config;
  const {
    clamp, lerp, rand, signOr,
  } = RallyOne.math;
  const { predictLanding, predictApex, predictAtZ } = RallyOne.physics;

  /**
   * 追跡目標として使う地点。まだ一度もバウンドしていない球はそのまま predictLanding()
   * の（最初の）着地点でよい。
   * 既に1バウンドした球に predictLanding() をそのまま使うと「次の（＝2バウンド目の）
   * 着地点」まで先読みしてしまい、実際に打つ位置よりずっと先を追いかけてしまう。
   * かわりに、まだ上がっている途中（vy>0）なら predictApex() で「今の弾道の頂点」
   * （＝風がなければ現在地から一意に決まる固定点。時間ベースの先読みと違い、球が
   * 近づいてもずるずる先へ動かない）を、頂点を過ぎて下り始めていたら素直に現在地を
   * 追わせる（頂点はもう過ぎているので、これ以上先読みする意味がない）。
   */
  function chaseTarget(ball) {
    if (ball.bounces === 0) return predictLanding(ball);
    if (ball.vy > 0) return predictApex(ball);
    return { x: ball.x, z: ball.z };
  }

  /**
   * 既にボールへ手が届く範囲にいるか（＝これ以上動く必要がない）。
   * バウンドした瞬間に追跡目標（着地点の後ろ→頂点や現在地）が切り替わるせいで、実際には
   * もう届く位置に構えられているのに「新しい目標までの距離」だけを見て全力で走り出したと
   * 判定され（＝打点での実速度が跳ね上がり stretch が最大になる＝ゆるい返球になる）てしまう
   * ことがあった。見た目には十分な余裕をもって追いついているのに返球が弱くなる主因だったので、
   * 目標地点がどこであれ「もう届く」ならそもそも動かさない（＝待球）。
   * 高さは上限（CPU_REACH_Y）だけ見る。下限（CPU_REACH_Y_MIN）まで入れると、バウンド直後の
   * まだ弾みきっていない一瞬（y が下限をわずかに下回る数フレーム）だけこの判定を素通りして
   * しまい、すぐ次のフレームには打てる高さまで上がってくるのに、その一瞬だけ切り取って
   * 「まだ届かない」→ 新しい目標へ全力で動き出した扱いになってしまっていた。
   */
  function inReachOf(player, ball) {
    return ball.y < PLAYER.CPU_REACH_Y
      && Math.hypot(player.x - ball.x, player.z - ball.z) <= PLAYER.CPU_REACH;
  }

  /**
   * ボールを追うときに立ちたい位置。
   * CPU.CHASE_Z_* はもともと cpu 陣地（z>0）基準の値なので、you 陣地（z<0）の
   * youMate が使うときは side=-1 を渡して z 方向を鏡映しにする（自陣を追わせるため）。
   * @param {1|-1} [side] 追う選手がいる陣地。既定は 1（cpu 陣地）。
   * @param {{x:number, z:number}} [player] 追う本人の現在位置。渡された場合のみ
   *   inReachOf() / canPoach() を見る。省略時（isResponder 用の距離比較など）は
   *   常に旧来の着地点基準。
   *   既に届く位置にいるならそこに留まり、ネット際で canPoach() できるときは
   *   着地点（＝深い場所）まで下がらせるのではなく、その場でボールが自分の前を通る
   *   位置まで横に寄らせるだけにする（＝ポーチできる態勢を保つ）。
   * @returns {{x:number, z:number}}
   */
  function chasePosition(ball, side = 1, player) {
    if (player && inReachOf(player, ball)) {
      return { x: player.x, z: player.z };
    }
    if (player && canPoach(player, ball)) {
      const at = predictAtZ(ball, player.z);
      return { x: clamp(at.x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT), z: player.z };
    }
    const landing = chaseTarget(ball);
    // 「後ろに下がって待つ」のはバウンド前（＝着地点そのものはまだ低すぎて打てない）の
    // 話であって、バウンド後（chaseTarget が頂点や現在地を返す）はもう十分な高さの
    // 位置そのものなので、これ以上下げる必要はない。
    const targetZ = ball.bounces >= 1
      ? landing.z
      : side > 0
        ? Math.max(landing.z, CPU.CHASE_Z_MIN) + CPU.CHASE_BEHIND
        : Math.min(landing.z, -CPU.CHASE_Z_MIN) - CPU.CHASE_BEHIND;
    const zMin = side > 0 ? CPU.CHASE_Z_MIN : -CPU.CHASE_Z_MAX;
    const zMax = side > 0 ? CPU.CHASE_Z_MAX : -CPU.CHASE_Z_MIN;
    return {
      x: clamp(landing.x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT),
      z: clamp(targetZ, zMin, zMax),
    };
  }

  /** ラリーが自分に関係ないときの定位置 */
  function homePosition() {
    return { x: 0, z: CPU.HOME_Z };
  }

  /**
   * 打球の狙い先。相手プレイヤーの逆をつきつつ、一定確率でミスもする。
   * @param {number} opponentX 逆をつく相手（返球を受ける側）の現在位置
   * @param {1|-1} [dir] 打ち込む方向。既定は -1（z<0側＝you陣地。cpu が you を狙う従来の向き）。
   *   you 陣地の選手（youMate）が cpu 陣地（z>0）を狙うときは +1 を渡す。
   * @param {number} [stretch] 0〜1。ぎりぎり追いついて打った度合い（hit() が実速度から算出）。
   *   大きいほど狙いが浅く・中央寄りになり、ミスの確率も上がる（＝弱気な返球）。
   * @returns {{x:number, y:number, z:number}} ワールド座標の目標地点
   */
  function shotTarget(opponentX, dir = -1, stretch = 0) {
    const aimXMin = lerp(CPU.AIM_X_MIN, CPU.STRETCH_AIM_X_MIN, stretch);
    const aimXMax = lerp(CPU.AIM_X_MAX, CPU.STRETCH_AIM_X_MAX, stretch);
    const aimZMin = lerp(CPU.AIM_Z_MIN, CPU.STRETCH_AIM_Z_MIN, stretch);
    const aimZMax = lerp(CPU.AIM_Z_MAX, CPU.STRETCH_AIM_Z_MAX, stretch);
    const outLong = lerp(CPU.OUT_LONG, CPU.STRETCH_OUT_LONG, stretch);
    const outWide = lerp(CPU.OUT_WIDE, CPU.STRETCH_OUT_WIDE, stretch);

    let x = -signOr(opponentX, Math.random() - 0.5) * rand(aimXMin, aimXMax);
    let z = dir * rand(aimZMin, aimZMax);

    if (Math.random() < outLong) z = dir * (HALF_L + 0.9);          // ベースラインオーバー
    if (Math.random() < outWide) x = Math.sign(x) * (HALF_W + 0.7); // サイドアウト

    return { x, y: PHYSICS.BALL_R, z };
  }

  /**
   * ネット際にいる選手が、まだ着地していないボールを待たずに横取り（ポーチ）できるか。
   * isResponder() を着地点までの距離だけで決めると、前衛の目の前を素通りする球でも
   * 着地点は後衛側（深い場所）になるため常に後衛任せになり、前衛が全くボレーしない
   * （＝スルーする）事態になっていた。ここでは「まだバウンドしていない球が、自分の
   * いる深さ（z）を通過する瞬間、自分の届く範囲・高さにあるか」を直接シミュレートする。
   */
  function canPoach(player, ball) {
    if (ball.bounces > 0 || Math.abs(player.z) > PLAYER.VOLLEY_Z) return false;
    const at = predictAtZ(ball, player.z);
    if (!at) return false;
    return Math.abs(at.x - player.x) <= PLAYER.CPU_REACH
      && at.y < PLAYER.CPU_REACH_Y && at.y > PLAYER.CPU_REACH_Y_MIN;
  }

  /**
   * ダブルスのペアのうち、どちらが返球を担当するか。
   * ネット際にいる方が canPoach() できるならそちらを優先し（ポーチ）、
   * そうでなければ落下点までの距離が近い方が応答し、もう一方は構えに回る。
   * @returns {boolean} me（1人目）が担当するなら true
   */
  function isResponder(me, mate, ball) {
    const meCanPoach = canPoach(me, ball);
    const mateCanPoach = canPoach(mate, ball);
    if (meCanPoach !== mateCanPoach) return meCanPoach;

    const landing = chaseTarget(ball);
    const dMe = Math.hypot(me.x - landing.x, me.z - landing.z);
    const dMate = Math.hypot(mate.x - landing.x, mate.z - landing.z);
    return dMe <= dMate;
  }

  /**
   * 応答しない方が構える位置。相方の反対サイドへ寄って、ネット際で待つ。
   * @param {number} responderX 応答している側の現在位置
   * @param {number} netZ 自陣のネット際の深さ（DOUBLES.NET_Z_YOU / NET_Z_CPU）
   */
  function coverPosition(responderX, netZ) {
    const x = clamp(-responderX * DOUBLES.MIRROR, -DOUBLES.SLOT_X, DOUBLES.SLOT_X);
    return { x, z: netZ };
  }

  RallyOne.ai = {
    chasePosition, homePosition, shotTarget, isResponder, coverPosition,
  };
})(window.RallyOne = window.RallyOne || {});
