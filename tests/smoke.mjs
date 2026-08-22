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

const { HALF_W, HALF_L, COURT, PLAYER, SERVE } = R.config;
const fakeInput = { moveX: 0, moveZ: 0, lob: false };
const noHooks = {
  sound() {}, call() {}, clearCall() {}, score() {}, wind() {},
};

/** 即座に離す（溜め時間0）タップ。1回の Space 押下＋即離しを表す。 */
function tap(g) {
  g.chargeStart();
  g.chargeRelease();
}

/**
 * Space を押しっぱなしにしてサーブする、を模した実際のフロー。
 * 押下と同時にトス＋テイクバックの溜めが始まり、holdFrames ぶん待ってから離す＝打つ。
 */
function tossAndHit(g, holdFrames = 0) {
  g.chargeStart(); // トスとチャージを同時に開始
  for (let f = 0; f < holdFrames; f++) g.update(1 / 60);
  g.chargeRelease(); // 離した瞬間に打つ
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
  ok(inBox === 200, `serves in the service box: ${inBox}/200`);
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
  let faults = 0;
  let minMargin = Infinity;
  const N = 300;
  for (let i = 0; i < N; i++) {
    const g = new R.Game({ input, hooks: noHooks });
    g.started = true;
    g.newPoint();
    tossAndHit(g, SWEET_FRAMES);
    ok(g.you.swingCharge > 0.85, `precondition: released at the sweet spot for full power, got ${g.you.swingCharge}`);
    const L = R.physics.predictLanding(g.ball);
    if (L.net || Math.abs(L.x) > HALF_W || L.z <= 0 || L.z > COURT.SERVICE) faults++;
    minMargin = Math.min(minMargin, HALF_W - Math.abs(L.x));
  }
  ok(faults === 0, `wide full-power serves don't fault: ${faults}/${N}`);
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

  g.chargeRelease();
  ok(g.tossActive === false, 'releasing Space ends the toss');
  ok(g.ball.live === true, 'ball becomes live after releasing');
  ok(g.phase === 'rally', 'phase moves to rally after releasing');
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

  // 離した瞬間から通常どおり動ける
  g.chargeRelease();
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

// --- サーブはノーバウンドで打ち返してはいけない（volley禁止） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  tap(g); // Space 押して即離す＝トスして打つ
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
  g.ball.bounces = 0;
  g.ball.x = 1.0; g.ball.y = 0; g.ball.vy = -1; g.ball.z = COURT.SERVICE + 1;
  const ended = g.bounce();
  ok(ended === true, 'a serve landing past the service line ends this attempt (fault)');
  ok(g.serveNumber === 2, 'first fault moves to the second serve');
  ok(g.phase === 'serve', 'does not end the point, goes back to waiting to serve');
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

// --- 1本目がフォールトしても、2本目が入れば普通にラリーへ進む ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.serve('you');
  g.ball.bounces = 0;
  g.ball.x = 1.0; g.ball.y = 0; g.ball.vy = -1; g.ball.z = COURT.SERVICE + 1; // 1本目アウト
  g.bounce();
  ok(g.serveNumber === 2, 'precondition: on the second serve');

  tossAndHit(g); // セカンドサーブを普通に打つ
  ok(g.phase === 'rally', 'a valid second serve starts the rally as normal');
  const L = R.physics.predictLanding(g.ball);
  ok(!L.net && Math.abs(L.x) <= HALF_W && L.z > 0 && L.z <= COURT.SERVICE,
    'the second serve itself lands in the service box like a first serve would');
}

// --- スタッツ：ダブルフォルトはサーバー側のカウントに積む ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  ok(g.stats.you.doubleFaults === 0 && g.stats.cpu.doubleFaults === 0, 'precondition: no stats yet');

  g.serve('you');
  g.ball.bounces = 0;
  g.ball.x = 1.0; g.ball.y = 0; g.ball.vy = -1; g.ball.z = COURT.SERVICE + 1; // 1本目アウト
  g.bounce();
  ok(g.serveNumber === 2, 'precondition: on the second serve');

  g.serve('you');
  g.ball.x = 1; g.ball.z = -0.01; g.ball.y = 0.3; g.ball.vx = 0; g.ball.vy = 0; g.ball.vz = 5;
  g.stepBall(0.05); // 2本目もネットにかかる＝ダブルフォルト
  ok(g.phase === 'over', 'precondition: double fault ends the point');
  ok(g.stats.you.doubleFaults === 1, 'double fault counts against the server (you)');
  ok(g.stats.cpu.doubleFaults === 0, "double fault doesn't count against the receiver");
}

