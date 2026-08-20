/**
 * 効果音。ファイルを持たず、Web Audio の短いトーンだけで鳴らす。
 * AudioContext はユーザー操作より前に作れないので、遅延生成 + unlock() で resume する。
 */
(function (RallyOne) {
  'use strict';

  const { AUDIO } = RallyOne.config;
  const { rand } = RallyOne.math;

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

  /**
   * 呼び出しごとに周波数・長さ・音量を軽くランダムに揺らし、波形も数種から選ぶ。
   * 毎回全く同じ音にならないようにするための味付け（AUDIO.*_JITTER）。
   */
  function tone(freq, dur, vol) {
    const ac = context();
    if (!ac) return;
    try {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = AUDIO.WAVES[Math.floor(Math.random() * AUDIO.WAVES.length)];
      osc.frequency.value = freq * rand(1 - AUDIO.PITCH_JITTER, 1 + AUDIO.PITCH_JITTER);
      const jitteredDur = dur * rand(1 - AUDIO.DUR_JITTER, 1 + AUDIO.DUR_JITTER);
      const jitteredVol = vol * rand(1 - AUDIO.VOL_JITTER, 1 + AUDIO.VOL_JITTER);
      gain.gain.setValueAtTime(jitteredVol, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + jitteredDur);
      osc.connect(gain).connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + jitteredDur);
    } catch (e) {
      /* 音が出ないだけなのでゲームは続行 */
    }
  }

  const sfx = {
    // 溜めたサーブほど鋭く大きな音に
    serve: (charge = 0) => tone(320 * (1 + charge * 0.35), 0.09, 0.16 + charge * 0.12),
    /**
     * バックハンドはフォアハンドよりわずかに低く・こもった音にして打感を変える。
     * さらに溜めた強打ほど高く・強く鳴らして「弾いた」感を出す。
     */
    hit: (who, stroke, charge = 0) => {
      const base = who === 'you' ? 520 : 430;
      const backhand = stroke.includes('backhand'); // 'backhand' と 'volley-backhand' の両方を拾う
      const freq = (backhand ? base * 0.84 : base) * (1 + charge * 0.3);
      tone(freq, (backhand ? 0.1 : 0.08) + charge * 0.05, 0.20 + charge * 0.16);
    },
    bounce: () => tone(180, 0.06, 0.10),
    point: (winner) => tone(winner === 'you' ? 660 : 220, 0.16, 0.14),
  };

  RallyOne.audio = { unlock, sfx };
})(window.RallyOne = window.RallyOne || {});
