/** テニスのスコア計算。DOM も three.js も見ない純粋なロジック。 */
(function (RallyOne) {
  'use strict';

  const { RULES } = RallyOne.config;

  const POINT_LABELS = ['0', '15', '30', '40'];

  /**
   * 表示用のポイント表記。
   * @param {number} mine 自分の得点数
   * @param {number} theirs 相手の得点数
   */
  function pointLabel(mine, theirs) {
    if (mine >= 3 && theirs >= 3) {
      if (mine === theirs) return '40';   // デュース
      return mine > theirs ? 'Ad' : '40'; // アドバンテージを取られている側は 40
    }
    return POINT_LABELS[Math.min(mine, 3)];
  }

  /** target 以上かつ MARGIN 差がついたら決着 */
  function won(mine, theirs, target) {
    return mine >= target && mine - theirs >= RULES.MARGIN;
  }

  /** 1セットマッチのスコア。awardPoint() の戻り値で「何が起きたか」を伝える。 */
  class Match {
    constructor() {
      this.reset();
    }

    reset() {
      this.points = { you: 0, cpu: 0 };
      this.games = { you: 0, cpu: 0 };
    }

    /**
     * サーブのサイド（クロス/逆クロス）は、そのゲームの累計ポイント数で決まる。
     * 偶数(0-0, 15-15, ...)は -1＝クロス、奇数は +1＝逆クロス。
     * この符号は game.js の描画（world +x が画面左に映るカメラ配置）に合わせてあるので、
     * 変えるときは game.js 側の見え方も必ず確認すること。
     */
    get serveSide() {
      return (this.points.you + this.points.cpu) % 2 ? 1 : -1;
    }

    /**
     * 1ポイント加算し、ゲーム・セットの成立まで判定する。
     * @param {'you'|'cpu'} winner
     * @returns {{type:'point'|'game'|'set', winner:'you'|'cpu'}}
     */
    awardPoint(winner) {
      const loser = winner === 'you' ? 'cpu' : 'you';
      this.points[winner]++;

      if (!won(this.points[winner], this.points[loser], RULES.GAME_POINTS)) {
        return { type: 'point', winner };
      }

      this.games[winner]++;
      this.points.you = this.points.cpu = 0;

      if (won(this.games[winner], this.games[loser], RULES.SET_GAMES)) {
        return { type: 'set', winner };
      }
      return { type: 'game', winner };
    }
  }

  RallyOne.scoring = { POINT_LABELS, pointLabel, Match };
})(window.RallyOne = window.RallyOne || {});
