// ゲームロジック層（src/config.js〜game.js）の回帰テスト。
// ブラウザと同じ順番でクラシック script を読み込み、three.js にも DOM にも触れずに検証する。
// 実行: node tests/smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const FILES = ['config.js', 'math.js', 'physics.js', 'scoring.js', 'ai.js', 'game.js'];

const sandbox = { window: {}, Math, console, Object, Set, Array, JSON, performance };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sandbox, { filename: f });
}
const R = sandbox.window.RallyOne;

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.log('  FAIL:', msg); fail++; } };

ok(Object.keys(R).sort().join(',') === 'Game,ai,config,math,physics,scoring',
  `namespace: ${Object.keys(R).sort().join(',')}`);

// --- scoring ---
const { pointLabel, Match } = R.scoring;
ok(pointLabel(0, 0) === '0' && pointLabel(3, 0) === '40', 'basic labels');
ok(pointLabel(3, 3) === '40' && pointLabel(4, 3) === 'Ad' && pointLabel(3, 4) === '40', 'deuce/ad');
{
  const m = new Match();
  for (let i = 0; i < 3; i++) ok(m.awardPoint('you').type === 'point', 'point');
  ok(m.awardPoint('you').type === 'game', 'game at 4');
  for (let g = 0; g < 4; g++) for (let p = 0; p < 4; p++) m.awardPoint('you');
  for (let p = 0; p < 3; p++) m.awardPoint('you');
  ok(m.awardPoint('you').type === 'set', 'set at 6');
}

// --- タイブレーク：6-6でゲーム数が並んだら、通常ゲームの代わりにタイブレークに入る ---
{
  const m = new Match();
  for (let g = 0; g < 5; g++) for (let p = 0; p < 4; p++) m.awardPoint('you'); // you 5ゲーム
  for (let g = 0; g < 5; g++) for (let p = 0; p < 4; p++) m.awardPoint('cpu'); // cpu 5ゲーム
  ok(m.games.you === 5 && m.games.cpu === 5, `precondition: 5-5, got ${m.games.you}-${m.games.cpu}`);

  let r;
  for (let p = 0; p < 4; p++) r = m.awardPoint('you'); // 6-5
  ok(r.type === 'game' && !r.tiebreak, `6-5 is a normal game (no tiebreak yet), got type=${r.type} tiebreak=${r.tiebreak}`);
  ok(!m.tiebreak, 'not in tiebreak at 6-5');

  for (let p = 0; p < 4; p++) r = m.awardPoint('cpu'); // 6-6
  ok(r.type === 'game' && r.tiebreak === true, `6-6 enters a tiebreak, got type=${r.type} tiebreak=${r.tiebreak}`);
  ok(m.tiebreak === true && m.games.you === 6 && m.games.cpu === 6,
    `match is in a tiebreak at 6-6, got tiebreak=${m.tiebreak} games=${m.games.you}-${m.games.cpu}`);

  for (let i = 0; i < 3; i++) {
    r = m.awardPoint('you');
    ok(r.type === 'point' && r.tiebreak === true, `tiebreak point ${i + 1}: type=${r.type} tiebreak=${r.tiebreak}`);
  }
  ok(m.tiebreakPoints.you === 3 && m.tiebreakPoints.cpu === 0,
    `tiebreak points are 3-0, got ${m.tiebreakPoints.you}-${m.tiebreakPoints.cpu}`);

  for (let i = 0; i < 3; i++) r = m.awardPoint('you'); // 6-0
  ok(r.type === 'point', `6 tiebreak points isn't enough yet (needs 7 and a 2-point margin), got type=${r.type}`);
  r = m.awardPoint('you'); // 7-0
  ok(r.type === 'set' && r.winner === 'you', `winning the tiebreak 7-0 awards the set, got type=${r.type} winner=${r.winner}`);
  ok(m.games.you === 7 && m.games.cpu === 6, `tiebreak win makes the score 7-6, got ${m.games.you}-${m.games.cpu}`);
  ok(m.tiebreak === false, 'tiebreak flag clears once the set is decided');
  ok(m.tiebreakPoints.you === 0 && m.tiebreakPoints.cpu === 0, 'tiebreak points reset after the set');
}

// --- タイブレーク：6点先取では終わらず、2点差がつくまで続く ---
{
  const m = new Match();
  m.games = { you: 6, cpu: 6 };
  m.tiebreak = true;
  // 1点ずつ交互に与えて 7-7 まで積む（先に片方だけ7点与えると2点差で decisive になってしまうため）
  for (let i = 0; i < 7; i++) { m.awardPoint('you'); m.awardPoint('cpu'); } // 7-7
  ok(m.tiebreak === true, 'still in the tiebreak at 7-7 (no 2-point margin yet)');
  let r = m.awardPoint('you'); // 8-7
  ok(r.type === 'point' && m.tiebreak === true, `8-7 isn't enough (needs a 2-point margin), got type=${r.type}`);
  r = m.awardPoint('you'); // 9-7
  ok(r.type === 'set' && r.winner === 'you', `9-7 (2-point margin) wins the tiebreak and the set, got type=${r.type}`);
}

// --- タイブレーク中はサーブサイド（クロス/逆クロス）がタイブレークの合計ポイント数で交互になる ---
{
  const m = new Match();
  m.games = { you: 6, cpu: 6 };
  m.tiebreak = true;
  ok(m.serveSide === -1, `tiebreak starts on the cross side, got ${m.serveSide}`);
  m.awardPoint('you');
  ok(m.serveSide === 1, `after 1 tiebreak point, the serve side flips, got ${m.serveSide}`);
  m.awardPoint('cpu');
  ok(m.serveSide === -1, `after 2 tiebreak points, the serve side flips back, got ${m.serveSide}`);
}

// --- ブレークポイント／ゲームポイント／マッチポイントの判定（scoring.pointStakes） ---
{
  const { pointStakes } = R.scoring;
  /** 判定結果を「呼び名(取れば決まる側) bp=ブレークのチャンスか」の1行に畳む */
  const at = (setup, server) => {
    const m = new Match();
    Object.assign(m, setup);
    const s = pointStakes(m, server);
    return s ? `${s.label}(${s.team}) bp=${s.breakPoint}` : 'なし';
  };
  const g = (you, cpu) => ({ games: { you, cpu } });

  ok(at({ points: { you: 3, cpu: 0 } }, 'you') === 'ゲームポイント(you) bp=false',
    `40-0 on serve is a game point, got ${at({ points: { you: 3, cpu: 0 } }, 'you')}`);
  ok(at({ points: { you: 0, cpu: 3 } }, 'you') === 'ブレークポイント(cpu) bp=true',
    `0-40 on serve is a break point for the receiver, got ${at({ points: { you: 0, cpu: 3 } }, 'you')}`);
  ok(at({ points: { you: 3, cpu: 3 } }, 'you') === 'なし', 'deuce has nothing riding on it');
  ok(at({ points: { you: 4, cpu: 3 } }, 'you') === 'ゲームポイント(you) bp=false', 'advantage on serve is a game point');
  ok(at({ points: { you: 3, cpu: 4 } }, 'you') === 'ブレークポイント(cpu) bp=true', 'advantage against serve is a break point');
  ok(at({ points: { you: 2, cpu: 0 } }, 'you') === 'なし', '30-0 is not a game point yet');

  // 1セットマッチなので、セット（＝試合）まで決まる1点は「マッチポイント」が見出しになる
  // （以前は「セットポイント」と出ていた）
  ok(at({ ...g(5, 0), points: { you: 3, cpu: 0 } }, 'you') === 'マッチポイント(you) bp=false',
    '5-0 40-0 on serve is a match point');
  ok(at({ ...g(0, 5), points: { you: 0, cpu: 3 } }, 'you') === 'マッチポイント(cpu) bp=true',
    'a match point won by the receiver is still counted as a break chance');
  // 5-6 で1ゲーム取っても 6-6＝タイブレークに入るだけ（セットは決まらない）
  ok(at({ ...g(5, 6), points: { you: 3, cpu: 0 } }, 'you') === 'ゲームポイント(you) bp=false',
    `5-6 40-0 only reaches 6-6 (a tiebreak), so it is not a match point yet, got ${at({ ...g(5, 6), points: { you: 3, cpu: 0 } }, 'you')}`);
  ok(at({ ...g(6, 5), points: { you: 3, cpu: 0 } }, 'you') === 'マッチポイント(you) bp=false',
    '6-5 40-0 on serve is a match point (7-5 takes the set and the match)');

  // タイブレーク：取ればセット（＝試合）なので常にマッチポイント。ブレークとしては数えない
  const tb = { games: { you: 6, cpu: 6 }, tiebreak: true };
  ok(at({ ...tb, tiebreakPoints: { you: 6, cpu: 3 } }, 'cpu') === 'マッチポイント(you) bp=false',
    'a tiebreak point to close it out is a match point, and never a break point');
  ok(at({ ...tb, tiebreakPoints: { you: 5, cpu: 5 } }, 'you') === 'なし', '5-5 in a tiebreak has nothing riding on it');
  ok(at({ ...tb, tiebreakPoints: { you: 6, cpu: 6 } }, 'you') === 'なし', '6-6 in a tiebreak needs a 2-point margin');

  // peek() はスコアを一切進めない
  {
    const m = new Match();
    m.points = { you: 3, cpu: 0 };
    const snapshot = JSON.stringify([m.points, m.games, m.tiebreak, m.tiebreakPoints]);
    ok(m.peek('you').type === 'game', 'peek reports what awardPoint would return');
    ok(JSON.stringify([m.points, m.games, m.tiebreak, m.tiebreakPoints]) === snapshot,
      'and peek leaves the score exactly as it was');
    ok(m.awardPoint('you').type === 'game', 'awardPoint still works afterwards');
    ok(m.games.you === 1, 'and it is the one that actually moves the score');
  }
}

const {
  HALF_W, HALF_L, COURT, PLAYER, SERVE, BOUNDS,
} = R.config;
const fakeInput = { moveX: 0, moveZ: 0, lob: false };
const noHooks = {
  sound() {}, call() {}, clearCall() {}, score() {}, wind() {}, serveSpeed() {}, matchEnd() {},
};

// --- Game: 1点ごとに stakes が立ち、ブレークポイントがスタッツに乗る ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(false, 'you'); // 人間のサーブから
  ok(g.stakes === null, '0-0 has nothing riding on it');

  // 0-40 まで CPU に取らせる＝ブレークポイント
  g.match.points = { you: 0, cpu: 2 };
  g.endPoint('cpu', 'ツーバウンド'); // 0-40 になり、次のポイントの stakes が立つ
  for (let i = 0; i < 60 * 5 && g.phase !== 'serve'; i++) g.update(1 / 60);
  ok(!!g.stakes && g.stakes.kind === 'break' && g.stakes.team === 'cpu',
    `0-40 on the human serve is a break point for the CPU, got ${JSON.stringify(g.stakes)}`);

  // サーバーが凌ぐ＝チャンスは数えるが converted は増えない
  g.endPoint('you', 'ツーバウンド');
  ok(g.stats.cpu.breakPoints === 1 && g.stats.cpu.breaksWon === 0,
    `a saved break point counts as a chance only, got ${g.stats.cpu.breakPoints}/${g.stats.cpu.breaksWon}`);
  ok(g.stakes === null, 'the badge clears the moment the point is decided');

  // 15-40 でもう一度ブレークポイント。今度は決める
  for (let i = 0; i < 60 * 5 && g.phase !== 'serve'; i++) g.update(1 / 60);
  ok(!!g.stakes && g.stakes.kind === 'break', 'precondition: 15-40 is another break point');
  g.endPoint('cpu', 'ツーバウンド');
  ok(g.stats.cpu.breakPoints === 2 && g.stats.cpu.breaksWon === 1,
    `converting it counts both, got ${g.stats.cpu.breakPoints}/${g.stats.cpu.breaksWon}`);
  ok(g.match.games.cpu === 1, 'precondition: the CPU actually broke');
  ok(g.stats.you.breakPoints === 0, 'the serving side is not credited with a break chance');
}

// --- ブレークで取ったゲームはコールでそう言う／かかっていた1点は歓声も変わる ---
{
  const calls = [];
  const sounds = [];
  const hooks = {
    ...noHooks,
    call: (big, sub) => calls.push(`${big}|${sub || ''}`),
    sound: (name, ...args) => sounds.push([name, ...args]),
  };
  const g = new R.Game({ input: fakeInput, hooks });
  g.start(false, 'you');
  g.match.points = { you: 0, cpu: 3 }; // 0-40＝ブレークポイント
  g.beginServe();
  ok(!!g.stakes && g.stakes.breakPoint, 'precondition: a break point is on');
  calls.length = 0;
  sounds.length = 0;
  g.endPoint('cpu', 'ツーバウンド');
  ok(calls.some((c) => c.includes('ブレーク！')), `the game call says it was a break, got ${JSON.stringify(calls)}`);
  const point = sounds.find((sfx) => sfx[0] === 'point');
  ok(!!point && point[4] === 'break',
    `the crowd is told a break point was converted, got ${JSON.stringify(point)}`);

  // 凌いだ側のときは 'saved'
  const g2 = new R.Game({ input: fakeInput, hooks });
  g2.start(false, 'you');
  g2.match.points = { you: 0, cpu: 3 };
  g2.beginServe();
  sounds.length = 0;
  g2.endPoint('you', 'ツーバウンド');
  const saved = sounds.find((sfx) => sfx[0] === 'point');
  ok(!!saved && saved[4] === 'saved', `saving it is told apart, got ${JSON.stringify(saved)}`);

  // 何もかかっていない1点では従来どおり（null＝倍率1）
  const g3 = new R.Game({ input: fakeInput, hooks });
  g3.start(false, 'you');
  sounds.length = 0;
  g3.endPoint('you', 'ツーバウンド');
  const plain = sounds.find((sfx) => sfx[0] === 'point');
  ok(!!plain && plain[4] === null, `an ordinary point passes null, got ${JSON.stringify(plain)}`);
}

// --- 試合で初めてのマッチポイントは、構えに入ったところで演出を挟み、その間は試合が止まる ---
{
  const { MATCH_POINT, TIMING } = R.config;
  const calls = [];
  const sounds = [];
  const hooks = {
    ...noHooks,
    call: (big, sub) => calls.push(`${big}|${sub || ''}`),
    sound: (name, ...args) => sounds.push([name, ...args]),
  };
  /** 決まった1点から、ポイント間を待って次の構えに入るところまで（実際の進行と同じ順）。 */
  const playTo = (g, winner) => {
    g.phase = 'rally';
    g.serveInFlight = false;
    g.endPoint(winner, 'ツーバウンド');
    for (let i = 0; i < 60 * 3 && g.phase === 'over'; i++) g.update(1 / 60);
  };

  // 自分のサーブで 5-0 30-0 → 40-0＝試合で初めてのマッチポイント
  const g = new R.Game({ input: fakeInput, hooks });
  g.start(false, 'you');
  g.match.games = { you: 5, cpu: 0 };
  g.match.points = { you: 2, cpu: 0 };
  ok(!g.matchPointCut, 'precondition: no cut before the match point');
  calls.length = 0;
  sounds.length = 0;
  playTo(g, 'you');
  ok(!!g.stakes && g.stakes.kind === 'match' && g.stakes.label === 'マッチポイント',
    `40-0 at 5-0 is labelled a match point, got ${JSON.stringify(g.stakes)}`);
  ok(!!g.matchPointCut && g.matchPointCut.team === 'you',
    `the first match point starts the cut, got ${JSON.stringify(g.matchPointCut)}`);
  ok(calls[calls.length - 1].startsWith('マッチポイント|'), `and calls it out, got ${calls[calls.length - 1]}`);
  ok(sounds.some((sfx) => sfx[0] === 'matchPoint' && sfx[1] === 'you'), 'and the crowd roars');
  // 演出の間はトスを上げられない（いつもの画面に戻るまで待つ）
  ok(g.chargeStart() === false && !g.tossActive, 'the server cannot toss while the cut plays');
  for (let i = 0; i < 60; i++) g.update(1 / 60);
  ok(!!g.matchPointCut && Math.abs(g.matchPointCut.t - 1) < 1e-6 && g.phase === 'serve',
    `the cut runs on the game clock while the point waits, t=${g.matchPointCut && g.matchPointCut.t}`);
  // DURATION を過ぎたら、いつものサーブの構えへ戻る（案内も出し直す）
  calls.length = 0;
  for (let i = 0; i < 60 * (MATCH_POINT.DURATION + 1) && g.matchPointCut; i++) g.update(1 / 60);
  ok(!g.matchPointCut, 'the cut ends by itself after MATCH_POINT.DURATION');
  ok(calls.some((c) => c.startsWith('サーブ|')), `the serve prompt comes back, got ${JSON.stringify(calls)}`);
  ok(sounds.some((sfx) => sfx[0] === 'matchPointEnd'), 'and the roar is told to settle');
  ok(g.chargeStart() === true && g.tossActive, 'after the cut the server can toss as usual');
  g.chargeRelease();
  untilServed(g);

  // 凌がれて 40-15 になっても、2回目のマッチポイントでは演出を出さない
  playTo(g, 'cpu');
  ok(!!g.stakes && g.stakes.kind === 'match', 'precondition: 40-15 is still a match point');
  ok(!g.matchPointCut, 'the second match point of the same game does not replay the cut');

  // ゲームが替わったら戻す：凌がれてそのゲームを落とし、次のゲームで再びマッチポイントになれば出す
  const g5 = new R.Game({ input: fakeInput, hooks });
  g5.start(false, 'you');
  g5.match.games = { you: 5, cpu: 0 };
  g5.match.points = { you: 3, cpu: 4 }; // 40-AD から CPU が取ってこのゲームは CPU
  g5.matchPointCutDone = true; // このゲームではもう出した扱い
  g5.phase = 'rally';
  g5.serveInFlight = false;
  g5.endPoint('cpu', 'ツーバウンド');
  ok(g5.match.games.cpu === 1, `precondition: the CPU took the game, games=${JSON.stringify(g5.match.games)}`);
  ok(g5.matchPointCutDone === false, 'a new game re-arms the match point cut');
  g5.match.points = { you: 3, cpu: 0 };
  g5.beginServe();
  ok(!!g5.matchPointCut && g5.matchPointCut.team === 'you',
    'the first match point of the next game starts the cut again');

  // CPU のサーブで CPU のマッチポイント：演出の間は CPU もサーブしてこない。Space で切り上げられる
  const g2 = new R.Game({ input: fakeInput, hooks });
  g2.start(false, 'cpu');
  g2.match.games = { you: 0, cpu: 5 };
  g2.match.points = { you: 0, cpu: 2 };
  playTo(g2, 'cpu');
  ok(!!g2.matchPointCut && g2.matchPointCut.team === 'cpu', 'the CPU match point starts the cut too');
  for (let i = 0; i < 60 * (MATCH_POINT.DURATION - 0.5); i++) g2.update(1 / 60);
  ok(!!g2.matchPointCut && !g2.aiTossActive && !g2.ball.live && g2.phase === 'serve',
    'the CPU does not toss while the cut plays (its scheduled serve waits)');
  g2.skipMatchPointCut();
  ok(!g2.matchPointCut, 'Space ends the cut at once');
  let tossed = false;
  for (let i = 0; i < 60 * (TIMING.CPU_SERVE_READY + 0.5) && !tossed; i++) {
    g2.update(1 / 60);
    tossed = g2.aiTossActive;
  }
  ok(tossed, 'and the CPU tosses after its usual pause');

  // セカンドサーブで構え直しても（同じ1点なので）出さない
  const g3 = new R.Game({ input: fakeInput, hooks });
  g3.start(false, 'you');
  g3.match.games = { you: 5, cpu: 0 };
  g3.match.points = { you: 3, cpu: 0 };
  g3.matchPointCutDone = true; // このマッチではもう出した扱い
  g3.beginServe('ネット');
  ok(!g3.matchPointCut, 'a second serve never starts the cut');
  const g4 = new R.Game({ input: fakeInput, hooks });
  g4.start(false, 'you');
  g4.match.games = { you: 5, cpu: 0 };
  g4.match.points = { you: 3, cpu: 0 };
  g4.beginServe('ネット');
  ok(!g4.matchPointCut, 'not even when the match point first shows up on a second serve');
}

/**
 * ボールを「ちょうど (x, z) へ接地する1ステップ」の状態に置いてから bounce() を呼ぶ。
 * bounce() は直前位置（px/py/pz）から本当の接地点を線形補間して求めるので、現在座標だけを
 * 書き換えると、補間の材料が前のポイントの座標のまま残って的外れな着地点になってしまう。
 * @returns {boolean} bounce() の戻り値（このバウンドでポイントが決まったか）
 */
function bounceAt(g, x, z, bounces = 0) {
  const BALL_R = R.config.PHYSICS.BALL_R;
  Object.assign(g.ball, {
    x, z, y: 0, vy: -1, bounces,
    px: x, pz: z, py: BALL_R + 0.01,
  });
  return g.bounce();
}

/** 即座に離す（溜め時間0）タップ。1回の溜めキー押下＋即離しを表す。 */
function tap(g) {
  g.chargeStart();
  g.chargeRelease();
}

/**
 * 振り出したサーブ（Game#swingServe()）が実際に当たるまで、トスの球だけを物理の刻みで
 * 進める。ラケットは打点（SERVE.CONTACT_Y）にしか届かないので、離した瞬間にはまだ
 * 当たらない。当たった瞬間（serve() が serveSwing を消す）で止める＝球は打った直後の状態。
 */
function untilServed(g) {
  for (let i = 0; i < 2000 && g.serveSwing; i++) g.stepBall(R.config.PHYSICS.STEP);
}

/**
 * 溜めキーを押しっぱなしにしてサーブする、を模した実際のフロー。
 * 押下と同時にトス＋テイクバックの溜めが始まり、holdFrames ぶん待ってから離す＝振り出す。
 * トスが打点まで来たところで当たる（untilServed()）。
 * @param {'flat'|'top'|'slice'} [spin] 押したキーに対応するスピン。省略時はフラット。
 */
function tossAndHit(g, holdFrames = 0, spin = 'flat', kick = false) {
  g.chargeStart(spin, kick); // トスとチャージを同時に開始（kick＝キックサーブのキー K）
  for (let f = 0; f < holdFrames; f++) g.update(1 / 60);
  g.chargeRelease(); // 離した瞬間に振り出す
  untilServed(g);
}

// --- serve lands in the service box（Space を押しっぱなしにして離す、を通す） ---
{
  let inBox = 0;
  for (let i = 0; i < 200; i++) {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.started = true;
    g.newPoint();
    tossAndHit(g);
    const L = R.physics.predictLanding(g.ball);
    if (!L.net && Math.abs(L.x) <= HALF_W && L.z > 0 && L.z <= COURT.SERVICE) inBox++;
  }
  // 1本だけ許容する。solveShot() が確かめるネットの余裕は解析的な放物線のもので、実際に
  // 飛ばす積分（半陰的オイラー）は解析解よりわずかに下を通るため、余裕ぎりぎりで解けた
  // 球だけがテープをかすることがある（実測 100,000本中8本＝0.008%。200本なら1.6%の確率で
  // 1本混じる）。詳しくは下の「強いサーブはときどきネットに掛かる」のコメント参照。
  ok(inBox >= 199, `serves in the service box: ${inBox}/200`);
}

// --- サーブの初速をkm/hに換算してHUDへ出す（hooks.serveSpeed） ---
{
  const { mpsToKmh } = R.math;
  ok(Math.abs(mpsToKmh(10) - 36) < 1e-9, 'mpsToKmh: 10m/s -> 36km/h');
  ok(mpsToKmh(0) === 0, 'mpsToKmh: 0m/s -> 0km/h');

  const SWEET_FRAMES = Math.round(SERVE.CHARGE_SWEET_T * 60);
  const serveSpeedsFor = (holdFrames) => {
    const speeds = [];
    const g = new R.Game({
      input: fakeInput,
      hooks: { ...noHooks, serveSpeed: (kmh) => { if (kmh != null) speeds.push(kmh); } },
    });
    g.started = true;
    g.newPoint();
    tossAndHit(g, holdFrames);
    ok(Math.abs(speeds[speeds.length - 1] - mpsToKmh(Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz))) < 1e-9,
      'reported km/h matches the actual initial speed of the served ball');
    return speeds;
  };
  // コース・深さは毎回ランダムなので、狙いのばらつきが溜めの差を上回らないよう
  // 2本とも同じ狙いになるよう乱数を固定する（三角形カーブのテストと同じ手当て）。
  const origRandom = Math.random;
  Math.random = () => 0.5;
  let full;
  let soft;
  try {
    full = serveSpeedsFor(SWEET_FRAMES); // ちょうど良いタイミング＝フルパワーのフラットサーブ
    soft = serveSpeedsFor(0); // 即離し＝タップ＝セカンド相当の緩いサーブ
  } finally {
    Math.random = origRandom;
  }
  ok(full.length === 1, `serveSpeed hook fires exactly once per serve, got ${full.length}`);
  ok(full[0] > soft[0] * 1.3,
    `full-power serve reads clearly faster than a tap serve: full=${full[0].toFixed(0)} soft=${soft[0].toFixed(0)}`);
}

// --- エース（サーブだけで決まった1点）は、中央のコールに球種だけでなく球速も出す ---
{
  const aceCall = (finish) => {
    const shots = [];
    let kmh = null;
    const g = new R.Game({
      input: fakeInput,
      hooks: {
        ...noHooks,
        call: (big, sub, shot) => shots.push(shot),
        serveSpeed: (v) => { if (v != null) kmh = v; },
      },
    });
    g.started = true;
    g.newPoint();
    tossAndHit(g, Math.round(SERVE.CHARGE_SWEET_T * 60));
    finish(g);
    return { shot: shots[shots.length - 1], kmh };
  };

  // 一度も触れられずに2バウンド＝エース。球種名のうしろに整数の km/h が付く。
  const ace = aceCall((g) => g.endPoint('you', 'ツーバウンド'));
  ok(/サービス|キックサーブ/.test(ace.shot), `an ace is credited to the serve, got ${ace.shot}`);
  ok(ace.shot.endsWith(`${Math.round(ace.kmh)}km/h`),
    `and carries the same speed the HUD showed: shot=${ace.shot} serveSpeed=${ace.kmh}`);

  // 返球された後に決まった1点は従来どおり球種だけ（速さはもうその1本のものではない）。
  const rally = aceCall((g) => { g.serveInFlight = false; g.endPoint('you', 'ツーバウンド'); });
  ok(!/km\/h/.test(rally.shot), `a rally winner keeps the plain shot name, got ${rally.shot}`);

  // 相手のミスで取った1点も同じ（エースではない）。
  const miss = aceCall((g) => { g.serveInFlight = false; g.endPoint('you', 'アウト'); });
  ok(!/km\/h/.test(miss.shot), `an opponent error keeps the plain shot name, got ${miss.shot}`);
}

// --- ワイド×フル溜めのサーブは、フォールトにならずサイドラインまで十分な余白を残す ---
// (外方向に強いサーブを打つとフォールトになりやすい問題の調整。物理ステップの粒度上、
// 着地判定はステップ後の位置をそのまま使うため速い球ほど着地点が数cm外側にずれうる。
// AIM_WIDE_MAX と CLEARANCE を調整し、ワイド×フル溜めでも安定してサイドラインから
// 余白を残して入ることを検証する)
{
  const SWEET_FRAMES = Math.round(SERVE.CHARGE_SWEET_T * 60);
  const SIDELINE_SAFETY_MARGIN = 0.15; // これ未満だと「ぎりぎり」とみなす
  const input = { moveX: -1, moveZ: 0, lob: false }; // aim===targetSign(+1) でワイド狙い
  let outs = 0;
  let nets = 0;
  let minMargin = Infinity;
  const N = 300;
  for (let i = 0; i < N; i++) {
    const g = new R.Game({ input, hooks: noHooks });
    g.started = true;
    g.newPoint();
    tossAndHit(g, SWEET_FRAMES);
    ok(g.you.swingCharge > 0.85, `precondition: released at the sweet spot for full power, got ${g.you.swingCharge}`);
    const L = R.physics.predictLanding(g.ball);
    // わざとネットに掛ける1本（SERVE.NET_CHANCE の抽選）はこのテストの対象外。狙いは
    // ネット際へ切り替わっているので、サイドラインの余白を測る意味もない。
    if (L.net) { nets++; continue; }
    if (Math.abs(L.x) > HALF_W || L.z <= 0 || L.z > COURT.SERVICE) outs++;
    minMargin = Math.min(minMargin, HALF_W - Math.abs(L.x));
  }
  ok(outs === 0, `wide full-power serves never go past the line: ${outs}/${N}`);
  ok(nets <= N * SERVE.NET_CHANCE * 2.5,
    `and only the intended few catch the net: ${nets}/${N} (SERVE.NET_CHANCE=${SERVE.NET_CHANCE})`);
  ok(minMargin >= SIDELINE_SAFETY_MARGIN,
    `wide full-power serves keep at least ${SIDELINE_SAFETY_MARGIN}m from the sideline, min observed=${minMargin.toFixed(3)}`);
}

// --- サーブは Space を押しっぱなしにする1ジェスチャー（押した瞬間にトス、離した瞬間に打つ） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  ok(!g.tossActive && !g.ball.live, 'precondition: not tossed yet');

  g.chargeStart();
  ok(g.tossActive === true, 'pressing Space starts the toss');
  ok(g.you.charging === true, 'the same press also starts charging the takeback');
  ok(g.ball.live === false, 'ball is not live during the toss (no rally physics)');
  ok(g.ball.vy > 0, 'toss ball moves upward');
  ok(g.phase === 'serve', 'still in serve phase during the toss');

  // 即離しでは球はまだ手元（ラケットの届く CONTACT_Y より下）を上がっている途中なので、
  // 振り出しただけで当たらない。上がってきて打点を通った瞬間に打つ。
  g.chargeRelease();
  ok(g.serveSwing && g.serveSwing.who === 'you', 'releasing Space swings (waits for the toss to reach the racket)');
  ok(g.tossActive === true && g.ball.live === false, 'the ball is not hit yet while still below the racket');
  untilServed(g);
  ok(g.tossActive === false, 'the toss ends once the racket meets the ball');
  ok(g.ball.live === true, 'ball becomes live once hit');
  ok(g.phase === 'rally', 'phase moves to rally once hit');
}

// --- サーブはラケットが届く高さで当たる（軌跡の始点＝打点が選手の頭上高くに浮かない） ---
// 以前は離した瞬間のトスの高さで打っていて、ゲージの線ちょうどで離すと打点がトス頂点近くの
// 3.3m になり、ラケット（約2m）よりはるか上から球が飛び出していた（ユーザー報告：ポイント後に
// 残る軌跡の始点が高すぎる）。トスは高いまま、落ちてきて届いたところで打つ。
{
  const { PLAYER: P } = R.config;
  const SWEET_FRAMES = Math.round(SERVE.CHARGE_SWEET_T * 60);
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.chargeStart();
  for (let f = 0; f < SWEET_FRAMES; f++) g.update(1 / 60);
  ok(g.ball.y > SERVE.CONTACT_Y + 0.3, `precondition: at the gauge line the toss is well above the racket, y=${g.ball.y}`);
  g.chargeRelease();
  ok(g.phase === 'serve' && g.serveSwing && Math.abs(g.serveSwing.y - SERVE.CONTACT_Y) < 1e-6,
    'releasing at the line swings, and will meet the ball at the top of the reach');
  g.chargeStart(); // 待っている間に押し直しても、2回目のスイングにはならない
  ok(g.you.charging === false && g.serveSwing.who === 'you', 'pressing again while the swing waits is ignored');
  let frames = 0;
  for (; frames < 120 && g.phase === 'serve'; frames++) g.update(1 / 60);
  ok(g.phase === 'rally', 'the ball is hit once it falls to the racket');
  ok(frames * (1 / 60) < 0.35, `and that comes soon after releasing: ${(frames / 60).toFixed(2)}s`);
  ok(g.trail[0].y <= SERVE.CONTACT_Y + 1e-9 && g.trail[0].y > SERVE.CONTACT_Y - 0.03,
    `the trail starts at the racket's reach (CONTACT_Y), y=${g.trail[0].y}`);
  // 跳躍の頂点がちょうど当たる瞬間に来る（頂点を過ぎてから当たると、ラケットが球の下を通って見える）
  const L = g.you.leap;
  ok(L && L.kind === 'serve' && Math.abs(L.reach - SERVE.CONTACT_Y) < 1e-6,
    `the server jumps into the ball, leap=${JSON.stringify(L)}`);
  const pastPeak = L && (L.span - L.t) - L.rise * L.span;
  ok(L && pastPeak >= -1e-9 && pastPeak <= 1 / 60 + 1e-9,
    `the jump peaks at the moment of contact (within the contact frame), ${pastPeak}s past the peak`);
  ok(L.rise * L.span <= P.SERVE_LEAP_RISE_T + 1e-9, 'the take-off is no longer than SERVE_LEAP_RISE_T');
}

// --- 振り終わる前にトスが跳ばずに届く高さより下へ落ちる（離すのが遅すぎた）なら、その高さで打つ ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.chargeStart();
  for (let f = 0; f < 120 && !(g.ball.vy < 0 && g.ball.y < SERVE.CONTACT_Y - 0.1); f++) g.update(1 / 60);
  ok(g.tossActive && g.ball.vy < 0 && g.ball.y < SERVE.CONTACT_Y && g.ball.y > SERVE.STAND_CONTACT_Y,
    `precondition: the toss is falling between the two reach heights, y=${g.ball.y}`);
  g.chargeRelease();
  ok(g.serveSwing && g.serveSwing.t < SERVE.SWING_T, 'a very late swing meets the ball before the swing is complete');
  for (let f = 0; f < 60 && g.phase === 'serve'; f++) g.update(1 / 60);
  ok(g.phase === 'rally', 'the late swing still connects');
  ok(Math.abs(g.trail[0].y - SERVE.STAND_CONTACT_Y) < 0.03,
    `it is hit at the standing reach (STAND_CONTACT_Y), y=${g.trail[0].y}`);
  // 跳ぶ高さは打点の高さで決まる（見た目側：SWING.SERVE_JUMP_H + reach − CONTACT_Y）。
  // 跳ばずに届く高さなら跳ばない＝腕を振り上げるだけ。
  ok(g.you.leap && Math.abs(g.you.leap.reach - SERVE.STAND_CONTACT_Y) < 1e-6,
    `the jump is sized for the standing reach (no lift), leap=${JSON.stringify(g.you.leap)}`);
}

// --- 人間のサーブは、離したタイミングで打点が変わる（遅いほど落ちてきた球を低く打つ） ---
// 振り出してから当たるまでは SERVE.SWING_T。そのときトスがある高さで打つ（上限 CONTACT_Y）。
{
  const SWEET_FRAMES = Math.round(SERVE.CHARGE_SWEET_T * 60);
  const g0 = Math.abs(R.config.PHYSICS.GRAVITY);
  const vy0 = Math.sqrt(2 * g0 * (SERVE.TOSS_PEAK - SERVE.BALL_Y)); // tossBall() と同じ初速
  const tossY = (t) => SERVE.BALL_Y + vy0 * t - 0.5 * g0 * t * t;
  /** holdFrames 押して離したときの打点の高さと、離してから当たるまでの秒数 */
  const contactFor = (holdFrames) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.chargeStart();
    for (let f = 0; f < holdFrames; f++) g.update(1 / 60);
    g.chargeRelease();
    let frames = 0;
    for (; frames < 120 && g.phase === 'serve'; frames++) g.update(1 / 60);
    return { y: g.trail[0].y, wait: frames / 60 };
  };
  const early = contactFor(SWEET_FRAMES - 9); // 線より0.15秒早い
  const line = contactFor(SWEET_FRAMES);
  const late1 = contactFor(SWEET_FRAMES + 3); // 0.05秒遅い
  const late2 = contactFor(SWEET_FRAMES + 6); // 0.1秒遅い
  ok(Math.abs(early.y - SERVE.CONTACT_Y) < 0.03, `an early release is still hit at the top of the reach, y=${early.y}`);
  ok(Math.abs(line.y - SERVE.CONTACT_Y) < 0.03, `a release on the line is hit at the top of the reach, y=${line.y}`);
  ok(late1.y < line.y - 0.05 && late2.y < late1.y - 0.1,
    `the later the release, the lower the contact: ${line.y.toFixed(2)} > ${late1.y.toFixed(2)} > ${late2.y.toFixed(2)}`);
  const want = (holdFrames) => tossY(holdFrames / 60 + SERVE.SWING_T);
  ok(Math.abs(late1.y - want(SWEET_FRAMES + 3)) < 0.03 && Math.abs(late2.y - want(SWEET_FRAMES + 6)) < 0.03,
    `a late release is hit where the toss is SWING_T later: ${late1.y.toFixed(3)}/${want(SWEET_FRAMES + 3).toFixed(3)}, `
    + `${late2.y.toFixed(3)}/${want(SWEET_FRAMES + 6).toFixed(3)}`);
  ok(Math.abs(late1.wait - SERVE.SWING_T) <= 1 / 60 + 1e-9, `and SWING_T after releasing: ${late1.wait.toFixed(3)}s`);
}

// --- Space を離さずに待ちすぎると、トスが落ちてきて自動でリセットされる（フォルト扱いにはしない） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.chargeStart(); // トス＆チャージ開始。まだ離さない
  ok(g.tossActive === true, 'tossed');
  ok(g.you.charging === true, 'precondition: still holding Space');
  for (let i = 0; i < 180 && g.tossActive; i++) g.update(1 / 60); // 3秒＝落ちてくるまで十分待つ
  ok(g.tossActive === false, 'toss auto-resets after falling without releasing');
  ok(g.ball.live === false, 'ball is not live after an unfulfilled toss');
  ok(g.phase === 'serve', 'still serve phase, can retry');
  ok(Math.abs(g.ball.y - SERVE.BALL_Y) < 0.01, `ball returns to hand height, y=${g.ball.y}`);
  ok(g.you.charging === false, 'holding through the auto-reset cancels the charge');
}

// --- 自分のサーブ中はフットフォルトになる位置へ動けない ---
{
  const input = { moveX: 0, moveZ: 0, lob: false };
  const g = new R.Game({ input, hooks: noHooks });
  g.start();
  const side = g.match.serveSide;
  // クロス(-1)から始まる＝画面右で構える配置なので、フットフォルトの可動域は
  // [-HALF_W, 0]（サイドラインは -x 側、センターマークは 0）になる。
  ok(side === -1, `precondition: serveSide should be -1 (cross) for a fresh match (got ${side})`);

  input.moveZ = 1; input.moveX = 0;
  g.movePlayers(5);
  ok(g.you.z === -HALF_L, `foot fault: can't cross baseline, z=${g.you.z}`);

  input.moveZ = 0; input.moveX = 1;
  g.movePlayers(5);
  ok(g.you.x === -HALF_W, `foot fault: can't cross sideline, x=${g.you.x}`);

  input.moveX = -1;
  g.movePlayers(5);
  ok(g.you.x === 0, `foot fault: can't cross center mark, x=${g.you.x}`);

  input.moveX = 0; input.moveZ = 0;
  g.serve('you');
  input.moveZ = 1;
  g.movePlayers(5);
  ok(g.you.z === PLAYER.Z_NEAR, `after contact: normal bounds apply, z=${g.you.z}`);
}

// --- トス中は左右キーを入力しても一切動かない（打点がトス位置からずれない） ---
{
  const input = { moveX: 0, moveZ: 0, lob: false };
  const g = new R.Game({ input, hooks: noHooks });
  g.start();
  g.chargeStart(); // Space 押しっぱなし開始＝トス（まだ離さない）
  ok(g.tossActive === true, 'precondition: tossing');
  const before = { x: g.you.x, z: g.you.z };

  input.moveX = 1; input.moveZ = 1;
  g.movePlayers(1 / 60);
  ok(g.you.x === before.x && g.you.z === before.z, `player does not move during the toss, x=${g.you.x} z=${g.you.z}`);
  ok(g.you.vx === 0 && g.you.vz === 0, 'velocity is held at 0 during the toss');
  ok(g.you.speed === 0, 'speed reads 0 during the toss (no walk animation)');

  for (let i = 0; i < 20; i++) g.movePlayers(1 / 60);
  ok(g.you.x === before.x && g.you.z === before.z, 'still frozen after several frames of held input');

  // 打った瞬間から通常どおり動ける
  g.chargeRelease();
  untilServed(g);
  ok(g.tossActive === false, 'precondition: served');
  g.movePlayers(1 / 60);
  ok(g.you.x !== before.x || g.you.z !== before.z, 'player can move again once the toss has been hit');
}

// --- サーブはクロスサイドから始まり、ポイントごとに逆クロスサイドへ交互になる ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  ok(g.match.serveSide === -1, `fresh game starts on the cross side (-1), got ${g.match.serveSide}`);
  g.match.awardPoint('you');
  ok(g.match.serveSide === 1, `next point is the reverse-cross side (+1), got ${g.match.serveSide}`);
  g.match.awardPoint('cpu');
  ok(g.match.serveSide === -1, `back to the cross side on the 3rd point, got ${g.match.serveSide}`);
}

// --- レシーバーはポイント開始時にレシーブポジションへ移動する ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.you.x = 999; g.you.z = 999; // ありえない位置から始めて、移動したことを確認する
  g.server = 'cpu'; // you チームが受ける番
  g.start();
  ok(Math.abs(g.you.x) < HALF_W + 1, `receiver moves near the return box, x=${g.you.x}`);
  ok(g.you.z < -HALF_L, `receiver is positioned behind their own baseline, z=${g.you.z}`);
}

// --- レシーブ位置はサイドライン寄り（ボックス中央ではない）で、サーブが打たれるまで崩れない ---
// (退行テスト: moveSinglesCpu() が phase==='serve' 中も homePosition()（センター）へ向けて
//  毎フレーム歩かせていたため、newPoint() が置いたレシーブの構えが、人間がトス/溜めしている
//  間にセンターへ寄っていって崩れてしまっていた)
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.server = 'you'; // cpu チームが受ける番
  g.start();
  ok(g.phase === 'serve' && g.cpu.x !== 0, `precondition: cpu starts near the sideline, not centered, x=${g.cpu.x}`);
  ok(Math.abs(g.cpu.x) > HALF_W - 2, `receive stance is near the sideline, not mid-box, x=${g.cpu.x}`);
  const stance = { x: g.cpu.x, z: g.cpu.z };

  // 人間がトス/溜めしている間の複数フレームぶん進める。まだ serve() は呼ばれていない。
  for (let i = 0; i < 60; i++) g.movePlayers(1 / 60);
  ok(g.phase === 'serve', 'precondition: still waiting to serve');
  ok(Math.abs(g.cpu.x - stance.x) < 1e-6 && Math.abs(g.cpu.z - stance.z) < 1e-6,
    `receiver is not dragged toward the center before the serve, got x=${g.cpu.x} z=${g.cpu.z}`);
}

// --- グラウンドストロークの構え位置は、落下点そのものではなく弾んでから打ちやすい高さの頂点 ---
// (退行テスト: 固定オフセットが小さすぎて、着地点のほぼ真上で待つような不自然な構えになっていた。
//  今は predictBounceApex() で「バウンド後に実際どこまで戻ってくるか」を物理的に先読みしている)
{
  const { chasePosition } = R.ai;
  const { predictLanding, predictBounceApex } = R.physics;
  const ball = {
    x: 1, y: 2, z: 5, vx: 0.5, vy: -3, vz: 6, bounces: 0, // cpu 陣地(z>0)へ向かって落ちてくる球
  };
  const landing = predictLanding(ball);
  const bounceApex = predictBounceApex(ball);
  const target = chasePosition(ball, 1);
  ok(bounceApex.z - landing.z > 1.0,
    `the bounce apex sits generously beyond the raw landing point, not right on top of it, landing.z=${landing.z} apex.z=${bounceApex.z}`);
  ok(Math.abs(target.z - bounceApex.z) < 1e-9,
    `chasePosition() targets the predicted bounce apex, got target.z=${target.z} apex.z=${bounceApex.z}`);
}

// --- 先読みのクランプ(CHASE_APEX_LEAD_MAX)は、普通のラリー球の頂点を切り落とさない大きさ ---
// (退行テスト: 4.5 では実戦の球の100%が切り落とされていた（実測した「着地点→バウンド後の
//  頂点」距離は中央値6.35m）。そのためCPUは着地点で待ってからバウンド後に慌てて走り出す
//  羽目になり、打球の70.6%を全力疾走のまま打つ＝ぎりぎりの弱い返球になっていた。
//  逆に大きくしすぎると今度は CHASE_Z_MAX（後方の限界）へ下がって張り付くので、
//  実戦から採取した実際の球で両側から挟んで固定する)
{
  const { CPU } = R.config;
  const { predictLanding, predictBounceApex } = R.physics;
  const { chasePosition } = R.ai;
  // 擬似ランダムな試合シミュレーションから採取した、人間が実際に打った球（先読み距離が
  // 中央値付近のもの）。ベースライン(z≈-11.9)から相手陣地(z>0)へ打ち出した直後の状態。
  const rallyBalls = [
    { x: -2.94, y: 0.91, z: -11.51, vx: 1.91, vy: 8.63, vz: 12.44, bounces: 0 },
    { x: 2.85, y: 0.93, z: -11.60, vx: -2.13, vy: 8.62, vz: 13.19, bounces: 0 },
  ];
  for (const ball of rallyBalls) {
    const landing = predictLanding(ball);
    const apex = predictBounceApex(ball);
    const lead = Math.hypot(apex.x - landing.x, apex.z - landing.z);
    ok(lead <= CPU.CHASE_APEX_LEAD_MAX,
      `a real rally ball's bounce apex fits inside the lead clamp (lead=${lead.toFixed(2)} <= ${CPU.CHASE_APEX_LEAD_MAX})`);
    const target = chasePosition(ball, 1);
    ok(Math.abs(target.z - apex.z) < 1e-9,
      `the clamp doesn't truncate a real rally ball's apex, got target.z=${target.z} apex.z=${apex.z}`);
    ok(target.z < CPU.CHASE_Z_MAX,
      `the target stays in front of the rear chase limit (no camping), got target.z=${target.z} limit=${CPU.CHASE_Z_MAX}`);
  }
}

// --- 打った直後（人間もCPUも）はフォロースルー中で、しばらく動けない ---
// (退行テスト: 打ってからミドルに戻るまでの時間が短すぎるというフィードバックを受けて、
//  硬直時間を延ばした。人間側にも同様の硬直（HIT_RECOVER_DELAY）を新設した)
{
  const { HIT_RECOVER_DELAY, CPU_RECOVER_DELAY } = PLAYER;

  // 人間：打った直後は入力があっても動けず、硬直が明けると動ける
  {
    const input = { moveX: 1, moveZ: 0, lob: false };
    const g = new R.Game({ input, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -2;
    g.ball.x = 0; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
    g.hit('you');
    ok(g.recoverTimers.you === HIT_RECOVER_DELAY, `hitting sets the human's recover timer, got ${g.recoverTimers.you}`);

    const stillFrames = Math.floor(HIT_RECOVER_DELAY / (1 / 60)) - 2;
    for (let i = 0; i < stillFrames; i++) g.movePlayers(1 / 60);
    ok(g.you.x === 0, `human cannot move yet during the post-hit recovery lock, x=${g.you.x}`);

    for (let i = 0; i < 30; i++) g.movePlayers(1 / 60); // 硬直が明けるのに十分な時間
    ok(g.you.x !== 0, `human can move again once the recovery lock expires, x=${g.you.x}`);
  }

  // CPU：打った直後は棒立ちで、硬直が明けると定位置(home)へ戻り始める
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.cpu.x = 3; g.cpu.z = 5;
    g.ball.x = 3; g.ball.y = 1; g.ball.z = 5; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
    g.hit('cpu');
    ok(g.recoverTimers.cpu === CPU_RECOVER_DELAY, `hitting sets the cpu's recover timer, got ${g.recoverTimers.cpu}`);

    const cpuXAfterHit = g.cpu.x;
    const stillFrames = Math.floor(CPU_RECOVER_DELAY / (1 / 60)) - 2;
    for (let i = 0; i < stillFrames; i++) g.movePlayers(1 / 60);
    ok(g.cpu.x === cpuXAfterHit, `cpu stays put during its own post-hit recovery lock, x=${g.cpu.x}`);

    for (let i = 0; i < 60; i++) g.movePlayers(1 / 60); // 硬直が明けて home へ戻り始めるのに十分な時間
    ok(g.cpu.x < cpuXAfterHit, `cpu starts recovering toward home once its lock expires, x=${g.cpu.x}`);
  }
}

// --- サーブはノーバウンドで打ち返してはいけない（volley禁止） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  tap(g); // Space 押して即離す＝トスして振り出す
  untilServed(g);
  ok(g.serveInFlight === true, 'serve sets serveInFlight');
  ok(g.ball.last === 'you', 'precondition: served by team you');

  // ボールが cpu 側に来た状態を作る（実際の弾道を待たず、判定だけを検証する）
  g.ball.x = 0; g.ball.y = 1.0; g.ball.z = 5;
  g.cpu.x = 0; g.cpu.z = 5;

  // cpu が届く位置にいても、バウンド前は打ち返せない
  g.checkSwings();
  ok(g.ball.last === 'you', 'cannot volley the serve before it bounces');

  // 1バウンドしたら打ち返せる
  g.ball.bounces = 1;
  g.checkSwings();
  ok(g.ball.last === 'cpu', 'can return the serve once it has bounced');
  ok(g.serveInFlight === false, 'returning the serve clears serveInFlight');
}

// --- inServiceBox(): サービスボックス（ネット〜サービスライン、狙った側）の内外判定 ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(); // server='you', serveSide=-1 なので targetSign=+1 側のボックスを狙う

  ok(g.inServiceBox({ x: 1.0, z: 3.0 }) === true, 'inside the box (you serving) is in');
  ok(g.inServiceBox({ x: 1.0, z: COURT.SERVICE + 1 }) === false,
    'past the service line (you serving) is out, even though it is well inside the full court');
  ok(g.inServiceBox({ x: HALF_W + 1, z: 3.0 }) === false, 'past the sideline (you serving) is out');
  ok(g.inServiceBox({ x: -1.0, z: 3.0 }) === false, 'wrong half (crossing the center line) is out');
  ok(g.inServiceBox({ x: 1.0, z: -3.0 }) === false, "didn't clear the net (own side) is out");

  g.server = 'cpu'; // 反対チームのサーブでも符号が正しく反転すること（cpu狙いは targetSign=side）
  const cpuTargetSign = g.match.serveSide; // -1 のまま（フレッシュな試合）
  ok(g.inServiceBox({ x: cpuTargetSign * 1.0, z: -3.0 }) === true, 'inside the box (cpu serving) is in');
  ok(g.inServiceBox({ x: cpuTargetSign * 1.0, z: 3.0 }) === false, "didn't clear the net (cpu's own side) is out");
}

// --- サーブがフォールト（ネット／アウト）になっても即失点にはせず、1本目はセカンドサーブでやり直せる ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  ok(g.serveNumber === 1, 'precondition: first serve');

  g.serve('you');
  ok(g.phase === 'rally' && g.serveInFlight === true, 'precondition: serve is in flight');

  // コート全体には入っているが、サービスラインより深く着地＝サービスボックスの外（アウト）
  const ended = bounceAt(g, 1.0, COURT.SERVICE + 1);
  ok(ended === true, 'a serve landing past the service line ends this attempt (fault)');
  ok(g.serveNumber === 2, 'first fault moves to the second serve');
  ok(g.phase === 'fault', 'the fault is called first, instead of jumping straight into the next serve');
  g.tickTimers(R.config.TIMING.FAULT_CALL + 0.01);
  ok(g.phase === 'serve', 'after the call it goes back to waiting to serve');
  ok(g.ball.live === false, 'ball is reset, not mid-flight');
  ok(g.server === 'you', 'server stays the same after a fault');
  ok(g.match.points.you === 0 && g.match.points.cpu === 0, 'no point is awarded on a single fault');

  // セカンドサーブがネットに掛かる（2本目のフォールト）＝ダブルフォルトで相手の得点
  g.serve('you');
  ok(g.serveInFlight === true, 'precondition: second serve is in flight');
  g.ball.x = 1; g.ball.z = -0.01; g.ball.y = 0.3; g.ball.vx = 0; g.ball.vy = 0; g.ball.vz = 5;
  g.stepBall(0.05);
  ok(g.phase === 'over', 'a fault on the second serve ends the point (double fault)');
  ok(g.match.points.cpu === 1, 'double fault awards the point to the receiver');
  ok(g.match.points.you === 0, "the server doesn't score on a double fault");
}

// --- 1本目のフォールトは「フォールト」とコールし、一拍おいてからセカンドサーブに入る ---
// (退行テスト: 以前はフォールトした瞬間にセカンドサーブの構えへ切り替わっていたため、
//  1本目が失敗したことに気づけず、溜めキーを押したままだとそのまま次のトスが上がっていた)
{
  const { TIMING } = R.config;
  const calls = [];
  const input = { moveX: 0, moveZ: 0, lob: false };
  const g = new R.Game({ input, hooks: { ...noHooks, call: (big, sub) => calls.push([big, sub]) } });
  g.start();
  g.serve('you');
  bounceAt(g, 1.0, COURT.SERVICE + 1); // 1本目がサービスボックスの外＝フォールト

  ok(calls.some(([big, sub]) => big === 'フォールト' && sub === 'アウト'),
    `"フォールト" is called with the reason, got ${JSON.stringify(calls)}`);
  ok(g.phase === 'fault', `the game waits in the fault call, got phase=${g.phase}`);
  ok(g.ball.live === false, 'the ball stops where it landed instead of rolling on');

  // コールの間はトスも打球も始まらない（溜めキーを押しっぱなしでも次のサーブに入らない）
  g.chargeStart('flat');
  g.update(1 / 60);
  ok(g.tossActive === false && g.phase === 'fault',
    'holding the charge key during the call does not start the next toss');

  // コールが明けてからセカンドサーブの構えに入る
  g.tickTimers(TIMING.FAULT_CALL);
  ok(g.phase === 'serve', `the second serve starts only after TIMING.FAULT_CALL, got phase=${g.phase}`);
  ok(calls[calls.length - 1][0] === 'セカンドサーブ',
    `and it is announced as the second serve, got ${JSON.stringify(calls[calls.length - 1])}`);
  ok(g.serveNumber === 2, 'still the same point, now on the second serve');
  ok(g.match.points.you === 0 && g.match.points.cpu === 0, 'no point is awarded');
}

// --- 1本目がフォールトしても、2本目が入れば普通にラリーへ進む ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.serve('you');
  bounceAt(g, 1.0, COURT.SERVICE + 1); // 1本目アウト
  g.tickTimers(R.config.TIMING.FAULT_CALL + 0.01); // 「フォールト」のコールが明けるまで待つ
  ok(g.serveNumber === 2, 'precondition: on the second serve');

  tossAndHit(g); // セカンドサーブを普通に打つ
  ok(g.phase === 'rally', 'a valid second serve starts the rally as normal');
  const L = R.physics.predictLanding(g.ball);
  ok(!L.net && Math.abs(L.x) <= HALF_W && L.z > 0 && L.z <= COURT.SERVICE,
    'the second serve itself lands in the service box like a first serve would');
}

// --- AI（CPU/AI）のセカンドサーブは1本目より遅く、ラインから余裕を取り、回転で入れにいく ---
// (退行テスト: 以前は serve() が this.serveNumber を球速にも狙いにも一切使っておらず、
//  AIは1本目も2本目も同じフル威力のフラット系サーブを打っていた)
{
  const sampleCpuServes = (serveNumber) => {
    const speeds = [];
    const spins = [];
    const landings = [];
    for (let i = 0; i < 300; i++) {
      const g = new R.Game({
        input: fakeInput,
        hooks: { ...noHooks, serveSpeed: (kmh) => { if (kmh != null) speeds.push(kmh); } },
      });
      g.started = true;
      g.server = 'cpu';
      g.newPoint();
      g.serveNumber = serveNumber; // newPoint() は必ず1本目から始めるので、ここで2本目にする
      g.serve('cpu');
      spins.push(g.ball.spin);
      landings.push(R.physics.predictLanding(g.ball));
    }
    const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    return {
      avg,
      flatShare: spins.filter((sp) => sp === 'flat').length / spins.length,
      // CPU のサーブは -z 側（人間のコート）の対角ボックスへ入る
      inBox: landings.filter((L) => !L.net && Math.abs(L.x) <= HALF_W
        && L.z < 0 && L.z >= -COURT.SERVICE).length / landings.length,
    };
  };
  const first = sampleCpuServes(1);
  const second = sampleCpuServes(2);

  ok(second.avg < first.avg * 0.85,
    `the AI's second serve is clearly slower: 1st=${first.avg.toFixed(0)} 2nd=${second.avg.toFixed(0)}km/h`);
  // 角度サーブ（サイドラインを越える所まで踏み込むコース）は2本目には出ない。
  // 着地点ではなく狙いそのものを見る（外す抽選＝CPU_FIRST_MISS に当たった1本は、
  // わざとボックスの外へ狙いをずらすため着地点では区別できない）。
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    const aims = (sn) => Array.from({ length: 300 }, () => g.cpuServeAimMagnitude(sn === 2));
    const secondAims = aims(2);
    ok(Math.max(...secondAims) <= SERVE.SECOND_AIM_WIDE_MAX,
      `the second serve keeps clear of the sideline: max aim=${Math.max(...secondAims).toFixed(2)}m`);
    ok(Math.max(...aims(1)) > SERVE.SECOND_AIM_WIDE_MAX,
      'the first serve still uses the wide/angle courses');
  }
  ok(second.flatShare < 0.3 && second.flatShare < first.flatShare,
    `the second serve mostly carries spin: flat ${(second.flatShare * 100).toFixed(0)}% vs 1st ${(first.flatShare * 100).toFixed(0)}%`);
  ok(second.inBox > first.inBox,
    `the second serve goes in more often: 1st=${(first.inBox * 100).toFixed(0)}% 2nd=${(second.inBox * 100).toFixed(0)}%`);
}

// --- AIのサーブの成功率は実際のテニスの水準（1本目6割強／2本目9割強）にある ---
// (以前は幾何的に外れるぶんしかなく1本目も2本目も約9割入っていた＝「毎回フル威力の
//  1本目がほぼ確実に入る」状態。SERVE.CPU_FIRST_MISS / CPU_SECOND_MISS で外す)
{
  const inRate = (serveNumber) => {
    let inBox = 0;
    const N = 600;
    for (let i = 0; i < N; i++) {
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.started = true;
      g.server = 'cpu';
      g.newPoint();
      g.serveNumber = serveNumber;
      g.serve('cpu');
      const L = R.physics.predictLanding(g.ball);
      if (!L.net && Math.abs(L.x) <= HALF_W && L.z < 0 && L.z >= -COURT.SERVICE) inBox++;
    }
    return inBox / N;
  };
  // 実測（各6000本）では 1本目 61〜64%・2本目 92〜93%。ATPの平均は 1st 62%／2nd 92%。
  // ここは600本なので、標準偏差（約2%）の3倍ぶん幅を持たせてある。
  const first = inRate(1);
  const second = inRate(2);
  ok(first > 0.54 && first < 0.70, `first serves go in about 62% of the time: ${(first * 100).toFixed(0)}%`);
  ok(second > 0.86 && second < 0.97, `second serves go in about 92% of the time: ${(second * 100).toFixed(0)}%`);
  ok((1 - first) * (1 - second) < 0.06,
    `double faults stay near the real ~3%: ${((1 - first) * (1 - second) * 100).toFixed(1)}%`);
}

// --- AIは構えてから一拍おいてトスを上げ、そこからさらに間を置いて打つ ---
// (退行テスト: 以前はポイントが始まった瞬間にトスが上がり 0.9秒後には球が飛んできていた＝
//  レシーバー（人間）が構える間がなく「サーブが早すぎる」と感じられていた)
{
  const { TIMING, PHYSICS } = R.config;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.started = true;
  g.server = 'cpu';
  g.newPoint();
  ok(g.aiTossActive === false, 'the AI does not toss the instant the point starts');

  g.tickTimers(TIMING.CPU_SERVE_READY - 0.05);
  ok(g.aiTossActive === false, 'it is still standing at the line just before CPU_SERVE_READY');
  g.tickTimers(0.1);
  ok(g.aiTossActive === true, 'the toss goes up after CPU_SERVE_READY');
  ok(g.phase === 'serve', 'the ball has not been hit yet');

  // 振り出す（跳び始める）のは CPU_SERVE_DELAY 後。当たるのはそこから、トスがラケットの
  // 届く AI_CONTACT_Y まで落ちてきたとき（トスの球を実際に動かすので update() で進める）。
  let t = 0;
  for (; t < TIMING.CPU_SERVE_DELAY - 0.1; t += 1 / 60) g.update(1 / 60);
  ok(g.phase === 'serve' && !g.serveSwing, 'still on the toss just before CPU_SERVE_DELAY');
  for (; t < TIMING.CPU_SERVE_DELAY + 0.05; t += 1 / 60) g.update(1 / 60);
  ok(g.serveSwing && g.serveSwing.who === 'cpu', 'the AI swings CPU_SERVE_DELAY after the toss');
  ok(g.phase === 'serve', 'but the toss is still above the racket, so it has not been hit yet');
  for (let i = 0; i < 120 && g.phase === 'serve'; i++) g.update(1 / 60);
  ok(g.phase === 'rally', 'the serve is struck once the toss falls to the racket');
  ok(Math.abs(g.trail[0].y - SERVE.AI_CONTACT_Y) < 0.03,
    `the AI hits from its racket height (the trail starts there), y=${g.trail[0].y}`);
  ok(g.cpu.leap && g.cpu.leap.kind === 'serve', 'the AI jumps into its serve');

  // 打つのはトスが手元へ落ちきる前でなければならない（でないとトスが2回上がって見える）
  const tossAir = 2 * Math.sqrt(2 * (SERVE.TOSS_PEAK - SERVE.BALL_Y) / Math.abs(PHYSICS.GRAVITY));
  ok(TIMING.CPU_SERVE_DELAY < tossAir,
    `the AI hits before its toss lands back in hand: delay=${TIMING.CPU_SERVE_DELAY}s air=${tossAir.toFixed(2)}s`);
}

// --- スタッツ：ダブルフォルトはサーバー側のカウントに積む ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  ok(g.stats.you.doubleFaults === 0 && g.stats.cpu.doubleFaults === 0, 'precondition: no stats yet');

  g.serve('you');
  bounceAt(g, 1.0, COURT.SERVICE + 1); // 1本目アウト
  ok(g.serveNumber === 2, 'precondition: on the second serve');

  g.serve('you');
  g.ball.x = 1; g.ball.z = -0.01; g.ball.y = 0.3; g.ball.vx = 0; g.ball.vy = 0; g.ball.vz = 5;
  g.stepBall(0.05); // 2本目もネットにかかる＝ダブルフォルト
  ok(g.phase === 'over', 'precondition: double fault ends the point');
  ok(g.stats.you.doubleFaults === 1, 'double fault counts against the server (you)');
  ok(g.stats.cpu.doubleFaults === 0, "double fault doesn't count against the receiver");
}

// --- 極端な範囲（BOUNDS）を出た球の保険判定も、サーブ中はフォールト扱いにする ---
// (退行テスト: stepBall() の「計算が破綻したときの保険」判定が serveInFlight を見ておらず、
//  1本目のサーブがこの保険に引っかかると、セカンドサーブに回らず即失点になっていた)
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.serve('you');
  ok(g.serveInFlight === true, 'precondition: first serve is in flight');
  g.ball.x = BOUNDS.X + 1; // 通常のサーブでは絶対に届かない極端な位置（保険判定の対象）
  g.ball.z = 3;
  g.stepBall(1 / 240);
  ok(g.serveNumber === 2, 'an out-of-bounds first serve retries as a fault, not an instant loss');
  ok(g.phase === 'fault', 'does not end the point');
  ok(g.match.points.you === 0 && g.match.points.cpu === 0, 'no point is awarded');
}

// --- 既にサービスボックスへ入ったサーブは、返球されずに BOUNDS を出ても「アウト」にしない ---
// (退行テスト: BOUNDS の保険判定が serveInFlight を見るだけで bounces を見ておらず、
//  「正しく入ったサーブをレシーバーが空振りし、2バウンド目より先に球が遠くまで転がり出た」
//  ケースまでフォールト扱いになっていた。実際にはサーバーの得点＝エースであるべき)
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.serve('you');
  ok(g.serveInFlight === true, 'precondition: serve in flight');

  // サービスボックス内に着地させる（bounce() がフォールトにしない＝正しいサーブ）
  ok(bounceAt(g, 1.0, 3) === false, 'precondition: the serve lands in the service box');
  ok(g.serveInFlight === true && g.ball.bounces === 1,
    'precondition: landed in but still untouched by the receiver');

  // 誰も触れないまま、2バウンド目より先に BOUNDS を越えて転がり出る
  g.ball.z = -(BOUNDS.Z + 1);
  g.stepBall(1 / 240);
  ok(g.phase === 'over', 'the point is decided, not replayed as a fault');
  ok(g.serveNumber === 1, 'it is not treated as a fault (still on the first serve)');
  ok(g.match.points.you === 1 && g.match.points.cpu === 0,
    `the server wins the point (the receiver failed to return a good serve), got ${g.match.points.you}-${g.match.points.cpu}`);
  ok(g.stats.you.aces === 1, 'it counts as an ace, same as an untouched serve that bounces twice');
}

// --- ネットイン：ラリー中にネットへ掛かった球が、ごく低い確率でそのまま相手コートへ入り続ける ---
{
  const { NET, TIMING } = R.config;

  /** ラリー中、ネットの手前から相手コート側へ向かう球を1ステップだけ進める。 */
  function rallyNetHit(g) {
    g.phase = 'rally';
    g.serveInFlight = false;
    Object.assign(g.ball, {
      x: 1, z: -0.01, px: 1, pz: -0.01, y: 0.3, py: 0.3, vx: 0, vy: 0, vz: 5, bounces: 0, last: 'you', live: true, wind: 0,
    });
    g.stepBall(0.05);
  }

  // 既定（乱数が確率を上回る）はこれまでどおりフォールトのまま
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    const origRandom = Math.random;
    Math.random = () => NET.IN_CHANCE; // ちょうど境界＝ネットインにはならない（< 判定）
    try {
      rallyNetHit(g);
    } finally {
      Math.random = origRandom;
    }
    ok(g.phase === 'over', 'without beating the chance, a net-clipped rally shot still ends the point as before');
    ok(g.match.points.cpu === 1 && g.match.points.you === 0,
      'the point goes to the opponent of whoever hit it into the net, unchanged');
  }

  // 確率を下回ったときだけネットインになり、ポイントは終わらずボールが生きたまま相手コートへ続く
  {
    const calls = [];
    const sounds = [];
    const hooks = {
      ...noHooks, call: (big, sub) => calls.push([big, sub]), clearCall: () => calls.push('clear'), sound: (name) => sounds.push(name),
    };
    const g = new R.Game({ input: fakeInput, hooks });
    g.start();
    const origRandom = Math.random;
    Math.random = () => 0; // 必ずネットインさせる
    try {
      rallyNetHit(g);
    } finally {
      Math.random = origRandom;
    }
    ok(g.phase === 'rally', 'a net-in does not end the point');
    ok(g.ball.live === true, 'the ball stays live after a net-in');
    ok(g.match.points.you === 0 && g.match.points.cpu === 0, 'no point is awarded on a net-in');
    ok(g.ball.vz > 0, `the ball keeps travelling the same direction (toward the opponent), got vz=${g.ball.vz}`);
    ok(Math.abs(g.ball.vz - 5 * NET.IN_VZ_MULT) < 1e-9,
      `forward speed is damped by NET.IN_VZ_MULT, got vz=${g.ball.vz}`);
    ok(sounds.includes('netIn'), 'a dedicated netIn sound is played');
    ok(calls.some(([big]) => big === 'ネットイン！'), 'a transient "ネットイン！" call is shown');

    // その表示は TIMING.NET_IN_CALL 秒後に自動で消える（タイマーだけを直接進める）
    g.tickTimers(TIMING.NET_IN_CALL + 0.01);
    ok(calls[calls.length - 1] === 'clear', 'the net-in call clears itself after TIMING.NET_IN_CALL seconds');
  }

  // サーブは対象外：ネットに掛かればネットインの確率に関わらず常にフォールトのまま
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.serve('you');
    ok(g.serveInFlight === true, 'precondition: first serve is in flight');
    const origRandom = Math.random;
    Math.random = () => 0; // ネットインの確率だけ見るならここで必ず救われるはずの乱数
    try {
      g.ball.x = 1; g.ball.z = -0.01; g.ball.y = 0.3; g.ball.vx = 0; g.ball.vy = 0; g.ball.vz = 5;
      g.stepBall(0.05);
    } finally {
      Math.random = origRandom;
    }
    ok(g.serveNumber === 2, 'a serve clipping the net is always a fault, never a net-in');
    ok(g.phase === 'fault', 'the point does not continue as a live rally');
  }
}

// --- スタッツ：エースはサーブが一度も返球されずに2バウンドで決まったときだけ積む ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.serve('you');
  ok(g.serveInFlight === true, 'precondition: serve in flight');
  // サービスボックス内に着地（フォールトではない）
  const decided1 = bounceAt(g, 1.0, 3);
  ok(decided1 === false, 'precondition: lands in the box, point continues');
  ok(g.serveInFlight === true, 'precondition: still not returned');

  // 誰も触れないまま2バウンド目＝エース
  const decided2 = bounceAt(g, 1.0, 3, 1);
  ok(decided2 === true, 'second bounce without a return ends the point');
  ok(g.phase === 'over' && g.match.points.you === 1, 'precondition: server wins the point');
  ok(g.stats.you.aces === 1, 'an untouched serve that bounces twice counts as an ace');
  ok(g.stats.cpu.aces === 0, 'the receiver gets no ace credit');
}

// --- スタッツ：返球されたラリーがツーバウンドで決まっても、エースにはカウントしない ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.serve('you');
  bounceAt(g, 1.0, 3); // サービスボックスに着地
  g.hit('cpu'); // リターンされる＝serveInFlight が解除される
  ok(g.serveInFlight === false, 'precondition: the serve has been returned');

  bounceAt(g, 1.0, 3, 1); // 相手が拾えず2バウンド
  ok(g.phase === 'over', 'precondition: point ends on the second bounce');
  ok(g.stats.you.aces === 0,
    'a rally point (serve already returned) is not an ace, even if it ends on a double bounce');
}

// --- コール表現：「ツーバウンド」は味気ないので、エース／ウィナーに言い換える ---
{
  const calls = [];
  const hooksWithCall = { ...noHooks, call: (big, sub) => calls.push({ big, sub }) };

  const gAce = new R.Game({ input: fakeInput, hooks: hooksWithCall });
  gAce.start();
  gAce.serve('you');
  gAce.ball.bounces = 0;
  gAce.ball.x = 1.0; gAce.ball.y = 0; gAce.ball.vy = -1; gAce.ball.z = 3;
  gAce.bounce();
  gAce.ball.bounces = 1;
  gAce.ball.y = 0; gAce.ball.vy = -1;
  gAce.bounce(); // 誰も触れないまま2バウンド＝エース
  const aceCall = calls[calls.length - 1];
  ok(aceCall.sub === 'エース！', `an untouched serve calls out 'エース！' instead of 'ツーバウンド', got ${aceCall.sub}`);

  const gWinner = new R.Game({ input: fakeInput, hooks: hooksWithCall });
  gWinner.start();
  gWinner.serve('you');
  gWinner.ball.bounces = 0;
  gWinner.ball.x = 1.0; gWinner.ball.y = 0; gWinner.ball.vy = -1; gWinner.ball.z = 3;
  gWinner.bounce();
  gWinner.hit('cpu'); // リターンされたラリー
  gWinner.ball.bounces = 1;
  gWinner.ball.y = 0; gWinner.ball.vy = -1;
  gWinner.bounce(); // 相手が拾えず2バウンド＝ラリーの決定打
  const winnerCall = calls[calls.length - 1];
  ok(winnerCall.sub === 'ウィナー！', `a rally-ending double bounce calls out 'ウィナー！' instead of 'ツーバウンド', got ${winnerCall.sub}`);
}

// --- 観客の歓声：hooks.sound('point', ...) に決まり方(outcome)とラリーの本数(rallyShots)が渡る ---
// (audio.js 側は AudioContext が要るので純ロジックのテストはできない。ここでは
//  game.js が渡す引数が正しいことだけを検証する)
{
  const sounds = [];
  const hooksWithSound = { ...noHooks, sound: (name, ...args) => sounds.push({ name, args }) };
  const lastPointSound = () => sounds.filter((s) => s.name === 'point').slice(-1)[0].args;

  // エース：サーブのみ（rallyShots=1）、誰も触れないまま2バウンド
  {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithSound });
    g.start();
    g.serve('you');
    Object.assign(g.ball, { bounces: 0, x: 1.0, y: 0, vy: -1, z: 3 });
    g.bounce();
    Object.assign(g.ball, { bounces: 1, y: 0, vy: -1 });
    g.bounce(); // 誰も触れないまま2バウンド＝エース
    const [winner, outcome, rallyShots] = lastPointSound();
    ok(winner === 'you' && outcome === 'ace' && rallyShots === 1,
      `an ace reports outcome='ace' and rallyShots=1, got winner=${winner} outcome=${outcome} rallyShots=${rallyShots}`);
  }

  // ウィナー：リターンされたラリー（サーブ+返球=2本）の末、相手が拾えず2バウンド
  {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithSound });
    g.start();
    g.serve('you');
    Object.assign(g.ball, { bounces: 0, x: 1.0, y: 0, vy: -1, z: 3 });
    g.bounce();
    g.hit('cpu'); // リターン（2本目）
    Object.assign(g.ball, { bounces: 1, y: 0, vy: -1 });
    g.bounce(); // 相手が拾えず2バウンド＝ラリーの決定打
    const [, outcome, rallyShots] = lastPointSound();
    ok(outcome === 'winner' && rallyShots === 2,
      `a rally-ending double bounce reports outcome='winner' with the shot count, got outcome=${outcome} rallyShots=${rallyShots}`);
  }

  // 凡ミス（ネット／アウト）：相手のミスで決まったとき
  {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithSound });
    g.start();
    g.phase = 'rally';
    g.endPoint('you', 'ネット');
    const [, outcome] = lastPointSound();
    ok(outcome === 'error', `a net fault reports outcome='error', got ${outcome}`);
  }

  // ダブルフォルト：1本目・2本目とも明らかなアウトを狙って強制的にフォールトさせる
  {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithSound });
    g.start();
    g.serveFault('アウト');
    g.serveFault('アウト'); // 2本目もフォールト＝ダブルフォルト
    const [, outcome] = lastPointSound();
    ok(outcome === 'doubleFault', `a double fault reports outcome='doubleFault', got ${outcome}`);
  }

  // ラリーが長引くほど rallyShots も伸びる（歓声の盛り上がりの材料）
  {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithSound });
    g.start();
    g.serve('you');
    Object.assign(g.ball, { bounces: 0, x: 1.0, y: 0, vy: -1, z: 3 });
    g.bounce();
    for (let i = 0; i < 5; i++) {
      g.hit(i % 2 === 0 ? 'cpu' : 'you');
      Object.assign(g.ball, { bounces: 0, y: 1, vy: -1 });
    }
    g.hit('cpu');
    Object.assign(g.ball, { bounces: 1, y: 0, vy: -1 });
    g.bounce();
    const [, , rallyShots] = lastPointSound();
    ok(rallyShots === 7, `a longer rally reports a proportionally larger rallyShots, got ${rallyShots}`);
  }
}

// --- 打球音・バウンド音のリアル化：hooks.sound に「何をどう打ったか」が渡る ---
// (audio.js 側の合成そのものは AudioContext が要るのでここでは検証できない。
//  game.js が渡す引数と、config.js の音色テーブルが揃っていることだけを見る)
{
  const sounds = [];
  const hooksWithSound = { ...noHooks, sound: (name, ...args) => sounds.push({ name, args }) };
  const last = (name) => sounds.filter((s) => s.name === name).slice(-1)[0].args;

  // サーブ：溜め量に加えて球種（フラット/スピン/スライス）が渡る
  {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithSound });
    g.start();
    g.you.chargeSpin = 'slice';
    g.serve('you');
    const [charge, spin] = last('serve');
    ok(typeof charge === 'number' && spin === 'slice',
      `sfx.serve gets the serve's spin, got charge=${charge} spin=${spin}`);
  }

  // ラリー：チーム・打ち方・溜め量・スピンの4つが渡る
  {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithSound });
    g.start();
    g.serve('you');
    Object.assign(g.ball, { bounces: 1, x: g.cpu.x, y: 1.0, z: g.cpu.z, vy: -1 });
    g.hit('cpu');
    const [team, stroke, charge, spin] = last('hit');
    ok(team === 'cpu' && typeof stroke === 'string' && typeof charge === 'number'
      && ['flat', 'top', 'slice', 'drop'].includes(spin),
      `sfx.hit gets team/stroke/charge/spin, got ${team} ${stroke} ${charge} ${spin}`);
  }

  // バウンド：スピンと「跳ねる前の速さ」が渡る（reflectBounce が減速させる前の値）
  {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithSound });
    g.start();
    g.serve('you');
    Object.assign(g.ball, {
      bounces: 0, x: 1.0, y: 0, z: 3, vx: 3, vy: -4, vz: 12, spin: 'top',
    });
    const before = Math.hypot(3, -4, 12);
    g.bounce();
    const [spin, speed] = last('bounce');
    ok(spin === 'top', `sfx.bounce gets the ball's spin, got ${spin}`);
    ok(Math.abs(speed - before) < 1e-9,
      `sfx.bounce gets the pre-bounce speed (${before.toFixed(2)}), got ${speed}`);
  }
}

// --- 音色テーブル（config.AUDIO）が打ち方・サーフェスぶん揃っていて、実際に聞き分けられる差がある ---
{
  const { AUDIO } = R.config;
  const S = AUDIO.IMPACT.STROKE;
  const layers = ['NOISE_VOL', 'NOISE_HZ', 'NOISE_Q', 'NOISE_DUR', 'BODY_VOL', 'BODY_HZ', 'BODY_DROP', 'BODY_DUR'];
  // audio.js#strokeVoice / sfx.serve が引ける名前がすべて存在すること
  for (const name of ['flat', 'top', 'slice', 'drop', 'volley', 'smash', 'serve', 'serveTop', 'serveSlice']) {
    ok(S[name] && layers.every((k) => typeof S[name][k] === 'number'),
      `AUDIO.IMPACT.STROKE.${name} defines every layer`);
  }
  // 「聞き分けられる」＝実際に差がついていること
  ok(S.slice.BRUSH_VOL > S.top.BRUSH_VOL && S.top.BRUSH_VOL > S.flat.BRUSH_VOL,
    'slice hisses more than topspin, and topspin more than flat (BRUSH_VOL)');
  ok(S.slice.NOISE_HZ > S.flat.NOISE_HZ && S.flat.NOISE_HZ > S.top.NOISE_HZ,
    'slice is the thinnest/highest and topspin the dullest (NOISE_HZ)');
  ok(S.smash.NOISE_VOL > S.flat.NOISE_VOL && S.flat.NOISE_VOL > S.drop.NOISE_VOL,
    'a smash is the loudest impact and a drop shot the softest');
  ok(S.volley.BODY_DUR < S.flat.BODY_DUR && S.volley.NOISE_DUR < S.flat.NOISE_DUR,
    'a blocked volley is the shortest impact');

  const B = AUDIO.BOUNCE;
  for (const name of Object.keys(R.config.SURFACE_PRESETS)) {
    ok(B.SURFACE[name], `AUDIO.BOUNCE.SURFACE covers the '${name}' court`);
  }
  ok(B.SURFACE.hard.BODY_HZ > B.SURFACE.clay.BODY_HZ && B.SURFACE.clay.BODY_HZ > B.SURFACE.grass.BODY_HZ,
    'hard courts ring highest, grass lowest');
  ok(B.SURFACE.clay.NOISE_DUR > B.SURFACE.hard.NOISE_DUR,
    'clay keeps a longer gritty hiss than hard');
  ok(B.SPIN.top.VOL > B.SPIN.flat.VOL && B.SPIN.flat.VOL > B.SPIN.drop.VOL,
    'a topspin bounce kicks louder than flat, and a drop shot dies quietest');
  ok(B.SPIN.slice.SKID_VOL > 0 && B.SPIN.flat.SKID_VOL === 0,
    'only the sliding shots (slice/drop) get a skid hiss');
  ok(B.SPEED_MIN_MULT < 1 && B.SPEED_MAX_MULT > 1 && B.SPEED_REF > 0,
    'bounce volume scales around a reference landing speed');

  // ポイントが決まったときの「ポン」という電子音は廃止し、歓声と拍手だけで勝敗を示す
  const C = AUDIO.CROWD;
  ok(AUDIO.WAVES === undefined,
    'the single-oscillator point beep (and its WAVES table) is gone');
  ok(C.WINNER_VOL_MULT.you > C.WINNER_VOL_MULT.cpu
    && C.WINNER_FILTER_MULT.you > C.WINNER_FILTER_MULT.cpu,
    'the crowd swells louder and brighter when you win the point than when the CPU does');
  ok(C.CLAP && C.CLAP.MAX > C.CLAP.MIN && C.CLAP.WINDOW > 0 && C.CLAP.DUR > 0,
    'applause scatters more claps as the point gets more exciting');

  // SURFACE.NAME は audio.js がバウンド音を選ぶのに使う（applySurface で切り替わること）
  R.config.applySurface('clay');
  ok(R.config.SURFACE.NAME === 'clay', 'applySurface() updates SURFACE.NAME for the bounce voice');
  R.config.applySurface('hard');
  ok(R.config.SURFACE.NAME === 'hard', 'applySurface() switches SURFACE.NAME back');
}


// --- 移動は加速度ベース：急に最高速にならず、離しても急停止しない（滑るような自然さ） ---
{
  const input = { moveX: 0, moveZ: 1, lob: false };
  const g = new R.Game({ input, hooks: noHooks });
  g.start();
  g.serve('you'); // rally phase にしてフットフォルト制限の狭い可動域を外す
  g.you.x = 0; g.you.z = -5; g.you.vx = 0; g.you.vz = 0;

  g.movePlayers(1 / 60); // たった1フレーム
  const earlySpeed = Math.hypot(g.you.vx, g.you.vz);
  ok(earlySpeed > 0 && earlySpeed < PLAYER.SPEED - 0.01,
    `after 1 frame, speed ramps up rather than snapping to max: ${earlySpeed}`);

  for (let i = 0; i < 60; i++) g.movePlayers(1 / 60); // 加速しきるのに十分な時間
  const cruiseSpeed = Math.hypot(g.you.vx, g.you.vz);
  // 走った分だけスタミナがわずかに減っている（STAMINA.DRAIN_PER_M）ので、
  // 1秒弱走った後の上限速度は PLAYER.SPEED よりほんの少しだけ低い。
  ok(Math.abs(cruiseSpeed - PLAYER.SPEED) < 0.1, `eventually reaches (near) full speed: ${cruiseSpeed}`);

  input.moveZ = 0; // 入力を離す
  g.movePlayers(1 / 60);
  const afterRelease = Math.hypot(g.you.vx, g.you.vz);
  ok(afterRelease > 0.01 && afterRelease < PLAYER.SPEED - 0.01,
    `releasing input doesn't stop instantly: ${afterRelease}`);

  for (let i = 0; i < 60; i++) g.movePlayers(1 / 60);
  ok(Math.hypot(g.you.vx, g.you.vz) < 0.01, 'eventually comes to a full stop');
}

// --- Space を溜めるほど強い球になる（ラリー） ---
{
  const { TAP_T, CHARGE_T, LOB_T } = R.config.SHOT;
  const { MAX_TIME } = R.config.CHARGE;

  // タップ（溜め0）: 通常球
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.chargeStart();
    ok(g.you.charging === true, 'holding Space starts charging');
    g.chargeRelease();
    ok(g.you.charging === false, 'releasing stops charging');
    ok(g.you.swingCharge === 0, `tap with no hold time -> charge 0, got ${g.you.swingCharge}`);
    ok(g.playerShot().flight === TAP_T, `tap -> TAP_T flight, got ${g.playerShot().flight}`);
  }

  // 最大まで溜めてから離す: 強打
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.chargeStart();
    for (let i = 0; i < 60; i++) g.update(1 / 60); // 1秒 > MAX_TIME、頭打ちを確認
    ok(g.you.chargeTime === MAX_TIME, `charge caps at MAX_TIME, got ${g.you.chargeTime}`);
    g.chargeRelease();
    ok(g.you.swingCharge === 1, `full charge -> swingCharge 1, got ${g.you.swingCharge}`);
    // lerp の丸め誤差があるので厳密比較はしない
    ok(Math.abs(g.playerShot().flight - CHARGE_T) < 1e-9,
      `full charge -> CHARGE_T flight, got ${g.playerShot().flight}`);
  }

  // 溜め量に応じて連続的に威力が変わる（中間の溜めは TAP_T と CHARGE_T の間）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.chargeStart();
    for (let i = 0; i < Math.round(MAX_TIME * 30); i++) g.update(1 / 60); // MAX_TIME の約半分
    g.chargeRelease();
    const flight = g.playerShot().flight;
    ok(flight < TAP_T && flight > CHARGE_T, `partial charge is between TAP_T and CHARGE_T, got ${flight}`);
  }

  // ロブは溜め量に関わらず最優先
  {
    const input = { moveX: 0, moveZ: 0, lob: true };
    const g = new R.Game({ input, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.chargeStart();
    for (let i = 0; i < 60; i++) g.update(1 / 60);
    g.chargeRelease();
    ok(g.playerShot().flight === LOB_T, `lob overrides charge, got ${g.playerShot().flight}`);
  }
}

// --- 溜め：フル溜めに要する時間が短すぎない／少し動いているだけでもキャップが効く ---
// (退行テスト: MAX_TIME が短く(0.55秒)、かつ MOVE_CAP_SPEED_START が高い(0.5m/s)ままだと、
//  位置取りで少し動いている程度の「よくある状況」でもキャップが発動せず、ほとんどの状況で
//  楽にフル溜めできてしまっていた)
{
  const { MAX_TIME } = R.config.CHARGE;
  ok(MAX_TIME >= 0.7,
    `full charge should take meaningfully more than half a second to discourage easy MAX charging, got ${MAX_TIME}`);

  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  ok(g.chargeSpeedCap(0) === 1, 'standing still: no cap on the charge');
  ok(g.chargeSpeedCap(0.3) < 1,
    `even modest movement (0.3 m/s, well below a real sprint) already reduces the charge cap, got ${g.chargeSpeedCap(0.3)}`);
}

// --- 溜めの強弱が体感できる差になっている（初速・深さ・演出）---
// 「溜めても変わった気がしない」という退行を防ぐため、最低限の差を数値で固定する。
{
  const hitWith = (charge) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    // 溜めの差だけを見るので無風にする（滞空の長い溜めなしの球ほど追い風／向かい風で深さが変わる）
    g.windStrength = 0;
    g.setWindVector();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -5;
    g.ball.x = 0.3; g.ball.y = 1.0; g.ball.z = -5;
    g.ball.bounces = 1; // 既にバウンド済みの通常のグラウンドストローク（ボレー扱いにしない）
    g.you.swingCharge = charge;
    g.hit('you');
    return {
      speed: Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz),
      landing: R.physics.predictLanding(g.ball),
      impact: g.ball.impact,
      power: g.ball.impactPower,
    };
  };
  const tapShot = hitWith(0);
  const fullShot = hitWith(1);

  ok(fullShot.speed > tapShot.speed * 2.1,
    `full charge should be at least 110% faster: tap=${tapShot.speed.toFixed(1)} full=${fullShot.speed.toFixed(1)}`);
  ok(fullShot.landing.z > tapShot.landing.z + 4.5,
    `full charge should land clearly deeper: tap=${tapShot.landing.z.toFixed(1)} full=${fullShot.landing.z.toFixed(1)}`);
  ok(fullShot.impact > tapShot.impact,
    `full charge should have a longer impact effect: tap=${tapShot.impact} full=${fullShot.impact}`);
  ok(fullShot.power === 1 && tapShot.power === 0,
    `impactPower carries the charge for the FX layer: tap=${tapShot.power} full=${fullShot.power}`);

  // 深く打ってもコート内に収まること（アウトばかりになっていないか）
  let out = 0;
  for (let i = 0; i < 100; i++) if (hitWith(1).landing.z > HALF_L) out++;
  ok(out === 0, `full-charge shots should still land in: ${out}/100 went long`);
}

// --- 振り出すタイミングでコースがずれる（早い=引っ張る／遅い=流れる、フォアとバックで逆） ---
{
  const { NEUTRAL_WAIT_T, PULL_BAND_T, FLOW_BAND_T, EDGE_X } = R.config.TIMING_AIM;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.you.x = 0; // baseX を固定するため

  const early = NEUTRAL_WAIT_T + PULL_BAND_T; // timing = +1（長く待った＝早く振り出した）
  const late = NEUTRAL_WAIT_T - FLOW_BAND_T;  // timing = -1（引きつけて振った）
  const neutral = NEUTRAL_WAIT_T;             // timing = 0（ずれない）

  // ばらつき（ライン際を狙ったときの荒れ）は preview=true で中央値に固定して見る
  const foreEarly = g.playerShot('forehand', early, true).target.x;
  const foreLate = g.playerShot('forehand', late, true).target.x;
  const foreNeutral = g.playerShot('forehand', neutral, true).target.x;
  const backEarly = g.playerShot('backhand', early, true).target.x;
  const backLate = g.playerShot('backhand', late, true).target.x;

  ok(late <= 1 / 60 + 1e-9,
    `the flow end is reachable within a frame of the ball arriving, needs waited=${late.toFixed(3)}s`);
  // 目一杯ずらすと、狙いがどこであれ「ずれる側のコートの端」へ届く。
  // 右利きなので、フォアの引っ張りは world +x（画面の左）、流しは world -x（画面の右）。
  ok(Math.abs(foreEarly - EDGE_X) < 1e-9,
    `a full pull lands at the pull-side edge, got ${foreEarly.toFixed(2)}`);
  ok(Math.abs(foreLate + EDGE_X) < 1e-9,
    `a full flow lands at the flow-side edge, got ${foreLate.toFixed(2)}`);
  ok(Math.abs(foreNeutral - (-R.config.SHOT.DEFAULT_X)) < 1e-9,
    `neutral timing keeps the arrow-key aim untouched, got ${foreNeutral.toFixed(2)}`);

  // フォアとバックでは体を横切る向きが逆なので、同じ早い/遅いでもずれる方向が逆になる
  ok(Math.sign(backEarly) === -Math.sign(foreEarly),
    `backhand early pulls the OPPOSITE way from forehand early: fore=${foreEarly.toFixed(2)} back=${backEarly.toFixed(2)}`);
  ok(Math.sign(backLate) === -Math.sign(foreLate),
    `backhand late flows the OPPOSITE way from forehand late: fore=${foreLate.toFixed(2)} back=${backLate.toFixed(2)}`);

  // ロブはタイミングの影響を受けない
  const input2 = { moveX: 0, moveZ: 0, lob: true };
  const gLob = new R.Game({ input: input2, hooks: noHooks });
  gLob.you.x = 0;
  const lobEarly = gLob.playerShot('forehand', early, true).target.x;
  const lobLate = gLob.playerShot('forehand', late, true).target.x;
  ok(lobEarly === lobLate, `lob ignores timing, got early=${lobEarly} late=${lobLate}`);

  // ←→ の方向指定は「タイミングがずれていないとき」の狙いを決め、タイミングはそこから
  // コートの端へ寄せる（足し算ではない）。方向キーを押していても端は越えない。
  // フォアの流し側（world -x ＝ 画面の右）へ、方向キーでも寄せてみる
  const input3 = { moveX: 1, moveZ: 0, lob: false }; // 画面右 = world -x
  const gAim = new R.Game({ input: input3, hooks: noHooks });
  gAim.you.x = 0;
  ok(Math.abs(gAim.playerShot('forehand', neutral, true).target.x + R.config.SHOT.AIM_X) < 1e-9,
    'with neutral timing the ball goes exactly where the arrow key aims');
  ok(Math.abs(gAim.playerShot('forehand', late, true).target.x + EDGE_X) < 1e-9,
    'a full flow aims at the edge, not past it, even when aiming that way too');

  // 素直なタイミングならコート内に収まる
  let out = 0;
  for (let i = 0; i < 100; i++) {
    const gg = new R.Game({ input: fakeInput, hooks: noHooks });
    gg.start();
    gg.phase = 'rally';
    gg.you.x = 0; gg.you.z = -5;
    gg.ball.x = 0.3; gg.ball.y = 1.0; gg.ball.z = -5 + 0.9;
    gg.ball.bounces = 1; // 既にバウンド済みの通常のグラウンドストローク（ボレー扱いにしない）
    gg.hit('you');
    if (R.physics.predictLanding(gg.ball).z > HALF_L) out++;
  }
  ok(out === 0, `normal-timing shots should still land in: ${out}/100 went long`);
}

// --- どの狙い・どの打ち方からでも、引きつければ必ず「流し」側へ届く ---
// (退行テスト: タイミングのずれを狙いに「足す」形だった頃は、ずれ幅(1.3m)より狙い
//  （←→ で2.7m、無入力でも1.4m）のほうが大きく、目一杯引きつけても反対側へ出られなかった。
//  実測：方向キーなしのフォアで着地点はど真ん中(-0.1m)止まり、←を押しながらだと-1.4mのまま
//  ＝ユーザー報告「素通りするくらい引き寄せて待っても真ん中までしか飛ばない」)
{
  const { NEUTRAL_WAIT_T, PULL_BAND_T, FLOW_BAND_T } = R.config.TIMING_AIM;
  const { setRating, resetRatings } = R.config;
  const cases = [];
  for (const consistency of [1, 3, 5]) {          // 能力値「安定感」（ずれにくさ）
    resetRatings();
    setRating('you', 'consistency', consistency);
    for (const stroke of ['forehand', 'backhand']) {
      for (const moveX of [0, -1, 1]) {            // 方向キーなし／→／←
        for (const youX of [2, -2]) {              // 自分がコートのどちら側にいるか
          const g = new R.Game({ input: { moveX, moveZ: 0, lob: false }, hooks: noHooks });
          g.you.x = youX;
          // 流しの向き（world x）。右利きなのでフォアは -x（画面の右）へ流れる。
          const flowSide = stroke === 'forehand' ? -1 : 1;
          const flow = g.playerShot(stroke, NEUTRAL_WAIT_T - FLOW_BAND_T, true).target.x;
          const pull = g.playerShot(stroke, NEUTRAL_WAIT_T + PULL_BAND_T, true).target.x;
          cases.push({
            consistency, stroke, moveX, youX, flow, pull,
            // 「流し側へ届く」＝コートの真ん中を越えて自分のラケット側へ出ること。
            // 能力値「安定感」を上げているとずれ幅そのものは小さくなる（そういう能力）が、
            // それでも必ず反対側へは出る。
            flowOk: flow * flowSide > 0,
            pullOk: pull * flowSide < 0,
            far: consistency !== 3 || flow * flowSide > 1.5,
          });
        }
      }
    }
  }
  resetRatings();
  const badFlow = cases.filter((c) => !c.flowOk);
  const badPull = cases.filter((c) => !c.pullOk);
  ok(badFlow.length === 0,
    `drawing the ball in always reaches the flow side: ${badFlow.length}/${cases.length} failed`
    + (badFlow[0] ? ` e.g. ${badFlow[0].stroke} moveX=${badFlow[0].moveX} x=${badFlow[0].flow.toFixed(2)}` : ''));
  ok(badPull.length === 0,
    `swinging early always reaches the pull side: ${badPull.length}/${cases.length} failed`);
  const timid = cases.filter((c) => !c.far);
  ok(timid.length === 0,
    `with default skills it is not just barely across, but a real angle: ${timid.length} too timid`);
  // そして狙いそのものはコートの中（サイドラインの内側）。実際の着地はここから
  // ライン際のばらつき（RISK_SPREAD）ぶん散るので、外れることもある（別テスト）。
  const wide = cases.filter((c) => Math.abs(c.flow) > HALF_W || Math.abs(c.pull) > HALF_W);
  ok(wide.length === 0, `and none of them aim past the sideline: ${wide.length}/${cases.length}`);
}

// --- 打ち分けは「スイングがボールを待った時間」で決まる（打点の位置ではない） ---
// (退行テスト: 打点の前後位置で測っていた頃は、ボールが手の届く範囲にいる時間が
//  実測48ms・最短8msしかないため、引っ張りと流しを撃ち分ける猶予が1〜3フレームしかなく、
//  実際には「間に合ううちに振る」＝常に引っ張りにしかならなかった＝流し方向へ打てない)
{
  const { PLAYER, TIMING_AIM } = R.config;
  // 溜めキーを離してからボールが来るまでの待ち時間だけを変えて、同じ打点で打つ
  const landingFor = (waitFrames) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -5;
    g.ball.x = 0.3; g.ball.y = 1.0; g.ball.z = -5 + 0.9;
    g.ball.bounces = 1;
    g.chargeRelease(); // ここで振り出す（swing = SWING_WINDOW）
    g.you.swing = PLAYER.SWING_WINDOW - waitFrames / 60; // waitFrames ぶん待ってから当たった
    g.hit('you');
    return R.physics.predictLanding(g.ball).x;
  };
  // 狙う深さのばらつき（SHOT.DRIVE_Z_SPREAD）が着地点の左右にも効くので、乱数は固定する
  const origRandom = Math.random;
  Math.random = () => 0.5;
  let drawnIn;
  let onTime;
  let early;
  try {
    drawnIn = landingFor(0); // ボールが来てから離した＝待ち時間ゼロ＝流し
    onTime = landingFor(Math.round(TIMING_AIM.NEUTRAL_WAIT_T * 60));
    early = landingFor(Math.round((TIMING_AIM.NEUTRAL_WAIT_T + TIMING_AIM.PULL_BAND_T) * 60));
  } finally {
    Math.random = origRandom;
  }
  ok(drawnIn > onTime + 2,
    `releasing as the ball arrives flows well to the other side: drawnIn=${drawnIn.toFixed(1)} onTime=${onTime.toFixed(1)}`);
  ok(early < onTime - 2,
    `releasing early pulls the other way: early=${early.toFixed(1)} onTime=${onTime.toFixed(1)}`);
  ok(Math.abs(drawnIn) < HALF_W && Math.abs(early) < HALF_W,
    `and neither extreme sails past the sideline: flow=${drawnIn.toFixed(1)} pull=${early.toFixed(1)}`);

  // 打ち分けに使える幅（0〜HALF_BAND_T×2）が、スイングの有効時間に収まっていること。
  // ここがはみ出していると、目一杯引っ張ろうとしただけで空振りになる。
  ok(TIMING_AIM.NEUTRAL_WAIT_T + TIMING_AIM.PULL_BAND_T <= PLAYER.SWING_WINDOW,
    `a full pull still connects: needs ${TIMING_AIM.NEUTRAL_WAIT_T + TIMING_AIM.PULL_BAND_T}s of a ${PLAYER.SWING_WINDOW}s window`);
  // かつ、打ち分けの幅が実測の「ボールが打てる範囲にいる時間」(約48ms)より広いこと
  ok(TIMING_AIM.FLOW_BAND_T + TIMING_AIM.PULL_BAND_T >= 0.08,
    `the pull-to-flow range is wide enough to aim with, got ${TIMING_AIM.FLOW_BAND_T + TIMING_AIM.PULL_BAND_T}s`);
}

// --- やりすぎるとミスも起きる：ライン際まで狙いを振るとサイドアウトすることがある ---
{
  const {
    NEUTRAL_WAIT_T, PULL_BAND_T, FLOW_BAND_T, RISK_FROM_X, EDGE_X, RISK_SPREAD,
  } = R.config.TIMING_AIM;
  const { setRating, resetRatings } = R.config;

  /** その待ち時間で N 本打って、サイドアウトした割合と着地点の散らばりを見る */
  const outRate = (waited, n = 400) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.you.x = 0;
    let out = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const { x } = g.playerShot('forehand', waited).target;
      if (Math.abs(x) > HALF_W) out++;
      min = Math.min(min, x); max = Math.max(max, x);
    }
    return { rate: out / n, min, max };
  };

  const full = outRate(NEUTRAL_WAIT_T - FLOW_BAND_T);   // 目一杯引きつけた＝ライン際狙い
  const half = outRate(NEUTRAL_WAIT_T - FLOW_BAND_T / 2); // 半分だけ流した
  const straight = outRate(NEUTRAL_WAIT_T);              // 素直に打った
  const fullPull = outRate(NEUTRAL_WAIT_T + PULL_BAND_T);

  ok(full.rate > 0.05 && full.rate < 0.45,
    `going for the maximum angle misses sometimes, but not usually: ${(full.rate * 100).toFixed(0)}%`);
  ok(fullPull.rate > 0.05 && fullPull.rate < 0.45,
    `the same on the pull side: ${(fullPull.rate * 100).toFixed(0)}%`);
  ok(straight.rate === 0 && straight.min === straight.max,
    'a straight (neutral) shot never wanders and never goes wide');
  ok(half.rate === 0,
    `easing off the extreme is completely safe: ${(half.rate * 100).toFixed(0)}% out`);
  ok(RISK_FROM_X > R.config.SHOT.AIM_X,
    `aiming with the arrow keys alone stays inside the safe zone: aim=${R.config.SHOT.AIM_X} risk from ${RISK_FROM_X}`);
  // 流し側（右利きのフォアなら world -x）へ振り切ったときの散らばり。符号は利き手で
  // 変わるので、ラインを割ったかどうかは絶対値で見る。
  ok(Math.abs(full.max - full.min) <= RISK_SPREAD * 2 + 1e-9
    && Math.max(Math.abs(full.min), Math.abs(full.max)) > HALF_W,
    `the spread at the edge is what puts it out: ${full.min.toFixed(2)}〜${full.max.toFixed(2)} (line ${HALF_W.toFixed(2)})`);

  // 能力値「安定感」が高いほど散らない＝ミスも減る
  try {
    setRating('you', 'consistency', 5);
    const steady = outRate(NEUTRAL_WAIT_T - FLOW_BAND_T);
    ok(steady.rate < full.rate,
      `a steadier player misses less when going for the line: ${(steady.rate * 100).toFixed(0)}% vs ${(full.rate * 100).toFixed(0)}%`);
  } finally {
    resetRatings();
  }

  // ガイドは「いまライン際を狙っている」ことを risk で伝える（表示側が警告に使う）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.you.x = 0;
    ok(g.playerShot('forehand', NEUTRAL_WAIT_T - FLOW_BAND_T, true).risk > 0,
      'the preview reports how much the aim wanders at the edge');
    ok(g.playerShot('forehand', NEUTRAL_WAIT_T, true).risk === 0,
      'and reports no wander for a straight shot');
    ok(Math.abs(g.playerShot('forehand', NEUTRAL_WAIT_T - FLOW_BAND_T, true).target.x + EDGE_X) < 1e-9,
      'the preview itself shows the middle of that spread (the aim), not a random draw');
  }
}

// --- 打ち分けが段階的に跳ばない（離すタイミングの細かさが結果に出る） ---
// (退行テスト: スイングの有効時間(you.swing)を1フレーム(1/60秒)ぶんまとめて減らしていた
//  頃は、当たり判定が 1/240秒 刻みなのに待ち時間は 1/60秒 刻みでしか測れず、離す距離を
//  2cm ずつ変えても結果は7段階、流し側にいたっては2段階（-0.27 と -0.93）しかなかった
//  ＝「引きつけると急に大きく曲がる」カクついた打ち分けになっていた)
{
  const { TIMING_AIM } = R.config;
  const landings = new Set();
  const timings = [];
  const origHit = R.Game.prototype.hit;
  for (let d = 1.0; d <= 4.0; d += 0.05) {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -8;
    Object.assign(g.ball, {
      x: 0.3, y: 1.1, z: -8 + d, vx: 0, vy: -0.3, vz: -9,
      bounces: 1, live: true, last: 'cpu', spin: 'flat', wind: 0, age: 0.5,
    });
    let waited = null;
    R.Game.prototype.hit = function hit(who) {
      if (who === 'you' && waited === null) waited = this.swingWaited();
      origHit.call(this, who);
    };
    try {
      g.chargeStart('flat');
      g.chargeRelease();
      for (let i = 0; i < 30 && waited === null && g.phase === 'rally'; i++) g.update(1 / 60);
    } finally {
      R.Game.prototype.hit = origHit;
    }
    if (waited !== null) {
      const off = waited - TIMING_AIM.NEUTRAL_WAIT_T;
      const timing = Math.max(-1, Math.min(1,
        off / (off >= 0 ? TIMING_AIM.PULL_BAND_T : TIMING_AIM.FLOW_BAND_T)));
      timings.push(timing);
      landings.add(timing.toFixed(2));
    }
  }
  ok(landings.size >= 15,
    `releasing a little later gives a little more flow, not a jump: ${landings.size} distinct steps`);
  const flowSteps = [...new Set(timings.filter((t) => t < 0).map((t) => t.toFixed(2)))];
  ok(flowSteps.length >= 4,
    `the flow half alone is graded, not on/off: ${flowSteps.length} steps (${flowSteps.join(',')})`);
  // 隣り合う段の差（＝1段階でどれだけコースが変わるか）が大きすぎないこと
  const sorted = [...timings].sort((a, b) => a - b);
  const gap = sorted.reduce((max, t, i) => (i === 0 ? max : Math.max(max, t - sorted[i - 1])), 0);
  ok(gap <= 0.35, `no single step jumps more than a third of the range, got ${gap.toFixed(2)}`);
}

// --- ガイド付きモード：溜めている間、「いま離したらどこへ飛ぶか」を出す ---
{
  const { PLAYER, GUIDE } = R.config;
  /** 自分に向かってまっすぐ飛んでくる、バウンド済みの球を作って溜め始めた状態 */
  const charging = (guideOn) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.setGuide(guideOn);
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -8;
    Object.assign(g.ball, {
      x: 0.4, y: 1.2, z: -2.0, vx: 0, vy: -1.0, vz: -14,
      bounces: 1, live: true, last: 'cpu', spin: 'flat', wind: 0, age: 0.5,
    });
    g.chargeStart('flat');
    return g;
  };

  // ガイドを切っていれば何も出ない（既定はガイドなし）
  {
    const g = charging(false);
    g.update(1 / 60);
    ok(g.swingGuide === null, 'no guide unless the guided mode is on');
    ok(new R.Game({ input: fakeInput, hooks: noHooks }).guide === false,
      'the guided mode is off by default');
  }

  // 溜めながら待つほど、引っ張り→素直→流しへ連続的に変わっていく
  {
    const g = charging(true);
    const seen = [];
    for (let i = 0; i < 40 && g.you.charging && g.phase === 'rally'; i++) {
      g.update(1 / 60);
      if (g.swingGuide) seen.push({ ...g.swingGuide });
    }
    ok(seen.length > 5, `the guide is produced every frame while charging, got ${seen.length}`);
    ok(seen[0].tooEarly === true,
      'while the ball is still far, it says releasing now would miss entirely');
    const last = seen[seen.length - 1];
    ok(last.tooEarly === false && last.timing < -0.9,
      `by the time the ball is on you it reads as a full flow shot, got timing=${last.timing}`);
    ok(seen.some((s) => Math.abs(s.timing) <= GUIDE.NEUTRAL_BAND),
      'and it passes through the straight (no shift) zone on the way');
    // タイミングが遅くなる（＝待ち時間が短くなる）順に並んでいること
    const waits = seen.map((s) => s.waited);
    ok(waits.every((w, i) => i === 0 || w <= waits[i - 1] + 1e-9),
      'the waiting time counts down as the ball approaches');
  }

  // ガイドの着地点は、実際にその待ち時間で打ったときの着地点そのもの（左右も深さも）
  {
    const g = charging(true);
    for (let i = 0; i < 18 && g.you.charging && g.phase === 'rally'; i++) g.update(1 / 60);
    const guide = g.swingGuide;
    ok(!!guide && !guide.tooEarly, 'precondition: the guide is showing a real shot');
    ok(guide.timingMatters === true, 'precondition: a groundstroke, where timing does change the course');
    const shot = g.playerShot(guide.stroke, guide.waited, true);
    ok(Math.abs(shot.target.x - guide.x) < 1e-9 && Math.abs(shot.target.z - guide.z) < 1e-9,
      `the guide shows the same spot the shot would land: guide=(${guide.x},${guide.z}) shot=(${shot.target.x},${shot.target.z})`);
  }

  // 打点タイミングが効かない打ち方（ボレー・スマッシュ）は、ガイドもそう言う
  // (退行テスト: グラウンドストロークのつもりで方向を出していたため、ネット前のボレーや
  //  スマッシュになる球でも「引っ張り／流し」と表示していた＝ガイドが嘘をついていた)
  {
    const g = charging(true);
    g.you.z = -3; // サービスラインより前＝ノーバウンドで触ればボレー
    g.ball.bounces = 0;
    g.ball.z = -2.2; g.ball.y = 1.0;
    g.update(1 / 60);
    ok(g.swingGuide.stroke.startsWith('volley-'),
      `a no-bounce ball taken inside the service line reads as a volley, got ${g.swingGuide.stroke}`);
    ok(g.swingGuide.timingMatters === false, 'and the guide says the timing does not change its course');
  }
  {
    const g = charging(true);
    g.you.chargeTime = R.config.CHARGE.MAX_TIME; // しっかり溜めた＝スマッシュの条件
    g.ball.bounces = 0;
    g.ball.y = R.config.PLAYER.SMASH_MIN_Y + 0.3;
    g.ball.z = g.you.z + 0.5;
    g.ball.vy = -2;
    g.update(1 / 60);
    ok(g.swingGuide.stroke === 'smash', `a high ball with a full charge reads as a smash, got ${g.swingGuide.stroke}`);
    ok(g.swingGuide.timingMatters === false, 'and the timing does not change a smash either');
  }

  // 打った瞬間（溜めが終わる）と、ラリー以外の場面では出さない
  {
    const g = charging(true);
    g.update(1 / 60);
    ok(g.swingGuide !== null, 'precondition: showing while charging');
    g.chargeRelease();
    g.update(1 / 60);
    ok(g.swingGuide === null, 'the guide disappears once the swing is released');
  }

  // スイングの有効時間より遠い球には「まだ早い」を出す（＝いま離すと空振り）
  {
    const g = charging(true);
    g.ball.z = -8 + PLAYER.REACH + 6; // 6m 先＝どう見ても届かない
    g.update(1 / 60);
    ok(g.swingGuide.tooEarly === true, 'a ball that far away cannot be hit by releasing now');
  }
}

// --- サーブの溜め：ゲージの線（9割の位置＝CHARGE_SWEET_T）まで溜めたときが最大威力。
//     線を超えても威力は増えず、超えた度合いに応じてフォールトの確率だけが上がる ---
{
  const {
    T, CHARGE_T, CHARGE_SWEET_T, CHARGE_SWEET_MARK, CHARGE_SWEET_HOLD, CHARGE_FAULT_T,
  } = R.config.SERVE;

  // 威力のカーブ（純粋関数として）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    ok(g.serveTimingPower(CHARGE_SWEET_T) === 1, 'reaching the line is max power');
    ok(g.serveTimingPower(0) === 0, 'releasing immediately has no power at all');
    ok(g.serveTimingPower(CHARGE_SWEET_T / 2) > 0
      && g.serveTimingPower(CHARGE_SWEET_T / 2) < 1, 'power grows with the hold time up to the line');
    ok(g.serveTimingPower(CHARGE_SWEET_T * 0.4) < g.serveTimingPower(CHARGE_SWEET_T * 0.8),
      'holding longer (but still short of the line) is stronger');
    const fullT = CHARGE_SWEET_T / CHARGE_SWEET_MARK;
    ok(g.serveTimingPower((CHARGE_SWEET_T + fullT) / 2) === 1 && g.serveTimingPower(fullT) === 1,
      'holding past the line (up to a full gauge) does not add power (the risk goes up instead, not the power)');
    // 満タンの後も押し続けると溜めが抜けていき、ゲージが線より下へ戻ったところから威力も落ちる
    const { CHARGE_DRAIN } = R.config.SERVE;
    const backToLine = fullT + (fullT - CHARGE_SWEET_T) / CHARGE_DRAIN;
    ok(Math.abs(g.serveTimingPower(backToLine) - 1) < 1e-9,
      'the power holds while the draining gauge is still above the line');
    const p1 = g.serveTimingPower(backToLine + 0.05);
    const p2 = g.serveTimingPower(backToLine + 0.15);
    ok(p1 < 1 && p2 < p1, `keeping on holding after a full gauge weakens the serve: ${p1.toFixed(2)} > ${p2.toFixed(2)}`);
    ok(g.serveTimingPower(fullT + fullT / CHARGE_DRAIN + 0.1) === 0, 'held long enough, the charge drains away completely');
  }

  // フォールト確率のカーブ
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    ok(g.serveFaultChance(0) === 0, 'no fault risk when barely charged');
    ok(g.serveFaultChance(CHARGE_SWEET_T) === 0, 'releasing right on the line never faults from overcharge');
    ok(g.serveFaultChance(CHARGE_SWEET_T + CHARGE_SWEET_HOLD) === 0,
      'a hair past the line is still inside the grace window');
    const little = g.serveFaultChance(CHARGE_SWEET_T + CHARGE_SWEET_HOLD + CHARGE_FAULT_T * 0.25);
    const lots = g.serveFaultChance(CHARGE_SWEET_T + CHARGE_SWEET_HOLD + CHARGE_FAULT_T * 0.75);
    ok(little > 0 && little < lots && lots < 1,
      `the further past the line, the likelier a fault: little=${little} lots=${lots}`);
    ok(g.serveFaultChance(CHARGE_SWEET_T + CHARGE_SWEET_HOLD + CHARGE_FAULT_T * 2) === 1,
      'holding well past the line always faults');
    // ゲージが満タンになる頃には無視できない確率になっている（＝満タンまで溜めるのは博打）
    const fullT = CHARGE_SWEET_T / CHARGE_SWEET_MARK;
    ok(g.serveFaultChance(fullT) > 0.1,
      `filling the whole gauge is a real gamble, got ${g.serveFaultChance(fullT)}`);
  }

  // 実際のトス→保持→リリースを通した結果（球速で確認）
  const landingFor = (holdFrames) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    tossAndHit(g, holdFrames);
    return g.ball;
  };
  const speedOf = (ball) => Math.hypot(ball.vx, ball.vy, ball.vz);

  // サーブのコース・深さは毎回ランダム（rand()）なので、そのままだと狙いがばらばらになり、
  // 飛距離の差が溜めの差を上回って球速の比較が成立しない（実測：約10%の確率で逆転していた）。
  // 3本とも同じ狙いになるよう乱数を固定する。
  const origRandom = Math.random;
  Math.random = () => 0.5;
  let tapSpeed;
  let halfSpeed;
  let sweetSpeed;
  try {
    tapSpeed = speedOf(landingFor(0)); // 即リリース＝溜めなし
    halfSpeed = speedOf(landingFor(Math.round(CHARGE_SWEET_T * 30))); // 線の半分まで
    sweetSpeed = speedOf(landingFor(Math.round(CHARGE_SWEET_T * 60))); // 線まで＝最大威力
  } finally {
    Math.random = origRandom;
  }

  ok(sweetSpeed > halfSpeed && halfSpeed > tapSpeed,
    `the longer the charge (up to the line), the faster the serve: sweet=${sweetSpeed.toFixed(2)} half=${halfSpeed.toFixed(2)} tap=${tapSpeed.toFixed(2)}`);
  ok(T > CHARGE_T, 'precondition: SERVE.CHARGE_T should be shorter (faster) than SERVE.T');
  // 「線付近で今まで以上に強いサーブが打てる」＝以前の最大威力(CHARGE_T=0.38)より速い
  ok(CHARGE_T < 0.38, `a line-perfect serve is stronger than it used to be (CHARGE_T=${CHARGE_T} < 0.38)`);
}

// --- タイミングが同じなら球速も同じ：狙いの深さで球速がばらつかない ---
// （「線ぴったりで離したのに、ときどき 82km/h の弱いサーブになる」というユーザー報告。
//  原因は飛翔時間が距離に関係なく固定だったこと＋浅い狙いを引くと solveShot() が
//  ネット回避で滞空時間を伸ばして山なりの遅い球にしていたこと。SERVE.DIST_REF による
//  距離の正規化と、威力に応じた深さの制限（DEPTH_FULL_MAX）で両方をふさいである）
{
  const SWEET_FRAMES = Math.round(SERVE.CHARGE_SWEET_T * 60);
  const speeds = [];
  for (let i = 0; i < 400; i++) {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.started = true;
    g.newPoint();
    tossAndHit(g, SWEET_FRAMES);
    const L = R.physics.predictLanding(g.ball);
    if (L.net) continue; // わざとネットに掛ける1本（SERVE.NET_CHANCE）は別枠
    speeds.push(Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz));
  }
  const min = Math.min(...speeds);
  const max = Math.max(...speeds);
  ok(max / min < 1.15,
    `line-perfect serves all come out at the same speed: ${(min * 3.6).toFixed(0)}〜${(max * 3.6).toFixed(0)}km/h (ratio ${(max / min).toFixed(2)})`);

  // 狙いの距離が変わっても球速が変わらない＝距離で飛翔時間を正規化できていること。
  // ↑（深い）と、無入力（それより手前まで含む）で速さがそろう。
  const avgFor = (moveZ) => {
    const input = { moveX: 0, moveZ, lob: false };
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const g = new R.Game({ input, hooks: noHooks });
      g.started = true;
      g.newPoint();
      tossAndHit(g, SWEET_FRAMES);
      if (R.physics.predictLanding(g.ball).net) continue;
      sum += Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz);
      n++;
    }
    return sum / n;
  };
  const deep = avgFor(1);
  const any = avgFor(0);
  ok(Math.abs(deep - any) / deep < 0.05,
    `aiming deep and aiming anywhere give the same speed: deep=${(deep * 3.6).toFixed(0)} any=${(any * 3.6).toFixed(0)}km/h`);
}

// --- 球種で球速が変わる：フラット＞スライス＞トップスピン（同じタイミングで離した場合） ---
// (以前は球種が実効重力と弾み方を変えるだけで球速は同じだったため、「低く滑るうえに
//  フラットと同じ速さ」のスライスサーブが一方的に得な選択になっていた)
{
  const SWEET_FRAMES = Math.round(SERVE.CHARGE_SWEET_T * 60);
  const speedFor = (spin) => {
    const speeds = [];
    for (let i = 0; i < 200; i++) {
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.started = true;
      g.newPoint();
      tossAndHit(g, SWEET_FRAMES, spin);
      if (R.physics.predictLanding(g.ball).net) continue; // わざとネットに掛ける1本は除く
      speeds.push(Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz));
    }
    return { avg: speeds.reduce((a, b) => a + b, 0) / speeds.length, max: Math.max(...speeds) };
  };
  const flat = speedFor('flat');
  const slice = speedFor('slice');
  const top = speedFor('top');
  ok(flat.avg > slice.avg && slice.avg > top.avg,
    `flat is the fastest serve, then slice, then topspin: ${(flat.avg * 3.6).toFixed(0)} > ${(slice.avg * 3.6).toFixed(0)} > ${(top.avg * 3.6).toFixed(0)}km/h`);
  ok(slice.max < flat.max * 0.95,
    `even the fastest slice serve stays clearly below a flat one: ${(slice.max * 3.6).toFixed(0)} vs ${(flat.max * 3.6).toFixed(0)}km/h`);
  ok(Math.abs(flat.avg / slice.avg - SERVE.SPIN_T_MULT.slice) < 0.03,
    'and the gap is the SPIN_T_MULT ratio (speed = distance / flight time)');
}

// --- 強いサーブはときどきネットに掛かる（弱いサーブはほぼ掛からない） ---
{
  const SWEET_FRAMES = Math.round(SERVE.CHARGE_SWEET_T * 60);
  const netRate = (holdFrames) => {
    let net = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.started = true;
      g.newPoint();
      tossAndHit(g, holdFrames);
      if (R.physics.predictLanding(g.ball).net) net++;
    }
    return net / N;
  };
  const full = netRate(SWEET_FRAMES);
  ok(full > SERVE.NET_CHANCE / 3 && full < SERVE.NET_CHANCE * 2.5,
    `a full-power serve catches the net about SERVE.NET_CHANCE(${SERVE.NET_CHANCE}) of the time, got ${full.toFixed(3)}`);
  // 「絶対に0」ではなく「ほぼ0」で見る。solveShot() はネットの余裕（SERVE.CLEARANCE=0.15m）を
  // 解析的な放物線で確かめるが、実際に飛ばすときの積分（半陰的オイラー）は解析解より
  // わずかに下を通る（誤差はおよそ 0.5*|g|*dt*t ＝数cm）。余裕ぴったりで解けた球だけは
  // その差でネットテープをかすることがある（実測 200,000本中16本＝0.008%）。
  // 威力に比例するリスク（SERVE.NET_CHANCE）が0であることは、この桁の低さで担保できている。
  const soft = netRate(0);
  ok(soft <= 0.004,
    `a serve with no charge at all practically never catches the net (the risk scales with the power), got ${(soft * 100).toFixed(2)}%`);

  // ネットに掛かった1本は「フォールト（ネット）」としてコールされ、セカンドサーブになる
  {
    const calls = [];
    const g = new R.Game({
      input: fakeInput,
      hooks: { ...noHooks, call: (big, sub) => calls.push(`${big}/${sub}`) },
    });
    g.started = true;
    g.newPoint();
    const origRandom = Math.random;
    // 0 なら NET_CHANCE の抽選に必ず当たる（溜めすぎの抽選より後に引かれる）
    Math.random = () => 0;
    try {
      tossAndHit(g, SWEET_FRAMES);
      for (let i = 0; i < 300 && g.phase === 'rally'; i++) g.update(1 / 60);
    } finally {
      Math.random = origRandom;
    }
    ok(g.serveNumber === 2, `a netted first serve is replayed as a second serve, phase=${g.phase}`);
    ok(calls.some((c) => c.startsWith('フォールト/ネット')), `and it is called as a net fault: ${calls.join(' | ')}`);
  }
}

// --- 線を超えて溜めたサーブは、狙いがサービスボックスの外へ外れる形でフォールトする ---
{
  const { CHARGE_SWEET_T, CHARGE_SWEET_HOLD, CHARGE_FAULT_T } = R.config.SERVE;
  const serveWith = (holdFrames, roll) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.started = true;
    g.newPoint();
    const origRandom = Math.random;
    Math.random = () => roll;
    try {
      tossAndHit(g, holdFrames);
    } finally {
      Math.random = origRandom;
    }
    return g;
  };
  const inBox = (g) => {
    const L = R.physics.predictLanding(g.ball);
    return !L.net && Math.abs(L.x) <= HALF_W && L.z > 0 && L.z <= COURT.SERVICE;
  };
  const wayPast = Math.ceil((CHARGE_SWEET_T + CHARGE_SWEET_HOLD + CHARGE_FAULT_T * 2) * 60);

  // 抽選に外れた（roll がフォールト確率より大きい）ときは普通に入る。
  // 少しだけ超えた保持時間（確率25%程度）を roll=0.9 で通す。
  const barelyPast = Math.round((CHARGE_SWEET_T + CHARGE_SWEET_HOLD + CHARGE_FAULT_T * 0.25) * 60);
  const lucky = serveWith(barelyPast, 0.9);
  ok(lucky.you.serveMiss === false, 'precondition: this serve did not draw the fault');
  ok(inBox(lucky), 'a serve that dodged the fault roll still lands in the box');

  // ロング側（FAULT_LONG_CHANCE に当たる roll）とサイド側（外れる roll）の両方を通す。
  // roll は Math.random() を固定した値。0 は「必ず抽選に当たる＋ロングを引く」、
  // 0.9 は「必ず当たる（確率100%なので）＋サイドアウトを引く」。
  const long = serveWith(wayPast, 0);
  ok(long.you.serveMiss === true, 'holding well past the line always draws the fault');
  const longLanding = R.physics.predictLanding(long.ball);
  ok(!inBox(long) && longLanding.z > COURT.SERVICE,
    `overcharging can miss long, got z=${longLanding.z.toFixed(2)} (service line ${COURT.SERVICE})`);

  const wide = serveWith(wayPast, 0.9);
  const wideLanding = R.physics.predictLanding(wide.ball);
  ok(!inBox(wide) && Math.abs(wideLanding.x) > HALF_W,
    `overcharging can miss wide, got x=${wideLanding.x.toFixed(2)} (sideline ${HALF_W})`);

  // フォールトのコールまで通す（1本目ならセカンドサーブへ）
  {
    const calls = [];
    const g = new R.Game({ input: fakeInput, hooks: { ...noHooks, call: (big, sub) => calls.push(`${big}/${sub}`) } });
    g.started = true;
    g.newPoint();
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      tossAndHit(g, wayPast);
      for (let i = 0; i < 300 && g.phase === 'rally'; i++) g.update(1 / 60);
    } finally {
      Math.random = origRandom;
    }
    ok(g.serveNumber === 2, `an overcharged first serve is called a fault and replayed: phase=${g.phase}`);
    ok(calls.some((c) => c.startsWith('フォールト')), `the fault is called out: ${calls.join(' | ')}`);
  }
}

// --- chargeMeter()（HUDゲージ用）はサーブ中は「満タンまでの割合」（線は9割の位置）、
//     ラリー中は溜め時間の割合を返す ---
{
  const { CHARGE_SWEET_T, CHARGE_SWEET_MARK } = R.config.SERVE;
  const { MAX_TIME } = R.config.CHARGE;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  ok(g.chargeMeter() === 0, 'no meter while not charging');

  g.start();
  g.chargeStart(); // サーブのトス＆チャージ開始
  const sweetFrames = Math.round(CHARGE_SWEET_T * 60);
  for (let i = 0; i < sweetFrames; i++) g.update(1 / 60);
  // 線（＝最大威力）に届いたとき、ゲージはまだ満タンではなく CHARGE_SWEET_MARK（9割）。
  ok(Math.abs(g.chargeMeter() - CHARGE_SWEET_MARK) < 0.03,
    `serve meter sits at the line (${CHARGE_SWEET_MARK}) when the power peaks, got ${g.chargeMeter()}`);
  ok(g.serveTimingPower(g.you.chargeTime) === 1, 'and that is indeed max power');
  // さらに保持し続けるとゲージは満タンまで伸び、そこからは減っていく（トスの滞空 約1.03秒より
  // 内側で確認する。それを過ぎるとトスが自動リセットされて溜め自体がキャンセルされる）。
  let peak = 0;
  let peakFrame = 0;
  for (let i = 1; i <= 10; i++) {
    g.update(1 / 60);
    if (g.chargeMeter() > peak) { peak = g.chargeMeter(); peakFrame = i; }
  }
  ok(peak > 0.98, `holding past the line fills the gauge the rest of the way, peak=${peak}`);
  ok(g.isServeOvercharged(), 'past the line the gauge shows the overcharge (red)');
  ok(peakFrame < 10 && g.chargeMeter() < peak, `holding on after a full gauge drains it, ${peak.toFixed(2)} -> ${g.chargeMeter().toFixed(2)}`);
  const drainedAt = [];
  for (let i = 0; i < 8; i++) { g.update(1 / 60); drainedAt.push(g.chargeMeter()); }
  ok(drainedAt.every((m, i) => i === 0 || m < drainedAt[i - 1]), `and keeps draining while held: ${drainedAt.map((m) => m.toFixed(2)).join(' ')}`);
  ok(g.chargeMeter() < CHARGE_SWEET_MARK && g.isServeOvercharged(),
    'even once drained below the line it stays red (the fault risk comes from how long it was held)');
  ok(g.serveTimingPower(g.you.chargeTime) < 1, 'and releasing now gives a weaker serve');
  g.chargeRelease();

  const g2 = new R.Game({ input: fakeInput, hooks: noHooks });
  g2.start();
  g2.phase = 'rally';
  g2.chargeStart();
  for (let i = 0; i < Math.round(MAX_TIME * 30); i++) g2.update(1 / 60); // 半分だけ溜める
  const midMeter = g2.chargeMeter();
  ok(midMeter > 0 && midMeter < 1, `rally meter tracks the plain hold fraction, got ${midMeter}`);
}

// --- 溜め中にポイントが切り替わる/トスが流れると、溜めはキャンセルされる ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.chargeStart(); // トス＆チャージ開始。まだ離さない
  for (let i = 0; i < 10; i++) g.update(1 / 60);
  ok(g.you.charging === true, 'precondition: charging mid-toss');

  for (let i = 0; i < 180 && g.tossActive; i++) g.update(1 / 60); // トスを見送って自動リセットさせる
  ok(g.tossActive === false, 'toss auto-reset while charging');
  ok(g.you.charging === false, 'charging is cancelled when the toss resets');
}

// --- 溜めキーを押しっぱなしのままポイントをまたいでも、次のポイントで構えられる ---
// this.you.charging は「キーが今も押されているか」そのものなので、ポイントが決まった
// 瞬間（phase==='over'）にここを false へ落としてしまうと、キーは押されたままで
// keydown が二度と来ない＝chargeStart() が呼ばれず、次のポイントで構えが出ないまま
// 離しても chargeRelease() が素通りする、という手詰まりになっていた。
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(false, 'cpu'); // cpu のサーブ＝人間はレシーブ側
  g.chargeStart('flat'); // サーブを待ちながらラケットを引く（押したまま離さない）
  ok(g.you.charging === true, 'precondition: holding while waiting for the serve');

  for (let i = 0; i < 60 * 30 && g.phase !== 'over'; i++) g.update(1 / 60);
  ok(g.phase === 'over', 'precondition: the point finished');
  ok(g.you.charging === true, 'the hold survives the end of the point (the key is still down)');
  ok(g.you.chargeTime === 0, 'but the charge itself is emptied between points');

  for (let i = 0; i < 60 * 30 && g.phase !== 'serve'; i++) g.update(1 / 60);
  ok(g.phase === 'serve' && g.servingPlayer() !== 'you', 'precondition: waiting for the next serve');
  for (let i = 0; i < 20; i++) g.update(1 / 60);
  ok(g.you.charging === true, 'still holding into the next point');
  ok(g.you.chargeTime > 0, `the takeback starts filling again, got ${g.you.chargeTime}`);
  ok(g.you.prep !== null, `and the stance is shown again, got ${g.you.prep}`);

  // サーブが来たら、握り直さずに離すだけで溜まったリターンが打てる
  for (let i = 0; i < 60 * 10 && g.phase !== 'rally'; i++) g.update(1 / 60);
  ok(g.phase === 'rally', 'precondition: the serve is on its way');
  g.chargeRelease();
  ok(g.you.swing > 0, 'releasing swings without having to re-press the key');
  ok(g.you.swingCharge > 0, `and the swing carries a real charge, got ${g.you.swingCharge}`);
}

// --- フォールトのコール中に押し直しても、そのまま2本目の構えに入れる ---
// chargeStart() が phase==='serve' しか見ていなかった頃は、この1.3秒の間に押すと
// どこにも引っかからず、キーが押されたままなので握り直しになっていた。
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(false, 'cpu');
  // 1本目をわざとロングにしてフォールトさせる
  for (let i = 0; i < 60 * 60 && g.phase !== 'fault'; i++) {
    g.update(1 / 60);
    if (g.phase === 'rally' && g.serveInFlight) { g.ball.vz *= 1.8; g.ball.vy *= 1.3; }
  }
  ok(g.phase === 'fault', 'precondition: the first serve faulted');
  g.chargeStart('flat');
  ok(g.you.charging === true, 'pressing during the fault call arms the takeback');
  for (let i = 0; i < 20; i++) g.update(1 / 60);
  ok(g.you.chargeTime > 0, `and it fills while waiting for the second serve, got ${g.you.chargeTime}`);
  ok(g.you.prep !== null, `the stance is shown during the fault call, got ${g.you.prep}`);
}

// --- サーブのコースを ←→ で打ち分けられる ---
{
  const { AIM_WIDE_MIN, AIM_WIDE_MAX, AIM_T_MIN, AIM_T_MAX, AIM_BODY_MIN, AIM_BODY_MAX } = SERVE;
  const courseLanding = (moveX) => {
    const input = { moveX, moveZ: 0, lob: false };
    const g = new R.Game({ input, hooks: noHooks });
    g.start();
    tossAndHit(g);
    return R.physics.predictLanding(g.ball);
  };
  // predictLanding() は 1/120s 刻みで着地を検知するため、その1ステップぶん
  // （数cm）だけ境界からずれることがある。実際の物理ステップ(1/240s)には影響しない。
  const STEP_SLACK = 0.05;
  const inRange = (v, min, max) => v >= min - STEP_SLACK && v <= max + STEP_SLACK;

  for (let i = 0; i < 30; i++) {
    // フレッシュな試合は side=-1（クロス）で始まるので、team='you' の targetSign は +1。
    // ワイドは targetSign と同じ向きの入力（aim===targetSign）で出るので、
    // aim = moveX * INPUT_X_TO_WORLD(-1) = +1 となる moveX=-1 がワイド。
    const wide = courseLanding(-1);
    ok(inRange(Math.abs(wide.x), AIM_WIDE_MIN, AIM_WIDE_MAX), `wide course: |x|=${wide.x}`);
    ok(wide.x > 0, `wide course lands in the correct box: x=${wide.x}`);

    const t = courseLanding(1);
    ok(inRange(Math.abs(t.x), AIM_T_MIN, AIM_T_MAX), `T course: |x|=${t.x}`);

    const body = courseLanding(0);
    ok(inRange(Math.abs(body.x), AIM_BODY_MIN, AIM_BODY_MAX), `body course: |x|=${body.x}`);
  }
}

// --- 角度をつけたサービス：ワイドより切れ込むが、その分フォールトもしやすい4本目のコース ---
{
  const {
    AIM_WIDE_MIN, AIM_WIDE_MAX, AIM_ANGLE_MIN, AIM_ANGLE_MAX, AIM_T_MIN, AIM_T_MAX,
    AIM_BODY_MIN, AIM_BODY_MAX,
  } = SERVE;
  const FAULT_X = HALF_W + COURT.LINE_SLACK;
  const courseLanding = (moveX, lob) => {
    const input = { moveX, moveZ: 0, lob };
    const g = new R.Game({ input, hooks: noHooks });
    g.start();
    tossAndHit(g);
    return R.physics.predictLanding(g.ball);
  };
  const STEP_SLACK = 0.05; // 上の「サーブのコースを←→で打ち分けられる」テストと同じ手当て
  const inRange = (v, min, max) => v >= min - STEP_SLACK && v <= max + STEP_SLACK;

  // Shift を押しながらワイド方向へ離すと、ワイドの続きからサイドラインの外まで踏み込む
  // 角度サーブになる（入れば通常のワイドより外へ切れる＝レシーバーの届く範囲の外）
  let sawOutsideWideMax = false;
  let angleFaults = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    const angle = courseLanding(-1, true);
    ok(inRange(Math.abs(angle.x), AIM_ANGLE_MIN, AIM_ANGLE_MAX), `angle course: |x|=${angle.x}`);
    if (Math.abs(angle.x) > AIM_WIDE_MAX) sawOutsideWideMax = true;
    if (Math.abs(angle.x) > FAULT_X) angleFaults++;
  }
  ok(sawOutsideWideMax, 'the angle course reaches beyond the normal wide serve\'s outer edge');
  ok(angleFaults / N > 0.15,
    `the angle course faults (goes past the sideline) a lot more than the ~0% of a normal wide serve, got ${angleFaults}/${N}`);

  // Shift なしなら従来どおりの通常ワイド（4本目のコースを選んでも既存のワイドは無傷）
  const wide = courseLanding(-1, false);
  ok(inRange(Math.abs(wide.x), AIM_WIDE_MIN, AIM_WIDE_MAX), `wide course (no Shift) is unaffected: |x|=${wide.x}`);

  // T・ボディは Shift の有無に関わらず変わらない（既存のバランスは無変更）
  const tNoShift = courseLanding(1, false);
  const tShift = courseLanding(1, true);
  ok(inRange(Math.abs(tNoShift.x), AIM_T_MIN, AIM_T_MAX) && inRange(Math.abs(tShift.x), AIM_T_MIN, AIM_T_MAX),
    `T course is unaffected by Shift, got noShift=${tNoShift.x} shift=${tShift.x}`);
  const bodyNoShift = courseLanding(0, false);
  const bodyShift = courseLanding(0, true);
  ok(inRange(Math.abs(bodyNoShift.x), AIM_BODY_MIN, AIM_BODY_MAX) && inRange(Math.abs(bodyShift.x), AIM_BODY_MIN, AIM_BODY_MAX),
    `body course is unaffected by Shift, got noShift=${bodyNoShift.x} shift=${bodyShift.x}`);

  // CPU/AI も角度サーブを選べる（ワイド域を明確に超える値がサンプルの中に出る）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    let sawAngle = false;
    for (let i = 0; i < 200 && !sawAngle; i++) {
      if (Math.abs(g.cpuServeAimMagnitude()) > AIM_WIDE_MAX) sawAngle = true;
    }
    ok(sawAngle, 'CPU/AI serve course selection also reaches the angle zone across repeated samples');
  }
}

// --- CPU/AIのサーブも T／ボディ／ワイドの3コースへ散らばる ---
// (退行テスト: 以前は専用の SERVE.AIM_X_MIN〜AIM_X_MAX という狭い範囲しか使っておらず、
//  結果としてボディ相当の場所にしか来なかった＝「必ず正面に来る」)
{
  const { AIM_WIDE_MIN, AIM_T_MAX } = SERVE;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  let sawWide = false;
  let sawT = false;
  for (let i = 0; i < 60; i++) {
    const x = Math.abs(g.cpuServeAimMagnitude());
    if (x >= AIM_WIDE_MIN) sawWide = true;
    if (x <= AIM_T_MAX) sawT = true;
  }
  ok(sawWide, 'CPU serve course selection reaches the wide zone across repeated samples');
  ok(sawT, 'CPU serve course selection reaches the T zone across repeated samples');
}

// --- ネットはポストの間にしかない（＝ポールの外側は素通りできる） ---
// (バギーホイップのストレート＝ポール回しが成立する前提。以前は |x| を NET_HALF で
//  頭打ちにしていたため、コートのはるか外でもネットが続いている扱いになっていた)
{
  const { netHeightAt, hitsNet } = R.physics;
  const { NET_HALF, NET_C, NET_P } = R.config.COURT;
  ok(Math.abs(netHeightAt(0) - NET_C) < 1e-9, 'the net sags to NET_C at the centre');
  ok(Math.abs(netHeightAt(NET_HALF) - NET_P) < 1e-9, 'and is highest at the post');
  ok(netHeightAt(NET_HALF + 0.01) === 0, 'just outside the post there is no net at all');
  ok(netHeightAt(-(NET_HALF + 2)) === 0, 'and none further out either');

  // 低い球がポストの外を通っても「ネットに掛かった」にはならない
  const outside = {
    x: -(NET_HALF + 0.4), y: 0.5, z: 0.02, px: -(NET_HALF + 0.45), py: 0.52, pz: -0.02,
  };
  ok(hitsNet(outside) === false, 'a low ball crossing outside the post is not a net hit');
  const inside = { ...outside, x: -1, px: -1.05 };
  ok(hitsNet(inside) === true, 'the same ball crossing between the posts is');
}

// --- フォアハンド/バックハンドの判定（ボールの仮想延長線がラケット側か逆側か） ---
// 全員**右利き**＝自分から見て右側（画面の右。カメラの都合で world は -x）がフォア。
// vx/vz を0にして、速度による延長を無効化し、打点の位置関係だけを見る。
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.you.x = 0;
  // 全員右利き。手前を向いている 'you' の右手side（画面の右）は world -x。
  g.ball.x = -1.5; g.ball.y = 1; g.ball.z = -2; g.ball.vx = 0; g.ball.vz = 0; // world -x 側 = ラケット側
  g.hit('you');
  ok(g.you.stroke === 'forehand', `ball on racket side -> forehand, got ${g.you.stroke}`);

  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2; g.ball.vx = 0; g.ball.vz = 0; // world +x 側 = 逆側
  g.hit('you');
  ok(g.you.stroke === 'backhand', `ball on off side -> backhand, got ${g.you.stroke}`);

  // cpu は180°回転しているので判定が反転する（world +x 側がラケット側）
  g.cpu.x = 0;
  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = 2; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('cpu');
  ok(g.cpu.stroke === 'forehand', `cpu: ball on its racket side -> forehand, got ${g.cpu.stroke}`);

  g.ball.x = -1.5; g.ball.y = 1; g.ball.z = 2; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('cpu');
  ok(g.cpu.stroke === 'backhand', `cpu: ball on its off side -> backhand, got ${g.cpu.stroke}`);
}

// --- フォアハンド/バックハンドの判定（ボールの仮想延長線を使う） ---
// 現在位置ではラケット側でも、速度の延長線がプレイヤーに届く頃には逆側に来るなら、
// 逆側（バックハンド等）と判定されるべき。
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.you.x = 0; g.you.z = -HALF_L - 0.6;
  // 今は 'you' のラケット側(-x)にいるが、+x 方向へ進んでいて、届く頃には逆側(+x)に来る
  g.ball.x = -0.3; g.ball.y = 1; g.ball.z = -3;
  g.ball.vx = 4; g.ball.vz = -4; // player.z へ向かって進む
  g.hit('you');
  ok(g.you.stroke === 'backhand',
    `virtual extension crossing to off side -> backhand, got ${g.you.stroke}`);
}

// --- サーブは stroke='serve'（横振りではなく専用の縦振りポーズを使う） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  tossAndHit(g);
  ok(g.you.stroke === 'serve', `serve sets stroke='serve', got ${g.you.stroke}`);
}

// --- 高くて緩いボールを、しっかり溜めてから離すとスマッシュになる ---
{
  const { SMASH_MIN_Y, SMASH_MIN_CHARGE } = PLAYER;
  const { SMASH_T, SMASH_Z, DRIVE_Z_SPREAD } = R.config.SHOT;

  // 高い(SMASH_MIN_Y以上) かつ 十分溜めた(SMASH_MIN_CHARGE以上) -> スマッシュ
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -5;
    g.ball.x = 0.3; g.ball.y = SMASH_MIN_Y + 0.2; g.ball.z = -5;
    g.you.swingCharge = SMASH_MIN_CHARGE + 0.1;
    g.hit('you');
    ok(g.you.stroke === 'smash', `high + charged ball becomes a smash, got ${g.you.stroke}`);
    const landing = R.physics.predictLanding(g.ball);
    ok(landing.z >= SMASH_Z - 0.5 && landing.z <= SMASH_Z + DRIVE_Z_SPREAD + 0.5,
      `smash aims for the smash depth, got z=${landing.z}`);
  }

  // 高いが溜めが足りない -> 通常のフォア/バックのまま（スマッシュにならない）
  // bounces=1 で「既にバウンド済み」にしておき、ボレー判定（bounces===0が条件）にも
  // かからないようにして、純粋にスマッシュのゲーティングだけを検証する。
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -5;
    g.ball.x = 0.3; g.ball.y = SMASH_MIN_Y + 0.2; g.ball.z = -5;
    g.ball.bounces = 1;
    g.you.swingCharge = SMASH_MIN_CHARGE - 0.1;
    g.hit('you');
    ok(g.you.stroke === 'forehand' || g.you.stroke === 'backhand',
      `not enough charge -> falls back to a plain forehand/backhand, got ${g.you.stroke}`);
  }

  // 十分溜めたが低いボール -> 通常のフォア/バックのまま（スマッシュにならない）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -5;
    g.ball.x = 0.3; g.ball.y = SMASH_MIN_Y - 0.5; g.ball.z = -5;
    g.ball.bounces = 1;
    g.you.swingCharge = 1;
    g.hit('you');
    ok(g.you.stroke === 'forehand' || g.you.stroke === 'backhand',
      `low ball -> falls back to a plain forehand/backhand even at full charge, got ${g.you.stroke}`);
  }

  // スマッシュはサーブと同等以上に速い（決め球らしい威力）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -5;
    g.ball.x = 0.3; g.ball.y = SMASH_MIN_Y + 0.2; g.ball.z = -5;
    g.you.swingCharge = 1;
    g.hit('you');
    const smashSpeed = Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz);

    const g2 = new R.Game({ input: fakeInput, hooks: noHooks });
    g2.start();
    g2.phase = 'rally';
    g2.you.x = 0; g2.you.z = -5;
    g2.ball.x = 0.3; g2.ball.y = 1; g2.ball.z = -5;
    g2.ball.bounces = 1; // 既にバウンド済みの通常のグラウンドストローク（ボレー扱いにしない）
    g2.you.swingCharge = 1; // フル溜めの通常打（スマッシュ対象外の高さ）
    g2.hit('you');
    const fullDriveSpeed = Math.hypot(g2.ball.vx, g2.ball.vy, g2.ball.vz);

    ok(smashSpeed > fullDriveSpeed,
      `smash is faster than even a full-charge normal drive: smash=${smashSpeed.toFixed(2)} drive=${fullDriveSpeed.toFixed(2)}`);
    ok(SMASH_T < R.config.SHOT.CHARGE_T, 'precondition: SMASH_T is shorter (faster) than CHARGE_T');
  }
}

// --- サービスラインより前でノーバウンドの球を返すとボレーになる（溜めではなく距離で鋭さが決まる） ---
{
  const { SERVICE } = COURT;
  const { SWEET_DIST, BLOCK_Z, ANGLE_Z, BLOCK_T, ANGLE_T } = R.config.VOLLEY;

  const volleyHit = (playerZ, ballXOffset, bounces = 0) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = playerZ;
    g.ball.x = ballXOffset; g.ball.y = 1.0; g.ball.z = playerZ; g.ball.bounces = bounces;
    g.you.swingCharge = 0; // ボレーは溜めなしでも成立するはず（溜めに依存しない）
    g.hit('you');
    return g;
  };

  // サービスラインより前 + ノーバウンド -> ボレー
  {
    const g = volleyHit(-SERVICE + 1, SWEET_DIST);
    ok(g.you.stroke === 'volley-forehand' || g.you.stroke === 'volley-backhand',
      `in front of the service line with no bounce -> volley, got ${g.you.stroke}`);
  }

  // サービスラインより後ろ（ベースライン寄り）ならノーバウンドでもボレーにならない
  {
    const g = volleyHit(-SERVICE - 1, SWEET_DIST);
    ok(g.you.stroke === 'forehand' || g.you.stroke === 'backhand',
      `behind the service line -> plain forehand/backhand even with no bounce, got ${g.you.stroke}`);
  }

  // サービスラインより前でも、既にバウンドしていればボレーにならない
  {
    const g = volleyHit(-SERVICE + 1, SWEET_DIST, 1);
    ok(g.you.stroke === 'forehand' || g.you.stroke === 'backhand',
      `already bounced -> plain forehand/backhand even in front of the service line, got ${g.you.stroke}`);
  }

  // 真正面（距離0）は普通のブロック、程よい距離（SWEET_DIST）は鋭い角度になる（対称）。
  // playerShot() を直接呼び、DRIVE_Z_SPREAD の乱数を Math.random 固定で潰して決定的に比較する。
  {
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      const shotAt = (ballXOffset, charge) => {
        const g = new R.Game({ input: fakeInput, hooks: noHooks });
        g.you.x = 0;
        g.ball.x = ballXOffset;
        g.you.swingCharge = charge;
        return g.playerShot('volley-forehand');
      };

      const straight = shotAt(0, 0);
      const sharpPlus = shotAt(SWEET_DIST, 0);
      const sharpMinus = shotAt(-SWEET_DIST, 0);
      const overstretched = shotAt(SWEET_DIST + 1.0, 0);
      const sharpFullCharge = shotAt(SWEET_DIST, 1); // 溜めを変えても結果は同じはず

      ok(Math.abs(straight.target.z - BLOCK_Z) < 1e-9,
        `dead center (distance 0) lands at the safe BLOCK_Z depth, got z=${straight.target.z}`);
      ok(Math.abs(sharpPlus.target.z - ANGLE_Z) < 1e-9,
        `sweet-spot distance lands at the sharp ANGLE_Z depth, got z=${sharpPlus.target.z}`);
      ok(Math.abs(sharpPlus.target.z - sharpMinus.target.z) < 1e-9,
        'sweet-spot distance is symmetric on either side of the player (same depth/flight)');
      ok(Math.abs(overstretched.target.z - BLOCK_Z) < 1e-9,
        `overstretched distance falls back to the safe BLOCK_Z depth, got z=${overstretched.target.z}`);
      ok(sharpPlus.target.z === sharpFullCharge.target.z && sharpPlus.flight === sharpFullCharge.flight,
        'volley result is unaffected by how much Space was charged');
      ok(straight.flight === BLOCK_T && sharpPlus.flight === ANGLE_T,
        `flight time also follows the sharpness curve, straight=${straight.flight} sharp=${sharpPlus.flight}`);
    } finally {
      Math.random = origRandom;
    }
  }
}

// --- 打点でインパクト演出（ball.impact）が発火し、時間とともに減衰する ---
{
  const { FX } = R.config;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  ok(g.ball.impact === 0, 'no impact before anything happens');

  tossAndHit(g);
  ok(g.ball.impact > 0 && g.ball.impact <= FX.IMPACT_DURATION, `serve sets ball.impact, got ${g.ball.impact}`);
  // 減衰しきるのに十分だが、サーブが相手コートに届いて CPU が打ち返す（＝新しい impact が
  // 発火する）よりは短い時間だけ待つ（SERVE.T=0.72s より確実に短い20フレーム=0.33秒）。
  for (let i = 0; i < 20; i++) g.update(1 / 60);
  ok(g.ball.impact === 0, `ball.impact decays back to 0, got ${g.ball.impact}`);

  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2;
  g.hit('you');
  ok(g.ball.impact > 0, `rally hit also sets ball.impact, got ${g.ball.impact}`);
}

// --- 溜めなしの打球は、フル溜めより明らかに山なり（ゆるい球）になる ---
{
  const { GRAVITY } = R.config.PHYSICS;
  const { TAP_T, CHARGE_T } = R.config.SHOT;
  const from = { x: 0, y: 1, z: -3 };
  const target = { x: 0, y: R.config.PHYSICS.BALL_R, z: 5 };
  const tap = R.physics.solveShot(from, target, TAP_T);
  const charged = R.physics.solveShot(from, target, CHARGE_T);
  const apex = (v) => from.y + (v.vy * v.vy) / (2 * Math.abs(GRAVITY));
  ok(apex(tap) > apex(charged) * 1.5,
    `tap shot arcs noticeably higher than a charged shot, tap apex=${apex(tap).toFixed(2)} charged apex=${apex(charged).toFixed(2)}`);
  ok(apex(tap) > 2.2, `tap shot is a genuinely loose, lob-like arc, apex=${apex(tap).toFixed(2)}`);
}

// --- CPU: stretch(0〜1) が大きいほど、狙いが浅く・中央寄りになる（ぎりぎり追いついた弱気な返球）---
// Math.random を固定して rand()/OUT判定を決定的にする（OUT確率は最大0.22なので0.5は下回らない）
{
  const { shotTarget } = R.ai;
  const {
    AIM_X_MIN, AIM_X_MAX, AIM_Z_MIN, AIM_Z_MAX,
    STRETCH_AIM_X_MIN, STRETCH_AIM_X_MAX, STRETCH_AIM_Z_MIN, STRETCH_AIM_Z_MAX, STRETCH_T, SHOT_T,
  } = R.config.CPU;
  ok(STRETCH_T > SHOT_T, `precondition: STRETCH_T is a slower/loopier flight than SHOT_T`);

  const origRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const comfy = shotTarget(2, -1, 0);
    const stretched = shotTarget(2, -1, 1);
    const mid = (a, b) => (a + b) / 2;
    ok(Math.abs(comfy.x + mid(AIM_X_MIN, AIM_X_MAX)) < 1e-9, `stretch=0 uses the normal aim range, x=${comfy.x}`);
    ok(Math.abs(comfy.z + mid(AIM_Z_MIN, AIM_Z_MAX)) < 1e-9, `stretch=0 uses the normal depth, z=${comfy.z}`);
    ok(Math.abs(stretched.x + mid(STRETCH_AIM_X_MIN, STRETCH_AIM_X_MAX)) < 1e-9,
      `stretch=1 aims more central, x=${stretched.x}`);
    ok(Math.abs(stretched.z + mid(STRETCH_AIM_Z_MIN, STRETCH_AIM_Z_MAX)) < 1e-9,
      `stretch=1 lands much shorter, z=${stretched.z}`);
    ok(Math.abs(stretched.x) < Math.abs(comfy.x) && Math.abs(stretched.z) < Math.abs(comfy.z),
      'a stretched return is safer/shallower than a comfortable one');
  } finally {
    Math.random = origRandom;
  }
}

// --- CPU: 新しい球が来た瞬間は反応遅延があり、直前まで動いていた方向と逆を突かれると間に合わない ---
{
  const { CPU_REACT } = R.config.PLAYER;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.phase = 'rally';
  g.cpu.x = 0; g.cpu.z = R.config.CPU.HOME_Z;
  g.ball.last = 'cpu';
  g.movePlayers(1 / 60); // lastBallOwnerSeen を 'cpu' にしておく（you 側の反応タイマーが立つのは想定内）

  g.ball.x = -3; g.ball.z = 3; g.ball.last = 'you'; // you が打ち返した＝cpu 陣営に新しい球が来た
  const before = { x: g.cpu.x, z: g.cpu.z };
  g.movePlayers(1 / 60);
  ok(g.reactTimers.cpu > 0, `precondition: reaction timer starts counting down, got ${g.reactTimers.cpu}`);
  ok(g.cpu.x === before.x && g.cpu.z === before.z,
    `cpu does not move during the reaction window, x=${g.cpu.x} z=${g.cpu.z}`);
  ok(g.cpu.speed === 0, 'cpu speed reads 0 while still reacting (idle, not sprinting)');

  for (let i = 0; i < Math.ceil(CPU_REACT / (1 / 60)) + 2; i++) g.movePlayers(1 / 60);
  ok(g.reactTimers.cpu === 0, 'reaction timer has fully counted down');
  ok(g.cpu.x !== before.x || g.cpu.z !== before.z, 'cpu starts chasing once it has reacted');
}

// --- サーブにも必ず反応遅延が掛かる（前のポイントで最後に打ったのが誰であっても） ---
// ball.last は beginServe() をまたいでも前のポイントの値のまま残る。以前は
// lastBallOwnerSeen をラリー外でも更新していたため、「前のポイントの最後の打者」＝
// 「次のサーバー」のときだけ owner が変化せず、そのサーブへの反応遅延が丸ごと
// 飛んでいた（＝自分のミス／ウィナーで終えた次の自分のサーブでは CPU がノータイム
// でリターンに動き出す）。どちらのケースでも同じだけ掛かることを見る。
{
  const { CPU_REACT } = R.config.PLAYER;
  /** 人間のサーブを1本打たせて、そのときの cpu の反応遅延を返す（シングルス）。 */
  const serveWith = (previousHitter) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(false, 'you');
    g.ball.last = previousHitter; // 前のポイントの名残
    g.lastBallOwnerSeen = null;
    for (let i = 0; i < 10; i++) g.update(1 / 60); // サーブ待ちのフレーム
    g.chargeStart('flat');
    g.you.chargeTime = 0.5;
    for (let i = 0; i < 5; i++) g.update(1 / 60); // トスが上がる
    g.chargeRelease();
    // 当たるのはトスがラケットの届く高さに来たとき（物理の刻みの中）。反応遅延はその次の
    // フレームの movePlayers() が掛ける（ラリー中の打球と同じ順序）。
    for (let guard = 0; g.phase === 'serve' && guard < 120; guard++) g.update(1 / 60);
    g.update(1 / 60);
    return g;
  };
  // 人間のサーブへの反応は「サーブの読み」の範囲（CPU.SERVE_REACT_MIN/MAX）から引く
  const { SERVE_REACT_MIN, SERVE_REACT_MAX } = R.config.CPU;
  const reactMult = R.config.ATTRS.cpu.react;
  const inServeRange = (t) => t >= SERVE_REACT_MIN * reactMult - 1e-9 && t <= SERVE_REACT_MAX * reactMult + 1e-9;
  const after = serveWith('you');
  ok(after.phase === 'rally', `precondition: the serve went out, phase=${after.phase}`);
  ok(inServeRange(after.reactTimers.cpu),
    `the previous point ending on a "you" shot still gives the CPU its reaction delay: `
    + `${after.reactTimers.cpu} (want ${SERVE_REACT_MIN * reactMult}〜${SERVE_REACT_MAX * reactMult})`);
  ok(inServeRange(serveWith('cpu').reactTimers.cpu),
    'and so does a previous point that ended on a "cpu" shot (unchanged)');

  // ダブルスも同じ：cpu チームがサーブするとき youMate に反応遅延が掛かる
  const doublesServe = (previousHitter) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(true, 'cpu');
    g.ball.last = previousHitter;
    g.lastBallOwnerSeen = null;
    for (let i = 0; i < 10; i++) g.update(1 / 60);
    for (let guard = 0; g.phase === 'serve' && guard < 600; guard++) g.update(1 / 60);
    g.update(1 / 60); // 打った次のフレームで反応遅延が掛かる（上の serveWith() と同じ）
    return g.reactTimers.youMate;
  };
  const wantMate = CPU_REACT * R.config.ATTRS.youMate.react;
  ok(Math.abs(doublesServe('cpu') - wantMate) < 1e-9,
    `doubles: the receiving partner reacts late even when the serving team hit last, `
    + `got ${doublesServe('cpu')} (want ${wantMate})`);
  ok(Math.abs(doublesServe('you') - wantMate) < 1e-9, 'doubles: unchanged the other way round');
}

// --- CPU の人間のサーブへの反応は、サーブのたびに「読み」の範囲から引く（ラリーは従来どおり） ---
{
  const { SERVE_REACT_MIN, SERVE_REACT_MAX } = R.config.CPU;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(false, 'you');
  const reactMult = g.cpu.attr.react;
  const reactTo = (serve) => {
    g.phase = 'rally';
    g.serveInFlight = serve;
    g.ball.last = 'you';
    g.ball.reactBonus = 0;
    g.lastBallOwnerSeen = 'cpu';
    g.updateReactTimers(0);
    return g.reactTimers.cpu / reactMult;
  };
  const serves = Array.from({ length: 40 }, () => reactTo(true));
  ok(serves.every((t) => t >= SERVE_REACT_MIN - 1e-9 && t <= SERVE_REACT_MAX + 1e-9),
    `the reaction to a serve stays within SERVE_REACT_MIN..MAX: ${Math.min(...serves).toFixed(3)}〜${Math.max(...serves).toFixed(3)}`);
  ok(Math.max(...serves) - Math.min(...serves) > (SERVE_REACT_MAX - SERVE_REACT_MIN) / 2,
    'and it is drawn afresh for each serve (sometimes read early, sometimes late)');
  ok(Math.abs(reactTo(false) - PLAYER.CPU_REACT) < 1e-9, 'a rally shot still uses the rally reaction (CPU_REACT)');
}

// --- Hard でも、線ちょうどの全力サーブをセンターへ打てばときどきエースになる ---
// （退行テスト：CPU のサーブへの反応がラリーと同じ Hard 0.05秒だった頃は、センター・
//  ワイド・角度のどこへ打っても1本もエースにならなかった＝ユーザー報告）
{
  const { SERVE } = R.config;
  const saved = SERVE.NET_CHANCE;
  SERVE.NET_CHANCE = 0; // ネットに掛かった1本は数えたくない（入ったサーブの中の割合を見る）
  R.config.applyCpuLevel('hard');
  const SWEET_FRAMES = Math.round(SERVE.CHARGE_SWEET_T * 60);
  const count = { center: 0, centerAces: 0, body: 0, bodyAces: 0 };
  try {
    for (let i = 0; i < 400 && (count.center < 150 || count.body < 80); i++) {
      // ←→ のどちらがセンターになるかはサイドで入れ替わるので、両方打って呼び名で振り分ける
      const input = { moveX: [1, -1, 0][i % 3], moveZ: 0, lob: false };
      const g = new R.Game({ input, hooks: noHooks });
      g.start(false, 'you');
      if (i % 2) { g.match.awardPoint('you'); g.newPoint(); }
      g.chargeStart('flat');
      for (let f = 0; f < SWEET_FRAMES; f++) g.update(1 / 60);
      g.chargeRelease();
      for (let f = 0; f < 60 && g.phase === 'serve'; f++) g.update(1 / 60);
      input.moveX = 0;
      const label = g.lastShotBy.you || '';
      const course = label.includes('センター') ? 'center' : label.includes('ボディ') ? 'body' : null;
      let ace = false;
      for (let f = 0; f < 300 && g.phase === 'rally' && g.serveInFlight; f++) g.update(1 / 60);
      if (g.phase === 'fault') continue;
      ace = g.stats.you.aces === 1;
      if (!course) continue;
      count[course]++;
      if (ace) count[`${course}Aces`]++;
    }
  } finally {
    R.config.applyCpuLevel('normal');
    SERVE.NET_CHANCE = saved;
  }
  const rate = (k) => count[`${k}Aces`] / Math.max(count[k], 1);
  ok(count.center >= 100 && rate('center') > 0.03 && rate('center') < 0.5,
    `hard: a line-perfect serve down the T is sometimes an ace, ${count.centerAces}/${count.center}`);
  ok(count.body >= 50 && rate('body') < 0.05,
    `hard: a serve straight at the receiver (body) is still returned, ${count.bodyAces}/${count.body}`);
}

// --- タイブレーク：Game#endPoint() 経由でも、1本目はサーバーそのまま・以降は2ポイントごとに交代する ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(false);
  g.match.games = { you: 6, cpu: 6 };
  g.match.tiebreak = true;
  g.server = 'you'; // タイブレーク1本目を打つ人

  g.phase = 'rally';
  g.endPoint('you', 'test'); // 1本目
  ok(g.server === 'cpu', `server switches right after the 1st tiebreak point, got ${g.server}`);

  g.phase = 'rally';
  g.endPoint('cpu', 'test'); // 2本目
  ok(g.server === 'cpu', `server stays the same after the 2nd point, got ${g.server}`);

  g.phase = 'rally';
  g.endPoint('you', 'test'); // 3本目
  ok(g.server === 'you', `server switches after the 3rd point, got ${g.server}`);

  g.phase = 'rally';
  g.endPoint('you', 'test'); // 4本目
  ok(g.server === 'you', `server stays the same after the 4th point, got ${g.server}`);
}

// --- ダブルスのタイブレーク：4人がセットと同じ順番で回り、必殺技はサーブ権が移るたびに戻る ---
// (退行テスト: タイブレーク中はチーム内の担当（serverPartner）を回していなかったため、
//  主力の you/cpu だけが交互にサーブし、パートナーは一度もサーブしなかった。必殺技の回復も
//  「6ポイントごと」で、サーブ権が移るのは奇数本目の後なので、必ず同じ人の2本の途中に来ていた)
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.setSpecials(['hawkEye']);
  g.start(true, 'you');
  // 全ゲームをサーブ側が取って 6-6 まで進める（通常のゲームのローテーションを通してタイブレークに入る）
  for (let game = 0; game < 12; game++) {
    const team = g.server;
    for (let p = 0; p < 4; p++) { g.phase = 'rally'; g.endPoint(team, 'test'); }
  }
  ok(g.match.tiebreak && g.match.games.you === 6 && g.match.games.cpu === 6,
    `precondition: doubles reaches a 6-6 tiebreak, got ${g.match.games.you}-${g.match.games.cpu} tb=${g.match.tiebreak}`);

  const servers = [];
  const receivers = [];
  const refreshed = [];
  for (let p = 0; p < 14; p++) {
    servers.push(g.servingPlayer());
    receivers.push(g.receivingPlayer(g.server === 'you' ? 'cpu' : 'you', g.match.serveSide));
    g.specialUses.hawkEye = 0; // 毎ポイント使い切った状態にして、戻ったかどうかだけを見る
    g.phase = 'rally';
    g.endPoint(p % 2 ? 'you' : 'cpu', 'test'); // 交互に取らせて 7-7 まで続ける
    refreshed.push(g.usesLeft('hawkEye') > 0);
  }
  // ITF ルール 5(b)：1本目は順番の人、以降は相手チームの順番の人から2本ずつ、チーム内はセットと同じ順番
  const wantServers = ['you', 'cpu', 'cpu', 'youMate', 'youMate', 'cpuMate', 'cpuMate',
    'you', 'you', 'cpu', 'cpu', 'youMate', 'youMate', 'cpuMate'];
  ok(servers.join() === wantServers.join(),
    `doubles tiebreak serve order rotates through all four players, got ${servers.join()}`);
  // レシーブするコートはセットを通して各選手で固定（パートナーは -1 側、主力は +1 側）
  const wantReceivers = ['cpuMate', 'you', 'youMate', 'cpu'];
  ok(receivers.every((r, i) => r === wantReceivers[i % 4]),
    `doubles tiebreak receivers keep their courts from the set, got ${receivers.join()}`);
  // 必殺技はサーブ権が移った直後（奇数本目の後）だけ戻り、同じ人の2本の途中では戻らない
  ok(refreshed.every((r, i) => r === (i % 2 === 0)),
    `specials refresh exactly when the serve changes hands in a tiebreak, got ${refreshed.join()}`);

  // タイブレークで決まったセットの次は、タイブレークの1本目をサーブした側（you）の相手から。
  // 7-7 から 7-8 → 8-8 → 9-8 → 10-8 と進めると、最後の1本を打つのは cpu（cpu チーム）なので、
  // 「最後にサーブした側の相手」では you になってしまう。
  for (const w of ['cpu', 'you', 'you']) { g.phase = 'rally'; g.endPoint(w, 'test'); }
  ok(g.servingPlayer() === 'cpu', `precondition: cpu serves the last point, got ${g.servingPlayer()}`);
  g.phase = 'rally'; g.endPoint('you', 'test');
  ok(g.match.games.you === 7 && g.match.games.cpu === 6, `you win the tiebreak 7-6, got ${g.match.games.you}-${g.match.games.cpu}`);
  ok(g.server === 'cpu', `the team that received first in the tiebreak serves the next set, got ${g.server}`);
  ok(g.tiebreakOpener === null, 'the tiebreak opener is forgotten once the set is decided');
}

// --- タイブレーク：Game#endPoint() を通しても、取った側がそのままセットを取る ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(false);
  g.match.games = { you: 6, cpu: 6 };
  g.match.tiebreak = true;
  for (let i = 0; i < 7; i++) { g.phase = 'rally'; g.endPoint('you', 'test'); }
  ok(g.match.games.you === 7 && g.match.games.cpu === 6,
    `winning the tiebreak makes it 7-6, got ${g.match.games.you}-${g.match.games.cpu}`);
  ok(g.match.tiebreak === false, 'tiebreak flag clears once the set is decided');
}

// --- チェンジエンズ（ITF ルール10・29）：いつ入れ替わり、どの休憩が付くか ---
{
  const { changeoverAfter } = R.scoring;
  const m = new Match();
  const winGame = (who) => {
    let r;
    for (let p = 0; p < 4; p++) r = m.awardPoint(who);
    return changeoverAfter(r, m);
  };
  // 6-6 まで1ゲームずつ交互に取らせる：第1ゲームの後は休憩なし、以降は奇数ゲームの後だけ90秒の休憩
  const kinds = [];
  for (let game = 0; game < 12; game++) kinds.push(winGame(game % 2 ? 'cpu' : 'you'));
  ok(kinds.join() === 'firstGame,,rest,,rest,,rest,,rest,,rest,',
    `ends change after every odd game of the set (no rest after the first), got ${kinds.join()}`);
  ok(m.tiebreak, 'precondition: 6-6 goes to a tiebreak (12 games, so no change before it)');

  // タイブレーク中は6ポイントごと（休憩なし）
  const tb = [];
  for (let p = 0; p < 12; p++) tb.push(changeoverAfter(m.awardPoint(p % 2 ? 'cpu' : 'you'), m));
  ok(tb.join() === ',,,,,tiebreak,,,,,,tiebreak',
    `a tiebreak changes ends every 6 points, got ${tb.join()}`);
  ok(changeoverAfter(m.awardPoint('you'), m) === null, '13 tiebreak points: no change');
  const last = m.awardPoint('you');
  ok(last.type === 'set' && m.games.you === 7 && m.games.cpu === 6, 'precondition: the tiebreak decides the set 7-6');
  // タイブレークは1ゲームと数える＝13ゲームのセットなので、終わったら入れ替わる
  ok(changeoverAfter(last, m) === 'setBreak', `a 7-6 set ends with a change of ends, got ${changeoverAfter(last, m)}`);

  // セットの終わりは、そのセットのゲーム数が偶数なら入れ替わらない（次のセットの第1ゲームの後）
  const even = new Match();
  let r;
  for (let p = 0; p < 24; p++) r = even.awardPoint('you');
  ok(r.type === 'set' && changeoverAfter(r, even) === null, `a 6-0 set (6 games) ends without a change, got ${changeoverAfter(r, even)}`);
  const odd = new Match();
  for (let p = 0; p < 4; p++) odd.awardPoint('cpu');
  for (let p = 0; p < 24; p++) r = odd.awardPoint('you');
  ok(r.type === 'set' && changeoverAfter(r, odd) === 'setBreak', `a 6-1 set (7 games) ends with a change, got ${changeoverAfter(r, odd)}`);
}

// --- チェンジエンズ：Game を通して暗転・入れ替わり・風・休憩のスタミナ・スキップ ---
{
  const { CHANGEOVER } = R.config;
  const calls = [];
  const hooks = { ...noHooks, call: (big, sub) => calls.push(`${big}|${sub || ''}`) };
  const g = new R.Game({ input: fakeInput, hooks });
  g.start(false, 'you');
  // 次のポイントの構えに入り、暗転も明けきるまで進める（CPU のサーブはまだ飛んでこない）
  const settle = () => {
    for (let i = 0; i < 60 * 10 && (g.phase !== 'serve' || g.changeover); i++) g.update(1 / 60);
  };
  const winPoint = (who) => { g.phase = 'rally'; g.endPoint(who, 'test'); };
  const winGame = (who) => { for (let p = 0; p < 4; p++) { winPoint(who); settle(); } };

  // 第1ゲーム：最後の1点の後、暗転しきってから入れ替わり、明けたら幕が消える
  for (let p = 0; p < 3; p++) { winPoint('you'); settle(); }
  ok(!g.endsSwapped, 'precondition: no change during the first game');
  // 斜め（+x 寄りの追い風）に吹かせておく。入れ替わった後は横も前後も逆向きになるはず
  // （ポイント間の揺らぎは向き ±WIND.ANGLE_SPREAD までなので、符号は変わらない）。
  g.windBase = { angle: Math.PI / 4, strength: 0.5 };
  g.windStrength = 0.5;
  g.windAngleOff = 0;
  g.setWindVector();
  ok(g.wind > 0 && g.windZ > 0, 'precondition: a diagonal tailwind blowing toward +x');
  calls.length = 0;
  winPoint('you');
  let shadeAtSwap = null;
  let maxShade = 0;
  for (let i = 0; i < 60 * 10 && (g.phase !== 'serve' || g.changeover); i++) {
    const before = g.endsSwapped;
    g.update(1 / 60);
    maxShade = Math.max(maxShade, g.changeoverShade());
    if (before !== g.endsSwapped) shadeAtSwap = g.changeoverShade();
  }
  ok(g.endsSwapped, 'ends change after the first game');
  ok(shadeAtSwap === 1, `the swap happens while the screen is fully dark, got shade ${shadeAtSwap}`);
  ok(maxShade === 1 && g.changeoverShade() === 0 && g.changeover === null,
    `the shade fades out and back in, got max ${maxShade} / now ${g.changeoverShade()}`);
  ok(calls.some((c) => c === 'チェンジエンズ|第1ゲームの後は休憩なし'),
    `the change after the first game is called with no rest, got ${JSON.stringify(calls)}`);
  ok(g.wind < 0 && g.windZ < 0,
    `the wind blows the other way once the ends change (a headwind now), got ${g.wind}, ${g.windZ}`);
  ok(g.phase === 'serve' && g.match.games.you === 1, 'the next point is ready to serve after the change');

  // 第2ゲーム：入れ替わらない。休憩もないのでスタミナはポイント間の分だけ戻る
  for (let p = 0; p < 3; p++) { winPoint('cpu'); settle(); }
  g.you.stamina = 0.2;
  winPoint('cpu');
  settle();
  ok(g.endsSwapped, 'no change after the second game');
  const plain = g.you.stamina - 0.2;
  ok(Math.abs(plain - g.staminaRecoverAmount(2)) < 1e-9,
    `between games without a change only the usual recovery applies, got ${plain}`);

  // 第3ゲーム：90秒の休憩つきで入れ替わり、休憩ぶんスタミナが多く戻る
  for (let p = 0; p < 3; p++) { winPoint('you'); settle(); }
  g.you.stamina = 0.2;
  calls.length = 0;
  winPoint('you');
  settle();
  ok(!g.endsSwapped, 'ends change back after the third game');
  ok(calls.some((c) => c.startsWith(`チェンジエンズ|${CHANGEOVER.RULE_SEC.rest}秒の休憩`)),
    `the change after the third game comes with a rest, got ${JSON.stringify(calls)}`);
  const rested = g.you.stamina - 0.2;
  const want = g.staminaRecoverAmount(3) * (1 + CHANGEOVER.RECOVER_MULT.rest);
  ok(Math.abs(rested - want) < 1e-6, `the rest recovers ${want.toFixed(3)} of stamina, got ${rested.toFixed(3)}`);

  // Space（skipChangeover）で休憩を切り上げても、入れ替わりと休憩ぶんの回復はそのまま
  winGame('cpu'); // 第4ゲーム（入れ替わらない）
  for (let p = 0; p < 3; p++) { winPoint('you'); settle(); }
  g.you.stamina = 0.2;
  winPoint('you'); // 第5ゲーム
  for (let i = 0; i < 60 * 5 && !g.changeover; i++) g.update(1 / 60);
  ok(g.changeover && g.changeover.kind === 'rest', 'precondition: a rest changeover after the fifth game');
  g.update(1 / 60);
  g.skipChangeover();
  g.update(1 / 60);
  ok(g.endsSwapped && g.phase === 'serve', 'skipping the rest swaps ends on the next frame');
  ok(Math.abs(g.you.stamina - 0.2 - g.staminaRecoverAmount(5) * (1 + CHANGEOVER.RECOVER_MULT.rest)) < 1e-6,
    `and still recovers the whole rest, got ${g.you.stamina}`);
  settle();
  ok(g.changeover === null && g.changeoverShade() === 0, 'and fades back in');
}

// --- チェンジエンズ：タイブレークは6ポイントごと、セットの終わりはゲーム数が奇数なら入れ替わる ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(false, 'you');
  // セットが決まった1点は、締めくくり（FINALE）とセット間の休憩を挟むぶん長く待つ
  const settle = () => {
    for (let i = 0; i < 60 * 20 && (g.phase !== 'serve' || g.changeover); i++) g.update(1 / 60);
  };
  const winPoint = (who) => { g.phase = 'rally'; g.endPoint(who, 'test'); settle(); };
  g.match.games = { you: 6, cpu: 6 };
  g.match.tiebreak = true;
  const swaps = [];
  for (let p = 0; p < 6; p++) {
    const before = g.endsSwapped;
    winPoint(p % 2 ? 'cpu' : 'you');
    swaps.push(before !== g.endsSwapped);
  }
  ok(swaps.join() === 'false,false,false,false,false,true',
    `a tiebreak changes ends after the 6th point, got ${swaps.join()}`);
  // 7-6 で終わったセット（13ゲーム）の後は、セット間の休憩のうちに入れ替わる
  g.you.stamina = 0.2;
  const before = g.endsSwapped;
  for (let p = 0; p < 3; p++) winPoint('you'); // タイブレーク 3-3 → 6-3
  ok(g.match.tiebreak, 'precondition: the tiebreak is still on at 6-3');
  winPoint('you'); // 7-3＝セット
  ok(g.match.games.you === 0 && g.match.games.cpu === 0, 'precondition: the next set has begun');
  ok(g.endsSwapped !== before, 'a set decided by a tiebreak (13 games) ends with a change of ends');

  // 6-0（6ゲーム）で終わったセットの後は入れ替わらないが、セット間の休憩ぶんは戻る
  const h = new R.Game({ input: fakeInput, hooks: noHooks });
  h.start(false, 'you');
  h.match.games = { you: 5, cpu: 0 };
  h.match.points = { you: 3, cpu: 0 };
  h.you.stamina = 0.2;
  h.phase = 'rally';
  h.endPoint('you', 'test');
  for (let i = 0; i < 60 * 20 && (h.phase !== 'serve' || h.changeover); i++) h.update(1 / 60);
  ok(!h.endsSwapped && h.match.games.you === 0, 'a 6-0 set (6 games) ends without a change of ends');
  const { CHANGEOVER, STAMINA } = R.config;
  const setBreak = STAMINA.RECOVER_PER_POINT * (1 + CHANGEOVER.RECOVER_MULT.setBreak);
  ok(Math.abs(h.you.stamina - 0.2 - setBreak) < 1e-6,
    `but the set break still recovers ${setBreak.toFixed(3)}, got ${(h.you.stamina - 0.2).toFixed(3)}`);
}

// --- 当たった1打の直後に空振り処理が走らない（打ち方とモーションが上書きされない） ---
// (退行テスト: hit() が成功時に swing を0にするため、「残り時間が0になった」だけを見て
//  missSwing() を呼んでいた頃は、成功した1打の直後に必ず空振り処理が走って
//  player.stroke='forehand' / anim=SWING_ANIM で上書きされ、人間のスマッシュ・ボレー・
//  必殺技のモーションが一度も再生されていなかった)
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.phase = 'rally';
  g.ball.live = true; g.ball.last = 'cpu';
  g.you.x = 0; g.you.z = -4;
  Object.assign(g.ball, {
    x: 0.2, y: 2.3, z: -3.7, px: 0.2, py: 2.4, pz: -3.7, vx: 0, vy: -1.5, vz: 0,
    bounces: 0, spin: 'flat', wind: 0,
  });
  g.chargeStart('flat');
  g.you.chargeTime = 0.6; // スマッシュに必要な溜め（PLAYER.SMASH_MIN_CHARGE 以上）
  g.chargeRelease();
  g.update(1 / 60);
  ok(g.ball.last === 'you', 'precondition: the high ball was actually hit');
  ok(g.you.stroke === 'smash', `a connected smash keeps its stroke, got ${g.you.stroke}`);
  ok(Math.abs(g.you.anim - PLAYER.SMASH_ANIM) < 1e-9,
    `and its longer motion (SMASH_ANIM), got ${g.you.anim}`);

  // 空振りのときは従来どおりスイングのモーションだけ再生する
  const w = new R.Game({ input: fakeInput, hooks: noHooks });
  w.start();
  w.phase = 'rally';
  w.ball.live = true; w.ball.last = 'cpu';
  w.you.x = 0; w.you.z = -4;
  Object.assign(w.ball, { x: 8, y: 1, z: 5, vx: 0, vy: 0, vz: 0, bounces: 1 }); // 遠くて届かない
  w.chargeStart('flat');
  w.chargeRelease();
  for (let i = 0; i < 30 && w.you.swing > 0; i++) w.update(1 / 60);
  ok(w.ball.last === 'cpu', 'precondition: the swing missed');
  ok(Math.abs(w.you.anim - PLAYER.SWING_ANIM) < 1e-9,
    `a whiff still plays the swing motion, got ${w.you.anim}`);
}

// --- full match simulation（フリーズ・タイマーリーク・スコア破綻がないか） ---
{
  const events = [];
  const g = new R.Game({
    input: fakeInput,
    hooks: { ...noHooks, call: (big, sub) => events.push(`${big}|${sub}`) },
  });
  g.start();
  // タイマーは「その瞬間に待っている予定」の数。溜まり続けない（＝リークしない）ことを
  // 見たいので、最後の1フレームだけでなく走っている間の最大値を見る。セットが決まった
  // 後は締めのカットまでの1本（FINALE.DELAY）、カットの後は次の試合までの1本（NEXT_MATCH）
  // しか待たないが、ほかの演出のタイマーと重なることもあるので2本までは正常とみなす。
  let maxTimers = 0;
  for (let i = 0; i < 60 * 600; i++) {
    if (g.phase === 'serve' && g.server === 'you') tap(g);
    if (g.phase === 'rally' && i % 6 === 0) tap(g);
    g.update(1 / 60);
    maxTimers = Math.max(maxTimers, g.timers.length);
  }
  ok(events.length > 20, `calls fired: ${events.length}`);
  ok(Number.isFinite(g.ball.x) && Number.isFinite(g.ball.y), 'ball stays finite');
  ok(maxTimers <= 2, `timers do not leak: at most ${maxTimers} pending at once`);
}

// --- 必殺技を全部つけたままのフルマッチ（自動発動が混ざり続ける） ---
// 場面ごとに違う技が乗り続けても、フリーズ・NaN・タイマーリーク・回数のマイナスが
// 起きないことを確認する（技ごとの狙いは上の必殺技のブロックで個別に見ている）。
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.setSpecials(R.config.SPECIAL_MOVES.map((m) => m.key));
  g.start();
  let minUses = Infinity;
  let maxUses = -Infinity;
  let maxTimers = 0;
  const counts = () => R.config.SPECIAL_MOVES.map((m) => g.usesLeft(m.key));
  for (let i = 0; i < 60 * 600; i++) {
    if (g.phase === 'serve' && g.server === 'you') tap(g);
    if (g.phase === 'rally' && i % 6 === 0) tap(g);
    g.update(1 / 60);
    maxTimers = Math.max(maxTimers, g.timers.length);
    counts().forEach((n) => {
      minUses = Math.min(minUses, n);
      maxUses = Math.max(maxUses, n);
    });
  }
  ok(Number.isFinite(g.ball.x) && Number.isFinite(g.ball.y) && Number.isFinite(g.you.x),
    'ball and player stay finite with specials on');
  // 必殺技のコールを引っ込めるタイマー（SPECIAL.CALL_T）が1本増えうるので、上の
  // 「セット決着の2本」に加えて3本までは正常。
  ok(maxTimers <= 3, `timers do not leak with specials on: at most ${maxTimers} pending at once`);
  ok(minUses >= 0, `the per-move use count never goes negative: ${minUses}`);
  ok(g.stats.you.specials + g.matchStats.points > 0, 'the match actually progressed');
  ok(maxUses <= R.config.SPECIAL.USES_PER_GAME,
    `and never exceeds the per-game cap: ${maxUses}`);
}

// --- ダブルス：isResponder は着地点に近い方を選ぶ、coverPosition は逆サイドのネット際 ---
{
  const { isResponder, coverPosition } = R.ai;
  const ball = { x: 0, y: 1, z: 3, vx: 0, vy: 2, vz: 0 };
  const near = { x: 0.2, z: 3 };
  const far = { x: 5, z: -5 };
  ok(isResponder(near, far, ball) === true, 'closer player responds');
  ok(isResponder(far, near, ball) === false, 'farther player does not respond');

  const cover = coverPosition(2, 1.8);
  ok(cover.z === 1.8, `coverPosition uses the given net depth, z=${cover.z}`);
  ok(cover.x < 0, `coverPosition mirrors away from the responder's side, x=${cover.x}`);
}

// --- ダブルス雁行陣：前衛の構えが展開（クロス／ストレート）で変わる ---
// クロス展開（相手後衛と味方後衛が対角）＝相手後衛と同じ側へ寄ってストレートを守る。
// ストレート展開（同じ側）＝真ん中を越えてラリー側へ踏み込み、ネットにも詰める（攻めの姿勢）。
{
  const { frontPosition } = R.ai;
  const { DOUBLES } = R.config;
  const NET = DOUBLES.NET_Z_CPU;

  const cross = frontPosition({ x: 3 }, { x: -3 }, NET);   // 相手 右 / 味方 左
  const straight = frontPosition({ x: 3 }, { x: 3 }, NET); // 相手 右 / 味方 右
  ok(cross.x > straight.x && straight.x > 0,
    `cross guards wider than straight, both on the hitter's side: cross=${cross.x.toFixed(2)} straight=${straight.x.toFixed(2)}`);
  ok(cross.x >= DOUBLES.FRONT_GUARD_X - 0.01,
    `cross: the net player covers the down-the-line lane, x=${cross.x.toFixed(2)}`);
  ok(straight.x >= DOUBLES.FRONT_LEAN_X - 0.01,
    `straight: the net player steps past the middle onto the rally side, x=${straight.x.toFixed(2)}`);
  ok(Math.abs(straight.z) < Math.abs(cross.z),
    `straight: and closer to the net (attacking), |z|=${Math.abs(straight.z).toFixed(2)} vs ${Math.abs(cross.z).toFixed(2)}`);

  // 鏡映し：左右を入れ替えれば立ち位置も左右が入れ替わるだけ
  const crossL = frontPosition({ x: -3 }, { x: 3 }, NET);
  ok(Math.abs(crossL.x + cross.x) < 1e-9 && crossL.z === cross.z,
    `mirrored sides mirror the stance, got x=${crossL.x.toFixed(2)}`);
  // 相手後衛が中央にいるうちは、どちらにも出られるよう前衛も中央
  ok(Math.abs(frontPosition({ x: 0 }, { x: 3 }, NET).x) < 0.01,
    'a centred opponent keeps the net player centred');
  // you 陣地（netZ が負）でも自陣側に構える
  ok(frontPosition({ x: 3 }, { x: -3 }, DOUBLES.NET_Z_YOU).z < 0,
    'the you-side net player stands on its own side of the net');
}

// --- ダブルス雁行陣：前衛は自分の真横だけでなく、半歩ぶん前後を通る球にも触れる ---
// (退行テスト: 以前の canPoach() は「自分がいまいる深さ z ちょうど」の1点しか見ておらず、
//  頭の少し上を越えていく球や半歩前を通る球を目の前で素通りさせていた＝ユーザー報告
//  「近くに来たボールを見逃す」)
{
  const { poachSpot } = R.ai;
  const { solveShot, predictAtZ } = R.physics;
  const front = { x: 2.0, z: 1.8 }; // cpu 側のネット際に立つ前衛
  const from = { x: 0, y: 1.0, z: -10 };
  const ball = Object.assign(
    { x: from.x, y: from.y, z: from.z, spin: 'flat', wind: 0, curve: 0, bounces: 0, age: 0.25 },
    solveShot(from, { x: 1.8, y: R.config.PHYSICS.BALL_R, z: 6 }, 1.3, undefined, 'flat', 0),
  );
  const atOwnZ = predictAtZ(ball, front.z);
  ok(atOwnZ && atOwnZ.y > R.config.PLAYER.CPU_REACH_Y,
    `precondition: right at the net player's line the ball is over their head, y=${atOwnZ && atOwnZ.y.toFixed(2)}`);
  const spot = poachSpot(front, ball);
  ok(spot && Math.abs(spot.z - front.z) > 0.01,
    `half a step off their line they can still volley it, got ${JSON.stringify(spot)}`);
  ok(spot && Math.abs(spot.z) <= R.config.PLAYER.VOLLEY_Z && Math.abs(spot.z) >= R.config.DOUBLES.POACH_MIN_Z,
    `and the spot stays inside the net zone, z=${spot && spot.z.toFixed(2)}`);

  // 完全に頭上を越えていくロブには手を出さない（バウンドを待つ／後衛に任せる）
  const lob = Object.assign(
    { x: from.x, y: from.y, z: from.z, spin: 'flat', wind: 0, curve: 0, bounces: 0, age: 0.25 },
    solveShot(from, { x: 0, y: R.config.PHYSICS.BALL_R, z: 10.5 }, 1.9, undefined, 'flat', 0),
  );
  ok(poachSpot(front, lob) === null, 'a lob over their head is not claimed as a poach');
}

// --- ダブルス雁行陣：仕掛けるポーチ（ストレートを守る位置から中央へ出ていける） ---
// poachSpot() は「立っていれば触れる球」しか拾わないので、それだけではクロス展開で
// サイドを守っている前衛は一生ポーチに出られない。poachRun() は走る時間を織り込む。
{
  const { poachRun, poachSpot } = R.ai;
  const { solveShot } = R.physics;
  const from = { x: 3, y: 1.0, z: -10 };
  // 相手後衛(右)が左へクロスで打った球。前衛は右サイド(ストレート)を守って立っている。
  // 狙いの横位置は PLAYER.CPU_CHASE で1秒ほどに走り切れる範囲にしてある（前衛の守備
  // 位置 FRONT_GUARD_X=3.1 から 2〜3m の横移動＝現実のポーチの間合い）。ここをコート
  // 半面ぶん（x=-2.6 など）にすると、ネット際を1秒で5m以上走れる足を前提にすることになる。
  const ball = Object.assign(
    { x: from.x, y: from.y, z: from.z, spin: 'flat', wind: 0, curve: 0, bounces: 0, age: 0.05 },
    solveShot(from, { x: -1.5, y: R.config.PHYSICS.BALL_R, z: 8.5 }, 1.0, undefined, 'flat', 0),
  );
  const front = { x: R.config.DOUBLES.FRONT_GUARD_X, z: R.config.DOUBLES.NET_Z_CPU };
  ok(poachSpot(front, ball) === null,
    'precondition: standing still on the line, the net player cannot touch the cross-court ball');
  const run = poachRun(ball, front, 1);
  // 「守っていた線を捨てて中央へ出ていける」ことが見たいので、絶対位置(x<0)ではなく
  // 守備位置からどれだけ寄れたかで見る。
  ok(run && run.x < front.x - 1,
    `but reading it early they can run across and cut it off, got ${JSON.stringify(run)}`);
  ok(run && run.z > 0 && Math.abs(run.z) <= R.config.PLAYER.VOLLEY_Z,
    `and the interception stays in the net zone, z=${run && run.z.toFixed(2)}`);

  // 走っても間に合わない球には仕掛けない（出ていって抜かれる最悪の形を避ける）
  const fast = Object.assign(
    { x: from.x, y: from.y, z: from.z, spin: 'flat', wind: 0, curve: 0, bounces: 0, age: 0.05 },
    solveShot(from, { x: -4.6, y: R.config.PHYSICS.BALL_R, z: 9.5 }, 0.42, undefined, 'flat', 0),
  );
  ok(poachRun(fast, front, 1) === null, 'a ball it cannot reach in time is not chased');
  // もうバウンドした球はポーチではない
  ok(poachRun({ ...ball, bounces: 1 }, front, 1) === null, 'a ball that already bounced is not a poach');
}

// --- ダブルス雁行陣：どちらが取りにいくか（前衛が下がりすぎて陣形が崩れない） ---
{
  const { pairResponder } = R.ai;
  const { solveShot } = R.physics;
  const back = { x: 0, z: 10.9 };
  const front = { x: 2.0, z: 1.8 };
  const from = { x: 0, y: 1.0, z: -10 };
  const shot = (tx, tz, flight) => Object.assign(
    { x: from.x, y: from.y, z: from.z, spin: 'flat', wind: 0, curve: 0, bounces: 0, age: 0.25 },
    solveShot(from, { x: tx, y: R.config.PHYSICS.BALL_R, z: tz }, flight, undefined, 'flat', 0),
  );
  // 深い展開球は後衛の持ち場。前衛の近くを通っても（通過点が高すぎて触れないなら）出ていかない
  ok(pairResponder(back, front, shot(-3, 9.5, 1.0)) === 'back',
    'a deep ball to the open side is the baseliner\'s ball');
  // ネット際に落ちる短い球は前衛の持ち場（後衛をわざわざ走らせない）
  ok(pairResponder(back, front, shot(2.5, 2.2, 0.75)) === 'front',
    'a short ball in front of the net player is the net player\'s ball');
}

// --- ダブルス雁行陣：前衛がポーチに出ている間、後衛はベースライン付近で開ける ---
// (退行テスト: 以前は前衛がポーチに出ても後衛まで coverPosition()＝ネット際へ上がっており、
//  前衛が触れなかったときに自陣の深いところががら空きになっていた)
{
  const { backPosition } = R.ai;
  const { DOUBLES } = R.config;
  const spot = backPosition(2.5, 1);
  ok(spot.z > R.config.CPU.NET_Z,
    `the baseliner stays back while the partner poaches, z=${spot.z.toFixed(2)}`);
  ok(spot.x < 0, `and opens the side the poacher left, x=${spot.x.toFixed(2)}`);
  ok(backPosition(2.5, -1).z === -spot.z, 'the you-side mirror stays on its own side');
}

// --- ダブルス：ネット際の相手の「目の前を横切る」ボレーを打たない ---
// (退行テスト: 通常の cpuVolleyShot() は相手の逆サイドを狙う。相手もネット際にいる場面では
//  その球が相手の真ん前を至近距離で通ることになり、反応時間0.2秒足らずでボレーを打ち返され
//  続ける——「前衛同士のボレー合戦」というユーザー報告——の原因になっていた)
{
  const { doublesVolleyShot, doublesSmashShot } = R.ai;
  // 自分は you 陣地のネット際(z=-1.5)、相手はその向かいのネット際(z=+1.5)。
  // 打った球が相手の深さを通過するときの横位置を直線近似で求め、相手からどれだけ
  // 離れているかを見る（ボレーもスマッシュも、離れているほど「横切っていない」）。
  const FROM_Z = -1.5; const FOE_Z = 1.5;
  const TOO_CLOSE = PLAYER.CPU_BLIND_REACH * 3;
  const crossX = (fromX, shot) => fromX
    + (shot.target.x - fromX) * ((FOE_Z - FROM_Z) / (shot.target.z - FROM_Z));
  const run = (make, fromX, foeX) => {
    const foe = { x: foeX, z: FOE_Z };
    const back = { x: -foeX, z: 10.0 };
    let crossed = 0; let lobs = 0; let clear = 0; let worst = Infinity;
    for (let i = 0; i < 2000; i++) {
      const shot = make(foe, back, fromX);
      if (shot.lob) { lobs++; continue; }
      ok(shot.target.z > 0, 'the shot still goes into the opponent half');
      // わざとラインを割る1本（scatterOut）はコートの外へ飛ばす「ミス」なので、狙いの
      // 評価からは外す（ミス球が相手の近くを通るのは現実どおり）。
      if (Math.abs(shot.target.z) > HALF_L || Math.abs(shot.target.x) > COURT.DW / 2) continue;
      const gap = Math.abs(crossX(fromX, shot) - foeX);
      worst = Math.min(worst, gap);
      // 至近距離で届く範囲（PLAYER.CPU_BLIND_REACH）より十分に外していれば「横切っていない」
      if (gap < TOO_CLOSE) crossed++; else clear++;
    }
    return { crossed, lobs, clear, worst };
  };
  const volley = (foe, back, fromX) => doublesVolleyShot(foe, back, fromX, 1, 0, 1.6);
  const smash = (foe, back, fromX) => doublesSmashShot(foe, back, fromX, 1, 0);

  // 相手が中央寄りに立っている＝外側に抜くスペースがある
  const open = run(volley, 1.8, 0.6);
  ok(open.crossed === 0,
    `the volley never passes within a racket of the net player: crossed=${open.crossed}, closest=${open.worst.toFixed(2)}m`);
  ok(open.clear > 0 && open.lobs === 0,
    `and it is played past them rather than lobbed when there is room: clear=${open.clear} lobs=${open.lobs}`);

  // 前衛同士が真正面で向かい合う（同じ横位置）。ここで中央側へ逃がすと相手の x を
  // そのまま通過してしまうので、サイドライン側へ抜ける必要がある。
  const face = run(volley, 1.9, 1.9);
  ok(face.crossed === 0 && face.lobs === 0,
    `face to face it still goes outside them: crossed=${face.crossed} lobs=${face.lobs} closest=${face.worst.toFixed(2)}m`);

  // スマッシュも同じ（ネット際から打つスマッシュが相手の真ん前を通らない）
  const sm = run(smash, 1.9, 1.9);
  ok(sm.crossed === 0,
    `the same holds for a smash from the net: crossed=${sm.crossed}, closest=${sm.worst.toFixed(2)}m`);

  // 相手がサイドライン際を締めていて、自分はさらにその外＝横に抜く隙間が残っていない。
  // ボレーはこのときだけ頭を越す（ロブボレー）。
  const shut = run(volley, 5.0, 4.2);
  ok(shut.lobs === 2000,
    `with the line shut off the volley goes over their head instead: lobs=${shut.lobs}/2000`);
  // スマッシュを打った後にロブへ切り替えるのは形として不自然なので、そちらは従来の狙いに戻る
  ok(run(smash, 5.0, 4.2).lobs === 0, 'a smash never turns into a lob');

  // 左右を入れ替えても同じ（符号だけの対称）
  const mirrored = run(volley, -1.8, -0.6);
  ok(mirrored.crossed === 0 && mirrored.lobs === 0, 'the mirrored case behaves the same');
}

// --- ダブルス：向かいのネット際から打たれた球は、反応が間に合わず返せない ---
// (退行テスト: 反応時間の下限が CPU_REFLEX_REACH(0.53m) 止まりだったため、3mほどの至近距離で
//  打たれた球にも届いてしまい、前衛同士がボレーを打ち合い続けていた＝ユーザー報告)
{
  const { DOUBLES, PLAYER, PHYSICS } = R.config;
  const netToNet = (age) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(true);
    g.phase = 'rally';
    g.serveInFlight = false;
    Object.assign(g.cpuMate, { x: 0, z: DOUBLES.NET_Z_CPU });
    Object.assign(g.cpu, { x: 0, z: HALF_L - 0.5 });
    // 0.4m 横をかすめて通る球。立っていれば触れる距離だが、反応する時間があるかどうか。
    Object.assign(g.ball, {
      x: 0.4, y: 1.2, z: DOUBLES.NET_Z_CPU, px: 0.4, py: 1.2, pz: DOUBLES.NET_Z_CPU,
      vx: 0, vy: 0, vz: 9, bounces: 0, last: 'you', live: true, age, wind: 0, spin: 'flat',
    });
    g.checkSwings();
    return g.ball.last === 'cpu';
  };
  ok(netToNet(0.15) === false,
    'a ball struck from the opposite net position goes past before they can move');
  ok(netToNet(0.9) === true,
    'the same ball played from the baseline gives them time to reach it');
}

// --- ダブルス雁行陣：後衛の配球は「前衛を避けてクロス、隙があればストレートを抜く」 ---
{
  const { doublesRallyShot } = R.ai;
  const { DOUBLES } = R.config;
  const back = { x: -3, z: 10.5 };
  const run = (frontX, stretch) => {
    const front = { x: frontX, z: 1.8 };
    let cross = 0; let pass = 0; let lob = 0;
    for (let i = 0; i < 4000; i++) {
      const shot = doublesRallyShot(front, back, -1, stretch, 1, 1);
      if (shot.lob) lob++;
      else if (Math.sign(shot.target.x) === Math.sign(frontX) && Math.abs(shot.target.x) > 2.5) pass++;
      else cross++;
      ok(shot.target.z < 0, 'doubles rally shot always aims into the opponent half');
    }
    return { cross, pass, lob };
  };
  // 前衛がサイドを締めている（ストレートに隙がない）＝ほぼクロス一辺倒
  const tight = run(3.2, 0);
  ok(tight.cross > tight.pass * 6,
    `a net player covering the line is played cross-court: cross=${tight.cross} pass=${tight.pass}`);
  // 前衛が中央へ寄ってポーチを狙っている＝ストレートのパッシングが増える
  const loose = run(0.6, 0);
  ok(loose.pass > tight.pass * 3,
    `a net player leaning to the middle gets passed down the line more: ${tight.pass} -> ${loose.pass}`);
  ok(loose.cross > loose.pass,
    `but cross-court stays the staple: cross=${loose.cross} pass=${loose.pass}`);
  // 走らされているときは抜きにいかない（無理をしない）
  ok(run(0.6, 1).pass === 0, 'a stretched baseliner never tries the pass');
}

// --- ダブルス：chasePosition(ball, side) は side=-1 のとき自陣(z<0)側に鏡映しになる ---
// (退行テスト: side を渡さないと常に cpu 陣地(z>0)基準の値を返していたため、
//  youMate が you 陣地の落下点を追うときにネットの向こう側へ寄ってしまうバグがあった)
{
  const { chasePosition } = R.ai;
  const deepCpuBall = {
    x: 1, y: 1, z: 9, vx: 0, vy: 1, vz: 0, bounces: 0,
  };
  const deepYouBall = {
    x: 1, y: 1, z: -9, vx: 0, vy: 1, vz: 0, bounces: 0,
  }; // 鏡映しの入力
  const cpuSide = chasePosition(deepCpuBall, 1);
  const youSide = chasePosition(deepYouBall, -1);
  ok(cpuSide.z > 0, `default/side=1 stays on the cpu side for a deep cpu-side ball, z=${cpuSide.z}`);
  ok(youSide.z < 0, `side=-1 stays on the you side for the mirrored deep you-side ball, z=${youSide.z}`);
  ok(Math.abs(youSide.z) === Math.abs(cpuSide.z), 'side=-1 mirrors the magnitude of side=1 for mirrored inputs');

  const shallowYouBall = {
    x: 0, y: 1, z: -0.5, vx: 0, vy: 1, vz: 0, bounces: 0,
  };
  const youShallow = chasePosition(shallowYouBall, -1);
  ok(youShallow.z < 0, `even a shallow you-side landing keeps the chase target on the you side, z=${youShallow.z}`);
}

// --- ダブルス：hit() は個人ごとの演出を持ちつつ、ball.last はチーム単位のまま ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(true);
  ok(g.doubles === true, 'precondition: doubles mode is active');

  g.you.x = 0;
  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2;
  g.hit('you');
  ok(g.ball.last === 'you', `hit('you') -> ball.last is team 'you', got ${g.ball.last}`);

  g.youMate.x = 3; g.youMate.z = -3;
  g.ball.x = 3.2; g.ball.y = 1; g.ball.z = -3;
  g.hit('youMate');
  ok(g.ball.last === 'you', `hit('youMate') -> ball.last is still team 'you', got ${g.ball.last}`);
  ok(['forehand', 'backhand'].includes(g.youMate.stroke), `youMate gets its own stroke, got ${g.youMate.stroke}`);

  g.cpuMate.x = -3; g.cpuMate.z = 3;
  g.ball.x = -3.2; g.ball.y = 1; g.ball.z = 3;
  g.hit('cpuMate');
  ok(g.ball.last === 'cpu', `hit('cpuMate') -> ball.last is team 'cpu', got ${g.ball.last}`);
}

// --- ダブルス：youMate は cpu 陣地(z>0)へ、cpu/cpuMate は you 陣地(z<0)へ正しく打ち返す ---
// (退行テスト: youMate が shotTarget() の既定方向をそのまま使っていた結果、自陣を狙って
//  相手コートに届かないバグがあった。着地点の z 座標の符号で検証する)
{
  const landingFor = (who, ballZ) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(true);
    g.you.x = 0; g.cpu.x = 0;
    g.ball.x = 0.3; g.ball.y = 1; g.ball.z = ballZ;
    g.hit(who);
    return R.physics.predictLanding(g.ball);
  };
  for (let i = 0; i < 20; i++) {
    const youMateLanding = landingFor('youMate', -2);
    ok(youMateLanding.z > 0, `youMate should return into the cpu court (z>0), got z=${youMateLanding.z}`);

    const cpuLanding = landingFor('cpu', 2);
    ok(cpuLanding.z < 0, `cpu should return into the you court (z<0), got z=${cpuLanding.z}`);

    const cpuMateLanding = landingFor('cpuMate', 2);
    ok(cpuMateLanding.z < 0, `cpuMate should return into the you court (z<0), got z=${cpuMateLanding.z}`);
  }
}

// --- ダブルス：checkSwings は4人ぶんの reach を見る（人間が届かない球を味方が拾う） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(true);
  g.phase = 'rally';
  g.ball.last = 'cpu';
  g.ball.x = 0.1; g.ball.y = 1; g.ball.z = -1;
  g.you.x = 10; g.you.z = -10;   // 人間は遠い
  g.youMate.x = 0; g.youMate.z = -1; // 味方は近い
  g.checkSwings();
  ok(g.ball.last === 'you', `youMate returns a ball out of the human's reach, ball.last=${g.ball.last}`);
}

// --- ダブルス：コート幅の out 判定がダブルスサイドラインまで広がる ---
{
  const midAlleyX = (HALF_W + COURT.DW / 2) / 2; // シングルスラインの外、ダブルスラインの内側
  const ballR = R.config.PHYSICS.BALL_R;
  const setupBounce = (doublesMode) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.doubles = doublesMode;
    g.phase = 'rally';
    Object.assign(g.ball, {
      last: 'you', x: midAlleyX, z: 5, y: ballR, vy: -1, bounces: 0,
    });
    return g;
  };

  ok(setupBounce(false).bounce() === true, 'singles: alley position is out (ends the point)');
  ok(setupBounce(true).bounce() === false, 'doubles: same position is in (doubles sideline)');
}

// --- ダブルス：サーバーはゲームごとに交代し、各チーム内でもパートナーと交互になる ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(true);
  ok(g.server === 'you' && g.servingPlayer() === 'you', 'you serves first for team you by default');

  // you チームに1ゲームぶん与える（4-0）
  for (let i = 0; i < 4; i++) { g.phase = 'rally'; g.endPoint('you', 'test'); }
  ok(g.server === 'cpu', `server switches to team cpu after a game, got ${g.server}`);
  ok(g.serverPartner.you === 'youMate',
    `team you's server rotates to youMate for next time, got ${g.serverPartner.you}`);

  // cpu チームに1ゲームぶん与える
  for (let i = 0; i < 4; i++) { g.phase = 'rally'; g.endPoint('cpu', 'test'); }
  ok(g.server === 'you', `server switches back to team you, got ${g.server}`);
  ok(g.servingPlayer() === 'youMate', `youMate serves this time (rotated), got ${g.servingPlayer()}`);
  ok(g.serverPartner.cpu === 'cpuMate',
    `team cpu's server also rotated to cpuMate, got ${g.serverPartner.cpu}`);

  // さらに you チームの番が回ってくると、主力に戻る
  for (let i = 0; i < 4; i++) { g.phase = 'rally'; g.endPoint('cpu', 'test'); }
  for (let i = 0; i < 4; i++) { g.phase = 'rally'; g.endPoint('you', 'test'); }
  ok(g.serverPartner.you === 'you', `team you's server rotates back to you, got ${g.serverPartner.you}`);
}

// --- トス（コイントス）：勝った側が選んだサーブ/レシーブが最初のサーバーになり、
//     以降のゲームごとの交代（ダブルスのパートナーの巡りも含む）はいつもどおり続く ---
{
  // 引数省略時は従来どおり you が最初のサーバー（既存の挙動を壊さない）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(false);
    ok(g.server === 'you', `omitting initialServer keeps the default (you), got ${g.server}`);
  }

  // シングルス：トスに負けて相手（cpu）にサーブを選ばれた場合
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(false, 'cpu');
    ok(g.server === 'cpu', `initialServer='cpu' makes cpu serve first, got ${g.server}`);
    // 以降のゲームごとの交代は既存ロジックのまま（1ゲームぶん与えると交代する）
    for (let i = 0; i < 4; i++) { g.phase = 'rally'; g.endPoint('cpu', 'test'); }
    ok(g.server === 'you', `the usual per-game alternation still applies afterward, got ${g.server}`);
  }

  // ダブルス：トスに勝って人間チームがレシーブを選んだ（＝cpuチームが最初にサーブ）場合、
  // パートナーの巡りも含めて既存ロジックがそのまま続く
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(true, 'cpu');
    ok(g.server === 'cpu' && g.servingPlayer() === 'cpu',
      `doubles: initialServer='cpu' makes the main cpu serve first, got server=${g.server} servingPlayer=${g.servingPlayer()}`);
    for (let i = 0; i < 4; i++) { g.phase = 'rally'; g.endPoint('you', 'test'); } // cpuチームに1ゲームぶん与える
    ok(g.server === 'you' && g.serverPartner.cpu === 'cpuMate',
      `doubles: the per-game rotation (including the partner rotation) still works from a non-default start, got server=${g.server} serverPartner.cpu=${g.serverPartner.cpu}`);
  }

  // 既に始まっている試合には影響しない（2回目の start() は無視される）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(false, 'cpu');
    g.start(false, 'you'); // 2回目は無視されるはず
    ok(g.server === 'cpu', `a second start() call (even with a different initialServer) is a no-op, got ${g.server}`);
  }
}

// --- ダブルス：レシーバーは固定（サイドで主力/相方が決まる）、もう一方はネット際で構える ---
{
  const { DOUBLES } = R.config;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.doubles = true; // receivingPlayer() はシングルスでは常にチーム名を返すため
  ok(g.receivingPlayer('you', 1) === 'you', 'primary receives on side=+1');
  ok(g.receivingPlayer('you', -1) === 'youMate', 'mate receives on side=-1');
  ok(g.receivingPlayer('cpu', 1) === 'cpu', 'primary receives on side=+1 (cpu team)');
  ok(g.receivingPlayer('cpu', -1) === 'cpuMate', 'mate receives on side=-1 (cpu team)');

  g.server = 'cpu'; // you チームが受ける番
  g.start(true);
  ok(g.match.serveSide === -1, 'precondition: fresh match starts on side=-1');
  // side=-1 なので youMate が受け、you はネット際で構えているはず
  ok(Math.abs(g.youMate.x) < HALF_W + 1 && g.youMate.z < -HALF_L, `youMate (receiver) is at the return position, x=${g.youMate.x} z=${g.youMate.z}`);
  ok(Math.abs(g.you.z - DOUBLES.NET_Z_YOU) < 0.01, `you (not receiving) waits at the net, z=${g.you.z}`);
}

// --- ダブルス：サーブ待ち中は、実際にサーブする本人をコース取りロジックで動かさない ---
// (退行テスト: moveDoublesTeams() が phase='serve' 中も毎フレーム通常のラリー用ロジック
//  （追う/構える）を動かしていたため、サーバーはサービススタンスからネット側へ歩いて
//  出てしまいフットフォルトに見え、レシーブ側の2人もまだ来ていないサーブへの構えを
//  くずされて（＝レシーブできない一因になって）いた)
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(true);
  // team you の担当を youMate に回して、youMate がサーブする番を作る
  g.server = 'you';
  g.serverPartner.you = 'youMate';
  g.newPoint();
  ok(g.servingPlayer() === 'youMate', `precondition: youMate is serving, got ${g.servingPlayer()}`);
  const stance = {
    youMate: { x: g.youMate.x, z: g.youMate.z },
    you: { x: g.you.x, z: g.you.z },
    cpu: { x: g.cpu.x, z: g.cpu.z },
    cpuMate: { x: g.cpuMate.x, z: g.cpuMate.z },
  };
  ok(stance.youMate.z < -HALF_L, `precondition: youMate starts behind the baseline, z=${stance.youMate.z}`);

  // CPU_SERVE_READY + CPU_SERVE_DELAY が過ぎる前の複数フレームぶん進める。まだ serve() は呼ばれていない。
  for (let i = 0; i < 30; i++) { g.movePlayers(1 / 60); }
  ok(g.phase === 'serve', 'precondition: still waiting to serve');
  ok(Math.abs(g.youMate.x - stance.youMate.x) < 1e-6 && Math.abs(g.youMate.z - stance.youMate.z) < 1e-6,
    `server (youMate) stays at the serve stance while waiting to serve, got x=${g.youMate.x} z=${g.youMate.z}`);
  ok(Math.abs(g.cpu.x - stance.cpu.x) < 1e-6 && Math.abs(g.cpu.z - stance.cpu.z) < 1e-6,
    `receiving team (cpu) is not dragged out of its stance before the serve, got x=${g.cpu.x} z=${g.cpu.z}`);
  ok(Math.abs(g.cpuMate.x - stance.cpuMate.x) < 1e-6 && Math.abs(g.cpuMate.z - stance.cpuMate.z) < 1e-6,
    `receiving team (cpuMate) is not dragged out of its stance before the serve, got x=${g.cpuMate.x} z=${g.cpuMate.z}`);

  // cpu チームのサーブでも同様（cpu/cpuMate どちらでも本人だけは動かさない、youMate 側の受け手も崩れない）
  const g2 = new R.Game({ input: fakeInput, hooks: noHooks });
  g2.start(true);
  g2.server = 'cpu';
  g2.serverPartner.cpu = 'cpuMate';
  g2.newPoint();
  ok(g2.servingPlayer() === 'cpuMate', `precondition: cpuMate is serving, got ${g2.servingPlayer()}`);
  const stance2 = {
    cpuMate: { x: g2.cpuMate.x, z: g2.cpuMate.z },
    youMate: { x: g2.youMate.x, z: g2.youMate.z },
  };
  for (let i = 0; i < 30; i++) { g2.movePlayers(1 / 60); }
  ok(Math.abs(g2.cpuMate.x - stance2.cpuMate.x) < 1e-6 && Math.abs(g2.cpuMate.z - stance2.cpuMate.z) < 1e-6,
    `server (cpuMate) stays at the serve stance while waiting to serve, got x=${g2.cpuMate.x} z=${g2.cpuMate.z}`);
  ok(Math.abs(g2.youMate.x - stance2.youMate.x) < 1e-6 && Math.abs(g2.youMate.z - stance2.youMate.z) < 1e-6,
    `receiving team (youMate) is not dragged out of its stance before the serve, got x=${g2.youMate.x} z=${g2.youMate.z}`);
}

// --- ダブルス：サーブ前に自分（R/F）とパートナー（Q/E）の立ち位置を前／後ろに変えられる。
//     サーバー／レシーバーの番の選手は動かない ---
{
  const { DOUBLES } = R.config;
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  /** server: 'you' | 'youMate' | 'cpu'、side: サービスサイド。返すのはサーブ待ちの状態の Game */
  const setup = (server, side = -1) => {
    const calls = [];
    const g = new R.Game({ input: fakeInput, hooks: { ...noHooks, call: (big, sub) => calls.push(`${big}:${sub}`) } });
    g.server = server === 'cpu' ? 'cpu' : 'you';
    g.start(true);
    if (server === 'youMate') g.serverPartner.you = 'youMate';
    if (side === 1) g.match.points.cpu = 1; // serveSide は得点の合計で決まる（奇数＝+1）
    g.newPoint();
    calls.length = 0;
    return { g, calls };
  };

  // パートナーがサーブする番：自分は前にも後ろにも立てる。パートナー（サーバー）は動かない
  {
    const { g, calls } = setup('youMate');
    ok(g.servingPlayer() === 'youMate' && g.phase === 'serve', 'precondition: youMate is about to serve');
    ok(near(g.you.z, DOUBLES.NET_Z_YOU), `by default you wait at the net, z=${g.you.z}`);
    g.you.vx = 3;
    g.setYouFormation('back');
    ok(near(g.you.z, DOUBLES.BACK_Z_YOU), `F puts you at the back, z=${g.you.z}`);
    ok(near(g.you.x, -g.youMate.x * DOUBLES.MIRROR), `still on the side opposite the server, x=${g.you.x}`);
    ok(g.you.vx === 0, 'and drops any momentum you were walking with');
    ok(calls.some((c) => c.startsWith('自分:')), `the order is acknowledged, calls=${calls}`);
    g.setYouFormation('net');
    ok(near(g.you.z, DOUBLES.NET_Z_YOU), `R puts you back at the net, z=${g.you.z}`);

    const stance = { x: g.youMate.x, z: g.youMate.z };
    g.setYouMateFormation('back');
    ok(near(g.youMate.x, stance.x) && near(g.youMate.z, stance.z),
      `the partner is serving, so E does not move them, got x=${g.youMate.x} z=${g.youMate.z}`);
    ok(g.youMateFormation === 'back', 'but the order still holds for the rally after the serve');
  }

  // 自分がサーブする番：自分は動かせない。パートナー（サーバーの相方）は前／後ろに動かせる
  {
    const { g, calls } = setup('you');
    ok(g.servingPlayer() === 'you', 'precondition: you are about to serve');
    const stance = { x: g.you.x, z: g.you.z };
    g.setYouFormation('net');
    ok(near(g.you.x, stance.x) && near(g.you.z, stance.z), `the server cannot be moved by R, got z=${g.you.z}`);
    ok(g.youFormation === 'net' && calls.some((c) => c.includes('サーブ担当')),
      `and is told why, calls=${calls}`);
    g.setYouMateFormation('back');
    ok(near(g.youMate.z, DOUBLES.BACK_Z_YOU), `E moves the server's partner to the back, z=${g.youMate.z}`);
    g.setYouMateFormation('net');
    ok(near(g.youMate.z, DOUBLES.NET_Z_YOU), `Q moves them back up to the net, z=${g.youMate.z}`);
  }

  // 自分がレシーブする番（side=+1）：自分は動かせない。パートナーは動かせる
  {
    const { g } = setup('cpu', 1);
    ok(g.receivingPlayer('you', 1) === 'you', 'precondition: you are receiving');
    const stance = { x: g.you.x, z: g.you.z };
    g.setYouFormation('net');
    ok(near(g.you.x, stance.x) && near(g.you.z, stance.z), `the receiver cannot be moved by R, got z=${g.you.z}`);
    g.setYouMateFormation('back');
    ok(near(g.youMate.z, DOUBLES.BACK_Z_YOU), `E moves the receiver's partner to the back, z=${g.youMate.z}`);
  }

  // パートナーがレシーブする番（side=-1）：自分は動かせる。パートナーは動かない
  {
    const { g } = setup('cpu', -1);
    ok(g.receivingPlayer('you', -1) === 'youMate', 'precondition: youMate is receiving');
    g.setYouFormation('back');
    ok(near(g.you.z, DOUBLES.BACK_Z_YOU), `F puts you at the back while the partner receives, z=${g.you.z}`);
    const stance = { x: g.youMate.x, z: g.youMate.z };
    g.setYouMateFormation('back');
    ok(near(g.youMate.x, stance.x) && near(g.youMate.z, stance.z),
      `the receiver (youMate) is not moved by E, got z=${g.youMate.z}`);

    // 選んだ位置は次のポイントにも引き継がれる（次に相方が担当する番も後ろから始まる）
    g.newPoint(); // 得点は動かしていない＝同じサイドでもう一度
    ok(near(g.you.z, DOUBLES.BACK_Z_YOU), `your chosen spot carries over to the next point, z=${g.you.z}`);
  }

  // パートナーに「下がれ」と言っても、パートナーのサーブの番に自分まで下げられない
  // （退行テスト：以前は人間の立ち位置も youMateFormation で決めていた）
  {
    const { g } = setup('youMate');
    g.setYouMateFormation('back');
    g.newPoint();
    ok(g.servingPlayer() === 'youMate' && near(g.you.z, DOUBLES.NET_Z_YOU),
      `the partner's "stay back" order does not drag you back too, z=${g.you.z}`);
  }

  // サーブ前でなければ（ラリー中）R/F は何もしない。シングルスでも何もしない
  {
    const { g } = setup('youMate');
    g.phase = 'rally';
    g.you.x = 1.234; g.you.z = -5.678;
    g.setYouFormation('back');
    ok(near(g.you.z, -5.678) && g.youFormation === 'net', `R/F do nothing during a rally, z=${g.you.z}`);

    const s = new R.Game({ input: fakeInput, hooks: noHooks });
    s.start(false);
    const z = s.you.z;
    s.setYouFormation('net');
    ok(near(s.you.z, z), 'R/F do nothing in singles');
  }

  // HUD の「立ち位置の指示」の札に渡す状態（formationOrders）：指示の今の値と、サーブ待ちの担当
  {
    const { g } = setup('you');
    let o = g.formationOrders();
    ok(o && o.youMate === 'net' && o.you === 'net', `both orders start at the net, got ${JSON.stringify(o)}`);
    ok(o.youDuty === 'サーブ' && o.youMateDuty === null, `you are serving, the partner is not, got ${JSON.stringify(o)}`);
    g.setYouMateFormation('back');
    ok(g.formationOrders().youMate === 'back', 'E shows up as the partner standing back');

    const { g: g2 } = setup('cpu', -1);
    g2.setYouFormation('back');
    o = g2.formationOrders();
    ok(o.you === 'back' && o.youMateDuty === 'レシーブ' && o.youDuty === null,
      `F shows up while the partner receives, got ${JSON.stringify(o)}`);
    g2.phase = 'rally';
    o = g2.formationOrders();
    ok(o.you === 'back' && o.youDuty === null && o.youMateDuty === null,
      `in a rally the orders stay but no one is on serve/return duty, got ${JSON.stringify(o)}`);

    const s = new R.Game({ input: fakeInput, hooks: noHooks });
    s.start(false);
    ok(s.formationOrders() === null, 'singles has no formation orders to show');
  }
}

// --- ダブルス：「下がれ」を指示したパートナーは、ロブを叩きに前へ出ない ---
// (ユーザー報告: パートナーに「下がれ」を指示していても、ロブが上がるたびにネット際まで
//  走り出てスマッシュしてしまい、指示が事実上効いていなかった。ai.smashApproach() は
//  「叩けるなら叩く」だけを見ていて、指示（youMateFormation）がそこまで届いていなかった)
{
  const { DOUBLES, COURT } = R.config;
  const { smashApproach, chasePosition } = R.ai;
  const mate = (z) => ({ x: 0, z, attr: { reach: 1, speed: 1 }, stamina: 1 });
  /** 落ちてくる途中の高いロブ（まだノーバウンド）。vz が大きいほど奥へ落ちる */
  const lob = (y, z, vz) => ({ x: 0, y, z, vx: 0, vy: 0, vz, bounces: 0, age: 0.3, spin: 'flat' });

  // ネット際に落ちてくる短いロブ：指示が無ければ叩きに出るが、「下がれ」なら出ない。
  // 高さは PLAYER.CPU_CHASE で z=-6 から打点まで走り着ける滞空時間になるよう取ってある
  // （smashApproach() は dist/CPU_CHASE で「間に合うか」を見積もるので、足の速さを
  // 変えるとこの前提も動く）。
  const short = lob(9, 1, -3);
  const rush = smashApproach(short, mate(-6), -1);
  ok(rush && rush.z > -COURT.SERVICE,
    `precondition: without an order the partner runs up to smash a short lob, got ${rush && rush.z.toFixed(2)}`);
  ok(smashApproach(short, mate(-6), -1, DOUBLES.BACK_SMASH_Z) === null,
    'told to stay back, the partner does not go up to smash it');
  ok(chasePosition(short, -1, mate(-6), DOUBLES.BACK_SMASH_Z).z
    < chasePosition(short, -1, mate(-6)).z,
    'so the spot it chases stays deeper than the smash spot (it waits for the bounce instead)');

  // 「下がれ」でも、下がったまま叩ける深いロブは今までどおり叩く（指示は前に出ることだけを止める）
  const deep = lob(8, 0, -8);
  const back = smashApproach(deep, mate(-9), -1, DOUBLES.BACK_SMASH_Z);
  ok(back && back.z <= -COURT.SERVICE,
    `a lob that comes down deep is still smashed from back there, got ${back && back.z.toFixed(2)}`);

  // 指示が実際に追いかけ方まで届いている（moveDoublesTeams 経由）
  const lobRally = (formation) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(true);
    g.setYouMateFormation(formation);
    g.phase = 'rally';
    g.serveInFlight = false;   // サーブリターン中はレシーバー固定なので、通常のラリーにする
    g.ball.last = 'cpu';
    // 上の short とまったく同じロブを使う（別々に書くと、片方だけ直したときに静かにずれる）
    Object.assign(g.ball, short, { live: true });
    g.you.x = -6; g.you.z = -11; // 人間は遠くへ置いて、この球の担当を youMate に回す
    g.youMate.x = 0; g.youMate.z = -6;
    g.reactTimers.youMate = 0;
    g.recoverTimers.youMate = 0;
    ok(g.doublesResponder('you') === 'youMate',
      `precondition: the partner is the one answering this lob (${formation})`);
    // 目標へ着き切るだけ回す。目標は動かないので着いたらそこで止まる＝多めに回して問題ない
    // （frame 数をぎりぎりにすると PLAYER.CPU_CHASE を変えたとき「着く手前で打ち切った」
    // だけで落ちる）。
    for (let i = 0; i < 200; i++) g.moveDoublesTeams(1 / 60);
    return g.youMate.z;
  };
  const zNet = lobRally('net');
  const zBack = lobRally('back');
  ok(zBack < zNet - 1,
    `the order reaches the chase itself: net z=${zNet.toFixed(2)} vs back z=${zBack.toFixed(2)}`);
  ok(zNet > -COURT.SERVICE && Math.abs(zNet - rush.z) < 0.01,
    `and without it the partner really does run to the smash spot, got z=${zNet.toFixed(2)}`);
}

// --- ダブルス雁行陣：展開が変わると CPU の前衛が実際に立ち位置を変える（moveDoublesTeams 経由） ---
{
  const { DOUBLES } = R.config;
  // you 陣地の後衛（人間）を左右に置き分けて、cpu の前衛(cpuMate)がどちらへ構えるか見る。
  // cpu（味方後衛）は右(+x)固定なので、人間も右＝ストレート展開／人間が左＝クロス展開。
  const stance = (youX) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(true);
    g.phase = 'rally';
    g.serveInFlight = false;
    g.ball.last = 'cpu'; // cpu チームが打った直後＝前衛は構えに戻るだけ（追わない）
    Object.assign(g.ball, { x: 0, y: 1.2, z: -2, vx: 0, vy: 1, vz: -6, bounces: 0, age: 0.2, live: true });
    g.you.x = youX; g.you.z = -10.5;
    g.youMate.x = -youX; g.youMate.z = DOUBLES.NET_Z_YOU;
    g.cpu.x = 3; g.cpu.z = 10.5;
    g.cpuMate.x = 0; g.cpuMate.z = DOUBLES.NET_Z_CPU;
    // 前衛・後衛はポイントごとに決まる（開幕ポイントは cpuMate がレシーバー＝後衛）ので、
    // 上の立ち位置どおり cpuMate を前衛にしておく
    g.frontOf.cpu = 'cpuMate';
    g.poachCommit.cpuMate = false;
    for (let i = 0; i < 240; i++) {
      g.poachCommit.cpuMate = false; // ここで見たいのは「仕掛けない」ときの構え
      // 後衛たちは展開そのものなので固定する（放っておくと両者ともセンターへ戻ってしまい、
      // 「クロスかストレートか」自体が消えてしまう）
      g.cpu.x = 3; g.cpu.z = 10.5;
      g.you.x = youX; g.you.z = -10.5;
      g.moveDoublesTeams(1 / 60);
    }
    return { x: g.cpuMate.x, z: g.cpuMate.z };
  };
  const straight = stance(3);   // 人間も cpu も +x 側＝ストレート展開
  const cross = stance(-3);     // 人間が -x 側＝クロス展開
  ok(straight.x > 0 && straight.x >= DOUBLES.FRONT_LEAN_X - 0.1,
    `straight rally: the CPU net player steps past the middle onto the rally side, x=${straight.x.toFixed(2)}`);
  ok(cross.x < 0 && Math.abs(cross.x) >= DOUBLES.FRONT_GUARD_X - 0.1,
    `cross rally: it moves over to guard the line instead, x=${cross.x.toFixed(2)}`);
  ok(straight.z < cross.z,
    `and stands closer to the net on the straight pattern, z=${straight.z.toFixed(2)} vs ${cross.z.toFixed(2)}`);
}

// --- ダブルス雁行陣：CPU の前衛・後衛はポイントの途中で入れ替わらない ---
// (退行テスト／ユーザー報告: 以前は cpu＝後衛・cpuMate＝前衛で固定だったため、cpuMate が
//  サーブ／レシーブする番では、ベースラインから始めた cpuMate がネットへ上がり、ネット際で
//  構えていた cpu がベースラインへ下がる＝ポイントの途中で2人がすれ違っていた)
{
  const { DOUBLES } = R.config;
  /** cpu チームの誰がサーブ／レシーブするかを決めてポイントを始める */
  const pointWith = (cpuServes, mateTakesIt) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(true);
    g.server = cpuServes ? 'cpu' : 'you';
    if (cpuServes) g.serverPartner.cpu = mateTakesIt ? 'cpuMate' : 'cpu';
    // レシーブはサイドで決まる（side=+1 は主力、-1 は相方）
    else g.match.points.you = mateTakesIt ? 0 : 1;
    g.newPoint();
    return g;
  };
  for (const cpuServes of [true, false]) {
    for (const mateTakesIt of [true, false]) {
      const g = pointWith(cpuServes, mateTakesIt);
      const label = `${mateTakesIt ? 'cpuMate' : 'cpu'} ${cpuServes ? 'serves' : 'receives'}`;
      const taker = mateTakesIt ? 'cpuMate' : 'cpu';
      ok(cpuServes ? g.servingPlayer() === taker : g.receivingPlayer('cpu', g.match.serveSide) === taker,
        `precondition: ${label}`);
      const netMan = mateTakesIt ? 'cpu' : 'cpuMate';
      ok(Math.abs(g[netMan].z - DOUBLES.NET_Z_CPU) < 0.01,
        `precondition (${label}): ${netMan} starts at the net, z=${g[netMan].z}`);
      ok(g.frontOf.cpu === netMan, `${label}: the one at the net plays front, got ${g.frontOf.cpu}`);
    }
  }

  // cpuMate がサーブした後のラリー：cpuMate は後衛のまま深く、cpu は前衛のままネット際に残る
  {
    const g = pointWith(true, true);
    g.phase = 'rally';
    g.serveInFlight = false;
    g.ball.last = 'cpu'; // cpu チームが打った直後＝2人とも構えに戻るだけ
    Object.assign(g.ball, { x: 0, y: 1.2, z: -2, vx: 0, vy: 1, vz: -6, bounces: 0, age: 0.2, live: true });
    for (let i = 0; i < 240; i++) g.moveDoublesTeams(1 / 60);
    ok(g.cpu.z <= DOUBLES.FRONT_MAX_Z, `the server's partner (cpu) stays at the net, z=${g.cpu.z.toFixed(2)}`);
    ok(g.cpuMate.z > HALF_L - 2, `the server (cpuMate) stays back, z=${g.cpuMate.z.toFixed(2)}`);
  }

  // 実際の試合の流れの中でも、前衛だった方が後衛より深くまで下がることがない
  {
    const input = { moveX: 0, moveZ: 0, lob: false };
    const g = new R.Game({ input, hooks: noHooks });
    g.start(true);
    let points = 0; let mateTook = 0; let swapped = 0;
    let startFront = null; let swappedThisPoint = false;
    for (let i = 0; i < 60 * 600; i++) {
      input.moveX = Math.sin(i / 37) > 0 ? 1 : -1;
      input.moveZ = Math.sin(i / 53) > 0 ? 1 : -1;
      if (g.phase === 'serve' && g.servingPlayer() === 'you') tap(g);
      if (g.phase === 'rally' && i % 6 === 0) tap(g);
      g.update(1 / 60);
      if (g.phase === 'rally') {
        if (!startFront) {
          // ラリーの開始時点で、ネットに近かった方
          startFront = Math.abs(g.cpu.z) < Math.abs(g.cpuMate.z) ? 'cpu' : 'cpuMate';
          if (startFront === 'cpu') mateTook++;
        }
        const back = startFront === 'cpu' ? 'cpuMate' : 'cpu';
        if (Math.abs(g[startFront].z) > Math.abs(g[back].z) + 2) swappedThisPoint = true;
      } else if (startFront) {
        points++;
        if (swappedThisPoint) swapped++;
        startFront = null;
        swappedThisPoint = false;
      }
    }
    ok(points > 50 && mateTook > 10,
      `precondition: enough points where cpuMate served/received, got ${mateTook}/${points}`);
    ok(swapped === 0, `the CPU pair never swaps front and back mid-point, got ${swapped}/${points} points`);
  }
}

// --- ダブルス雁行陣：CPU の後衛は相手の前衛を避けて打つ ---
// (退行テスト: 以前は常に「相手チームの主力(you)」の逆をつくだけで、相手前衛がどこに
//  立っていようと配球が変わらず、ネット際の前衛へ自分から打ち込んでいた)
{
  const aimSides = (frontX) => {
    let towardFront = 0; let away = 0;
    for (let i = 0; i < 300; i++) {
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.start(true);
      g.phase = 'rally';
      g.serveInFlight = false;
      // you チームは雁行（前衛がネット際・後衛が深く）。cpu の後衛がこれから打つ。
      g.you.x = frontX; g.you.z = R.config.DOUBLES.NET_Z_YOU;
      g.youMate.x = -frontX * 0.5; g.youMate.z = -10.5;
      g.cpu.x = 0; g.cpu.z = 9.5;
      Object.assign(g.ball, {
        x: 0, y: 1.0, z: 9.5, vx: 0, vy: 0, vz: 0, bounces: 1, age: 1.2, live: true, last: 'you',
      });
      g.hit('cpu');
      if (Math.sign(g.ball.vx) === Math.sign(frontX)) towardFront++; else away++;
    }
    return { towardFront, away };
  };
  const right = aimSides(3.0);
  ok(right.away > right.towardFront * 3,
    `the CPU baseliner plays away from the net player: away=${right.away} toward=${right.towardFront}`);
  const left = aimSides(-3.0);
  ok(left.away > left.towardFront * 3,
    `and the same with the net player on the other side: away=${left.away} toward=${left.towardFront}`);
}

// --- ダブルス：フルマッチのシミュレーション（フリーズ・タイマーリークがないか） ---
{
  const events = [];
  // youMate の受け返しが直ったことで cpu チームと you チームの双方が「壁」のように
  // 拾い続けられるようになった。moveX/moveZ が常に0の静止した you だと、双方が
  // 完璧な守備をし続けて点が一切決まらない（60分回しても終わらない）退行があったため、
  // 実際のプレイに近い「動き続ける人間」を模してテストする。
  const input = { moveX: 0, moveZ: 0, lob: false };
  const g = new R.Game({
    input,
    hooks: { ...noHooks, call: (big, sub) => events.push(`${big}|${sub}`) },
  });
  g.start(true);
  for (let i = 0; i < 60 * 600; i++) {
    input.moveX = Math.sin(i / 37) > 0 ? 1 : -1;
    input.moveZ = Math.sin(i / 53) > 0 ? 1 : -1;
    if (g.phase === 'serve' && g.server === 'you') tap(g);
    if (g.phase === 'rally' && i % 6 === 0) tap(g);
    g.update(1 / 60);
  }
  ok(events.length > 20, `doubles: calls fired: ${events.length}`);
  ok(Number.isFinite(g.ball.x) && Number.isFinite(g.ball.y), 'doubles: ball stays finite');
  ok(Number.isFinite(g.youMate.x) && Number.isFinite(g.cpuMate.x), 'doubles: mates stay finite');
  // シングルス版と同じく2本までは正常（以前は1本以下で見ていたため、最後の1フレームが
  // たまたま演出のタイマーと重なる瞬間に当たると、試合の進み方しだいでまれに落ちていた）。
  ok(g.timers.length <= 2, `doubles: timers do not leak: ${g.timers.length}`);
}

// --- CPU/AIの強さプリセット（Easy/Normal/Hard）：スタート画面の難易度選択が実際にCPUの値へ反映される ---
{
  const { CPU_LEVELS, applyCpuLevel } = R.config;
  ok(!!CPU_LEVELS.easy && !!CPU_LEVELS.normal && !!CPU_LEVELS.hard && !!CPU_LEVELS.extreme,
    'four presets exist');

  applyCpuLevel('normal'); // 他のテストの実行順に依存しないよう、まずベースラインへ戻す
  const baseline = { ...R.config.CPU };
  // プリセットが上書きする PLAYER のキーはプリセット定義から導出して全部押さえる。
  // 手で列挙すると、列挙し忘れたキーの復元漏れをこのテスト自身が見逃してしまう。
  const presetPlayerKeys = [...new Set(
    Object.values(CPU_LEVELS).flatMap((preset) => Object.keys(preset.player)),
  )];
  const basePlayerCpu = Object.fromEntries(
    presetPlayerKeys.map((key) => [key, R.config.PLAYER[key]]),
  );
  ok(presetPlayerKeys.includes('CPU_RECOVER_DELAY') && presetPlayerKeys.includes('CPU_REACH'),
    `the derived key list covers the presets' PLAYER overrides, got ${presetPlayerKeys.join(',')}`);

  applyCpuLevel('easy');
  ok(R.config.CPU.OUT_LONG > baseline.OUT_LONG && R.config.CPU.OUT_WIDE > baseline.OUT_WIDE,
    `easy misses more often than normal: OUT_LONG=${R.config.CPU.OUT_LONG} OUT_WIDE=${R.config.CPU.OUT_WIDE}`);
  ok(R.config.CPU.SHOT_T > baseline.SHOT_T, 'easy hits slower/loopier shots than normal');
  ok(R.config.CPU.SERVE_T > baseline.SERVE_T, 'easy serves weaker (slower/loopier) than normal');
  ok(R.config.PLAYER.CPU_REACT > basePlayerCpu.CPU_REACT, 'easy reacts slower than normal');
  ok(R.config.PLAYER.CPU_CHASE < basePlayerCpu.CPU_CHASE, 'easy chases slower than normal');

  applyCpuLevel('hard');
  ok(R.config.CPU.OUT_LONG < baseline.OUT_LONG && R.config.CPU.OUT_WIDE < baseline.OUT_WIDE,
    `hard misses less often than normal: OUT_LONG=${R.config.CPU.OUT_LONG} OUT_WIDE=${R.config.CPU.OUT_WIDE}`);
  ok(R.config.CPU.SHOT_T < baseline.SHOT_T, 'hard hits faster/flatter shots than normal');
  ok(R.config.CPU.SERVE_T < baseline.SERVE_T, 'hard serves stronger (faster/flatter) than normal');
  ok(R.config.PLAYER.CPU_REACT < basePlayerCpu.CPU_REACT, 'hard reacts faster than normal');
  ok(R.config.PLAYER.CPU_CHASE > basePlayerCpu.CPU_CHASE, 'hard chases faster than normal');

  // extreme は hard のさらに1段上（要望「hard よりも強い動きをする相手」）。
  // 比べるのは hard の値そのもので、「hard より強い」が壊れたらここで落ちる。
  {
    applyCpuLevel('hard');
    const hard = { ...R.config.CPU, ...Object.fromEntries(presetPlayerKeys.map((k) => [k, R.config.PLAYER[k]])) };
    applyCpuLevel('extreme');
    const ex = { ...R.config.CPU, ...Object.fromEntries(presetPlayerKeys.map((k) => [k, R.config.PLAYER[k]])) };
    ok(ex.OUT_LONG < hard.OUT_LONG && ex.OUT_WIDE < hard.OUT_WIDE,
      `extreme misses less often than hard: ${ex.OUT_LONG}/${ex.OUT_WIDE} vs ${hard.OUT_LONG}/${hard.OUT_WIDE}`);
    ok(ex.STRETCH_OUT_LONG < hard.STRETCH_OUT_LONG && ex.STRETCH_OUT_WIDE < hard.STRETCH_OUT_WIDE,
      'and barely misses even when it is run off the court');
    ok(ex.SHOT_T < hard.SHOT_T && ex.SERVE_T < hard.SERVE_T,
      `extreme hits and serves faster than hard: ${ex.SHOT_T}/${ex.SERVE_T} vs ${hard.SHOT_T}/${hard.SERVE_T}`);
    ok(ex.SMASH_T < hard.SMASH_T && ex.VOLLEY_ANGLE_T < hard.VOLLEY_ANGLE_T,
      'its put-aways are sharper too');
    ok(ex.CPU_CHASE > hard.CPU_CHASE && ex.CPU_RECOVER > hard.CPU_RECOVER,
      `extreme moves faster than hard: ${ex.CPU_CHASE} vs ${hard.CPU_CHASE}`);
    ok(ex.CPU_REACT < hard.CPU_REACT && ex.CPU_RECOVER_DELAY < hard.CPU_RECOVER_DELAY,
      'reacts and recovers quicker');
    ok(ex.CPU_REACT > 0, 'but still takes a beat to react (a 0 here reads as "sees the future")');
    ok(ex.CPU_REACH > hard.CPU_REACH && ex.CPU_REFLEX_REACH > hard.CPU_REFLEX_REACH,
      'and covers more court');
    ok(ex.CPU_REFLEX_REACH / hard.CPU_REFLEX_REACH <= ex.CPU_REACH / hard.CPU_REACH,
      'with the reflex range raised no faster than the normal one (hard\'s rule: leave net winners possible)');
    ok(ex.SPECIALS === true && ex.SPECIAL_ALL_MOVES === true,
      'extreme turns on the AI specials, all of them');
    ok(ex.SPECIAL_USES > hard.SPECIAL_USES && ex.SPECIAL_CHANCE > hard.SPECIAL_CHANCE,
      `and lets the AI use each one several times a game: ${ex.SPECIAL_USES}x at ${ex.SPECIAL_CHANCE}`);
    ok(hard.SPECIAL_ALL_MOVES === false && hard.SPECIAL_USES === R.config.SPECIAL.USES_PER_GAME,
      'while hard keeps the seven-move, once-per-game budget it always had');
  }

  applyCpuLevel('normal');
  ok(JSON.stringify(R.config.CPU) === JSON.stringify(baseline), 'switching back to normal restores the baseline CPU values');
  // プリセットが上書きしうる PLAYER のキーが1つ残らず normal の値へ戻ること
  // （戻し漏れがあると、一度 easy/hard を選んだ後 normal に戻してもその値だけ効いたままになる）
  for (const [key, value] of Object.entries(basePlayerCpu)) {
    ok(R.config.PLAYER[key] === value,
      `switching back to normal restores PLAYER.${key} (expected ${value}, got ${R.config.PLAYER[key]})`);
  }

  // 段階差の主軸はミス確率。easy > normal > hard の順に単調に下がっていること
  // (退行テスト: hard のミス確率が normal と近すぎて「Hardを選んでも変わらない」状態だった。
  //  実測ではミス確率が強さに最も効き、球速や狙いの深さはほとんど効かない)
  const missRate = (level) => {
    applyCpuLevel(level);
    return {
      base: R.config.CPU.OUT_LONG + R.config.CPU.OUT_WIDE,
      stretch: R.config.CPU.STRETCH_OUT_LONG + R.config.CPU.STRETCH_OUT_WIDE,
    };
  };
  const easyMiss = missRate('easy');
  const normalMiss = missRate('normal');
  const hardMiss = missRate('hard');
  const extremeMiss = missRate('extreme');
  ok(easyMiss.base > normalMiss.base && normalMiss.base > hardMiss.base
    && hardMiss.base > extremeMiss.base,
    `miss rate falls monotonically easy>normal>hard>extreme: ${easyMiss.base} > ${normalMiss.base} > ${hardMiss.base} > ${extremeMiss.base}`);
  ok(easyMiss.stretch > normalMiss.stretch && normalMiss.stretch > hardMiss.stretch
    && hardMiss.stretch > extremeMiss.stretch,
    `stretched-shot miss rate falls monotonically too: ${easyMiss.stretch} > ${normalMiss.stretch} > ${hardMiss.stretch} > ${extremeMiss.stretch}`);
  // 単調なだけでは「Hardを選んでもほとんど変わらない」状態を防げない（変更前もミス率自体は
  // normal より低かった）。ベンチで体感差が出た比率を下限として固定する：
  // hard は normal の 1/3 以下、easy は normal の 2.5 倍以上。
  // （比率は当初 1/5・3/10 だったが、「ノーマルが弱すぎる」という指摘で normal 自体を
  //  旧normalとhardの中点まで引き上げたぶん、両者の差は当然縮まる。それでも hard が
  //  はっきり別物であることを担保できる線まで緩めてある。）
  ok(hardMiss.base <= normalMiss.base * (1 / 3),
    `hard's miss rate is at most a third of normal's: ${hardMiss.base} vs ${normalMiss.base}`);
  ok(hardMiss.stretch <= normalMiss.stretch * 0.5,
    `hard barely misses even on stretched shots: ${hardMiss.stretch} vs ${normalMiss.stretch}`);
  ok(easyMiss.base >= normalMiss.base * 2.5,
    `easy misses at least 2.5x as often as normal: ${easyMiss.base} vs ${normalMiss.base}`);

  applyCpuLevel('normal');
  // COURT/RULES 等のゲームルール寄りの値には触れない
  ok(R.config.COURT.W === 8.23, 'applyCpuLevel does not touch court dimensions');
}

// --- CPU/AIのサーブの威力（CPU.SERVE_T）は難易度に応じて実際に serve() へ反映される ---
// (ユーザー報告「敵のサーブが弱すぎる、難易度で変わらない」を受けた変更。ダブルスの
//  味方(youMate)も cpu と同じコードパスを通るので、そちらも同様に確認する)
{
  const { applyCpuLevel } = R.config;
  const { mpsToKmh } = R.math;
  const cpuServeSpeed = () => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(false);
    // server を明示的に cpu にしてから newPoint() し直す。そうしないと beginServe() が
    // まだ 'you' として置いたボール位置（自陣ベースライン）のまま serve('cpu') を呼ぶことになり、
    // ネットを挟まない・現実にありえない位置からの「サーブ」を測ってしまう。
    g.server = 'cpu';
    g.newPoint();
    g.serve('cpu');
    return mpsToKmh(Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz));
  };
  const mateServeSpeed = () => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(true);
    g.server = 'you';
    g.serverPartner.you = 'youMate';
    g.newPoint();
    g.serve('youMate');
    return mpsToKmh(Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz));
  };

  // コース・深さのランダムなばらつきが威力差より大きく出ないよう固定する
  // （初速km/hのテストと同じ手当て）
  const origRandom = Math.random;
  Math.random = () => 0.5;
  let easyCpu; let normalCpu; let hardCpu; let easyMate; let hardMate;
  try {
    applyCpuLevel('easy');
    easyCpu = cpuServeSpeed();
    easyMate = mateServeSpeed();
    applyCpuLevel('normal');
    normalCpu = cpuServeSpeed();
    applyCpuLevel('hard');
    hardCpu = cpuServeSpeed();
    hardMate = mateServeSpeed();
  } finally {
    Math.random = origRandom;
    applyCpuLevel('normal');
  }
  ok(easyCpu < normalCpu && normalCpu < hardCpu,
    `CPU serve speed rises with difficulty: easy=${easyCpu.toFixed(0)} normal=${normalCpu.toFixed(0)} hard=${hardCpu.toFixed(0)}`);
  ok(easyMate < hardMate,
    `doubles partner (youMate) serve speed also rises with difficulty: easy=${easyMate.toFixed(0)} hard=${hardMate.toFixed(0)}`);
}

// --- CPU/AIの「プレースタイル」：強さ(Easy/Normal/Hard)とは直交する性格を上書きする ---
{
  const { CPU_STYLES, applyCpuLevel, applyCpuStyle } = R.config;
  ok(['none', 'serveAndVolley', 'retriever', 'aggressiveBaseliner'].every((k) => !!CPU_STYLES[k]),
    `all four styles exist, got ${Object.keys(CPU_STYLES).join(',')}`);

  applyCpuLevel('normal'); // 強さの基準を固定してから比べる
  applyCpuStyle('none');
  const baselineCpu = { ...R.config.CPU };
  const baselinePlayer = { ...R.config.PLAYER };

  // スタイル無指定なら現状と完全に一致する
  ok(JSON.stringify(R.config.CPU) === JSON.stringify(baselineCpu), 'style "none" leaves CPU untouched');
  ok(JSON.stringify(R.config.PLAYER) === JSON.stringify(baselinePlayer), 'style "none" leaves PLAYER untouched');

  // サーブ&ボレーヤー：APPROACH_NET_AFTER_SERVE が立ち、サーブ後にネットへ詰める
  // （実際の移動は game.js#moveSinglesCpu() が見る。ここでは homePosition() の切り替えだけ検証）
  applyCpuLevel('normal');
  applyCpuStyle('serveAndVolley');
  ok(R.config.CPU.APPROACH_NET_AFTER_SERVE === true, 'serveAndVolley sets APPROACH_NET_AFTER_SERVE');
  {
    const { homePosition } = R.ai;
    const normalHome = homePosition(false);
    const netHome = homePosition(true);
    ok(netHome.z < normalHome.z && netHome.z === R.config.CPU.NET_APPROACH_Z,
      `approaching the net targets a shallower z than the normal home position, got net=${netHome.z} normal=${normalHome.z}`);
  }
  {
    // serve() を実際に呼ぶと cpuNetRush が立つ（そのポイントの間ネットへ詰め続けるフラグ）。
    // 退行テスト: 以前は serveInFlight（サーブがまだ返っていない、コンマ数秒しかない間）で
    // 見ていたため、人間が返球した瞬間に接近そのものをやめてしまい、実際にはベースライン
    // 付近からほとんど動けていなかった（ユーザー報告「サービス＆ボレーでもあまり前に
    // 出てこない」）。cpuNetRush はサーブを打った後、返球されても立ったままであること、
    // かつ CPU_RECOVER（定位置へ戻るだけの遅い速度）ではなく CPU_CHASE（球を追う速い速度）
    // で詰めることを検証する。
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.server = 'cpu';
    g.newPoint();
    g.serve('cpu');
    ok(g.cpuNetRush === true, 'serve() flags cpuNetRush for a serve-and-volley cpu serve');

    // 人間が打ち返した想定（serveInFlight は解除されるが、cpuNetRush は解除されない）
    g.serveInFlight = false;
    g.ball.last = 'you';
    ok(g.cpuNetRush === true, 'cpuNetRush survives past the return, unlike the old serveInFlight-based check');

    // 待機中（自分の番ではない）に戻し、実際に1秒ぶん歩かせて速度と到達距離を確認する
    g.ball.last = 'cpu';
    g.cpu.x = 0; g.cpu.z = R.config.CPU.HOME_Z;
    for (let i = 0; i < 60; i++) g.movePlayers(1 / 60);
    const covered = R.config.CPU.HOME_Z - g.cpu.z;
    ok(g.cpu.z < R.config.CPU.HOME_Z - 1,
      `serve-and-volley CPU keeps walking toward the net after the return, got z=${g.cpu.z} (started at ${R.config.CPU.HOME_Z})`);
    ok(covered >= PLAYER.CPU_CHASE * 0.9,
      `advances at CPU_CHASE speed rather than the slower CPU_RECOVER, covered ${covered.toFixed(2)}m/s vs CPU_CHASE=${PLAYER.CPU_CHASE}`);
  }

  // リトリーバー：ミスしにくく、ロブを多用する
  applyCpuLevel('normal');
  applyCpuStyle('retriever');
  ok(R.config.CPU.OUT_LONG < baselineCpu.OUT_LONG && R.config.CPU.OUT_WIDE < baselineCpu.OUT_WIDE,
    `retriever misses less often than no style, got LONG=${R.config.CPU.OUT_LONG} WIDE=${R.config.CPU.OUT_WIDE}`);
  ok(R.config.PLAYER.CPU_CHASE > baselinePlayer.CPU_CHASE, 'retriever chases faster than no style');
  {
    const { cpuShot } = R.ai;
    let lobs = 0;
    const N = 300;
    // ベースライン同士のラリー（NET_Zの外）でロブ率を比べる
    for (let i = 0; i < N; i++) if (cpuShot({ x: 0, z: -R.config.HALF_L + 1 }, -1, 0).lob) lobs++;
    const retrieverLobRate = lobs / N;
    applyCpuLevel('normal'); // 必ず applyCpuLevel() の後で style を適用する（config.js のコメント参照）
    applyCpuStyle('none');
    lobs = 0;
    for (let i = 0; i < N; i++) if (cpuShot({ x: 0, z: -R.config.HALF_L + 1 }, -1, 0).lob) lobs++;
    const noneLobRate = lobs / N;
    ok(retrieverLobRate > noneLobRate * 1.5,
      `retriever lobs a lot more often in a baseline rally, got retriever=${retrieverLobRate} none=${noneLobRate}`);
  }

  // アグレッシブベースライナー：コースが広く、速く、その分ミスも増える
  applyCpuLevel('normal');
  applyCpuStyle('aggressiveBaseliner');
  ok(R.config.CPU.AIM_X_MAX > baselineCpu.AIM_X_MAX, 'aggressive baseliner aims wider than no style');
  ok(R.config.CPU.SHOT_T < baselineCpu.SHOT_T, 'aggressive baseliner hits flatter/faster shots than no style');
  ok(R.config.CPU.OUT_LONG > baselineCpu.OUT_LONG && R.config.CPU.OUT_WIDE > baselineCpu.OUT_WIDE,
    `aggressive baseliner takes more risk (misses more) than no style, got LONG=${R.config.CPU.OUT_LONG} WIDE=${R.config.CPU.OUT_WIDE}`);

  // 後続のテストに影響しないよう、必ず基準状態へ戻す
  applyCpuLevel('normal');
  applyCpuStyle('none');
}

// --- スピン：実効重力（フラットは従来のGRAVITYと完全一致、トップスピンはより強く、スライスはより弱く） ---
{
  const { spinGravity } = R.physics;
  const { PHYSICS: PHYS } = R.config;
  ok(spinGravity('flat') === PHYS.GRAVITY, `flat spin is exactly the base gravity, got ${spinGravity('flat')}`);
  ok(spinGravity(undefined) === PHYS.GRAVITY, 'no spin (e.g. during the toss) also falls back to the base gravity');
  ok(spinGravity('top') < PHYS.GRAVITY, `topspin's effective gravity is stronger (more negative), got ${spinGravity('top')}`);
  ok(spinGravity('slice') > PHYS.GRAVITY, `slice's effective gravity is weaker, got ${spinGravity('slice')}`);
}

// --- スピン：同じ発射点・同じ着地目標・同じ飛翔時間でも、トップスピンは山なりに高く上がり
//     （実効重力が強い分、同じ時間で降りてくるにはより高く上げる必要がある）、
//     スライスは低く滑るように飛ぶ（着地点そのものは spin によらず一致する）。
{
  const { solveShot, integrate } = R.physics;
  function peakAndLanding(spin) {
    const from = { x: 0, y: 1, z: -6 };
    const target = { x: 1.5, y: 0.11, z: 8 };
    const v = solveShot(from, target, 0.9, 0.30, spin);
    const b = { x: from.x, y: from.y, z: from.z, vx: v.vx, vy: v.vy, vz: v.vz, spin };
    let peak = b.y;
    for (let i = 0; i < 400 && b.y >= 0.11; i++) {
      integrate(b, 1 / 240);
      if (b.y > peak) peak = b.y;
    }
    return { peak, x: b.x, z: b.z };
  }

  const flat = peakAndLanding('flat');
  const top = peakAndLanding('top');
  const slice = peakAndLanding('slice');

  ok(top.peak > flat.peak, `topspin arcs higher than flat for the same target/time: top=${top.peak.toFixed(2)} flat=${flat.peak.toFixed(2)}`);
  ok(flat.peak > slice.peak, `flat arcs higher than slice for the same target/time: flat=${flat.peak.toFixed(2)} slice=${slice.peak.toFixed(2)}`);
  ok(Math.abs(top.x - flat.x) < 0.05 && Math.abs(slice.x - flat.x) < 0.05,
    `landing x is unaffected by spin (same aim regardless of spin): flat=${flat.x.toFixed(3)} top=${top.x.toFixed(3)} slice=${slice.x.toFixed(3)}`);
  ok(Math.abs(top.z - flat.z) < 0.05 && Math.abs(slice.z - flat.z) < 0.05,
    `landing z is unaffected by spin (same depth regardless of spin): flat=${flat.z.toFixed(3)} top=${top.z.toFixed(3)} slice=${slice.z.toFixed(3)}`);
}

// --- スピン：バウンドの弾み方（トップスピンは高く弾む、スライスは低く滑って伸びる） ---
{
  const { SPIN } = R.config;
  function bounced(spin) {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.ball.spin = spin;
    g.ball.y = 0.2; g.ball.vy = -6; g.ball.vx = 3; g.ball.vz = 4;
    g.bounce();
    return { vy: g.ball.vy, vx: g.ball.vx, vz: g.ball.vz };
  }
  const flat = bounced('flat');
  const top = bounced('top');
  const slice = bounced('slice');

  ok(flat.vy === 6 * R.config.PHYSICS.RESTITUTION, `flat bounce uses the plain restitution, got ${flat.vy}`);
  ok(top.vy > flat.vy, `topspin bounces higher than flat: top=${top.vy.toFixed(2)} flat=${flat.vy.toFixed(2)}`);
  ok(slice.vy < flat.vy, `slice bounces lower than flat: slice=${slice.vy.toFixed(2)} flat=${flat.vy.toFixed(2)}`);
  ok(Math.abs(slice.vx) > Math.abs(flat.vx) && Math.abs(slice.vz) > Math.abs(flat.vz),
    `slice retains more horizontal pace after the bounce (skids) than flat: slice.vx=${slice.vx.toFixed(2)} flat.vx=${flat.vx.toFixed(2)}`);
  ok(SPIN.BOUNCE_RESTITUTION_MULT.flat === 1 && SPIN.BOUNCE_FRICTION_MULT.flat === 1,
    'the flat preset is multiplier 1 in both dimensions, matching the pre-spin behaviour exactly');
}

// --- スピン選択：B=フラット／V=トップスピン／C=スライス、それぞれ独立した溜め・スイングキー ---
// chargeStart(spin) の引数（押されたキーに対応するスピン）をその瞬間に固定する。当たる瞬間
// まで押し続ける必要はない（chargeStroke（フォア/バック）と同じ方式）。
{
  // 通常のグラウンドストローク：chargeStart() に渡したスピンを反映する
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.phase = 'rally';
  g.you.z = -HALF_L - 0.6; // ベースライン付近＝ボレー圏外にしておく
  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;

  g.chargeStart(); // B（引数省略）＝フラット
  g.chargeRelease();
  g.hit('you');
  ok(g.ball.spin === 'flat', `B (no spin arg) -> flat, got ${g.ball.spin}`);

  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.chargeStart('top'); // V
  g.chargeRelease();
  g.hit('you');
  ok(g.ball.spin === 'top', `V (topspin) at chargeStart() is applied to a groundstroke, got ${g.ball.spin}`);

  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.chargeStart('slice'); // C
  g.chargeRelease();
  // 溜めずに離したスライスはドロップショット（別の球種）になるので、ここでは
  // しっかり溜めた「通常のスライス」として検証する
  g.you.swingCharge = R.config.DROP.MAX_CHARGE + 0.1;
  g.hit('you');
  ok(g.ball.spin === 'slice', `C (slice) at chargeStart() is applied to a groundstroke, got ${g.ball.spin}`);

  // スマッシュ：スピン選択の対象外（フラット固定）
  g.you.chargeStroke = null;
  g.you.chargeSpin = 'flat';
  g.you.swingCharge = PLAYER.SMASH_MIN_CHARGE;
  g.ball.x = 0; g.ball.y = PLAYER.SMASH_MIN_Y + 0.1; g.ball.z = -HALF_L - 0.6; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.chargeStart('top'); // V を押していてもスマッシュには反映されない
  g.chargeRelease();
  g.you.swingCharge = PLAYER.SMASH_MIN_CHARGE; // chargeRelease() が溜め時間から上書きするので、テスト用に固定し直す
  g.hit('you');
  ok(g.you.stroke === 'smash', 'precondition: this hit is classified as a smash');
  ok(g.ball.spin === 'flat', `smash ignores spin input and stays flat, got ${g.ball.spin}`);

  // ボレー：スピン選択の対象外（フラット固定）
  g.you.swingCharge = 0;
  g.you.x = 0; g.you.z = -1; // サービスラインより前＝ボレー圏内
  g.ball.x = 0.5; g.ball.y = 1; g.ball.z = -1.5; g.ball.bounces = 0; g.ball.vx = 0; g.ball.vz = 0;
  g.chargeStart('slice'); // C を押していてもボレーには反映されない
  g.chargeRelease();
  g.hit('you');
  ok(g.you.stroke.startsWith('volley-'), 'precondition: this hit is classified as a volley');
  ok(g.ball.spin === 'flat', `volley ignores spin input and stays flat, got ${g.ball.spin}`);

  // CPU/AIの返球：aiSpin() が一定確率でトップスピン／スライスを混ぜる（以前は常にフラット
  // 固定だった）。1回だけだと運で 'flat' を引く可能性があるので、多数回サンプルして
  // 「毎回フラットではない」こと・「常に有効なスピンの範囲に収まる」ことの両方を確認する。
  {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      g.cpu.x = 0; g.cpu.z = HALF_L + 0.5;
      g.ball.x = 0; g.ball.y = 1; g.ball.z = 2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
      g.hit('cpu');
      seen.add(g.ball.spin);
    }
    ok([...seen].every((s) => ['flat', 'top', 'slice'].includes(s)),
      `CPU/AI returns only ever use flat/top/slice, got ${[...seen]}`);
    ok(seen.size > 1, `CPU/AI returns are no longer always flat (200 samples), got only ${[...seen]}`);
  }

  // サーブ：トスを上げた瞬間（chargeStart()）に固定したスピンでスライスサーブ・スピンサーブが打てる
  const gs = new R.Game({ input: fakeInput, hooks: noHooks });
  gs.start();
  tossAndHit(gs, 0, 'slice'); // C を押しっぱなしにしてサーブ
  ok(gs.ball.spin === 'slice', `holding C (slice) through the toss produces a slice serve, got ${gs.ball.spin}`);

  // CPU/AI のサーブも同じ aiSpin() を使う（以前は常にフラット固定だった）。返球と同様、
  // 多数回サンプルして確認する。
  {
    const seenServe = new Set();
    for (let i = 0; i < 200; i++) {
      const gs3 = new R.Game({ input: fakeInput, hooks: noHooks });
      gs3.start();
      gs3.serve('cpu');
      seenServe.add(gs3.ball.spin);
    }
    ok([...seenServe].every((s) => ['flat', 'top', 'slice'].includes(s)),
      `CPU/AI serves only ever use flat/top/slice, got ${[...seenServe]}`);
    ok(seenServe.size > 1, `CPU/AI serves are no longer always flat (200 samples), got only ${[...seenServe]}`);
  }
}

// --- newPoint() は前のポイントのスピンを持ち越さない ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.ball.spin = 'top';
  g.newPoint();
  ok(g.ball.spin === 'flat', `newPoint() resets spin to flat, got ${g.ball.spin}`);
}

// --- 風：integrate() は b.wind が未設定/0 なら従来の物理と完全に一致する（後方互換） ---
{
  const { integrate } = R.physics;
  const withoutWind = { x: 0, y: 1, z: 0, vx: 2, vy: 0, vz: 5 };
  const explicitZero = { x: 0, y: 1, z: 0, vx: 2, vy: 0, vz: 5, wind: 0 };
  for (let i = 0; i < 60; i++) {
    integrate(withoutWind, 1 / 60);
    integrate(explicitZero, 1 / 60);
  }
  ok(withoutWind.vx === 2 && withoutWind.x === explicitZero.x,
    `no wind field leaves vx untouched (backward compatible), vx=${withoutWind.vx}`);
  ok(withoutWind.x === explicitZero.x && withoutWind.vx === explicitZero.vx,
    'wind:undefined and wind:0 behave identically');
}

// --- 風：integrate() で vx に継続的に加算される（横方向に流される） ---
{
  const { integrate } = R.physics;
  const blown = { x: 0, y: 1, z: 0, vx: 2, vy: 0, vz: 5, wind: 0.6 };
  const calm = { x: 0, y: 1, z: 0, vx: 2, vy: 0, vz: 5, wind: 0 };
  for (let i = 0; i < 60; i++) {
    integrate(blown, 1 / 60);
    integrate(calm, 1 / 60);
  }
  ok(blown.vx > calm.vx, `a positive wind accelerates vx over time: blown=${blown.vx.toFixed(3)} calm=${calm.vx.toFixed(3)}`);
  ok(blown.x > calm.x, `a positive wind drifts the ball further in +x: blown=${blown.x.toFixed(3)} calm=${calm.x.toFixed(3)}`);
}

// --- 風：predictLanding() も b.wind を織り込む（CPUの追跡・着地マーカーが実際の着地点とずれない） ---
{
  const { predictLanding } = R.physics;
  const from = {
    x: 0, y: 1, z: -6, vx: 1, vy: 3, vz: 6, wind: 0.6,
  };
  const noWind = { ...from, wind: 0 };
  const landed = predictLanding(from);
  const landedCalm = predictLanding(noWind);
  ok(!landed.net && !landedCalm.net, 'precondition: both trajectories clear the net');
  ok(Math.abs(landed.x - landedCalm.x) > 0.02,
    `predicted landing x differs when wind is present: wind=${landed.x.toFixed(3)} calm=${landedCalm.x.toFixed(3)}`);
}

// --- 風：ポイントごとに Game#wind が WIND.MAX_ACCEL の範囲内で決まり、hooks.wind に通知される ---
{
  const { WIND } = R.config;
  let notified;
  const hooksWithWind = { ...noHooks, wind: (x, z) => { notified = { x, z }; } };
  for (let i = 0; i < 20; i++) {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithWind });
    g.start();
    ok(Math.hypot(g.wind, g.windZ) <= WIND.MAX_ACCEL + 1e-9,
      `the wind is never stronger than WIND.MAX_ACCEL, got ${g.wind}, ${g.windZ}`);
    ok(notified.x === g.wind && notified.z === g.windZ,
      `hooks.wind() is called with both components of Game#wind, got ${JSON.stringify(notified)} vs ${g.wind}, ${g.windZ}`);
  }
}

// --- 風：無関係な値へ飛ばず、前のポイントから強さ・向きとも少しだけ変わる（ドリフト）。
//     試合を通して卓越風（windBase）の向きから ANGLE_SPREAD 以上は振れない ---
{
  const { WIND } = R.config;
  for (let m = 0; m < 10; m++) {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    ok(g.windBase.strength >= WIND.BASE_MIN && g.windBase.strength <= WIND.BASE_MAX,
      `each match draws its prevailing wind within BASE_MIN..BASE_MAX, got ${g.windBase.strength}`);
    g.start();
    const baseDir = { x: Math.sin(g.windBase.angle), z: Math.cos(g.windBase.angle) };
    for (let i = 0; i < 100; i++) {
      const before = { strength: g.windStrength, off: g.windAngleOff };
      g.newPoint();
      ok(Math.abs(g.windStrength - before.strength) <= WIND.DRIFT_ACCEL + 1e-9,
        `the strength changes by at most WIND.DRIFT_ACCEL per point, got ${before.strength} -> ${g.windStrength}`);
      ok(Math.abs(g.windAngleOff - before.off) <= WIND.ANGLE_DRIFT + 1e-9,
        `the direction changes by at most WIND.ANGLE_DRIFT per point, got ${before.off} -> ${g.windAngleOff}`);
      ok(Math.abs(g.windStrength - g.windBase.strength) <= WIND.GUST_RANGE + 1e-9 && g.windStrength >= 0,
        `the strength stays within GUST_RANGE of the prevailing wind, got ${g.windStrength} vs ${g.windBase.strength}`);
      const strength = Math.hypot(g.wind, g.windZ);
      ok(strength <= WIND.MAX_ACCEL + 1e-9 && Math.abs(strength - g.windStrength) < 1e-9,
        `the wind vector has the drifted strength, got ${strength} vs ${g.windStrength}`);
      if (strength > 1e-6) {
        const cos = (g.wind * baseDir.x + g.windZ * baseDir.z) / strength;
        ok(cos >= Math.cos(WIND.ANGLE_SPREAD) - 1e-9,
          `the wind keeps blowing from the prevailing direction all match, got cos=${cos.toFixed(3)}`);
      }
    }
  }
}

// --- 風：integrate() は b.windZ（前後の風）を vz に継続的に加算する。未設定なら従来どおり ---
{
  const { integrate } = R.physics;
  const tail = { x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 5, windZ: 0.6 };
  const head = { x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 5, windZ: -0.6 };
  const calm = { x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 5 };
  for (let i = 0; i < 60; i++) {
    integrate(tail, 1 / 60);
    integrate(head, 1 / 60);
    integrate(calm, 1 / 60);
  }
  ok(calm.vz === 5, `no windZ field leaves vz untouched (backward compatible), vz=${calm.vz}`);
  ok(tail.z > calm.z && head.z < calm.z,
    `a tailwind carries the ball further and a headwind holds it back: tail=${tail.z.toFixed(3)} calm=${calm.z.toFixed(3)} head=${head.z.toFixed(3)}`);
}

// --- 風：predictLanding() も b.windZ を織り込む。追い風のロブは向かい風より1m以上深く落ちる ---
{
  const { predictLanding, solveShot } = R.physics;
  const from = { x: 0, y: 1, z: -10 };
  // 相手のベースライン手前 1.5m を狙った高いロブ（無風で解いた初速のまま、風だけ変える）
  const lob = { ...from, ...solveShot(from, { x: 0, y: R.config.PHYSICS.BALL_R, z: HALF_L - 1.5 }, 2.2, 3), spin: 'flat' };
  const calm = predictLanding({ ...lob, windZ: 0 });
  const tail = predictLanding({ ...lob, windZ: 0.5 });
  const head = predictLanding({ ...lob, windZ: -0.5 });
  ok(Math.abs(calm.z - (HALF_L - 1.5)) < 0.15, `precondition: the calm lob lands on target, got ${calm.z.toFixed(2)}`);
  ok(tail.z - head.z > 1.0,
    `with the wind behind it the lob lands much deeper: tail=${tail.z.toFixed(2)} head=${head.z.toFixed(2)}`);
  ok(tail.z > HALF_L - 0.6, `so a lob aimed 1.5m inside can sail long-ish downwind, got ${tail.z.toFixed(2)}`);
}

// --- 風：サーブの飛翔（トス〜1本目の着地）は常に無風。返球された瞬間から this.wind が乗る ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.wind = 0.6; // 強制的に非0の風にしておく
  g.windZ = -0.4;
  tossAndHit(g); // フォールトなく1本目のサーブを打つ
  ok(g.ball.wind === 0 && g.ball.windZ === 0,
    `the serve itself flies with zero wind regardless of Game#wind, got ${g.ball.wind}, ${g.ball.windZ}`);

  // レシーバーが返球すると、以降 ball.wind は Game#wind に切り替わる
  g.you.z = -HALF_L - 0.6;
  g.ball.x = 0; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('you');
  ok(g.ball.wind === g.wind && g.ball.windZ === g.windZ,
    `after the return, the ball carries the point's wind, got ${g.ball.wind}, ${g.ball.windZ} vs ${g.wind}, ${g.windZ}`);
}

// --- 風：ラリー中の通常の打球にも Game#wind がそのまま乗る ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.wind = -0.4;
  g.windZ = 0.3;
  g.you.z = -HALF_L - 0.6;
  g.ball.x = 0; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('you');
  ok(g.ball.wind === -0.4 && g.ball.windZ === 0.3,
    `a groundstroke picks up the current point wind, got ${g.ball.wind}, ${g.ball.windZ}`);
}

// --- 予測の着地点が、実際に弾む座標とぴったり一致する ---
// game.js の bounce() は reflectBounce() 経由で「本当の接地点」（groundCrossing で
// 補間した座標）を使う。予測側がこれとずれると、CPU の追跡目標も縮地の「間に合うか」の
// 判定も実際の打点から外れる。ずれの原因は2つあって向きが逆なので、片方だけ直すと
// 打ち消しが消えてかえって悪化する（詳しくは physics.js の landedAt() のコメント）：
//   ・コマ送り後の座標をそのまま返す（＝進行方向へ行き過ぎる）
//   ・予測の刻みが実際の物理より粗い（＝準陰的オイラーの誤差 g·dt·t/2 で手前に落ちる）
{
  const { predictLanding, integrate, reflectBounce, hitsNet } = R.physics;
  const { PHYSICS } = R.config;
  const BALL_R = PHYSICS.BALL_R;
  // 乱数を使わず、決まった弾道を並べて回す（毎回同じ結果になるように）
  const realBounce = (b) => {
    const s = { ...b };
    for (let t = 0; t < 5; t += PHYSICS.STEP) {
      integrate(s, PHYSICS.STEP);
      if (hitsNet(s)) return null;
      if (s.y <= BALL_R && s.vy < 0) { reflectBounce(s); return { x: s.x, z: s.z }; }
    }
    return null;
  };
  let worst = 0;
  let checked = 0;
  for (const speed of [18, 28, 38, 48, 58]) {
    for (const ang of [-0.04, 0.05, 0.14, 0.25, 0.4]) {
      for (const spin of ['flat', 'top', 'slice']) {
        const b = {
          x: 1.2, y: 1.4, z: -10.5, px: 1.2, py: 1.4, pz: -10.5,
          vx: 2.1, vy: speed * Math.sin(ang), vz: speed * Math.cos(ang),
          spin, wind: 0.3, curve: 0, bounces: 0,
        };
        const real = realBounce({ ...b });
        const predicted = predictLanding({ ...b });
        if (!real || predicted.net) continue;
        checked++;
        worst = Math.max(worst, Math.hypot(predicted.x - real.x, predicted.z - real.z));
      }
    }
  }
  ok(checked > 50, `precondition: enough trajectories land in bounds, got ${checked}`);
  ok(worst < 0.005,
    `predictLanding() lands where the ball really bounces, worst gap ${(worst * 1000).toFixed(1)}mm`);
  ok(R.config.PHYSICS.STEP === 1 / 240,
    'and the predictions are stepped at the same rate as the real physics');
}

// --- 軌跡：誰か（you）が打つと Game#trail がその打点1点から描き直される ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.you.z = -HALF_L - 0.6;
  g.ball.x = 0.3; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0; g.ball.live = true;
  g.hit('you');
  ok(g.trail.length === 1, `hit('you') resets the trail to a single point, got length ${g.trail.length}`);
  ok(g.trail[0].x === 0.3 && g.trail[0].z === -2, `the reset point is the contact point, got ${JSON.stringify(g.trail[0])}`);
}

// --- 軌跡：直近の打球が飛んでいる間、update() のたびに Game#trail が伸びる ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.you.z = -HALF_L - 0.6;
  g.ball.x = 0; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0; g.ball.live = true;
  g.hit('you');
  const lenAfterHit = g.trail.length;
  for (let i = 0; i < 10; i++) g.update(1 / 60);
  ok(g.trail.length > lenAfterHit, `the trail keeps growing while the hit ball is live, got length ${g.trail.length}`);
}

// --- 軌跡：相手（cpu）に打ち返されると、軌跡は凍結せず相手の打点から描き直される ---
// （常に「今まさに飛んでいる最新の1打」を表す。誰が打ったかは問わない）
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.you.z = -HALF_L - 0.6;
  g.ball.x = 0; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0; g.ball.live = true;
  g.hit('you');
  for (let i = 0; i < 5; i++) g.update(1 / 60);
  ok(g.trail.length > 1, 'precondition: the you-hit trail grew past its single reset point');

  g.cpu.x = 1.2; g.cpu.z = 3.4; g.cpu.speed = 0;
  g.ball.x = 1.2; g.ball.y = 1; g.ball.z = 3.4; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('cpu'); // 相手が打ち返した＝以降は cpu の直近の1打を表す
  ok(g.trail.length === 1 && g.trail[0].x === 1.2 && g.trail[0].z === 3.4,
    `the opponent's hit redraws the trail from their own contact point, got ${JSON.stringify(g.trail)}`);
  const lenAfterCpuHit = g.trail.length;
  for (let i = 0; i < 10; i++) g.update(1 / 60);
  ok(g.trail.length > lenAfterCpuHit, `the trail keeps growing for the cpu's shot too, got ${g.trail.length}`);
}

// --- 軌跡：you が次に打つと、前のポイントの軌跡は消えて新しい1本に描き直される ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.you.z = -HALF_L - 0.6;
  g.ball.x = 0; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0; g.ball.live = true;
  g.hit('you');
  for (let i = 0; i < 5; i++) g.update(1 / 60);
  ok(g.trail.length > 1, 'precondition: the first trail grew past its single reset point');

  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -3; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('you');
  ok(g.trail.length === 1 && g.trail[0].x === 1.5,
    `a new you-hit redraws the trail from scratch, got ${JSON.stringify(g.trail)}`);
}

// --- 軌跡：ダブルスで youMate が打っても、その打点からきちんと描き直される ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(true);
  g.you.z = -HALF_L - 0.6;
  g.ball.x = 0; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0; g.ball.live = true;
  g.hit('you');
  for (let i = 0; i < 5; i++) g.update(1 / 60);
  ok(g.trail.length > 1, 'precondition: the trail grew after the you hit');

  g.youMate.x = 3; g.youMate.z = 5;
  g.ball.x = 3.2; g.ball.y = 1; g.ball.z = 5; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('youMate');
  ok(g.ball.last === 'you', "precondition: ball.last stays the team value 'you' even when youMate hits");
  ok(g.trail.length === 1 && g.trail[0].x === 3.2 && g.trail[0].z === 5,
    `youMate's hit redraws the trail from youMate's own contact point, got ${JSON.stringify(g.trail)}`);
}

// --- 軌跡：バウンド（IN/OUT判定に使う座標）の瞬間を必ず1点記録する ---
// (退行テスト: update() は1フレームに1点しか記録しないため、速い球ではその間に何cmも
//  進んでしまい、直線で結んだ軌跡の「着地したように見える位置」と、実際に判定に使う
//  bounce() 時点の座標がずれることがあった＝軌跡ではINに見えるのに実際はOUT)
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  const from = { x: 0, y: 1, z: -2 };
  const target = { x: HALF_W - 0.05, y: R.config.PHYSICS.BALL_R, z: 8 }; // サイドライン際
  const v = R.physics.solveShot(from, target, 0.35, 0.3, 'flat'); // 短い飛翔時間＝速い球
  Object.assign(g.ball, {
    x: from.x, y: from.y, z: from.z, vx: v.vx, vy: v.vy, vz: v.vz, bounces: 0, last: 'you', live: true, spin: 'flat',
  });
  g.resetTrail();
  // わざと粗いフレームレート（1/20秒）でシミュレートし、着地の瞬間を挟む2点の間隔を広げる
  for (let i = 0; i < 60 && g.ball.bounces < 1; i++) g.update(1 / 20);
  ok(g.ball.bounces >= 1, 'precondition: the ball landed within the simulated frames');
  // bounce() が明示的に追加した点は y===BALL_R ちょうどになる（フレームサンプルの点は
  // 空中の途中の高さなので一致しない）。この点があること自体が、通常のフレームサンプル
  // 頼みではなく着地の瞬間を確実に記録していることの証拠になる。
  const bouncePoint = g.trail.find((p) => p.y === R.config.PHYSICS.BALL_R);
  ok(!!bouncePoint, `the trail includes an explicit bounce-height point (y===BALL_R), got ${JSON.stringify(g.trail)}`);
  // solveShot() は解析解だが実際の飛翔は 1/240 のオイラー積分なので、速い球ほど数cm手前で
  // 接地する。ずれは必ず「狙いより手前」側（＝コートの内側）に出るので、その向きも確かめる。
  const CONTACT_SLACK = 0.08;
  ok(bouncePoint && Math.abs(bouncePoint.x - target.x) < CONTACT_SLACK
    && Math.abs(bouncePoint.z - target.z) < CONTACT_SLACK,
  `the recorded bounce point matches the intended landing target (within integration slack), got ${JSON.stringify(bouncePoint)}`);
  ok(bouncePoint && bouncePoint.z <= target.z && bouncePoint.x <= target.x,
    `the touchdown never overshoots the aim point (the old bug pushed it outward), got ${JSON.stringify(bouncePoint)}`);
}

// --- バウンドの接地点は、ステップ後の座標ではなく本当に地面を横切った座標を使う ---
// (退行テスト: reflectBounce() が「1ステップ進んだ後の座標」をそのまま接地点にしていたため、
//  速い球ほど進行方向へ数cm〜十数cm行き過ぎた点で IN/OUT を判定していた。ずれは必ず
//  コートの外向きに出るので、ライン際の球が「入って見えるのにアウト」になっていた)
{
  const { integrate, reflectBounce } = R.physics;
  const BALL_R = R.config.PHYSICS.BALL_R;
  // 地面すれすれを高速で進む球。1ステップで z 方向に大きく進む状況を作る
  const b = { x: 0, y: BALL_R + 0.01, z: 0, vx: 0, vy: -6, vz: 30, spin: 'flat' };
  integrate(b, 1 / 240);
  ok(b.y < BALL_R, `precondition: this step crosses the ground (y=${b.y.toFixed(4)})`);
  // 補正しなければ、このステップ後の座標がそのまま接地点として使われていた
  const stepped = { y: b.y, z: b.z, py: b.py, pz: b.pz };
  reflectBounce(b);
  ok(b.y === BALL_R, 'the bounce leaves the ball exactly at ground height');
  ok(b.z < stepped.z,
    `the contact point is pulled back from the stepped-past position (${b.z.toFixed(4)} < ${stepped.z.toFixed(4)})`);
  // 真の接地点：y が BALL_R を横切る瞬間を線形補間で求めたもの
  const t = (BALL_R - stepped.py) / (stepped.y - stepped.py);
  ok(Math.abs(b.z - (stepped.pz + (stepped.z - stepped.pz) * t)) < 1e-9,
    `the contact point is the interpolated ground crossing, got ${b.z}`);

  // 直前位置が用意されていない（テレポートさせた）球では補間せず、今の座標をそのまま使う
  const teleported = { x: 2, y: 0, z: 5, vx: 0, vy: -1, vz: 0, spin: 'flat' };
  reflectBounce(teleported);
  ok(teleported.x === 2 && teleported.z === 5,
    `without a previous position the bounce keeps the current coords, got (${teleported.x}, ${teleported.z})`);
}

// --- コートサーフェス（ハード／クレー／芝）でバウンドの質が変わる ---
{
  const { reflectBounce } = R.physics;
  const { applySurface, SURFACE, PHYSICS: PHYS } = R.config;
  const savedSurface = { ...SURFACE };

  const bounceOf = (surfaceName) => {
    applySurface(surfaceName);
    const b = {
      x: 0, y: PHYS.BALL_R, z: 0, px: 0, py: 0.5, pz: -0.5, vx: 5, vy: -6, vz: 8, spin: 'flat',
    };
    reflectBounce(b);
    return b;
  };

  try {
    const hard = bounceOf('hard');
    const clay = bounceOf('clay');
    const grass = bounceOf('grass');

    // クレー＝高く弾んで減速：ハードより上向きの初速(vy)が大きく、水平速度は遅い
    ok(clay.vy > hard.vy, `clay bounces higher than hard, got clay.vy=${clay.vy} hard.vy=${hard.vy}`);
    ok(Math.hypot(clay.vx, clay.vz) < Math.hypot(hard.vx, hard.vz),
      `clay slows the ball down more than hard, got clay=${Math.hypot(clay.vx, clay.vz)} hard=${Math.hypot(hard.vx, hard.vz)}`);

    // 芝＝低く滑って伸びる：ハードより上向きの初速(vy)が小さく、水平速度は保たれる
    ok(grass.vy < hard.vy, `grass bounces lower than hard, got grass.vy=${grass.vy} hard.vy=${hard.vy}`);
    ok(Math.hypot(grass.vx, grass.vz) > Math.hypot(hard.vx, hard.vz),
      `grass keeps more pace than hard, got grass=${Math.hypot(grass.vx, grass.vz)} hard=${Math.hypot(hard.vx, hard.vz)}`);

    // ハードを選んだときは、サーフェスの仕組みを足す前の物理と完全に一致する（既存のバランスを崩さない）
    const restMult = R.config.SPIN.BOUNCE_RESTITUTION_MULT.flat || 1;
    const friMult = R.config.SPIN.BOUNCE_FRICTION_MULT.flat || 1;
    const expectedVy = -(-6) * PHYS.RESTITUTION * restMult;
    const expectedVx = 5 * PHYS.FRICTION * friMult;
    const expectedVz = 8 * PHYS.FRICTION * friMult;
    ok(Math.abs(hard.vy - expectedVy) < 1e-9 && Math.abs(hard.vx - expectedVx) < 1e-9 && Math.abs(hard.vz - expectedVz) < 1e-9,
      `hard surface matches the physics with no surface multiplier applied, got vy=${hard.vy} vx=${hard.vx} vz=${hard.vz}`);
  } finally {
    Object.assign(SURFACE, savedSurface);
  }

  // 不明なサーフェス名はハード扱いにフォールバックする
  applySurface('does-not-exist');
  ok(SURFACE.RESTITUTION_MULT === 1 && SURFACE.FRICTION_MULT === 1,
    `an unknown surface name falls back to hard, got ${JSON.stringify(SURFACE)}`);
  Object.assign(SURFACE, savedSurface);
}

// --- 軌跡：サービスのフォルト判定（inServiceBox）も、同じ「着地の瞬間を必ず1点記録する」
//     仕組みでカバーされている（inServiceBox() も bounce() の中から同じ座標で呼ばれるため） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.phase = 'rally';
  g.serveInFlight = true;
  g.serveNumber = 1;
  const from = { x: 0, y: SERVE.CONTACT_Y, z: -HALF_L };
  // サービスラインより1m深く（サーバーは'you'なので dir=+1）＝コースに関わらず明確にフォルト
  const target = { x: 0, y: R.config.PHYSICS.BALL_R, z: COURT.SERVICE + 1 };
  const v = R.physics.solveShot(from, target, 0.3, SERVE.CLEARANCE, 'flat'); // 速い球
  Object.assign(g.ball, {
    x: from.x, y: from.y, z: from.z, vx: v.vx, vy: v.vy, vz: v.vz, bounces: 0, last: 'you', live: true, spin: 'flat',
  });
  g.resetTrail();
  // わざと粗いフレームレート（1/20秒）でシミュレートする
  for (let i = 0; i < 60 && g.ball.bounces < 1; i++) g.update(1 / 20);
  const bouncePoint = g.trail.find((p) => p.y === R.config.PHYSICS.BALL_R);
  ok(!!bouncePoint, `the trail includes the exact service-landing point (y===BALL_R), got ${JSON.stringify(g.trail)}`);
  ok(g.serveNumber === 2, 'precondition: this long serve actually faulted (moved to the second serve)');
  ok(bouncePoint && g.inServiceBox({ x: bouncePoint.x, z: bouncePoint.z }) === false,
    `the trail's recorded landing point agrees with inServiceBox()'s fault ruling, got ${JSON.stringify(bouncePoint)}`);
}

// --- CPU/AI のロブ：相手がネットに詰めていたら山なりで頭を越し、そうでなければ通常の弾道 ---
{
  const { cpuShot } = R.ai;
  const CPU = R.config.CPU;
  const saved = { ...CPU };
  const restore = () => Object.assign(CPU, saved);

  // ロブを必ず選ぶ設定にして、狙いと飛翔時間がロブのものになることを確認する
  // (z=-1 は NET_PRESS_Z(1.8) 以内＝完全に詰め切っている扱いなので NET_LOB_PRESSED を使う)
  Object.assign(CPU, { NET_LOB_PRESSED: 1, LOB_BASE: 1, LOB_VS_STRETCH: 0 });
  const lob = cpuShot({ x: 2, z: -1 }, -1, 0); // 相手はネット際（z=-1）
  ok(lob.lob === true, 'a net-rushing opponent draws a lob');
  ok(lob.flight === CPU.LOB_T, `the lob uses the lob flight time, got ${lob.flight}`);
  ok(lob.target.z <= -CPU.LOB_Z_MIN && lob.target.z >= -CPU.LOB_Z_MAX,
    `the lob lands deep on the opponent's side, got z=${lob.target.z}`);
  ok(Math.abs(lob.target.z) <= HALF_L, `the lob still lands inside the court, got z=${lob.target.z}`);
  ok(Math.abs(lob.target.x) <= CPU.LOB_X, `the lob stays central, got x=${lob.target.x}`);

  // ロブを絶対に選ばない設定なら、足元かパッシングのどちらか（低い弾道）に戻る
  Object.assign(CPU, saved, { NET_LOB_PRESSED: 0, NET_LOB: 0, LOB_BASE: 0, LOB_VS_STRETCH: 0 });
  const drive = cpuShot({ x: 2, z: -1 }, -1, 0);
  ok(drive.lob === false, 'with the lob chance at zero the shot stays a normal (non-lob) shot');
  ok(drive.flight === CPU.NET_DROP_T || drive.flight === CPU.NET_PASS_T,
    `the shot uses either the drop or the passing flight time, got ${drive.flight}`);
  restore();
}

// --- CPU/AI のネットに詰めた相手への配球は「足元」「パッシング」「ロブ」の3択で撃ち分ける ---
{
  const { cpuShot } = R.ai;
  const CPU = R.config.CPU;
  const N = 400;

  const sample = (opponent) => {
    let lobCount = 0;
    let dropCount = 0;
    let passCount = 0;
    for (let i = 0; i < N; i++) {
      const shot = cpuShot(opponent, -1, 0);
      if (shot.lob) lobCount++;
      else if (shot.flight === CPU.NET_DROP_T) dropCount++;
      else if (shot.flight === CPU.NET_PASS_T) passCount++;
    }
    return { lobRate: lobCount / N, dropRate: dropCount / N, passRate: passCount / N };
  };

  // 人間がネット際（z≒-2、中央）にいる：詰め切ってはいないので、ロブ率は旧来の50%から
  // 明確に下がり（目安2〜3割）、代わりにパッシングと沈める球が出る。
  const atNet = sample({ x: 0, z: -2 });
  ok(atNet.lobRate < 0.35, `lob rate drops well below the old 50% for a net-rushing (not fully pressed) opponent, got ${atNet.lobRate}`);
  ok(atNet.dropRate > 0.05, `some shots go short to the feet, got dropRate=${atNet.dropRate}`);
  ok(atNet.passRate > 0.05, `some shots go for the sideline passing shot, got passRate=${atNet.passRate}`);

  // 前に出過ぎている（z が PLAYER.Z_NEAR=-1.2 寄り）ときだけロブの比率が上がる
  const pressed = sample({ x: 0, z: -1.3 });
  ok(pressed.lobRate > atNet.lobRate,
    `a fully pressed-in opponent (near PLAYER.Z_NEAR) draws more lobs than a merely net-rushing one, got pressed=${pressed.lobRate} vs atNet=${atNet.lobRate}`);

  // 相手が中央に寄っているほどパッシングが増え、サイドに寄り切っているほど減る
  const centered = sample({ x: 0, z: -2 });
  const wide = sample({ x: CPU.NET_PASS_X_REF + 1, z: -2 });
  ok(centered.passRate > wide.passRate,
    `a centered opponent draws more passing shots than one already hugging the sideline, got centered=${centered.passRate} vs wide=${wide.passRate}`);

  // シングルスのベースライン同士のラリー（z がNET_Zの外）は、この配球の対象外のまま
  // （＝LOB_BASE 経由の従来ロジックが変わらず使われる）
  const savedLobBase = CPU.LOB_BASE;
  Object.assign(CPU, { LOB_BASE: 0 });
  const baseline = cpuShot({ x: 0, z: -HALF_L + 1 }, -1, 0);
  ok(baseline.lob === false && baseline.flight === CPU.SHOT_T,
    `baseline-to-baseline rallies are untouched by the net-play logic, got lob=${baseline.lob} flight=${baseline.flight}`);
  Object.assign(CPU, { LOB_BASE: savedLobBase });
}

// --- CPU/AI のロブは、人間がスマッシュを打てる高さ・場所を通る（この項目の目的そのもの） ---
{
  const CPU = R.config.CPU;
  const { solveShot, integrate } = R.physics;
  const BALL_R = R.config.PHYSICS.BALL_R;
  // CPU がベースライン付近から、ロブの一番浅い狙いへ返した場合（一番厳しい条件）
  const from = { x: 0, y: 1.0, z: HALF_L - 1 };
  const v = solveShot(from, { x: 0, y: BALL_R, z: -CPU.LOB_Z_MIN }, CPU.LOB_T, undefined, 'flat');
  const b = { ...from, px: from.x, py: from.y, pz: from.z, ...v, spin: 'flat', wind: 0 };

  let window = null;
  for (let t = 0; t < 6 && b.y > BALL_R; t += R.config.PHYSICS.STEP) {
    integrate(b, R.config.PHYSICS.STEP);
    // 落ちてくる途中でスマッシュの高さ帯を通る区間（ノーバウンドで叩ける場所）
    if (b.vy < 0 && b.y >= PLAYER.SMASH_MIN_Y && b.y < PLAYER.REACH_Y) {
      if (!window) window = { z: b.z, dur: 0 };
      window.dur += R.config.PHYSICS.STEP;
    }
  }
  ok(!!window, 'the lob passes through the smash height band on its way down');
  ok(window && window.z < PLAYER.Z_NEAR && window.z > -(HALF_L + PLAYER.Z_FAR_MARGIN),
    `the smash contact point is somewhere the human can actually stand, got z=${window && window.z}`);
  ok(window && window.dur <= PLAYER.SWING_WINDOW,
    `the smash window is tight enough to need timing (<= SWING_WINDOW), got ${window && window.dur}s`);
}

// --- physics.predictWindow()：条件を満たすひとつながりの区間を最初のひとつだけ返す ---
{
  const { predictWindow } = R.physics;
  // 真上に打ち上げて落ちてくるだけの球（水平にも少し進む）
  const ball = {
    x: 0, y: 1, z: -4, px: 0, py: 1, pz: -4, vx: 0.5, vy: 7, vz: -0.5,
    spin: 'flat', wind: 0, bounces: 0,
  };
  const band = (lo, hi) => predictWindow(ball, (at) => at.y >= lo && at.y <= hi, 3);

  const w = band(2.0, 2.4);
  ok(!!w, 'a window is found when the trajectory passes through the band');
  ok(w && w.enter.y >= 2.0 && w.enter.y <= 2.4 && w.exit.y >= 2.0 && w.exit.y <= 2.4,
    'both ends of the window are inside the band');
  ok(w && w.enter.t < w.exit.t, 'the window runs forward in time');
  ok(w && w.mid.t > w.enter.t && w.mid.t < w.exit.t, 'mid sits between the two ends');
  // 上昇中に最初に帯へ入った区間だけを返す（落ちてくるときの2回目は含めない）
  ok(w && w.exit.t < 0.6, `only the first pass is returned, got exit t=${w && w.exit.t.toFixed(2)}`);
  ok(band(20, 30) === null, 'a band the ball never reaches yields null');
}

// --- physics.predictWindow()：サンプルは縦の速さと「弾んでからの時間」も持つ（ライジングの判定用） ---
{
  const { predictWindow } = R.physics;
  const { STEP } = R.config.PHYSICS;
  // 目の前の地面へ落ちてきて、弾んで上がる球
  const falling = {
    x: 0, y: 0.4, z: -5, vx: 0, vy: -4, vz: -10, spin: 'flat', wind: 0, bounces: 0,
  };
  const before = predictWindow(falling, () => true, 0.02, 1);
  ok(before && before.enter.sinceBounce === null && before.enter.vy < 0,
    `before the bounce there is no time since it: ${before && before.enter.sinceBounce}`);
  const after = predictWindow(falling, (at) => at.bounces === 1, 1, 1);
  ok(after && after.enter.sinceBounce === 0 && after.enter.vy > 0,
    `the bounce step starts the clock at 0 with the ball going up, got ${after && after.enter.sinceBounce}/${after && after.enter.vy}`);
  ok(after && Math.abs(after.exit.sinceBounce - (after.exit.t - after.enter.t)) < 1e-9,
    'and it counts up with the flight after that');
  // 予測を始めた時点で既に弾んでいる球は、その球の sinceBounce から数え続ける
  const rising = { ...falling, y: 0.3, vy: 3, bounces: 1, sinceBounce: 0.1 };
  const next = predictWindow(rising, () => true, 0.1, 1);
  ok(next && Math.abs(next.enter.sinceBounce - (0.1 + STEP)) < 1e-9,
    `an already-bounced ball keeps its clock, got ${next && next.enter.sinceBounce}`);
  // いつ弾んだか分からない球（sinceBounce を持たない）は null のまま
  const unknown = { ...rising };
  delete unknown.sinceBounce;
  ok(predictWindow(unknown, () => true, 0.1, 1).enter.sinceBounce === null,
    'a bounced ball with no clock stays unknown');
}

// --- スマッシュの先回りヒント：ロブが来たとき「立つべき地点」を返す ---
{
  const { solveShot, predictLanding } = R.physics;
  const { STEP, BALL_R } = R.config.PHYSICS;
  const CPU = R.config.CPU;
  const { SMASH_MIN_Y, SMASH_MIN_CHARGE, REACH, REACH_Y, X_LIMIT, Z_FAR_MARGIN } = PLAYER;

  /** CPU がベースラインから打ったロブが飛んでいる最中の局面を作る */
  const lobIncoming = () => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    const from = { x: 0, y: 1.0, z: HALF_L - 1 };
    const v = solveShot(from, { x: 0, y: BALL_R, z: -CPU.LOB_Z_MIN }, CPU.LOB_T, undefined, 'flat');
    Object.assign(g.ball, {
      x: from.x, y: from.y, z: from.z, px: from.x, py: from.y, pz: from.z,
      vx: v.vx, vy: v.vy, vz: v.vz,
      spin: 'flat', wind: 0, bounces: 0, live: true, last: 'cpu',
    });
    // ベースライン付近ではヒントを出さない仕様なので、前に詰めた位置を既定にする
    g.you.x = 0; g.you.z = -COURT.SERVICE - 1;
    return g;
  };

  {
    const g = lobIncoming();
    const hint = g.smashSpot();
    ok(!!hint, 'an incoming lob produces a smash hint');
    ok(hint && hint.y >= SMASH_MIN_Y && hint.y < REACH_Y,
      `the hinted contact height is inside the smash band, got y=${hint && hint.y}`);
    ok(hint && Math.abs(hint.x) <= X_LIMIT && hint.z <= PLAYER.Z_NEAR && hint.z >= -(HALF_L + Z_FAR_MARGIN),
      `the hinted spot is somewhere the human can stand, got (${hint && hint.x}, ${hint && hint.z})`);
    ok(hint && hint.t > 0 && hint.t < R.config.SMASH_HINT.LEAD_T,
      `the hint counts down to the contact, got t=${hint && hint.t}`);
    // 立つべき地点は「打点そのもの」ではなく「そこに立てば届く場所」。着地点とは別物
    // （着地点で待つとボールは頭上を越えてから落ちてくる）ことを確かめておく。
    const landing = predictLanding(g.ball);
    ok(hint && Math.abs(hint.z - landing.z) > 0.5,
      `the hint is not just the landing spot, hint z=${hint && hint.z} landing z=${landing.z}`);
  }

  // 先回りしていれば ready、遠くにいれば「間に合わない」になる
  {
    const g = lobIncoming();
    const hint = g.smashSpot();
    ok(hint && !hint.ready, 'standing back in mid-court is not yet in position');
    g.you.x = hint.x; g.you.z = hint.z;
    ok(g.smashSpot().ready, 'standing on the hinted spot flips the hint to ready');

    const far = lobIncoming();
    far.you.x = X_LIMIT; far.you.z = PLAYER.Z_NEAR; // コートの逆の隅
    const farHint = far.smashSpot();
    ok(farHint && !farHint.inTime,
      'from the far corner there is no time left to run and charge');
  }

  // 本番の判定と一致する：ヒントの位置で待って溜めて振ると、実際にスマッシュになる
  {
    const g = lobIncoming();
    const hint = g.smashSpot();
    g.you.x = hint.x; g.you.z = hint.z; // 先回りして待つ
    let elapsed = 0;
    while (elapsed < hint.t - STEP) {
      g.stepBall(STEP);
      elapsed += STEP;
    }
    g.you.swingCharge = SMASH_MIN_CHARGE; // 止まって溜めておいた分（ぎりぎり最低限）
    g.you.swing = PLAYER.SWING_WINDOW;
    g.checkSwings();
    ok(g.you.stroke === 'smash',
      `waiting on the hinted spot really yields a smash, got ${g.you.stroke}`);
    ok(Math.hypot(g.ball.x - hint.x, g.ball.z - hint.z) < REACH,
      'the ball is within reach of the hinted spot at the hinted moment');
  }

  // ベースライン付近に立っている間はヒントを出さない（そこからでは走る時間だけで滞空を使い切る）
  {
    const { HIDE_BASELINE_Z } = R.config.SMASH_HINT;
    const at = (z) => {
      const g = lobIncoming();
      g.you.z = z;
      return g.smashSpot();
    };
    ok(at(-HALF_L) === null, 'standing on the baseline shows no hint');
    ok(at(-HALF_L - PLAYER.Z_FAR_MARGIN) === null, 'standing behind the baseline shows no hint either');
    ok(at(-(HALF_L - HIDE_BASELINE_Z) - 0.01) === null,
      'just inside the hide zone still shows no hint');
    ok(at(-(HALF_L - HIDE_BASELINE_Z) + 0.3) !== null,
      'stepping in past the hide zone brings the hint back');
  }

  // バウンド後にしか打てない球にはヒントを出さない（ノーバウンドで叩ける球だけが対象）
  {
    // ロブをバウンド直前まで進めてから、ノーバウンドの帯を通り過ぎさせる。
    // この後もバウンドして高く弾む＝ルール上はスマッシュできるが、案内はしない。
    const g = lobIncoming();
    for (let t = 0; t < 3 && g.ball.bounces < 1; t += R.config.PHYSICS.STEP) g.stepBall(R.config.PHYSICS.STEP);
    ok(g.ball.bounces >= 1, 'precondition: the lob has bounced');
    // 弾んだ後も打てる高さの帯を通る＝ルール上はスマッシュできる球であることを確かめてから、
    // それでもヒントが出ないことを確認する（＝トリビアルに null なのではない）。
    // バウンド後にどこまで戻るかは PHYSICS.RESTITUTION のチューニング次第（跳ねすぎの
    // 調整で 0.72→0.57 まで下げた結果、実戦のロブはもう SMASH_MIN_Y まで戻らない）なので、
    // ここで見たい「バウンド後にしか打てない球には案内を出さない」だけを取り出せるよう、
    // 弾んだ直後の上向き速度を帯へ確実に届く値に置き換えてから判定する。
    g.ball.vy = Math.sqrt(2 * -R.config.PHYSICS.GRAVITY * (SMASH_MIN_Y + 0.2));
    const after = R.physics.predictWindow(
      g.ball, (at) => at.y >= SMASH_MIN_Y && at.y < REACH_Y, 2, 1,
    );
    ok(!!after, 'precondition: the bounced ball still climbs back into the smash height band');
    g.you.x = after.mid.x; g.you.z = after.mid.z; // その打点で待ち構えても…
    ok(g.smashSpot() === null, '…a ball that can only be smashed after the bounce produces no hint');
  }

  // 低い普通の返球にはヒントを出さない／自分が打った球にも出さない
  {
    const g = lobIncoming();
    Object.assign(g.ball, { y: 1.0, vy: 0.5 }); // 低い平たい球に差し替える
    ok(g.smashSpot() === null, 'a low drive produces no hint');

    const own = lobIncoming();
    own.ball.last = 'you';
    ok(own.smashSpot() === null, 'the ball you just hit yourself produces no hint');

    const idle = lobIncoming();
    idle.phase = 'serve';
    ok(idle.smashSpot() === null, 'no hint outside a rally');
  }
}

// --- スマッシュのモーション：長めのアニメと、溜め中の「振りかぶり」の構え ---
{
  const { solveShot } = R.physics;
  const { BALL_R } = R.config.PHYSICS;
  const CPU = R.config.CPU;

  ok(PLAYER.SMASH_ANIM > PLAYER.SWING_ANIM,
    `the smash animation is longer than a normal swing (跳ぶ分だけ見せる時間が要る), got ${PLAYER.SMASH_ANIM}`);

  // 打った瞬間、スマッシュだけ長いモーション時間が入る
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -5;
    g.ball.x = 0.3; g.ball.y = PLAYER.SMASH_MIN_Y + 0.2; g.ball.z = -5;
    g.you.swingCharge = PLAYER.SMASH_MIN_CHARGE + 0.1;
    g.hit('you');
    ok(g.you.stroke === 'smash', 'precondition: this hit is a smash');
    ok(g.you.anim === PLAYER.SMASH_ANIM, `a smash uses SMASH_ANIM, got ${g.you.anim}`);

    g.ball.y = 1.0; g.ball.bounces = 1; g.ball.last = 'cpu';
    g.you.chargeStroke = null;
    g.hit('you');
    ok(g.you.stroke !== 'smash' && g.you.anim === PLAYER.SWING_ANIM,
      `a normal groundstroke still uses SWING_ANIM, got ${g.you.stroke}/${g.you.anim}`);
  }

  // --- 跳躍は「打つ前」から始まる（スマッシュ／ダンクスマッシュ） ---
  // 打球のモーション（anim）は hit() が当たった瞬間に入れるので、跳躍を同じ時計に
  // 乗せると跳ぶのと打つのが同時に見える（ユーザー報告）。tickLeap() が「あと踏み切り
  // ぶんの時間で球が届く」ところで、まだ溜めキーを離していなくても跳び始める。
  {
    const mk = () => {
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.start();
      g.phase = 'rally';
      g.ball.live = true; g.ball.last = 'cpu'; g.wind = 0;
      g.you.x = 0; g.you.z = -3;
      Object.assign(g.ball, {
        x: 0.3, y: PLAYER.SMASH_MIN_Y + 0.5, z: -2.8, vx: 0, vy: -2, vz: -3, bounces: 0,
        spin: 'flat', wind: 0, curve: 0,
      });
      g.chargeStart('flat');
      g.you.chargeTime = R.config.CHARGE.MAX_TIME * (PLAYER.SMASH_MIN_CHARGE + 0.2);
      return g;
    };

    const g = mk();
    ok(!g.you.leap, 'precondition: not leaping yet');
    ok(g.leapKind(null, PLAYER.SMASH_MIN_CHARGE + 0.2) === 'smash',
      `precondition: this swing would be a smash, got ${g.leapKind(null, 0.7)}`);
    g.specialArmed = g.specialAim();
    g.tickLeap();
    ok(g.you.leap && g.you.leap.kind === 'smash' && g.you.leap.t === PLAYER.SMASH_LEAP_T,
      `the leap starts while still charging, got ${JSON.stringify(g.you.leap)}`);
    ok(g.you.charging && g.you.anim === 0 && g.you.stroke !== 'smash',
      `and the swing motion has not started: ${g.you.stroke}/${g.you.anim}`);
    ok(PLAYER.SMASH_LEAP_T * PLAYER.SMASH_LEAP_RISE > 0.1,
      `the take-off is long enough to read, got ${(PLAYER.SMASH_LEAP_T * PLAYER.SMASH_LEAP_RISE).toFixed(3)}s`);

    // 溜めが足りなければ（スマッシュにならないので）跳ばない
    const weak = mk();
    weak.you.chargeTime = R.config.CHARGE.MAX_TIME * (PLAYER.SMASH_MIN_CHARGE - 0.2);
    weak.specialArmed = weak.specialAim();
    weak.tickLeap();
    ok(!weak.you.leap, `a swing that will not be a smash does not leap, got ${JSON.stringify(weak.you.leap)}`);

    // 低い球（ふつうのストローク）でも跳ばない
    const low = mk();
    low.ball.y = 1.0;
    low.specialArmed = low.specialAim();
    low.tickLeap();
    ok(!low.you.leap, `a normal groundstroke does not leap, got ${JSON.stringify(low.you.leap)}`);

    // 当たったときには、離す前に始めた跳躍がまだ続いている
    const rise = PLAYER.SMASH_LEAP_T * PLAYER.SMASH_LEAP_RISE;
    for (let i = 0; i < Math.round(rise * 60); i++) g.update(1 / 60);
    g.chargeRelease();
    g.update(1 / 60);
    ok(g.you.leap && g.you.leap.kind === 'smash',
      `the leap is still running at contact, got ${JSON.stringify(g.you.leap)}`);
    ok(g.you.leap.t < PLAYER.SMASH_LEAP_T - rise + 1 / 60,
      `and it is past the take-off by then, got ${g.you.leap.t.toFixed(3)}`);

    // ポイントをまたいで持ち越さない
    g.newPoint();
    ok(!g.you.leap, `a new point clears the leap, got ${JSON.stringify(g.you.leap)}`);

    // --- 跳ぶ高さは打点で決まる：立ったままラケットが届く高さなら跳ばない ---
    // 以前は打点に関わらず毎回 SWING.SMASH_JUMP_H 跳び、低い打点ではラケットが球の上を
    // 素通りして見えた（ユーザー報告「ジャンプしない方が自然な高さでも跳ぶ」）。
    const { SWING } = R.config;
    const at = (y) => {
      const h = mk();
      h.ball.y = y;
      h.specialArmed = h.specialAim();
      return h;
    };
    const stand = at(SWING.SMASH_STAND_Y - 0.25);
    stand.tickLeap();
    ok(stand.you.leap && stand.you.leap.kind === 'smash',
      `a smash at standing height still runs the leap clock (it drives the swing), got ${JSON.stringify(stand.you.leap)}`);
    ok(stand.you.leap.lift === 0, `but does not leave the ground, got lift=${stand.you.leap.lift}`);

    const high = at(SWING.SMASH_STAND_Y + 0.18);
    high.tickLeap();
    ok(high.you.leap && Math.abs(high.you.leap.lift - 0.18) < 1e-9,
      `a smash above the standing reach jumps just high enough to meet it, got lift=${high.you.leap && high.you.leap.lift}`);
    ok(PLAYER.REACH_Y - SWING.SMASH_STAND_Y <= SWING.SMASH_JUMP_H,
      'even the highest reachable smash needs no more than the jump cap');

    // ダンクスマッシュは技の見せ場なので、打点に関わらず高く跳ぶ
    const dunk = at(SWING.SMASH_STAND_Y - 0.05);
    dunk.specialArmed = { move: 'dunkSmash' };
    dunk.tickLeap();
    ok(dunk.you.leap && dunk.you.leap.lift === SWING.SMASH_JUMP_H * R.config.SPECIAL.DUNK.JUMP_MULT,
      `the dunk smash always leaps high, got lift=${dunk.you.leap && dunk.you.leap.lift}`);

    // 跳んだ後も当たるまでは打点の見込みへ寄せ直す：離すのが遅れて球が落ちてくれば低くなる
    const late = at(SWING.SMASH_STAND_Y + 0.2);
    late.tickLeap();
    const lift0 = late.you.leap.lift;
    for (let i = 0; i < 15; i++) late.update(1 / 60); // 溜めたまま 0.25 秒待つ＝球は 2.0m 付近まで落ちる
    ok(late.you.charging && late.ball.y < SWING.SMASH_STAND_Y,
      `precondition: still holding while the ball drops below the standing reach, y=${late.ball.y.toFixed(2)}`);
    ok(late.you.leap.lift < lift0 * 0.3,
      `holding on lowers the jump towards the later contact, got ${late.you.leap.lift.toFixed(3)} (from ${lift0.toFixed(3)})`);
    // 当たった後は寄せない（打った高さのまま着地する）
    late.chargeRelease();
    late.update(1 / 60);
    ok(late.you.anim > 0, 'precondition: the late release connects');
    const liftAtHit = late.you.leap.lift;
    late.update(1 / 60);
    ok(late.you.leap.lift === liftAtHit, `the jump height is fixed once the ball is hit, got ${late.you.leap.lift} vs ${liftAtHit}`);
  }

  // CPU/AI のスマッシュも、跳ぶ高さは打点で決まる
  {
    const { CPU, SWING } = R.config;
    const cpuSmash = (y) => {
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.start();
      g.phase = 'rally';
      g.serveInFlight = false;
      g.cpu.x = 0; g.cpu.z = 3;
      Object.assign(g.ball, { x: 0.3, y, z: 3, bounces: 0, vy: CPU.SMASH_FALLING_VY - 1, vx: 0, vz: -1 });
      g.hit('cpu');
      return g;
    };
    const low = cpuSmash(Math.max(CPU.SMASH_MIN_Y, SWING.SMASH_STAND_Y - 0.1));
    ok(low.cpu.stroke === 'smash' && !low.cpu.special, `precondition: a plain CPU smash, got ${low.cpu.stroke}/${low.cpu.special}`);
    ok(low.cpu.leap && low.cpu.leap.kind === 'smash' && low.cpu.leap.lift === 0,
      `a CPU smash at standing height does not jump, got ${JSON.stringify(low.cpu.leap)}`);
    const top = cpuSmash(PLAYER.CPU_REACH_Y - 0.01);
    ok(top.cpu.leap && Math.abs(top.cpu.leap.lift - (PLAYER.CPU_REACH_Y - 0.01 - SWING.SMASH_STAND_Y)) < 1e-9,
      `a CPU smash above the standing reach jumps just enough, got ${JSON.stringify(top.cpu.leap)}`);
  }

  // スマッシュで打てる位置に立って溜めている間は、構えが 'smash'（頭の後ろへ担ぐ振りかぶり）になる
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    const from = { x: 0, y: 1.0, z: HALF_L - 1 };
    const v = solveShot(from, { x: 0, y: BALL_R, z: -CPU.LOB_Z_MIN }, CPU.LOB_T, undefined, 'flat');
    Object.assign(g.ball, {
      x: from.x, y: from.y, z: from.z, px: from.x, py: from.y, pz: from.z,
      vx: v.vx, vy: v.vy, vz: v.vz, spin: 'flat', wind: 0, bounces: 0, live: true, last: 'cpu',
    });
    g.you.x = 0; g.you.z = -COURT.SERVICE - 1; // ベースライン付近はヒントを出さないので前に詰めておく

    const hint = g.smashSpot();
    g.you.x = hint.x; g.you.z = hint.z; // ヒントの地点で待つ
    g.chargeStart('flat');
    g.smashHint = g.smashSpot();
    g.updatePrep();
    ok(g.smashHint.ready && g.you.prep === 'smash',
      `charging on the hinted spot shows the wind-up pose, got ${g.you.prep}`);

    // 同じ溜めでも、スマッシュで打てる位置にいなければ従来どおりフォア/バックのテイクバック
    g.you.x = PLAYER.X_LIMIT; g.you.z = PLAYER.Z_NEAR;
    g.smashHint = g.smashSpot();
    g.updatePrep();
    ok(g.you.prep === 'forehand' || g.you.prep === 'backhand',
      `away from the spot the takeback stays a normal groundstroke, got ${g.you.prep}`);
  }
}

// --- CPU/AI の守備範囲は「反応に使える時間」で決まる（速い球・至近距離の球は反射でしか触れない） ---
{
  const { reactReach } = R.ai;
  const DOUBLES = R.config.DOUBLES;
  const {
    CPU_REACH, CPU_REFLEX_REACH, CPU_REFLEX_T_MIN, CPU_REFLEX_T_MAX,
    CPU_BLIND_REACH, CPU_BLIND_T,
  } = PLAYER;

  ok(reactReach(0) === CPU_BLIND_REACH, `no time at all leaves only a body block, got ${reactReach(0)}`);
  ok(reactReach(CPU_BLIND_T) === CPU_BLIND_REACH, 'at the blind limit it is still only a body block');
  ok(reactReach(CPU_REFLEX_T_MIN) === CPU_REFLEX_REACH, 'at T_MIN the reflex reach is back');
  ok(reactReach(CPU_REFLEX_T_MAX) === CPU_REACH, 'at T_MAX the full reach is available again');
  ok(reactReach(5) === CPU_REACH, 'plenty of time is still just the full reach (no bonus)');
  ok(reactReach(undefined) === CPU_BLIND_REACH, 'a ball with no age recorded is treated as the strictest case');
  const blind = reactReach((CPU_BLIND_T + CPU_REFLEX_T_MIN) / 2);
  ok(blind > CPU_BLIND_REACH && blind < CPU_REFLEX_REACH, `it ramps out of the blind zone, got ${blind}`);
  const mid = reactReach((CPU_REFLEX_T_MIN + CPU_REFLEX_T_MAX) / 2);
  ok(mid > CPU_REFLEX_REACH && mid < CPU_REACH, `it ramps in between, got ${mid}`);
  // 至近距離のボレー（ネット際同士は 0.2 秒ほどで届く）は、体の正面しか触れない
  ok(reactReach(0.17) < 0.3,
    `a volley from the opposite net position leaves almost no reach, got ${reactReach(0.17)}`);

  // 実際の当たり判定：打たれた直後に届く球（＝スマッシュやネット際のボレー）は取りこぼす
  const netPlayerTry = (age) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(true); // ダブルス
    g.phase = 'rally';
    g.serveInFlight = false;
    // cpuMate をネット際に置き、その 1.0m 横をノーバウンドで通す
    Object.assign(g.cpuMate, { x: 0, z: DOUBLES.NET_Z_CPU });
    Object.assign(g.cpu, { x: 0, z: HALF_L - 0.5 });
    Object.assign(g.ball, {
      x: 1.0, y: 1.2, z: DOUBLES.NET_Z_CPU, px: 1.0, py: 1.2, pz: DOUBLES.NET_Z_CPU,
      vx: 0, vy: 0, vz: 6, bounces: 0, last: 'you', live: true, age, wind: 0, spin: 'flat',
    });
    g.checkSwings();
    return g.ball.last === 'cpu'; // 返された＝ボールの持ち主がCPU側に変わる
  };
  ok(reactReach(0.05) < 1.0 && reactReach(CPU_REFLEX_T_MAX) > 1.0,
    'precondition: 1.0m is outside the reflex reach but inside the full reach');
  ok(netPlayerTry(0.05) === false,
    'a ball that arrives right after it was struck slips past the net player');
  ok(netPlayerTry(CPU_REFLEX_T_MAX + 0.1) === true,
    'the same ball is reached when there was time to read it');
}

// --- ポイントが決まったとき、取った側が最後に放った球種を出す ---
{
  const CHARGE = R.config.CHARGE;
  const label = (setup, input = fakeInput) => {
    const g = new R.Game({ input, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.you.x = 0; g.you.z = -HALF_L;
    Object.assign(g.ball, {
      x: 0.3, y: 1.0, z: -HALF_L + 0.5, bounces: 1, last: 'cpu', live: true, wind: 0,
    });
    setup(g);
    g.hit('you');
    return g.lastShotBy.you;
  };

  ok(label((g) => { g.you.chargeSpin = 'flat'; g.you.swingCharge = 1; }) === 'フラットショット',
    'a plain drive is reported as a flat shot');
  ok(label((g) => { g.chargeStart('top'); g.chargeRelease(); }) === 'スピンショット',
    'topspin is reported as a spin shot');
  ok(label((g) => { g.chargeStart('slice'); g.you.chargeTime = CHARGE.MAX_TIME; g.chargeRelease(); }) === 'スライスショット',
    'a charged slice is reported as a slice shot');
  ok(label((g) => { g.chargeStart('slice'); g.chargeRelease(); }) === 'ドロップショット',
    'an uncharged slice (= drop shot) is reported as a drop shot');
  ok(label((g) => { g.you.swingCharge = 1; }, { moveX: 0, moveZ: 0, lob: true }) === 'ロブ',
    'a lob is reported as a lob, not as the spin it was hit with');
  ok(label((g) => {
    g.you.z = -1.5; g.ball.z = -1.6; g.ball.bounces = 0; // サービスラインより前＋ノーバウンド＝ボレー
    g.ball.x = 0.55;
  }) === 'ボレー', 'a volley is reported as a volley');
  ok(label((g) => {
    g.ball.y = PLAYER.SMASH_MIN_Y + 0.3;
    g.you.swingCharge = PLAYER.SMASH_MIN_CHARGE + 0.1;
  }) === 'スマッシュ', 'a smash is reported as a smash');

  // サーブ（エースはこれで決まる）。球種（スピン）とコースまで出す：「サービス」だけでは
  // 何が良かったのか分からない、というフィードバックを受けた変更。
  {
    const serveLabel = (spin, aimX) => {
      const g = new R.Game({ input: { ...fakeInput, moveX: aimX }, hooks: noHooks });
      g.start();
      g.chargeStart(spin);   // トス
      g.chargeStart(spin);   // 溜め始め
      g.chargeRelease();     // 振り出す
      untilServed(g);        // トスが打点に来て当たる
      return g.lastShotBy.you;
    };
    // 無入力（moveX=0）はボディ狙い。スピンの呼び分けがそのまま出る
    ok(serveLabel('flat', 0) === 'フラットサービス（ボディ）',
      `a flat serve is reported with its spin and course, got ${serveLabel('flat', 0)}`);
    ok(serveLabel('top', 0) === 'スピンサービス（ボディ）',
      `a topspin serve is reported as a spin serve, got ${serveLabel('top', 0)}`);
    ok(serveLabel('slice', 0) === 'スライスサービス（ボディ）',
      `a slice serve is reported as a slice serve, got ${serveLabel('slice', 0)}`);
    // コースは ←→ の入力で変わる。どちらの向きがワイドになるかはサーブするサイド
    // （デュース/アド）で入れ替わるので、「2通り打てば片方がセンター、もう片方が外側」で見る。
    const both = [serveLabel('flat', 1), serveLabel('flat', -1)];
    ok(both.some((l) => l.includes('センター')), `one of them goes down the T, got ${both.join(' / ')}`);
    ok(both.some((l) => l.includes('ワイド') || l.includes('角度')),
      `the other goes outside, got ${both.join(' / ')}`);
    ok(both.every((l) => l.startsWith('フラットサービス')),
      'the spin name stays the same whatever the course');
  }

  // CPU のロブもロブとして記録される
  {
    const CPU = R.config.CPU;
    const saved = { ...CPU };
    Object.assign(CPU, { LOB_BASE: 1, LOB_VS_STRETCH: 0 }); // g.you はデフォルトでベースライン付近＝NET_Zの外
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.cpu.x = 0; g.cpu.z = HALF_L - 0.5;
    Object.assign(g.ball, { x: 0, y: 1.0, z: HALF_L - 1, bounces: 1, last: 'you', live: true, wind: 0 });
    g.hit('cpu');
    ok(g.lastShotBy.cpu === 'ロブ', `a CPU lob is reported as a lob, got ${g.lastShotBy.cpu}`);
    Object.assign(CPU, saved);
  }

  // ポイントが決まったら、取った側の最後の1本がコールと一緒に渡る
  {
    const calls = [];
    const hooks = {
      sound() {}, call(big, sub, shot) { calls.push({ big, sub, shot }); }, clearCall() {}, score() {}, wind() {}, serveSpeed() {},
    };
    const g = new R.Game({ input: fakeInput, hooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.you.x = 0; g.you.z = -5;
    Object.assign(g.ball, { x: 0.3, y: PLAYER.SMASH_MIN_Y + 0.3, z: -5, bounces: 1, last: 'cpu', live: true, wind: 0 });
    g.you.swingCharge = 1;
    g.hit('you'); // スマッシュで決める
    calls.length = 0;
    g.endPoint('you', 'ツーバウンド');
    ok(calls.length > 0 && calls[0].shot === 'スマッシュ',
      `the winning side's last shot is reported with the call, got ${calls.length && calls[0].shot}`);

    // 相手のミス（ネット）で取ったときは「その1本前に自分が打った球」が出る
    calls.length = 0;
    g.phase = 'rally'; // endPoint() は 'over' のままだと二重に走らないので戻す
    g.endPoint('you', 'ネット');
    ok(calls.length > 0 && calls[0].shot === 'スマッシュ',
      'a point won on the opponent\'s error still reports the winner\'s own last shot');

    // 次のポイントでは消える（前のポイントの球種を引きずらない）
    g.newPoint();
    ok(g.lastShotBy.you === null && g.lastShotBy.cpu === null,
      'the record is cleared for the next point');
  }
}

// --- CPU/AI の移動：斜めでも設定速度を超えない（x/z 別々に step を足すと √2 倍速くなる） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  const speed = PLAYER.CPU_CHASE;
  const dt = 1 / 60;
  const before = { x: 0, z: 0 };
  Object.assign(g.cpu, { x: 0, z: 0, speed: 0, chaseDist: 0 });
  g.moveTowards(g.cpu, before, { x: 100, z: 100 }, speed, dt); // 真斜め（45度）へ全力
  const moved = Math.hypot(g.cpu.x, g.cpu.z);
  ok(Math.abs(moved - speed * dt) < 1e-9,
    `diagonal movement covers exactly speed*dt, got ${moved} want ${speed * dt}`);
  ok(Math.abs(g.cpu.speed - speed) < 1e-9, `recorded speed never exceeds CPU_CHASE, got ${g.cpu.speed}`);
  ok(Math.abs(g.cpu.chaseDist - moved) < 1e-9, `the move is accumulated into chaseDist, got ${g.cpu.chaseDist}`);

  // 目標を通り過ぎない（残り距離が step より短いときはぴったり止まる）
  Object.assign(g.cpu, { x: 0, z: 0, chaseDist: 0, parked: false });
  g.moveTowards(g.cpu, { x: 0, z: 0 }, { x: 0.01, z: 0 }, speed, dt);
  ok(g.cpu.x === 0.01 && g.cpu.z === 0, `stops exactly on the target, got (${g.cpu.x}, ${g.cpu.z})`);

  // 着いた後は、目標が数cm揺れても追わない（＝止まって待てている）。先読みの目標は
  // フレームの刻みと物理の刻みのずれで揺れ、追うと 144Hz の画面などで CPU が
  // いつまでも「待てていない・走らされた」扱いになっていた（ユーザー報告）
  ok(g.cpu.parked, 'arriving on the target parks the CPU');
  Object.assign(g.cpu, { settleT: 0, chaseDist: 0 });
  g.moveTowards(g.cpu, { x: 0.01, z: 0 }, { x: 0.06, z: 0 }, speed, dt);
  ok(g.cpu.x === 0.01 && g.cpu.speed === 0 && g.cpu.chaseDist === 0 && g.cpu.settleT > 0,
    `a few cm of target jitter does not move a parked CPU, got x=${g.cpu.x} speed=${g.cpu.speed}`);
  g.moveTowards(g.cpu, { x: 0.01, z: 0 }, { x: 1, z: 0 }, speed, dt);
  ok(g.cpu.x > 0.01 && !g.cpu.parked, `but a real change of target still gets chased, got x=${g.cpu.x}`);
}

// --- サーブのレシーブ：構えた位置のまま届く球（ボディ）は、余計に走っても弱くならない ---
// ユーザー報告「ボディにサーブを打つと、強い CPU でもレシーブが弱すぎる」。遅いサーブは
// 高く弾んで深く伸びるので、レシーバーは弾んだ後の頂点を目指して3〜4m 走り、その走った
// 距離で「走らされた」扱いになっていた（107km/h のサーブにレシーブ 74km/h・ロブ24%）。
{
  const { CPU, applyCpuLevel } = R.config;
  applyCpuLevel('extreme');
  const returnFlight = (serve, chaseDist) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = serve;
    g.cpu.x = 0; g.cpu.z = HALF_L - 1;
    Object.assign(g.cpu, { chaseDist, chaseFromX: 0.3, chaseFromZ: HALF_L, settleT: 0, runFwd: 0 });
    Object.assign(g.ball, {
      x: 0.6, y: 1.0, z: HALF_L - 1.6, vx: 0, vy: -0.5, vz: 8, bounces: 1, live: true, last: 'you',
      spin: 'flat', wind: 0, windZ: 0, curve: 0, shotSpeed: 50,
    });
    const saved = { ...CPU };
    Object.assign(CPU, { LOB_BASE: 0, LOB_VS_STRETCH: 0, OUT_LONG: 0, OUT_WIDE: 0, STRETCH_OUT_LONG: 0, STRETCH_OUT_WIDE: 0 });
    g.hit('cpu');
    Object.assign(CPU, saved);
    return R.physics.predictLanding(g.ball).t;
  };
  const calm = returnFlight(true, 0);
  const ranAround = returnFlight(true, CPU.STRETCH_DIST_MAX);
  ok(Math.abs(ranAround - calm) < 0.05,
    `a return of a serve that came to the receiver is not weakened by extra running: ${ranAround.toFixed(2)}s vs ${calm.toFixed(2)}s`);
  ok(returnFlight(false, CPU.STRETCH_DIST_MAX) > calm + 0.2,
    'while in a rally the same run still counts as being stretched');

  // 実際のサーブ：溜めずに打った遅いボディサーブにも、しっかり返す（ロブに逃げない）
  const bodyReturn = () => {
    const input = { moveX: 0, moveZ: 0, lob: false };
    const g = new R.Game({ input, hooks: noHooks });
    g.start(false, 'you');
    g.wind = 0; g.windZ = 0;
    let rec = null;
    const hitAs = g.hit.bind(g);
    g.hit = (who) => {
      const r = hitAs(who);
      if (who === 'cpu' && !rec) rec = { kmh: R.math.mpsToKmh(Math.hypot(g.ball.vx, g.ball.vz)), lob: /ロブ/.test(g.lastShotBy.cpu) };
      return r;
    };
    let served = false;
    for (let i = 0; i < 60 * 6 && !rec && g.phase !== 'fault' && g.phase !== 'over'; i++) {
      if (!served && g.phase === 'serve' && !g.tossActive && !g.serveSwing) g.chargeStart('flat');
      if (!served && g.tossActive && g.you.charging && g.you.chargeTime >= 0.15) { g.chargeRelease(); served = true; }
      g.update(1 / 60);
    }
    return rec;
  };
  const rs = Array.from({ length: 40 }, bodyReturn).filter(Boolean);
  const drives = rs.filter((r) => !r.lob);
  const kmh = drives.reduce((a, r) => a + r.kmh, 0) / drives.length;
  ok(rs.length >= 30 && kmh > 90 && drives.length >= rs.length * 0.85,
    `a slow body serve is returned firmly: ${kmh.toFixed(0)} km/h, ${rs.length - drives.length}/${rs.length} lobs`);
  applyCpuLevel('normal');
}

// --- CPU の返球はフレームレートで変わらない（60fps 以外の画面で弱くなっていた） ---
// 実測（修正前、Extreme・溜めずに打った球）：60fps では待てた時間 1.2秒・返球 152km/h、
// 144fps では 0.00秒・36km/h でロブ47%（ユーザー報告「ゆるいフラットショットとロブが
// 返ってくる」）。CPU が先読みの揺れを毎フレーム追い、止まれていなかった。
{
  const { applyCpuLevel } = R.config;
  applyCpuLevel('extreme');
  const softReturn = (nextDt) => {
    const g = new R.Game({ input: { moveX: 0, moveZ: 0, lob: false }, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.wind = 0; g.windZ = 0;
    g.you.x = 0; g.you.z = -HALF_L;
    g.cpu.x = 0; g.cpu.z = HALF_L + 0.5;
    Object.assign(g.ball, {
      x: 0.6, y: 0.9, z: -HALF_L + 0.3, vx: 0, vy: 1, vz: -5,
      bounces: 1, live: true, last: 'cpu', spin: 'flat', wind: 0, windZ: 0, curve: 0,
    });
    g.you.swingCharge = 0; g.you.chargeSpin = 'flat'; g.you.chargeStroke = null;
    g.hit('you');
    let settle = 0;
    for (let i = 0; i < 2000 && g.ball.last === 'you' && g.phase === 'rally'; i++) {
      settle = g.cpu.settleT;
      g.update(nextDt());
    }
    return { settle, kmh: R.math.mpsToKmh(Math.hypot(g.ball.vx, g.ball.vz)), lob: /ロブ/.test(g.lastShotBy.cpu) };
  };
  const rates = { '60fps': () => 1 / 60, '144fps': () => 1 / 144, 'uneven': () => 1 / 240 + Math.random() * (1 / 40 - 1 / 240) };
  Object.entries(rates).forEach(([name, nextDt]) => {
    const rs = Array.from({ length: 20 }, () => softReturn(nextDt));
    const settle = rs.reduce((a, r) => a + r.settle, 0) / rs.length;
    const drives = rs.filter((r) => !r.lob);
    const kmh = drives.reduce((a, r) => a + r.kmh, 0) / Math.max(1, drives.length);
    ok(settle > 0.5, `${name}: the CPU settles before hitting a soft ball, waited ${settle.toFixed(2)}s`);
    ok(kmh > 110 && drives.length >= 18, `${name}: and hits it hard, ${kmh.toFixed(0)} km/h, ${rs.length - drives.length}/20 lobs`);
  });
  applyCpuLevel('normal');
}

// --- CPU/AI の返球の強さ（stretch）は「その球を追って走った距離」で決まる ---
{
  const CPU = R.config.CPU;
  const setup = (chaseDist) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.cpu.x = 0; g.cpu.z = HALF_L - 2;
    Object.assign(g.ball, {
      x: 0, y: 1.0, z: HALF_L - 2, live: true, bounces: 1, last: 'you',
    });
    g.cpu.chaseDist = chaseDist;
    // ロブと「わざとのアウト」を止めてから打たせる（どちらも乱数で入るため比較にならない）
    const saved = { ...CPU };
    Object.assign(CPU, {
      LOB_BASE: 0, LOB_VS_STRETCH: 0,
      OUT_LONG: 0, OUT_WIDE: 0, STRETCH_OUT_LONG: 0, STRETCH_OUT_WIDE: 0,
    });
    g.hit('cpu');
    Object.assign(CPU, saved);
    return g.ball;
  };
  // 走っていない＝余裕がある返球：速くて深い
  const comfy = setup(0);
  // 大きく走らされた返球：山なりで浅い
  const stretched = setup(CPU.STRETCH_DIST_MAX + 1);
  const landing = (b) => R.physics.predictLanding(b);
  ok(Math.hypot(comfy.vx, comfy.vy, comfy.vz) > Math.hypot(stretched.vx, stretched.vy, stretched.vz),
    'a return hit without running is faster than one hit after a long chase');
  ok(Math.abs(landing(comfy).z) > Math.abs(landing(stretched).z),
    `the comfortable return lands deeper, got ${landing(comfy).z} vs ${landing(stretched).z}`);

  // 走った距離は新しい打球のたびにリセットされる（前の球の疲労を持ち越さない）
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.cpu.chaseDist = 99;
  g.resetChase();
  ok(g.cpu.chaseDist === 0, 'resetChase() clears the accumulated chase distance');
}

// --- チャンスボール：ゆるい球が来て、打点で待てていたら強打する（難易度が高いほど） ---
// ユーザー報告「こちらがあまり溜めていないゆるい球を打っているのに、相手もゆるい球を
// 返す（特に難易度が高いとき）」。浅いゆるい球へ前に走った距離を「走らされた苦しさ」と
// 数えて、山なりの弱い返球・ロブになっていた。
{
  const { CPU, applyCpuLevel } = R.config;
  applyCpuLevel('hard');
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    ok(g.ball.shotSpeed === Infinity && g.chanceAttack(g.cpu) === 0,
      'before anyone has hit, nothing counts as a slow ball');
    g.cpu.settleT = CPU.CHANCE_SETTLE_T;
    g.ball.shotSpeed = CPU.CHANCE_SPEED_SLOW;
    ok(g.chanceAttack(g.cpu) === CPU.CHANCE_ATTACK, `a slow ball the CPU waited for is a full chance, got ${g.chanceAttack(g.cpu)}`);
    g.ball.shotSpeed = CPU.CHANCE_SPEED_FAST;
    ok(g.chanceAttack(g.cpu) === 0, 'a fast ball is not a chance');
    g.ball.shotSpeed = CPU.CHANCE_SPEED_SLOW;
    g.cpu.settleT = 0;
    ok(g.chanceAttack(g.cpu) === 0, 'nor is a slow ball the CPU only just reached');
    applyCpuLevel('easy');
    g.cpu.settleT = CPU.CHANCE_SETTLE_T;
    ok(g.chanceAttack(g.cpu) === 0, 'easy never goes for it');
    applyCpuLevel('extreme');
    const extreme = CPU.CHANCE_ATTACK;
    applyCpuLevel('hard');
    const hard = CPU.CHANCE_ATTACK;
    applyCpuLevel('normal');
    ok(extreme >= hard && hard > CPU.CHANCE_ATTACK && CPU.CHANCE_ATTACK > 0,
      `the higher the level, the harder it punishes: normal ${CPU.CHANCE_ATTACK} / hard ${hard} / extreme ${extreme}`);
  }

  // 叩きにいく1本はロブに逃げず、走らされていても速い球になる
  {
    applyCpuLevel('hard');
    let lobs = 0;
    let slowest = 0;
    for (let i = 0; i < 300; i++) {
      const s = R.ai.cpuShot({ x: 0, z: -HALF_L }, -1, 1, 1, 1, undefined, 1);
      if (s.lob) lobs++;
      else slowest = Math.max(slowest, s.flight);
    }
    ok(lobs === 0, `a full chance never lobs, got ${lobs}/300`);
    ok(Math.abs(slowest - CPU.CHANCE_T) < 1e-9 && CPU.CHANCE_T < CPU.SHOT_T,
      `and flies in CHANCE_T (faster than a normal rally ball), got ${slowest}`);
  }

  // 実際のラリー：人間が溜めずに打ったゆるい球への返球は、フル溜めへの返球より速い
  {
    applyCpuLevel('hard');
    const returnTo = (charge) => {
      const input = { moveX: Math.random() * 2 - 1, moveZ: 0, lob: false };
      const g = new R.Game({ input, hooks: noHooks });
      g.start();
      g.phase = 'rally';
      g.serveInFlight = false;
      g.wind = 0; g.windZ = 0;
      g.you.x = (Math.random() * 2 - 1) * 2; g.you.z = -HALF_L + 0.5;
      g.cpu.x = (Math.random() * 2 - 1) * 1.5; g.cpu.z = HALF_L + 0.5;
      Object.assign(g.ball, {
        x: g.you.x + 0.6, y: 0.9, z: g.you.z + 0.3, vx: 0, vy: 1, vz: -5,
        bounces: 1, live: true, last: 'cpu', spin: 'flat', wind: 0, windZ: 0, curve: 0,
      });
      g.you.swingCharge = charge; g.you.chargeSpin = 'flat'; g.you.chargeStroke = null;
      g.hit('you');
      for (let i = 0; i < 60 * 5 && g.ball.last === 'you' && g.phase === 'rally'; i++) g.update(1 / 60);
      if (g.ball.last !== 'cpu') return null;
      return { kmh: R.math.mpsToKmh(Math.hypot(g.ball.vx, g.ball.vz)), lob: /ロブ/.test(g.lastShotBy.cpu) };
    };
    const sample = (charge) => {
      const rs = [];
      for (let i = 0; i < 80; i++) { const r = returnTo(charge); if (r) rs.push(r); }
      const drives = rs.filter((r) => !r.lob);
      return {
        kmh: drives.reduce((s, r) => s + r.kmh, 0) / drives.length,
        lobRate: (rs.length - drives.length) / rs.length,
        n: rs.length,
      };
    };
    const soft = sample(0);
    const hardHit = sample(1);
    ok(soft.n > 60 && hardHit.n > 60, `precondition: the CPU returns most balls, got ${soft.n}/${hardHit.n}`);
    ok(soft.kmh > hardHit.kmh + 5,
      `a soft ball gets hit harder than a full-power one: ${soft.kmh.toFixed(0)} vs ${hardHit.kmh.toFixed(0)} km/h`);
    ok(soft.lobRate < 0.1, `and the CPU does not lob it back, got ${(soft.lobRate * 100).toFixed(0)}%`);
  }

  // 弾んで上がってくるチャンスボールは、届くうちのいちばん高いところまで引きつけて叩く
  {
    applyCpuLevel('extreme');
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.cpu.x = 0; g.cpu.z = 9;
    g.cpu.settleT = 1;
    Object.assign(g.ball, {
      x: 0.2, y: 0.6, z: 7.6, vx: 0, vy: 3, vz: 3, bounces: 1, sinceBounce: 0.1, age: 1,
      live: true, last: 'you', spin: 'flat', wind: 0, windZ: 0, curve: 0, shotSpeed: CPU.CHANCE_SPEED_SLOW,
    });
    ok(g.chanceAttack(g.cpu) > 0, 'precondition: a chance ball');
    ok(g.holdForChance(g.cpu, g.ball), 'a rising chance ball is not hit at knee height');
    g.ball.shotSpeed = CPU.CHANCE_SPEED_FAST;
    ok(!g.holdForChance(g.cpu, g.ball), 'a ball that is no chance is hit as soon as it is in reach (as before)');
    g.ball.shotSpeed = CPU.CHANCE_SPEED_SLOW;
    g.ball.vy = -0.5;
    ok(!g.holdForChance(g.cpu, g.ball), 'once the ball starts to drop, the CPU swings');
    // 叩きにいく1本はスライスに逃げず、ネットのすぐ上を低く通す
    let slices = 0;
    for (let i = 0; i < 300; i++) if (R.ai.aiSpin(false, 1) === 'slice') slices++;
    ok(slices === 0, `a full chance is never sliced, got ${slices}/300`);
    const shot = R.ai.cpuShot({ x: 0, z: -HALF_L }, -1, 0, 0, 1, undefined, 1);
    ok(Math.abs(shot.clearance - CPU.CHANCE_CLEARANCE) < 1e-9 && CPU.CHANCE_CLEARANCE < R.config.PHYSICS.NET_CLEARANCE,
      `and clears the net by less than a rally ball, got ${shot.clearance}`);
    ok(R.ai.cpuShot({ x: 0, z: -HALF_L }, -1, 0, 0, 1).clearance === undefined,
      'a normal rally ball keeps the default net clearance');
  }

  // 実際の試合の流れ：溜めずに山なりの球を打ち返し続ける人間に、Extreme が強打で返す。
  // ユーザー報告「溜めずに打つ山なりの球を、まだ強打してこない（Extreme）」。上の
  // 1本だけ打たせるテストは通っていたのに、試合では AI が弾み際の膝の高さで捉えて
  // ネットを越すために飛翔時間が伸び、平均 89km/h のままだった。
  {
    applyCpuLevel('extreme');
    const input = { moveX: 0, moveZ: 0, lob: false };
    const g = new R.Game({ input, hooks: noHooks });
    g.start();
    const attacks = [];
    const smashes = [];
    const hitAs = g.hit.bind(g);
    g.hit = (who) => {
      const attack = who === 'cpu' ? g.chanceAttack(g.cpu) : 0;
      const y = g.ball.y;
      const dx = Math.abs(g.ball.x - g.cpu.x);
      const slowBall = g.ball.shotSpeed <= CPU.CHANCE_SPEED_SLOW;
      const r = hitAs(who);
      const plain = g.cpu.stroke === 'forehand' || g.cpu.stroke === 'backhand';
      const kmh = R.math.mpsToKmh(Math.hypot(g.ball.vx, g.ball.vz));
      // 球がこちらのベースラインに届くまでの時間（返せるかどうかの目安）
      const reach = R.physics.predictAtZ(g.ball, -HALF_L, undefined, 1);
      if (who === 'cpu' && plain && !g.cpu.special && attack > 0.75) attacks.push({ y, dx, kmh, t: reach ? reach.t : 0 });
      if (who === 'cpu' && g.cpu.stroke === 'smash' && !g.cpu.special && slowBall) smashes.push(kmh);
      return r;
    };
    for (let i = 0; i < 60 * 300; i++) {
      if (g.phase === 'serve' && g.servingPlayer() === 'you' && !g.tossActive && !g.serveSwing) g.chargeStart('flat');
      else if (g.phase === 'serve' && g.tossActive && g.you.charging && g.you.chargeTime > 0.45) g.chargeRelease();
      if (g.phase === 'rally' && g.ball.live && g.ball.last !== 'you') {
        // 着地点の少し後ろへ、足の速さの範囲で寄る。届くようになったら溜めずに打つ
        const land = R.physics.predictLanding(g.ball);
        const tz = R.math.clamp(land.z - 1.6, -HALF_L - 1.5, -2);
        const dx = land.x - g.you.x;
        const dz = tz - g.you.z;
        const k = Math.min(1, (PLAYER.SPEED / 60) / (Math.hypot(dx, dz) || 1));
        g.you.x += dx * k; g.you.z += dz * k;
        const c = g.predictContact();
        if (c && c.t < 0.03 && !g.you.charging && g.you.swing <= 0 && c.bounces > 0) tap(g);
      }
      g.update(1 / 60);
    }
    const avg = (f) => attacks.reduce((s, a) => s + f(a), 0) / attacks.length;
    ok(attacks.length >= 20, `the CPU gets plenty of chance balls, got ${attacks.length}`);
    ok(avg((a) => a.y) > 0.95, `it lets them rise before hitting, contact ${avg((a) => a.y).toFixed(2)}m`);
    ok(avg((a) => a.kmh) > 100, `and hits them hard, ${avg((a) => a.kmh).toFixed(0)} km/h`);
    // 強すぎても返せない：以前は 144km/h・0.52秒でこちらのベースラインに届き、反応して
    // 全速で走っても 3% しか届かなかった（ユーザー報告「強打が強すぎて全く返せない」）
    ok(avg((a) => a.kmh) < 125 && avg((a) => a.t) > 0.6,
      `but stays returnable: ${avg((a) => a.kmh).toFixed(0)} km/h, reaching your baseline in ${avg((a) => a.t).toFixed(2)}s`);
    // 球は体の真正面ではなく横を通る（ユーザー報告「CPU はボールが自分の身体の真正面に
    // くるように移動して打っている」。以前の平均は 0.08m）
    ok(avg((a) => a.dx) > 0.5, `and meets them beside the body, not in front of it: |dx| ${avg((a) => a.dx).toFixed(2)}m`);
    // 山なりの球は、バウンド前にスマッシュで叩かれることも多い。前へ走り込んで叩く
    // スマッシュが「走らされた」扱いで当てるだけ（55〜65km/h）になっていた（平均 92km/h）
    const smashKmh = smashes.reduce((a, b) => a + b, 0) / smashes.length;
    ok(smashes.length >= 5 && smashKmh > 85,
      `the CPU's smashes on loopy balls are hard too: ${smashKmh.toFixed(0)} km/h over ${smashes.length}`);
  }
  applyCpuLevel('normal');
}

// --- 強打のコース：相手のいる位置から離れたところへ（真ん中に戻った相手の正面に来ない） ---
// ユーザー報告「強打してくるが、ほとんどプレイヤー正面の真ん中に打ってくるので返すのに
// 苦労しない」。狙いを真ん中寄りの決まった位置にしていたため、打った後に真ん中へ戻る
// 相手には、ほぼ正面（平均 1.3m）に来ていた。
{
  const { CPU, applyCpuLevel } = R.config;
  applyCpuLevel('extreme');
  // 狙いそのものを見たいので、わざと外す1本（scatterOut）は止める
  Object.assign(CPU, { OUT_LONG: 0, OUT_WIDE: 0, STRETCH_OUT_LONG: 0, STRETCH_OUT_WIDE: 0 });
  const xs = (opponent, n = 300) => Array.from({ length: n },
    () => R.ai.cpuShot(opponent, -1, 0, 0, 1, undefined, 1).target.x);
  const centre = xs({ x: 0, z: -HALF_L, runX: 0 });
  ok(centre.every((x) => Math.abs(x) >= CPU.CHANCE_MOVE_MIN - 1e-9 && Math.abs(x) <= CPU.CHANCE_AIM_X_LIMIT + 1e-9),
    `a centred opponent never gets the attack at their body: |x| ${Math.min(...centre.map(Math.abs)).toFixed(2)}〜${Math.max(...centre.map(Math.abs)).toFixed(2)}`);
  ok(centre.some((x) => x > 0) && centre.some((x) => x < 0), 'and it goes to either side');
  const wide = xs({ x: 2.5, z: -HALF_L, runX: 0 });
  ok(wide.every((x) => x <= 2.5 - CPU.CHANCE_MOVE_MIN + 1e-9),
    `an opponent pulled wide gets it into the open court, max x=${Math.max(...wide).toFixed(2)}`);
  // 打った後に真ん中へ戻っている相手には、ときどき背中側（戻ってきた側）へ打つ
  const recovering = xs({ x: -0.6, z: -HALF_L, runX: 2 }, 600);
  const behind = recovering.filter((x) => x < -0.6).length / recovering.length;
  ok(behind > CPU.CHANCE_WRONG_FOOT * 0.6 && behind < CPU.CHANCE_WRONG_FOOT * 1.4,
    `a recovering opponent is sometimes wrong-footed: ${(behind * 100).toFixed(0)}% behind them`);
  applyCpuLevel('normal');
}

// --- 強打の演出：AI がチャンスボールを叩いた1本は、人間のフル溜めと同じく閃光・打球音・
// 振り抜きが大きい（AI には溜めが無く、以前は常に0＝速くなっても見た目も音もつなぎの球だった） ---
{
  const { CPU, applyCpuLevel } = R.config;
  applyCpuLevel('extreme');
  const hitWith = (shotSpeed) => {
    const sounds = [];
    const g = new R.Game({ input: fakeInput, hooks: { ...noHooks, sound: (...a) => sounds.push(a) } });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.cpu.x = 0; g.cpu.z = HALF_L - 1;
    g.cpu.settleT = CPU.CHANCE_SETTLE_T;
    Object.assign(g.ball, {
      x: 0.8, y: 1.1, z: HALF_L - 1.6, vx: 0, vy: -0.2, vz: 3, bounces: 1, live: true, last: 'you',
      spin: 'flat', wind: 0, windZ: 0, curve: 0, shotSpeed,
    });
    const attack = g.chanceAttack(g.cpu);
    g.updatePrep();
    const takeback = g.cpu.chargeFrac;
    g.hit('cpu');
    return { g, attack, takeback, hitSound: sounds.find((s) => s[0] === 'hit') };
  };
  const chance = hitWith(CPU.CHANCE_SPEED_SLOW);
  ok(chance.attack === 1, `precondition: a full chance, got ${chance.attack}`);
  ok(chance.takeback === 1, `the CPU winds up deep while it waits for a chance ball, got ${chance.takeback}`);
  ok(chance.g.ball.impactPower === 1 && chance.g.cpu.swingCharge === 1,
    `the flash and the follow-through are full power, got ${chance.g.ball.impactPower}/${chance.g.cpu.swingCharge}`);
  ok(chance.hitSound && chance.hitSound[3] === 1, `and so is the hit sound, got ${chance.hitSound && chance.hitSound[3]}`);
  const rally = hitWith(CPU.CHANCE_SPEED_FAST);
  ok(rally.takeback === 0 && rally.g.ball.impactPower === 0 && rally.g.cpu.swingCharge === 0
    && rally.hitSound[3] === 0, 'a normal rally ball stays a normal-looking shot');
  applyCpuLevel('normal');
}

// --- スマッシュ：前へ走り込んで叩く1本は、下がりながら打つ1本より強い（追い込まれていない） ---
{
  const { CPU, applyCpuLevel } = R.config;
  applyCpuLevel('extreme');
  const smashAfter = (runFwd) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.cpu.x = 0; g.cpu.z = 3;
    Object.assign(g.cpu, { chaseDist: CPU.STRETCH_DIST_MAX, settleT: 0, runFwd });
    Object.assign(g.ball, {
      x: 0.3, y: CPU.SMASH_MIN_Y + 0.2, z: 3, vx: 0, vy: CPU.SMASH_FALLING_VY - 1, vz: -1,
      bounces: 0, live: true, last: 'you', spin: 'flat', wind: 0, windZ: 0, curve: 0, shotSpeed: 15,
    });
    g.hit('cpu');
    return { g, landing: R.physics.predictLanding(g.ball) };
  };
  const forward = smashAfter(5);
  ok(forward.g.cpu.stroke === 'smash', `precondition: a smash, got ${forward.g.cpu.stroke}`);
  const back = smashAfter(-5);
  ok(forward.landing.t < back.landing.t - 0.1,
    `a smash after running forward flies faster than one after backpedalling: ${forward.landing.t.toFixed(2)}s vs ${back.landing.t.toFixed(2)}s`);
  ok(forward.g.ball.impactPower > back.g.ball.impactPower,
    `and comes with a bigger flash, got ${forward.g.ball.impactPower} vs ${back.g.ball.impactPower}`);
  // ただし全部は打ち消さない：全部打ち消すと 0.35秒で届く 150km/h 超になり、返せなかった
  ok(CPU.SMASH_FORWARD_RELIEF < 1 && forward.landing.t > CPU.SMASH_T + 0.05,
    `a forward smash is not the fastest possible one, ${forward.landing.t.toFixed(2)}s vs SMASH_T ${CPU.SMASH_T}`);
  applyCpuLevel('normal');
}

// --- 位置取り：CPU/AI は球の通り道の真上ではなく、球が体の横を通る位置に立つ ---
{
  const { CPU } = R.config;
  const { solveShot, predictAtZ } = R.physics;
  const from = { x: 0, y: 1.0, z: -HALF_L };
  const v = solveShot(from, { x: 1.0, y: R.config.PHYSICS.BALL_R, z: 7 }, 1.3, undefined, 'flat');
  const ball = { ...from, px: from.x, py: from.y, pz: from.z, ...v, spin: 'flat', wind: 0, windZ: 0, bounces: 0, age: 0 };
  const onPath = R.ai.chasePosition(ball, 1);
  const pathX = predictAtZ(ball, onPath.z, undefined, 1).x;
  // 通り道のすぐそばにいれば、フォアハンド側（cpu は world の +x がラケット側）に球を通す
  const near = R.ai.chasePosition(ball, 1, { x: pathX, z: onPath.z + 3, attr: { reach: 1 } });
  ok(Math.abs(near.x - (pathX - CPU.HIT_SIDE_X)) < 0.05,
    `the CPU stands so the ball passes its forehand side: want x=${(pathX - CPU.HIT_SIDE_X).toFixed(2)}, got ${near.x.toFixed(2)}`);
  // バック側にずっと近ければ、回り込まずにバックで打つ
  const far = R.ai.chasePosition(ball, 1, { x: pathX + 3, z: onPath.z + 3, attr: { reach: 1 } });
  ok(Math.abs(far.x - (pathX + CPU.HIT_SIDE_X)) < 0.05,
    `but takes it on the backhand when that side is much closer: want x=${(pathX + CPU.HIT_SIDE_X).toFixed(2)}, got ${far.x.toFixed(2)}`);
  // サーブリターンは通り道の上で待つ（速いサーブに横へ動き出すと、正面のサーブを返せなくなる）
  const ret = R.ai.chasePosition(ball, 1, { x: pathX, z: onPath.z + 3, attr: { reach: 1 } }, undefined, false);
  ok(Math.abs(ret.x - pathX) < 0.05, `a serve return still waits on the ball's path, got ${ret.x.toFixed(2)} vs ${pathX.toFixed(2)}`);
  ok(CPU.HIT_SIDE_X < 1.32, 'the side step stays well inside the shortest CPU reach (Easy)');
}

// --- CPU/AI の追跡目標は必ずボールの弾道の上に乗る（深さを手前に寄せたら横位置も取り直す） ---
{
  const CPU = R.config.CPU;
  const { solveShot, predictApex, predictAtZ, integrate, reflectBounce } = R.physics;
  const { BALL_R, STEP } = R.config.PHYSICS;
  // フル溜めのフラットサーブ相当。バウンド後も水平40m/s近くで飛ぶので、打点（頂点）は
  // ベースラインの遥か後方＝CPUがどう頑張っても立てない場所になる。
  const from = { x: -SERVE.STANCE_X, y: SERVE.CONTACT_Y, z: -HALF_L };
  const v = solveShot(from, { x: 2.0, y: BALL_R, z: COURT.SERVICE - 1.4 }, SERVE.CHARGE_T, SERVE.CLEARANCE, 'flat');
  const ball = { ...from, px: from.x, py: from.y, pz: from.z, ...v, spin: 'flat', wind: 0, bounces: 0 };
  for (let t = 0; t < 3; t += STEP) { // バウンドの直後まで進める
    integrate(ball, STEP);
    if (ball.y <= BALL_R && ball.vy < 0) { reflectBounce(ball); ball.bounces = 1; break; }
  }
  ok(ball.bounces === 1 && ball.vy > 0, 'precondition: the ball has just bounced and is rising');

  const apex = predictApex(ball);
  const target = R.ai.chasePosition(ball, 1);
  ok(target.z < apex.z,
    `precondition: the apex is too far ahead to chase, so the target depth is pulled in (${target.z} < ${apex.z})`);

  // 目標が本当に弾道の上にあるか（＝その深さを通過する瞬間のボールの x と一致するか）
  const at = predictAtZ(ball, target.z, undefined, 1);
  ok(!!at, 'the ball does cross the target depth');
  ok(at && Math.abs(target.x - at.x) < 0.01,
    `the chase target sits on the ball's actual path: want x=${at && at.x}, got ${target.x}`);
  // x と z を別々にクランプしていた頃は頂点の x をそのまま使っていた＝弾道上にない点だった
  ok(Math.abs(apex.x - target.x) > 0.3,
    `and that is meaningfully different from the old per-axis clamp (apex x=${apex.x}), ${Math.abs(apex.x - target.x).toFixed(2)}m apart`);
}

// --- ラリーの溜め：走っている間は溜まらず、既に溜めた分も抜けていく ---
{
  const CHARGE = R.config.CHARGE;
  const charging = () => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    Object.assign(g.you, { charging: true, chargeTime: 0, speed: 0 });
    return g;
  };
  const hold = (g, seconds, speed) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      g.you.speed = speed;
      g.tickCharge(1 / 60);
    }
    return g.chargeMeter();
  };

  ok(charging().you && true, 'setup');
  // 足を止めていればこれまで通りフル溜めできる
  ok(hold(charging(), CHARGE.MAX_TIME + 0.2, 0) === 1, 'standing still still reaches a full charge');
  // 全力で走っている間はまったく溜まらない
  ok(hold(charging(), 2, PLAYER.SPEED) === 0, 'sprinting builds no charge at all');
  // 歩く程度なら途中まで溜まる（0 でも満タンでもない）
  const jog = hold(charging(), 2, PLAYER.SPEED / 2);
  ok(jog > 0 && jog < 1, `jogging caps the charge partway, got ${jog}`);

  // 止まって溜め切ってから走り出すと、溜めた分が抜けていく（＝フル溜めを持ち運べない）
  const g = charging();
  ok(hold(g, CHARGE.MAX_TIME + 0.2, 0) === 1, 'precondition: fully charged while stationary');
  const afterStep = hold(g, 0.2, PLAYER.SPEED);
  ok(afterStep > 0 && afterStep < 1, `one step bleeds some charge but not all of it, got ${afterStep}`);
  ok(hold(g, 1, PLAYER.SPEED) === 0, 'running any distance drains the charge completely');
  // 抜ける速さは溜まる速さより速い（走りながら溜め直せない）
  ok(CHARGE.MOVE_DECAY > 1, `the drain outruns the build rate, got ${CHARGE.MOVE_DECAY}`);

  // 走るのをやめれば溜め直せる
  ok(hold(g, CHARGE.MAX_TIME + 0.2, 0) === 1, 'stopping lets the charge build again');
}

// --- スタミナ：長いラリーで消耗し、移動速度と溜め速度が落ちる。ポイント間で回復する ---
{
  const { STAMINA } = R.config;

  // 走った距離ぶんスタミナが減り、その分だけ最高速度が落ちる（効き幅は控えめに）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    ok(g.you.stamina === 1 && g.cpu.stamina === 1, 'precondition: stamina starts full for everyone');

    // 20本ぶんのラリー、1本あたり平均3m走ったとみなす（CPU.STRETCH_DIST_MAX=6.5mが
    // 「ぎりぎり」の目安なので、平均的なラリーはそれより手前という想定）
    const METERS_PER_SHOT = 3;
    for (let i = 0; i < 20; i++) g.drainStamina(g.you, METERS_PER_SHOT);
    const staminaAfter20 = g.you.stamina;
    const speedMultAfter20 = g.staminaSpeedMult(staminaAfter20);
    const dropPct = (1 - speedMultAfter20) * 100;
    ok(staminaAfter20 < 1 && staminaAfter20 > 0, `20 shots of a grueling rally drain some stamina, got ${staminaAfter20}`);
    // 実測：20本(合計60m)走った直後の速度低下率。控えめ（10%未満）だが0でもない。
    ok(dropPct < 10, `after 20 shots (~${METERS_PER_SHOT * 20}m) speed drops by less than 10%, got ${dropPct.toFixed(1)}%`);
    ok(dropPct > 1, `but the drain is still noticeable, not a no-op, got ${dropPct.toFixed(1)}%`);
  }

  // スタミナが尽きても移動速度は STAMINA.SPEED_FLOOR までしか落ちない（操作不能にはならない）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    ok(Math.abs(g.staminaSpeedMult(0) - STAMINA.SPEED_FLOOR) < 1e-9,
      `fully drained stamina floors the speed multiplier at SPEED_FLOOR, got ${g.staminaSpeedMult(0)}`);
    ok(STAMINA.SPEED_FLOOR > 0.7, `the floor keeps movement clearly usable, got ${STAMINA.SPEED_FLOOR}`);
  }

  // 実際に movePlayers()/moveTowards() を通しても効く。人間・CPU/AI 両方に同じルール
  {
    const input = { moveX: 0, moveZ: 1, lob: false };
    const g = new R.Game({ input, hooks: noHooks });
    g.start();
    g.serve('you'); // rally phase にしてフットフォルト制限の狭い可動域を外す
    g.you.x = 0; g.you.z = -5; g.you.vx = 0; g.you.vz = 0;
    g.you.stamina = 0; // 尽きた状態から
    for (let i = 0; i < 60; i++) g.movePlayers(1 / 60); // 加速しきるのに十分な時間
    const cruiseSpeed = Math.hypot(g.you.vx, g.you.vz);
    ok(Math.abs(cruiseSpeed - PLAYER.SPEED * STAMINA.SPEED_FLOOR) < 0.1,
      `a fully drained human cruises at SPEED_FLOOR of PLAYER.SPEED, got ${cruiseSpeed}`);

    const g2 = new R.Game({ input: fakeInput, hooks: noHooks });
    Object.assign(g2.cpu, { x: 0, z: 0, stamina: 0 });
    g2.moveTowards(g2.cpu, { x: 0, z: 0 }, { x: 100, z: 0 }, PLAYER.CPU_CHASE, 1 / 60);
    ok(Math.abs(g2.cpu.speed - PLAYER.CPU_CHASE * STAMINA.SPEED_FLOOR) < 1e-9,
      `a fully drained CPU is capped at SPEED_FLOOR of CPU_CHASE too (the same rule as the human), got ${g2.cpu.speed}`);
  }

  // 溜め（人間のみ、CPU/AIには溜めの概念自体が無い）：スタミナが尽きているとフル溜めしても
  // CHARGE.MAX_TIME いっぱいまでは溜まらず、STAMINA.CHARGE_FLOOR までで頭打ちになる
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.you.stamina = 0;
    Object.assign(g.you, { charging: true, chargeTime: 0, speed: 0 });
    for (let i = 0; i < 60; i++) g.tickCharge(1 / 60); // 1秒、MAX_TIMEより長く保持
    ok(Math.abs(g.you.chargeTime - R.config.CHARGE.MAX_TIME * STAMINA.CHARGE_FLOOR) < 1e-9,
      `fully drained stamina caps the charge at CHARGE_FLOOR of MAX_TIME, got ${g.you.chargeTime}`);
  }

  // ポイント間で回復する（人間・CPU/AI とも同じ量。満タンを超えては増えない）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.you.stamina = 0.3;
    g.cpu.stamina = 0.3;
    g.newPoint();
    const expected = Math.min(1, 0.3 + STAMINA.RECOVER_PER_POINT);
    ok(Math.abs(g.you.stamina - expected) < 1e-9, `stamina recovers by RECOVER_PER_POINT between points, got ${g.you.stamina}`);
    ok(g.cpu.stamina === g.you.stamina, 'the same recovery rule applies to CPU/AI too');

    g.you.stamina = 0.9; // 満タンに近い状態からはそれ以上増えずキャップされる
    g.newPoint();
    ok(g.you.stamina === 1, `recovery is capped at full, got ${g.you.stamina}`);
  }
}

// --- サーブのコース：3コースが隣り合ってサービスボックスの幅を切れ目なく覆う ---
{
  ok(SERVE.AIM_T_MAX >= SERVE.AIM_BODY_MIN,
    `T and body touch, no dead zone between them (${SERVE.AIM_T_MAX} vs ${SERVE.AIM_BODY_MIN})`);
  ok(SERVE.AIM_BODY_MAX >= SERVE.AIM_WIDE_MIN,
    `body and wide touch (${SERVE.AIM_BODY_MAX} vs ${SERVE.AIM_WIDE_MIN})`);
  ok(SERVE.AIM_WIDE_MAX < HALF_W - R.config.PHYSICS.BALL_R,
    `the widest aim still leaves room inside the sideline, got ${SERVE.AIM_WIDE_MAX}`);

  // 実際に3コースを打ち分けたとき、着地がボックスの幅を満遍なく覆うこと
  const g = new R.Game({ input: { moveX: 0, moveZ: 0, lob: false }, hooks: noHooks });
  g.start();
  const BINS = 8;
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    g.input.moveX = [0, 1, -1][i % 3];
    const targetSign = i % 2 === 0 ? 1 : -1;
    const x = g.serveAimMagnitude(targetSign);
    ok(x >= 0 && x <= SERVE.AIM_WIDE_MAX, `aim stays inside the box, got ${x}`);
    seen.add(Math.min(BINS - 1, Math.floor(x / (HALF_W / BINS))));
  }
  ok(seen.size === BINS,
    `all ${BINS} slices of the box's width get served to, got ${seen.size} (${[...seen].sort().join(',')})`);
}

// --- サーブの深さ：トス中の ↑↓ で深い／浅いを選べる（無入力なら全域） ---
{
  const input = { moveX: 0, moveZ: 0, lob: false };
  const g = new R.Game({ input, hooks: noHooks });
  g.start();
  const sample = (mz) => {
    input.moveZ = mz;
    const out = [];
    for (let i = 0; i < 200; i++) out.push(g.serveDepth());
    return { min: Math.min(...out), max: Math.max(...out) };
  };
  const deep = sample(1);
  const shallow = sample(-1);
  g.you.swingCharge = 0; // 無入力の範囲は溜め量で変わる（下記）
  const any = sample(0);
  ok(deep.max <= SERVE.DEPTH_DEEP_MAX, `↑ keeps the serve deep, got max ${deep.max}`);
  ok(shallow.min >= SERVE.DEPTH_SHORT_MIN, `↓ keeps the serve short, got min ${shallow.min}`);
  ok(deep.max < shallow.min, 'the deep and short bands do not overlap');
  ok(any.min < deep.max && any.max > shallow.min, 'a soft serve with no input uses the whole depth range');

  // 無入力のときの「浅さの上限」は威力で変わる。全力で打つほど深い側へ寄る：浅い狙いへ
  // 速い球を通す軌道は幾何的に存在せず、引いてしまうと溜めが完璧でも山なりの遅い球になる。
  g.you.swingCharge = 1;
  const full = sample(0);
  ok(full.max <= SERVE.DEPTH_FULL_MAX,
    `a full-power serve with no input only picks depths it can actually hit hard, got max ${full.max}`);
  ok(full.max < any.max, 'and that is a narrower band than a soft serve uses');
  // どの深さもサービスボックスの中（ネットとサービスラインの間）に収まる
  ok(SERVE.DEPTH_MAX < COURT.SERVICE, `even the shortest serve clears the net side, got ${SERVE.DEPTH_MAX}`);
}

// --- ドロップショット：溜めずに離したスライスはネット際に落ちて、そこで死ぬ ---
{
  const DROP = R.config.DROP;
  const { predictLanding, integrate, reflectBounce, netHeightAt } = R.physics;
  const { BALL_R, STEP } = R.config.PHYSICS;

  // ドロップはネットぎりぎり（DROP.CLEARANCE=0.12、ボール半径0.11との差はわずか1cm）を
  // 狙う球なので、狙う左右位置・深さ・風がぶれると実際にネットに掛かることがある
  // （サイドへ大きく角度をつけた浅いドロップは、ネットの高い側＝ポスト寄りを越える必要が
  //  あるぶんリスクが高い＝仕様どおり）。ここで見たいのは「弾道と球質」なので、風を無風に
  // 固定し、狙いのランダム要素も Math.random を固定して毎回同じ1本にする。
  const shoot = (spin, charge, fromZ, roll = 0.5) => {
    const origRandom = Math.random;
    Math.random = () => roll;
    try {
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.start();
      g.phase = 'rally';
      g.serveInFlight = false;
      g.you.x = 0; g.you.z = fromZ;
      g.wind = 0; // hit() が ball.wind に入れ直すので、ボール側だけ0にしても効かない
      Object.assign(g.ball, { x: 0, y: 0.8, z: fromZ, live: true, bounces: 1, last: 'cpu', wind: 0 });
      g.you.chargeSpin = spin;
      g.you.swingCharge = charge;
      g.you.chargeStroke = 'forehand';
      g.hit('you');
      return g.ball;
    } finally {
      Math.random = origRandom;
    }
  };
  // 1バウンド目と2バウンド目の位置（＝どこまで転がるか）
  const bounces = (ball) => {
    const s = { ...ball, px: ball.x, py: ball.y, pz: ball.z };
    const out = [];
    for (let t = 0; t < 6 && out.length < 2; t += STEP) {
      integrate(s, STEP);
      if (s.y <= BALL_R && s.vy < 0) { reflectBounce(s); out.push(s.z); }
    }
    return out;
  };

  const drop = shoot('slice', 0, -HALF_L);            // 溜めなしのスライス
  ok(drop.spin === 'drop', `an uncharged slice becomes a drop shot, got spin=${drop.spin}`);
  const dropLand = predictLanding({ ...drop, px: drop.x, py: drop.y, pz: drop.z });
  ok(dropLand.z >= DROP.Z_MIN - 0.2 && dropLand.z <= DROP.Z_MAX + 0.2,
    `the drop lands right behind the net, got z=${dropLand.z}`);
  ok(dropLand.z > 0, 'and it still clears the net (lands on the far side)');

  // 溜めたスライスは従来どおりの深いスライス
  const slice = shoot('slice', 1, -HALF_L);
  ok(slice.spin === 'slice', `a charged slice stays a normal slice, got spin=${slice.spin}`);
  const sliceLand = predictLanding({ ...slice, px: slice.x, py: slice.y, pz: slice.z });
  ok(sliceLand.z > dropLand.z + 5,
    `the charged slice lands far deeper than the drop, got ${sliceLand.z} vs ${dropLand.z}`);
  // 溜めなしでもフラット/トップならドロップにはならない
  ok(shoot('flat', 0, -HALF_L).spin === 'flat', 'an uncharged flat shot is not a drop');
  ok(shoot('top', 0, -HALF_L).spin === 'top', 'an uncharged topspin shot is not a drop');

  // ドロップはバウンドしてから死ぬ（2バウンド目までの距離が通常のスライスよりずっと短い）
  const dropRun = bounces(drop);
  const sliceRun = bounces(slice);
  ok(dropRun.length === 2 && sliceRun.length === 2, 'both shots bounce twice within the sim window');
  const dropSpan = dropRun[1] - dropRun[0];
  const sliceSpan = sliceRun[1] - sliceRun[0];
  ok(dropSpan < sliceSpan / 2,
    `the drop dies after the bounce: ${dropSpan.toFixed(2)}m vs the slice's ${sliceSpan.toFixed(2)}m`);
  ok(dropRun[1] < COURT.SERVICE,
    `the drop's second bounce is still inside the service box, got z=${dropRun[1]}`);

  // 読み負け：抽選（CPU.DROP_MISREAD_CHANCE）に当たった1本だけ、相手の出足が DROP.MISREAD_T 遅れる
  const { CPU } = R.config;
  ok(drop.reactBonus === 0,
    `a drop the CPU reads (roll 0.5 > ${CPU.DROP_MISREAD_CHANCE}) carries no extra delay, got ${drop.reactBonus}`);
  const misread = shoot('slice', 0, -HALF_L, 0);
  ok(misread.spin === 'drop' && misread.reactBonus === DROP.MISREAD_T,
    `a misread drop delays the CPU by DROP.MISREAD_T, got ${misread.reactBonus}`);
  ok(shoot('slice', 1, -HALF_L, 0).reactBonus === 0, 'a charged slice is never "misread" (it is not a drop)');
  {
    // ガイド表示（プレビュー）は毎フレーム呼ばれるので、抽選を引かない（乱数を消費しない）
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.you.chargeSpin = 'slice';
    g.you.swingCharge = 0;
    const origRandom = Math.random;
    let draws = 0;
    Math.random = () => { draws++; return 0; };
    try {
      const shot = g.playerShot('forehand', undefined, true);
      ok(shot.spin === 'drop' && shot.reactBonus === 0 && draws === 0,
        `the guide preview never rolls the misread, got bonus=${shot.reactBonus} draws=${draws}`);
    } finally {
      Math.random = origRandom;
    }
  }
}

// --- ドロップは「たまに決まる」：定位置の CPU に対して、決まる割合が難易度と場面でなだらかに変わる ---
{
  const { CPU, applyCpuLevel } = R.config;
  // ベースライン（または z=fromZ）から、定位置付近の CPU へ溜めなしのスライス（＝ドロップ）を
  // N 本打ち、CPU が触れずに2バウンドした（＝ウィナー）割合を返す。
  const winnerRate = (level, fromZ, N = 300) => {
    applyCpuLevel(level);
    let winners = 0;
    for (let i = 0; i < N; i++) {
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.start();
      g.phase = 'rally';
      g.serveInFlight = false;
      const x = (Math.random() * 2 - 1) * 3;
      g.you.x = x; g.you.z = fromZ;
      g.cpu.x = (Math.random() * 2 - 1) * 2.5;
      g.cpu.z = CPU.HOME_Z + (Math.random() - 0.5);
      g.recoverTimers.cpu = 0;
      Object.assign(g.ball, { x: x + 0.6, y: 0.8, z: fromZ, live: true, bounces: 1, last: 'cpu' });
      g.lastBallOwnerSeen = 'cpu';
      g.you.chargeSpin = 'slice';
      g.you.swingCharge = 0;
      g.you.chargeStroke = 'forehand';
      g.hit('you');
      let result = null;
      g.endPoint = (winner, reason) => { result = { winner, reason }; };
      for (let f = 0; f < 60 * 4 && !result && g.ball.last === 'you'; f++) g.update(1 / 60);
      if (result && result.winner === 'you' && result.reason === 'ツーバウンド') winners++;
    }
    return winners / N;
  };
  try {
    const normalBase = winnerRate('normal', -HALF_L + 0.5);
    const normalIn = winnerRate('normal', -5);
    const hardBase = winnerRate('hard', -HALF_L + 0.5);
    // 以前は normal 5% / hard 0%（CPU が打たれた瞬間に走り出して必ず間に合う）だった。
    ok(normalBase > 0.1 && normalBase < 0.35,
      `on normal, a drop from the baseline wins now and then (not never, not always), got ${(normalBase * 100).toFixed(1)}%`);
    ok(normalIn > normalBase + 0.05 && normalIn < 0.6,
      `from inside the court it works more often, but is still no sure thing, got ${(normalIn * 100).toFixed(1)}%`);
    ok(hardBase > 0.02 && hardBase < normalBase,
      `hard reads drops better than normal but can still be caught, got ${(hardBase * 100).toFixed(1)}%`);
  } finally {
    applyCpuLevel('normal');
  }
}

// --- CPU/AI：ネット際でノーバウンドに捕まえた球はボレーになり、高い打点ほど鋭く決めにいく ---
{
  const { CPU } = R.config;
  const { cpuVolleyShot } = R.ai;
  const opponent = { x: 2.0, z: -HALF_L };

  // 打点の高さと余裕（stretch）で鋭さが決まる：高くて余裕があるほど短く・角度がつき・速い
  {
    const origRandom = Math.random;
    Math.random = () => 0.5;
    try {
      const high = cpuVolleyShot(opponent, -1, 0, CPU.VOLLEY_HIGH_Y);
      const low = cpuVolleyShot(opponent, -1, 0, CPU.VOLLEY_LOW_Y);
      const stretched = cpuVolleyShot(opponent, -1, 1, CPU.VOLLEY_HIGH_Y);
      ok(Math.abs(high.target.z) < Math.abs(low.target.z),
        `a high volley is put away shorter than a low one: ${high.target.z} vs ${low.target.z}`);
      ok(Math.abs(high.target.x) > Math.abs(low.target.x),
        `a high volley is angled wider: ${high.target.x} vs ${low.target.x}`);
      ok(high.flight < low.flight,
        `a high volley is faster (shorter flight): ${high.flight} vs ${low.flight}`);
      ok(high.flight < CPU.SHOT_T,
        `even so it is far faster than a plain groundstroke: ${high.flight} vs ${CPU.SHOT_T}`);
      ok(stretched.flight === low.flight,
        'a high ball reached on the stretch falls back to the same safe block as a low one');
      ok(Math.sign(high.target.x) === -Math.sign(opponent.x),
        'the volley goes to the open side (away from the opponent)');
      ok(Math.sign(high.target.z) === -1, 'the volley is hit into the opponent half (dir=-1)');
    } finally {
      Math.random = origRandom;
    }
  }

  // ネット際(PLAYER.VOLLEY_Z 以内)でノーバウンドの球を返した cpu は 'volley-*' になる
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.cpu.x = 0; g.cpu.z = PLAYER.VOLLEY_Z - 0.5;
    g.ball.x = 0.3; g.ball.y = 1.2; g.ball.z = g.cpu.z; g.ball.bounces = 0; g.ball.vy = 0;
    g.hit('cpu');
    ok(g.cpu.stroke === 'volley-forehand' || g.cpu.stroke === 'volley-backhand',
      `the cpu volleys a no-bounce ball at the net, got ${g.cpu.stroke}`);
  }

  // ベースライン側で1バウンドさせて返す球はこれまで通りのグラウンドストローク
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.cpu.x = 0; g.cpu.z = CPU.HOME_Z;
    g.ball.x = 0.3; g.ball.y = 1.2; g.ball.z = g.cpu.z; g.ball.bounces = 1; g.ball.vy = 0;
    g.hit('cpu');
    ok(g.cpu.stroke === 'forehand' || g.cpu.stroke === 'backhand',
      `a bounced baseline ball stays a plain groundstroke, got ${g.cpu.stroke}`);
  }
}

// --- CPU/AI：頭上へ落ちてくる高い球はスマッシュになる（人間の溜め条件にあたるものは無い） ---
{
  const { CPU } = R.config;
  const smashHit = (y, vy, z) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.serveInFlight = false;
    g.cpu.x = 0; g.cpu.z = z;
    Object.assign(g.ball, {
      x: 0.3, y, z, bounces: 0, vy, vx: 0, vz: -1,
    });
    g.hit('cpu');
    return g;
  };

  {
    const g = smashHit(CPU.SMASH_MIN_Y + 0.2, CPU.SMASH_FALLING_VY - 1, 3);
    ok(g.cpu.stroke === 'smash', `a high falling ball inside the court is a smash, got ${g.cpu.stroke}`);
    ok(g.lastShotBy.cpu === 'スマッシュ', `and it is called a smash, got ${g.lastShotBy.cpu}`);
  }
  // まだ上がっている（＝叩き下ろせない）球はスマッシュにしない
  {
    const g = smashHit(CPU.SMASH_MIN_Y + 0.2, 2, 3);
    ok(g.cpu.stroke !== 'smash', `a rising ball is not a smash, got ${g.cpu.stroke}`);
  }
  // 低い球もスマッシュにしない
  {
    const g = smashHit(CPU.SMASH_MIN_Y - 0.4, CPU.SMASH_FALLING_VY - 1, 3);
    ok(g.cpu.stroke !== 'smash', `a low ball is not a smash, got ${g.cpu.stroke}`);
  }
  // ベースラインのはるか後ろ（SMASH_Z_MAX の外）で高く弾んだ球もスマッシュにしない
  {
    const g = smashHit(CPU.SMASH_MIN_Y + 0.2, CPU.SMASH_FALLING_VY - 1, CPU.SMASH_Z_MAX + 1.5);
    ok(g.cpu.stroke !== 'smash', `a high ball taken from behind the baseline is not a smash, got ${g.cpu.stroke}`);
  }

  // スマッシュは通常のグラウンドストロークよりはっきり速い
  {
    const origRandom = Math.random;
    Math.random = () => 0.5;
    try {
      const opponent = { x: 1.5, z: -HALF_L };
      const smash = R.ai.cpuSmashShot(opponent, -1, 0);
      const drive = R.ai.cpuShot(opponent, -1, 0);
      ok(smash.flight < drive.flight,
        `the cpu smash flies faster than its groundstroke: ${smash.flight} vs ${drive.flight}`);
      ok(smash.flight < CPU.SMASH_STRETCH_T,
        'a comfortable smash is faster than a stretched one');
      ok(Math.abs(smash.target.z) >= CPU.SMASH_AIM_Z_MIN,
        `the smash is buried deep, got z=${smash.target.z}`);
    } finally {
      Math.random = origRandom;
    }
  }
}

// --- CPU/AI：ロブは待たずに空中で叩きにいく（smashApproach）。普通のドライブでは出ていかない ---
{
  const { CPU } = R.config;
  const { smashApproach } = R.ai;
  const { solveShot } = R.physics;
  const shoot = (target, flight) => {
    const from = { x: 0, y: 1.0, z: -HALF_L + 1 };
    return {
      ...from, ...solveShot(from, { x: target.x, y: R.config.PHYSICS.BALL_R, z: target.z }, flight),
      bounces: 0, age: 0, spin: 'flat', wind: 0,
    };
  };
  const atBaseline = { x: 0, z: CPU.HOME_Z };

  const lob = shoot({ x: 0, z: 9.5 }, R.config.SHOT.LOB_T);
  const spot = smashApproach(lob, atBaseline, 1);
  ok(spot !== null, 'the cpu goes out to meet a lob in the air');
  if (spot) {
    ok(spot.z >= CPU.SMASH_Z_MIN && spot.z <= CPU.SMASH_Z_MAX,
      `the interception point is inside the court, got z=${spot.z}`);
  }

  // 普通の（低い）ドライブは自陣で2m台を降りてくるが、高く上がっていないので対象外
  const drive = shoot({ x: 0, z: 9.0 }, CPU.SHOT_T);
  ok(smashApproach(drive, atBaseline, 1) === null,
    'a plain drive is not chased down as a smash');
  // 既にバウンドした球も対象外（ノーバウンドで叩くための先回りなので）
  ok(smashApproach({ ...lob, bounces: 1 }, atBaseline, 1) === null,
    'an already-bounced ball is not chased down as a smash');
  // 陣地は side で鏡映しになる（youMate は z<0 側で同じことをする）
  const mirrored = { ...lob, z: -lob.z, vz: -lob.vz };
  const mateSpot = smashApproach(mirrored, { x: 0, z: -CPU.HOME_Z }, -1);
  ok(mateSpot !== null && mateSpot.z < 0, 'the partner does the same on its own (z<0) half');
}

// --- CPU/AI：先回りの対象と「スマッシュ」の判定条件が食い違わない ---
// (退行テスト: 先回りの条件だけ「頂点3.0m以上＝完全なロブ」と厳しかった頃は、頂点が
//  2.3〜2.9m の浮いた球は先回りの対象外のまま走って追いかけ、走行中に打点の高さの条件
//  （CPU.SMASH_MIN_Y）だけ満たして「追い込まれたスマッシュ」＝最弱の一撃になっていた。
//  ダブルスの味方が下手なスマッシュしか打てない主因だった)
{
  const { CPU, DOUBLES, PHYSICS } = R.config;
  const { smashApproach } = R.ai;
  const { solveShot } = R.physics;
  const from = { x: 0, y: 1.0, z: -HALF_L + 1 };
  // ロブほど高くはないが、ネット際の選手の頭上を 2.6m まで浮いて越えてくる球
  const floater = {
    ...from,
    ...solveShot(from, { x: 0, y: PHYSICS.BALL_R, z: 8.0 }, 1.15),
    bounces: 0, age: 0, spin: 'flat', wind: 0,
  };
  const atNet = { x: 0, z: DOUBLES.NET_Z_CPU };
  const spot = smashApproach(floater, atNet, 1);
  ok(spot !== null, 'a floating high ball (not a full lob) is also met in the air');
  ok(CPU.SMASH_LOB_PEAK < CPU.SMASH_MIN_Y + 0.5,
    `the interception threshold stays close to the height that hit() calls a smash, got ${CPU.SMASH_LOB_PEAK} vs ${CPU.SMASH_MIN_Y}`);
}

// --- CPU/AI：落下点で待ってから叩いたスマッシュはフルパワー（走った距離では弱くならない） ---
// (退行テスト: 苦しさ(stretch)を「その球を追って走った距離」だけで測っていた頃は、
//  ロブに先回りして落下点で待っていた＝十分間に合っている場合でも、そこまで走った距離の
//  ぶんだけ最弱のスマッシュになっていた。ユーザー報告「ダブルスの味方のスマッシュが下手。
//  十分間に合っていても弱い」)
{
  const { CPU } = R.config;
  const smashSpeed = (settleT) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.phase = 'rally';
    g.cpu.x = 0; g.cpu.z = 4;
    g.cpu.chaseDist = CPU.STRETCH_DIST_MAX; // コートの端から端まで走ってきた
    g.cpu.settleT = settleT;
    Object.assign(g.ball, {
      x: 0.3, y: CPU.SMASH_MIN_Y + 0.25, z: 4, vx: 0, vy: -3, vz: -2, bounces: 0, last: 'you', age: 1,
    });
    g.hit('cpu');
    ok(g.cpu.stroke === 'smash', `precondition: it is a smash, got ${g.cpu.stroke}`);
    return Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz);
  };
  const origRandom = Math.random;
  Math.random = () => 0.5; // 狙いのばらつきが速さの差を上回らないように
  let running;
  let settled;
  try {
    running = smashSpeed(0);                     // 走りながら叩いた
    settled = smashSpeed(CPU.SMASH_SETTLE_T);    // 落下点で待ってから叩いた
  } finally {
    Math.random = origRandom;
  }
  ok(settled > running * 1.5,
    `a smash hit after settling under the ball is far stronger: settled=${settled.toFixed(1)} running=${running.toFixed(1)}`);
}

// --- CPU/AI：ネットへ詰めている間は、下がらずに前で迎え撃つ位置を返す（netRushPosition） ---
{
  const { CPU } = R.config;
  const { netRushPosition, chasePosition } = R.ai;
  const { solveShot } = R.physics;
  const shoot = (target, flight) => {
    const from = { x: 0, y: 1.0, z: -HALF_L + 1 };
    return {
      ...from, ...solveShot(from, { x: target.x, y: R.config.PHYSICS.BALL_R, z: target.z }, flight),
      bounces: 0, age: 0, spin: 'flat', wind: 0,
    };
  };

  // ネット際に立っている選手の少し横を通る低い球。その場から一歩寄れば前で迎え撃てる
  // （真正面すぎると canPoach() だけで足りてしまい、netRushPosition の出番にならない）。
  const drive = shoot({ x: 2.6, z: 8.0 }, CPU.SHOT_T);
  const atNet = { x: 0, z: CPU.NET_APPROACH_Z };
  const meet = netRushPosition(drive, 1, atNet);
  ok(meet !== null && meet.z <= CPU.NET_APPROACH_Z + 0.01,
    `a rushing cpu meets the ball at the net instead of retreating, got ${meet && meet.z}`);
  ok(chasePosition(drive, 1, atNet).z > CPU.NET_APPROACH_Z,
    'precondition: the normal chase would have sent it back toward the baseline');

  // 頭を越すロブは迎え撃てない（null＝通常の追い方に戻って下がる）
  const lob = shoot({ x: 0, z: 9.5 }, R.config.SHOT.LOB_T);
  ok(netRushPosition(lob, 1, atNet) === null, 'a lob over the head cannot be met at the net');
  // 既にバウンドした球も対象外
  ok(netRushPosition({ ...drive, bounces: 1 }, 1, atNet) === null,
    'an already-bounced ball is chased normally');
}

// --- ネットへ詰めている途中の cpu は、ネット際（VOLLEY_Z）より後ろで迎え撃った球もボレーで返す ---
// 以前は netRushPosition() が選んだ迎撃点（サービスライン付近）に立っていても、ノーバウンドで
// 打てるのは VOLLEY_Z 以内だけだったため、体の正面へ来た球を素通りさせていた（ユーザー報告）。
{
  const { CPU } = R.config;
  const { solveShot } = R.physics;
  /** 中盤(z=8)にいる cpu の正面へ、ベースラインからドライブを打ち込む。cpu が当てた瞬間を返す */
  const driveAtCpu = (netRush) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(false, 'cpu');
    g.phase = 'rally';
    g.serveInFlight = false;
    g.cpuNetRush = netRush;
    g.cpu.x = 0; g.cpu.z = 8;
    g.you.x = 0; g.you.z = -HALF_L + 0.5;
    const from = { x: 0, y: 1.0, z: -HALF_L + 1 };
    const v = solveShot(from, { x: -1, y: R.config.PHYSICS.BALL_R, z: 8 }, 0.9);
    Object.assign(g.ball, {
      ...from, px: from.x, py: from.y, pz: from.z, ...v, bounces: 0, age: 0, last: 'you', live: true,
      spin: 'flat', wind: 0, windZ: 0, curve: 0, shotSpeed: Math.hypot(v.vx, v.vz), reactBonus: 0,
    });
    g.lastBallOwnerSeen = 'cpu';
    let contact = null;
    const hit = g.hit.bind(g);
    g.hit = (who) => { contact = contact || { bounces: g.ball.bounces, z: g.cpu.z }; hit(who); };
    for (let i = 0; i < 60 * 4 && !contact && g.phase === 'rally'; i++) g.update(1 / 60);
    return { g, contact };
  };

  const rush = driveAtCpu(true);
  ok(!!rush.contact && rush.contact.bounces === 0,
    `a rushing cpu volleys the ball coming straight at it, got ${JSON.stringify(rush.contact)}`);
  ok(!!rush.contact && rush.contact.z > PLAYER.VOLLEY_Z,
    `precondition: it met the ball behind the usual volley zone, got z=${rush.contact && rush.contact.z.toFixed(2)}`);
  ok(/^volley-/.test(rush.g.cpu.stroke), `and it is a volley, got ${rush.g.cpu.stroke}`);

  // 詰めていない（ベースラインへ戻る普段の）cpu は、これまでどおり中盤ではノーバウンドで手を出さない
  const stay = driveAtCpu(false);
  ok(!stay.contact || stay.contact.bounces >= 1,
    `a cpu that is not rushing still lets the ball bounce first, got ${JSON.stringify(stay.contact)}`);

  // 迎撃点はノーバウンドで返してよい深さ（NET_RUSH_VOLLEY_Z）より後ろにはならない
  const deep = { x: 0, z: CPU.NET_RUSH_VOLLEY_Z + 1.5 };
  const lobbish = {
    x: 0, y: 1.0, z: -HALF_L + 1, bounces: 0, age: 0, spin: 'flat', wind: 0,
    ...solveShot({ x: 0, y: 1.0, z: -HALF_L + 1 }, { x: 0, y: R.config.PHYSICS.BALL_R, z: HALF_L + 3 }, 1.0),
  };
  const meet = R.ai.netRushPosition(lobbish, 1, deep);
  ok(!meet || meet.z <= CPU.NET_RUSH_VOLLEY_Z + 1e-9,
    `the rush intercept stays where a volley is allowed, got ${meet && meet.z.toFixed(2)}`);
}

// --- 選手ごとの能力値：既定（すべて3）ならどの倍率も 1.0＝これまでと完全に同じ挙動 ---
{
  const {
    SKILLS, ROSTER, ATTRS, NEUTRAL_ATTR, SKILL_MIN, SKILL_MAX, SKILL_DEFAULT,
    setRating, getRating, resetRatings, shotSkill,
  } = R.config;

  ok(SKILLS.length >= 7, `all requested skills exist: ${SKILLS.length}`);
  ['forehand', 'backhand', 'volley', 'smash', 'serve', 'stamina', 'speed']
    .forEach((key) => ok(SKILLS.some((s) => s.key === key), `skill "${key}" is configurable`));

  ROSTER.forEach((actor) => {
    Object.entries(ATTRS[actor.key]).forEach(([key, mult]) => {
      ok(mult === 1, `${actor.key}.${key} starts at exactly 1.0 (default = today's balance), got ${mult}`);
    });
    SKILLS.forEach((s) => ok(getRating(actor.key, s.key) === SKILL_DEFAULT,
      `${actor.key}.${s.key} defaults to ${SKILL_DEFAULT}`));
  });
  Object.values(NEUTRAL_ATTR).forEach((mult) => ok(mult === 1, 'the neutral set is all 1.0 too'));

  // 上げ下げの向き：高い能力＝速く走り、球も速く（飛翔時間は短く）、バテにくい
  setRating('cpu', 'speed', SKILL_MAX);
  setRating('cpu', 'stamina', SKILL_MIN);
  setRating('cpu', 'forehand', SKILL_MAX);
  setRating('cpu', 'consistency', SKILL_MAX);
  ok(ATTRS.cpu.speed > 1, `speed 5 -> faster, got ${ATTRS.cpu.speed}`);
  ok(ATTRS.cpu.drain > 1, `stamina 1 -> drains faster, got ${ATTRS.cpu.drain}`);
  ok(ATTRS.cpu.recover < 1, `stamina 1 -> recovers less, got ${ATTRS.cpu.recover}`);
  ok(ATTRS.cpu.forehand < 1, `forehand 5 -> shorter flight (faster ball), got ${ATTRS.cpu.forehand}`);
  ok(ATTRS.cpu.backhand === 1, 'the other wing is untouched');
  ok(ATTRS.cpu.out < 1, `consistency 5 -> fewer deliberate misses, got ${ATTRS.cpu.out}`);
  // 範囲外は丸められる
  setRating('cpu', 'speed', 99);
  ok(getRating('cpu', 'speed') === SKILL_MAX, 'ratings are clamped to the 1..5 range');

  // ai.js へ渡す形（打ち方に対応する能力＋安定感）
  const skill = shotSkill(ATTRS.cpu, 'forehand');
  ok(skill.power === ATTRS.cpu.forehand && skill.out === ATTRS.cpu.out && skill.sharp === ATTRS.cpu.volleySharp,
    'shotSkill folds the right three multipliers for that stroke');

  resetRatings();
  ROSTER.forEach((actor) => Object.entries(ATTRS[actor.key]).forEach(([, mult]) => {
    ok(mult === 1, 'resetRatings() puts every multiplier back to 1.0');
  }));
}

// --- 選べる選手（スタート画面の「選手」）：個性はあっても強さは同じ（最強の選手だけは別格）、
//     既定は従来どおり ---
{
  const {
    CHARACTERS, CHARACTER_BUDGET, CHARACTER_DEFAULT, SKILLS, ROSTER, ATTRS, THEME,
    SKILL_MIN, SKILL_MAX, SKILL_DEFAULT, applyCharacter, getRating, resetRatings,
  } = R.config;
  const core = SKILLS.filter((s) => !s.aiOnly);
  const STYLES = ['short', 'buzz', 'ponytail', 'cap', 'curly', 'bun', 'long', 'band', 'crown']; // hud.js#portrait が描ける髪型
  const HEX = /^#[0-9a-f]{6}$/i;

  ok(CHARACTERS.length >= 6, `there is a real choice of players: ${CHARACTERS.length}`);
  ok(new Set(CHARACTERS.map((c) => c.key)).size === CHARACTERS.length, 'player keys are unique');
  ok(CHARACTERS.every((c) => c.key !== 'custom'), '"custom" is reserved for the slider-made player');
  ok(CHARACTER_BUDGET === SKILL_DEFAULT * core.length, `the budget equals an all-${SKILL_DEFAULT} player: ${CHARACTER_BUDGET}`);
  CHARACTERS.forEach((c) => {
    SKILLS.forEach((s) => {
      const v = c.ratings[s.key];
      ok(Number.isInteger(v) && v >= SKILL_MIN && v <= SKILL_MAX, `${c.key}.${s.key} is a whole ${SKILL_MIN}..${SKILL_MAX}, got ${v}`);
    });
    const total = core.reduce((sum, s) => sum + c.ratings[s.key], 0);
    if (c.champion) {
      ok(core.every((s) => c.ratings[s.key] === SKILL_MAX), `${c.key} (the strongest) is maxed out in every ability`);
      ok(c.ratings.netPlay === SKILL_DEFAULT, 'but net play is a taste, not an ability, so it stays neutral');
    } else {
      ok(total === CHARACTER_BUDGET, `${c.key} is personality, not power: total ${total} vs ${CHARACTER_BUDGET}`);
    }
    ok(c.name && c.type && c.text, `${c.key} has a name, a type and a description`);
    ok(STYLES.includes(c.look.style), `${c.key} has a hair style the portrait can draw: ${c.look.style}`);
    ok(['skin', 'hair', 'accent'].every((k) => HEX.test(c.look[k])), `${c.key} has #rrggbb portrait colours`);
    ok(R.config.CPU_STYLES[c.cpuStyle], `${c.key} brings a CPU play style that exists: ${c.cpuStyle}`);
    if (c.key !== CHARACTER_DEFAULT && !c.champion) {
      ok(core.some((s) => c.ratings[s.key] > SKILL_DEFAULT) && core.some((s) => c.ratings[s.key] < SKILL_DEFAULT),
        `${c.key} has both a strength and a weakness`);
    }
  });
  ok(CHARACTERS.filter((c) => c.champion).length === 1, 'there is exactly one strongest player (the only one off-budget)');
  const profiles = CHARACTERS.map((c) => SKILLS.map((s) => c.ratings[s.key]).join(','));
  ok(new Set(profiles).size === profiles.length, 'no two players share the same ratings');
  ROSTER.forEach((r) => ok(THEME[r.kit] && typeof THEME[r.kit].shirt === 'number', `${r.key} wears THEME.${r.kit}`));

  // 既定の選手は全項目3＝何も選ばなければ従来と同じ（main.js の「既定に戻す」もこれを前提にしている）
  const standard = CHARACTERS.find((c) => c.key === CHARACTER_DEFAULT);
  ok(standard && SKILLS.every((s) => standard.ratings[s.key] === SKILL_DEFAULT),
    `the default player (${CHARACTER_DEFAULT}) is all ${SKILL_DEFAULT}s`);
  ok(standard.cpuStyle === 'none', 'and brings no play style, so the default match is unchanged');
  ok(CHARACTERS.find((c) => c.key === 'serveVolley').cpuStyle === 'serveAndVolley',
    'picking the serve-and-volleyer as the CPU makes it serve and volley');

  try {
    const big = CHARACTERS.find((c) => c.ratings.serve === SKILL_MAX);
    applyCharacter('cpu', big.key);
    ok(SKILLS.every((s) => getRating('cpu', s.key) === big.ratings[s.key]), `applyCharacter copies ${big.key}'s ratings`);
    ok(ATTRS.cpu.serve < 1, `and the multipliers follow (serve ${ATTRS.cpu.serve})`);
    ok(SKILLS.every((s) => getRating('you', s.key) === SKILL_DEFAULT), 'other slots are untouched');
    applyCharacter('cpu', 'nobody');
    ok(getRating('cpu', 'serve') === SKILL_MAX, 'an unknown player key changes nothing');
    // 最強の選手は、どの倍率も既定より有利な側にある（速く走り・速い球・ミスが少ない…）
    applyCharacter('cpu', CHARACTERS.find((c) => c.champion).key);
    const higherIsBetter = ['speed', 'recover', 'reach', 'volleySharp', 'serveWindow'];
    const lowerIsBetter = ['drain', 'react', 'forehand', 'backhand', 'volley', 'smash', 'serve', 'out', 'timing'];
    higherIsBetter.forEach((k) => ok(ATTRS.cpu[k] > 1, `the strongest player's ${k} is above 1.0, got ${ATTRS.cpu[k]}`));
    lowerIsBetter.forEach((k) => ok(ATTRS.cpu[k] < 1, `the strongest player's ${k} is below 1.0, got ${ATTRS.cpu[k]}`));
    ok(ATTRS.cpu.net === 1, 'and goes to the net as often as usual');
    applyCharacter('cpu', CHARACTER_DEFAULT);
    ok(Object.values(ATTRS.cpu).every((m) => m === 1), 'picking the default player puts every multiplier back to 1.0');
  } finally { resetRatings(); }
}

// --- 能力値が実際のプレーに効く（移動・スタミナ・サーブ・打球の速さ） ---
{
  const { setRating, resetRatings, SKILL_MIN, SKILL_MAX } = R.config;
  const { PHYSICS } = R.config;

  // 移動速度：同じ時間だけ同じ目標へ走らせると、能力5の方が遠くまで進む
  const ranIn = (rating) => {
    setRating('cpu', 'speed', rating);
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    g.cpu.x = 0; g.cpu.z = 5;
    const before = { x: g.cpu.x, z: g.cpu.z };
    g.moveTowards(g.cpu, before, { x: 6, z: 5 }, PLAYER.CPU_CHASE, 0.5);
    return g.cpu.x;
  };
  try {
    const slow = ranIn(SKILL_MIN);
    const fast = ranIn(SKILL_MAX);
    ok(fast > slow + 0.3, `speed 5 covers more ground than speed 1: ${fast.toFixed(2)} vs ${slow.toFixed(2)}`);
  } finally { resetRatings(); }

  // 体力：同じ距離を走ったときの消費が違う
  try {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    setRating('cpu', 'stamina', SKILL_MIN);
    setRating('cpuMate', 'stamina', SKILL_MAX);
    g.drainStamina(g.cpu, 10);
    g.drainStamina(g.cpuMate, 10);
    ok(g.cpu.stamina < g.cpuMate.stamina,
      `stamina 1 tires faster than stamina 5: ${g.cpu.stamina.toFixed(3)} vs ${g.cpuMate.stamina.toFixed(3)}`);
  } finally { resetRatings(); }

  // サーブ：CPU/AI のサーブの初速が能力で変わる。コース・深さ・スピンは毎回ランダムに
  // 選ばれ、それだけで初速が数m/s動くので、Math.random を固定して能力だけを比べる。
  const cpuServeSpeed = (rating) => {
    const origRandom = Math.random;
    Math.random = () => 0.5;
    try {
      setRating('cpu', 'serve', rating);
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.start();
      g.server = 'cpu';
      g.beginServe();
      g.serve('cpu');
      return Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz);
    } finally {
      Math.random = origRandom;
    }
  };
  try {
    const weak = cpuServeSpeed(SKILL_MIN);
    const strong = cpuServeSpeed(SKILL_MAX);
    ok(strong > weak, `serve 5 is faster than serve 1: ${strong.toFixed(1)} vs ${weak.toFixed(1)} m/s`);
  } finally { resetRatings(); }

  // 人間の打球：フォアの能力で飛翔時間（＝速さ）が変わる。バックは別々に効く
  const youFlight = (stroke, rating) => {
    setRating('you', stroke, rating);
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.you.swingCharge = 1;
    return g.playerShot(stroke).flight;
  };
  try {
    const weakFh = youFlight('forehand', SKILL_MIN);
    const strongFh = youFlight('forehand', SKILL_MAX);
    ok(strongFh < weakFh, `forehand 5 hits a faster ball: flight ${strongFh.toFixed(3)} vs ${weakFh.toFixed(3)}`);
    resetRatings();
    setRating('you', 'forehand', SKILL_MAX);
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.you.swingCharge = 1;
    ok(g.playerShot('backhand').flight > g.playerShot('forehand').flight,
      'a strong forehand does not make the backhand strong too');
  } finally { resetRatings(); }

  // AI の打球：能力（skill.power / skill.out）が飛翔時間とミス率に効く
  {
    const origRandom = Math.random;
    Math.random = () => 0.5; // ミスの抽選には当たらない値に固定して飛翔時間だけ見る
    try {
      const opponent = { x: 1.5, z: -HALF_L };
      const plain = R.ai.cpuShot(opponent, -1, 0);
      const strong = R.ai.cpuShot(opponent, -1, 0, 1, 1, { power: 0.85, out: 1, sharp: 1 });
      ok(strong.flight < plain.flight,
        `a stronger AI hits a faster ball: ${strong.flight.toFixed(3)} vs ${plain.flight.toFixed(3)}`);
      const volley = R.ai.cpuVolleyShot(opponent, -1, 0, 1.4, { power: 1, out: 1, sharp: 1.35 });
      const dullVolley = R.ai.cpuVolleyShot(opponent, -1, 0, 1.4, { power: 1, out: 1, sharp: 0.65 });
      ok(Math.abs(volley.target.x) > Math.abs(dullVolley.target.x),
        'a better volleyer angles the same ball wider');
      ok(volley.flight < dullVolley.flight, 'and hits it harder');
    } finally {
      Math.random = origRandom;
    }
    // ミス率：安定感が高い（out<1）ほど、わざとアウトを狙う確率が下がる
    const outs = (outMult) => {
      let n = 0;
      for (let i = 0; i < 400; i++) {
        const t = R.ai.shotTarget(0, -1, 1, outMult); // stretch=1（最もミスしやすい状況）
        if (Math.abs(t.z) > HALF_L || Math.abs(t.x) > HALF_W) n++;
      }
      return n;
    };
    ok(outs(0.4) < outs(1), 'a steadier AI misses the lines less often');
  }
  ok(PHYSICS.BALL_R > 0, 'sanity: config is still intact after all the rating changes');
}

// --- 試合後のスタッツ：数え方（ポイント／ウィナー／ミス／1stサーブ／最速サーブ／ラリー） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.phase = 'rally'; // endPoint() を直接叩いて「決まり方」ごとの数え方だけを見る

  const point = (winner, reason, shots) => {
    g.phase = 'rally';
    g.serveInFlight = false;
    g.rallyShots = shots;
    g.endPoint(winner, reason);
  };
  point('you', 'ツーバウンド', 5);          // 自分のウィナー
  point('cpu', 'アウト', 3);                // 自分のミス＝相手のポイント
  point('you', 'ネット', 9);                // 相手のミス
  g.phase = 'rally';
  g.serveInFlight = true;                   // サーブが一度も触れられずに決まった＝エース
  g.rallyShots = 1;
  g.endPoint('you', 'ツーバウンド');
  point('cpu', 'ダブルフォルト', 1);        // ダブルフォルトはサーバー（you）の失点

  const st = g.stats;
  ok(st.you.points === 3 && st.cpu.points === 2, `points: ${st.you.points}-${st.cpu.points}`);
  ok(st.you.winners === 1, `winners count only the decisive shots (not aces): ${st.you.winners}`);
  ok(st.you.aces === 1 && st.you.unforced === 1, `ace=${st.you.aces} unforced=${st.you.unforced}`);
  ok(st.cpu.unforced === 1, `the opponent's net error is their own miss: ${st.cpu.unforced}`);
  ok(st.you.doubleFaults === 1 && st.cpu.unforced === 1,
    'a double fault is counted in its own column, not as an unforced error');
  ok(g.matchStats.points === 5 && g.matchStats.longestRally === 9,
    `match totals: points=${g.matchStats.points} longest=${g.matchStats.longestRally}`);

  const sum = g.matchSummary('you');
  ok(sum.winner === 'you' && sum.points === 5, 'summary carries the winner and the point count');
  ok(Math.abs(sum.avgRally - (5 + 3 + 9 + 1 + 1) / 5) < 1e-9, `avgRally: ${sum.avgRally}`);
  ok(sum.you.points === 3 && sum.you !== g.stats.you, 'summary copies the stats (not a live reference)');

  g.resetStats();
  ok(g.stats.you.points === 0 && g.matchStats.points === 0, 'resetStats() clears everything');
}

// --- 試合後のハイライト：決まった1点ずつに見どころの点数を付け、上位と試合を決めた1点を古い順に選ぶ ---
{
  const { HIGHLIGHT } = R.config;
  const S = HIGHLIGHT.SCORE;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(false, 'you');
  /** shots 本のラリーで winner が reason で取る（specials はそのポイントで出た技の呼び名） */
  const point = (winner, reason, shots, specials = []) => {
    g.phase = 'rally';
    g.serveInFlight = false;
    g.stakes = null;
    g.rallyShots = shots;
    g.pointSpecials = specials.slice();
    g.endPoint(winner, reason);
    g.clearTimers();
    return g.lastPoint;
  };
  const short = point('you', 'アウト', 2);
  ok(short.id === 1 && short.score === 2 * S.PER_SHOT && short.outcome === 'error',
    `a short error rally scores just its shots: ${JSON.stringify(short)}`);
  const long = point('cpu', 'ツーバウンド', 15);
  ok(long.score === 15 * S.PER_SHOT + S.WINNER, `a long winner rally adds the winner bonus: ${long.score}`);
  const special = point('you', 'ツーバウンド', 3, ['ジャックナイフ']);
  ok(special.score === 3 * S.PER_SHOT + S.WINNER + S.SPECIAL && special.specials[0] === 'ジャックナイフ',
    `a special move adds its bonus: ${special.score}`);
  // エース：サーブに触れられずに決まった（serveInFlight のまま）。速いサーブはさらに上乗せ
  g.phase = 'rally'; g.serveInFlight = true; g.rallyShots = 1; g.pointSpecials = [];
  g.lastServeKmh = S.FAST_SERVE_KMH + 5;
  g.endPoint('you', 'ツーバウンド'); g.clearTimers();
  ok(g.lastPoint.outcome === 'ace' && g.lastPoint.serveKmh === S.FAST_SERVE_KMH + 5
    && g.lastPoint.score === S.PER_SHOT + S.ACE + S.FAST_SERVE, `a fast ace: ${JSON.stringify(g.lastPoint)}`);
  for (let i = 0; i < 6; i++) point('cpu', 'ネット', 1);
  const last = point('cpu', 'アウト', 1);
  ok(g.pointLog.length === 11, `every decided point is logged: ${g.pointLog.length}`);

  const picks = g.highlightPicks();
  ok(picks.length <= HIGHLIGHT.MAX_CLIPS, `at most MAX_CLIPS: ${picks.length}`);
  ok(picks[picks.length - 1] === last, 'the last (deciding) point is always in, even when it is dull');
  ok(picks.every((p, i) => i === 0 || picks[i - 1].id < p.id), 'and the picks are in the order they were played');
  ok(picks.indexOf(long) !== -1 && picks.indexOf(special) !== -1 && picks.indexOf(short) === -1,
    `the best points are picked, the dull ones are not: ${picks.map((p) => p.id)}`);
  ok(picks.slice(0, -1).every((p) => p.score >= HIGHLIGHT.MIN_SCORE), 'nothing below MIN_SCORE except the last point');
  const keep = g.highlightKeep();
  ok(picks.every((p) => keep.has(p.id)), 'every possible pick is kept by the display side');
  ok(!keep.has(short.id), 'and dull points can be thrown away');
  ok(g.matchSummary('cpu').highlights.length === picks.length, 'the match summary carries the highlights');
  g.resetStats();
  ok(g.pointLog.length === 0 && g.highlightPicks().length === 0, 'the next match starts a new log');
  ok(point('you', 'アウト', 1).id === 12, 'ids keep counting so recordings never collide');
}

// --- ポイントの後の感情表現：気性と決まり方で、ガッツポーズ／うなだれる／ラケットを叩きつける ---
{
  const { EMOTION } = R.config;
  const sounds = [];
  const realRandom = Math.random;
  /** server がサーブする場面で、winner が reason で取る。rnd＝Math.random が返す値 */
  const play = ({ tempers, server = 'you', winner, reason, shots = 1, games, points, rnd = 0 }) => {
    const g = new R.Game({ input: fakeInput, hooks: { ...noHooks, sound: (n) => sounds.push(n) } });
    g.start(false, server);
    g.setTempers(tempers);
    if (games) g.match.games = games;
    if (points) g.match.points = points;
    g.stakes = R.scoring.pointStakes(g.match, g.server);
    g.matchPointCutDone = true;
    g.phase = 'rally';
    g.serveInFlight = false;
    g.rallyShots = shots;
    sounds.length = 0;
    Math.random = () => rnd;
    try { g.endPoint(winner, reason); } finally { Math.random = realRandom; }
    return g;
  };
  const fiery = { you: 'fiery', cpu: 'fiery' };
  // 0-40 からブレークされた（you のサーブ）：熱くなる選手はラケットを叩きつけ、取った側はガッツポーズ
  let g = play({ tempers: fiery, winner: 'cpu', reason: 'アウト', points: { you: 0, cpu: 3 } });
  ok(g.you.mood && g.you.mood.kind === 'smash', `a fiery server who is broken smashes the racket: ${JSON.stringify(g.you.mood)}`);
  ok(g.cpu.mood && g.cpu.mood.kind === 'fist', `the breaker pumps a fist: ${JSON.stringify(g.cpu.mood)}`);
  const S = EMOTION.SMASH;
  for (let i = 0; i < 60 * (EMOTION.DELAY + S.RAISE_T + S.SLAM_T) + 2; i++) g.update(1 / 60);
  ok(sounds.includes('racketSmash'), `the smash is heard as the racket lands: ${sounds}`);
  // 冷静な選手は同じ場面でも叩きつけない（うなだれるだけ）
  g = play({ tempers: { you: 'calm', cpu: 'calm' }, winner: 'cpu', reason: 'アウト', points: { you: 0, cpu: 3 } });
  ok(g.you.mood && g.you.mood.kind === 'slump', `a calm server only slumps: ${JSON.stringify(g.you.mood)}`);
  // 自分のサーブをキープした側（サーバーが取った）には叩きつける理由がない
  g = play({ tempers: fiery, winner: 'you', reason: 'アウト', points: { you: 3, cpu: 0 } });
  ok(g.cpu.mood && g.cpu.mood.kind === 'slump', `losing a return game is not a break: ${JSON.stringify(g.cpu.mood)}`);
  // 何もかかっていない短い1点を相手のミスで取っても、ガッツポーズはしない
  g = play({ tempers: fiery, winner: 'you', reason: 'アウト', points: { you: 1, cpu: 0 } });
  ok(!g.you.mood, `a dull point gets no fist pump: ${JSON.stringify(g.you.mood)}`);
  // 確率を外せば何もしない（毎回同じ反応にはならない）
  g = play({ tempers: { you: 'normal', cpu: 'normal' }, winner: 'cpu', reason: 'ツーバウンド', shots: 12, rnd: 0.99 });
  ok(!g.you.mood && !g.cpu.mood, 'with an unlucky roll nobody reacts');
  // 表情は SPAN で消え、次のサーブの構えでも必ず消える
  g = play({ tempers: fiery, winner: 'cpu', reason: 'ツーバウンド', shots: 12 });
  ok(g.cpu.mood && g.cpu.mood.kind === 'fist', 'a long winning rally earns a fist pump');
  for (let i = 0; i < 60 * (EMOTION.DELAY + EMOTION.SPAN) + 2; i++) g.update(1 / 60);
  ok(!g.cpu.mood, 'and it fades after SPAN');
  ok(EMOTION.DELAY + EMOTION.SPAN < R.config.TIMING.NEXT_POINT, 'the reaction fits inside the pause between points');
  g = play({ tempers: fiery, winner: 'cpu', reason: 'アウト', points: { you: 0, cpu: 1 } });
  g.beginServe();
  ok(!g.you.mood && !g.cpu.mood, 'the next serve clears the reactions');
  // 知らない気性・カスタムは normal
  g.setTempers({ you: 'nope' });
  ok(g.tempers.you === 'normal', `unknown tempers fall back to normal: ${g.tempers.you}`);
  ok(R.config.CHARACTERS.every((c) => EMOTION.TEMPERS[c.temper]), 'every character has a known temper');
}

// --- にわか雨：降り出す → 小雨の間は続く → ポイントの後で中断 → 再開すると濡れたコートで低く弾む ---
{
  const { RAIN, TIMING } = R.config;
  const calls = [];
  const realRandom = Math.random;
  const g = new R.Game({ input: fakeInput, hooks: { ...noHooks, call: (big) => calls.push(big) } });
  g.start(false, 'cpu');
  const step = (sec) => { for (let i = 0; i < Math.round(60 * sec); i++) g.update(1 / 60); };
  // 晴れを選んでいれば、何本やっても降らない
  g.matchStats.points = RAIN.MIN_POINTS;
  Math.random = () => 0;
  try { g.newPoint(); } finally { Math.random = realRandom; }
  ok(!g.rain, 'no rain unless the weather option is on');
  g.setRain(true);
  g.matchStats.points = RAIN.MIN_POINTS - 1;
  Math.random = () => 0;
  try { g.newPoint(); } finally { Math.random = realRandom; }
  ok(!g.rain, `not before MIN_POINTS points have been played`);
  g.matchStats.points = RAIN.MIN_POINTS;
  Math.random = () => 0;
  try { g.newPoint(); } finally { Math.random = realRandom; }
  ok(g.rain && g.rain.phase === 'drizzle', `it starts to drizzle at the start of a point: ${JSON.stringify(g.rain)}`);
  // 小雨の間は試合が続き、コートが少しずつ濡れる
  g.rain.t = RAIN.DRIZZLE_T - 0.01;
  g.tickRain(0.02);
  ok(Math.abs(g.wet - RAIN.DRIZZLE_WET) < 1e-9, `the court gets damp in the drizzle: ${g.wet}`);
  // 決まった1点の後で中断。この間は試合が止まる
  g.phase = 'rally'; g.serveInFlight = false; g.rallyShots = 3; g.stakes = null;
  g.endPoint('you', 'ツーバウンド');
  step(TIMING.NEXT_POINT + 0.05);
  ok(g.rain.phase === 'suspended' && calls[calls.length - 1] === '雨天中断', `play is suspended after the point: ${JSON.stringify(g.rain)} ${calls.slice(-1)}`);
  const at = { x: g.you.x, z: g.you.z, phase: g.phase, points: { ...g.match.points } };
  step(RAIN.DELAY - 1);
  ok(g.rain.phase === 'suspended' && g.phase === at.phase && g.match.points.you === at.points.you,
    'nothing moves on during the delay');
  step(1.1);
  ok(g.rain.phase === 'clearing' && g.wet === 1 && calls[calls.length - 1] === '試合再開',
    `after DELAY the covers come off and the court is soaked: ${JSON.stringify(g.rain)} wet=${g.wet}`);
  step(RAIN.RESUME_T + 0.05);
  ok(g.phase === 'serve' && !g.rain, `then play resumes with the next serve: phase=${g.phase} rain=${JSON.stringify(g.rain)}`);
  // 濡れたコートは低く弾み、滑る（予測も同じ物理を使う）
  const bounceOf = (wet) => {
    R.physics.setWetness(wet);
    const b = { x: 0, y: 0.05, z: 3, px: 0, py: 0.15, pz: 2.8, vx: 0, vy: -8, vz: 15, spin: 'flat' };
    R.physics.reflectBounce(b);
    return b;
  };
  const dry = bounceOf(0);
  const soaked = bounceOf(1);
  R.physics.setWetness(g.wet);
  ok(soaked.vy < dry.vy * 0.9 && soaked.vz > dry.vz, `a wet court bounces lower and skids: dry=${dry.vy.toFixed(2)}/${dry.vz.toFixed(2)} wet=${soaked.vy.toFixed(2)}/${soaked.vz.toFixed(2)}`);
  // 1ポイントごとに乾いていく。1試合に降るのは MAX_PER_MATCH 回まで
  g.phase = 'rally'; g.serveInFlight = false;
  g.endPoint('cpu', 'アウト');
  ok(Math.abs(g.wet - (1 - 1 / RAIN.WET_POINTS)) < 1e-9, `it dries a little after each point: ${g.wet}`);
  Math.random = () => 0;
  try { step(TIMING.NEXT_POINT + 0.05); } finally { Math.random = realRandom; }
  ok(!g.rain, 'it rains at most MAX_PER_MATCH times a match');
  // 中断は Space で切り上げられる
  const h = new R.Game({ input: fakeInput, hooks: noHooks });
  h.start(false, 'cpu');
  h.beginRainDelay(null);
  h.skipRainDelay();
  ok(h.rain.phase === 'clearing', 'Space cuts the rain delay short');
  ok(new R.Game({ input: fakeInput, hooks: noHooks }).wet === 0 && (bounceOf(0), true), 'a new game starts dry');
  R.physics.setWetness(0);
}

// --- 試合後のスタッツ：セットが終わると matchEnd が1回だけ呼ばれ、次のマッチで0に戻る ---
{
  const ends = [];
  const g = new R.Game({
    input: fakeInput,
    hooks: { ...noHooks, matchEnd: (summary) => ends.push(summary) },
  });
  g.start();
  g.match.games.you = 5; // あと1ゲームでセット
  // 1ポイントずつ「決まる → ポイント間を待って次のサーブの構えに戻る」を通す
  // （まとめて endPoint() だけを続けて呼ぶと、前のポイントの待ちタイマーが後から
  // beginServe() を呼んで、セット終了時のタイマーごと消してしまう＝実際の進行とは違う）。
  const winPoint = (last) => {
    g.phase = 'rally';
    g.serveInFlight = false;
    g.rallyShots = 4;
    g.endPoint('you', 'ツーバウンド');
    if (last) return;
    for (let i = 0; i < 60 * 3 && g.phase === 'over'; i++) g.update(1 / 60);
    // 40-0 は試合で初めてのマッチポイント＝演出が終わるまで試合が止まる（実際の進行と同じく待つ）
    for (let i = 0; i < 60 * 8 && g.matchPointCut; i++) g.update(1 / 60);
  };
  for (let i = 0; i < 3; i++) winPoint(false);
  winPoint(true); // この1本でゲーム＝セットが決まる
  ok(g.match.games.you === 6, `precondition: the set is won, games=${g.match.games.you}`);
  ok(ends.length === 0, 'the summary does not appear before the finale has played');
  // 締めくくり（FINALE.DELAY の後に締めのカットを DURATION）を見せてから出る（リプレイ中は
  // main.js が update() を止めるので、実際の画面では再生が終わってから数え始める）
  const { FINALE } = R.config;
  for (let i = 0; i < 60 * (FINALE.DELAY + FINALE.DURATION + 1) && ends.length === 0; i++) g.update(1 / 60);
  ok(ends.length === 1, `matchEnd fires once when the set ends: ${ends.length}`);
  ok(ends[0].winner === 'you' && ends[0].games.you === 6, 'the summary has the final score');
  ok(ends[0].you.winners === 4, `and the accumulated stats: ${ends[0].you.winners}`);
  // 次のマッチが始まるとき（TIMING.NEXT_MATCH）にスタッツは0へ戻る
  for (let i = 0; i < 60 * 4 && g.stats.you.winners > 0; i++) g.update(1 / 60);
  ok(g.stats.you.winners === 0 && g.match.games.you === 0, 'the next match starts from zero');
  ok(ends.length === 1, 'and the summary is not shown twice');
  ok(g.matchPointCutDone === false, 'and the next match gets its own match point cut again');
}

// --- 試合が決まった後の締めくくり：総立ちのまま、一拍おいて締めのカット、それからスタッツ画面 ---
{
  const { FINALE, TIMING } = R.config;
  const calls = [];
  const ends = [];
  const hooks = {
    ...noHooks,
    call: (big, sub) => calls.push(`${big}|${sub || ''}`),
    matchEnd: (summary) => ends.push(summary),
  };
  /** 5-0 40-0（マッチポイントの演出はもう出した扱い）から、winner がこの1点を取って試合が決まる。 */
  const decide = (winner) => {
    const g = new R.Game({ input: fakeInput, hooks });
    g.start(false, 'you');
    const leader = winner;
    const trailer = winner === 'you' ? 'cpu' : 'you';
    g.match.games = { [leader]: 5, [trailer]: 0 };
    g.match.points = { [leader]: 3, [trailer]: 0 };
    g.matchPointCutDone = true;
    g.phase = 'rally';
    g.serveInFlight = false;
    g.rallyShots = 4;
    calls.length = 0;
    ends.length = 0;
    g.endPoint(winner, 'ツーバウンド');
    return g;
  };
  const step = (g, sec) => { for (let i = 0; i < Math.round(60 * sec); i++) g.update(1 / 60); };

  const g = decide('you');
  ok(!!g.finale && g.finale.team === 'you' && !g.finale.cut && !g.finale.done,
    `the winning point starts the finale (the crowd rises at once), got ${JSON.stringify(g.finale)}`);
  ok(calls[calls.length - 1] === 'ゲームセット|あなたの勝ち', `and calls game set, got ${calls[calls.length - 1]}`);
  // Space を押しても（リプレイを飛ばした勢いで）まだ始まっていないカットを先に飛ばしたりしない
  g.skipFinaleCut();
  ok(!g.finale.cut && !g.finale.done && ends.length === 0, 'Space before the cut does not skip it ahead of time');
  step(g, FINALE.DELAY - 0.1);
  ok(!g.finale.cut, 'the closing cut waits FINALE.DELAY (counted after the replay)');
  step(g, 0.2);
  ok(g.finale.cut && Math.abs(g.finale.t) < 0.2, `then the closing cut begins, got ${JSON.stringify(g.finale)}`);
  ok(calls[calls.length - 1].startsWith('ゲームセット|あなたの勝ち 6-0') && calls[calls.length - 1].includes('SPACE'),
    `and the call shows the final score and how to skip, got ${calls[calls.length - 1]}`);
  // カットの間は試合が止まる（選手は決まった後の位置のまま。入力があっても動かない）
  const at = { x: g.you.x, z: g.you.z };
  const t0 = g.finale.t;
  const input = g.input;
  g.input = { ...fakeInput, moveX: 1, moveZ: 1 };
  step(g, 1);
  g.input = input;
  ok(g.you.x === at.x && g.you.z === at.z, 'the players hold still during the cut');
  ok(Math.abs(g.finale.t - t0 - 1) < 1e-6 && g.timers.length === 0,
    `the cut runs on the game clock with nothing else pending, t=${g.finale.t} timers=${g.timers.length}`);
  ok(ends.length === 0, 'the summary waits for the cut to finish');
  step(g, FINALE.DURATION);
  ok(!g.finale.cut && g.finale.done, 'the cut ends by itself after FINALE.DURATION');
  ok(ends.length === 1 && ends[0].winner === 'you', `and only then the summary comes up: ${ends.length}`);
  ok(g.match.games.you === 6, 'the final score stays on the board while the summary is up');
  step(g, TIMING.NEXT_MATCH + 0.2);
  ok(g.finale === null && g.match.games.you === 0, 'the next match clears the finale and starts from zero');
  ok(ends.length === 1, 'and the summary is not shown twice');

  // CPU が勝っても同じ流れ。Space でカットを切り上げると、すぐスタッツ画面の番になる
  const c = decide('cpu');
  ok(!!c.finale && c.finale.team === 'cpu', 'a CPU win starts the finale too');
  ok(calls[calls.length - 1] === 'ゲームセット|CPU の勝ち', `and calls it, got ${calls[calls.length - 1]}`);
  step(c, FINALE.DELAY + 0.1);
  ok(c.finale.cut, 'precondition: the closing cut is on');
  c.skipFinaleCut();
  ok(!c.finale.cut && c.finale.done && ends.length === 1 && ends[0].winner === 'cpu',
    'Space ends the cut at once and brings up the summary');
  c.skipFinaleCut();
  ok(ends.length === 1, 'a second Space does not bring it up twice');

  // ふつうのゲーム（試合が決まらない1点）では締めくくりは始まらない
  const n = new R.Game({ input: fakeInput, hooks });
  n.start(false, 'you');
  n.match.points = { you: 3, cpu: 0 };
  n.phase = 'rally';
  n.endPoint('you', 'ツーバウンド');
  ok(n.finale === null, 'winning an ordinary game does not start the finale');
}

// --- 試合後のスタッツ：1stサーブの本数と確率、最速サーブ（実際にサーブを打って数える） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  // 1本目を打って、フォールトせずに入るまで進める
  tap(g);
  untilServed(g);
  ok(g.stats.you.firstServes === 1, `hitting a first serve counts it: ${g.stats.you.firstServes}`);
  ok(g.stats.you.maxServeKmh > 0, `the serve speed is recorded: ${g.stats.you.maxServeKmh}`);
  for (let i = 0; i < 240 && g.ball.bounces === 0 && g.phase !== 'serve'; i++) g.update(1 / 60);
  ok(g.stats.you.firstServeIn === 1,
    `a first serve that lands in the box counts as in: ${g.stats.you.firstServeIn}`);

  // 2本目（セカンドサーブ）は 1st の分母に入らない
  const g2 = new R.Game({ input: fakeInput, hooks: noHooks });
  g2.start();
  g2.serveNumber = 2;
  tap(g2);
  untilServed(g2);
  ok(g2.stats.you.firstServes === 0, 'a second serve is not counted as a first serve');
}

// ================================ 必殺技 =================================
// Space（input.special）を押しながら溜めキーを離すと、その場面に合う技が1つだけ出る。
// 1ゲームにつき SPECIAL.USES_PER_GAME 回まで（全技で共有、ゲームが替わると回復）。
{
  const { SPECIAL, SPECIAL_MOVES, CHARGE, PLAYER, COURT, HALF_W: HW, HALF_L: HL } = R.config;
  /** 人間のラケット側（game.js の RACKET_SIDE.you）。フォア側が world -x、バック側が +x */
  const RACKET_SIDE_YOU = -1;
  const ALL = SPECIAL_MOVES.map((m) => m.key);
  /** 必殺技は自動発動なので、専用の入力はない（いつもの無入力でよい） */
  const idle = { moveX: 0, moveZ: 0, lob: false };
  /** 「足を止めて溜めた1打」を作る（鷹の目のように溜め量が条件の技がある） */
  const chargeUp = (g) => { g.chargeStart(); g.you.chargeTime = CHARGE.MAX_TIME; };
  /** 「ネット方向（+z）へ前へ詰めながら打つ」状態にする（ダンクスマッシュの条件） */
  const rushingIn = (g) => { g.you.fwd = SPECIAL.DUNK.MIN_FWD + 1; };
  /**
   * 「フォア側（画面の右＝world -x）へ大きく振り回されて、まだ走っている」状態にする。
   * バギーホイップの条件（走った距離 runX・立ち位置 you.x・直前まで走っていたか）をすべて満たす。
   */
  const draggedWide = (g) => {
    g.you.x = -(SPECIAL.BUGGY.MIN_X + 0.6);
    g.you.runX = -(SPECIAL.BUGGY.MIN_RUN_X + 0.5);
    g.you.speed = 5;
    g.you.sinceRunT = 0; // いま走っている最中
    g.you.chargeSpin = 'top'; // V（トップスピン）で溜めている＝バギーホイップの条件
  };
  /**
   * 「ベースライン上に立っていて、目の前で弾んだばかりの球が上がってくる」状態にする
   * （ライジングの条件）。球はもう届く位置（フォア側）にある＝いま振ればこの打点で当たる。
   * @param {{since?:number, vy?:number, y?:number, youZ?:number}} [opt]
   *   since＝弾んでからの秒数、vy＝縦の速さ、y＝打点の高さ、youZ＝立ち位置
   */
  const onTheRise = (g, opt = {}) => {
    g.you.x = 0;
    g.you.z = opt.youZ === undefined ? -HL : opt.youZ;
    g.you.speed = 0;
    Object.assign(g.ball, {
      x: g.you.x + RACKET_SIDE_YOU * 0.5,
      y: opt.y === undefined ? 0.3 : opt.y,
      z: g.you.z + 1.0,
      vx: 0,
      vy: opt.vy === undefined ? 3 : opt.vy,
      vz: -15,
      bounces: 1,
      sinceBounce: 'since' in opt ? opt.since : 0.05,
      spin: 'flat',
      wind: 0,
      curve: 0,
    });
  };

  /** ラリー中（相手が打った球が飛んできている）状態のゲームを作る */
  const rally = (specials, input = idle) => {
    const g = new R.Game({ input, hooks: noHooks });
    g.setSpecials(specials);
    g.start();
    // 技そのものの狙いを見るので無風にする（風は会場ごとに1点目から吹いていて、横風なら
    // サイドラインぎりぎりの鷹の目は外へ流されうる）。
    g.windStrength = 0;
    g.setWindVector();
    g.phase = 'rally';
    g.ball.live = true;
    g.ball.last = 'cpu';
    g.ball.bounces = 1;
    g.ball.vx = 0; g.ball.vy = 0; g.ball.vz = 0;
    return g;
  };
  /** 自分のすぐ横（届く位置）に球を置く。既定はラケット側＝フォアハンドになる側（world -x）。 */
  const ballAt = (g, y, dz = 0.3, bounces = 1, side = -1) => {
    g.ball.x = g.you.x + side * 0.3;
    g.ball.y = y;
    g.ball.z = g.you.z + dz;
    g.ball.bounces = bounces;
  };
  /**
   * 打った直後のボールの軌道を追い、ネット面(z=0)を通過した瞬間と着地点を返す。
   * ネットポストの外を回るショット（バギーホイップのストレート）の確認に使う。
   */
  const trace = (g) => {
    const BALL_R = R.config.PHYSICS.BALL_R;
    const sim = Object.assign({}, g.ball);
    let cross = null;
    for (let i = 0; i < 3000; i++) {
      const pz = sim.z;
      R.physics.integrate(sim, 1 / 240);
      if (pz * sim.z < 0) cross = { x: sim.x, y: sim.y, hitsNet: R.physics.hitsNet(sim) };
      if (sim.y <= BALL_R && sim.vy < 0) return { cross, land: { x: sim.x, z: sim.z } };
    }
    return { cross, land: null };
  };
  const inOpponentCourt = (L) => !L.net && L.z > 0
    && L.z <= HL + COURT.LINE_SLACK && Math.abs(L.x) <= HW + COURT.LINE_SLACK;

  // --- 装備していなければ何も起きない（＝従来どおりのゲーム） ---
  {
    const g = rally([]);
    ballAt(g, 1.0);
    chargeUp(g);
    ok(g.specialAim() === null, 'no specials equipped: nothing is armed');
    g.chargeRelease();
    ok(g.you.special === null, 'and releasing does not arm anything');
  }

  // --- 候補を出すのは「これから打つ」場面だけ（ラリー中は溜めている間） ---
  {
    const g = rally(ALL);
    g.you.z = -3;
    rushingIn(g);
    ballAt(g, 2.6, 0.3, 0);
    ok(g.specialAim() === null, 'not charging yet: no special is announced');
    chargeUp(g);
    const armed = g.specialAim();
    ok(armed && armed.move === 'dunkSmash', `charging announces the move, got ${armed && armed.move}`);
  }

  // --- 場面ごとに出る技が変わる（SPECIAL_MOVES の並び順＝優先度） ---
  {
    // 高い球 → ダンクスマッシュ
    const high = rally(ALL);
    high.you.z = -3;
    rushingIn(high);
    ballAt(high, 2.6, 0.3, 0);
    ok(high.pickSpecial() === 'dunkSmash', `a high ball picks the dunk smash, got ${high.pickSpecial()}`);

    // ネット前のノーバウンドでも、普通に届く球には飛び込まない（下の優先度へ落ちる）
    const easy = rally(ALL);
    easy.you.z = -3;
    ballAt(easy, 1.0, 0.3, 0);
    ok(easy.pickSpecial() !== 'divingVolley',
      `a volley within normal reach does not dive, got ${easy.pickSpecial()}`);

    // 普通のリーチでは届かないノーバウンド → 飛びつきボレー
    const net = rally(ALL);
    net.you.z = -3;
    ballAt(net, 1.0, 0.3, 0);
    net.ball.x = net.you.x - 2.4; // 通常(1.55)では届かず、飛びつき(×1.95)なら届く距離
    ok(net.pickSpecial() === 'divingVolley', `an out-of-reach no-bounce ball picks the diving volley, got ${net.pickSpecial()}`);

    // ベースライン寄りのノーバウンドの浮き球 → ドライブボレー
    const drive = rally(ALL);
    drive.you.z = -9;
    ballAt(drive, 1.2, 0.3, 0);
    ok(drive.pickSpecial() === 'driveVolley', `a floating no-bounce ball picks the drive volley, got ${drive.pickSpecial()}`);

    // フォア側へ大きく振り回されたグラウンドストローク → バギーホイップ
    const run = rally(ALL);
    run.you.z = -9;
    draggedWide(run);
    ballAt(run, 1.0);
    ok(run.pickSpecial() === 'buggyWhip', `a groundstroke on the run picks the buggy whip, got ${run.pickSpecial()}`);

    // 足を止めて溜めたグラウンドストローク → 鷹の目
    const set = rally(ALL);
    set.you.z = -9;
    set.you.speed = 0;
    ballAt(set, 1.0);
    chargeUp(set);
    ok(set.pickSpecial() === 'hawkEye', `a groundstroke with the feet set picks the hawk eye, got ${set.pickSpecial()}`);

    // 自分より後ろ（抜かれた）→ ツイーナー
    const behind = rally(ALL);
    behind.you.z = -10;
    behind.you.speed = 5;
    ballAt(behind, 1.0, -1.2); // 真後ろに 1.2m ＝ 抜かれた球
    ok(behind.pickSpecial() === 'tweener', `a ball that got past you picks the tweener, got ${behind.pickSpecial()}`);

    // 自分のサーブ → B/V/C のトスでは何も出ない（ラリー用の技も出ない）。
    // キックサーブは K で上げたトスだけ。
    const serving = new R.Game({ input: idle, hooks: noHooks });
    serving.setSpecials(ALL);
    serving.start();
    ok(serving.pickSpecial() === null, `a plain serve picks nothing, got ${serving.pickSpecial()}`);
    ok(serving.chargeStart('top', true) === true, 'K tosses the serve');
    ok(serving.pickSpecial() === 'kickServe', `a K toss picks the kick serve, got ${serving.pickSpecial()}`);
  }

  // --- 装備していない技は出ない（同じ場面でも次の優先度へ落ちる） ---
  // 場面は「振り回されたフォアのトップスピン」＝バギーホイップ（優先度が上）と
  // 鷹の目の両方が条件を満たすところ。鷹の目はグラウンドストローク限定なので、
  // 2つが重なる場面をここで作る必要がある。
  {
    const scene = (g) => {
      g.you.z = -9;
      ballAt(g, 1.0);
      chargeUp(g);      // 溜め（鷹の目の条件）
      draggedWide(g);   // 振り回されたフォアのトップスピン（バギーホイップの条件）
    };
    const both = rally(['hawkEye', 'buggyWhip']);
    scene(both);
    ok(both.pickSpecial() === 'buggyWhip',
      `precondition: with both equipped the higher-priority move wins, got ${both.pickSpecial()}`);

    const g = rally(['hawkEye']); // バギーホイップは装備していない
    scene(g);
    ok(g.pickSpecial() === 'hawkEye',
      `an unequipped move is skipped for the next matching one, got ${g.pickSpecial()}`);
  }

  // --- 使える回数は技ごとに1ゲーム USES_PER_GAME 回。ゲームが替わると回復する ---
  {
    const g = rally(['hawkEye']);
    ok(g.usesLeft('hawkEye') === SPECIAL.USES_PER_GAME, 'a match starts with a full set of uses');
    ballAt(g, 1.0);
    g.you.speed = 0;
    chargeUp(g);
    g.chargeRelease();
    ok(g.you.special === 'hawkEye', `releasing arms the picked move, got ${g.you.special}`);
    ok(g.usesLeft('hawkEye') === SPECIAL.USES_PER_GAME,
      'the use is not spent until the shot actually connects');
    g.hit('you');
    ok(g.usesLeft('hawkEye') === SPECIAL.USES_PER_GAME - 1,
      `connecting spends one use of that move, left ${g.usesLeft('hawkEye')}`);
    ok(g.stats.you.specials === 1, `and counts it in the match stats, got ${g.stats.you.specials}`);

    // 使い切った後は、同じ場面でも armed.move が null になる（＝出ない）。
    // 「回数さえあれば出せた技」は spent に入るので、HUD はその名前で案内できる。
    g.you.special = null;
    ballAt(g, 1.0);
    g.ball.last = 'cpu';
    chargeUp(g);
    const spent = g.specialAim();
    ok(spent && spent.move === null, `out of uses: nothing is armed, got ${spent && spent.move}`);
    ok(spent && spent.spent === '鷹の目', `and the spent move is named, got ${spent && spent.spent}`);
    g.chargeRelease();
    g.hit('you');
    ok(g.you.special === null, 'and the shot is an ordinary one');

    // 4ポイント取ってゲームを取ると回復する
    for (let p = 0; p < 4; p++) { g.phase = 'rally'; g.endPoint('you', 'ツーバウンド'); }
    ok(g.match.games.you === 1, `precondition: the game was won, got ${g.match.games.you}`);
    ok(g.usesLeft('hawkEye') === SPECIAL.USES_PER_GAME,
      `a new game refreshes the uses, got ${g.usesLeft('hawkEye')}`);
  }

  // --- 前の1打の技が次の振りに持ち越されない（回数が二重に減らない） ---
  // (退行テスト: 技は振り終わる（モーションが尽きる）まで you.special に残るので、
  //  当たった直後にもう一度振ると、技が乗らない2振り目にも前の技が残ったまま hit() に
  //  入り、同じ技の回数がもう1回減っていた＝残り回数がマイナスになりうる)
  {
    const g = rally(['hawkEye']);
    g.you.z = -9; g.you.speed = 0;
    ballAt(g, 1.0);
    chargeUp(g);
    g.chargeRelease();
    g.hit('you');
    ok(g.usesLeft('hawkEye') === SPECIAL.USES_PER_GAME - 1, 'precondition: the move was spent once');
    ok(g.you.special === 'hawkEye' && g.you.anim > 0,
      'precondition: it is still on the player while the swing plays out');

    // 振り終わる前に、続けてもう一度振る（技は残り0回なので乗らないはず）
    ballAt(g, 1.0);
    g.ball.last = 'cpu';
    chargeUp(g);
    g.chargeRelease();
    ok(g.you.special === null, 'the next swing carries no move');
    g.hit('you');
    ok(g.usesLeft('hawkEye') === SPECIAL.USES_PER_GAME - 1,
      `and does not spend it again, left ${g.usesLeft('hawkEye')}`);
    ok(g.stats.you.specials === 1, `nor double-count it, got ${g.stats.you.specials}`);
  }

  // --- 空振りしただけでは回数は減らない（自動発動なので、振り損ねの罰にはしない） ---
  {
    const g = rally(['hawkEye']);
    g.you.z = -9; g.you.speed = 0;
    ballAt(g, 1.0);
    chargeUp(g);
    g.chargeRelease();
    ok(g.you.special === 'hawkEye', 'precondition: the move is on this swing');
    // 当たらないところへボールを動かして、スイングの有効時間を使い切らせる
    Object.assign(g.ball, { x: 8, y: 1, z: 5, vx: 0, vy: 0, vz: 0, bounces: 1 });
    for (let i = 0; i < 30 && g.you.swing > 0; i++) g.update(1 / 60);
    ok(g.ball.last === 'cpu', 'precondition: the swing missed');
    ok(g.usesLeft('hawkEye') === SPECIAL.USES_PER_GAME,
      `a whiff does not spend the move, left ${g.usesLeft('hawkEye')}`);
    ok(g.stats.you.specials === 0, 'and it is not counted in the stats');
  }

  // --- 回数は技ごとに独立。使い切った技は飛ばして、次の候補がその場面を拾う ---
  {
    const g = rally(['buggyWhip', 'hawkEye']);
    g.you.z = -9;
    ballAt(g, 1.0);
    chargeUp(g);    // 振り回されたフォアのトップスピンを溜めて打つ場面＝
    draggedWide(g); // バギーホイップ（優先度が上）と鷹の目の両方が条件を満たす
    ok(g.pickSpecial() === 'buggyWhip', `precondition: the buggy whip is picked first, got ${g.pickSpecial()}`);
    g.spendSpecial('buggyWhip');
    ok(g.usesLeft('buggyWhip') === 0 && g.usesLeft('hawkEye') === SPECIAL.USES_PER_GAME,
      'spending one move does not touch the others');
    ok(g.pickSpecial() === 'hawkEye',
      `a spent move is skipped for the next matching one, got ${g.pickSpecial()}`);
  }

  // --- キックサーブ：溜めすぎてもフォールトせず、ボックスに入り、1バウンド目で大きく跳ねる ---
  {
    const g = new R.Game({ input: idle, hooks: noHooks });
    g.setSpecials(['kickServe']);
    g.start();
    // 0.97秒溜める＝ゲージの線（SERVE.CHARGE_SWEET_T=0.56秒）をはるかに超えた溜めすぎ。
    // トスが落ちきる（約1.03秒）前に離せる長さにしてある。
    const OVER_FRAMES = 58;
    ok(g.serveFaultChance(OVER_FRAMES / 60) > 0.9,
      `precondition: that hold would normally almost always fault, got ${g.serveFaultChance(OVER_FRAMES / 60).toFixed(2)}`);
    tossAndHit(g, OVER_FRAMES, 'top', true);
    ok(g.you.special === 'kickServe', `the kick serve is armed on release, got ${g.you.special}`);
    ok(g.you.serveMiss === false, 'an over-charged kick serve is not faulted');
    ok(g.ball.spin === 'top' && g.ball.kick === true, 'the kick serve is a topspin ball marked to kick up');
    const L = R.physics.predictLanding(g.ball);
    ok(!L.net && L.z > 0 && L.z <= COURT.SERVICE + COURT.LINE_SLACK && Math.abs(L.x) <= HW + COURT.LINE_SLACK,
      `and it lands in the service box: x=${L.x.toFixed(2)} z=${L.z.toFixed(2)} net=${L.net}`);

    // 着地の瞬間に跳ね上げ、目印は消える（2バウンド目以降は普通に弾む）
    for (let i = 0; i < 300 && g.ball.bounces === 0; i++) g.update(1 / 60);
    ok(g.ball.bounces === 1 && g.ball.kick === false, 'the kick flag is consumed by the first bounce');
    ok(g.ball.vy > 0, `and the ball is kicking up after it, vy=${g.ball.vy.toFixed(2)}`);
  }

  // --- キックサーブ：ふつうに（ゲージの線で）離しても出る ---
  // 離してから当たるまで約0.2秒ある（swingServe）。上の溜めすぎの1本はトスがもう低く、
  // 離した瞬間に当たるので、この待ちの間に技が消える不具合（tickSpecial が swing を
  // 使わないサーブの技を次のフレームで消していた）を素通りしていた。
  {
    const g = new R.Game({ input: idle, hooks: noHooks });
    g.setSpecials(['kickServe']);
    g.start();
    g.chargeStart('top', true);
    for (let f = 0; f < Math.round(SERVE.CHARGE_SWEET_T * 60); f++) g.update(1 / 60);
    g.chargeRelease();
    ok(g.phase === 'serve' && g.serveSwing && g.serveSwing.t > 0.05,
      `precondition: released on the line, the racket is still on its way up, swing=${JSON.stringify(g.serveSwing)}`);
    // untilServed() は球だけを進める（tickSpecial を通らない）ので、ここは実際の試合と同じく
    // update() でフレームを進めて当たるのを待つ。
    for (let f = 0; f < 60 && g.phase === 'serve'; f++) g.update(1 / 60);
    ok(g.phase === 'rally', 'precondition: the serve was struck');
    ok(g.ball.spin === 'top' && g.ball.kick === true,
      `a kick serve released on the line is still a kick serve, spin=${g.ball.spin} kick=${g.ball.kick}`);
    ok(g.usesLeft('kickServe') === 0, 'and it spends the kick serve');
  }

  // --- キックサーブは専用のキー（K）だけ：選んでいても B/V/C のサーブは普通のサーブ ---
  // 以前は「自分のサーブ」だけが条件で、回数が残る限りどのサーブもキックサーブになっていた。
  {
    const g = new R.Game({ input: idle, hooks: noHooks });
    g.setSpecials(['kickServe']);
    g.start();
    const before = g.specialAim();
    ok(before && before.move === null && /K/.test(before.hint || ''),
      `before the toss, the HUD tells how to kick, got ${JSON.stringify(before)}`);
    g.chargeStart('flat');
    ok(g.specialAim() === null, 'a B toss shows no special at all');
    for (let f = 0; f < Math.round(SERVE.CHARGE_SWEET_T * 60); f++) g.update(1 / 60);
    g.chargeRelease();
    for (let f = 0; f < 60 && g.phase === 'serve'; f++) g.update(1 / 60);
    ok(g.phase === 'rally' && g.ball.kick === false && g.ball.spin === 'flat',
      `a B serve stays a plain flat serve, kick=${g.ball.kick} spin=${g.ball.spin}`);
    ok(g.usesLeft('kickServe') === SPECIAL.USES_PER_GAME, 'and the kick serve is not spent');

    // K はサーブのトス以外では何もしない（握らない＝B/V/C を塞がない）
    ok(g.chargeStart('top', true) === false && !g.you.charging, 'K does nothing during a rally');
    const recv = new R.Game({ input: idle, hooks: noHooks });
    recv.setSpecials(['kickServe']);
    recv.start(false, 'cpu');
    ok(recv.chargeStart('top', true) === false && !recv.you.charging, 'nor while waiting for the CPU serve');
    // 使い切っていれば、K のトスは普通のトップスピンのサーブ（HUD は使用済みと出す）
    const spent = new R.Game({ input: idle, hooks: noHooks });
    spent.setSpecials(['kickServe']);
    spent.start();
    spent.spendSpecial('kickServe');
    ok(spent.specialAim() === null, 'with no kick left, nothing is suggested before the toss');
    spent.chargeStart('top', true);
    const aim = spent.specialAim();
    ok(aim && aim.move === null && aim.spent === R.config.SPECIAL_MOVES[0].label,
      `a K toss with no kick left says it is spent, got ${JSON.stringify(aim)}`);
  }

  // --- 縮地：打点まで瞬間移動し、残像を残し、スイングの有効時間が伸びる ---
  {
    const g = rally(['shukuchi']);
    // 相手のベースラインから自陣のサイドライン際へ、0.62秒で突き刺さる速いパッシング
    // （solveShot を通すので、ネットを越える本物の軌道になる）
    const hitFrom = { x: 0, y: 1.0, z: 9 };
    const hitTo = { x: 4.0, y: R.config.PHYSICS.BALL_R, z: -9 };
    Object.assign(g.ball, {
      x: hitFrom.x, y: hitFrom.y, z: hitFrom.z,
      px: hitFrom.x, py: hitFrom.y, pz: hitFrom.z,
      bounces: 0, spin: 'flat', wind: 0,
    }, R.physics.solveShot(hitFrom, hitTo, 0.62));
    g.you.x = -4; g.you.z = -10; // 逆サイドに立っている＝走っても間に合わない
    ok(!R.physics.predictLanding(g.ball).net, 'precondition: the ball clears the net');
    ok(g.predictContact() === null, 'precondition: the ball is out of reach');
    ok(g.dashUnreachable(), 'precondition: and running cannot get there in time');
    ok(!!g.dashSpot(), 'but there is a spot to dash to');
    ok(g.pickSpecial() === 'shukuchi', `an unreachable ball picks shukuchi, got ${g.pickSpecial()}`);

    const from = { x: g.you.x, z: g.you.z };
    g.chargeStart();
    g.chargeRelease();
    ok(Math.hypot(g.you.x - from.x, g.you.z - from.z) > 2,
      `shukuchi teleports to the contact point, moved ${Math.hypot(g.you.x - from.x, g.you.z - from.z).toFixed(1)}m`);
    ok(g.you.dash && g.you.dash.x === from.x && g.you.dash.z === from.z,
      'and leaves an afterimage where it started');
    ok(g.you.swing > PLAYER.SWING_WINDOW,
      `and extends the swing window to reach the ball, got ${g.you.swing.toFixed(2)}`);

    // そのまま進めると実際に打ち返せている
    for (let i = 0; i < 180 && g.ball.last !== 'you' && g.phase === 'rally'; i++) g.update(1 / 60);
    ok(g.ball.last === 'you', 'and the ball is actually returned');
    // 残像は FX_T 秒で消える
    for (let i = 0; i < 60 && g.you.dash; i++) g.update(1 / 60);
    ok(g.you.dash === null, 'the afterimage fades away');
  }

  // --- 縮地は「ボールが十分に離れている」ときだけ。ギリギリ届かない球では出ない ---
  // (要望: ボールとの距離が一定以上ないと発動しないようにする。手を伸ばせば届きそうな
  //  球でも、速く通り過ぎる球は2バウンド目が遠いので「走っても間に合わない」が成立して
  //  しまい、そのままだと縮地が出ていた)
  {
    const { MIN_DIST } = SPECIAL.DASH;
    /** 自分の横 d メートルを、ベースラインへ速く抜けていく球 */
    const passingAt = (d) => {
      const g = rally(['shukuchi']);
      g.you.x = 0; g.you.z = -9;
      Object.assign(g.ball, {
        x: d, y: 1.0, z: -9, px: d - 0.02, py: 0.99, pz: -8.88,
        vx: 0.4, vy: 0.6, vz: -14, bounces: 1, spin: 'flat', wind: 0, curve: 0,
      });
      return g;
    };

    // ぎりぎり届かない距離（ラケットは1.55m）。走っても間に合わないが、縮地は出さない
    const close = passingAt(MIN_DIST - 0.8);
    ok(close.predictContact() === null, 'precondition: just out of racket reach');
    ok(close.dashUnreachable(), 'precondition: and running cannot catch it either');
    ok(Math.abs(close.ballDistance() - (MIN_DIST - 0.8)) < 1e-9,
      `precondition: the ball is ${(MIN_DIST - 0.8).toFixed(1)}m away`);
    ok(close.pickSpecial() === null,
      `a ball that is barely out of reach does not trigger shukuchi, got ${close.pickSpecial()}`);

    // 十分に離れていれば出る
    const far = passingAt(MIN_DIST + 0.4);
    ok(far.pickSpecial() === 'shukuchi',
      `a ball clearly out of reach does, got ${far.pickSpecial()}`);
  }

  // --- 縮地は「走っても間に合わない球」だけ。早く離しただけの普通の球では出ない ---
  // (退行テスト: 条件が「いま振っても届かない」だけだった頃は、溜めを少し早く離すと
  //  ほぼ毎回この技が出てしまい、他の技が出る場面がなくなっていた)
  {
    const g = rally(['shukuchi']);
    g.cpu.x = 0; g.cpu.z = 9;
    Object.assign(g.ball, { x: 0, y: 1.0, z: 9, bounces: 1, vx: 0, vy: 0, vz: 0 });
    g.hit('cpu');
    const target = R.physics.predictLanding(g.ball);
    g.you.x = target.x; g.you.z = target.z - 1; // 落下点のすぐそばに立っている
    ok(g.predictContact() === null, 'precondition: not reachable within this swing yet');
    ok(!g.dashUnreachable(), 'precondition: but it is comfortably runnable');
    ok(g.pickSpecial() === null, `a runnable ball does not trigger shukuchi, got ${g.pickSpecial()}`);
  }

  // --- どの必殺技も相手コートに入る（狙いのばらつきは0＝ラインを割らない） ---
  {
    /** move を乗せて1本打ち、着地点を返す */
    const landing = (move, place) => {
      const g = rally([move]);
      place(g);
      g.you.special = move;
      g.hit('you');
      return R.physics.predictLanding(g.ball);
    };
    const cases = [
      ['dunkSmash', (g) => { g.you.z = -3; ballAt(g, 2.6, 0.3, 0); }],
      ['divingVolley', (g) => { g.you.z = -3; ballAt(g, 1.0, 0.3, 0); }],
      ['driveVolley', (g) => { g.you.z = -9; ballAt(g, 1.2, 0.3, 0); }],
      ['jackknife', (g) => { g.you.x = 2; g.you.z = -9.5; ballAt(g, 1.8, 0.2, 1, 1); }],
      ['buggyWhip', (g) => { g.you.z = -9; ballAt(g, 1.0); }],
      ['hawkEye', (g) => { g.you.z = -9; ballAt(g, 1.0); }],
      ['tweener', (g) => { g.you.z = -10.5; ballAt(g, 1.0, -1.2); }],
      ['rising', (g) => onTheRise(g)],
    ];
    cases.forEach(([move, place]) => {
      let outs = 0;
      let worst = null;
      for (let i = 0; i < 40; i++) {
        const L = landing(move, place);
        if (!inOpponentCourt(L)) { outs++; worst = L; }
      }
      ok(outs === 0, `${move} always lands in the opponent court: ${outs}/40 out`
        + (worst ? ` (worst x=${worst.x.toFixed(2)} z=${worst.z.toFixed(2)} net=${worst.net})` : ''));
    });

    // 鷹の目はサイドラインぎりぎり（狙いが荒れない）
    const hawk = landing('hawkEye', (g) => { g.you.z = -9; ballAt(g, 1.0); });
    ok(Math.abs(Math.abs(hawk.x) - HW) < 0.35,
      `the hawk eye lands right on the sideline: |x|=${Math.abs(hawk.x).toFixed(2)} (sideline ${HW})`);
    // ダンクスマッシュは通常のスマッシュより速い
    const dunkSpeed = (special) => {
      const g = rally(['dunkSmash']);
      g.you.z = -3;
      ballAt(g, 2.6, 0.3, 0);
      g.you.swingCharge = 1;
      g.you.special = special;
      g.hit('you');
      return Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz);
    };
    ok(dunkSpeed('dunkSmash') > dunkSpeed(null) * 1.35,
      `the dunk smash is far faster than a normal smash: ${dunkSpeed('dunkSmash').toFixed(1)} vs ${dunkSpeed(null).toFixed(1)} m/s`);
    // 実戦で出る場面（前に詰めた位置）では 240km/h 以上の決め球になっている
    {
      const kmh = R.math.mpsToKmh(dunkSpeed('dunkSmash'));
      ok(kmh > 240, `and it is a genuine put-away from the net: ${kmh.toFixed(0)}km/h`);
    }
    // ベースライン後方から叩いても初速は頭打ちになる（距離ぶん飛翔時間を伸ばす）
    {
      const dunkKmh = (z) => {
        const g = rally(['dunkSmash']);
        g.you.z = z;
        ballAt(g, 2.4, 0.3, 0);
        g.you.special = 'dunkSmash';
        g.hit('you');
        return R.math.mpsToKmh(Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz));
      };
      const near = dunkKmh(-5);
      const deep = dunkKmh(-12);
      const cap = R.math.mpsToKmh(SPECIAL.DUNK.MAX_SPEED);
      ok(deep < cap * 1.05, `a dunk smash from deep is capped near MAX_SPEED: ${deep.toFixed(0)}km/h (cap ${cap.toFixed(0)})`);
      ok(deep <= near * 1.05,
        `and the extra distance does not make it faster: deep ${deep.toFixed(0)} vs near ${near.toFixed(0)}km/h`);
    }
  }

  // --- ツイーナー：相手の位置で打ち分け、背走で追いつけるようにする ---
  {
    const { TWEENER } = SPECIAL;
    /** 打球が飛翔中にいちばん高く上がる高さ(m)（predictApex は高さを返さないので自前で追う） */
    const apexY = (ball) => {
      const s = Object.assign({}, ball);
      let top = s.y;
      for (let i = 0; i < 240 * 5; i++) {
        R.physics.integrate(s, 1 / 240);
        top = Math.max(top, s.y);
        if (s.y <= R.config.PHYSICS.BALL_R && s.vy < 0) break;
      }
      return top;
    };
    /** 抜かれた球（自分のすぐ後ろ）をツイーナーで1本打ち、その打球を調べる */
    const tweener = (foeZ, foeX = 0, moveX = 0) => {
      const g = rally(['tweener'], { moveX, moveZ: 0, lob: false });
      g.you.x = 0; g.you.z = -12;
      g.cpu.x = foeX; g.cpu.z = foeZ;
      ballAt(g, 0.9, -1.2);
      g.you.special = 'tweener';
      g.hit('you');
      return {
        land: R.physics.predictLanding(g.ball),
        apex: apexY(g.ball),
        kmh: R.math.mpsToKmh(Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz)),
        reactBonus: g.ball.reactBonus,
        label: g.lastShotBy.you,
      };
    };

    // 詰めてきた相手には頭上を越すロブ、下がっている相手には低く速い抜き球
    const vsNet = tweener(2.0);
    const vsBack = tweener(10.5);
    ok(inOpponentCourt(vsNet.land) && inOpponentCourt(vsBack.land),
      `both tweener shots land in: net ${JSON.stringify(vsNet.land)} back ${JSON.stringify(vsBack.land)}`);
    ok(vsNet.apex > vsBack.apex + 1.5,
      `vs a net rusher the tweener goes up and over: apex ${vsNet.apex.toFixed(2)}m vs ${vsBack.apex.toFixed(2)}m`);
    ok(vsBack.kmh > vsNet.kmh * 1.3,
      `vs a deep opponent it is a fast passing shot instead: ${vsBack.kmh.toFixed(0)}km/h vs ${vsNet.kmh.toFixed(0)}km/h`);
    ok(vsNet.land.z > COURT.SERVICE && vsBack.land.z > COURT.SERVICE,
      `both land deep, past the service line: ${vsNet.land.z.toFixed(2)} / ${vsBack.land.z.toFixed(2)}`);

    // 無入力なら相手のいない側へ逃がす（←→ を入れればそちらが優先）
    ok(tweener(2.0, 2.5).land.x < 0 && tweener(2.0, -2.5).land.x > 0,
      'with no input the tweener goes away from the opponent');
    // ←→ の入力（画面基準。world へは INPUT_X_TO_WORLD で反転）を入れればそちらが優先
    ok(tweener(2.0, 2.5, -1).land.x > 0 && tweener(2.0, -2.5, 1).land.x < 0,
      'and the arrow keys override that choice');

    // 背を向けて打つので相手の出足が遅れる（この1打だけ）
    ok(vsNet.reactBonus === TWEENER.REACT_BONUS && vsBack.reactBonus === TWEENER.REACT_BONUS,
      `the tweener delays the opponent's reaction by ${TWEENER.REACT_BONUS}s, got ${vsNet.reactBonus}`);
    {
      const g = rally(['tweener']);
      g.you.z = -12;
      ballAt(g, 0.9, -1.2);
      g.you.special = 'tweener';
      g.hit('you');
      g.lastBallOwnerSeen = null;
      g.updateReactTimers(0);
      const withTweener = g.reactTimers.cpu;
      // 次の普通の1打では戻る（技の「読みにくさ」を持ち越さない）
      g.ball.last = 'cpu';
      ballAt(g, 1.0);
      g.you.special = null;
      g.hit('you');
      g.lastBallOwnerSeen = null;
      g.updateReactTimers(0);
      ok(withTweener > g.reactTimers.cpu + TWEENER.REACT_BONUS * 0.9,
        `the delay is on the tweener only: ${withTweener.toFixed(3)}s vs ${g.reactTimers.cpu.toFixed(3)}s`);
    }

    // 抜かれた球を背走で追っている間だけ足が速くなる
    {
      const back = { moveX: 0, moveZ: -1, lob: false };
      const fwd = { moveX: 0, moveZ: 1, lob: false };
      /** 「ロブで抜かれて、自分より後ろを転がっていく球」の状態を作る */
      const passedMe = (g) => {
        g.you.x = 0; g.you.z = -11;
        g.ball.x = 0; g.ball.y = 1.2; g.ball.z = -12.5;
        g.ball.vx = 0; g.ball.vy = 0; g.ball.vz = -12;
        g.ball.bounces = 1;
      };
      const chasing = rally(['tweener'], back); passedMe(chasing);
      const running = rally(['tweener'], fwd); passedMe(running);
      const noGear = rally([], back); passedMe(noGear);
      // 走り比べ用（下がり切る壁 PLAYER.Z_FAR_MARGIN に当たらないよう、ネット寄りから）
      const runA = rally(['tweener'], back); passedMe(runA); runA.you.z = -4;
      const runB = rally([], back); passedMe(runB); runB.you.z = -4;
      const notYet = rally(['tweener'], back);
      notYet.you.z = -11; ballAt(notYet, 1.0); // まだ自分より前にある球
      const usedUp = rally(['tweener'], back); passedMe(usedUp);
      usedUp.specialUses.tweener = 0;

      ok(chasing.tweenerChaseMult() === TWEENER.CHASE_MULT,
        `chasing down a ball that passed you is faster, got ${chasing.tweenerChaseMult()}`);
      ok(running.tweenerChaseMult() === 1, 'but only while running backwards');
      ok(noGear.tweenerChaseMult() === 1, 'and only with the tweener equipped');
      ok(notYet.tweenerChaseMult() === 1, 'a ball still in front of you does not speed you up');
      ok(usedUp.tweenerChaseMult() === 1, 'nor does one when the tweener is already used up');

      // 実際に移動が速くなる（0.8秒下がり続けたときの距離と最高速で見る）
      const ranBack = (g) => {
        const from = g.you.z;
        for (let i = 0; i < 48; i++) {
          g.ball.z = g.you.z - 1.5; // 追っている間ずっと「自分より後ろ」に居続ける球
          g.movePlayers(1 / 60);
        }
        return { dist: from - g.you.z, speed: g.you.speed };
      };
      const boosted = ranBack(runA);
      const plain = ranBack(runB);
      ok(boosted.dist > plain.dist * 1.25,
        `and it shows up in the actual run: ${boosted.dist.toFixed(2)}m vs ${plain.dist.toFixed(2)}m in 0.8s`);
      ok(Math.abs(boosted.speed - PLAYER.SPEED * TWEENER.CHASE_MULT) < 0.3
        && Math.abs(plain.speed - PLAYER.SPEED) < 0.3,
        `the top speed itself is multiplied: ${boosted.speed.toFixed(2)} vs ${plain.speed.toFixed(2)} m/s`);
    }

    // 専用モーションぶんの長さ（scene/player.js が体ごと反転させ、跳んで股を割る）
    {
      ok(TWEENER.ANIM > PLAYER.SWING_ANIM,
        `the tweener animation is longer than a normal swing, got ${TWEENER.ANIM}`);
      const g = rally(['tweener']);
      g.you.z = -12;
      ballAt(g, 0.9, -1.2);
      g.you.special = 'tweener';
      g.hit('you');
      ok(g.you.stroke === 'tweener' && g.you.anim === TWEENER.ANIM,
        `a tweener uses its own animation length, got ${g.you.stroke}/${g.you.anim}`);
      // 技はモーションが終わるまで残り（フォームの表示に使う）、終われば下りる
      g.you.swing = 0;
      g.update(TWEENER.ANIM - PLAYER.SWING_ANIM);
      ok(g.you.special === 'tweener' && g.you.anim > 0,
        'the move stays on while its longer motion plays');
      g.update(TWEENER.ANIM);
      ok(g.you.special === null && g.you.anim === 0,
        `and it is dropped once the motion ends, got ${g.you.special}`);
      // 次の普通の1打は通常の長さに戻る（前の技の長さを持ち越さない）
      g.ball.last = 'cpu';
      ballAt(g, 1.0);
      g.hit('you');
      ok(g.you.stroke !== 'tweener' && g.you.anim === PLAYER.SWING_ANIM,
        `a normal groundstroke still uses SWING_ANIM, got ${g.you.stroke}/${g.you.anim}`);
    }

    // 真横を通り過ぎる球では出ない＝ふつうのストロークが勝手にツイーナーにならない
    // （ユーザー報告）。自動プレイで実際に誤爆していた18件の形をそのまま置いてある：
    // 横へ 1.8〜2.6m ずれているのに、後ろへは 0.16〜1.28m しか入っていない球。
    {
      const wide = [
        [0.69, 1.91], [0.59, 2.54], [0.20, 2.34], [1.28, 2.25], [0.16, 2.37], [0.90, 1.90],
      ];
      wide.forEach(([behind, side]) => {
        const g = rally(ALL);
        g.you.x = 0; g.you.z = -9;
        Object.assign(g.ball, {
          x: side, y: 1.0, z: -9 - behind, vx: 0, vy: 0, vz: -6, bounces: 1,
        });
        const pick = g.pickSpecial();
        ok(pick !== 'tweener',
          `a ball ${side}m to the side and only ${behind}m behind is a normal stroke, got ${pick}`);
      });
      // 同じ「後ろへの距離」でも、真後ろに回り込んでいればツイーナーの場面
      const straight = rally(ALL);
      straight.you.x = 0; straight.you.z = -9;
      Object.assign(straight.ball, {
        x: 0.3, y: 1.0, z: -10.2, vx: 0, vy: 0, vz: -6, bounces: 1,
      });
      ok(straight.pickSpecial() === 'tweener',
        `but straight behind you it is: got ${straight.pickSpecial()}`);
      // 真後ろから45°（SIDE_RATIO=1.0）の外側は出ない＝境界がコースで決まっている
      const edge = (side) => {
        const g = rally(ALL);
        g.you.x = 0; g.you.z = -9;
        Object.assign(g.ball, {
          x: side, y: 1.0, z: -10.5, vx: 0, vy: 0, vz: -6, bounces: 1,
        });
        return g.pickSpecial();
      };
      ok(edge(1.2) === 'tweener' && edge(1.9) !== 'tweener',
        `the 45-degree cone is the line: inside=${edge(1.2)} outside=${edge(1.9)}`);
    }

    // ノーバウンドの球では出ない＝ふつうのボレーが勝手にツイーナーにならない
    // （ユーザー報告。リーチを広げたぶん、ネット際で体の横を通り過ぎる速い球が
    //  「わずかに後ろ」に入った瞬間に拾われていた）
    {
      /** ネット際で、体の横をノーバウンドで通り過ぎていく速い球 */
      const passingVolley = (g, youZ, dz, dx) => {
        g.you.x = 0; g.you.z = youZ;
        Object.assign(g.ball, {
          x: dx, y: 1.1, z: youZ + dz, vx: 0, vy: -1, vz: -20, bounces: 0,
        });
      };
      [[-2, -0.2, 0.4], [-2, -0.6, 1.2], [-4, -0.6, 0.4], [-6, -1.5, 1.2]].forEach(([z, dz, dx]) => {
        const g = rally(ALL);
        passingVolley(g, z, dz, dx);
        const pick = g.pickSpecial();
        ok(pick !== 'tweener',
          `a no-bounce ball past you at z=${z} is a volley, not a tweener: got ${pick}`);
      });
      // 同じ球でも、バウンドしていればツイーナーの場面
      const bounced = rally(ALL);
      passingVolley(bounced, -6, -1.2, 0.4);
      bounced.ball.bounces = 1;
      ok(bounced.pickSpecial() === 'tweener',
        `the same ball after a bounce is a tweener: got ${bounced.pickSpecial()}`);

      // 離した後に場面が変わった（ノーバウンドの球に当たった／もう自分より前にある）
      // ときは、当たる瞬間に技を下ろして普通の1打として打つ（回数も減らない）
      const onVolley = rally(['tweener']);
      onVolley.you.z = -3;
      onVolley.you.special = 'tweener';
      passingVolley(onVolley, -3, -1.2, 0.4); // bounces=0 のまま当たった
      onVolley.hit('you');
      ok(onVolley.you.special === null && onVolley.usesLeft('tweener') === 1,
        `a tweener that lands on a volley is dropped: special=${onVolley.you.special} uses=${onVolley.usesLeft('tweener')}`);
      ok(onVolley.lastShotBy.you !== SPECIAL_MOVES.find((m) => m.key === 'tweener').label,
        `and it is called as a normal shot: ${onVolley.lastShotBy.you}`);

      const inFront = rally(['tweener']);
      inFront.you.z = -10;
      inFront.you.special = 'tweener';
      ballAt(inFront, 1.0, 0.5); // 自分より前（ネット側）にある球
      inFront.hit('you');
      ok(inFront.you.special === null && inFront.usesLeft('tweener') === 1,
        'a tweener on a ball that is no longer behind you is dropped too');
    }

    // 抜かれた球は、縮地を装備していてもツイーナーが先に拾う（SPECIAL_MOVES の並び順）
    {
      /**
       * 後ろへ抜けたあと、横切るように体の真後ろへ流れてくる球。
       * いまは 2.6m 離れている（＝縮地の MIN_DIST を超える）が、伸びたリーチ（2.79m）の
       * 真後ろの扇に入ってくるので、ツイーナーにも縮地にも当てはまる。
       */
      const passedWide = (g) => {
        g.you.x = 0; g.you.z = -10;
        Object.assign(g.ball, {
          x: 2.0, y: 1.0, z: -12.6, vx: -12, vy: 1.5, vz: -1, bounces: 1,
          spin: 'flat', wind: 0, curve: 0, // 予測（縮地の判定）が風で揺れないように固定
        });
      };
      const t = rally(['tweener']); passedWide(t);
      const s = rally(['shukuchi']); passedWide(s);
      const both = rally(['tweener', 'shukuchi']); passedWide(both);
      ok(t.pickSpecial() === 'tweener' && s.pickSpecial() === 'shukuchi',
        `precondition: this ball matches both moves, got ${t.pickSpecial()} / ${s.pickSpecial()}`);
      ok(both.pickSpecial() === 'tweener',
        `a ball that got past you picks the tweener over shukuchi, got ${both.pickSpecial()}`);
    }
  }

  // --- 鷹の目は「足を止めて狙い澄ますグラウンドストローク」の技（ボレー／スマッシュでは出ない） ---
  // ユーザー報告「ノーバウンド返球（ボレー）でも鷹の目が発動する」。人間側だけ場面を
  // 見ていなかったため、ボレーがグラウンドストロークとして飛んでいた（hit() は技が
  // 乗った1打の打ち方を技に決めさせるため）。AI 側は最初から同じ条件で除いてある。
  {
    /** ネット前でノーバウンドの球に触る（＝ボレー）場面。しっかり溜めてある */
    const volleyScene = (g, youZ, y) => {
      g.you.x = 0; g.you.z = youZ;
      Object.assign(g.ball, {
        x: -0.3, y, z: youZ + 0.3, vx: 0, vy: -1, vz: -6, bounces: 0,
      });
      chargeUp(g);
    };
    [[-2, 0.8], [-3, 1.0], [-5, 1.4]].forEach(([youZ, y]) => {
      const g = rally(['hawkEye']);
      volleyScene(g, youZ, y);
      ok(g.pickSpecial() === null,
        `a volley at z=${youZ} (y=${y}) is not a hawk eye, got ${g.pickSpecial()}`);
    });
    // バウンドしていれば同じ高さ・同じ溜めでも鷹の目の場面
    const grounder = rally(['hawkEye']);
    volleyScene(grounder, -3, 1.0);
    grounder.ball.bounces = 1;
    ok(grounder.pickSpecial() === 'hawkEye',
      `the same ball after a bounce is a hawk eye, got ${grounder.pickSpecial()}`);
    // 頭上から叩く1打（スマッシュ）でも出ない＝そこはダンクスマッシュの領分
    const overhead = rally(['hawkEye']);
    volleyScene(overhead, -9, PLAYER.SMASH_MIN_Y + 0.3);
    overhead.ball.bounces = 1; // 跳ね上がってスマッシュの高さに来た球
    ok(overhead.pickSpecial() === null,
      `a ball high enough to smash is not a hawk eye, got ${overhead.pickSpecial()}`);

    // 打ち方が技に乗っ取られていないこと：ボレーはボレーのまま飛ぶ
    const hit = (specials) => {
      const g = rally(specials);
      volleyScene(g, -3, 1.0);
      g.chargeRelease();
      g.hit('you');
      return { stroke: g.you.stroke, special: g.you.special, call: g.lastShotBy.you };
    };
    const armed = hit(['hawkEye']);
    ok(armed.stroke === 'volley-forehand' && armed.special === null,
      `a volley stays a volley: stroke=${armed.stroke} special=${armed.special}`);
    ok(armed.call === hit([]).call, `and it is called a volley: ${armed.call}`);
  }

  // --- ジャックナイフ：高く弾んだ球を、足を止めてフラットのバックで叩く ---
  // バギーホイップ（フォア／トップスピン／走らされている）と背中合わせの条件。
  // 打点が高いほど速く・深くなるのがこの技の肝。
  {
    const { JACK } = SPECIAL;
    /** 高く弾んだ球をバックハンド側（world +x＝ラケット側の逆）に置く */
    const highBall = (g, y = 1.8, speed = 0) => {
      g.you.x = 2.0; g.you.z = -9.5; g.you.speed = speed;
      Object.assign(g.ball, {
        x: g.you.x - RACKET_SIDE_YOU * 0.5, y, z: g.you.z + 0.2, vx: 0, vy: -1, vz: -4, bounces: 1,
      });
    };
    const armed = (opt = {}) => {
      const g = rally(['jackknife', 'buggyWhip', 'hawkEye'],
        { moveX: opt.moveX || 0, moveZ: 0, lob: false });
      highBall(g, opt.y === undefined ? 1.8 : opt.y, opt.speed || 0);
      if (opt.fore) g.ball.x = g.you.x + RACKET_SIDE_YOU * 0.5; // フォアハンド側へ置き直す
      g.chargeStart(opt.spin || 'flat');
      g.you.chargeTime = CHARGE.MAX_TIME * (opt.charge === undefined ? 0.6 : opt.charge);
      return g;
    };

    ok(armed().pickSpecial() === 'jackknife',
      `a high bounced ball with a flat backhand picks the jackknife, got ${armed().pickSpecial()}`);
    ok(armed({ y: JACK.MIN_Y - 0.2 }).pickSpecial() !== 'jackknife',
      'but not on a ball below shoulder height');
    ok(armed({ spin: 'top' }).pickSpecial() !== 'jackknife'
      && armed({ spin: 'slice' }).pickSpecial() !== 'jackknife',
      'nor with topspin (V) or slice (C) — it is the flat (B) shot');
    ok(armed({ fore: true }).pickSpecial() !== 'jackknife',
      'nor on the forehand side');
    ok(armed({ speed: JACK.MAX_SPEED + 2 }).pickSpecial() !== 'jackknife',
      'nor while still running (that is the buggy whip situation)');
    ok(armed({ charge: JACK.MIN_CHARGE - 0.1 }).pickSpecial() !== 'jackknife',
      'nor on a barely-charged block return');
    // ノーバウンドの高い球はドライブボレー／ダンクスマッシュの領分
    {
      const g = armed();
      g.ball.bounces = 0;
      ok(g.pickSpecial() !== 'jackknife', `a no-bounce high ball is not a jackknife, got ${g.pickSpecial()}`);
    }

    /** 技を乗せて1本打ち、打球を調べる */
    const hitJack = (y, moveX = 0, youX = 2.0) => {
      const g = armed({ y, moveX });
      g.you.x = youX;
      g.ball.x = youX - RACKET_SIDE_YOU * 0.5;
      g.you.special = 'jackknife';
      g.you.swingCharge = 0.6;
      g.hit('you');
      return {
        land: R.physics.predictLanding(g.ball),
        kmh: R.math.mpsToKmh(Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz)),
        stroke: g.you.stroke,
        anim: g.you.anim,
      };
    };

    // 打点が高いほど速く、深くなる（MAX_Y より上は頭打ち）
    const low = hitJack(JACK.MIN_Y + 0.05);
    const high = hitJack(JACK.MAX_Y);
    const over = hitJack(JACK.MAX_Y + 0.3);
    ok(high.kmh > low.kmh * 1.4,
      `taking it high makes it much faster: ${low.kmh.toFixed(0)} → ${high.kmh.toFixed(0)}km/h`);
    ok(high.land.z > low.land.z + 1.0,
      `and deeper: z ${low.land.z.toFixed(2)} → ${high.land.z.toFixed(2)}`);
    ok(Math.abs(over.kmh - high.kmh) < 3,
      `above MAX_Y it is capped: ${over.kmh.toFixed(0)} vs ${high.kmh.toFixed(0)}km/h`);
    ok(inOpponentCourt(low.land) && inOpponentCourt(high.land),
      `both land in: ${JSON.stringify(low.land)} / ${JSON.stringify(high.land)}`);

    // 既定はダウン・ザ・ライン（自分が立っている側）、←→ で逆へ振れる
    ok(hitJack(1.8, 0, 2.0).land.x > 0 && hitJack(1.8, 0, -2.0).land.x < 0,
      'with no input it goes down the line, on the side you are standing');
    ok(hitJack(1.8, 1, 2.0).land.x < 0,
      'and the arrow keys swing it across court');

    // 専用モーション（跳んで叩く）
    ok(low.stroke === 'jackknife' && low.anim === JACK.ANIM,
      `it uses its own motion, got ${low.stroke}/${low.anim}`);
    ok(JACK.ANIM > PLAYER.SWING_ANIM, `which is longer than a normal swing, got ${JACK.ANIM}`);

    // 離した後に打点が落ちた／ノーバウンドで触った1打では技を下ろす
    {
      const g = armed();
      g.you.special = 'jackknife';
      g.ball.y = JACK.MIN_Y - 0.3; // 落ちてくるのを待ってしまった
      g.hit('you');
      ok(g.you.special === null && g.usesLeft('jackknife') === 1,
        `a jackknife on a ball that dropped is stood down: ${g.you.special}`);
    }

    // 跳躍は「溜めている間」に始まる＝跳んでから空中で振り始める。
    // 打球のモーション（anim）は hit() が当たった瞬間に入れるので、同じ時計に乗せると
    // 跳ぶのと振るのが同時になる。離した瞬間から跳ばせても、人はボールが来たところで
    // 離すので結局ほぼ同時になる（ユーザー報告）。tickLeap() が離す前から跳ばせる。
    {
      const g = armed();
      ok(!g.you.leap, 'precondition: not leaping yet');
      ok(g.pickSpecial() === 'jackknife', 'precondition: the jackknife is armed');
      // 球はもう届く位置にある＝「あと踏み切りぶんの時間で当たる」ので、
      // 溜めキーを離す前に跳び始める
      g.specialArmed = g.specialAim();
      g.tickLeap();
      ok(g.you.leap && g.you.leap.kind === 'jackknife' && g.you.leap.t === JACK.LEAP_T,
        `the leap starts while still charging, got ${JSON.stringify(g.you.leap)}`);
      ok(g.you.charging && g.you.anim === 0 && g.you.stroke !== 'jackknife',
        `before releasing: still charging, no swing yet (${g.you.stroke}/${g.you.anim})`);
      // 踏み切りぶん進めてから離すと、当たるころにはもう跳び上がっている
      const rise = JACK.LEAP_T * JACK.LEAP_RISE;
      for (let i = 0; i < Math.round(rise * 60); i++) g.update(1 / 60);
      // 1コマ(1/60秒)ぶんのスラック：跳躍は毎フレーム dt ずつ減るので端数が出る
      ok(g.you.leap && g.you.leap.t <= JACK.LEAP_T - rise + 1 / 60,
        `the leap keeps running on its own clock, got ${g.you.leap && g.you.leap.t.toFixed(3)}`);

      // 技が乗らない普通の1打では跳ばない
      const plain = rally(['jackknife']);
      plain.you.z = -9; ballAt(plain, 1.0);
      chargeUp(plain);
      plain.specialArmed = plain.specialAim();
      plain.tickLeap();
      plain.chargeRelease();
      ok(!plain.you.leap, `a normal swing does not leap, got ${JSON.stringify(plain.you.leap)}`);

      // ポイントをまたいで持ち越さない
      g.newPoint();
      ok(!g.you.leap, `a new point clears the leap, got ${JSON.stringify(g.you.leap)}`);
    }

    // 判定は「最初に届く点」ではなく「この1振りでいちばん高く捉えられる点」を見る
    // （ユーザー報告「結構高めでバックフラットを打っているつもりが発動しない」）。
    // 弾んで上がってくる球は、届きはじめの瞬間はまだ低い＝そこを見ると条件を満たす球が
    // 事実上なくなる（実測：ラリー中の「最初に届く点」の中央値は 0.16m）。
    {
      /** 目の前でバウンドして、届く範囲にいる間に胸の高さまで上がってくる球 */
      const risingBall = (g) => {
        g.you.x = 0; g.you.z = -10; g.you.speed = 0;
        Object.assign(g.ball, {
          x: 0.3, y: 0.35, z: -9.0, vx: 0, vy: 6, vz: -6, bounces: 1,
          spin: 'flat', wind: 0, curve: 0,
        });
        g.chargeStart('flat');
        g.you.chargeTime = CHARGE.MAX_TIME * 0.6;
      };
      const g = rally(['jackknife']);
      risingBall(g);
      ok(g.predictContact(1, 0).y < JACK.MIN_Y,
        `precondition: the first reachable point is still low (${g.predictContact(1, 0).y.toFixed(2)}m)`);
      ok(g.contactPeak(JACK.MIN_Y).y >= JACK.MIN_Y,
        `but it comes up to ${g.contactPeak(JACK.MIN_Y).y.toFixed(2)}m inside the swing window`);
      ok(g.pickSpecial() === 'jackknife',
        `so the jackknife is offered, got ${g.pickSpecial()}`);

      // 低いまま通り過ぎる球（上がってこない）では出ない
      const flat = rally(['jackknife']);
      risingBall(flat);
      flat.ball.vy = -1;
      ok(flat.contactPeak(JACK.MIN_Y).y < JACK.MIN_Y && flat.pickSpecial() !== 'jackknife',
        `a ball that never comes up is not offered, got ${flat.pickSpecial()}`);

      // 出せると言われても、**低い打点で当ててしまえば**技にはならない（回数も減らない）
      const early = rally(['jackknife']);
      risingBall(early);
      early.you.special = 'jackknife';
      early.hit('you'); // まだ y=0.35 のまま振ってしまった
      ok(early.you.special === null && early.usesLeft('jackknife') === 1
        && early.you.stroke !== 'jackknife',
        `hitting it early is just a normal backhand: ${early.you.stroke}/${early.you.special}`);

      // 引きつけて高い打点で捉えれば技になる
      const waited = rally(['jackknife']);
      risingBall(waited);
      waited.you.special = 'jackknife';
      waited.ball.y = JACK.MIN_Y + 0.2; // 上がってくるのを待ってから当てた
      waited.hit('you');
      ok(waited.you.stroke === 'jackknife' && waited.lastShotBy.you === 'ジャックナイフ',
        `waiting for it to come up gives the jackknife: ${waited.you.stroke}`);
    }

    // バギーホイップとは同じ1打で両立しない（フォア/バック・球種が背中合わせ）
    {
      const jackScene = armed();
      const whipScene = rally(['jackknife', 'buggyWhip']);
      whipScene.you.z = -9;
      draggedWide(whipScene);
      ballAt(whipScene, 1.0);
      ok(jackScene.pickSpecial() === 'jackknife' && whipScene.pickSpecial() === 'buggyWhip',
        `the two never overlap: ${jackScene.pickSpecial()} / ${whipScene.pickSpecial()}`);
    }
  }

  // --- バギーホイップの打球は空中で横に曲がる（それでも狙い通りに落ちる） ---
  {
    const BALL_R = R.config.PHYSICS.BALL_R;
    const g = rally(['buggyWhip']);
    g.you.x = -3; g.you.z = -9; g.you.speed = 5;
    ballAt(g, 1.0);
    g.you.special = 'buggyWhip';
    const start = { x: g.ball.x, z: g.ball.z };
    g.hit('you');
    // 曲がる向きは常に world +x（＝画面の右から左）。←→ の入力では変わらない。
    ok(g.ball.curve === SPECIAL.BUGGY.CURVE,
      `the shot curves toward +x (right to left on screen), got ${g.ball.curve}`);

    // 軌道を追って、打点→着地点を結ぶ直線からどれだけ膨らむかを測る
    const path = [];
    const sim = Object.assign({}, g.ball);
    for (let i = 0; i < 2000; i++) {
      R.physics.integrate(sim, 1 / 240);
      path.push({ x: sim.x, z: sim.z });
      if (sim.y <= BALL_R && sim.vy < 0) break;
    }
    const land = path[path.length - 1];
    const dx = land.x - start.x;
    const dz = land.z - start.z;
    const len = Math.hypot(dx, dz);
    const bow = path.reduce((max, p) => Math.max(
      max, Math.abs(((p.x - start.x) * dz - (p.z - start.z) * dx) / len),
    ), 0);
    ok(bow > 0.5, `the ball bows sideways in flight: ${bow.toFixed(2)}m off the straight line`);
    // 曲がるぶんは solveShot が織り込むので、着地は狙い（曲がった先のサイドライン際）のまま
    ok(Math.abs(land.x - SPECIAL.BUGGY.X) < 0.4,
      `and still lands on the aimed side line: x=${land.x.toFixed(2)} (aim ${SPECIAL.BUGGY.X})`);
    // 打ち出しは着地点より内側（＝真っ直ぐ出てから外へ曲がる）。曲がりを織り込まずに
    // 打ったら、この初速では中央寄りへ落ちてしまう＝「曲がって届いている」ことの裏取り。
    const straightX = start.x + g.ball.vx * 0.86;
    ok(straightX < land.x - 1,
      `the ball would fall well short of the line without the curve: ${straightX.toFixed(2)} vs ${land.x.toFixed(2)}`);
    // 曲がりはバウンドで消える（転がりながら曲がり続けない）
    const bounce = Object.assign({}, g.ball);
    for (let i = 0; i < 2000 && !(bounce.y <= BALL_R && bounce.vy < 0); i++) R.physics.integrate(bounce, 1 / 240);
    R.physics.reflectBounce(bounce);
    ok(bounce.curve === 0, `the curve is lost on the bounce, got ${bounce.curve}`);
  }

  // --- バギーホイップはフォアハンドのときだけ（バック側の球では出ない） ---
  {
    const fore = rally(['buggyWhip']);
    fore.you.z = -9;
    draggedWide(fore);
    ballAt(fore, 1.0); // ラケット側（world -x）の球＝フォアハンド
    ok(fore.currentStroke() === 'forehand', `precondition: forehand, got ${fore.currentStroke()}`);
    ok(fore.pickSpecial() === 'buggyWhip', `a forehand on the run picks it, got ${fore.pickSpecial()}`);

    const back = rally(['buggyWhip']);
    back.you.z = -9;
    draggedWide(back);
    ballAt(back, 1.0, 0.3, 1, 1); // 体の逆側（world +x）＝バックハンド
    ok(back.currentStroke() === 'backhand', `precondition: backhand, got ${back.currentStroke()}`);
    ok(back.pickSpecial() === null,
      `the same situation on the backhand side does not, got ${back.pickSpecial()}`);
  }

  // --- ドライブボレーはスマッシュになる高さでは出ない（腰〜頭の浮き球だけ） ---
  // (バグ報告: スマッシュできるくらい高い球でもドライブボレーが発動してしまう)
  {
    const { MIN_Y, MAX_Y } = SPECIAL.DRIVE;
    ok(MAX_Y === R.config.PLAYER.SMASH_MIN_Y,
      'the ceiling is the normal smash line, so the two cannot drift apart');

    // 頭上に上がった球（スマッシュの高さ）では出ない
    const high = rally(['driveVolley']);
    high.you.z = -9;
    ballAt(high, MAX_Y + 0.3, 0.3, 0);
    ok(high.pickSpecial() === null,
      `a ball high enough to smash is not a drive volley, got ${high.pickSpecial()}`);

    // ダンクスマッシュの高さ（さらに上）でも、ダンクの条件を満たしていなければ
    // ドライブボレーに落ちてこない（優先度の下の技が拾ってしまわないこと）
    const overhead = rally(['dunkSmash', 'driveVolley']);
    overhead.you.z = -9; // 前へ詰めていない＝ダンクの条件は満たさない
    ballAt(overhead, SPECIAL.DUNK.MIN_Y + 0.2, 0.3, 0);
    ok(overhead.pickSpecial() === null,
      `an overhead without the dunk conditions falls through to nothing, got ${overhead.pickSpecial()}`);

    // 上限のすぐ下なら従来どおり出る（＝止めているのは高さの上だけ）
    const justUnder = rally(['driveVolley']);
    justUnder.you.z = -9;
    ballAt(justUnder, MAX_Y - 0.05, 0.3, 0);
    ok(justUnder.pickSpecial() === 'driveVolley',
      `just below the smash line it still fires, got ${justUnder.pickSpecial()}`);

    // 下限の側も従来どおり（低すぎる球では出ない）
    const low = rally(['driveVolley']);
    low.you.z = -9;
    ballAt(low, MIN_Y - 0.1, 0.3, 0);
    ok(low.pickSpecial() === null,
      `and a ball that has not floated up enough still does not, got ${low.pickSpecial()}`);
  }

  // --- ダンクスマッシュは「前へ詰めながらの高いノーバウンド」だけ（溜めは不要） ---
  // (バグ報告: ワンバウンドの球でもダンクスマッシュになってしまう)
  {
    // ワンバウンドして高く跳ねた球では出ない（＝ただの高い打点の返球）
    const bounced = rally(['dunkSmash']);
    bounced.you.z = -3;
    rushingIn(bounced);
    ballAt(bounced, 2.6, 0.3, 1);
    ok(bounced.pickSpecial() === null,
      `a ball that has already bounced is not a dunk, got ${bounced.pickSpecial()}`);

    // 頭上まで上がっていない球では出ない（通常のスマッシュになる高さでもまだ足りない）
    const low = rally(['dunkSmash']);
    low.you.z = -3;
    rushingIn(low);
    ballAt(low, R.config.PLAYER.SMASH_MIN_Y + 0.05, 0.3, 0); // 普通のスマッシュの線は超える高さ
    ok(low.pickSpecial() === null,
      `a ball that is merely smash-height is not high enough to dunk, got ${low.pickSpecial()}`);
    ok(SPECIAL.DUNK.MIN_Y > R.config.PLAYER.SMASH_MIN_Y,
      'the dunk needs a higher ball than a normal smash');

    // 高さがちょうど線に届けば出る（＝止めているのは高さだけ）
    const justHigh = rally(['dunkSmash']);
    justHigh.you.z = -3;
    rushingIn(justHigh);
    ballAt(justHigh, SPECIAL.DUNK.MIN_Y, 0.3, 0);
    ok(justHigh.pickSpecial() === 'dunkSmash',
      `right at MIN_Y it does fire, got ${justHigh.pickSpecial()}`);

    // 通常のリーチ（PLAYER.REACH_Y）より高い球も、ダンクの上積み(REACH_Y_BONUS)で打てる
    const overhead = rally(['dunkSmash']);
    overhead.you.z = -3;
    rushingIn(overhead);
    ballAt(overhead, R.config.PLAYER.REACH_Y + 0.3, 0.3, 0);
    ok(overhead.pickSpecial() === 'dunkSmash',
      `a ball above the normal reach is still dunkable, got ${overhead.pickSpecial()}`);
    ok(overhead.predictContact(1, SPECIAL.DUNK.REACH_Y_BONUS).y > R.config.PLAYER.REACH_Y,
      'and it is struck above the normal reach ceiling, which only the dunk can do');

    // 前へ詰めていなければ出ない（止まって待って叩くのは普通のスマッシュ）
    const parked = rally(['dunkSmash']);
    parked.you.z = -3;
    ballAt(parked, 2.6, 0.3, 0);
    ok(parked.you.fwd === 0, 'precondition: standing still');
    ok(parked.pickSpecial() === null,
      `standing still is a normal smash, not a dunk, got ${parked.pickSpecial()}`);

    // 後ろへ下がりながらでも出ない（符号が逆）
    const backing = rally(['dunkSmash']);
    backing.you.z = -3;
    backing.you.fwd = -(SPECIAL.DUNK.MIN_FWD + 1);
    ballAt(backing, 2.6, 0.3, 0);
    ok(backing.pickSpecial() === null,
      `backing away is not a dunk either, got ${backing.pickSpecial()}`);

    // 前へ詰めながらの高いノーバウンドなら出る。しかも**溜めは要らない**
    // （走っている間は溜まらないので、溜めを条件にすると成立しなくなる）
    const rush = rally(['dunkSmash']);
    rush.you.z = -3;
    rushingIn(rush);
    ballAt(rush, 2.6, 0.3, 0);
    rush.chargeStart();
    ok(rush.you.chargeTime === 0, 'precondition: no charge at all');
    const armed = rush.specialAim();
    ok(armed && armed.move === 'dunkSmash',
      `rushing in on a high no-bounce ball dunks without any charge, got ${armed && armed.move}`);

    // 通常のスマッシュに要る溜め（PLAYER.SMASH_MIN_CHARGE）が無くても、
    // ダンクが乗った1打はスマッシュとして打たれる
    rush.chargeRelease();
    ok(rush.you.special === 'dunkSmash', 'and the move is armed on that swing');
    ok(rush.you.swingCharge < R.config.PLAYER.SMASH_MIN_CHARGE,
      `precondition: the swing is below the normal smash charge, got ${rush.you.swingCharge}`);
    rush.hit('you');
    ok(rush.you.stroke === 'smash', `it still swings as a smash, got ${rush.you.stroke}`);
    ok(rush.usesLeft('dunkSmash') === 0, 'and the use is spent');

    // 溜めを離したあとにバウンドを待ってしまった1打では技が下りる
    // （乗ったままだと、ワンバウンドの球がダンクとして打たれてしまう）
    const waited = rally(['dunkSmash']);
    waited.you.z = -3;
    rushingIn(waited);
    ballAt(waited, 2.6, 0.3, 0);
    ok(waited.pickSpecial() === 'dunkSmash', 'precondition: the dunk is armed on a no-bounce ball');
    waited.you.special = 'dunkSmash';
    const before = waited.usesLeft('dunkSmash');
    waited.ball.bounces = 1; // 振っている間にバウンドしてしまった
    waited.hit('you');
    ok(waited.you.special === null, `the armed dunk is dropped after a bounce, got ${waited.you.special}`);
    ok(waited.you.stroke !== 'smash', `and it is not swung as a smash, got ${waited.you.stroke}`);
    ok(waited.usesLeft('dunkSmash') === before,
      `and no use is spent, got ${waited.usesLeft('dunkSmash')} of ${before}`);
  }

  // --- バギーホイップはボレーでは出ない（走りながらのグラウンドストローク専用） ---
  // (バグ報告: ネット前でノーバウンドを触る1打までバギーホイップになってしまう)
  {
    // ボレーの技を装備していなくても、ネット前のノーバウンドでは候補にならない
    const volley = rally(['buggyWhip']);
    volley.you.z = -3; // サービスラインより前
    draggedWide(volley);
    ballAt(volley, 1.0, 0.3, 0); // ノーバウンド＝ボレーになる打点
    ok(volley.pickSpecial() === null,
      `a no-bounce ball at the net is a volley, not a buggy whip: got ${volley.pickSpecial()}`);

    // 同じ場面でもバウンド後（グラウンドストローク）なら出る＝止めているのはボレーだけ
    const ground = rally(['buggyWhip']);
    ground.you.z = -3;
    draggedWide(ground);
    ballAt(ground, 1.0, 0.3, 1);
    ok(ground.pickSpecial() === 'buggyWhip',
      `after the bounce at the same spot it still picks it, got ${ground.pickSpecial()}`);

    // 溜めを離したあとに前へ詰めて、結局ボレーになった1打でも技は下りる
    // （乗ったままだと打ち方の判定がボレーにならず、ボレーが曲がって飛んでしまう）
    const rushed = rally(['buggyWhip']);
    rushed.you.z = -9;
    draggedWide(rushed);
    ballAt(rushed, 1.0);
    ok(rushed.pickSpecial() === 'buggyWhip', 'precondition: the whip is armed from the baseline');
    rushed.you.special = 'buggyWhip';
    const before = rushed.usesLeft('buggyWhip');
    rushed.you.z = -3; // 溜めを離したあとにネット前へ詰めた
    ballAt(rushed, 1.0, 0.3, 0); // そこへノーバウンドの球が来た
    rushed.hit('you');
    ok(rushed.you.special === null, `the armed whip is dropped on a volley, got ${rushed.you.special}`);
    ok(rushed.ball.curve === 0, `and the volley does not curve, got ${rushed.ball.curve}`);
    ok(rushed.usesLeft('buggyWhip') === before,
      `and no use is spent, got ${rushed.usesLeft('buggyWhip')} of ${before}`);
  }

  // --- バギーホイップは「フォア側へ大きく振り回された」ときだけ ---
  // (要望: 右への走りがもっと長く、コートの右サイドにかなり寄っているときだけ出す)
  {
    const { MIN_X, MIN_RUN_X } = SPECIAL.BUGGY;

    // 走ってはいるが、まだコートの中央寄り＝出ない
    const middle = rally(['buggyWhip']);
    middle.you.z = -9; middle.you.speed = 5; middle.you.sinceRunT = 0; middle.you.chargeSpin = 'top';
    middle.you.x = -(MIN_X - 0.5);
    middle.you.runX = -(MIN_RUN_X + 1);
    ballAt(middle, 1.0);
    ok(middle.pickSpecial() === null,
      `still near the middle of the court: no buggy whip, got ${middle.pickSpecial()}`);

    // 右サイドにはいるが、そこまで走ってきていない（最初からそこに立っていた）＝出ない
    const parked = rally(['buggyWhip']);
    parked.you.z = -9; parked.you.speed = 5; parked.you.sinceRunT = 0; parked.you.chargeSpin = 'top';
    parked.you.x = -(MIN_X + 1);
    parked.you.runX = -(MIN_RUN_X - 0.5);
    ballAt(parked, 1.0);
    ok(parked.pickSpecial() === null,
      `standing wide without being dragged there: no buggy whip, got ${parked.pickSpecial()}`);

    // 逆サイド（左）へ走っていても出ない（符号が逆）
    const wrongWay = rally(['buggyWhip']);
    wrongWay.you.z = -9; wrongWay.you.speed = 5; wrongWay.you.sinceRunT = 0; wrongWay.you.chargeSpin = 'top';
    wrongWay.you.x = MIN_X + 1;
    wrongWay.you.runX = MIN_RUN_X + 1;
    ballAt(wrongWay, 1.0);
    ok(wrongWay.pickSpecial() === null,
      `dragged to the other side: no buggy whip, got ${wrongWay.pickSpecial()}`);

    // すべて満たして初めて出る
    const wide = rally(['buggyWhip']);
    wide.you.z = -9;
    draggedWide(wide);
    ballAt(wide, 1.0);
    ok(wide.pickSpecial() === 'buggyWhip',
      `dragged wide to the forehand side: buggy whip, got ${wide.pickSpecial()}`);

    // 同じ場面でも、押したキーがトップスピン(V)でなければ出ない
    // （大きく擦り上げて振り抜く打ち方そのものが技なので、フラット／スライスでは成立しない）
    for (const spin of ['flat', 'slice']) {
      const g = rally(['buggyWhip']);
      g.you.z = -9;
      draggedWide(g);
      g.you.chargeSpin = spin;
      ballAt(g, 1.0);
      ok(g.pickSpecial() === null,
        `the same situation with ${spin} does not: got ${g.pickSpecial()}`);
    }

    // 追いついて止まってから振っても、直前（RECENT_RUN_T 以内）まで走っていれば出る
    // (報告: 自分のバギーホイップがあまり狙って発動できない。離した瞬間の速さだけを
    //  見ていたので、止まって構えた時点で条件から外れていた)
    const { RECENT_RUN_T } = SPECIAL.BUGGY;
    const planted = rally(['buggyWhip']);
    planted.you.z = -9;
    draggedWide(planted);
    planted.you.speed = 0;
    planted.you.sinceRunT = RECENT_RUN_T - 0.05;
    ballAt(planted, 1.0);
    ok(planted.pickSpecial() === 'buggyWhip',
      `planted right after the sprint: still a buggy whip, got ${planted.pickSpecial()}`);

    // 止まってから時間が経っていれば、もう「走らされた1打」ではない
    const settled = rally(['buggyWhip']);
    settled.you.z = -9;
    draggedWide(settled);
    settled.you.speed = 0;
    settled.you.sinceRunT = RECENT_RUN_T + 0.05;
    ballAt(settled, 1.0);
    ok(settled.pickSpecial() === null,
      `set and waiting for a while: no buggy whip, got ${settled.pickSpecial()}`);
  }

  // --- 「直前まで走っていたか」は実際の移動から測る ---
  {
    const input = { moveX: 1, moveZ: 0, lob: false }; // 画面の右（world -x）へ走る
    const g = new R.Game({ input, hooks: noHooks });
    g.start();
    g.setSpecials(['buggyWhip']);
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -9;
    for (let i = 0; i < 40; i++) g.movePlayers(1 / 60);
    ok(g.you.sinceRunT === 0, `while sprinting it stays at 0, got ${g.you.sinceRunT}`);
    input.moveX = 0; // キーを離して止まる
    for (let i = 0; i < 30; i++) g.movePlayers(1 / 60);
    ok(g.you.speed === 0, `precondition: stopped, speed=${g.you.speed}`);
    // 減速のぶん（最高速から MIN_SPEED を切るまで）だけ 0.5 秒より短い
    ok(g.you.sinceRunT > SPECIAL.BUGGY.RECENT_RUN_T && g.you.sinceRunT < 0.5,
      `and it counts the time since the last running frame: ${g.you.sinceRunT.toFixed(3)}s`);
    // 次のポイントには持ち越さない
    g.you.sinceRunT = 0;
    g.newPoint();
    ok(g.you.sinceRunT > SPECIAL.BUGGY.RECENT_RUN_T,
      `a new point forgets the last point's sprint, got ${g.you.sinceRunT}`);
  }

  // --- 走った量（runX）は実際の移動から積まれる ---
  {
    // 画面の右（world -x）へ走り続ける入力
    const g = new R.Game({ input: { moveX: 1, moveZ: 0, lob: false }, hooks: noHooks });
    g.start();
    g.setSpecials(['buggyWhip']);
    g.phase = 'rally';
    g.you.x = 0; g.you.z = -9;
    for (let i = 0; i < 40; i++) g.movePlayers(1 / 60);
    ok(g.you.runX < -SPECIAL.BUGGY.MIN_RUN_X,
      `running right accumulates toward the racket side: runX=${g.you.runX.toFixed(2)}`);
    ok(Math.abs(g.you.runX - (g.you.x - 0)) < 1e-9,
      'and it is the net sideways displacement since the ball was struck');
  }

  // --- 走った量は相手が打つたびに数え直す（前の球で走った分を持ち越さない） ---
  {
    const g = rally(['buggyWhip']);
    g.you.z = -9;
    draggedWide(g);
    ballAt(g, 1.0);
    ok(g.pickSpecial() === 'buggyWhip', 'precondition: it is available now');
    g.resetChase(); // 新しい球が打たれた（hit()/serve()/newPoint() が呼ぶ）
    ok(g.you.runX === 0, 'the run is measured from the moment the ball was struck');
    ok(g.pickSpecial() === null, 'so it is not available on the next ball without running again');
  }

  // --- バギーホイップのコースは ←→ で2択。自分のいる側＝ストレート、それ以外＝クロス ---
  {
    const { NET_HALF } = R.config.COURT;
    /** youX に立って（ラケット側＝world -x）、moveX の入力で1本打つ */
    const whip = (youX, moveX) => {
      const g = rally(['buggyWhip'], { moveX, moveZ: 0, lob: false });
      g.you.z = -9;
      draggedWide(g);
      g.you.x = youX;
      ballAt(g, 1.0);
      ok(g.pickSpecial() === 'buggyWhip', `precondition: the whip is available at x=${youX}`);
      g.you.special = 'buggyWhip';
      g.hit('you');
      return { g, ...trace(g) };
    };

    // 画面の右（world -x）＝自分のいる側を指す入力。INPUT_X_TO_WORLD が反転するので moveX は +1
    const STRAIGHT = 1;
    const CROSS = -1;

    // サイドラインの外まで追い出されていれば、ネットポストの外を回って戻ってくる
    {
      const { g, cross, land } = whip(-5.0, STRAIGHT);
      ok(cross && Math.abs(cross.x) > NET_HALF,
        `the straight whip passes outside the net post: |x|=${cross && Math.abs(cross.x).toFixed(2)} (post ${NET_HALF})`);
      ok(cross && !cross.hitsNet, 'and there is no net out there to catch it');
      ok(land && land.x < 0 && Math.abs(land.x) <= HW && land.z > 0 && land.z <= HL,
        `and it lands down the line, in: x=${land && land.x.toFixed(2)} z=${land && land.z.toFixed(2)}`);
      ok(g.lastShotBy.you.indexOf('ポール回し') !== -1,
        `and it is called by that name, got ${g.lastShotBy.you}`);
    }

    // コートの内側すぎるとポールは回れない（＝ふつうの曲がるストレートになる）
    {
      const { g, cross, land } = whip(-3.0, STRAIGHT);
      ok(cross && Math.abs(cross.x) < NET_HALF,
        `from inside the court it cannot go around the post: |x|=${cross && Math.abs(cross.x).toFixed(2)}`);
      ok(cross && !cross.hitsNet, 'but it still clears the net');
      ok(land && land.x < 0 && Math.abs(land.x) <= HW && land.z > 0,
        `and still lands down the line, in: x=${land && land.x.toFixed(2)}`);
      ok(g.lastShotBy.you === 'バギーホイップ',
        `and keeps the plain name, got ${g.lastShotBy.you}`);
    }

    // 無入力／逆側の指定はクロス（従来どおり画面の左＝world +x のサイドライン際へ）
    [0, CROSS].forEach((moveX) => {
      const { cross, land } = whip(-5.0, moveX);
      ok(cross && Math.abs(cross.x) < NET_HALF, 'the cross-court whip goes over the net as usual');
      ok(land && Math.abs(land.x - SPECIAL.BUGGY.X) < 0.4,
        `and lands on the far side line: x=${land && land.x.toFixed(2)} (aim ${SPECIAL.BUGGY.X})`);
    });
  }

  // --- 必殺技以外の打球は曲がらない（curve は0のまま） ---
  {
    const g = rally(['buggyWhip']);
    g.you.z = -9; g.you.speed = 5;
    ballAt(g, 1.0);
    g.hit('you'); // 必殺技なしの普通のストローク
    ok(!g.ball.curve, `an ordinary shot does not curve, got ${g.ball.curve}`);
  }

  // --- 飛びつきボレーはリーチが伸び、その代わり打った後に長く動けない ---
  {
    const g = rally(['divingVolley']);
    g.you.z = -3;
    // 通常のリーチ(1.55)では届かないが、飛びつき(×1.95)なら届く距離に置く
    g.ball.x = g.you.x + 2.4;
    g.ball.y = 1.0;
    g.ball.z = g.you.z;
    g.ball.bounces = 0;
    ok(g.predictContact() === null, 'precondition: out of normal reach');
    ok(!!g.predictContact(SPECIAL.DIVE.REACH_MULT, 0), 'but within the diving reach');
    ok(g.pickSpecial() === 'divingVolley', `and the dive is offered, got ${g.pickSpecial()}`);

    g.chargeStart();
    g.chargeRelease();
    for (let i = 0; i < 30 && g.ball.last !== 'you'; i++) g.update(1 / 60);
    ok(g.ball.last === 'you', 'the dive actually reaches the ball');
    ok(g.recoverTimers.you === SPECIAL.DIVE.RECOVER,
      `and locks the player in place longer than a normal hit, got ${g.recoverTimers.you}`);
    // 飛び込み→伏せる→起き上がるのモーションは硬直と同じ長さ（起き上がり終わる＝動ける）
    ok(g.you.anim === SPECIAL.DIVE.RECOVER && g.you.stroke.indexOf('volley') === 0,
      `the dive motion lasts as long as the lock, got ${g.you.stroke}/${g.you.anim}`);
  }

  // --- 飛びつきボレーは球へ飛び込み、伸ばした体が届いたところで当たる ---
  // 以前は伸びたリーチ（3m）に入った瞬間に直立したまま当てていたので、ラケットと球が
  // 離れて見えた（ユーザー報告）。横を速く抜けていく球で確かめる：
  // ・飛び込み（you.dive）は目で追える長さ（LUNGE_MIN）以上ある
  // ・当たるのは球が体の真横を通るとき（通り過ぎてから後ろへ飛びつくのではない）
  // ・足元は球のほうへ移り、当たる瞬間の球は伸ばした体の届く距離の内側にある
  // ・フォア／バックは溜め始めの見込みではなく、飛び込む先で決まる
  {
    const { DIVE } = SPECIAL;
    const stretch = (y) => Math.sqrt(DIVE.BODY_REACH ** 2 - (y - DIVE.CONTACT_LIFT) ** 2);
    /** 体の横 side*2.7m を、前から 18m/s で抜けていく球に飛びつく */
    const passDive = (side, forceStroke) => {
      const g = rally(['divingVolley']);
      g.you.x = 0;
      g.you.z = -3;
      g.ball.x = side * 2.7;
      g.ball.y = 1.0;
      g.ball.z = -0.2;
      g.ball.vx = 0; g.ball.vy = 2; g.ball.vz = -18;
      g.ball.bounces = 0;
      g.ball.age = 0.5;
      const offered = g.pickSpecial();
      g.chargeStart();
      if (forceStroke) g.you.chargeStroke = forceStroke;
      g.chargeRelease();
      let span = null;
      let at = null;
      const hit = g.hit.bind(g);
      g.hit = (who) => {
        at = { x: g.ball.x, y: g.ball.y, z: g.ball.z, you: { x: g.you.x, z: g.you.z } };
        hit(who);
      };
      for (let i = 0; i < 40 && g.ball.last !== 'you'; i++) {
        g.update(1 / 60);
        if (g.you.dive && span === null) span = g.you.dive.span;
      }
      return { g, offered, span, at };
    };
    const fh = passDive(-1);
    ok(fh.offered === 'divingVolley', `precondition: the passing ball offers the dive, got ${fh.offered}`);
    ok(fh.g.ball.last === 'you' && !!fh.at, 'the dive returns the passing ball');
    ok(fh.span !== null && fh.span >= DIVE.LUNGE_MIN - 1e-6,
      `the lunge is long enough to see: ${fh.span && fh.span.toFixed(3)}s (min ${DIVE.LUNGE_MIN})`);
    if (fh.at) {
      const { at } = fh;
      const dz = at.z - at.you.z;
      ok(Math.abs(dz) < 0.5, `it meets the ball beside the body, not after it went past: dz=${dz.toFixed(2)}`);
      ok(at.you.x < -0.4, `the feet travel toward the ball: x=${at.you.x.toFixed(2)}`);
      const d = Math.hypot(at.x - at.you.x, at.z - at.you.z);
      ok(d <= stretch(at.y) + 0.05,
        `and the ball is within the stretched body's reach: ${d.toFixed(2)}m (reach ${stretch(at.y).toFixed(2)}m)`);
    }
    ok(fh.g.you.stroke === 'volley-forehand', `the racket side faces the ball, got ${fh.g.you.stroke}`);
    ok(!fh.g.you.dive, 'and the lunge is over once it hits');
    // 反対側（バック側）へ抜ける球：溜め始めにフォアの見込みだったとしても、バックで飛びつく
    const bh = passDive(1, 'forehand');
    ok(bh.g.ball.last === 'you' && bh.g.you.stroke === 'volley-backhand',
      `a ball on the backhand side is dived at with the backhand, got ${bh.g.you.stroke}`);
    ok(bh.at && bh.at.you.x > 0.4, `toward the backhand side: x=${bh.at && bh.at.you.x.toFixed(2)}`);
  }

  // --- 必殺技で決めたポイントは、球種ではなく技名でコールされる ---
  {
    const g = rally(['hawkEye']);
    g.you.z = -9;
    ballAt(g, 1.0);
    g.you.special = 'hawkEye';
    g.hit('you');
    ok(g.lastShotBy.you === '鷹の目', `the winning shot is named after the move, got ${g.lastShotBy.you}`);
  }

  // --- ライジング：ベースライン付近で、弾んだ直後の上がりばなを叩く ---
  // (要望: 必殺技「ライジング」。ベースライン付近で、ボールのあがりっぱなを打ち返す技)
  {
    const { RISING } = SPECIAL;
    /** 上がりばなの場面で溜め始めたところ（opt は onTheRise と、charge／spin／input） */
    const scene = (opt = {}, specials = ['rising']) => {
      const g = rally(specials, opt.input || idle);
      onTheRise(g, opt);
      g.chargeStart(opt.spin || 'flat');
      g.you.chargeTime = CHARGE.MAX_TIME * (opt.charge || 0);
      return g;
    };
    const picked = (opt, specials) => scene(opt, specials).pickSpecial();

    // 出る場面：溜めていなくても出る（相手の球威を使う打ち方なので、溜めは条件にしない）
    ok(picked() === 'rising', `a ball just off the bounce, taken on the baseline, picks the rising shot, got ${picked()}`);
    ok(picked({ charge: 1, spin: 'top' }) === 'rising', 'charged or with topspin it is the same shot');
    // 立ち位置はベースラインの内側 BASE_IN 〜 後ろ BASE_OUT の帯
    ok(picked({ youZ: -(HL - RISING.BASE_IN + 0.1) }) === 'rising'
      && picked({ youZ: -(HL + RISING.BASE_OUT - 0.1) }) === 'rising',
      'anywhere in the band around the baseline');
    ok(picked({ youZ: -(HL - RISING.BASE_IN - 0.5) }) === null,
      `not from well inside the court, got ${picked({ youZ: -(HL - RISING.BASE_IN - 0.5) })}`);
    ok(picked({ youZ: -(HL + RISING.BASE_OUT + 0.5) }) === null,
      `nor after backing off behind the baseline, got ${picked({ youZ: -(HL + RISING.BASE_OUT + 0.5) })}`);
    // 打点のタイミング：弾んでから MAX_SINCE 秒以内で、まだ上昇中
    ok(picked({ since: RISING.MAX_SINCE + 0.05 }) === null, 'not once the ball has been up for a while');
    ok(picked({ vy: -0.5 }) === null, 'nor once it has topped out and is dropping');
    ok(picked({ since: undefined }) === null, 'nor when it is unknown when the ball bounced');
    {
      const g = scene();
      g.ball.bounces = 0;
      ok(g.pickSpecial() === null, `nor on a ball that has not bounced, got ${g.pickSpecial()}`);
    }
    // つなぎのロブ／ドロップショットは「叩かない」ことを選んだ1打なので、化けさせない
    ok(picked({ input: { moveX: 0, moveZ: 0, lob: true } }) === null, 'a lob is left alone');
    ok(picked({ spin: 'slice', charge: 0 }) === null, 'so is a drop shot (C released at once)');
    ok(picked({ spin: 'slice', charge: 0.6 }) === 'rising', 'but a driven slice is still a rising shot');
    // 優先度：鷹の目より上（溜めてから上がりばなを捉えた1打は、鷹の目ではなくこちら）
    ok(picked({ charge: 1 }, ['rising', 'hawkEye']) === 'rising'
      && picked({ charge: 1 }, ['hawkEye']) === 'hawkEye',
      'it outranks the hawk eye, which still takes the same ball when rising is not equipped');
    ok(picked({ charge: 1 }, ALL) === 'rising', `with everything equipped it is the rising shot, got ${picked({ charge: 1 }, ALL)}`);

    // 実際の流れ：弾む前の球でも、打点の先読みが「弾んだ直後」なら離した瞬間に乗り、
    // 当たって回数を使い、技名でコールされる
    {
      const g = rally(['rising']);
      g.you.x = 0; g.you.z = -HL;
      Object.assign(g.ball, {
        x: -0.5, y: 0.4, z: -HL + 3.5, vx: 0, vy: -4, vz: -16, bounces: 0, spin: 'flat', wind: 0, curve: 0,
      });
      g.chargeStart();
      const c = g.predictContact();
      ok(c && c.bounces === 1 && c.vy > 0 && c.sinceBounce <= RISING.MAX_SINCE,
        `precondition: the first reachable point is just off the bounce, got ${JSON.stringify(c)}`);
      g.chargeRelease();
      ok(g.you.special === 'rising', `releasing arms it, got ${g.you.special}`);
      let hitAt = null;
      const hit = g.hit.bind(g);
      g.hit = (who) => { if (who === 'you') hitAt = { ...g.ball }; hit(who); };
      for (let i = 0; i < 30 && g.ball.last !== 'you'; i++) g.update(1 / 60);
      ok(hitAt && hitAt.bounces === 1 && hitAt.vy > 0 && hitAt.sinceBounce <= RISING.MAX_SINCE,
        `the ball really is met on the rise, got ${hitAt && hitAt.sinceBounce}`);
      ok(g.lastShotBy.you === 'ライジング' && g.usesLeft('rising') === SPECIAL.USES_PER_GAME - 1,
        `it connects as the rising shot, got ${g.lastShotBy.you} (left ${g.usesLeft('rising')})`);
      ok(g.you.stroke === 'forehand', `with the ordinary forehand swing, got ${g.you.stroke}`);
    }
    // 弾んでからの時間は実際のボールも同じ数え方（バウンドで0に戻り、そこから進む）
    {
      const g = rally([]);
      Object.assign(g.ball, {
        x: 0, y: 0.4, z: -5, vx: 0, vy: -4, vz: -10, bounces: 0, sinceBounce: 3, spin: 'flat', wind: 0, curve: 0,
      });
      for (let i = 0; i < 30 && g.ball.bounces === 0; i++) g.update(1 / 60);
      const first = g.ball.sinceBounce;
      ok(g.ball.bounces === 1 && first < 1 / 60, `the bounce resets the clock, got ${first}`);
      g.update(1 / 60);
      ok(Math.abs(g.ball.sinceBounce - first - 1 / 60) < 1e-6, 'and it runs with the ball after that');
    }

    // 離した後に引きつけすぎた（弾んでから時間が経った）1打では技を下ろす（回数も減らない）
    {
      const g = scene();
      g.you.special = 'rising';
      g.ball.sinceBounce = RISING.MAX_SINCE + 0.1;
      g.hit('you');
      ok(g.you.special === null && g.usesLeft('rising') === SPECIAL.USES_PER_GAME
        && g.lastShotBy.you !== 'ライジング',
        `waiting too long turns it back into a normal shot: ${g.lastShotBy.you}`);
    }

    /** 上がりばなを1本打ち、打球を調べる */
    const hitRising = (opt = {}) => {
      const g = rally(['rising'], opt.input || idle);
      onTheRise(g, opt);
      if (opt.cpuX !== undefined) g.cpu.x = opt.cpuX;
      g.you.swingCharge = opt.charge || 0;
      g.you.chargeSpin = 'flat';
      g.you.special = opt.special === undefined ? 'rising' : opt.special;
      g.hit('you');
      return {
        g,
        land: R.physics.predictLanding(g.ball),
        trace: trace(g),
        kmh: R.math.mpsToKmh(Math.hypot(g.ball.vx, g.ball.vy, g.ball.vz)),
      };
    };
    const median = (f, n = 15) => {
      const v = [];
      for (let i = 0; i < n; i++) v.push(f());
      return v.sort((a, b) => a - b)[Math.floor(n / 2)];
    };
    // 溜めていなくても、フル溜めの通常打と同じくらい速い（同じ溜めの通常打よりずっと速い）。
    // 低い打点では球速はネットの余裕で頭打ちになるので、フル溜めを「上回る」とまでは言えない
    // （0.3m で同じくらい、0.5m 以上で1割ほど上回る。SPECIAL.RISING のコメント参照）。
    [0.3, 0.6].forEach((y) => {
      const rising = median(() => hitRising({ y }).kmh);
      const tap = median(() => hitRising({ y, special: null }).kmh);
      const full = median(() => hitRising({ y, special: null, charge: 1 }).kmh);
      ok(rising > tap * 1.5, `met at ${y}m with no charge it is far faster than a plain tap: ${rising.toFixed(0)} vs ${tap.toFixed(0)}km/h`);
      ok(rising >= full * 0.97, `and as fast as a fully charged normal shot: ${rising.toFixed(0)} vs ${full.toFixed(0)}km/h`);
    });
    // 打点が低くてもネットに掛からない。hit() は打点を SHOT.SOLVE_MIN_Y の高さとして
    // 弾道を解くので、その差を余裕に足し戻していないと実際の球は1割強がネットになっていた
    [0.12, 0.2, 0.3, 0.45].forEach((y) => {
      for (let i = 0; i < 10; i++) {
        const { trace: t, land } = hitRising({ y });
        ok(t.cross && !t.cross.hitsNet && inOpponentCourt(land),
          `a rising shot met at ${y}m clears the net and lands in: ${JSON.stringify(t.cross)} ${JSON.stringify(land)}`);
      }
    });
    // 深く、相手のいない側へ。←→ を入れればそちらが優先
    {
      const right = hitRising({ cpuX: 2 }).land;
      const left = hitRising({ cpuX: -2 }).land;
      ok(right.x < 0 && left.x > 0, `with no input it goes away from the opponent: ${right.x.toFixed(2)} / ${left.x.toFixed(2)}`);
      ok(right.z > COURT.SERVICE + 2 && left.z > COURT.SERVICE + 2,
        `and deep: z ${right.z.toFixed(2)} / ${left.z.toFixed(2)}`);
      const aimed = hitRising({ cpuX: -2, input: { moveX: 1, moveZ: 0, lob: false } }).land; // → ＝ world -x
      ok(aimed.x < 0, `the arrow keys still choose the side, got ${aimed.x.toFixed(2)}`);
    }
    // 時間を奪う：CPU の出足がこの秒数遅れる
    {
      const { g } = hitRising();
      ok(g.ball.reactBonus === RISING.REACT_BONUS, `the rising shot delays the reply, got ${g.ball.reactBonus}`);
      g.update(1 / 60);
      ok(g.reactTimers.cpu > PLAYER.CPU_REACT * g.cpu.attr.react + RISING.REACT_BONUS - 0.05,
        `and the CPU really starts late: ${g.reactTimers.cpu.toFixed(3)}s`);
    }

    // CPU/AI（Hard 以上）も同じ条件で出す
    R.config.applyCpuLevel('hard');
    try {
      const RACKET_SIDE_CPU = 1; // cpu は向かい側を向いた右利き＝フォア側は world +x
      /** cpu がベースライン上で、目の前で弾んだばかりの球を上がりばなで捉える場面 */
      const aiScene = (opt = {}) => {
        const g = rally(ALL);
        g.ball.last = 'you';
        g.cpu.x = 0;
        g.cpu.z = opt.cpuZ === undefined ? HL : opt.cpuZ;
        g.cpu.speed = 0;
        g.cpu.settleT = 0; // 待てていない（鷹の目の場面ではない）
        Object.assign(g.ball, {
          x: g.cpu.x + RACKET_SIDE_CPU * 0.5,
          y: 0.3,
          z: g.cpu.z - 1.0,
          vx: 0,
          vy: opt.vy === undefined ? 3 : opt.vy,
          vz: 15,
          bounces: 1,
          sinceBounce: opt.since === undefined ? 0.05 : opt.since,
        });
        return g;
      };
      /** CHANCE で外れることがあるので、何度か引いて「その場面で出うる技」を集める */
      const aiPicks = (g) => {
        const seen = [];
        for (let i = 0; i < 300; i++) {
          const move = g.pickAiSpecial('cpu', g.aiSpecialContext('cpu'));
          if (move && seen.indexOf(move) === -1) seen.push(move);
        }
        return seen.join(',');
      };
      ok(rally(ALL).aiMoves().indexOf('rising') !== -1, 'hard gives the AI the rising shot');
      ok(aiPicks(aiScene()) === 'rising', `the AI takes the ball on the rise, got ${aiPicks(aiScene())}`);
      ok(aiPicks(aiScene({ since: RISING.MAX_SINCE + 0.1 })) === '', 'but not a ball that has been up a while');
      ok(aiPicks(aiScene({ vy: -1 })) === '', 'nor one that is dropping');
      ok(aiPicks(aiScene({ cpuZ: HL - RISING.BASE_IN - 1 })) === '', 'nor from well inside the court');
      // AI の打球も鏡になって、人間コートの深いところ・人間のいない側へ飛ぶ
      const g = aiScene();
      g.you.x = 2;
      g.pickAiSpecial = () => 'rising';
      g.hit('cpu');
      const land = R.physics.predictLanding(g.ball);
      ok(!land.net && land.z < -(COURT.SERVICE + 2) && land.z >= -(HL + COURT.LINE_SLACK) && land.x < 0,
        `the AI rising shot goes deep, away from you: ${JSON.stringify(land)}`);
      ok(g.lastShotBy.cpu === 'ライジング', `and is called by name, got ${g.lastShotBy.cpu}`);
    } finally {
      R.config.applyCpuLevel('normal');
    }
  }

  // --- Hard の CPU/AI も必殺技を使う ---
  // (要望: CPUも、hard以上の難易度の時は必殺技を使うようにしてほしい)
  {
    const { applyCpuLevel, CPU, SPECIAL: SP, HALF_W: W, HALF_L: L } = R.config;
    /** 難易度 hard の状態でひとつ確かめて、必ず normal へ戻す */
    const onHard = (fn) => {
      applyCpuLevel('hard');
      try { fn(); } finally { applyCpuLevel('normal'); }
    };
    /** cpu 側に「人間コートから飛んできた球」を、cpu のすぐ横に置く */
    const cpuBallAt = (g, y, bounces = 1, dz = -0.3) => {
      g.ball.last = 'you';
      g.ball.x = g.cpu.x + 0.3;
      g.ball.y = y;
      g.ball.z = g.cpu.z + dz;
      g.ball.bounces = bounces;
    };
    /**
     * 「AI がこの技を選んだ」1打を打たせる。技を選ぶかどうか（pickAiSpecial）と、
     * 選んだ技がどう飛ぶか（specialShot）は別物なので、後者だけを見たいときに使う。
     */
    const aiHitWith = (g, move, who = 'cpu') => {
      g.pickAiSpecial = () => move;
      g.hit(who);
    };

    ok(CPU.SPECIALS === false, 'precondition: the tests start on normal (no AI specials)');

    // 難易度が hard のときだけ AI は技を使える
    {
      onHard(() => ok(rally(ALL).aiSpecialsOn(), 'hard turns the AI specials on'));
      ok(!rally(ALL).aiSpecialsOn(), 'normal leaves them off');
      applyCpuLevel('easy');
      ok(!rally(ALL).aiSpecialsOn(), 'easy leaves them off too');
      applyCpuLevel('normal');
    }

    // 人間が技を1つも選んでいなければ、hard でも AI は使わない
    // （スタート画面で何も選ばなければ従来とまったく同じゲーム、という約束を守るため）
    onHard(() => {
      const g = rally([]);
      ok(!g.aiSpecialsOn(), 'with nothing equipped by the player, the AI stays plain');
      g.setSpecials(['hawkEye']);
      ok(g.aiSpecialsOn(), 'equipping one turns the AI side on as well');
    });

    // 回数は選手ごとに独立していて、ゲームが替わると回復する
    onHard(() => {
      const g = rally(ALL);
      ok(g.usesLeft('hawkEye', 'cpu') === SP.USES_PER_GAME, 'the AI starts with its own budget');
      g.spendSpecial('hawkEye', undefined, 'cpu');
      ok(g.usesLeft('hawkEye', 'cpu') === 0, 'spending an AI move draws down the AI budget');
      ok(g.usesLeft('hawkEye') === SP.USES_PER_GAME, "and leaves the human's alone");
      ok(g.stats.cpu.specials === 1, 'and it is counted on the CPU side of the stats');
      g.refreshSpecials();
      ok(g.usesLeft('hawkEye', 'cpu') === SP.USES_PER_GAME, 'a new game restores the AI budget too');
    });

    // 場面ごとに選ばれる技（人間と同じ config の条件を、AI 向けの代わりで見る）
    onHard(() => {
      /** CHANCE で外れることがあるので、何度か引いて「その場面で出うる技」を集める */
      const pick = (build) => {
        const g = rally(ALL);
        build(g);
        const seen = [];
        for (let i = 0; i < 300; i++) {
          // 跳んで打つ技（ダンクスマッシュ・ジャックナイフ）は、当たる少し前に跳ぶときに
          // 決まる（tickAiLeaps()）。いまの球がそのまま打点になる、として毎回その判断から通す
          g.cpu.leap = null;
          g.rollAiCommits('cpu');
          const plan = g.aiLeapPlan('cpu', { y: g.ball.y, vy: g.ball.vy, bounces: g.ball.bounces });
          if (plan) g.startLeap(plan.kind, 'cpu', plan.timing);
          const move = g.pickAiSpecial('cpu', g.aiSpecialContext('cpu'));
          if (move && seen.indexOf(move) === -1) seen.push(move);
        }
        return seen.join(',');
      };
      // 腰から頭の高さのノーバウンド → ドライブボレー
      ok(pick((g) => { g.cpu.z = 3; cpuBallAt(g, 1.2, 0); }) === 'driveVolley',
        `a floating no-bounce ball picks the drive volley for the AI, got ${pick((g) => { g.cpu.z = 3; cpuBallAt(g, 1.2, 0); })}`);
      // 足を止めて構えられたグラウンドストローク → 鷹の目（人間の「溜め5割」に当たる）
      ok(pick((g) => { g.cpu.z = 9; g.cpu.settleT = SP.AI.SETTLE_T + 0.2; cpuBallAt(g, 1.0); }) === 'hawkEye',
        'a settled groundstroke picks the hawk eye');
      // 攻めの位置での高いノーバウンド → ダンクスマッシュ。AI は打点へ先回りして止まって
      // 待つ動きなので、人間の「前へ踏み込みながら」（fwd）は出ない＝踏み込み0でも出ること。
      // (ユーザー報告「ダブルスの hard で CPU が必殺技を打たない」の正体：人間と同じ
      //  DUNK.MIN_FWD を要求していたため、この技だけ事実上 AI に存在しなかった)
      ok(pick((g) => { g.cpu.z = 3; g.cpu.fwd = 0; cpuBallAt(g, 2.6, 0); }) === 'dunkSmash',
        'a high no-bounce ball in the attacking court picks the dunk even standing still');
      // 同じ球でも、ベースライン際まで押し戻されていれば決め球にはならない
      ok(pick((g) => { g.cpu.z = SP.AI.DUNK_MAX_Z + 1.5; g.cpu.fwd = 0; cpuBallAt(g, 2.6, 0); }) === '',
        'but the same ball, hit from deep behind the baseline, is just a high return');
      // 高さの線は人間とまったく同じ（SPECIAL.DUNK.MIN_Y）
      ok(pick((g) => { g.cpu.z = 3; g.cpu.fwd = 0; cpuBallAt(g, SP.DUNK.MIN_Y - 0.2, 0); }) !== 'dunkSmash',
        'and a ball below the dunk line is not one');
      // 抜かれた（自分より後ろ＝自陣側を通っている）球 → ツイーナー
      ok(pick((g) => { g.cpu.z = 9; cpuBallAt(g, 1.0, 1, 1.2); }).indexOf('tweener') !== -1,
        'a ball behind the AI picks the tweener');
      // フォア側へ大きく振り回されて、まだ止まりきっていない → バギーホイップ
      // cpu は向かい側を向いた右利きなので、フォア側は world +x（game.js の RACKET_SIDE.cpu）。
      const CPU_RACKET_SIDE = 1;
      const draggedCpu = (g) => {
        g.cpu.z = 9;
        g.cpu.x = CPU_RACKET_SIDE * (SP.BUGGY.MIN_X + 0.6);
        g.cpu.runX = CPU_RACKET_SIDE * (SP.BUGGY.MIN_RUN_X + 0.5);
        g.cpu.speed = 5;
        cpuBallAt(g, 1.0, 1, -0.3);
        g.ball.x = g.cpu.x + CPU_RACKET_SIDE * 0.3; // ラケット側の球＝フォアハンド
      };
      {
        const g = rally(ALL);
        draggedCpu(g);
        ok(g.aiSpecialContext('cpu').stroke === 'forehand',
          `precondition: that is the AI's forehand side, got ${g.aiSpecialContext('cpu').stroke}`);
      }
      ok(pick(draggedCpu) === 'buggyWhip', 'dragged wide to the forehand side picks the buggy whip');
      // AI は当たった瞬間の速さで見る（人間の猶予 RECENT_RUN_T は持たない）：同じ場面でも
      // 追いついて止まって待てていれば出ない＝ AI が打ってくる回数は増えない
      ok(pick((g) => { draggedCpu(g); g.cpu.speed = 0; }) === '',
        'but not once the AI has got there and stopped');
      // 走ってもいない・止まってもいない普通の1打 → 何も出ない
      ok(pick((g) => { g.cpu.z = 9; g.cpu.speed = 1; cpuBallAt(g, 1.0); }) === '',
        'an ordinary groundstroke picks nothing');
      // 回数を使い切った技は飛ばして次の候補へ落ちる（人間と同じ拾い方）
      const g = rally(ALL);
      g.cpu.z = 3; cpuBallAt(g, 1.2, 0);
      g.cpu.specialUses.driveVolley = 0;
      let picked = null;
      for (let i = 0; i < 300 && !picked; i++) picked = g.pickAiSpecial('cpu', g.aiSpecialContext('cpu'));
      ok(picked === null, `a spent AI move is skipped and nothing else matches here, got ${picked}`);
    });

    // 難易度が normal なら、同じ場面でも AI は何も出さない
    {
      const g = rally(ALL);
      g.cpu.z = 9; g.cpu.settleT = SP.AI.SETTLE_T + 0.2; cpuBallAt(g, 1.0);
      let picked = null;
      for (let i = 0; i < 300 && !picked; i++) picked = g.pickAiSpecial('cpu', g.aiSpecialContext('cpu'));
      ok(picked === null, `normal never picks an AI special, got ${picked}`);
    }

    // AI の打球は人間コート（z<0）に入る。人間と同じ specialShot を通るが、狙いの
    // 深さも曲がる向きもすべて鏡になっていること。
    onHard(() => {
      SP.AI.MOVES.forEach((move) => {
        if (move === 'kickServe') return; // サーブは serve() の担当（下で別に見る）
        let outs = 0;
        let worst = null;
        for (let i = 0; i < 30; i++) {
          const g = rally(ALL);
          g.cpu.z = 6; g.cpu.x = 1;
          cpuBallAt(g, 1.4, 0);
          aiHitWith(g, move);
          const land = R.physics.predictLanding(g.ball);
          const inHumanCourt = !land.net && land.z < 0 && land.z >= -(L + COURT.LINE_SLACK)
            && Math.abs(land.x) <= W + COURT.LINE_SLACK;
          if (!inHumanCourt) { outs++; worst = land; }
        }
        ok(outs === 0, `the AI ${move} always lands in the human court: ${outs}/30 out`
          + (worst ? ` (worst x=${worst.x.toFixed(2)} z=${worst.z.toFixed(2)} net=${worst.net})` : ''));
      });
    });

    // バギーホイップの曲がりは打つ側で鏡になる（人間は +x へ、AI は -x へ）
    onHard(() => {
      const g = rally(ALL);
      g.cpu.z = 6; g.cpu.x = 1;
      cpuBallAt(g, 1.0);
      aiHitWith(g, 'buggyWhip');
      ok(g.ball.curve < 0, `the AI whip curves toward -x, got ${g.ball.curve}`);
      const human = rally(['buggyWhip']);
      human.you.z = -9;
      ballAt(human, 1.0);
      human.you.special = 'buggyWhip';
      human.hit('you');
      ok(human.ball.curve === -g.ball.curve,
        `and is the exact mirror of the human's: ${human.ball.curve} vs ${g.ball.curve}`);
    });

    // AI のクロスのバギーホイップは、読んで走れば人間にも届く（読み負ければ決まる）
    // (報告: 相手が放つクロスのバギーホイップショットが強力すぎる)
    // 以前はダウン・ザ・ラインに見える球が空中で 7.5m 曲がって逆サイドへ落ち、バウンド後も
    // 横へ 14.5m/s で逃げていくので、ベースライン中央から走っても1本も届かなかった。
    // 人間の足（PLAYER.SPEED / ACCEL）で、打たれてから 0.25 秒遅れて最短に走る、という
    // 見積もりで「届く打点があるか」を数える。
    onHard(() => {
      const { PLAYER: P, PHYSICS: PH } = R.config;
      const REACT_T = 0.25;
      /** 打たれてから t 秒で走れる距離（反応してから加速して最高速へ） */
      const runnable = (t) => {
        const T = Math.max(0, t - REACT_T);
        const tTop = P.SPEED / P.ACCEL;
        return T < tTop ? 0.5 * P.ACCEL * T * T : 0.5 * P.ACCEL * tTop * tTop + P.SPEED * (T - tTop);
      };
      /** (fromX, ベースラインの少し後ろ) から、バウンド後の打点のどれかに届くか */
      const reachable = (ball, fromX) => {
        const s = Object.assign({}, ball);
        const fromZ = -(L + 0.5);
        let bounces = 0;
        for (let t = 0; t < 3; t += PH.STEP) {
          R.physics.integrate(s, PH.STEP);
          if (R.physics.hitsNet(s)) return false;
          if (s.y <= PH.BALL_R && s.vy < 0) {
            R.physics.reflectBounce(s);
            if (++bounces >= 2) return false;
          }
          if (bounces === 1 && s.y < P.REACH_Y
            && Math.hypot(s.x - fromX, s.z - fromZ) - P.REACH <= runnable(t)) return true;
        }
        return false;
      };
      // CPU が自分のフォア側（world +x）へ振り回されて打つ場面を並べる。
      // AI のクロスは人間のフォア側（world -x）へ曲がり落ちる。
      const fromCenter = [];
      const guessedWrong = [];
      for (let xi = 0; xi <= 4; xi++) {
        for (let zi = 0; zi <= 2; zi++) {
          for (let yi = 0; yi <= 1; yi++) {
            const g = rally(ALL);
            g.cpu.x = SP.BUGGY.MIN_X + xi * 0.5;
            g.cpu.z = 10 + zi;
            cpuBallAt(g, 0.6 + yi * 0.5);
            aiHitWith(g, 'buggyWhip');
            fromCenter.push(reachable(g.ball, 0));
            guessedWrong.push(reachable(g.ball, 1)); // バック側へ1m寄っていた＝読み負け
          }
        }
      }
      const rate = (a) => a.filter(Boolean).length / a.length;
      ok(rate(fromCenter) >= 0.25,
        `from the middle of the baseline the AI's cross whip is reachable often enough: ${(rate(fromCenter) * 100).toFixed(0)}%`);
      ok(rate(guessedWrong) <= 0.2,
        `but it still wins the point when you lean the wrong way: ${(rate(guessedWrong) * 100).toFixed(0)}% reachable`);
    });

    // バギーホイップは曲がる球なので、相手の CPU/AI は読みきるまで出足が遅れる
    // (要望: CPU がバギーホイップの曲がりを読むのが遅れるようにしてほしい)
    // 以前は CPU が打たれた瞬間に曲がった後の着地点へ走り出せたので、人間のクロスは
    // Hard の CPU に中央で待たれると1本も決まらなかった。
    onHard(() => {
      // 打球そのものに「読みにくさ」が乗る（人間・AI どちらが打っても。クロスでもストレートでも）
      {
        const g = rally(ALL);
        g.you.z = -9;
        ballAt(g, 1.0);
        g.you.special = 'buggyWhip';
        g.hit('you');
        ok(g.ball.reactBonus === SP.BUGGY.REACT_BONUS,
          `the human's whip delays the reply by ${SP.BUGGY.REACT_BONUS}s, got ${g.ball.reactBonus}`);
        g.update(1 / 60);
        ok(g.reactTimers.cpu > PLAYER.CPU_REACT * g.cpu.attr.react + SP.BUGGY.REACT_BONUS - 0.05,
          `and the CPU really starts late: ${g.reactTimers.cpu.toFixed(3)}s`);
        const ai = rally(ALL);
        ai.cpu.z = 6; ai.cpu.x = 1;
        cpuBallAt(ai, 1.0);
        aiHitWith(ai, 'buggyWhip');
        ok(ai.ball.reactBonus === SP.BUGGY.REACT_BONUS, `so does the AI's, got ${ai.ball.reactBonus}`);
      }

      // フォア側の隅から打つクロスが、中央で待つ CPU から実際に決まるか
      /** @returns {number} 決まった割合（CPU が返せずに人間のポイントになった本数の比） */
      const winRate = (cpuX) => {
        let wins = 0;
        let n = 0;
        for (let xi = 0; xi <= 4; xi++) {
          for (let zi = 0; zi <= 2; zi++) {
            for (let yi = 0; yi <= 1; yi++) {
              const g = rally(ALL);
              g.ball.last = 'cpu';
              g.you.x = -(SP.BUGGY.MIN_X + xi * 0.5);
              g.you.z = -(10 + zi);
              ballAt(g, 0.6 + yi * 0.5);
              g.cpu.x = cpuX; g.cpu.z = L + 0.5;
              g.you.special = 'buggyWhip';
              const before = g.stats.you.points;
              g.hit('you');
              for (let i = 0; i < 240 && g.ball.last !== 'cpu' && g.phase === 'rally'; i++) g.update(1 / 60);
              if (g.stats.you.points > before) wins++;
              n++;
            }
          }
        }
        return wins / n;
      };
      const center = winRate(0);
      ok(center >= 0.25,
        `the human's cross whip now beats a CPU waiting in the middle: ${(center * 100).toFixed(0)}%`);
      // 曲がる先（world +x）へ先に寄られていれば返される＝読まれたら決まらない、は残る
      const read = winRate(1);
      ok(read <= 0.2, `but a CPU already leaning that way still gets it back: ${(read * 100).toFixed(0)}% won`);
    });

    // AI のキックサーブ：技として乗り、回数を使い、1バウンド目で跳ね上がる目印がつく
    onHard(() => {
      const g = new R.Game({ input: idle, hooks: noHooks });
      g.setSpecials(ALL);
      g.start();
      g.server = 'cpu';
      g.phase = 'serve';
      g.pickAiServeSpecial = () => 'kickServe';
      g.serve('cpu');
      ok(g.ball.kick === true, 'the AI kick serve is marked to bounce high');
      ok(g.usesLeft('kickServe', 'cpu') === 0, 'and it spends the AI budget for it');
      ok(g.stats.cpu.specials === 1, 'and is counted on the CPU side');
    });

    // 技が乗った1打の後始末：モーションが尽きたら消え、ポイントをまたがない
    onHard(() => {
      const g = rally(ALL);
      g.cpu.z = 6;
      cpuBallAt(g, 1.4, 0);
      aiHitWith(g, 'driveVolley');
      ok(g.cpu.special === 'driveVolley', 'the move stays on while the motion plays');
      g.cpu.anim = 0;
      g.tickSpecial(1 / 60);
      ok(g.cpu.special === null, 'and is cleared once the motion is done');
      g.cpu.special = 'hawkEye';
      g.newPoint();
      ok(g.cpu.special === null, 'a new point never carries one over');
    });

    // hard のフルマッチ（AI の技が混ざり続けてもフリーズ・NaN・回数のマイナスがない）
    onHard(() => {
      const g = new R.Game({ input: fakeInput, hooks: noHooks });
      g.setSpecials(ALL);
      g.start();
      let minUses = Infinity;
      let aiSpecials = 0;
      const spend = g.spendSpecial.bind(g);
      g.spendSpecial = (move, label, who = 'you') => {
        if (who !== 'you') aiSpecials++;
        return spend(move, label, who);
      };
      for (let i = 0; i < 60 * 600; i++) {
        if (g.phase === 'serve' && g.server === 'you') tap(g);
        if (g.phase === 'rally' && i % 6 === 0) tap(g);
        g.update(1 / 60);
        SP.AI.MOVES.forEach((m) => {
          minUses = Math.min(minUses, g.usesLeft(m, 'cpu'), g.usesLeft(m, 'cpuMate'), g.usesLeft(m, 'youMate'));
        });
      }
      ok(Number.isFinite(g.ball.x) && Number.isFinite(g.cpu.x), 'ball and AI stay finite on hard');
      ok(minUses >= 0, `the AI budget never goes negative, low water mark ${minUses}`);
      ok(aiSpecials > 0, `and the AI actually used some over a full match: ${aiSpecials}`);
    });

    // ダブルスの hard でも、相手ペアが実際に技を使う（ロブの多いダブルスで目に見える
    // 決め球＝ダンクスマッシュが出ることも含めて）
    // (ユーザー報告: ダブルスの hard で CPU が必殺技を打ってこない)
    onHard(() => {
      const input = { moveX: 0, moveZ: 0, lob: false };
      const g = new R.Game({ input, hooks: noHooks });
      g.setSpecials(ALL);
      g.start(true);
      const used = {};
      const spend = g.spendSpecial.bind(g);
      g.spendSpecial = (move, label, who = 'you') => {
        if (who !== 'you') used[`${who}:${move}`] = (used[`${who}:${move}`] || 0) + 1;
        return spend(move, label, who);
      };
      for (let i = 0; i < 60 * 600; i++) {
        input.moveX = Math.sin(i / 37) > 0 ? 1 : -1;
        input.moveZ = Math.sin(i / 53) > 0 ? 1 : -1;
        if (g.phase === 'serve' && g.server === 'you') tap(g);
        if (g.phase === 'rally' && i % 6 === 0) tap(g);
        g.update(1 / 60);
      }
      const byOpponent = Object.keys(used).filter((k) => k.indexOf('cpu') === 0);
      ok(byOpponent.length > 0, `doubles on hard: the opposing pair uses specials, got ${JSON.stringify(used)}`);
      ok(byOpponent.some((k) => k.indexOf('dunkSmash') !== -1),
        `including the dunk smash on a lob, got ${JSON.stringify(used)}`);
      ok(Number.isFinite(g.ball.x) && Number.isFinite(g.cpuMate.x), 'and the doubles match stays finite');
    });

    // --- Extreme：AI は全9種の技を1ゲームに複数回使う ---
    // (要望: extreme hard モード。相手は全ての必殺技を1ゲーム中複数使えて、hard より強い動き)
    {
      const { PLAYER } = R.config;
      /** 難易度 extreme の状態でひとつ確かめて、必ず normal へ戻す */
      const onExtreme = (fn) => {
        applyCpuLevel('extreme');
        try { fn(); } finally { applyCpuLevel('normal'); }
      };
      /** cpu 側へ向かってくる球のある、ラリー中のゲーム（ball.age は反応済みの値にしておく） */
      const cpuRally = () => {
        const g = rally(ALL);
        g.ball.last = 'you';
        g.ball.age = 2; // reactReach() が守備範囲をいっぱいまで開く（＝一歩動ける球）
        g.ball.bounces = 0;
        return g;
      };

      // 技の一覧と回数：extreme は全9種、hard は守備範囲を広げない7種
      onExtreme(() => {
        const g = rally(ALL);
        ok(g.aiMoves().length === R.config.SPECIAL_MOVES.length,
          `extreme gives the AI every move, got ${g.aiMoves().join(',')}`);
        ok(g.aiMoves().indexOf('shukuchi') !== -1 && g.aiMoves().indexOf('divingVolley') !== -1,
          'including the two that hard withholds (the dash and the diving volley)');
        ok(CPU.SPECIAL_USES > SP.USES_PER_GAME,
          `and more than one use of each per game, got ${CPU.SPECIAL_USES}`);
        ok(g.aiMoves().every((m) => g.usesLeft(m, 'cpu') === CPU.SPECIAL_USES),
          `every move starts with that budget, got ${JSON.stringify(g.cpu.specialUses)}`);
      });
      // 選び直したら前の難易度の持ち分は残らない（extreme → hard で縮地が使えたままにならない）
      {
        applyCpuLevel('extreme');
        const g = rally(ALL);
        applyCpuLevel('hard');
        g.refreshSpecials();
        ok(g.usesLeft('shukuchi', 'cpu') === 0 && g.usesLeft('divingVolley', 'cpu') === 0,
          `switching back to hard takes the extra moves away, got ${JSON.stringify(g.cpu.specialUses)}`);
        ok(g.usesLeft('hawkEye', 'cpu') === SP.USES_PER_GAME,
          'and puts the remaining ones back on the hard budget');
        applyCpuLevel('normal');
      }

      // 飛びつきボレー：普通のリーチでは届かないノーバウンドに手が届く（その代わり硬直が長い）
      const diveBall = (g) => {
        g.cpu.x = 0;
        g.cpu.z = 1.5; // ネット際（PLAYER.VOLLEY_Z 以内）
        g.ball.y = 1.2;
        g.ball.z = g.cpu.z - 0.1;
        g.ball.x = g.cpu.x + PLAYER.CPU_REACH * g.cpu.attr.reach * 1.3; // 届かないが飛びつけば届く
      };
      /** 飛び込み（startDive）から当たるまで、物理を1刻みずつ進める */
      const throughDive = (g, who) => {
        for (let i = 0; i < 240 && g[who].dive; i++) g.stepBall(R.config.PHYSICS.STEP);
      };
      onExtreme(() => {
        const g = cpuRally();
        diveBall(g);
        g.diveCommit.cpu = true;
        ok(g.swingAiAt('cpu', g.ball) === true, 'extreme: the AI dives at a volley it cannot otherwise reach');
        ok(!!g.cpu.dive && g.ball.last === 'you',
          'it launches itself at the ball first (the hit comes when the racket gets there)');
        throughDive(g, 'cpu');
        ok(g.ball.last === 'cpu', 'and then hits it');
        ok(g.cpu.special === 'divingVolley', `and the shot carries the move, got ${g.cpu.special}`);
        ok(g.usesLeft('divingVolley', 'cpu') === CPU.SPECIAL_USES - 1, 'it spends one use');
        ok(g.recoverTimers.cpu === SP.DIVE.RECOVER,
          `and pays the same long recovery the human does, got ${g.recoverTimers.cpu}`);
        ok(g.cpu.diveVolley === false, 'the flag is cleared so the next swing is an ordinary one');
      });
      // 遠い球には足元ごと飛び込み、伸ばした体が届くところで当たる
      onExtreme(() => {
        const g = cpuRally();
        diveBall(g);
        g.ball.x = g.cpu.x + PLAYER.CPU_REACH * g.cpu.attr.reach * 1.8; // 伸ばした体でも届かない遠さ
        g.diveCommit.cpu = true;
        const x0 = g.cpu.x;
        ok(g.swingAiAt('cpu', g.ball) === true, 'extreme: the AI dives at a far volley');
        let at = null;
        const hit = g.hit.bind(g);
        g.hit = (who) => { at = { x: g.ball.x, y: g.ball.y, cx: g.cpu.x, cz: g.cpu.z, z: g.ball.z }; hit(who); };
        throughDive(g, 'cpu');
        ok(g.ball.last === 'cpu' && !!at, 'and returns it');
        ok(g.cpu.x > x0 + 0.3, `moving its feet toward the ball: x ${x0.toFixed(2)} -> ${g.cpu.x.toFixed(2)}`);
        if (at) {
          const { DIVE } = SP;
          const reach = Math.sqrt(DIVE.BODY_REACH ** 2 - (at.y - DIVE.CONTACT_LIFT) ** 2);
          const d = Math.hypot(at.x - at.cx, at.z - at.cz);
          ok(d <= reach + 0.05, `so the stretched racket gets there: ${d.toFixed(2)}m (reach ${reach.toFixed(2)}m)`);
        }
      });
      // 打たれて間もない球でも、目で追える長さ（LUNGE_MIN）は飛び込んでから当てる。AI の手の
      // 届く範囲は打たれてからの時間で広がる（reactReach）ので、打点の見込みにもその瞬間の
      // 範囲を使う（いまの範囲で見ると、飛び込むと決めた直後にもう範囲の外へ抜ける球に
      // しか見込みが立たず、一瞬で倒れ込んで当てていた）。
      onExtreme(() => {
        const g = cpuRally();
        g.cpu.x = 0; g.cpu.z = 2;
        g.ball.x = 2.7; g.ball.y = 1.0; g.ball.z = 0.2;
        g.ball.vx = 0; g.ball.vy = 2; g.ball.vz = 18;
        g.ball.age = 0.6;
        g.diveCommit.cpu = true;
        let span = null;
        for (let i = 0; i < 120 && g.ball.last === 'you'; i++) {
          g.recoverTimers.cpu = Math.max(g.recoverTimers.cpu, g.cpu.dive ? 0 : 1); // 走らせない
          g.stepBall(R.config.PHYSICS.STEP);
          if (g.cpu.dive && span === null) span = g.cpu.dive.span;
        }
        ok(span !== null && span >= SP.DIVE.LUNGE_MIN - 1e-6,
          `a fresh ball is still dived at with a full lunge: ${span && span.toFixed(3)}s (min ${SP.DIVE.LUNGE_MIN})`);
        ok(g.ball.last === 'cpu', 'and returned');
      });
      // 体のほうへ寄ってくる球に飛びついたときは、普通のリーチに入る手前で捉える
      // （体のそばまで引きつけてから倒れ込むのではない）
      onExtreme(() => {
        const g = cpuRally();
        diveBall(g);
        g.ball.vx = -4; // 体のほうへ寄ってくる
        g.diveCommit.cpu = true;
        let at = null;
        const hit = g.hit.bind(g);
        g.hit = (who) => { at = { d: Math.hypot(g.ball.x - g.cpu.x, g.ball.z - g.cpu.z) }; hit(who); };
        const reach = R.ai.reactReach(g.ball.age, g.cpu.attr.reach);
        ok(g.swingAiAt('cpu', g.ball) === true, 'extreme: it dives at it (the decision is unchanged)');
        throughDive(g, 'cpu');
        ok(!!at && at.d >= reach - 0.05,
          `and meets it before it comes within normal reach: ${at && at.d.toFixed(2)}m (normal reach ${reach.toFixed(2)}m)`);
      });
      // 出す気でいない球（抽選に外れた球）には飛びつかない
      onExtreme(() => {
        const g = cpuRally();
        diveBall(g);
        g.diveCommit.cpu = false;
        ok(g.swingAiAt('cpu', g.ball) === false, 'without the roll it just watches the ball go by');
      });
      // hard は飛びつかない（守備範囲を広げる技は持たせていない）
      onHard(() => {
        const g = cpuRally();
        diveBall(g);
        g.diveCommit.cpu = true;
        ok(g.swingAiAt('cpu', g.ball) === false, 'hard never dives (the move is not in its list)');
      });

      // 飛びつきボレーの打球も、他の AI の技と同じく人間コートへ鏡になって飛ぶ
      onExtreme(() => {
        let outs = 0;
        let worst = null;
        for (let i = 0; i < 30; i++) {
          const g = cpuRally();
          diveBall(g);
          g.diveCommit.cpu = true;
          g.swingAiAt('cpu', g.ball);
          throughDive(g, 'cpu');
          const land = R.physics.predictLanding(g.ball);
          const inHumanCourt = !land.net && land.z < 0 && land.z >= -(L + COURT.LINE_SLACK)
            && Math.abs(land.x) <= W + COURT.LINE_SLACK;
          if (!inHumanCourt) { outs++; worst = land; }
        }
        ok(outs === 0, `the AI diving volley always lands in the human court: ${outs}/30 out`
          + (worst ? ` (worst x=${worst.x.toFixed(2)} z=${worst.z.toFixed(2)} net=${worst.net})` : ''));
      });

      // 縮地：走っても間に合わない球で打点へ瞬間移動する
      const runaway = (g) => {
        g.cpu.x = -4; g.cpu.z = 9;
        g.ball.x = 0; g.ball.y = 1.3; g.ball.z = 0.5;
        g.ball.vx = 11; g.ball.vy = 1.5; g.ball.vz = 8; // 逆サイドのはるか外へ走る球
      };
      onExtreme(() => {
        const g = cpuRally();
        runaway(g);
        g.dashCommit.cpu = true;
        const from = { x: g.cpu.x, z: g.cpu.z };
        g.tickAiDash();
        ok(g.cpu.x !== from.x || g.cpu.z !== from.z, 'extreme: the AI dashes to a ball it cannot run down');
        ok(g.usesLeft('shukuchi', 'cpu') === CPU.SPECIAL_USES - 1, 'it spends one use');
        ok(!!g.cpu.dash && g.cpu.dash.x === from.x && g.cpu.dash.z === from.z,
          'and leaves the afterimage where it stood');
        ok(g.cpu.chaseDist === 0 && g.cpu.settleT === 0,
          'landing there counts as being set (not as a stretched run)');
        ok(g.dashCommit.cpu === false, 'the roll is used up, so it cannot dash twice on one ball');
        // シングルスでコートに立っていない相方は動かない（見えない選手が回数を使わないこと）
        ok(g.cpuMate.dash === null && g.youMate.dash === null
          && g.usesLeft('shukuchi', 'cpuMate') === CPU.SPECIAL_USES,
          'in singles only the CPU on court dashes');
      });
      // 走って間に合う球には出さない（技を無駄にしない）
      onExtreme(() => {
        const g = cpuRally();
        g.cpu.x = 0; g.cpu.z = 9;
        g.ball.x = 0.2; g.ball.y = 1.3; g.ball.z = 6;
        g.ball.vx = 0; g.ball.vy = 1; g.ball.vz = 3;
        g.dashCommit.cpu = true;
        g.tickAiDash();
        ok(g.cpu.x === 0 && g.cpu.z === 9 && g.usesLeft('shukuchi', 'cpu') === CPU.SPECIAL_USES,
          'a ball it can simply run to is not worth a dash');
      });
      // hard は縮地を持たない
      onHard(() => {
        const g = cpuRally();
        runaway(g);
        g.dashCommit.cpu = true;
        g.tickAiDash();
        ok(g.cpu.x === -4 && g.cpu.z === 9, 'hard never dashes');
      });
      // 残像はポイントをまたがない
      onExtreme(() => {
        const g = cpuRally();
        g.cpu.dash = { x: 1, z: 2, t: SP.DASH.FX_T };
        g.tickSpecial(SP.DASH.FX_T + 0.01);
        ok(g.cpu.dash === null, 'the afterimage fades on its own');
        g.cpu.dash = { x: 1, z: 2, t: SP.DASH.FX_T };
        g.newPoint();
        ok(g.cpu.dash === null, 'and never carries into the next point');
      });

      // extreme のフルマッチ（全9種が混ざり続けてもフリーズ・NaN・回数のマイナスがない）
      onExtreme(() => {
        const g = new R.Game({ input: fakeInput, hooks: noHooks });
        g.setSpecials(ALL);
        g.start();
        const used = {};
        let minUses = Infinity;
        let maxUses = -Infinity;
        const spend = g.spendSpecial.bind(g);
        g.spendSpecial = (move, label, who = 'you') => {
          if (who !== 'you') used[move] = (used[move] || 0) + 1;
          return spend(move, label, who);
        };
        for (let i = 0; i < 60 * 600; i++) {
          if (g.phase === 'serve' && g.server === 'you') tap(g);
          if (g.phase === 'rally' && i % 6 === 0) tap(g);
          g.update(1 / 60);
          g.aiMoves().forEach((m) => {
            minUses = Math.min(minUses, g.usesLeft(m, 'cpu'));
            maxUses = Math.max(maxUses, g.usesLeft(m, 'cpu'));
          });
        }
        ok(Number.isFinite(g.ball.x) && Number.isFinite(g.cpu.x) && Number.isFinite(g.cpu.z),
          'ball and AI stay finite on extreme');
        ok(minUses >= 0 && maxUses <= CPU.SPECIAL_USES,
          `the AI budget stays inside 0..${CPU.SPECIAL_USES}, got ${minUses}..${maxUses}`);
        ok(Object.keys(used).length > 0, `and the AI used some over a full match: ${JSON.stringify(used)}`);
      });
    }

    ok(CPU.SPECIALS === false, 'the difficulty is left back on normal for the tests that follow');
  }

  // --- 技は振り終わるまで残り、そこで消える（フォームの表示に使うため） ---
  {
    const g = rally(['hawkEye']);
    g.you.z = -9;
    ballAt(g, 1.0);
    chargeUp(g);
    g.chargeRelease();
    for (let i = 0; i < 30 && g.ball.last !== 'you'; i++) g.update(1 / 60);
    ok(g.you.special === 'hawkEye', 'the move stays on while the swing animation plays');
    for (let i = 0; i < 60 && g.you.special; i++) g.update(1 / 60);
    ok(g.you.special === null, 'and is cleared once the motion is over');
  }
}


// --- レシーブ（サーブを打ち返す1打）の緩和 ---
// ユーザー報告「プレイヤーがレシーブするとき、返すのがかなり難しい」への対応。
// 球速・コース・深さは一切変えず（＝体感の速さはそのまま）、
//   1) サーブが来る前からテイクバックを引いて待てる
//   2) この1打だけスイングの有効時間とリーチが広い（RETURN.SWING_WINDOW / REACH_MULT）
//   3) predictContact()（＝ガイド）が「いま離せば当たる」と言ったら本当に当たる
// の3点で「なんとか返せる」ようにしてある。ここではその3点を検証する。
{
  const { RETURN, PHYSICS } = R.config;

  /** CPU のサーブが実際に打たれる（phase が 'rally' に変わる）直前まで進める。 */
  const upToServe = (input = { moveX: 0, moveZ: 0, lob: false }) => {
    const g = new R.Game({ input, hooks: noHooks });
    g.started = true;
    g.server = 'cpu';
    g.newPoint();
    return g;
  };
  const runToServe = (g) => {
    for (let i = 0; i < 4000 && !(g.serveInFlight && g.ball.live); i++) g.update(1 / 240);
    return g.serveInFlight && g.ball.live;
  };
  /** そのサーブがサービスボックスに入るか（＝返球を論じる意味があるか） */
  const servedIn = (g) => {
    const L = R.physics.predictLanding({ ...g.ball });
    return !L.net && L.z < 0 && L.z > -COURT.SERVICE - 0.02 && Math.abs(L.x) <= HALF_W + 0.02;
  };

  // 1) サーブを待っている間もテイクバックが溜まる（以前は chargeStart() が素通りだった）
  {
    const g = upToServe();
    g.chargeStart('slice');
    ok(g.you.charging, 'the receiver can start the takeback before the serve is struck');
    for (let i = 0; i < 30; i++) g.update(1 / 60);
    ok(g.you.chargeTime > 0.4,
      `and it keeps charging while waiting, got ${g.you.chargeTime.toFixed(2)}s`);
    ok(g.you.chargeSpin === 'slice', 'the spin key held while waiting is the one that comes out');
    ok(g.you.chargeStroke === null,
      'forehand/backhand is left undecided while the ball is still in the server hand');
    ok(runToServe(g), 'precondition: the CPU serves');
    ok(g.you.charging && g.you.chargeTime > 0.4,
      `the takeback survives the moment the serve is struck, got ${g.you.chargeTime.toFixed(2)}s`);
    ok(g.you.chargeStroke === 'forehand' || g.you.chargeStroke === 'backhand',
      `and forehand/backhand is fixed right then, got ${g.you.chargeStroke}`);
  }

  // 1b) 1本目がフォールトしても、押しっぱなしのテイクバックは握り直さずに済む
  {
    const g = upToServe();
    g.chargeStart('top');
    for (let i = 0; i < 20; i++) g.update(1 / 60);
    g.serveNumber = 1;
    g.serveFault('アウト');
    for (let i = 0; i < 300 && g.phase !== 'serve'; i++) g.update(1 / 60);
    ok(g.phase === 'serve' && g.serveNumber === 2, 'precondition: a second serve is being set up');
    ok(g.you.charging && g.you.chargeSpin === 'top',
      'the held takeback carries into the second serve instead of being dropped');
  }

  // 1c) 自分のサーブでは、前のトスの溜めをきっちり持ち越さない（従来どおり）
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.started = true;
    g.server = 'you';
    g.newPoint();
    g.chargeStart('slice');
    for (let i = 0; i < 20; i++) g.update(1 / 60);
    g.beginServe('アウト');
    ok(!g.you.charging && g.you.chargeTime === 0 && g.you.chargeSpin === 'flat',
      'the server own charge is still cleared when the stance is set up again');
  }

  // 2) スイングの有効時間は、レシーブのときだけ長い
  {
    const g = upToServe();
    ok(runToServe(g), 'precondition: the CPU serves');
    ok(Math.abs(g.swingWindow() - RETURN.SWING_WINDOW) < 1e-9,
      `returning a serve uses the wider window, got ${g.swingWindow()}`);
    ok(RETURN.SWING_WINDOW > PLAYER.SWING_WINDOW, 'which is wider than the normal one');
    g.chargeStart();
    g.chargeRelease();
    ok(Math.abs(g.you.swing - RETURN.SWING_WINDOW) < 1e-9,
      `and the released swing really lives that long, got ${g.you.swing.toFixed(3)}`);
    // 返球された後（serveInFlight が下りた後）は通常の窓に戻る
    g.serveInFlight = false;
    ok(Math.abs(g.swingWindow() - PLAYER.SWING_WINDOW) < 1e-9,
      'once the serve has been returned, the normal window is back');
  }

  // 2b) 窓が広がっても「早振り＝引っ張り／引きつけ＝流し」の関係は変わらない
  // （待ち時間を秒のまま測ると、レシーブは必ず引っ張り最大＝サイドライン際へ散る）
  {
    const g = upToServe();
    ok(runToServe(g), 'precondition: the CPU serves');
    g.chargeStart();
    g.chargeRelease();
    const waitedAtRelease = g.swingWaited();
    ok(waitedAtRelease < 1e-6, `waiting time starts at 0, got ${waitedAtRelease}`);
    for (let i = 0; i < 12; i++) g.update(1 / 240);
    const scaled = g.swingWaited();
    const elapsed = RETURN.SWING_WINDOW - g.you.swing;
    ok(scaled < elapsed,
      `the wider window is read as a ratio, not raw seconds: ${scaled.toFixed(3)} < ${elapsed.toFixed(3)}`);
    ok(Math.abs(scaled - elapsed * (PLAYER.SWING_WINDOW / RETURN.SWING_WINDOW)) < 1e-9,
      'and it is scaled back onto the normal window exactly');
  }

  // 3) predictContact() が「いま離せば当たる」と言ったら本当に当たる。
  // 以前は physics.predictWindow() が上限（スイングの有効時間）を1コマ越えた打点まで
  // 返していたため、ガイドが当たると言った瞬間に離しても数ミリ秒差で必ず空振りしていた。
  // これが空振りの主因だった（実測：レシーブ失敗の 64/66 が空振り）。
  {
    let tried = 0;
    let connected = 0;
    for (let i = 0; i < 200; i++) {
      const input = { moveX: 0, moveZ: 0, lob: false };
      const g = upToServe(input);
      if (!runToServe(g)) continue;
      if (!servedIn(g)) continue;
      let released = false;
      for (let f = 0; f < 800; f++) {
        if (!released && g.predictContact() !== null) {
          g.chargeStart();
          g.chargeRelease();
          released = true;
          tried++;
        }
        g.update(1 / 240);
        if (g.ball.last === 'you') { connected++; break; }
        if (g.phase !== 'rally' || !g.ball.live || g.ball.bounces >= 2) break;
      }
    }
    // 棒立ちのままラケットの円に入るのは、入ったサーブのうち半分ほど（残りは走らないと
    // 届かない）。200本流して数十本が残る。
    ok(tried > 40, `precondition: enough serves to swing at, got ${tried}`);
    ok(connected >= tried * 0.98,
      `releasing the moment predictContact() says it connects really does connect: ${connected}/${tried}`);
  }

  // 4) 通しで見て、レシーブが「なんとか返せる」水準になっている。
  // 反応してから落下点へ走り、ボールが3mまで来たら離すだけ（人間にできる操作）で、
  // 入ったサーブのほとんどが返る。たまにエースが決まるのは許容範囲。
  {
    const REACT = 0.28;
    for (const level of ['normal', 'hard']) {
      R.config.applyCpuLevel(level);
      let inBox = 0;
      let returned = 0;
      let charge = 0;
      for (let i = 0; i < 150; i++) {
        const input = { moveX: 0, moveZ: 0, lob: false };
        const g = upToServe(input);
        g.chargeStart(); // サーブを待つ間にテイクバックを引いておく
        if (!runToServe(g)) continue;
        if (!servedIn(g)) continue;
        inBox++;
        let t = 0;
        let released = false;
        for (let f = 0; f < 1200; f++) {
          const b = g.ball;
          if (t >= REACT) {
            const at = R.physics.predictAtZ(b, g.you.z, 3, 1) || R.physics.predictLanding(b);
            const dx = (at.x || 0) - g.you.x;
            input.moveX = Math.abs(dx) > 0.05 ? (dx > 0 ? -1 : 1) : 0; // INPUT_X_TO_WORLD = -1
            if (!released && Math.hypot(b.x - g.you.x, b.z - g.you.z) < 3) {
              g.chargeRelease();
              released = true;
            }
          }
          g.update(1 / 240);
          t += 1 / 240;
          if (g.ball.last === 'you') { returned++; charge += g.you.swingCharge; break; }
          if (g.phase !== 'rally' || !g.ball.live || g.ball.bounces >= 2) break;
        }
      }
      // 1本目は実際のテニスと同じく6割強しか入らない（SERVE.CPU_FIRST_MISS）。
      ok(inBox > 60, `precondition: enough serves in the box on ${level}, got ${inBox}`);
      ok(returned >= inBox * 0.9,
        `${level}: most serves that land in are returnable, got ${returned}/${inBox}`);
      ok(charge / Math.max(1, returned) > 0.3,
        `${level}: and waiting with the racket back pays off, avg charge ${(charge / Math.max(1, returned)).toFixed(2)}`);
    }
    R.config.applyCpuLevel('normal');
    ok(PHYSICS.BALL_R > 0, 'difficulty is left back on normal for anything that follows');
  }
}

// ===================================================================== 練習モード
{
  const { PRACTICE, SPECIAL_MOVES, CHARGE, SPECIAL } = R.config;
  const { predictAtZ, integrate } = R.physics;
  const DT = 1 / 120;

  // --- レッスンの定義：必殺技は全部そろい、種類ごとに必要なものを持っている ---
  {
    const keys = PRACTICE.LESSONS.map((l) => l.key);
    ok(new Set(keys).size === keys.length, `lesson keys are unique, got ${keys.join()}`);
    const taught = PRACTICE.LESSONS.filter((l) => l.special).map((l) => l.special);
    ok(SPECIAL_MOVES.every((m) => taught.indexOf(m.key) !== -1),
      `every special move has a lesson, missing ${SPECIAL_MOVES.filter((m) => taught.indexOf(m.key) === -1).map((m) => m.key)}`);
    const broken = PRACTICE.LESSONS.filter((l) => !l.title || !l.text || !(l.goal > 0)
      || (l.kind === 'move' && !(l.targets && l.targets.length && l.start))
      || (l.kind === 'feed' && !(l.feeds && l.feeds.length && l.start && l.start.length))
      || ['move', 'serve', 'return', 'feed'].indexOf(l.kind) === -1);
    ok(broken.length === 0, `every lesson has what its kind needs, broken: ${broken.map((l) => l.key)}`);
  }

  /** ボットの1コマぶんの入力（人間がやれる操作だけ）でレッスンを進める */
  const practise = (key, maxTries, bot) => {
    const input = { moveX: 0, moveZ: 0, lob: false };
    const calls = [];
    const g = new R.Game({ input, hooks: { ...noHooks, call: (b, s) => calls.push(`${b}|${s || ''}`) } });
    g.startPractice(key);
    let s = { rep: -1 };
    for (let f = 0; f < 120 * 30 * maxTries && g.practice.tries < maxTries; f++) {
      if (g.practice.rep !== s.rep) {
        s = { rep: g.practice.rep, t: 0, pressed: false, released: false };
        Object.assign(input, { moveX: 0, moveZ: 0, lob: false });
      }
      bot(g, input, s);
      g.update(DT);
      s.t += DT;
    }
    return { g, calls };
  };
  /** input.moveX は world の逆向き（INPUT_X_TO_WORLD=-1） */
  const steerX = (input, g, x, dead = 0.08) => {
    const dx = x - g.you.x;
    input.moveX = Math.abs(dx) > dead ? (dx > 0 ? -1 : 1) : 0;
  };
  /** 球が自分の深さを通る x へ寄る（球を体の横 0.6m に置く） */
  const track = (input, g, bounces) => {
    const at = predictAtZ(g.ball, g.you.z, 3, bounces);
    if (!at) { input.moveX = 0; return; }
    steerX(input, g, at.x - (at.x >= g.you.x ? 0.6 : -0.6));
  };
  const incoming = (g) => g.phase === 'rally' && g.ball.live && g.ball.last === 'cpu';
  /** 球が出る前から押して待ち、球を追って、届くところ（predictContact）で離す */
  const stroke = (spin, { lob = false, drop = false, bounces = 1 } = {}) => (g, input, s) => {
    input.lob = lob;
    if (g.phase === 'rally' && !g.ball.live && !drop && !s.pressed) { g.chargeStart(spin); s.pressed = true; }
    if (!incoming(g) || s.released) { input.moveX = 0; return; }
    track(input, g, bounces);
    if (g.predictContact() !== null) {
      if (drop) g.chargeStart(spin); // ドロップは溜めずにすぐ離す
      g.chargeRelease();
      s.released = true;
    }
  };
  const serveBot = (kick) => (g, input, s) => {
    if (g.phase !== 'serve' || g.servingPlayer() !== 'you') return;
    if (!s.pressed && s.t > 0.3) { g.chargeStart(kick ? 'top' : 'flat', kick); s.pressed = true; s.at = s.t; }
    if (s.pressed && !s.released && s.t - s.at >= SERVE.CHARGE_SWEET_T) { g.chargeRelease(); s.released = true; }
  };
  /** 必殺技：技の予告（specialArmed＝HUD の ⚡）が出たら離す。steer＝球が出てからの動き方 */
  const special = (key, { spin = 'flat', press = 'pre', steer = () => {} } = {}) => (g, input, s) => {
    if (g.phase === 'rally' && !g.ball.live && press === 'pre' && !s.pressed) { g.chargeStart(spin); s.pressed = true; }
    if (!incoming(g) || s.released) { input.moveX = 0; input.moveZ = 0; return; }
    if (!s.pressed && (press === 'feed' || (press === 'cross' && g.ball.z < 0))) { g.chargeStart(spin); s.pressed = true; }
    steer(g, input);
    const armed = g.specialArmed;
    if (s.pressed && armed && armed.move === key) { g.chargeRelease(); s.released = true; }
  };
  /** 落ちてくる球が y=h を下向きに通る地点と時刻（ノーバウンドのまま） */
  const descentTo = (ball, h) => {
    const b = { ...ball };
    for (let t = 0; t < 4; t += 1 / 240) {
      const py = b.y;
      integrate(b, 1 / 240);
      if (b.vy < 0 && py >= h && b.y < h) return { x: b.x, z: b.z, t };
    }
    return null;
  };
  const BOTS = {
    move: (g, input) => {
      const t = g.practice.target;
      if (!t) { Object.assign(input, { moveX: 0, moveZ: 0 }); return; }
      steerX(input, g, t.x, 0.1);
      input.moveZ = Math.abs(t.z - g.you.z) > 0.1 ? Math.sign(t.z - g.you.z) : 0;
    },
    serve: serveBot(false),
    return: (g, input, s) => {
      if (!s.pressed && g.phase === 'serve') { g.chargeStart('top'); s.pressed = true; }
      if (!incoming(g) || s.released) { input.moveX = 0; return; }
      track(input, g, 1);
      if (g.predictContact() !== null) { g.chargeRelease(); s.released = true; }
    },
    flat: stroke('flat'),
    top: stroke('top'),
    slice: stroke('slice'),
    drop: stroke('slice', { drop: true }),
    lob: stroke('top', { lob: true }),
    volley: stroke('flat', { bounces: 0 }),
    // スマッシュ：コートの輪（smashHint）へ先回りして止まり、半分以上溜めてから離す
    smash: (g, input, s) => {
      if (g.phase === 'rally' && !g.ball.live && !s.pressed) { g.chargeStart('flat'); s.pressed = true; }
      if (!incoming(g) || s.released) { Object.assign(input, { moveX: 0, moveZ: 0 }); return; }
      const h = g.smashHint;
      if (h) {
        steerX(input, g, h.x, 0.15);
        input.moveZ = Math.abs(h.z - g.you.z) > 0.15 ? Math.sign(h.z - g.you.z) : 0;
      }
      if (g.predictContact() !== null && g.you.chargeTime >= CHARGE.MAX_TIME * 0.55) {
        g.chargeRelease();
        s.released = true;
      }
    },
    kickServe: serveBot(true),
    hawkEye: special('hawkEye', { steer: (g, input) => track(input, g, 1) }),
    driveVolley: special('driveVolley', { steer: (g, input) => track(input, g, 0) }),
    divingVolley: special('divingVolley'),
    // 球が頭の高さ（2.5m）まで落ちてくる地点へ、間に合うように走り出す
    dunkSmash: special('dunkSmash', {
      steer: (g, input) => {
        const p = descentTo(g.ball, 2.5);
        if (!p) return;
        steerX(input, g, p.x, 0.1);
        input.moveZ = p.t <= (p.z - 0.4 - g.you.z) / (PLAYER.SPEED * 0.85) + 0.15 ? 1 : 0;
      },
    }),
    rising: special('rising'),
    shukuchi: special('shukuchi', { press: 'cross' }),
    buggyWhip: special('buggyWhip', { spin: 'top', steer: (g, input) => track(input, g, 1) }),
    jackknife: special('jackknife', { press: 'feed' }),
    tweener: special('tweener', {
      steer: (g, input) => {
        input.moveZ = -1;
        const at = predictAtZ(g.ball, g.you.z - 1, 3, 1);
        if (at) steerX(input, g, at.x, 0.15);
      },
    }),
  };

  // --- どのレッスンも、人間がやれる操作だけで目標の本数に届く（球出し・立ち位置の確かめ） ---
  {
    const failed = [];
    for (const L of PRACTICE.LESSONS) {
      const { g } = practise(L.key, L.goal * 3, BOTS[L.key]);
      if (!g.practice.cleared) failed.push(`${L.key} ${g.practice.done}/${g.practice.tries}`);
    }
    ok(failed.length === 0, `every lesson can be cleared within 3x its goal, failed: ${failed.join(', ')}`);
  }

  // --- 練習は得点をつけない（スコア・スタッツ・チェンジエンズ・リプレイの元になる状態が動かない） ---
  {
    const { g } = practise('flat', 6, BOTS.flat);
    ok(g.practice.tries === 6, `precondition: six reps were played, got ${g.practice.tries}`);
    ok(g.match.games.you === 0 && g.match.games.cpu === 0 && g.match.points.you === 0 && g.match.points.cpu === 0,
      `practice never scores, got games ${JSON.stringify(g.match.games)} points ${JSON.stringify(g.match.points)}`);
    ok(g.stats.you.points === 0 && g.stats.cpu.points === 0 && g.matchStats.points === 0,
      'practice never touches the match stats');
    ok(!g.endsSwapped && g.changeover === null, 'practice never changes ends');
    ok(g.cpu.x === PRACTICE.FEEDER.x && g.cpu.z === PRACTICE.FEEDER.z,
      `the feeder stays put, got ${g.cpu.x},${g.cpu.z}`);
  }

  // --- 打ち方が違えば、入っても成功にせず「何を変えればよいか」を出す ---
  {
    const { g, calls } = practise('flat', 3, stroke('top'));
    ok(g.practice.done === 0, `topspin does not count in the flat lesson, got ${g.practice.done}`);
    const hint = PRACTICE.LESSONS.find((l) => l.key === 'flat').hint;
    ok(calls.some((c) => c === `もう一度|${hint}`), `and the call says what to change, got ${JSON.stringify(calls)}`);
  }

  // --- 必殺技のレッスンはその技だけを装備し、何本打っても回数が尽きない ---
  {
    const { g } = practise('hawkEye', 4, BOTS.hawkEye);
    ok(g.specials.join() === 'hawkEye', `only the lesson's move is equipped, got ${g.specials.join()}`);
    ok(g.practice.done === 4, `the move fires on every rep (uses refill), got ${g.practice.done}/4`);
  }

  // --- サーブの練習：フォールトしてもダブルフォルトにならず、1本目から打ち直す ---
  {
    const calls = [];
    const g = new R.Game({ input: fakeInput, hooks: { ...noHooks, call: (b, s) => calls.push(`${b}|${s || ''}`) } });
    g.startPractice('serve');
    ok(g.phase === 'serve' && g.servingPlayer() === 'you', 'the serve lesson starts on your serve');
    const side = g.match.serveSide;
    g.serveFault('ネット');
    ok(g.practice.tries === 1 && g.practice.done === 0, 'a fault counts as a miss');
    for (let i = 0; i < 120 * 3 && g.phase !== 'serve'; i++) g.update(DT);
    ok(g.phase === 'serve' && g.serveNumber === 1, `then you serve again as a first serve, got ${g.phase} #${g.serveNumber}`);
    ok(g.match.serveSide === -side, 'from the other court (deuce / ad alternate)');
    g.serveFault('アウト');
    ok(!calls.some((c) => c.startsWith('ダブルフォルト')) && g.match.points.cpu === 0,
      'two faults in a row are not a double fault');
  }

  // --- レシーブの練習：CPU のフォールトは数えずに打ち直す ---
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.startPractice('return');
    ok(g.phase === 'serve' && g.servingPlayer() === 'cpu', 'the return lesson starts on the CPU serve');
    g.serveFault('アウト');
    ok(g.practice.tries === 0, `a CPU fault is not counted against you, got ${g.practice.tries}`);
    for (let i = 0; i < 120 * 3 && g.phase !== 'serve'; i++) g.update(DT);
    ok(g.phase === 'serve' && g.servingPlayer() === 'cpu', 'and the CPU serves again');
  }

  // --- 移動の練習：目印に入れば成功、次の目印は走った先から続ける ---
  {
    const { g } = practise('move', 2, BOTS.move);
    ok(g.practice.done === 2, `reaching the targets counts, got ${g.practice.done}`);
    Object.assign(g.input, { moveX: 0, moveZ: 0 }); // 2つ目に入った瞬間に手を離す
    for (let i = 0; i < 120 * 3 && !g.practice.target; i++) g.update(DT);
    const L = PRACTICE.LESSONS.find((l) => l.key === 'move');
    const reached = L.targets[1];
    ok(Math.hypot(g.you.x - reached.x, g.you.z - reached.z) <= PRACTICE.MOVE_RADIUS + 0.2,
      `the next target starts from where you ran to, got ${g.you.x.toFixed(2)},${g.you.z.toFixed(2)}`);
  }
}

// --- 線審のコール：1バウンド目の判定で、割った線（アウト／フォールト）と、ライン際に
//     入った球（セーフ）を lineCall に出す。声はアウト／フォールトだけ ---
{
  const { LINE_CALL, TIMING } = R.config;
  const sounds = [];
  const make = (doubles = false) => {
    sounds.length = 0;
    const g = new R.Game({ input: fakeInput, hooks: { ...noHooks, sound: (name, ...a) => sounds.push([name, ...a]) } });
    g.start(doubles, 'you');
    return g;
  };
  const rallyBounce = (g, x, z, last = 'cpu') => {
    g.phase = 'rally';
    g.serveInFlight = false;
    g.ball.live = true;
    g.ball.last = last;
    return bounceAt(g, x, z);
  };
  const voiced = () => sounds.filter(([n]) => n === 'lineCall').map(([, k]) => k);

  // ラリー：ベースラインの外（自陣の深く）＝アウト。線から外へ（-z）を指す。決着のコール
  {
    const g = make();
    rallyBounce(g, 1.0, -(HALF_L + 0.4));
    const c = g.lineCall;
    ok(c && c.kind === 'out' && c.line === 'base' && c.out.x === 0 && c.out.z === -1 && c.decisive,
      `a long ball is called out on the baseline, got ${JSON.stringify(c)}`);
    ok(voiced().join() === 'out', `and the judge shouts it, got ${JSON.stringify(sounds)}`);
    const near = sounds.filter(([n]) => n === 'nearLine');
    ok(near.length === 1 && Math.abs(near[0][1] - c.inside) < 1e-12 && c.inside < -0.3,
      `every call tells how close to the line it was (the crowd reacts only to close ones), got ${JSON.stringify(near)}`);
  }
  // ラリー：サイドラインの外。より大きく割った方の線になる
  {
    const g = make();
    rallyBounce(g, HALF_W + 0.5, -(HALF_L - 0.1));
    ok(g.lineCall && g.lineCall.kind === 'out' && g.lineCall.line === 'side' && g.lineCall.out.x === 1,
      `a wide ball is called on the sideline even near the corner, got ${JSON.stringify(g.lineCall)}`);
  }
  // ダブルスはダブルスのサイドラインで見る（シングルスの線の外でもインならセーフでもない）
  {
    const g = make(true);
    rallyBounce(g, HALF_W + 0.5, -5);
    ok(g.lineCall === null && g.phase === 'rally', `a doubles alley ball is in and not close, got ${JSON.stringify(g.lineCall)}`);
  }
  // ライン際のイン＝セーフ（無言）。余裕をもって入った球には何もしない
  {
    const g = make();
    rallyBounce(g, 1.0, -(HALF_L - LINE_CALL.SAFE_MARGIN * 0.5));
    ok(g.lineCall && g.lineCall.kind === 'safe' && g.lineCall.line === 'base' && !g.lineCall.decisive,
      `a ball just inside the baseline gets the safe signal, got ${JSON.stringify(g.lineCall)}`);
    ok(voiced().length === 0, 'the safe signal is silent');
    ok(sounds.some(([n, inside]) => n === 'nearLine' && inside >= 0 && inside <= LINE_CALL.SAFE_MARGIN),
      `but a ball just inside the line still reaches the crowd, got ${JSON.stringify(sounds)}`);
    const h = make();
    rallyBounce(h, 1.0, -(HALF_L - LINE_CALL.SAFE_MARGIN - 0.3));
    ok(h.lineCall === null, `a comfortably-in ball gets no call, got ${JSON.stringify(h.lineCall)}`);
  }
  // ネットを越えずに自陣に落ちた球は線の判定ではない
  {
    const g = make();
    rallyBounce(g, 1.0, 3, 'cpu');
    ok(g.lineCall === null, `a ball that never crossed the net gets no line call, got ${JSON.stringify(g.lineCall)}`);
  }
  // サーブ：サービスラインの外＝フォールト。1本目は決着ではなく、2本目（ダブルフォルト）は決着
  {
    const g = make();
    g.serve('you');
    bounceAt(g, 1.0, COURT.SERVICE + 0.5);
    ok(g.lineCall && g.lineCall.kind === 'fault' && g.lineCall.line === 'service' && g.lineCall.out.z === 1
      && !g.lineCall.decisive, `a long first serve is a fault on the service line, got ${JSON.stringify(g.lineCall)}`);
    ok(voiced().join() === 'fault', `and the judge shouts fault, got ${JSON.stringify(voiced())}`);
    g.tickTimers(TIMING.FAULT_CALL + 0.01);
    g.serve('you');
    bounceAt(g, -0.4, 3); // センターサービスラインの向こう（受ける側と反対の箱）
    ok(g.lineCall && g.lineCall.kind === 'fault' && g.lineCall.line === 'center' && g.lineCall.out.x === -1
      && g.lineCall.decisive, `a second serve over the center line is a deciding fault, got ${JSON.stringify(g.lineCall)}`);
  }
  // サーブ：ライン際に入ればセーフ。次のポイントでコールは消える
  {
    const g = make();
    g.serve('you');
    bounceAt(g, 1.0, COURT.SERVICE - 0.05);
    ok(g.lineCall && g.lineCall.kind === 'safe' && g.lineCall.line === 'service',
      `a serve just inside the service line gets the safe signal, got ${JSON.stringify(g.lineCall)}`);
    g.newPoint();
    ok(g.lineCall === null, 'the call is cleared at the next point');
  }
}

// --- ボールマーク：バウンドごとに接地点と弾む直前の速度が lastBounce に出て、コールが
//     あればそれが付く。跡は「線に掛かる ⇔ イン」になるよう置かれる（scene/marks.js） ---
{
  vm.runInContext(fs.readFileSync(path.join(SRC, 'scene', 'marks.js'), 'utf8'), sandbox, { filename: 'marks.js' });
  const markShape = R.scene.ballMarkShape;
  const { BALL_MARK, PHYSICS: P } = R.config;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start(false, 'you');
  g.phase = 'rally';
  g.serveInFlight = false;
  g.ball.live = true;
  g.ball.last = 'you';
  Object.assign(g.ball, { vx: 1.5, vz: 18 });
  bounceAt(g, 1.0, 5);
  const b = g.lastBounce;
  ok(b && b.x === g.ball.x && b.z === g.ball.z && b.vx === 1.5 && b.vz === 18 && b.call === null,
    `a mid-court bounce records where and how fast it landed, with no call, got ${JSON.stringify(b)}`);

  // 線の際をランダムに：コールの内外と、跡のコート側の端（線の法線方向）を見比べる
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const h = new R.Game({ input: fakeInput, hooks: noHooks });
    h.start(false, 'you');
    h.phase = 'rally';
    h.serveInFlight = false;
    h.ball.live = true;
    h.ball.last = 'you';
    const nearBase = i % 2 === 0;
    const x = nearBase ? (Math.random() - 0.5) * 6 : (HALF_W + (Math.random() - 0.5) * 0.4) * (Math.random() < 0.5 ? -1 : 1);
    const z = nearBase ? HALF_L + (Math.random() - 0.5) * 0.4 : 2 + Math.random() * 8;
    Object.assign(h.ball, { vx: (Math.random() - 0.5) * 10, vz: 5 + Math.random() * 25 });
    bounceAt(h, x, z);
    const call = h.lineCall;
    const bounce = h.lastBounce;
    if (!call || call.kind === 'safe' && call.inside > BALL_MARK.HALF_WIDTH * 3) continue;
    ok(bounce.call === call, 'the call is attached to the bounce it judged');
    const shape = markShape(bounce);
    const n = call.out;
    // 跡（楕円）が法線 n の向きでいちばんコート側に来る点
    const along = shape.u.x * n.x + shape.u.z * n.z;
    const across = -shape.u.z * n.x + shape.u.x * n.z;
    const inner = shape.x * n.x + shape.z * n.z - Math.hypot(shape.a * along, shape.b * across);
    const contact = bounce.x * n.x + bounce.z * n.z;
    ok(Math.abs(inner - contact) < 1e-9, `the mark starts exactly at the contact point, got ${inner} vs ${contact}`);
    const edge = (call.line === 'base' ? HALF_L : HALF_W) + COURT.LINE_SLACK; // 線の外縁（判定の境目）
    if (call.kind === 'out') ok(inner > edge, `an out mark stays clear of the line, inner=${inner.toFixed(3)} edge=${edge}`);
    else ok(inner <= edge, `an in mark reaches the line, inner=${inner.toFixed(3)} edge=${edge}`);
    checked++;
  }
  ok(checked > 100, `enough line-side bounces were checked, got ${checked}`);
}

// --- Extreme：角へ振られても、ロブに逃げず深い球で守る ---
// ユーザー報告「ベースラインの打ち合いで CPU がロブを上げてくるので、それを強打すると CPU が
// 弱い球しか返せなくなり、左右に振って勝ててしまう」。強い球で角へ振られると CPU は 4〜5m
// 走る。Hard まではそれで追い込まれた扱い（山なりで浅い球・ロブ）になるが、Extreme は崩れない。
{
  const { CPU, applyCpuLevel } = R.config;
  const { clamp } = R.math;
  const RUN = 4.5; // 角へ振られた1本で走る距離(m)
  const sample = (level) => {
    applyCpuLevel(level);
    const stretch = clamp((RUN - CPU.STRETCH_DIST_MIN) / (CPU.STRETCH_DIST_MAX - CPU.STRETCH_DIST_MIN), 0, 1);
    let lobs = 0;
    let rally = 0;
    let depth = 0;
    let flight = 0;
    const n = 600;
    for (let i = 0; i < n; i++) {
      const shot = R.ai.cpuShot({ x: 0.5, z: -HALF_L - 0.5 }, -1, stretch);
      if (shot.lob) {
        lobs++;
        continue;
      }
      rally++;
      depth += Math.abs(shot.target.z);
      flight += shot.flight;
    }
    return { lob: lobs / n, depth: depth / rally, flight: flight / rally };
  };
  try {
    const hard = sample('hard');
    const extreme = sample('extreme');
    ok(hard.lob > 0.2 && hard.depth < 7.5,
      `precondition: a 4.5m run still rattles Hard (lob ${hard.lob.toFixed(2)}, depth ${hard.depth.toFixed(2)}m)`);
    ok(extreme.lob < 0.12, `Extreme rarely lobs after being pulled wide, got ${extreme.lob.toFixed(2)}`);
    ok(extreme.depth > 8, `and still keeps it deep, got ${extreme.depth.toFixed(2)}m from the net`);
    ok(extreme.flight < hard.flight - 0.2,
      `and flatter than Hard, got ${extreme.flight.toFixed(2)}s vs ${hard.flight.toFixed(2)}s`);
  } finally {
    applyCpuLevel('normal');
  }
}

// --- AI のジャックナイフは、跳んでから打つ（跳ぶのと打つのが同時に見えない） ---
// ユーザー報告「CPU がジャックナイフするとき、ジャンプと打つのが同時に見える」。以前は AI だけ
// 当たった瞬間（hit()）から跳んでいた。人間（tickLeap()）と同じく、当たる踏み切りぶん前から跳ぶ。
{
  const { applyCpuLevel, SPECIAL: SP } = R.config;
  const RISE = SP.JACK.LEAP_T * SP.JACK.LEAP_RISE; // 踏み切りから頂点まで
  /** CPU のバックハンド側（world -x）へ、ゆるく高く弾む球を1本送って、打つまで進める */
  const highToBackhand = (commit) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.setSpecials(R.config.SPECIAL_MOVES.map((m) => m.key));
    g.start(false, 'you');
    Object.assign(g, { phase: 'rally', serveInFlight: false, wind: 0, windZ: 0 });
    g.cpu.x = 0;
    g.cpu.z = HALF_L - 0.3;
    const from = { x: 0, y: 1.0, z: -HALF_L + 0.5 };
    Object.assign(g.ball,
      R.physics.solveShot(from, { x: -1.5, y: R.config.PHYSICS.BALL_R, z: HALF_L - 4.5 }, 1.3, undefined, 'top', 0),
      from, { live: true, last: 'you', bounces: 0, age: 0, spin: 'top', wind: 0, windZ: 0, curve: 0 });
    g.ball.shotSpeed = Math.hypot(g.ball.vx, g.ball.vz);
    g.lastBallOwnerSeen = 'you'; // 「相手が打った」の抽選はもう済んだことにして、結果だけ決める
    g.jackCommit.cpu = commit;
    let leaptBeforeHit = false;
    let airborneAtHit = null; // 当たったフレームの終わりで、跳び始めてから何秒たっていたか
    for (let f = 0; f < 240 && g.ball.last === 'you'; f++) {
      g.update(1 / 60);
      if (g.ball.last === 'cpu') airborneAtHit = g.cpu.leap ? g.cpu.leap.span - g.cpu.leap.t : null;
      else if (g.cpu.leap) leaptBeforeHit = true;
    }
    return { g, leaptBeforeHit, airborneAtHit };
  };
  applyCpuLevel('extreme');
  try {
    const jack = highToBackhand(true);
    ok(jack.g.cpu.stroke === 'jackknife', `precondition: the AI jackknifes this ball, got ${jack.g.cpu.stroke}`);
    ok(jack.leaptBeforeHit, 'the AI is already in the air before it swings');
    // 当たったフレームの中で跳躍の時計がもう1フレームぶん進むので、その幅を見込む
    ok(jack.airborneAtHit !== null && jack.airborneAtHit >= RISE - 1 / 60 && jack.airborneAtHit <= RISE + 2 / 60,
      `and meets the ball at the top of the jump (${RISE.toFixed(3)}s after take-off), got ${jack.airborneAtHit}`);
    // 跳ぶ抽選に外れた球では跳ばない＝跳ばずにジャックナイフが出ることもない
    const plain = highToBackhand(false);
    ok(!plain.leaptBeforeHit && plain.g.cpu.stroke !== 'jackknife' && !plain.g.cpu.leap,
      `without the roll the AI neither jumps nor jackknifes, got ${plain.g.cpu.stroke}`);
  } finally {
    applyCpuLevel('normal');
  }
}

// --- AI のスマッシュ（ダンクスマッシュ含む）も、跳んでから打つ ---
// ユーザー要望「CPU スマッシュも（ジャックナイフと）同様に直して」。跳ぶ高さは打点で決まり
// （立って届く高さなら跳ばない）、ダンクにするかも跳ぶときに決まる。
{
  const { applyCpuLevel, SPECIAL: SP, SWING: SW } = R.config;
  const RISE = R.config.PLAYER.SMASH_LEAP_T * R.config.PLAYER.SMASH_LEAP_RISE;
  const DUNK_LIFT = SW.SMASH_JUMP_H * SP.DUNK.JUMP_MULT;
  /** ネットへ詰めている CPU へ、頭上を越えそうな山なりの球を1本送って、打つまで進める */
  const lobAtNet = (dunk) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.setSpecials(R.config.SPECIAL_MOVES.map((m) => m.key));
    g.start(false, 'you');
    Object.assign(g, { phase: 'rally', serveInFlight: false, wind: 0, windZ: 0, cpuNetRush: true });
    g.cpu.x = 0;
    g.cpu.z = 4;
    const from = { x: 0, y: 1.0, z: -HALF_L + 0.5 };
    Object.assign(g.ball,
      R.physics.solveShot(from, { x: 0.3, y: R.config.PHYSICS.BALL_R, z: 7 }, 1.3, undefined, 'flat', 0),
      from, { live: true, last: 'you', bounces: 0, age: 0, spin: 'flat', wind: 0, windZ: 0, curve: 0 });
    g.ball.shotSpeed = Math.hypot(g.ball.vx, g.ball.vz);
    g.lastBallOwnerSeen = 'you';
    g.dunkCommit.cpu = dunk;
    g.jackCommit.cpu = false;
    let leaptBeforeHit = false;
    let airborneAtHit = null;
    let lift = null;
    for (let f = 0; f < 240 && g.ball.last === 'you'; f++) {
      g.update(1 / 60);
      if (g.ball.last === 'cpu') {
        airborneAtHit = g.cpu.leap ? g.cpu.leap.span - g.cpu.leap.t : null;
        lift = g.cpu.leap ? g.cpu.leap.lift : null;
      } else if (g.cpu.leap) {
        leaptBeforeHit = true;
      }
    }
    return { g, leaptBeforeHit, airborneAtHit, lift };
  };
  const atTop = (t) => t !== null && t >= RISE - 1 / 60 && t <= RISE + 2 / 60;
  applyCpuLevel('hard');
  try {
    const smash = lobAtNet(false);
    ok(smash.g.cpu.stroke === 'smash' && smash.g.cpu.special === null,
      `precondition: the AI smashes this lob, got ${smash.g.cpu.stroke}/${smash.g.cpu.special}`);
    ok(smash.leaptBeforeHit, 'the AI is already in the air before it smashes');
    ok(atTop(smash.airborneAtHit),
      `and meets the ball at the top of the jump (${RISE.toFixed(3)}s after take-off), got ${smash.airborneAtHit}`);
    ok(smash.lift > 0 && smash.lift < DUNK_LIFT * 0.5,
      `a plain smash jumps only as high as the contact needs, got ${smash.lift}`);
    const dunk = lobAtNet(true);
    ok(dunk.g.cpu.special === 'dunkSmash', `with the roll it is a dunk, got ${dunk.g.cpu.special}`);
    ok(dunk.leaptBeforeHit && atTop(dunk.airborneAtHit),
      `the dunk is also jumped before it is hit, got ${dunk.airborneAtHit}`);
    ok(Math.abs(dunk.lift - DUNK_LIFT) < 0.02, `and at the dunk height, got ${dunk.lift} vs ${DUNK_LIFT}`);
  } finally {
    applyCpuLevel('normal');
  }
}

// --- ネットに掛かって決まった球は、その場で止まらず1バウンドするまで落ちて軌跡に残る ---
{
  const { NET, PHYSICS } = R.config;
  const savedIn = NET.IN_CHANCE;
  NET.IN_CHANCE = 0; // ネットインの抽選を外す
  try {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start(false, 'you');
    g.phase = 'rally';
    g.serveInFlight = false;
    Object.assign(g.ball, {
      x: 0, y: 0.5, z: -2, px: 0, py: 0.5, pz: -2, vx: 0, vy: 0, vz: 15,
      live: true, last: 'you', bounces: 0, age: 0, sinceBounce: 0, spin: 'flat', curve: 0, wind: 0, windZ: 0,
    });
    g.resetTrail();
    let hitNetAt = null;
    for (let i = 0; i < 60 * 3; i++) {
      g.update(1 / 60);
      if (hitNetAt === null && g.phase === 'over') hitNetAt = g.trail.length;
      else if (hitNetAt !== null && !g.ball.netFall) break; // 着地した
    }
    ok(hitNetAt !== null && g.phase === 'over', `the ball into the net ends the point, got phase=${g.phase}`);
    ok(Math.abs(g.ball.y - PHYSICS.BALL_R) < 1e-6 && g.ball.z < 0 && !g.ball.netFall,
      `after the net the ball keeps falling to the hitter's side and rests on the ground, got y=${g.ball.y} z=${g.ball.z}`);
    const last = g.trail[g.trail.length - 1];
    ok(g.trail.length > hitNetAt + 5 && Math.abs(last.y - PHYSICS.BALL_R) < 1e-6,
      `the trail follows the fall down to the bounce (${hitNetAt} -> ${g.trail.length} points, last y=${last.y})`);
  } finally {
    NET.IN_CHANCE = savedIn;
  }
}

console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
process.exit(fail ? 1 : 0);
