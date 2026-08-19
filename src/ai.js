/**
 * CPU の判断だけを集めたファイル。難易度を触りたいときはここと config の CPU を見る。
 * 状態は持たず、入力から目標値を返すだけ。
 */
(function (RallyOne) {
  'use strict';

  const { CPU, DOUBLES, HALF_L, HALF_W, PHYSICS } = RallyOne.config;
  const {
    clamp, lerp, rand, signOr,
  } = RallyOne.math;
  const { predictLanding } = RallyOne.physics;

  /**
   * ボールを追うときに立ちたい位置。
   * CPU.CHASE_Z_* はもともと cpu 陣地（z>0）基準の値なので、you 陣地（z<0）の
   * youMate が使うときは side=-1 を渡して z 方向を鏡映しにする（自陣を追わせるため）。
   * @param {1|-1} [side] 追う選手がいる陣地。既定は 1（cpu 陣地）。
   * @returns {{x:number, z:number}}
   */
  function chasePosition(ball, side = 1) {
    const landing = predictLanding(ball);
    const behindZ = side > 0
      ? Math.max(landing.z, CPU.CHASE_Z_MIN) + CPU.CHASE_BEHIND
      : Math.min(landing.z, -CPU.CHASE_Z_MIN) - CPU.CHASE_BEHIND;
    const zMin = side > 0 ? CPU.CHASE_Z_MIN : -CPU.CHASE_Z_MAX;
    const zMax = side > 0 ? CPU.CHASE_Z_MAX : -CPU.CHASE_Z_MIN;
    return {
      x: clamp(landing.x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT),
      z: clamp(behindZ, zMin, zMax),
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
   * ダブルスのペアのうち、どちらが返球を担当するか。
   * 落下点までの距離が近い方が応答し、もう一方は構えに回る。
   * @returns {boolean} me（1人目）が担当するなら true
   */
  function isResponder(me, mate, ball) {
    const landing = predictLanding(ball);
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
