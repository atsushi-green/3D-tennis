/**
 * ゲームのルールと状態。three.js にも DOM にも触らない。
 * 外へ伝えたいこと（音・コール・スコア更新）は hooks 経由で呼び出す。
 */
(function (RallyOne) {
  'use strict';

  const {
    BOUNDS, CHARGE, COURT, CPU, DOUBLES, FX, HALF_L, HALF_W, PHYSICS, PLAYER, SERVE, SHOT, TIMING,
  } = RallyOne.config;
  const {
    approach, approach2D, clamp, lerp, rand, signOr,
  } = RallyOne.math;
  const { hitsNet, integrate, solveShot } = RallyOne.physics;
  const {
    chasePosition, homePosition, shotTarget, isResponder, coverPosition,
  } = RallyOne.ai;
  const { Match } = RallyOne.scoring;

  const { BALL_R, STEP } = PHYSICS;

  const opponent = (who) => (who === 'you' ? 'cpu' : 'you');

  /**
   * カメラはベースライン後方（-z）から +z を向いているので、world の +x は画面の左に映る。
   * 入力は画面基準（右キー = +1）なので、world の x へ渡すときに反転させる。
   */
  const INPUT_X_TO_WORLD = -1;

  function reaches(ball, player, reach) {
    return Math.hypot(ball.x - player.x, ball.z - player.z) < reach;
  }

  /**
   * 'you'/'youMate' は world +x 側、'cpu'/'cpuMate' は180°回転しているので
   * world -x 側がそれぞれのラケット側（モデルの構造上、腕は常にローカル+x側に作られる）。
   */
  const RACKET_SIDE = { you: 1, youMate: 1, cpu: -1, cpuMate: -1 };

  /** 個々の選手が、チームとしてはどちら側か（ダブルスの味方はチームメイトと同じチーム） */
  const TEAM_OF = { you: 'you', youMate: 'you', cpu: 'cpu', cpuMate: 'cpu' };

  /** 打点でのボールの位置が、ラケット側か逆側（体の反対側に手を伸ばす＝バックハンド）か */
  function classifyStroke(who, ball, player) {
    return RACKET_SIDE[who] * (ball.x - player.x) >= 0 ? 'forehand' : 'backhand';
  }

  /** phase: idle → serve → rally → over → (serve …) */
  class Game {
    /**
     * @param {object} deps
     * @param {object} deps.input RallyOne.Input
     * @param {{sound:Function, call:Function, clearCall:Function, score:Function}} deps.hooks
     */
    constructor({ input, hooks }) {
      this.input = input;
      this.hooks = hooks;
      this.match = new Match();

      this.ball = {
        x: 0, y: SERVE.BALL_Y, z: -HALF_L,
        px: 0, py: SERVE.BALL_Y, pz: -HALF_L, // 1ステップ前の位置
        vx: 0, vy: 0, vz: 0,
        bounces: 0, last: 'you', live: false,
        impact: 0,      // 打った瞬間の演出（着弾フラッシュ・膨張）の残り時間
        impactPower: 0, // その打球の溜め量(0〜1)。演出の派手さに使う
      };
      this.you = {
        x: 0, z: -HALF_L - 0.6, vx: 0, vz: 0, // vx/vz は実速度（加速度で目標速度に近づける）
        swing: 0, anim: 0, speed: 0, stroke: 'forehand',
        charging: false, chargeTime: 0, swingCharge: 0, // Space 押しっぱなしのテイクバック
      };
      this.cpu = { x: 0, z: CPU.HOME_Z, anim: 0, speed: 0, stroke: 'forehand' };
      // ダブルス（this.doubles === true）のときだけ動く AI パートナー。シングルスでは未使用のまま。
      this.youMate = { x: 0, z: DOUBLES.NET_Z_YOU, anim: 0, speed: 0, stroke: 'forehand' };
      this.cpuMate = { x: 0, z: DOUBLES.NET_Z_CPU, anim: 0, speed: 0, stroke: 'forehand' };

      this.phase = 'idle';
      this.server = 'you';
      this.started = false;
      /** true ならダブルス（you+youMate vs cpu+cpuMate）。既定はシングルス。 */
      this.doubles = false;
      /** true の間、ボールはトス中（重力で上下するだけ）。2回目の Space で打つまで待つ。 */
      this.tossActive = false;
      /** setTimeout ではなくゲームループで数える。ポイント間で確実に破棄できる。 */
      this.timers = [];
    }

    actor(who) {
      return this[who];
    }

    /* -------------------------------------------------------------- 入力 */

    /** @param {boolean} [doubles] true ならダブルス（you+youMate vs cpu+cpuMate）で開始 */
    start(doubles) {
      if (this.started) return;
      this.started = true;
      this.doubles = !!doubles;
      this.newPoint();
    }

    /**
     * Space / クリックを押した瞬間。
     * サーブの1回目（トス前）は即トス。それ以外（トス中の2回目、ラリー中）は
     * テイクバックを溜め始める。実際に打つのは chargeRelease()（離した瞬間）。
     */
    chargeStart() {
      if (this.phase === 'serve' && this.server === 'you' && !this.tossActive) {
        this.tossBall();
        return;
      }
      if (this.phase === 'serve' && this.server === 'you' && this.tossActive) {
        this.you.charging = true;
        this.you.chargeTime = 0;
      } else if (this.phase === 'rally') {
        this.you.charging = true;
        this.you.chargeTime = 0;
      }
    }

    /** Space / クリックを離した瞬間。溜めた量に応じた威力で打つ。 */
    chargeRelease() {
      if (!this.you.charging) return;
      this.you.charging = false;
      this.you.swingCharge = clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);

      if (this.phase === 'serve' && this.server === 'you' && this.tossActive) {
        this.serve('you');
      } else if (this.phase === 'rally') {
        this.you.swing = PLAYER.SWING_WINDOW;
      }
    }

    /**
     * 溜め時間を毎フレーム加算する。ラリー中・トス中以外の文脈になったら
     * （ポイントが終わった、トスが自動リセットされた等）溜めを打ち切ってキャンセルする。
     */
    tickCharge(dt) {
      if (!this.you.charging) return;
      const validContext = this.phase === 'rally'
        || (this.phase === 'serve' && this.server === 'you' && this.tossActive);
      if (!validContext) {
        this.you.charging = false;
        return;
      }
      this.you.chargeTime = Math.min(this.you.chargeTime + dt, CHARGE.MAX_TIME);
    }

    /* ------------------------------------------------------ ポイント進行 */

    newPoint() {
      this.clearTimers();
      this.phase = 'serve';
      this.tossActive = false;

      const ball = this.ball;
      ball.live = false;
      ball.bounces = 0;
      ball.vx = ball.vy = ball.vz = 0;

      this.you.charging = false;
      this.you.chargeTime = 0; // 前のポイントの溜めを持ち越さない

      const side = this.match.serveSide;
      if (this.server === 'you') {
        this.you.x = side * SERVE.STANCE_X;
        this.you.z = -HALF_L - 0.5;
        this.you.vx = this.you.vz = 0; // 前のポイントの勢いを持ち越さない
        this.hooks.call('サーブ', '←→ でコース選択 ／ Space でトス');
      } else {
        this.cpu.x = -side * SERVE.STANCE_X;
        this.cpu.z = HALF_L + 0.5;
        this.hooks.call('リターン', 'CPU のサーブ');
        this.after(TIMING.CPU_SERVE_DELAY, () => {
          if (this.phase === 'serve') this.serve('cpu');
        });
      }
      if (this.doubles) this.positionMates(side);
      this.placeServeBall();
    }

    /** ダブルスのパートナーを、サーブのサイドに合わせてネット際の構えに置く */
    positionMates(side) {
      this.youMate.x = side * DOUBLES.SLOT_X * 0.6;
      this.youMate.z = DOUBLES.NET_Z_YOU;
      this.cpuMate.x = -side * DOUBLES.SLOT_X * 0.6;
      this.cpuMate.z = DOUBLES.NET_Z_CPU;
    }

    /** サーブ待ちの間、ボールはサーバーの手元に置いておく */
    placeServeBall() {
      const server = this.actor(this.server);
      const front = this.server === 'you' ? 0.4 : -0.4;
      const ball = this.ball;
      ball.x = ball.px = server.x;
      ball.z = ball.pz = server.z + front;
      ball.y = ball.py = SERVE.BALL_Y;
    }

    /** 1回目の Space。ボールを真上にトスし、重力で自然に落ちてくるのに任せる。 */
    tossBall() {
      const ball = this.ball;
      ball.vx = 0;
      ball.vz = 0;
      ball.vy = Math.sqrt(2 * Math.abs(PHYSICS.GRAVITY) * (SERVE.TOSS_PEAK - SERVE.BALL_Y));
      this.tossActive = true;
      this.hooks.call('トス', 'Space で打つ！');
    }

    serve(who) {
      const ball = this.ball;
      const dir = who === 'you' ? 1 : -1;   // 打ち込む方向
      const side = this.match.serveSide;
      // プレイヤーはトス中の実際の高さで打つ。CPU はトス演出を挟まないので固定の打点高さを使う。
      const contactY = who === 'you' ? Math.max(ball.y, SERVE.BALL_Y) : SERVE.TOSS_Y;
      const from = { x: ball.x, y: contactY, z: ball.z };
      // サービスはコートの対角へ入れる。狙う横位置（コース）はプレイヤーのみ選べる
      const targetSign = who === 'you' ? -side : side;
      const magnitude = who === 'you'
        ? this.serveAimMagnitude(targetSign)
        : rand(SERVE.AIM_X_MIN, SERVE.AIM_X_MAX);
      const target = {
        x: targetSign * magnitude,
        y: BALL_R,
        z: dir * (COURT.SERVICE - rand(SERVE.DEPTH_MIN, SERVE.DEPTH_MAX)),
      };
      // プレイヤーは「打つ」瞬間の溜め量で威力が変わる。CPU は常に一定。
      const flightT = who === 'you' ? lerp(SERVE.T, SERVE.CHARGE_T, this.you.swingCharge) : SERVE.T;

      ball.y = from.y;
      Object.assign(ball, solveShot(from, target, flightT, SERVE.CLEARANCE));
      ball.live = true;
      ball.bounces = 0;
      ball.last = who;

      this.tossActive = false;
      this.phase = 'rally';
      const server = this.actor(who);
      server.anim = PLAYER.SERVE_ANIM;
      server.stroke = 'serve';
      const serveCharge = who === 'you' ? this.you.swingCharge : 0;
      ball.impact = FX.IMPACT_DURATION * lerp(1, FX.CHARGE_TIME_BOOST, serveCharge);
      ball.impactPower = serveCharge;
      this.hooks.sound('serve', serveCharge);
      this.hooks.clearCall();
    }

    /**
     * トス中に ←→ で狙うコースを選ぶ。狙い先（targetSign）と同じ向きに入力すればワイド、
     * 逆向きなら T、無入力ならボディへ。
     * @param {1|-1} targetSign このサーブが入るボックスの符号
     */
    serveAimMagnitude(targetSign) {
      const aim = this.input.moveX * INPUT_X_TO_WORLD;
      if (aim === 0) return rand(SERVE.AIM_BODY_MIN, SERVE.AIM_BODY_MAX);
      return aim === targetSign
        ? rand(SERVE.AIM_WIDE_MIN, SERVE.AIM_WIDE_MAX)
        : rand(SERVE.AIM_T_MIN, SERVE.AIM_T_MAX);
    }

    hit(who) {
      const ball = this.ball;
      const player = this.actor(who);
      const from = { x: ball.x, y: Math.max(ball.y, 0.5), z: ball.z };
      // AI（cpu/cpuMate は人間の逆をつきつつ you 陣地(z<0)へ、youMate はダブルスで唯一の
      // AI仲間なので相手チームの主力 cpu の逆をつきつつ cpu 陣地(z>0)へ）。
      // 人間の 'you' だけ playerShot() で自分の入力を使う。
      const shot = who === 'you'
        ? this.playerShot()
        : TEAM_OF[who] === 'cpu'
          ? { target: shotTarget(this.you.x, -1), flight: CPU.SHOT_T }
          : { target: shotTarget(this.cpu.x, 1), flight: CPU.SHOT_T };

      // ball.x/z はまだ打点のまま（solveShot が書き換えるのは vx/vy/vz だけ）なので、
      // ここで打点とプレイヤー位置からフォア/バックを判定できる。
      const stroke = classifyStroke(who, ball, player);

      // 人間の打球だけ溜め量に応じて演出を強める（AIは常に0＝通常の演出）
      const charge = who === 'you' ? this.you.swingCharge : 0;

      Object.assign(ball, solveShot(from, shot.target, shot.flight));
      ball.last = TEAM_OF[who]; // スコア判定はチーム単位。誰が打ったかは player.stroke 側で個別に持つ
      ball.bounces = 0;
      ball.impact = FX.IMPACT_DURATION * lerp(1, FX.CHARGE_TIME_BOOST, charge);
      ball.impactPower = charge; // フラッシュの大きさに使う

      player.anim = PLAYER.SWING_ANIM;
      player.stroke = stroke;
      this.hooks.sound('hit', TEAM_OF[who], stroke, charge); // 音程はチーム単位（誰が打っても同じ）
    }

    /**
     * ←→ で左右に打ち分け、Shift でロブ。威力は Space を離した瞬間の溜め量
     * （chargeRelease() が計算した this.you.swingCharge、0〜1）で決まる。
     * 無入力ならクロス気味に返す。
     */
    playerShot() {
      const lob = this.input.lob;
      const aim = this.input.moveX * INPUT_X_TO_WORLD;
      const charge = this.you.swingCharge;
      const flight = lob ? SHOT.LOB_T : lerp(SHOT.TAP_T, SHOT.CHARGE_T, charge);
      // 溜めるほど深く。速さと深さの両方が変わるので「強い球を打った」感が出る。
      const depth = lerp(SHOT.TAP_Z, SHOT.CHARGE_Z, charge);
      return {
        target: {
          x: aim !== 0 ? aim * SHOT.AIM_X : -signOr(this.you.x, 1) * SHOT.DEFAULT_X,
          y: BALL_R,
          z: lob ? SHOT.LOB_Z : rand(depth, depth + SHOT.DRIVE_Z_SPREAD),
        },
        flight,
      };
    }

    endPoint(winner, reason) {
      if (this.phase === 'over') return;
      this.phase = 'over';
      this.ball.live = false;
      this.hooks.sound('point', winner);

      const result = this.match.awardPoint(winner);
      const mine = winner === 'you';
      if (result.type !== 'point') this.server = opponent(this.server); // ゲームごとにサーブ交代

      if (result.type === 'set') {
        this.hooks.call('ゲームセット', mine ? 'あなたの勝ち' : 'CPU の勝ち');
        this.hooks.score();
        this.after(TIMING.NEXT_MATCH, () => {
          this.match.reset();
          this.hooks.score();
          this.newPoint();
        });
        return;
      }

      const sub = result.type === 'game' ? `ゲーム — ${mine ? 'YOU' : 'CPU'}` : reason;
      this.hooks.call(mine ? 'ポイント' : '失点', sub);
      this.hooks.score();
      this.after(TIMING.NEXT_POINT, () => this.newPoint());
    }

    /* -------------------------------------------------------- 毎フレーム */

    update(dt) {
      this.tickTimers(dt);

      this.you.swing = Math.max(0, this.you.swing - dt);
      this.you.anim = Math.max(0, this.you.anim - dt);
      this.cpu.anim = Math.max(0, this.cpu.anim - dt);
      if (this.doubles) {
        this.youMate.anim = Math.max(0, this.youMate.anim - dt);
        this.cpuMate.anim = Math.max(0, this.cpuMate.anim - dt);
      }
      this.ball.impact = Math.max(0, this.ball.impact - dt);

      this.movePlayers(dt);

      // 物理は固定ステップで刻む（フレームレート非依存）
      for (let remaining = dt; remaining > 0; remaining -= STEP) {
        this.stepBall(Math.min(remaining, STEP));
      }

      // トスの自動リセットなど、このフレームの stepBall() の結果を見てから
      // 溜めを継続してよいか判定する（先に判定すると1フレーム遅れてしまう）。
      this.tickCharge(dt);
    }

    /**
     * プレイヤーが動ける範囲。自分のサーブ中（トスから打つまで）だけ、
     * フットフォルトになる位置（ベースラインの内側／センターマークの反対側／サイドラインの外）
     * へは動けないよう狭める。
     */
    youBounds() {
      if (!(this.phase === 'serve' && this.server === 'you')) {
        return {
          xMin: -PLAYER.X_LIMIT, xMax: PLAYER.X_LIMIT,
          zMin: -HALF_L - PLAYER.Z_FAR_MARGIN, zMax: PLAYER.Z_NEAR,
        };
      }
      const side = this.match.serveSide; // 現在サーブすべき側（センターマークからの符号）
      return {
        xMin: side > 0 ? 0 : -HALF_W,
        xMax: side > 0 ? HALF_W : 0,
        zMin: -HALF_L - PLAYER.Z_FAR_MARGIN,
        zMax: -HALF_L, // ベースラインを踏み越えたら失格（フットフォルト）
      };
    }

    movePlayers(dt) {
      const youBefore = { x: this.you.x, z: this.you.z };
      const cpuBefore = { x: this.cpu.x, z: this.cpu.z };

      const mx = this.input.moveX * INPUT_X_TO_WORLD;
      const mz = this.input.moveZ;
      const len = Math.hypot(mx, mz) || 1; // 斜め移動が速くならないように正規化
      const bounds = this.youBounds();

      // 目標速度（入力なしなら0）へ、加速度で少しずつ近づける。
      // 急停止・瞬間方向転換にならないので、コート上で滑るような自然さが出る。
      const hasInput = mx !== 0 || mz !== 0;
      const desiredVx = hasInput ? (mx / len) * PLAYER.SPEED : 0;
      const desiredVz = hasInput ? (mz / len) * PLAYER.SPEED : 0;
      const rate = (hasInput ? PLAYER.ACCEL : PLAYER.DECEL) * dt;
      const v = approach2D(this.you.vx, this.you.vz, desiredVx, desiredVz, rate);
      this.you.vx = v.x;
      this.you.vz = v.z;

      this.you.x = clamp(this.you.x + this.you.vx * dt, bounds.xMin, bounds.xMax);
      this.you.z = clamp(this.you.z + this.you.vz * dt, bounds.zMin, bounds.zMax);
      // 歩行/走行アニメーションが参照する実速度。壁際でクランプされた分は含めない
      // （実際に動いていないのに走って見えるのを防ぐ）。
      this.you.speed = Math.hypot(this.you.x - youBefore.x, this.you.z - youBefore.z) / dt;

      if (this.doubles) this.moveDoublesTeams(dt);
      else this.moveSinglesCpu(cpuBefore, dt);
    }

    /** シングルスの CPU 移動（従来どおり）。ダブルスでは使わない。 */
    moveSinglesCpu(cpuBefore, dt) {
      const chasing = this.phase === 'rally' && this.ball.last === 'you';
      const target = chasing ? chasePosition(this.ball) : homePosition();
      this.moveTowards(this.cpu, cpuBefore, target, chasing ? PLAYER.CPU_CHASE : PLAYER.CPU_RECOVER, dt);
    }

    /**
     * ダブルスの4人の移動。各ペアは、落下点に近い方（＝ isResponder ）が返球に向かい、
     * もう一方は相方の反対サイドのネット際で構える（本格的なフォーメーション戦略ではない簡易版）。
     */
    moveDoublesTeams(dt) {
      const ball = this.ball;
      const cpuBefore = { x: this.cpu.x, z: this.cpu.z };
      const cpuMateBefore = { x: this.cpuMate.x, z: this.cpuMate.z };
      const youMateBefore = { x: this.youMate.x, z: this.youMate.z };

      // cpu チーム：you 側の打球が向かってくる番なら、cpu/cpuMate のうち近い方が追う
      const cpuTeamChasing = this.phase === 'rally' && ball.last === 'you';
      if (cpuTeamChasing && isResponder(this.cpu, this.cpuMate, ball)) {
        this.moveTowards(this.cpu, cpuBefore, chasePosition(ball), PLAYER.CPU_CHASE, dt);
        this.moveTowards(this.cpuMate, cpuMateBefore, coverPosition(this.cpu.x, DOUBLES.NET_Z_CPU), PLAYER.CPU_RECOVER, dt);
      } else if (cpuTeamChasing) {
        this.moveTowards(this.cpuMate, cpuMateBefore, chasePosition(ball), PLAYER.CPU_CHASE, dt);
        this.moveTowards(this.cpu, cpuBefore, coverPosition(this.cpuMate.x, DOUBLES.NET_Z_CPU), PLAYER.CPU_RECOVER, dt);
      } else {
        this.moveTowards(this.cpu, cpuBefore, homePosition(), PLAYER.CPU_RECOVER, dt);
        this.moveTowards(this.cpuMate, cpuMateBefore, coverPosition(0, DOUBLES.NET_Z_CPU), PLAYER.CPU_RECOVER, dt);
      }

      // youMate：人間（you）の打球が向かってくる番で、自分の方が you より近ければ追う
      const mateChasing = this.phase === 'rally' && ball.last === 'cpu'
        && isResponder(this.youMate, this.you, ball);
      const mateTarget = mateChasing ? chasePosition(ball) : coverPosition(this.you.x, DOUBLES.NET_Z_YOU);
      this.moveTowards(this.youMate, youMateBefore, mateTarget, mateChasing ? PLAYER.CPU_CHASE : PLAYER.CPU_RECOVER, dt);
    }

    /** cpu/cpuMate/youMate 共通の移動：目標位置へ一定速度で寄せ、実速度も記録する（歩行アニメ用）。 */
    moveTowards(actor, before, target, speed, dt) {
      const step = speed * dt;
      actor.x = approach(actor.x, target.x, step);
      actor.z = approach(actor.z, target.z, step);
      actor.speed = Math.hypot(actor.x - before.x, actor.z - before.z) / dt;
    }

    stepBall(dt) {
      const ball = this.ball;

      if (this.tossActive) {
        integrate(ball, dt); // 重力だけで自然に上下させる（ラリーの当たり判定は通さない）
        if (ball.y <= SERVE.BALL_Y) {
          // 打たずに落ちてきた。トスをやり直せるようにリセットする（フォルトにはしない）
          this.tossActive = false;
          this.placeServeBall();
          this.hooks.call('サーブ', '←→ でコース選択 ／ Space でトス');
        }
        return;
      }

      if (!ball.live) {
        if (this.phase === 'serve') this.placeServeBall();
        return;
      }

      integrate(ball, dt);

      if (hitsNet(ball)) {
        ball.vz *= -0.18;
        ball.vx *= 0.3;
        ball.vy *= 0.3;
        this.endPoint(opponent(ball.last), 'ネット');
        return;
      }

      if (ball.y <= BALL_R && ball.vy < 0 && this.bounce()) return;

      if (this.phase === 'rally') this.checkSwings();

      if (Math.abs(ball.z) > BOUNDS.Z || Math.abs(ball.x) > BOUNDS.X) {
        this.endPoint(opponent(ball.last), 'アウト');
      }
    }

    /** @returns {boolean} このバウンドでポイントが決まったか */
    bounce() {
      const ball = this.ball;
      ball.y = BALL_R;
      ball.vy = -ball.vy * PHYSICS.RESTITUTION;
      ball.vx *= PHYSICS.FRICTION;
      ball.vz *= PHYSICS.FRICTION;
      ball.bounces++;
      this.hooks.sound('bounce');

      if (ball.bounces === 1) {
        const ownSide = (ball.last === 'you' && ball.z < 0) || (ball.last === 'cpu' && ball.z > 0);
        // ダブルスはコート幅がダブルスサイドラインまで広がる（サービスボックスの幅は変えない）
        const rallyHalfWidth = this.doubles ? COURT.DW / 2 : HALF_W;
        const inCourt = Math.abs(ball.x) <= rallyHalfWidth + 0.03 && Math.abs(ball.z) <= HALF_L + 0.03;
        if (ownSide || !inCourt) {
          this.endPoint(opponent(ball.last), ownSide ? '相手コートに届かず' : 'アウト');
          return true;
        }
        return false;
      }

      // 2バウンド＝返せなかった
      this.endPoint(ball.last, 'ツーバウンド');
      return true;
    }

    checkSwings() {
      const ball = this.ball;

      // プレイヤーは Space を押した瞬間の前後だけ打てる。人間が優先（AIパートナーに横取りさせない）
      if (ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN && this.you.swing > 0) {
        if (reaches(ball, this.you, PLAYER.REACH) && ball.y < PLAYER.REACH_Y) {
          this.hit('you');
          this.you.swing = 0;
        }
      }

      // ダブルスの youMate：人間が届かなかった／振らなかった球を、CPUと同様に自動で拾う
      if (this.doubles && ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN) {
        const inRange = ball.y < PLAYER.CPU_REACH_Y && ball.y > PLAYER.CPU_REACH_Y_MIN;
        if (reaches(ball, this.youMate, PLAYER.CPU_REACH) && inRange) this.hit('youMate');
      }

      // CPU は届く範囲なら自動で振る
      if (ball.last !== 'cpu' && ball.z > PLAYER.NET_MARGIN) {
        const inRange = ball.y < PLAYER.CPU_REACH_Y && ball.y > PLAYER.CPU_REACH_Y_MIN;
        if (reaches(ball, this.cpu, PLAYER.CPU_REACH) && inRange) {
          this.hit('cpu');
        } else if (this.doubles && reaches(ball, this.cpuMate, PLAYER.CPU_REACH) && inRange) {
          this.hit('cpuMate');
        }
      }
    }

    /* ---------------------------------------------------------- タイマー */

    after(seconds, fn) {
      this.timers.push({ remaining: seconds, fn });
    }

    clearTimers() {
      this.timers.length = 0;
    }

    tickTimers(dt) {
      if (!this.timers.length) return;
      const due = [];
      this.timers = this.timers.filter((timer) => {
        timer.remaining -= dt;
        if (timer.remaining > 0) return true;
        due.push(timer.fn);
        return false;
      });
      due.forEach((fn) => fn());
    }
  }

  RallyOne.Game = Game;
})(window.RallyOne = window.RallyOne || {});
