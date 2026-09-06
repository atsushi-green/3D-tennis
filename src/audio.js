/**
 * 効果音。音源ファイルを持たず、Web Audio で毎回その場で合成する。
 * AudioContext はユーザー操作より前に作れないので、遅延生成 + unlock() で resume する。
 *
 * 打球音・バウンド音は正弦波1本ではなく3層の重ね合わせで作る（値は config.js の AUDIO）：
 *   ノイズ層  ガットが弾ける／地面と擦れる高い成分。バンドパスの中心が高いほど鋭い音
 *   ボディ層  ボール／フレーム／地面の胴鳴り。低い音から急激に下がって「コッ」と鳴る
 *   ブラシ層  擦る余韻。ハイパス通しのノイズで、回転をかけるショットほど長く残す
 * この3層の配合を打ち方（フラット／トップスピン／スライス／ボレー／スマッシュ／サーブ／
 * ドロップ）とサーフェスで変えることで、音だけで何を打ったか分かるようにしている。
 */
(function (RallyOne) {
  'use strict';

  const { AUDIO, SURFACE } = RallyOne.config;
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

  // 呼び出しごとの軽いランダム（AUDIO.*_JITTER）。毎回まったく同じ音にならないようにする味付け。
  const jHz = (hz) => hz * rand(1 - AUDIO.PITCH_JITTER, 1 + AUDIO.PITCH_JITTER);
  const jDur = (dur) => dur * rand(1 - AUDIO.DUR_JITTER, 1 + AUDIO.DUR_JITTER);
  const jVol = (vol) => vol * rand(1 - AUDIO.VOL_JITTER, 1 + AUDIO.VOL_JITTER);

  /**
   * ノイズ層／ブラシ層／歓声の材料。打球のたびに数千サンプル生成しないよう一度だけ焼いて
   * 使い回し、再生のたびに開始位置をずらす（同じ波形の繰り返しに聞こえないようにするため）。
   */
  let noiseCache = null;
  function noiseBuffer(ac) {
    if (noiseCache && noiseCache.sampleRate === ac.sampleRate) return noiseCache;
    const length = Math.max(1, Math.floor(ac.sampleRate * AUDIO.NOISE_BUFFER_SEC));
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    noiseCache = buffer;
    return buffer;
  }

  /** 0 まで落とすと exponentialRamp が使えないので、無音とみなす下限。 */
  const SILENCE = 0.0001;

  /**
   * 立ち上がり(AUDIO.ATTACK)だけ持たせて指数的に減衰するエンベロープ。
   * ATTACK が 0 だと頭にプツッというデジタルなクリックが乗る。
   */
  function envelope(ac, vol, dur, attack, at = 0) {
    const gain = ac.createGain();
    const t0 = ac.currentTime + at;
    const a = Math.min(attack === undefined ? AUDIO.ATTACK : attack, dur * 0.5);
    gain.gain.setValueAtTime(SILENCE, t0);
    gain.gain.linearRampToValueAtTime(Math.max(vol, SILENCE), t0 + a);
    gain.gain.exponentialRampToValueAtTime(SILENCE, t0 + dur);
    return gain;
  }

  /**
   * フィルタを通したノイズを1発鳴らす（ノイズ層／ブラシ層／擦過音／拍手の1粒）。
   * @param {{vol:number, hz:number, dur:number, q?:number, type?:string, at?:number}} o
   *   at ＝ 今から何秒後に鳴らすか（拍手を時間差でばらまくのに使う。既定は即時）
   */
  function noiseVoice(ac, o) {
    const vol = jVol(o.vol);
    if (!(vol > SILENCE)) return;
    const dur = jDur(o.dur);
    const at = o.at || 0;
    const buffer = noiseBuffer(ac);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = o.type || 'bandpass';
    filter.frequency.value = jHz(o.hz);
    filter.Q.value = o.q === undefined ? 1 : o.q;
    const t0 = ac.currentTime + at;
    src.connect(filter).connect(envelope(ac, vol, dur, undefined, at)).connect(ac.destination);
    src.start(t0, Math.random() * Math.max(0, buffer.duration - dur));
    src.stop(t0 + dur);
  }

  /**
   * 胴鳴り（ボディ層）。当たった瞬間の高さから DROP 倍まで一気に落ちることで、
   * 一定の音程の「ピー」ではなく打撃音の「コッ」に聞こえる。
   * @param {{vol:number, hz:number, drop:number, dur:number, wave?:string}} o
   */
  function bodyVoice(ac, o) {
    const vol = jVol(o.vol);
    if (!(vol > SILENCE)) return;
    const dur = jDur(o.dur);
    const hz = jHz(o.hz);
    const osc = ac.createOscillator();
    osc.type = o.wave || 'triangle';
    const t0 = ac.currentTime;
    osc.frequency.setValueAtTime(hz, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, hz * o.drop), t0 + dur);
    osc.connect(envelope(ac, vol, dur)).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur);
  }

  /**
   * 3層まとめて1発の打撃音にする。voice は AUDIO.IMPACT.STROKE / AUDIO.BOUNCE.SURFACE の
   * どれか（BRUSH_* を持たない voice はブラシ層なしで鳴る）。
   * @param {object} voice 層ごとの音量・周波数・長さ
   * @param {{pitch?:number, gain?:number, dur?:number}} [mod] 溜め・スピン・速度による倍率
   */
  function layered(voice, mod = {}) {
    const ac = context();
    if (!ac) return;
    const pitch = mod.pitch === undefined ? 1 : mod.pitch;
    const gain = mod.gain === undefined ? 1 : mod.gain;
    const dur = mod.dur === undefined ? 1 : mod.dur;
    try {
      noiseVoice(ac, {
        vol: voice.NOISE_VOL * gain,
        hz: voice.NOISE_HZ * pitch,
        q: voice.NOISE_Q,
        dur: voice.NOISE_DUR * dur,
      });
      bodyVoice(ac, {
        vol: voice.BODY_VOL * gain,
        hz: voice.BODY_HZ * pitch,
        drop: voice.BODY_DROP,
        dur: voice.BODY_DUR * dur,
      });
      if (voice.BRUSH_VOL) {
        noiseVoice(ac, {
          type: 'highpass',
          vol: voice.BRUSH_VOL * gain,
          hz: voice.BRUSH_HZ,
          q: 0.7,
          dur: voice.BRUSH_DUR * dur,
        });
      }
    } catch (e) {
      /* 音が出ないだけなのでゲームは続行 */
    }
  }

  /**
   * 観客のざわめき／歓声＋拍手。ホワイトノイズをバンドパスフィルタで曲げ、沸き上がって
   * 収まる山なりの音量エンベロープを掛けるだけの簡易合成（音源ファイルは使わない）。
   * ラリーの長さ（rallyShots）で音量・長さが伸び、決まり方（outcome）で盛り上がりの倍率が、
   * 勝った側（winner）で音量と明るさが変わる（自分が取れば大きく明るく沸く）。
   * 歓声だけだと風の音に近く決着の瞬間が分かりにくいので、乾いた短いノイズ＝拍手の粒を
   * CLAP.WINDOW 秒の中にばらまいて重ねる。
   * @param {number} rallyShots このポイントで何本打たれたか（サーブも1本）
   * @param {'ace'|'winner'|'error'|'doubleFault'} outcome 決まり方
   * @param {'you'|'cpu'} winner 取った側
   */
  function crowd(rallyShots, outcome, winner) {
    const ac = context();
    if (!ac) return;
    try {
      const C = AUDIO.CROWD;
      // EXCITEMENT_SHOTS本で盛り上がりが頭打ちになる目安。エースは定義上ラリー1本
      // （サーブのみ）なので、ここが常に0のまま＝BASE_VOL/BASE_DURより育たない。
      const excitement = clamp((Math.max(1, rallyShots || 1) - 1) / (C.EXCITEMENT_SHOTS - 1), 0, 1);
      const sideVol = C.WINNER_VOL_MULT[winner] === undefined ? 1 : C.WINNER_VOL_MULT[winner];
      const sideHz = C.WINNER_FILTER_MULT[winner] === undefined ? 1 : C.WINNER_FILTER_MULT[winner];
      const dur = jDur(lerp(C.BASE_DUR, C.MAX_DUR, excitement));
      const vol = jVol(lerp(C.BASE_VOL, C.MAX_VOL, excitement)
        * (C.OUTCOME_VOL_MULT[outcome] || 1) * sideVol);
      const freq = lerp(C.FILTER_BASE_HZ, C.FILTER_EXCITED_HZ, excitement) * sideHz;

      const buffer = noiseBuffer(ac);
      const src = ac.createBufferSource();
      src.buffer = buffer;
      const filter = ac.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq;
      filter.Q.value = 0.7;
      const t0 = ac.currentTime;
      // クリック音を避け、立ち上がり(ATTACK)を経てから山なりに収める。
      src.connect(filter).connect(envelope(ac, vol, dur, C.ATTACK)).connect(ac.destination);
      src.start(t0, Math.random() * Math.max(0, buffer.duration - dur));
      src.stop(t0 + dur);

      // 拍手。粒ごとに開始時刻をずらすことで、揃った1発ではなくパチパチとばらける。
      const P = C.CLAP;
      const claps = Math.round(lerp(P.MIN, P.MAX, excitement)
        * (C.OUTCOME_VOL_MULT[outcome] || 1) * sideVol);
      for (let i = 0; i < claps; i++) {
        noiseVoice(ac, {
          type: 'highpass',
          vol: P.VOL,
          hz: P.HZ,
          q: 0.7,
          dur: P.DUR,
          at: P.DELAY + Math.random() * P.WINDOW,
        });
      }
    } catch (e) {
      /* 音が出ないだけなのでゲームは続行 */
    }
  }

  /**
   * 打ち方とスピンから打撃音の配合（AUDIO.IMPACT.STROKE の1つ）を選ぶ。
   * スマッシュとボレーは打ち方そのものが音を決める（スピンは掛けない打ち方なので無視）。
   * グラウンドストロークだけスピンで分かれる。
   * @param {'forehand'|'backhand'|'smash'|'volley-forehand'|'volley-backhand'} stroke
   * @param {'flat'|'top'|'slice'|'drop'} spin
   */
  function strokeVoice(stroke, spin) {
    const S = AUDIO.IMPACT.STROKE;
    if (stroke === 'smash') return S.smash;
    if (stroke.includes('volley')) return S.volley; // 'volley-forehand'/'volley-backhand' の両方
    return S[spin] || S.flat;
  }

  const sfx = {
    /**
     * サーブ。フラット／スピン（キック）／スライスで音色そのものを変え、
     * 溜めた（＝速い）サーブほど高く・大きく・余韻を長く鳴らす。
     * @param {number} charge 溜め量 0〜1
     * @param {'flat'|'top'|'slice'} spin
     */
    serve: (charge = 0, spin = 'flat') => {
      const I = AUDIO.IMPACT;
      const voice = spin === 'top' ? I.STROKE.serveTop
        : spin === 'slice' ? I.STROKE.serveSlice
          : I.STROKE.serve;
      layered(voice, {
        pitch: 1 + charge * I.CHARGE_PITCH,
        gain: 1 + charge * I.CHARGE_GAIN,
        dur: 1 + charge * I.CHARGE_DUR,
      });
    },
    /**
     * ラリー中の打球音。打ち方×スピンで音色を選び、そこに
     * 「どちらのチームが打ったか（TEAM_PITCH）」「バックかどうか」「溜め量」で音程・音量を振る。
     * @param {'you'|'cpu'} who 打ったチーム
     * @param {string} stroke forehand / backhand / smash / volley-*
     * @param {number} charge 溜め量 0〜1（AIは常に0）
     * @param {'flat'|'top'|'slice'|'drop'} spin
     */
    hit: (who, stroke, charge = 0, spin = 'flat') => {
      const I = AUDIO.IMPACT;
      const backhand = stroke.includes('backhand'); // 'backhand' と 'volley-backhand' の両方を拾う
      const pitch = (I.TEAM_PITCH[who] || 1)
        * (backhand ? I.BACKHAND_PITCH_MULT : 1)
        * (1 + charge * I.CHARGE_PITCH);
      layered(strokeVoice(stroke, spin), {
        pitch,
        gain: 1 + charge * I.CHARGE_GAIN,
        dur: 1 + charge * I.CHARGE_DUR,
      });
    },
    /**
     * バウンド音。地面の鳴り方はサーフェス（SURFACE.NAME）で、弾み方はスピンで変え、
     * 着地時の速度で音量をスケールさせる（緩い球は小さく、速い球は大きく）。
     * スライス／ドロップだけは滑る擦過音（SKID）を足す。
     * @param {'flat'|'top'|'slice'|'drop'} spin
     * @param {number} speed 着地直前の速さ(m/s)
     */
    bounce: (spin = 'flat', speed = 0) => {
      const B = AUDIO.BOUNCE;
      const ground = B.SURFACE[SURFACE.NAME] || B.SURFACE.hard;
      const m = B.SPIN[spin] || B.SPIN.flat;
      const speedMult = clamp(speed / B.SPEED_REF, B.SPEED_MIN_MULT, B.SPEED_MAX_MULT);
      layered(ground, { pitch: m.HZ, gain: m.VOL * speedMult, dur: m.DUR });
      if (m.SKID_VOL) {
        const ac = context();
        if (!ac) return;
        try {
          noiseVoice(ac, {
            type: 'highpass',
            vol: m.SKID_VOL * speedMult,
            hz: B.SKID_HZ,
            q: 0.7,
            dur: B.SKID_DUR,
          });
        } catch (e) {
          /* 音が出ないだけなのでゲームは続行 */
        }
      }
    },
    /** ネットコードに当たる鈍い音（低く長め＝テープ/ガットの damped な振動）。 */
    netIn: () => layered(AUDIO.NET_IN),
    /**
     * ポイントが決まった瞬間。以前はここで「ポン」という電子音を鳴らして音程で
     * どちらが取ったかを示していたが、他の音を実際の打球音に寄せた結果それだけが
     * 浮いて聞こえるようになったため廃止した（config.js の CROWD.WINNER_VOL_MULT
     * のコメント参照）。今は歓声と拍手の大きさ・明るさだけで勝敗が分かる。
     */
    point: (winner, outcome, rallyShots) => crowd(rallyShots, outcome, winner),
  };

  RallyOne.audio = { unlock, sfx };
})(window.RallyOne = window.RallyOne || {});
