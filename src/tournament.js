/**
 * トーナメントモードの組み合わせと勝ち上がり（純ロジック。three.js にも DOM にも触らない）。
 * 1試合ぶんの中身は Game が受け持ち、ここは「誰と当たるか」と「自分以外の対戦の結果」だけを持つ。
 */
(function (RallyOne) {
  'use strict';

  const {
    TOURNAMENT, CHARACTERS, SKILLS, RULES,
  } = RallyOne.config;

  /** 選手の強さ（ネット志向を除く9項目の合計）。カスタムの自分は使わない（自分の試合は実際に戦う）。 */
  const strengthOf = (key) => {
    const character = CHARACTERS.find((c) => c.key === key);
    return SKILLS.filter((s) => !s.aiOnly).reduce((sum, s) => sum + character.ratings[s.key], 0);
  };

  /** a が b に勝つ確率（TOURNAMENT.SIM_SCALE 参照） */
  function winChance(aKey, bKey) {
    return 1 / (1 + Math.exp(-(strengthOf(aKey) - strengthOf(bKey)) / TOURNAMENT.SIM_SCALE));
  }

  /** 配列を並べ替えた新しい配列（Fisher–Yates） */
  function shuffled(list, rng) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /**
   * 勝った側から見た1セットのゲーム数（scoring.js と同じ決まり方：SET_GAMES 先取・2ゲーム差、
   * SET_GAMES-all ならタイブレークで1ゲーム差）。3ゲーム先取なら 3-0／3-1／4-2／4-3 のどれか。
   */
  function setScore(rng) {
    const g = RULES.SET_GAMES;
    const options = [];
    for (let lost = 0; lost <= g - RULES.MARGIN; lost++) options.push([g, lost]);
    options.push([g + 1, g - 1], [g + 1, g]);
    return options[Math.floor(rng() * options.length)];
  }

  /**
   * 1試合ぶんの各セットのゲーム数（古い順。a・b はその試合の組み合わせの a 側・b 側）。
   * 勝った側が SETS_TO_WIN セット取り、最後のセットは必ず勝った側が取る。
   */
  function matchScore(aWins, rng) {
    const lostSets = Math.floor(rng() * RULES.SETS_TO_WIN);
    const order = shuffled(
      Array(RULES.SETS_TO_WIN - 1).fill(true).concat(Array(lostSets).fill(false)), rng,
    ).concat([true]);
    return order.map((winnerTook) => {
      const [w, l] = setScore(rng);
      const aTook = winnerTook === aWins;
      return { a: aTook ? w : l, b: aTook ? l : w };
    });
  }

  /**
   * 新しいトーナメント。自分は必ず枠0（いちばん上の山）、第1シード（TOURNAMENT.TOP_SEED）は
   * 最後の枠＝当たるとしたら決勝。残りの選手は無作為に並べる。
   * @param {string} youKey 自分の枠に選んでいる選手（CHARACTERS の key か 'custom'）
   * @param {() => number} [rng]
   */
  function createTournament(youKey, rng = Math.random) {
    const pool = CHARACTERS.map((c) => c.key).filter((k) => k !== youKey);
    const seeded = pool.indexOf(TOURNAMENT.TOP_SEED) !== -1;
    const rest = shuffled(pool.filter((k) => k !== TOURNAMENT.TOP_SEED), rng)
      .slice(0, TOURNAMENT.SIZE - 1 - (seeded ? 1 : 0));
    const keys = [youKey].concat(rest, seeded ? [TOURNAMENT.TOP_SEED] : []);
    const entrants = keys.map((key, i) => ({ key, you: i === 0 }));
    const first = [];
    for (let i = 0; i < entrants.length; i += 2) first.push({ a: i, b: i + 1, winner: null, sets: null });
    return {
      entrants,
      rounds: [first],
      round: 0,
      /** 'playing'＝まだ勝ち残っている／'champion'＝優勝／'eliminated'＝敗退 */
      status: 'playing',
      /** 優勝した選手（entrants の添字）。決まるまで null */
      champion: null,
      rng,
    };
  }

  /** 自分（枠0）の、いまの回戦の試合。勝ち残っていなければ null。 */
  function currentMatch(t) {
    if (t.status !== 'playing') return null;
    return t.rounds[t.round].find((m) => m.a === 0 || m.b === 0) || null;
  }

  /** 次に当たる相手（entrants の1人）。勝ち残っていなければ null。 */
  function opponentOf(t) {
    const m = currentMatch(t);
    return m ? t.entrants[m.a === 0 ? m.b : m.a] : null;
  }

  /** 自分の入っていない試合の結果を、能力値の差で決める。 */
  function simulate(t, m) {
    const aWins = t.rng() < winChance(t.entrants[m.a].key, t.entrants[m.b].key);
    m.winner = aWins ? m.a : m.b;
    m.sets = matchScore(aWins, t.rng);
  }

  /** その回戦が全部決まったら、勝者どうしで次の回戦を組む（決勝なら優勝者を決める）。 */
  function advance(t) {
    const done = t.rounds[t.round];
    if (done.length === 1) {
      t.champion = done[0].winner;
      return false;
    }
    const next = [];
    for (let i = 0; i < done.length; i += 2) {
      next.push({ a: done[i].winner, b: done[i + 1].winner, winner: null, sets: null });
    }
    t.rounds.push(next);
    t.round++;
    return true;
  }

  /**
   * 自分の試合の結果を記録し、同じ回戦の他の試合を決めて次の回戦へ進める。負けたら残りの
   * 回戦もすべて決めて、優勝者まで出しておく（トーナメント表の最後まで見せるため）。
   * @param {object} t createTournament() の結果
   * @param {boolean} youWon
   * @param {{you:number, cpu:number}[]} sets Game#matchSummary() の sets（自分＝you）
   * @returns {'playing'|'champion'|'eliminated'} 記録した後の t.status
   */
  function recordResult(t, youWon, sets) {
    const m = currentMatch(t);
    if (!m) return t.status;
    const youAreA = m.a === 0;
    m.winner = youWon ? 0 : (youAreA ? m.b : m.a);
    m.sets = sets.map((s) => (youAreA ? { a: s.you, b: s.cpu } : { a: s.cpu, b: s.you }));
    t.rounds[t.round].forEach((other) => { if (other.winner == null) simulate(t, other); });
    if (!youWon) {
      t.status = 'eliminated';
      while (advance(t)) t.rounds[t.round].forEach((other) => simulate(t, other));
      return t.status;
    }
    if (!advance(t)) t.status = 'champion';
    return t.status;
  }

  /** 回戦の呼び名（TOURNAMENT.ROUNDS。添字＝何回戦目か） */
  const roundName = (index) => TOURNAMENT.ROUNDS[index] || `${index + 1}回戦`;

  RallyOne.tournament = {
    createTournament, currentMatch, opponentOf, recordResult, roundName, winChance,
  };
})(window.RallyOne = window.RallyOne || {});
