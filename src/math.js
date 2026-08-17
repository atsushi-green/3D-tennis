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

  RallyOne.math = { clamp, rand, signOr, approach, lerp };
})(window.RallyOne = window.RallyOne || {});
