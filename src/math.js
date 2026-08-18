/** ゲームロジックが three.js に依存しないための最小限の数学ヘルパー */
(function (RallyOne) {
  'use strict';

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /** min〜max の一様乱数 */
  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  /** v が 0 のときは fallback の符号を返す（0 で割る／真正面に返すのを避ける） */
  function signOr(v, fallback) {
    return v === 0 ? Math.sign(fallback) : Math.sign(v);
  }

  /** target に向かって、1フレームで最大 step だけ近づく */
  function approach(current, target, step) {
    return current + clamp(target - current, -step, step);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * (cx,cz) から (tx,tz) へ、大きさ maxDelta を超えない範囲で2Dベクトルとして近づける。
   * 加速度で速度を目標値に寄せるのに使う（軸ごとに clamp すると斜め方向だけ
   * 加速が速くなってしまうため、ベクトルの大きさで制限する）。
   */
  function approach2D(cx, cz, tx, tz, maxDelta) {
    const dx = tx - cx;
    const dz = tz - cz;
    const dist = Math.hypot(dx, dz);
    if (dist <= maxDelta || dist === 0) return { x: tx, z: tz };
    const t = maxDelta / dist;
    return { x: cx + dx * t, z: cz + dz * t };
  }

  RallyOne.math = { clamp, rand, signOr, approach, approach2D, lerp };
})(window.RallyOne = window.RallyOne || {});