// --- スタッツ：エースはサーブが一度も返球されずに2バウンドで決まったときだけ積む ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.serve('you');
  ok(g.serveInFlight === true, 'precondition: serve in flight');
  // サービスボックス内に着地（フォールトではない）
  g.ball.bounces = 0;
  g.ball.x = 1.0; g.ball.y = 0; g.ball.vy = -1; g.ball.z = 3;
  const decided1 = g.bounce();
  ok(decided1 === false, 'precondition: lands in the box, point continues');
  ok(g.serveInFlight === true, 'precondition: still not returned');

  // 誰も触れないまま2バウンド目＝エース
  g.ball.bounces = 1;
  g.ball.y = 0; g.ball.vy = -1;
  const decided2 = g.bounce();
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
  g.ball.bounces = 0;
  g.ball.x = 1.0; g.ball.y = 0; g.ball.vy = -1; g.ball.z = 3;
  g.bounce(); // サービスボックスに着地
  g.hit('cpu'); // リターンされる＝serveInFlight が解除される
  ok(g.serveInFlight === false, 'precondition: the serve has been returned');

  g.ball.bounces = 1;
  g.ball.y = 0; g.ball.vy = -1;
  g.bounce(); // 相手が拾えず2バウンド
  ok(g.phase === 'over', 'precondition: point ends on the second bounce');
  ok(g.stats.you.aces === 0,
    'a rally point (serve already returned) is not an ace, even if it ends on a double bounce');
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
  ok(Math.abs(cruiseSpeed - PLAYER.SPEED) < 0.01, `eventually reaches full speed: ${cruiseSpeed}`);

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
    for (let i = 0; i < 15; i++) g.update(1 / 60); // MAX_TIME の約半分
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

