/**
 * 効果音。ファイルを持たず、Web Audio の短いトーンだけで鳴らす。
 * AudioContext はユーザー操作より前に作れないので、遅延生成 + unlock() で resume する。
 */
(function (RallyOne) {
  'use strict';

  const { AUDIO } = RallyOne.config;
  const { rand, clamp, lerp } = RallyOne.math;

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

  /** dur秒ぶんのホワイトノイズ（観客のざわめき／歓声の材料）。都度生成する軽い使い捨て。 */
  function noiseBuffer(ac, dur) {
    const length = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * 観客のざわめき／歓声。ホワイトノイズをバンドパスフィルタで曲げ、沸き上がって
   * 収まる山なりの音量エンベロープを掛けるだけの簡易合成（音源ファイルは使わない）。
   * ラリーの長さ（rallyShots）で音量・長さが伸び、決まり方（outcome）で盛り上がりの倍率が変わる。
   * @param {number} rallyShots このポイントで何本打たれたか（サーブも1本）
   * @param {'ace'|'winner'|'error'|'doubleFault'} outcome 決まり方
   */
  function crowd(rallyShots, outcome) {
    const ac = context();
    if (!ac) return;
    try {
      const C = AUDIO.CROWD;
      // EXCITEMENT_SHOTS本で盛り上がりが頭打ちになる目安。エースは定義上ラリー1本
      // （サーブのみ）なので、ここが常に0のまま＝BASE_VOL/BASE_DURより育たない。
      const excitement = clamp((Math.max(1, rallyShots || 1) - 1) / (C.EXCITEMENT_SHOTS - 1), 0, 1);
      const dur = lerp(C.BASE_DUR, C.MAX_DUR, excitement) * rand(1 - AUDIO.DUR_JITTER, 1 + AUDIO.DUR_JITTER);
      const vol = lerp(C.BASE_VOL, C.MAX_VOL, excitement)
        * (C.OUTCOME_VOL_MULT[outcome] || 1) * rand(1 - AUDIO.VOL_JITTER, 1 + AUDIO.VOL_JITTER);
      const freq = lerp(C.FILTER_BASE_HZ, C.FILTER_EXCITED_HZ, excitement);

      const src = ac.createBufferSource();
      src.buffer = noiseBuffer(ac, dur);
      const filter = ac.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = 0.7;
      const gain = ac.createGain();
      // クリック音を避け、立ち上がり(ATTACK)を経てから山なりに収める。
      gain.gain.setValueAtTime(0.0001, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(vol, ac.currentTime + C.ATTACK);
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);

      src.connect(filter).connect(gain).connect(ac.destination);
      src.start();
      src.stop(ac.currentTime + dur);
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
    // ネットコードに当たる鈍い音。bounce()より低く長め＝ゴム/ガットの振動っぽさを出す
    netIn: () => tone(130, 0.11, 0.12),
    point: (winner, outcome, rallyShots) => {
      tone(winner === 'you' ? 660 : 220, 0.16, 0.14);
      crowd(rallyShots, outcome);
    },
  };

  RallyOne.audio = { unlock, sfx };
})(window.RallyOne = window.RallyOne || {});
