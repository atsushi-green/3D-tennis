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

  /**
   * 試合のスコア（RULES.SETS_TO_WIN セット先取。既定は1セットマッチ）。awardPoint() の戻り値で
   * 「何が起きたか」を伝える。セットが決まっても games は最終スコアのまま残し（締めのカット・
   * チェンジエンズの判定が読む）、次のセットへ進めるのは呼び出し側の nextSet()。
   */
  class Match {
    constructor() {
      this.reset();
    }

    reset() {
      this.points = { you: 0, cpu: 0 };
      this.games = { you: 0, cpu: 0 };
      this.tiebreak = false;
      this.tiebreakPoints = { you: 0, cpu: 0 };
      this.sets = { you: 0, cpu: 0 };
      /** 決まったセットのゲーム数（古い順。例 [{you:6, cpu:4}, {you:3, cpu:6}]） */
      this.setScores = [];
    }

    /** 試合を続けて次のセットへ（ゲーム数を 0-0 に戻す。取ったセット数は残す）。 */
    nextSet() {
      this.points = { you: 0, cpu: 0 };
      this.games = { you: 0, cpu: 0 };
      this.tiebreak = false;
      this.tiebreakPoints = { you: 0, cpu: 0 };
    }

    /** winner がセットを取った。試合まで決まったかを返す。 */
    winSet(winner) {
      this.sets[winner]++;
      this.setScores.push({ you: this.games.you, cpu: this.games.cpu });
      return this.sets[winner] >= RULES.SETS_TO_WIN;
    }

    /**
     * サーブのサイド（クロス/逆クロス）は、そのゲーム（タイブレーク中はタイブレーク）の
     * 累計ポイント数で決まる。偶数(0-0, 15-15, ...)は -1＝クロス、奇数は +1＝逆クロス。
     * この符号は game.js の描画（world +x が画面左に映るカメラ配置）に合わせてあるので、
     * 変えるときは game.js 側の見え方も必ず確認すること。
     */
    get serveSide() {
      const total = this.tiebreak
        ? this.tiebreakPoints.you + this.tiebreakPoints.cpu
        : this.points.you + this.points.cpu;
      return total % 2 ? 1 : -1;
    }

    /**
     * 1ポイント加算し、ゲーム・セットの成立まで判定する。6-6でゲーム数が並んだら、
     * 以降は通常のゲームの代わりにタイブレーク（7点先取・2点差、RULES.MARGIN共用）を行い、
     * 取った方がそのままセットを取る。
     * @param {'you'|'cpu'} winner
     * @returns {{type:'point'|'game'|'set', winner:'you'|'cpu', tiebreak?:boolean, matchOver?:boolean}}
     *   tiebreak:true は「このポイントがタイブレーク中だった」（type:'point'）か
     *   「このゲームでタイブレークに入った」（type:'game'）ことを示す。
     *   matchOver は type:'set' のときだけ：そのセットで試合まで決まったか（1セットマッチなら必ず true）。
     */
    awardPoint(winner) {
      const loser = winner === 'you' ? 'cpu' : 'you';

      if (this.tiebreak) {
        this.tiebreakPoints[winner]++;
        if (!won(this.tiebreakPoints[winner], this.tiebreakPoints[loser], RULES.TIEBREAK_POINTS)) {
          return { type: 'point', winner, tiebreak: true };
        }
        this.games[winner]++;
        this.tiebreak = false;
        this.points.you = this.points.cpu = 0;
        this.tiebreakPoints.you = this.tiebreakPoints.cpu = 0;
        return { type: 'set', winner, matchOver: this.winSet(winner) }; // タイブレークを取った側が必ずセットも取る
      }

      this.points[winner]++;

      if (!won(this.points[winner], this.points[loser], RULES.GAME_POINTS)) {
        return { type: 'point', winner };
      }

      this.games[winner]++;
      this.points.you = this.points.cpu = 0;

      if (this.games.you === RULES.SET_GAMES && this.games.cpu === RULES.SET_GAMES) {
        this.tiebreak = true;
        return { type: 'game', winner, tiebreak: true };
      }
      if (won(this.games[winner], this.games[loser], RULES.SET_GAMES)) {
        return { type: 'set', winner, matchOver: this.winSet(winner) };
      }
      return { type: 'game', winner };
    }

    /**
     * awardPoint(winner) が「何を返すか」だけを、スコアを進めずに覗く。
     * 次の1点に何がかかっているか（pointStakes）を、ルールを書き写さずに求めるための足場。
     * 実際に awardPoint() を通して結果だけ持ち帰り、触った状態は元に戻す＝デュース・
     * アドバンテージ・6-6のタイブレーク入り・タイブレークの2点差、といった条件が
     * 将来変わっても、判定がここだけ取り残されることがない。
     * @param {'you'|'cpu'} winner
     * @returns {{type:'point'|'game'|'set', winner:'you'|'cpu', tiebreak?:boolean}}
     */
    peek(winner) {
      const before = {
        points: { ...this.points },
        games: { ...this.games },
        tiebreak: this.tiebreak,
        tiebreakPoints: { ...this.tiebreakPoints },
        sets: { ...this.sets },
        setScores: this.setScores.slice(),
      };
      const result = this.awardPoint(winner);
      Object.assign(this, before);
      return result;
    }
  }

  /**
   * kind → 画面に出す呼び名。1セットマッチなので、セットが決まる1点はそのまま試合が
   * 決まる1点＝「マッチポイント」（kind も 'match'）。
   */
  const STAKE_LABELS = {
    match: 'マッチポイント',
    set: 'セットポイント',
    break: 'ブレークポイント',
    game: 'ゲームポイント',
  };

  /**
   * 次の1点に何がかかっているか（かかっていなければ null）。
   *
   * 1点でゲームが決まるのは多くても片側だけ（40-40 では両者とも決まらない）なので、
   * 両方を peek() して先に見つかった方を返せばよい。セット（＝試合）まで決まるなら
   * 「マッチポイント」が最大の見出しで、そうでなければサーバー側なら「ゲームポイント」、
   * レシーブ側なら「ブレークポイント」。
   *
   * breakPoint はスタッツ用の別の旗で、見出しが「マッチポイント」でも、それが
   * レシーブ側の1点ならブレークのチャンスとして数える（実際のテニスのスタッツと同じ）。
   * タイブレーク中は数えない（サーブが2本ごとに回るので「ブレーク」の意味が変わるため）。
   *
   * @param {Match} match
   * @param {'you'|'cpu'} server いまサーブしている側
   * @returns {{team:'you'|'cpu', kind:'match'|'break'|'game', label:string,
   *   breakPoint:boolean}|null}
   */
  function pointStakes(match, server) {
    const receiver = server === 'you' ? 'cpu' : 'you';
    for (const team of [server, receiver]) {
      const result = match.peek(team);
      if (result.type === 'point') continue;
      const kind = result.type === 'set' ? (result.matchOver ? 'match' : 'set')
        : (team === server ? 'game' : 'break');
      return {
        team,
        kind,
        label: STAKE_LABELS[kind],
        breakPoint: team !== server && !match.tiebreak,
      };
    }
    return null;
  }

  /**
   * いま決まった1点（match.awardPoint() の戻り値と、それを反映した後の match）を受けて、
   * 選手がコートを入れ替わる（チェンジエンズ）かどうかと、そのときの休憩の種類を返す。
   * ITF ルール10・29 のとおり：
   * - 各セットの奇数ゲーム（第1・3・5…）が終わったら入れ替わる。セットの最後のゲームも
   *   同じ数え方で、そのセットのゲーム数が奇数なら入れ替わり、偶数なら次のセットの
   *   第1ゲームの後になる（＝次のセットも「奇数ゲームの後」のまま）。
   * - タイブレークは1ゲームと数える（6-6＋タイブレーク＝13ゲーム＝終わったら入れ替わる）。
   *   タイブレークの中では RULES.TIEBREAK_CHANGE_EVERY（6）ポイントごとに入れ替わる。
   * - 休憩は90秒（rest）。ただし各セットの第1ゲームの後（firstGame）とタイブレーク中
   *   （tiebreak）は休憩なしですぐ入れ替わる。セットの終わりはセット間の休憩（setBreak）。
   * セットが終わったときの match はまだ reset() 前（最終スコアのまま）であること。
   * @param {{type:'point'|'game'|'set', tiebreak?:boolean}} result
   * @param {Match} match
   * @returns {'firstGame'|'tiebreak'|'rest'|'setBreak'|null} null なら入れ替わらない
   */
  function changeoverAfter(result, match) {
    if (result.type === 'point') {
      if (!result.tiebreak) return null;
      const played = match.tiebreakPoints.you + match.tiebreakPoints.cpu;
      return played % RULES.TIEBREAK_CHANGE_EVERY === 0 ? 'tiebreak' : null;
    }
    const played = match.games.you + match.games.cpu;
    if (played % 2 === 0) return null;
    if (result.type === 'set') return 'setBreak';
    return played === 1 ? 'firstGame' : 'rest';
  }

  RallyOne.scoring = {
    POINT_LABELS, pointLabel, Match, pointStakes, STAKE_LABELS, changeoverAfter,
  };
})(window.RallyOne = window.RallyOne || {});
