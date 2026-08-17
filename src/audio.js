/**
 * 効果音。ファイルを持たず、Web Audio の短いトーンだけで鳴らす。
 * AudioContext はユーザー操作より前に作れないので、遅延生成 + unlock() で resume する。
 */
(function (RallyOne) {
  'use strict';

  let ctx = null;

  function context() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    return ctx;
  }

  /** 最初のクリック／キー入力で呼ぶ。ブラウザの自動再生ブロックを解除する。 */
  function unlock() {
    const ac = context();
    if (ac && ac.state === 'suspended') ac.resume();
  }

  function tone(freq, dur, vol) {
    const ac = context();
    if (!ac) return;
    try {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      osc.connect(gain).connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + dur);
    } catch (e) {
      /* 音が出ないだけなのでゲームは続行 */
    }
  }

  const sfx = {
    serve: () => tone(320, 0.09, 0.16),
    hit: (who) => tone(who === 'you' ? 520 : 430, 0.08, 0.20),
    bounce: () => tone(180, 0.06, 0.10),
    point: (winner) => tone(winner === 'you' ? 660 : 220, 0.16, 0.14),
  };

  RallyOne.audio = { unlock, sfx };
})(window.RallyOne = window.RallyOne || {});