// --- 溜めの強弱が体感できる差になっている（初速・深さ・演出）---
// 「溜めても変わった気がしない」という退行を防ぐため、最低限の差を数値で固定する。
{
  const hitWith = (charge) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
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

  ok(fullShot.speed > tapShot.speed * 1.6,
    `full charge should be at least 60% faster: tap=${tapShot.speed.toFixed(1)} full=${fullShot.speed.toFixed(1)}`);
  ok(fullShot.landing.z > tapShot.landing.z + 2.5,
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

// --- 打点のタイミングでコースがずれる（早い=引っ張る／遅い=流れる、フォアとバックで逆） ---
{
  const { NEUTRAL_DZ, HALF_BAND, MAX_SHIFT } = R.config.TIMING_AIM;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.you.x = 0; // baseX を固定するため

  const early = NEUTRAL_DZ + HALF_BAND; // timing = +1（前で捉えた＝早い）
  const late = NEUTRAL_DZ - HALF_BAND;  // timing = -1（引きつけた＝遅い）
  const neutral = NEUTRAL_DZ;           // timing = 0（ずれない）

  const foreEarly = g.playerShot('forehand', early).target.x;
  const foreLate = g.playerShot('forehand', late).target.x;
  const foreNeutral = g.playerShot('forehand', neutral).target.x;
  const backEarly = g.playerShot('backhand', early).target.x;
  const backLate = g.playerShot('backhand', late).target.x;

  ok(Math.abs(foreEarly - foreNeutral - (-MAX_SHIFT)) < 1e-9,
    `forehand early pulls by -MAX_SHIFT, got shift=${(foreEarly - foreNeutral).toFixed(2)}`);
  ok(Math.abs(foreLate - foreNeutral - MAX_SHIFT) < 1e-9,
    `forehand late flows by +MAX_SHIFT, got shift=${(foreLate - foreNeutral).toFixed(2)}`);

  // フォアとバックでは体を横切る向きが逆なので、同じ早い/遅いでもずれる方向が逆になる
  ok(Math.sign(backEarly - foreNeutral) === -Math.sign(foreEarly - foreNeutral),
    `backhand early should pull the OPPOSITE way from forehand early: fore=${(foreEarly - foreNeutral).toFixed(2)} back=${(backEarly - foreNeutral).toFixed(2)}`);
  ok(Math.sign(backLate - foreNeutral) === -Math.sign(foreLate - foreNeutral),
    `backhand late should flow the OPPOSITE way from forehand late: fore=${(foreLate - foreNeutral).toFixed(2)} back=${(backLate - foreNeutral).toFixed(2)}`);

  // ロブはタイミングの影響を受けない
  const input2 = { moveX: 0, moveZ: 0, lob: true };
  const gLob = new R.Game({ input: input2, hooks: noHooks });
  gLob.you.x = 0;
  const lobEarly = gLob.playerShot('forehand', early).target.x;
  const lobLate = gLob.playerShot('forehand', late).target.x;
  ok(lobEarly === lobLate, `lob ignores timing, got early=${lobEarly} late=${lobLate}`);

  // ←→ の方向指定と足し算で合成される（タイミングだけが上書きするわけではない）
  const input3 = { moveX: -1, moveZ: 0, lob: false }; // 画面右 = world +x
  const gAim = new R.Game({ input: input3, hooks: noHooks });
  gAim.you.x = 0;
  const aimOnly = gAim.playerShot('forehand', neutral).target.x;
  const aimPlusEarly = gAim.playerShot('forehand', early).target.x;
  ok(Math.abs(aimPlusEarly - aimOnly - (-MAX_SHIFT)) < 1e-9,
    `arrow-key aim composes with timing shift, got diff=${(aimPlusEarly - aimOnly).toFixed(2)}`);

  // 通常のタイミング（実測レンジの中心付近）ならコート内に収まる
  let out = 0;
  for (let i = 0; i < 100; i++) {
    const gg = new R.Game({ input: fakeInput, hooks: noHooks });
    gg.start();
    gg.phase = 'rally';
    gg.you.x = 0; gg.you.z = -5;
    gg.ball.x = 0.3; gg.ball.y = 1.0; gg.ball.z = -5 + (0.9 + Math.random() * 0.6); // 実測レンジ内
    gg.ball.bounces = 1; // 既にバウンド済みの通常のグラウンドストローク（ボレー扱いにしない）
    gg.hit('you');
    if (R.physics.predictLanding(gg.ball).z > HALF_L) out++;
  }
  ok(out === 0, `normal-timing shots should still land in: ${out}/100 went long`);
}

// --- サーブは「長く溜めるほど強い」のではなく、ちょうど良いタイミングで離すと最強、
//     早すぎても遅すぎても弱くなる（三角形のカーブ） ---
{
  const { T, CHARGE_T } = R.config.SERVE;
  const { CHARGE_SWEET_T, CHARGE_WINDOW } = R.config.SERVE;

  // 純粋関数としてのカーブ形状
  {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    ok(g.serveTimingPower(CHARGE_SWEET_T) === 1, 'releasing exactly at the sweet spot is max power');
    ok(g.serveTimingPower(0) < g.serveTimingPower(CHARGE_SWEET_T),
      'releasing immediately (too early) is weaker than the sweet spot');
    ok(g.serveTimingPower(CHARGE_SWEET_T + CHARGE_WINDOW * 2) === 0,
      'holding well past the sweet spot (too late) bottoms out at 0, not increasing further');
    const early = g.serveTimingPower(CHARGE_SWEET_T - CHARGE_WINDOW / 2);
    const late = g.serveTimingPower(CHARGE_SWEET_T + CHARGE_WINDOW / 2);
    ok(Math.abs(early - late) < 1e-9, `equally early/late from the sweet spot weaken it the same amount: early=${early} late=${late}`);
  }

  // 実際のトス→保持→リリースを通した結果（球速で確認）
  const landingFor = (holdFrames) => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    tossAndHit(g, holdFrames);
    return g.ball;
  };
  const speedOf = (ball) => Math.hypot(ball.vx, ball.vy, ball.vz);

  // 「長すぎ」はトスの自動リセット（約0.79秒）より確実に手前で、かつ CHARGE_WINDOW の
  // 下り坂の途中（威力が0まで落ちきる少し手前）になるタイミングを選ぶ。
  const tapSpeed = speedOf(landingFor(0)); // 即リリース＝早すぎ
  const sweetSpeed = speedOf(landingFor(Math.round(CHARGE_SWEET_T * 60))); // ちょうど良いタイミング
  const tooLongSpeed = speedOf(landingFor(Math.round((CHARGE_SWEET_T + CHARGE_WINDOW * 0.9) * 60))); // 長すぎ

  ok(sweetSpeed > tapSpeed,
    `sweet-spot serve is faster than releasing immediately: sweet=${sweetSpeed.toFixed(2)} tap=${tapSpeed.toFixed(2)}`);
  ok(sweetSpeed > tooLongSpeed,
    `sweet-spot serve is faster than holding too long: sweet=${sweetSpeed.toFixed(2)} tooLong=${tooLongSpeed.toFixed(2)}`);
  ok(T > CHARGE_T, `precondition: SERVE.CHARGE_T should be shorter (faster) than SERVE.T`);
}

// --- chargeMeter()（HUDゲージ用の先読み）はサーブ中はタイミングのカーブを、
//     ラリー中は溜め時間の割合を返す ---
{
  const { CHARGE_SWEET_T } = R.config.SERVE;
  const { MAX_TIME } = R.config.CHARGE;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  ok(g.chargeMeter() === 0, 'no meter while not charging');

  g.start();
  g.chargeStart(); // サーブのトス＆チャージ開始
  const sweetFrames = Math.round(CHARGE_SWEET_T * 60);
  for (let i = 0; i < sweetFrames; i++) g.update(1 / 60);
  ok(Math.abs(g.chargeMeter() - 1) < 0.05, `serve meter peaks near the sweet spot, got ${g.chargeMeter()}`);
  for (let i = 0; i < sweetFrames; i++) g.update(1 / 60); // さらに同じだけ長く保持し続ける
  ok(g.chargeMeter() < 0.2, `serve meter falls back down when held well past the sweet spot, got ${g.chargeMeter()}`);
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

// --- フォアハンド/バックハンドの判定（ボールの仮想延長線がラケット側か逆側か） ---
// vx/vz を0にして、速度による延長を無効化し、打点の位置関係だけを見る。
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.you.x = 0;
  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2; g.ball.vx = 0; g.ball.vz = 0; // 'you' の world +x 側 = ラケット側
  g.hit('you');
  ok(g.you.stroke === 'forehand', `ball on racket side -> forehand, got ${g.you.stroke}`);

  g.ball.x = -1.5; g.ball.y = 1; g.ball.z = -2; g.ball.vx = 0; g.ball.vz = 0; // world -x 側 = 逆側
  g.hit('you');
  ok(g.you.stroke === 'backhand', `ball on off side -> backhand, got ${g.you.stroke}`);

  // cpu は180°回転しているので判定が反転する（world -x 側がラケット側）
  g.cpu.x = 0;
  g.ball.x = -1.5; g.ball.y = 1; g.ball.z = 2; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('cpu');
  ok(g.cpu.stroke === 'forehand', `cpu: ball on its racket side -> forehand, got ${g.cpu.stroke}`);

  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = 2; g.ball.vx = 0; g.ball.vz = 0;
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
  // 今は 'you' のラケット側(+x)にいるが、-x 方向へ進んでいて、届く頃には逆側(-x)に来る
  g.ball.x = 0.3; g.ball.y = 1; g.ball.z = -3;
  g.ball.vx = -4; g.ball.vz = -4; // player.z へ向かって進む
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

// --- full match simulation（フリーズ・タイマーリーク・スコア破綻がないか） ---
{
  const events = [];
  const g = new R.Game({
    input: fakeInput,
    hooks: { ...noHooks, call: (big, sub) => events.push(`${big}|${sub}`) },
  });
  g.start();
  for (let i = 0; i < 60 * 600; i++) {
    if (g.phase === 'serve' && g.server === 'you') tap(g);
    if (g.phase === 'rally' && i % 6 === 0) tap(g);
    g.update(1 / 60);
  }
  ok(events.length > 20, `calls fired: ${events.length}`);
  ok(Number.isFinite(g.ball.x) && Number.isFinite(g.ball.y), 'ball stays finite');
  ok(g.timers.length <= 1, `timers do not leak: ${g.timers.length}`);
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

// --- ダブルス：chasePosition(ball, side) は side=-1 のとき自陣(z<0)側に鏡映しになる ---
// (退行テスト: side を渡さないと常に cpu 陣地(z>0)基準の値を返していたため、
//  youMate が you 陣地の落下点を追うときにネットの向こう側へ寄ってしまうバグがあった)
{
  const { chasePosition } = R.ai;
  const deepCpuBall = { x: 1, y: 1, z: 9, vx: 0, vy: 1, vz: 0 };
  const deepYouBall = { x: 1, y: 1, z: -9, vx: 0, vy: 1, vz: 0 }; // 鏡映しの入力
  const cpuSide = chasePosition(deepCpuBall, 1);
  const youSide = chasePosition(deepYouBall, -1);
  ok(cpuSide.z > 0, `default/side=1 stays on the cpu side for a deep cpu-side ball, z=${cpuSide.z}`);
  ok(youSide.z < 0, `side=-1 stays on the you side for the mirrored deep you-side ball, z=${youSide.z}`);
  ok(Math.abs(youSide.z) === Math.abs(cpuSide.z), 'side=-1 mirrors the magnitude of side=1 for mirrored inputs');

  const shallowYouBall = { x: 0, y: 1, z: -0.5, vx: 0, vy: 1, vz: 0 };
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

  // CPU_SERVE_DELAY (0.9s) が過ぎる前の複数フレームぶん進める。まだ serve() は呼ばれていない。
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
  ok(g.timers.length <= 1, `doubles: timers do not leak: ${g.timers.length}`);
}

// --- CPU/AIの強さプリセット（Easy/Normal/Hard）：スタート画面の難易度選択が実際にCPUの値へ反映される ---
{
  const { CPU_LEVELS, applyCpuLevel } = R.config;
  ok(!!CPU_LEVELS.easy && !!CPU_LEVELS.normal && !!CPU_LEVELS.hard, 'three presets exist');

  applyCpuLevel('normal'); // 他のテストの実行順に依存しないよう、まずベースラインへ戻す
  const baseline = { ...R.config.CPU };
  const basePlayerCpu = {
    CPU_CHASE: R.config.PLAYER.CPU_CHASE,
    CPU_RECOVER: R.config.PLAYER.CPU_RECOVER,
    CPU_REACT: R.config.PLAYER.CPU_REACT,
  };

  applyCpuLevel('easy');
  ok(R.config.CPU.OUT_LONG > baseline.OUT_LONG && R.config.CPU.OUT_WIDE > baseline.OUT_WIDE,
    `easy misses more often than normal: OUT_LONG=${R.config.CPU.OUT_LONG} OUT_WIDE=${R.config.CPU.OUT_WIDE}`);
  ok(R.config.CPU.SHOT_T > baseline.SHOT_T, 'easy hits slower/loopier shots than normal');
  ok(R.config.PLAYER.CPU_REACT > basePlayerCpu.CPU_REACT, 'easy reacts slower than normal');
  ok(R.config.PLAYER.CPU_CHASE < basePlayerCpu.CPU_CHASE, 'easy chases slower than normal');

  applyCpuLevel('hard');
  ok(R.config.CPU.OUT_LONG < baseline.OUT_LONG && R.config.CPU.OUT_WIDE < baseline.OUT_WIDE,
    `hard misses less often than normal: OUT_LONG=${R.config.CPU.OUT_LONG} OUT_WIDE=${R.config.CPU.OUT_WIDE}`);
  ok(R.config.CPU.SHOT_T < baseline.SHOT_T, 'hard hits faster/flatter shots than normal');
  ok(R.config.PLAYER.CPU_REACT < basePlayerCpu.CPU_REACT, 'hard reacts faster than normal');
  ok(R.config.PLAYER.CPU_CHASE > basePlayerCpu.CPU_CHASE, 'hard chases faster than normal');

  applyCpuLevel('normal');
  ok(JSON.stringify(R.config.CPU) === JSON.stringify(baseline), 'switching back to normal restores the baseline CPU values');
  ok(R.config.PLAYER.CPU_CHASE === basePlayerCpu.CPU_CHASE && R.config.PLAYER.CPU_REACT === basePlayerCpu.CPU_REACT,
    'switching back to normal restores the baseline PLAYER CPU values');

  // COURT/RULES 等のゲームルール寄りの値には触れない
  ok(R.config.COURT.W === 8.23, 'applyCpuLevel does not touch court dimensions');
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

// --- スピン選択：C=スライス／V=トップスピン。何も押さなければ従来通りフラット固定（回帰なし） ---
{
  // 通常のグラウンドストローク：入力を反映する
  const spinInput = { moveX: 0, moveZ: 0, lob: false, spin: null };
  const g = new R.Game({ input: spinInput, hooks: noHooks });
  g.start();
  g.you.z = -HALF_L - 0.6; // ベースライン付近＝ボレー圏外にしておく
  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;

  spinInput.spin = null;
  g.hit('you');
  ok(g.ball.spin === 'flat', `no modifier held -> flat (unchanged default), got ${g.ball.spin}`);

  spinInput.spin = 'top';
  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('you');
  ok(g.ball.spin === 'top', `holding V (topspin) is applied to a groundstroke, got ${g.ball.spin}`);

  spinInput.spin = 'slice';
  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('you');
  ok(g.ball.spin === 'slice', `holding C (slice) is applied to a groundstroke, got ${g.ball.spin}`);

  // スマッシュ：スピン選択の対象外（フラット固定）
  spinInput.spin = 'top';
  g.you.chargeStroke = null;
  g.you.swingCharge = PLAYER.SMASH_MIN_CHARGE;
  g.ball.x = 0; g.ball.y = PLAYER.SMASH_MIN_Y + 0.1; g.ball.z = -HALF_L - 0.6; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('you');
  ok(g.you.stroke === 'smash', 'precondition: this hit is classified as a smash');
  ok(g.ball.spin === 'flat', `smash ignores spin input and stays flat, got ${g.ball.spin}`);

  // ボレー：スピン選択の対象外（フラット固定）
  spinInput.spin = 'slice';
  g.you.swingCharge = 0;
  g.you.x = 0; g.you.z = -1; // サービスラインより前＝ボレー圏内
  g.ball.x = 0.5; g.ball.y = 1; g.ball.z = -1.5; g.ball.bounces = 0; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('you');
  ok(g.you.stroke.startsWith('volley-'), 'precondition: this hit is classified as a volley');
  ok(g.ball.spin === 'flat', `volley ignores spin input and stays flat, got ${g.ball.spin}`);

  // CPU/AIの返球：人間の入力に関わらず常にフラット
  spinInput.spin = 'top';
  g.cpu.x = 0; g.cpu.z = HALF_L + 0.5;
  g.ball.x = 0; g.ball.y = 1; g.ball.z = 2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('cpu');
  ok(g.ball.spin === 'flat', `CPU/AI returns are always flat regardless of the human's held spin key, got ${g.ball.spin}`);

  // サーブ：スピン選択の対象外（既に調整済みのバランスを崩さないためフラット固定）
  spinInput.spin = 'slice';
  const gs = new R.Game({ input: spinInput, hooks: noHooks });
  gs.start();
  tossAndHit(gs);
  ok(gs.ball.spin === 'flat', `serves stay flat regardless of a held spin key, got ${gs.ball.spin}`);
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

// --- 風：ポイントごとに Game#wind が WIND.MAX_ACCEL の範囲内でランダムに決まり、hooks.wind に通知される ---
{
  const { WIND } = R.config;
  let notified;
  const hooksWithWind = { ...noHooks, wind: (v) => { notified = v; } };
  for (let i = 0; i < 20; i++) {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithWind });
    g.start();
    ok(g.wind >= -WIND.MAX_ACCEL && g.wind <= WIND.MAX_ACCEL,
      `Game#wind stays within +-WIND.MAX_ACCEL, got ${g.wind}`);
    ok(notified === g.wind, `hooks.wind() is called with the same value as Game#wind, got ${notified} vs ${g.wind}`);
  }
}

// --- 風：サーブの飛翔（トス〜1本目の着地）は常に無風。返球された瞬間から this.wind が乗る ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.wind = 0.6; // 強制的に非0の風にしておく
  tossAndHit(g); // フォールトなく1本目のサーブを打つ
  ok(g.ball.wind === 0, `the serve itself flies with zero wind regardless of Game#wind, got ${g.ball.wind}`);

  // レシーバーが返球すると、以降 ball.wind は Game#wind に切り替わる
  g.you.z = -HALF_L - 0.6;
  g.ball.x = 0; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('you');
  ok(g.ball.wind === g.wind, `after the return, ball.wind matches the point's wind, got ${g.ball.wind} vs ${g.wind}`);
}

// --- 風：ラリー中の通常の打球にも Game#wind がそのまま乗る ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.wind = -0.4;
  g.you.z = -HALF_L - 0.6;
  g.ball.x = 0; g.ball.y = 1; g.ball.z = -2; g.ball.bounces = 1; g.ball.vx = 0; g.ball.vz = 0;
  g.hit('you');
  ok(g.ball.wind === -0.4, `a groundstroke picks up the current point wind, got ${g.ball.wind}`);
}

console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
process.exit(fail ? 1 : 0);
