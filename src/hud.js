/** スコアボード・コール表示・スタート画面。DOM に触るのはこのファイルだけ。 */
(function (RallyOne) {
  'use strict';

  const { pointLabel } = RallyOne.scoring;
  const $ = (id) => document.getElementById(id);

  class Hud {
    constructor() {
      this.el = {
        names: { you: $('n1'), cpu: $('n2') },
        games: { you: $('g1'), cpu: $('g2') },
        points: { you: $('p1'), cpu: $('p2') },
        aces: { you: $('ace1'), cpu: $('ace2') },
        doubleFaults: { you: $('df1'), cpu: $('df2') },
        call: $('call'),
        callBig: $('callBig'),
        callSub: $('callSub'),
        start: $('start'),
        charge: $('charge'),
        chargeFill: $('chargeFill'),
        diffOpts: [$('diffEasy'), $('diffNormal'), $('diffHard')],
      };
    }

    /** スタート画面のCPUの強さ表示を切り替える（実際の適用は config.applyCpuLevel が行う）。 */
    setDifficulty(level) {
      this.el.diffOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === level));
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

    showCall(big, sub) {
      this.el.callBig.textContent = big;
      this.el.callSub.textContent = sub || '';
      this.el.call.classList.add('on');
    }

    hideCall() {
      this.el.call.classList.remove('on');
    }

    hideStartScreen() {
      this.el.start.style.display = 'none';
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
