/**
 * CPU の判断だけを集めたファイル。難易度を触りたいときはここと config の CPU を見る。
 * 状態は持たず、入力から目標値を返すだけ。
 */
(function (RallyOne) {
  'use strict';

  const { CPU, DOUBLES, HALF_L, HALF_W, PHYSICS } = RallyOne.config;
  const { clamp, rand, signOr } = RallyOne.math;
  const { predictLanding } = RallyOne.physics;

  /**
   * ボールを追うときに立ちたい位置。
   * @returns {{x:number, z:number}}
   */
  function chasePosition(ball) {
    const landing = predictLanding(ball);
    return {
      x: clamp(landing.x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT),
      z: clamp(
        Math.max(landing.z, CPU.CHASE_Z_MIN) + CPU.CHASE_BEHIND,
        CPU.CHASE_Z_MIN,
        CPU.CHASE_Z_MAX,
      ),
    };
  }

  /** ラリーが自分に関係ないときの定位置 */
  function homePosition() {
    return { x: 0, z: CPU.HOME_Z };
  }

  /**
   * 打球の狙い先。プレイヤーの逆をつきつつ、一定確率でミスもする。
   * @param {number} playerX プレイヤーの現在位置
   * @returns {{x:number, y:number, z:number}} ワールド座標の目標地点
   */
  function shotTarget(playerX) {
    let x = -signOr(playerX, Math.random() - 0.5) * rand(CPU.AIM_X_MIN, CPU.AIM_X_MAX);
    let z = -rand(CPU.AIM_Z_MIN, CPU.AIM_Z_MAX);

    if (Math.random() < CPU.OUT_LONG) z = -(HALF_L + 0.9);               // ベースラインオーバー
    if (Math.random() < CPU.OUT_WIDE) x = Math.sign(x) * (HALF_W + 0.7); // サイドアウト

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
