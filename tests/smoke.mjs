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

const {
  HALF_W, HALF_L, COURT, PLAYER, SERVE, BOUNDS,
} = R.config;
const fakeInput = { moveX: 0, moveZ: 0, lob: false };
const noHooks = {
  sound() {}, call() {}, clearCall() {}, score() {}, wind() {}, serveSpeed() {}, matchEnd() {},
};

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
 * 溜めキーを押しっぱなしにしてサーブする、を模した実際のフロー。
 * 押下と同時にトス＋テイクバックの溜めが始まり、holdFrames ぶん待ってから離す＝打つ。
 * @param {'flat'|'top'|'slice'} [spin] 押したキーに対応するスピン。省略時はフラット。
 */
function tossAndHit(g, holdFrames = 0, spin = 'flat') {
  g.chargeStart(spin); // トスとチャージを同時に開始
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
  // 目一杯ずらすと、狙いがどこであれ「ずれる側のコートの端」へ届く
  ok(Math.abs(foreEarly + EDGE_X) < 1e-9,
    `a full pull lands at the pull-side edge, got ${foreEarly.toFixed(2)}`);
  ok(Math.abs(foreLate - EDGE_X) < 1e-9,
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
  const input3 = { moveX: -1, moveZ: 0, lob: false }; // 画面右 = world +x
  const gAim = new R.Game({ input: input3, hooks: noHooks });
  gAim.you.x = 0;
  ok(Math.abs(gAim.playerShot('forehand', neutral, true).target.x - R.config.SHOT.AIM_X) < 1e-9,
    'with neutral timing the ball goes exactly where the arrow key aims');
  ok(Math.abs(gAim.playerShot('forehand', late, true).target.x - EDGE_X) < 1e-9,
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
          const flowSide = stroke === 'forehand' ? 1 : -1; // 流しの向き（world x）
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
  ok(Math.abs(full.max - full.min) <= RISK_SPREAD * 2 + 1e-9 && full.max > HALF_W,
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
    ok(Math.abs(g.playerShot('forehand', NEUTRAL_WAIT_T - FLOW_BAND_T, true).target.x - EDGE_X) < 1e-9,
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
  // サーブのコース・深さは毎回ランダム（rand()）なので、そのままだと3本の狙いがばらばらに
  // なり、飛距離の差が溜めの差を上回って球速の比較が成立しない（実測：約10%の確率で
  // 「長すぎのほうが速い」結果になっていた）。3本とも同じ狙いになるよう乱数を固定する。
  const origRandom = Math.random;
  Math.random = () => 0.5;
  let tapSpeed;
  let sweetSpeed;
  let tooLongSpeed;
  try {
    tapSpeed = speedOf(landingFor(0)); // 即リリース＝早すぎ
    sweetSpeed = speedOf(landingFor(Math.round(CHARGE_SWEET_T * 60))); // ちょうど良いタイミング
    tooLongSpeed = speedOf(landingFor(Math.round((CHARGE_SWEET_T + CHARGE_WINDOW * 0.9) * 60))); // 長すぎ
  } finally {
    Math.random = origRandom;
  }

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
  ok(easyMiss.base > normalMiss.base && normalMiss.base > hardMiss.base,
    `miss rate falls monotonically easy>normal>hard: ${easyMiss.base} > ${normalMiss.base} > ${hardMiss.base}`);
  ok(easyMiss.stretch > normalMiss.stretch && normalMiss.stretch > hardMiss.stretch,
    `stretched-shot miss rate falls monotonically too: ${easyMiss.stretch} > ${normalMiss.stretch} > ${hardMiss.stretch}`);
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
  const hooksWithWind = { ...noHooks, wind: (v) => { notified = v; } };
  for (let i = 0; i < 20; i++) {
    const g = new R.Game({ input: fakeInput, hooks: hooksWithWind });
    g.start();
    ok(g.wind >= -WIND.MAX_ACCEL && g.wind <= WIND.MAX_ACCEL,
      `Game#wind stays within +-WIND.MAX_ACCEL, got ${g.wind}`);
    ok(notified === g.wind, `hooks.wind() is called with the same value as Game#wind, got ${notified} vs ${g.wind}`);
  }
}

// --- 風：無関係な値へ飛ばず、前のポイントから WIND.DRIFT_ACCEL の範囲だけ変わる（ドリフト） ---
{
  const { WIND } = R.config;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  for (let i = 0; i < 50; i++) {
    const before = g.wind;
    g.newPoint();
    const delta = Math.abs(g.wind - before);
    ok(delta <= WIND.DRIFT_ACCEL + 1e-9,
      `wind changes by at most WIND.DRIFT_ACCEL per point, got delta=${delta} (before=${before}, after=${g.wind})`);
    ok(g.wind >= -WIND.MAX_ACCEL && g.wind <= WIND.MAX_ACCEL, `drifted wind still stays within +-WIND.MAX_ACCEL, got ${g.wind}`);
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
  const from = { x: 0, y: SERVE.TOSS_Y, z: -HALF_L };
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
  } = PLAYER;

  ok(reactReach(0) === CPU_REFLEX_REACH, `no time at all leaves only the reflex reach, got ${reactReach(0)}`);
  ok(reactReach(CPU_REFLEX_T_MIN) === CPU_REFLEX_REACH, 'at T_MIN it is still the reflex reach');
  ok(reactReach(CPU_REFLEX_T_MAX) === CPU_REACH, 'at T_MAX the full reach is available again');
  ok(reactReach(5) === CPU_REACH, 'plenty of time is still just the full reach (no bonus)');
  ok(reactReach(undefined) === CPU_REFLEX_REACH, 'a ball with no age recorded is treated as the strictest case');
  const mid = reactReach((CPU_REFLEX_T_MIN + CPU_REFLEX_T_MAX) / 2);
  ok(mid > CPU_REFLEX_REACH && mid < CPU_REACH, `it ramps in between, got ${mid}`);

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
      g.chargeRelease();     // 打つ
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
  Object.assign(g.cpu, { x: 0, z: 0, chaseDist: 0 });
  g.moveTowards(g.cpu, { x: 0, z: 0 }, { x: 0.01, z: 0 }, speed, dt);
  ok(g.cpu.x === 0.01 && g.cpu.z === 0, `stops exactly on the target, got (${g.cpu.x}, ${g.cpu.z})`);
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

// --- CPU/AI の追跡目標は必ずボールの弾道の上に乗る（深さを手前に寄せたら横位置も取り直す） ---
{
  const CPU = R.config.CPU;
  const { solveShot, predictApex, predictAtZ, integrate, reflectBounce } = R.physics;
  const { BALL_R, STEP } = R.config.PHYSICS;
  // フル溜めのフラットサーブ相当。バウンド後も水平40m/s近くで飛ぶので、打点（頂点）は
  // ベースラインの遥か後方＝CPUがどう頑張っても立てない場所になる。
  const from = { x: -SERVE.STANCE_X, y: SERVE.TOSS_Y, z: -HALF_L };
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
  const any = sample(0);
  ok(deep.max <= SERVE.DEPTH_DEEP_MAX, `↑ keeps the serve deep, got max ${deep.max}`);
  ok(shallow.min >= SERVE.DEPTH_SHORT_MIN, `↓ keeps the serve short, got min ${shallow.min}`);
  ok(deep.max < shallow.min, 'the deep and short bands do not overlap');
  ok(any.min < deep.max && any.max > shallow.min, 'no input uses the whole depth range');
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
  const shoot = (spin, charge, fromZ) => {
    const origRandom = Math.random;
    Math.random = () => 0.5;
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
  };
  for (let i = 0; i < 3; i++) winPoint(false);
  winPoint(true); // この1本でゲーム＝セットが決まる
  ok(g.match.games.you === 6, `precondition: the set is won, games=${g.match.games.you}`);
  ok(ends.length === 0, 'the summary does not appear before TIMING.MATCH_STATS has passed');
  // TIMING.MATCH_STATS ぶん進めると出る（リプレイ中は main.js が update() を止めるので、
  // 実際の画面では再生が終わってから数え始める）
  for (let i = 0; i < 60 * 2 && ends.length === 0; i++) g.update(1 / 60);
  ok(ends.length === 1, `matchEnd fires once when the set ends: ${ends.length}`);
  ok(ends[0].winner === 'you' && ends[0].games.you === 6, 'the summary has the final score');
  ok(ends[0].you.winners === 4, `and the accumulated stats: ${ends[0].you.winners}`);
  // 次のマッチが始まるとき（TIMING.NEXT_MATCH）にスタッツは0へ戻る
  for (let i = 0; i < 60 * 4 && g.stats.you.winners > 0; i++) g.update(1 / 60);
  ok(g.stats.you.winners === 0 && g.match.games.you === 0, 'the next match starts from zero');
  ok(ends.length === 1, 'and the summary is not shown twice');
}

// --- 試合後のスタッツ：1stサーブの本数と確率、最速サーブ（実際にサーブを打って数える） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  // 1本目を打って、フォールトせずに入るまで進める
  tap(g);
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
  ok(g2.stats.you.firstServes === 0, 'a second serve is not counted as a first serve');
}

console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
process.exit(fail ? 1 : 0);
