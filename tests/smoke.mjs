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

const { HALF_W, HALF_L, COURT, PLAYER, SERVE } = R.config;
const fakeInput = { moveX: 0, moveZ: 0, lob: false };
const noHooks = { sound() {}, call() {}, clearCall() {}, score() {} };

/** 旧 g.swing() 相当：即座に離す（溜め時間0）タップ。1回の Space 押下を表す。 */
function tap(g) {
  g.chargeStart();
  g.chargeRelease();
}

/** 1回目 Space でトス、しばらく待って2回目 Space で打つ、を模した実際のフロー */
function tossAndHit(g) {
  tap(g);
  for (let f = 0; f < 12; f++) g.update(1 / 60);
  tap(g);
}

// --- serve lands in the service box（実際の「トス→打つ」の2段階を通す） ---
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

// --- サーブは2段階（1回目 Space でトス、2回目で打つ） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  ok(!g.tossActive && !g.ball.live, 'precondition: not tossed yet');

  tap(g);
  ok(g.tossActive === true, '1st Space starts the toss');
  ok(g.ball.live === false, 'ball is not live during the toss (no rally physics)');
  ok(g.ball.vy > 0, 'toss ball moves upward');
  ok(g.phase === 'serve', 'still in serve phase during the toss');

  tap(g);
  ok(g.tossActive === false, '2nd Space ends the toss');
  ok(g.ball.live === true, 'ball becomes live after the hit');
  ok(g.phase === 'rally', 'phase moves to rally after the hit');
}

// --- トスを打たずに待つと自動でリセットされる（フォルト扱いにはしない） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  tap(g);
  ok(g.tossActive === true, 'tossed');
  for (let i = 0; i < 180 && g.tossActive; i++) g.update(1 / 60); // 3秒＝落ちてくるまで十分待つ
  ok(g.tossActive === false, 'toss auto-resets after falling without a hit');
  ok(g.ball.live === false, 'ball is not live after an unfulfilled toss');
  ok(g.phase === 'serve', 'still serve phase, can retry');
  ok(Math.abs(g.ball.y - SERVE.BALL_Y) < 0.01, `ball returns to hand height, y=${g.ball.y}`);
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
  tap(g); // トス
  tap(g); // 打つ（サーブ）
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
    gg.hit('you');
    if (R.physics.predictLanding(gg.ball).z > HALF_L) out++;
  }
  ok(out === 0, `normal-timing shots should still land in: ${out}/100 went long`);
}

// --- Space を溜めるほど強いサーブになる ---
{
  const { T, CHARGE_T } = R.config.SERVE;
  const tapLanding = () => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    tap(g); // トス
    tap(g); // 即リリースで打つ（溜め0）
    return g.ball;
  };
  const chargedLanding = () => {
    const g = new R.Game({ input: fakeInput, hooks: noHooks });
    g.start();
    tap(g); // トス
    g.chargeStart();
    // MAX_TIME ぶんだけ溜める（トスの滞空時間 ~0.77s より短いので、トスを逃さず打てる）
    const frames = Math.round(R.config.CHARGE.MAX_TIME * 60);
    for (let i = 0; i < frames; i++) g.update(1 / 60);
    g.chargeRelease();
    return g.ball;
  };
  const tapBall = tapLanding();
  const chargedBall = chargedLanding();
  const tapSpeed = Math.hypot(tapBall.vx, tapBall.vy, tapBall.vz);
  const chargedSpeed = Math.hypot(chargedBall.vx, chargedBall.vy, chargedBall.vz);
  ok(chargedSpeed > tapSpeed,
    `charged serve is faster than a tap serve: charged=${chargedSpeed.toFixed(2)} tap=${tapSpeed.toFixed(2)}`);
  ok(T > CHARGE_T, `precondition: SERVE.CHARGE_T should be shorter (faster) than SERVE.T`);
}

// --- 溜め中にポイントが切り替わる/トスが流れると、溜めはキャンセルされる ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  tap(g); // トス
  g.chargeStart();
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

// --- フォアハンド/バックハンドの判定（打点がラケット側か逆側か） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  g.you.x = 0;
  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2; // 'you' の world +x 側 = ラケット側
  g.hit('you');
  ok(g.you.stroke === 'forehand', `ball on racket side -> forehand, got ${g.you.stroke}`);

  g.ball.x = -1.5; g.ball.y = 1; g.ball.z = -2; // world -x 側 = 逆側
  g.hit('you');
  ok(g.you.stroke === 'backhand', `ball on off side -> backhand, got ${g.you.stroke}`);

  // cpu は180°回転しているので判定が反転する（world -x 側がラケット側）
  g.cpu.x = 0;
  g.ball.x = -1.5; g.ball.y = 1; g.ball.z = 2;
  g.hit('cpu');
  ok(g.cpu.stroke === 'forehand', `cpu: ball on its racket side -> forehand, got ${g.cpu.stroke}`);

  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = 2;
  g.hit('cpu');
  ok(g.cpu.stroke === 'backhand', `cpu: ball on its off side -> backhand, got ${g.cpu.stroke}`);
}

// --- サーブは stroke='serve'（横振りではなく専用の縦振りポーズを使う） ---
{
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  tossAndHit(g);
  ok(g.you.stroke === 'serve', `serve sets stroke='serve', got ${g.you.stroke}`);
}

// --- 打点でインパクト演出（ball.impact）が発火し、時間とともに減衰する ---
{
  const { FX } = R.config;
  const g = new R.Game({ input: fakeInput, hooks: noHooks });
  g.start();
  ok(g.ball.impact === 0, 'no impact before anything happens');

  tossAndHit(g);
  ok(g.ball.impact > 0 && g.ball.impact <= FX.IMPACT_DURATION, `serve sets ball.impact, got ${g.ball.impact}`);
  for (let i = 0; i < 60; i++) g.update(1 / 60); // 1秒待てば必ず減衰しきる
  ok(g.ball.impact === 0, `ball.impact decays back to 0, got ${g.ball.impact}`);

  g.ball.x = 1.5; g.ball.y = 1; g.ball.z = -2;
  g.hit('you');
  ok(g.ball.impact > 0, `rally hit also sets ball.impact, got ${g.ball.impact}`);
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

console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`);
process.exit(fail ? 1 : 0);
