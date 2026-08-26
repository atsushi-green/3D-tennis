/** スコアボード・コール表示・スタート画面。DOM に触るのはこのファイルだけ。 */
(function (RallyOne) {
  'use strict';

  const { pointLabel } = RallyOne.scoring;
  const { WIND } = RallyOne.config;
  const $ = (id) => document.getElementById(id);

  class Hud {
    constructor() {
      this.el = {
        names: { you: $('n1'), cpu: $('n2') },
        games: { you: $('g1'), cpu: $('g2') },
        points: { you: $('p1'), cpu: $('p2') },
        aces: { you: $('ace1'), cpu: $('ace2') },
        doubleFaults: { you: $('df1'), cpu: $('df2') },
        wind: $('wind'),
        serveSpeed: $('serveSpeed'),
        call: $('call'),
        callBig: $('callBig'),
        callSub: $('callSub'),
        callShot: $('callShot'),
        start: $('start'),
        charge: $('charge'),
        chargeFill: $('chargeFill'),
        smashTip: $('smashTip'),
        diffOpts: [$('diffEasy'), $('diffNormal'), $('diffHard')],
        surfaceOpts: [$('surfHard'), $('surfClay'), $('surfGrass')],
      };
    }

    /** スタート画面のCPUの強さ表示を切り替える（実際の適用は config.applyCpuLevel が行う）。 */
    setDifficulty(level) {
      this.el.diffOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === level));
    }

    /** スタート画面のサーフェス表示を切り替える（実際の適用は config.applySurface が行う）。 */
    setSurface(level) {
      this.el.surfaceOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === level));
    }

    /**
     * 風向き・強さの表示（ポイントごとに Game#newPoint() から呼ばれる）。
     * @param {number} accel 横方向の加速度(m/s²)。world +x はカメラの都合で画面の左に映るので、
     *   正の値（+x方向）は左向きの矢印にする。
     */
    setWind(accel) {
      const abs = Math.abs(accel);
      if (abs < WIND.DISPLAY_THRESHOLD) {
        this.el.wind.textContent = '無風';
        return;
      }
      const arrow = accel > 0 ? '←' : '→';
      this.el.wind.textContent = `風 ${arrow} ${abs.toFixed(1)}`;
    }

    /**
     * サーブの初速表示（次のポイントが始まるまで残る）。
     * @param {number|null} kmh null なら非表示（次のポイントが始まった直後）。
     */
    setServeSpeed(kmh) {
      this.el.serveSpeed.textContent = kmh == null ? '' : `サーブ ${Math.round(kmh)}km/h`;
    }

    /**
     * @param {object} match RallyOne.scoring.Match
     * @param {'you'|'cpu'} server
     * @param {{you:{aces:number,doubleFaults:number}, cpu:{aces:number,doubleFaults:number}}} stats RallyOne.Game#stats
     */
    renderScore(match, server, stats) {
      const {
        points, games, tiebreak, tiebreakPoints,
      } = match;
      if (tiebreak) {
        // タイブレーク中は 0/15/30/40 ではなく素点（1点刻み）で表示する
        this.el.points.you.textContent = tiebreakPoints.you;
        this.el.points.cpu.textContent = tiebreakPoints.cpu;
      } else {
        this.el.points.you.textContent = pointLabel(points.you, points.cpu);
        this.el.points.cpu.textContent = pointLabel(points.cpu, points.you);
      }
      this.el.games.you.textContent = games.you;
      this.el.games.cpu.textContent = games.cpu;
      this.el.names.you.className = 'nm' + (server === 'you' ? ' srv' : '');
      this.el.names.cpu.className = 'nm' + (server === 'cpu' ? ' srv' : '');
      this.el.aces.you.textContent = stats.you.aces;
      this.el.aces.cpu.textContent = stats.cpu.aces;
      this.el.doubleFaults.you.textContent = stats.you.doubleFaults;
      this.el.doubleFaults.cpu.textContent = stats.cpu.doubleFaults;
    }

    /**
     * @param {string} big 大きい方の文字（'ポイント'・'失点'・コール）
     * @param {string} [sub] 補足（'ウィナー！'・'ゲーム — YOU' など）
     * @param {string} [shot] 決めた側が最後に放った球種（'スマッシュ' など）。
     *   無いポイント（ダブルフォルト直後など）は空にして行ごと隠す。
     */
    showCall(big, sub, shot) {
      this.el.callBig.textContent = big;
      this.el.callSub.textContent = sub || '';
      this.el.callShot.textContent = shot || '';
      this.el.callShot.classList.toggle('on', !!shot);
      this.el.call.classList.add('on');
    }

    hideCall() {
      this.el.call.classList.remove('on');
    }

    hideStartScreen() {
      this.el.start.style.display = 'none';
    }

    /**
     * スマッシュの先回りヒントの文言（コート上のマーカーと対で出す）。マーカーは
     * 「どこへ」を示すが、スマッシュにもう一つ要る「止まって溜める」までは伝わらないので、
     * 状態に応じてそこを言葉で補う。
     * @param {{ready:boolean, inTime:boolean}|null} hint RallyOne.Game#smashHint。null なら非表示。
     */
    setSmashTip(hint) {
      const el = this.el.smashTip;
      el.classList.toggle('on', !!hint);
      if (!hint) return;
      el.classList.toggle('ready', hint.ready);
      el.classList.toggle('late', !hint.ready && !hint.inTime);
      el.textContent = hint.ready
        ? '⚡ スマッシュ！ 止まって溜め、印の高さで離す'
        : hint.inTime ? '⚡ スマッシュのチャンス — 印まで先回り' : '⚡ スマッシュ — 急げば届く！';
    }

    /** @param {number} fraction 溜め量 0〜1。0以下なら非表示。 */
    setCharge(fraction) {
      const on = fraction > 0;
      this.el.charge.classList.toggle('on', on);
      if (!on) return;
      this.el.chargeFill.style.width = `${Math.min(fraction, 1) * 100}%`;
      this.el.chargeFill.classList.toggle('full', fraction >= 1);
    }
  }

  RallyOne.Hud = Hud;
})(window.RallyOne = window.RallyOne || {});
