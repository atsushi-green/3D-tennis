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
        call: $('call'),
        callBig: $('callBig'),
        callSub: $('callSub'),
        start: $('start'),
        charge: $('charge'),
        chargeFill: $('chargeFill'),
      };
    }

    /**
     * @param {object} match RallyOne.scoring.Match
     * @param {'you'|'cpu'} server
     */
    renderScore(match, server) {
      const { points, games } = match;
      this.el.points.you.textContent = pointLabel(points.you, points.cpu);
      this.el.points.cpu.textContent = pointLabel(points.cpu, points.you);
      this.el.games.you.textContent = games.you;
      this.el.games.cpu.textContent = games.cpu;
      this.el.names.you.className = 'nm' + (server === 'you' ? ' srv' : '');
      this.el.names.cpu.className = 'nm' + (server === 'cpu' ? ' srv' : '');
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
