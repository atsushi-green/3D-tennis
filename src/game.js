/**
 * ゲームのルールと状態。three.js にも DOM にも触らない。
 * 外へ伝えたいこと（音・コール・スコア更新）は hooks 経由で呼び出す。
 */
(function (RallyOne) {
  'use strict';

  const {
    BOUNDS, COURT, CPU, HALF_L, HALF_W, PHYSICS, PLAYER, SERVE, SHOT, TIMING,
  } = RallyOne.config;
  const { approach, clamp, rand, signOr } = RallyOne.math;
  const { hitsNet, integrate, solveShot } = RallyOne.physics;
  const { chasePosition, homePosition, shotTarget } = RallyOne.ai;
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
      };
      this.you = { x: 0, z: -HALF_L - 0.6, swing: 0, anim: 0 };
      this.cpu = { x: 0, z: CPU.HOME_Z, anim: 0 };

      this.phase = 'idle';
      this.server = 'you';
      this.started = false;
      /** setTimeout ではなくゲームループで数える。ポイント間で確実に破棄できる。 */
      this.timers = [];
    }

    actor(who) {
      return who === 'you' ? this.you : this.cpu;
    }

    /* -------------------------------------------------------------- 入力 */

    start() {
      if (this.started) return;
      this.started = true;
      this.newPoint();
    }

    /** Space / クリック：サーブ、またはスイング */
    swing() {
      if (this.phase === 'serve' && this.server === 'you') this.serve('you');
      else if (this.phase === 'rally') this.you.swing = PLAYER.SWING_WINDOW;
    }

    /* ------------------------------------------------------ ポイント進行 */

    newPoint() {
      this.clearTimers();
      this.phase = 'serve';

      const ball = this.ball;
      ball.live = false;
      ball.bounces = 0;
      ball.vx = ball.vy = ball.vz = 0;

      const side = this.match.serveSide;
      if (this.server === 'you') {
        this.you.x = side * SERVE.STANCE_X;
        this.you.z = -HALF_L - 0.5;
        this.hooks.call('サーブ', '←→ でコース選択 ／ Space でトス＆サーブ');
      } else {
        this.cpu.x = -side * SERVE.STANCE_X;
        this.cpu.z = HALF_L + 0.5;
        this.hooks.call('リターン', 'CPU のサーブ');
        this.after(TIMING.CPU_SERVE_DELAY, () => {
          if (this.phase === 'serve') this.serve('cpu');
        });
      }
      this.placeServeBall();
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

    serve(who) {
      const ball = this.ball;
      const dir = who === 'you' ? 1 : -1;   // 打ち込む方向
      const side = this.match.serveSide;
      const from = { x: ball.x, y: SERVE.TOSS_Y, z: ball.z };
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

      ball.y = from.y;
      Object.assign(ball, solveShot(from, target, SERVE.T, SERVE.CLEARANCE));
      ball.live = true;
      ball.bounces = 0;
      ball.last = who;

      this.phase = 'rally';
      this.actor(who).anim = PLAYER.SERVE_ANIM;
      this.hooks.sound('serve');
      this.hooks.clearCall();
    }

    hit(who) {
      const ball = this.ball;
      const from = { x: ball.x, y: Math.max(ball.y, 0.5), z: ball.z };
      const shot = who === 'you'
        ? this.playerShot()
        : { target: shotTarget(this.you.x), flight: CPU.SHOT_T };

      Object.assign(ball, solveShot(from, shot.target, shot.flight));
      ball.last = who;
      ball.bounces = 0;

      this.actor(who).anim = PLAYER.SWING_ANIM;
      this.hooks.sound('hit', who);
    }

    /** ←→ で左右に打ち分け、Shift でロブ。無入力ならクロス気味に返す。 */
    playerShot() {
      const lob = this.input.lob;
      const aim = this.input.moveX * INPUT_X_TO_WORLD;
      return {
        target: {
          x: aim !== 0 ? aim * SHOT.AIM_X : -signOr(this.you.x, 1) * SHOT.DEFAULT_X,
          y: BALL_R,
          z: lob ? SHOT.LOB_Z : rand(SHOT.DRIVE_Z, SHOT.DRIVE_Z + SHOT.DRIVE_Z_SPREAD),
        },
        flight: lob ? SHOT.LOB_T : SHOT.DRIVE_T,
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

      this.movePlayers(dt);

      // 物理は固定ステップで刻む（フレームレート非依存）
      for (let remaining = dt; remaining > 0; remaining -= STEP) {
        this.stepBall(Math.min(remaining, STEP));
      }
    }

    movePlayers(dt) {
      const mx = this.input.moveX * INPUT_X_TO_WORLD;
      const mz = this.input.moveZ;
      const len = Math.hypot(mx, mz) || 1; // 斜め移動が速くならないように正規化
      this.you.x = clamp(
        this.you.x + (mx / len) * PLAYER.SPEED * dt,
        -PLAYER.X_LIMIT,
        PLAYER.X_LIMIT,
      );
      this.you.z = clamp(
        this.you.z + (mz / len) * PLAYER.SPEED * dt,
        -HALF_L - PLAYER.Z_FAR_MARGIN,
        PLAYER.Z_NEAR,
      );

      // CPU は自分が返す番なら落下点へ、そうでなければ定位置へ戻る
      const chasing = this.phase === 'rally' && this.ball.last === 'you';
      const target = chasing ? chasePosition(this.ball) : homePosition();
      const step = (chasing ? PLAYER.CPU_CHASE : PLAYER.CPU_RECOVER) * dt;
      this.cpu.x = approach(this.cpu.x, target.x, step);
      this.cpu.z = approach(this.cpu.z, target.z, step);
    }

    stepBall(dt) {
      const ball = this.ball;
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
        const inCourt = Math.abs(ball.x) <= HALF_W + 0.03 && Math.abs(ball.z) <= HALF_L + 0.03;
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

      // プレイヤーは Space を押した瞬間の前後だけ打てる
      if (ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN && this.you.swing > 0) {
        if (reaches(ball, this.you, PLAYER.REACH) && ball.y < PLAYER.REACH_Y) {
          this.hit('you');
          this.you.swing = 0;
        }
      }

      // CPU は届く範囲なら自動で振る
      if (ball.last !== 'cpu' && ball.z > PLAYER.NET_MARGIN) {
        const inRange = ball.y < PLAYER.CPU_REACH_Y && ball.y > PLAYER.CPU_REACH_Y_MIN;
        if (reaches(ball, this.cpu, PLAYER.CPU_REACH) && inRange) this.hit('cpu');
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
