/**
 * ゲームのルールと状態。three.js にも DOM にも触らない。
 * 外へ伝えたいこと（音・コール・スコア更新）は hooks 経由で呼び出す。
 */
(function (RallyOne) {
  'use strict';

  const {
    BOUNDS, CHARGE, COURT, CPU, DOUBLES, FX, HALF_L, HALF_W, PHYSICS, PLAYER, RETURN, SERVE, SHOT,
    TIMING, TIMING_AIM,
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
        swing: 0, anim: 0, speed: 0, stroke: 'forehand', prep: null,
        charging: false, chargeTime: 0, swingCharge: 0, // Space 押しっぱなしのテイクバック
        chargeFrac: 0, // 溜めている間だけ 0〜1 で増える、テイクバックの深さ用（chargeTime のポーズ表示版）
        chargeStroke: null, // chargeStart() の瞬間に固定するフォア/バック。溜めている間は変えない
      };
      this.cpu = {
        x: 0, z: CPU.HOME_Z, anim: 0, speed: 0, stroke: 'forehand', prep: null,
      };
      // ダブルス（this.doubles === true）のときだけ動く AI パートナー。シングルスでは未使用のまま。
      this.youMate = {
        x: 0, z: DOUBLES.NET_Z_YOU, anim: 0, speed: 0, stroke: 'forehand', prep: null,
      };
      this.cpuMate = {
        x: 0, z: DOUBLES.NET_Z_CPU, anim: 0, speed: 0, stroke: 'forehand', prep: null,
      };

      this.phase = 'idle';
      /** 現在サーブする「チーム」。'you' | 'cpu'。個人は servingPlayer() で解決する。 */
      this.server = 'you';
      /**
       * ダブルスで、各チームの2人のうちどちらが現在の担当サーバーか。
       * 1ゲームごとに、そのチームの番が来るたびに交代する（実際のダブルスのルール）。
       * シングルスでは参照されない。
       */
      this.serverPartner = { you: 'you', cpu: 'cpu' };
      this.started = false;
      /** true ならダブルス（you+youMate vs cpu+cpuMate）。既定はシングルス。 */
      this.doubles = false;
      /** ダブルスの AI パートナー(youMate)に指示する定位置。'net'（前へ）か 'back'（下がれ）。 */
      this.youMateFormation = 'net';
      /** true の間、ボールはトス中（重力で上下するだけ）。2回目の Space で打つまで待つ。 */
      this.tossActive = false;
      /** true の間はサーブがまだ一度も返球されていない＝ノーバウンドで打ち返してはいけない。 */
      this.serveInFlight = false;
      /** setTimeout ではなくゲームループで数える。ポイント間で確実に破棄できる。 */
      this.timers = [];
      /**
       * CPU 側の反応遅延タイマー（cpu/cpuMate/youMate）。新しい球が飛んできた瞬間に
       * PLAYER.CPU_REACT にセットし、0になるまで移動を止める（＝逆を突かれると間に合わない）。
       */
      this.reactTimers = { cpu: 0, cpuMate: 0, youMate: 0 };
      /** 直前フレームの ball.last。変化を検知して反応遅延タイマーを起動するために使う。 */
      this.lastBallOwnerSeen = null;
    }

    actor(who) {
      return this[who];
    }

    /** 現在サーブする個人。シングルスではチームと同じ、ダブルスでは serverPartner を見る。 */
    servingPlayer() {
      return this.doubles ? this.serverPartner[this.server] : this.server;
    }

    /**
     * 現在レシーブする個人。実際のダブルスと同様、各選手が受けるコート（デュース/アド）は
     * セットを通して固定：主力(you/cpu)は side===1 側、相方は side===-1 側で必ず受ける。
     * @param {'you'|'cpu'} team レシーブする側のチーム
     * @param {1|-1} side 現在のサービスサイド（match.serveSide）
     */
    receivingPlayer(team, side) {
      if (!this.doubles) return team;
      const mate = team === 'you' ? 'youMate' : 'cpuMate';
      return side === 1 ? team : mate;
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
     * ダブルスのAIパートナー(youMate)に定位置を指示する。'net'＝前へ詰める、'back'＝
     * ベースライン付近まで下がる。ラリー中に構えていない側（isResponder でない側）の
     * 定位置と、次のポイント開始時の立ち位置（positionDoublesMates）の両方に反映される。
     * @param {'net'|'back'} formation
     */
    setYouMateFormation(formation) {
      if (!this.doubles || this.youMateFormation === formation) return;
      this.youMateFormation = formation;
      this.hooks.call('パートナー', formation === 'net' ? '前へ' : '下がれ');
      this.after(0.8, () => this.hooks.clearCall());
    }

    /**
     * Space / クリックを押した瞬間。
     * サーブの1回目（トス前）は即トス。それ以外（トス中の2回目、ラリー中）は
     * テイクバックを溜め始める。実際に打つのは chargeRelease()（離した瞬間）。
     */
    chargeStart() {
      // 自分がサーブする番（＝ダブルスで味方が回ってきているときは対象外）のときだけ反応する
      const myServe = this.phase === 'serve' && this.servingPlayer() === 'you';
      if (myServe && !this.tossActive) {
        this.tossBall();
        return;
      }
      if (myServe && this.tossActive) {
        this.you.charging = true;
        this.you.chargeTime = 0;
      } else if (this.phase === 'rally') {
        this.you.charging = true;
        this.you.chargeTime = 0;
        // フォア/バックはテイクバックを始めた瞬間（＝今)のボールとの位置関係で決め、
        // 溜めている間ボールや自分が動いても変えない。毎フレーム判定し直すと、溜めている
        // 最中に左右が入れ替わってテイクバックの向きが急に反転して見えることがあった。
        this.you.chargeStroke = classifyStroke('you', this.ball, this.you);
      }
    }

    /** Space / クリックを離した瞬間。溜めた量に応じた威力で打つ。 */
    chargeRelease() {
      if (!this.you.charging) return;
      this.you.charging = false;
      this.you.swingCharge = clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);

      const myServe = this.phase === 'serve' && this.servingPlayer() === 'you';
      if (myServe && this.tossActive) {
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
      const myServe = this.phase === 'serve' && this.servingPlayer() === 'you';
      const validContext = this.phase === 'rally' || (myServe && this.tossActive);
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
      this.serveInFlight = false;

      const ball = this.ball;
      ball.live = false;
      ball.bounces = 0;
      ball.vx = ball.vy = ball.vz = 0;

      this.you.charging = false;
      this.you.chargeTime = 0; // 前のポイントの溜めを持ち越さない
      this.you.chargeStroke = null;

      // 前のポイントの反応遅延を持ち越さない（moveDoublesTeams()/moveSinglesCpu() は
      // phase==='serve' 中は動かないので実害はないが、次のラリー開始時に混乱しないよう明示的に戻す）
      this.reactTimers.cpu = 0;
      this.reactTimers.cpuMate = 0;
      this.reactTimers.youMate = 0;
      this.lastBallOwnerSeen = null;

      const side = this.match.serveSide; // クロス(-1)から始まり、ポイントごとに逆クロス(+1)と交互になる
      const serverTeam = this.server;
      const receiverTeam = opponent(serverTeam);
      const server = this.servingPlayer();
      const receiver = this.receivingPlayer(receiverTeam, side);

      // サーバーをサービススタンスに置く（既存のサーブ位置ロジックと同じ式をチーム単位に一般化）
      const serverActor = this.actor(server);
      serverActor.x = (serverTeam === 'you' ? side : -side) * SERVE.STANCE_X;
      serverActor.z = serverTeam === 'you' ? -HALF_L - 0.5 : HALF_L + 0.5;
      if (server === 'you') this.you.vx = this.you.vz = 0; // 前のポイントの勢いを持ち越さない

      // レシーバーを、サーブが飛んでくる対角のボックス付近に置く（構える位置が見えるように）
      const receiverActor = this.actor(receiver);
      const targetSign = serverTeam === 'you' ? -side : side; // serve() の狙いと同じ式
      receiverActor.x = targetSign * RETURN.STANCE_X;
      receiverActor.z = receiverTeam === 'you' ? -HALF_L - RETURN.BACK : HALF_L + RETURN.BACK;
      if (receiver === 'you') this.you.vx = this.you.vz = 0;

      if (this.doubles) {
        this.positionDoublesMates(server, serverActor, serverTeam, receiver, receiverActor, receiverTeam);
      }

      if (server === 'you') {
        this.hooks.call('サーブ', '←→ でコース選択 ／ Space でトス');
      } else if (server === 'youMate') {
        // 人間のチームだが、今回は相方の番。人間は何もしなくてよい
        this.hooks.call('パートナーのサーブ', '');
        this.after(TIMING.CPU_SERVE_DELAY, () => {
          if (this.phase === 'serve') this.serve('youMate');
        });
      } else {
        this.hooks.call('リターン', 'CPU のサーブ');
        this.after(TIMING.CPU_SERVE_DELAY, () => {
          if (this.phase === 'serve') this.serve(server);
        });
      }
      this.placeServeBall();
    }

    /**
     * ダブルスで、サーバー・レシーバー以外の2人（それぞれの相方）をネット際の構えに置く。
     * 相方の反対サイドへ寄る（本格的なフォーメーション戦略ではない簡易版、ai.coverPosition と同じ考え方）。
     */
    positionDoublesMates(server, serverActor, serverTeam, receiver, receiverActor, receiverTeam) {
      const mateOf = (individual) => (TEAM_OF[individual] === 'you'
        ? (individual === 'you' ? 'youMate' : 'you')
        : (individual === 'cpu' ? 'cpuMate' : 'cpu'));
      // you 側だけ、指示されたフォーメーション（前へ／下がれ）を定位置に反映する
      const netZ = (team) => (team === 'you'
        ? (this.youMateFormation === 'back' ? DOUBLES.BACK_Z_YOU : DOUBLES.NET_Z_YOU)
        : DOUBLES.NET_Z_CPU);

      const serverMateActor = this.actor(mateOf(server));
      serverMateActor.x = clamp(-serverActor.x * DOUBLES.MIRROR, -DOUBLES.SLOT_X, DOUBLES.SLOT_X);
      serverMateActor.z = netZ(serverTeam);

      const receiverMateActor = this.actor(mateOf(receiver));
      receiverMateActor.x = clamp(-receiverActor.x * DOUBLES.MIRROR, -DOUBLES.SLOT_X, DOUBLES.SLOT_X);
      receiverMateActor.z = netZ(receiverTeam);
    }

    /** サーブ待ちの間、ボールはサーバーの手元に置いておく */
    placeServeBall() {
      const serverKey = this.servingPlayer();
      const server = this.actor(serverKey);
      const front = TEAM_OF[serverKey] === 'you' ? 0.4 : -0.4;
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
      const team = TEAM_OF[who];
      const dir = team === 'you' ? 1 : -1;   // 打ち込む方向
      const side = this.match.serveSide;
      // プレイヤーはトス中の実際の高さで打つ。CPU はトス演出を挟まないので固定の打点高さを使う。
      const contactY = who === 'you' ? Math.max(ball.y, SERVE.BALL_Y) : SERVE.TOSS_Y;
      const from = { x: ball.x, y: contactY, z: ball.z };
      // サービスはコートの対角へ入れる。狙う横位置（コース）はプレイヤーのみ選べる
      const targetSign = team === 'you' ? -side : side;
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
      ball.last = team; // スコア判定・当たり判定はチーム単位（hit() と同じ扱い）

      this.tossActive = false;
      this.serveInFlight = true; // 一度も返球されていない＝ノーバウンドで打ち返してはいけない
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
      this.serveInFlight = false; // 一度でも打ち返されたら「ノーバウンド禁止」の制約は解除

      // ball.x/z はまだ打点のまま（solveShot が書き換えるのは vx/vy/vz だけ）なので、
      // ここで打点とプレイヤー位置からフォア/バックを判定できる。shot の計算より前に
      // 必要（playerShot() がタイミングのずれを出すのに使う）。
      // 人間はテイクバックを始めた瞬間に chargeStart() が固定した向きをそのまま使う。
      // ここで改めて判定すると、溜めている間にボールと自分の位置関係が変わった場合、
      // テイクバックで見せていた向きと実際に振る向きがずれてしまう。
      const stroke = (who === 'you' && this.you.chargeStroke) || classifyStroke(who, ball, player);

      // AI（cpu/cpuMate は人間の逆をつきつつ you 陣地(z<0)へ、youMate はダブルスで唯一の
      // AI仲間なので相手チームの主力 cpu の逆をつきつつ cpu 陣地(z>0)へ）。
      // 人間の 'you' だけ playerShot() で自分の入力を使う。
      // AI は「打点での実速度 / CPU_CHASE」を stretch(0〜1) として使う：全力疾走のまま
      // ぎりぎり追いついた球ほど、山なりで浅く・中央寄りの弱気な返球になる。
      const stretch = who === 'you' ? 0 : clamp(player.speed / PLAYER.CPU_CHASE, 0, 1);
      const shot = who === 'you'
        ? this.playerShot(stroke, ball.z - player.z)
        : TEAM_OF[who] === 'cpu'
          ? { target: shotTarget(this.you.x, -1, stretch), flight: lerp(CPU.SHOT_T, CPU.STRETCH_T, stretch) }
          : { target: shotTarget(this.cpu.x, 1, stretch), flight: lerp(CPU.SHOT_T, CPU.STRETCH_T, stretch) };

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
     *
     * 打点のタイミングでもコースがずれる：ボールを前（遠く）で捉えるほど「引っ張り」、
     * 引きつけて近くで打つほど「流れる」。フォアとバックでは体を横切る向きが逆なので、
     * 引っ張る方向も逆になる（pullDir で吸収する）。ロブは対象外。
     * @param {'forehand'|'backhand'} [stroke]
     * @param {number} [contactDz] 打点の z - プレイヤーの z（前にあるほど大きい）
     */
    playerShot(stroke = 'forehand', contactDz = TIMING_AIM.NEUTRAL_DZ) {
      const lob = this.input.lob;
      const aim = this.input.moveX * INPUT_X_TO_WORLD;
      const charge = this.you.swingCharge;
      const flight = lob ? SHOT.LOB_T : lerp(SHOT.TAP_T, SHOT.CHARGE_T, charge);
      // 溜めるほど深く。速さと深さの両方が変わるので「強い球を打った」感が出る。
      const depth = lerp(SHOT.TAP_Z, SHOT.CHARGE_Z, charge);

      const baseX = aim !== 0 ? aim * SHOT.AIM_X : -signOr(this.you.x, 1) * SHOT.DEFAULT_X;
      let x = baseX;
      if (!lob) {
        const timing = clamp((contactDz - TIMING_AIM.NEUTRAL_DZ) / TIMING_AIM.HALF_BAND, -1, 1);
        const pullDir = (stroke === 'forehand' ? -1 : 1) * RACKET_SIDE.you;
        const shiftLimit = HALF_W + TIMING_AIM.OUT_MARGIN;
        x = clamp(baseX + timing * pullDir * TIMING_AIM.MAX_SHIFT, -shiftLimit, shiftLimit);
      }

      return {
        target: {
          x,
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
      if (result.type !== 'point') {
        // ダブルスは、今サーブし終えたチームの中で次に回ってくるまで担当者を交代する
        // （実際のルール通り。次にそのチームの番が来るのは2ゲーム後）
        if (this.doubles) {
          const finishedTeam = this.server;
          const mate = finishedTeam === 'you' ? 'youMate' : 'cpuMate';
          this.serverPartner[finishedTeam] = this.serverPartner[finishedTeam] === finishedTeam
            ? mate
            : finishedTeam;
        }
        this.server = opponent(this.server); // ゲームごとにサーブ交代
      }

      if (result.type === 'set') {
        this.hooks.call('ゲームセット', mine ? 'あなたの勝ち' : 'CPU の勝ち');
        this.hooks.score();
        this.after(TIMING.NEXT_MATCH, () => {
          this.match.reset();
          this.serverPartner = { you: 'you', cpu: 'cpu' }; // 次のセットは主力からサーブし直す
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

      const swingBefore = this.you.swing;
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

      // スイング入力の有効時間が、一度も hit() を呼ばずに（＝届かず）尽きた瞬間。
      // hit() は成功した時点で this.you.swing を自分で 0 にするので、ここで
      // 0 を検知できるのは「振ったのに届かなかった」ときだけ。届いたかどうかが
      // 見た目でも分かるよう、空振りでもスイングモーションだけは再生する。
      if (swingBefore > 0 && this.you.swing === 0) this.missSwing();

      this.updatePrep();

      // トスの自動リセットなど、このフレームの stepBall() の結果を見てから
      // 溜めを継続してよいか判定する（先に判定すると1フレーム遅れてしまう）。
      this.tickCharge(dt);
    }

    /** 空振り。当たり判定はせず、振る方向だけボールの位置から見繕う。 */
    missSwing() {
      this.you.anim = PLAYER.SWING_ANIM;
      this.you.stroke = classifyStroke('you', this.ball, this.you);
    }

    /**
     * ボールが自分の陣に向かっていて、まだ振っていない選手にテイクバック（構え）の
     * ポーズを出す。全キャラ共通：実際に打てる距離(REACH)より広い PREP_REACH 圏内に
     * 入った時点でラケットを引いておくので、実際にスイングが始まる前からフォア/バックが
     * 見分けられる。人間は Space を溜めている間は距離に関わらず常にテイクバックを出す
     * （＝打つ意思がすでに明確なため）。
     */
    updatePrep() {
      // Space を溜めている間だけ 0〜1 で伸びる、テイクバックの深さ表示用の値。
      // 打つ・トスするなど他の文脈に移ったら（charging が false に戻ったら）即座に引っ込める。
      this.you.chargeFrac = this.you.charging
        ? clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1)
        : 0;
      if (this.phase !== 'rally') {
        this.you.prep = null;
        this.cpu.prep = null;
        this.youMate.prep = null;
        this.cpuMate.prep = null;
        return;
      }
      // 溜めている間は chargeStart() で固定した向きを使い続ける（毎フレーム判定し直さない）
      this.you.prep = this.you.charging
        ? this.you.chargeStroke
        : this.computePrep('you', PLAYER.PREP_REACH);
      this.cpu.prep = this.computePrep('cpu', PLAYER.CPU_PREP_REACH);
      this.youMate.prep = this.doubles ? this.computePrep('youMate', PLAYER.CPU_PREP_REACH) : null;
      this.cpuMate.prep = this.doubles ? this.computePrep('cpuMate', PLAYER.CPU_PREP_REACH) : null;
    }

    /** @returns {'forehand'|'backhand'|null} 圏内かつ自分が拾うべき球なら見込みのストロークを返す */
    computePrep(who, reach) {
      const ball = this.ball;
      if (!ball.live || TEAM_OF[who] === ball.last) return null;
      const player = this.actor(who);
      const onMySide = TEAM_OF[who] === 'you' ? ball.z < PLAYER.NET_MARGIN : ball.z > PLAYER.NET_MARGIN;
      if (!onMySide || !reaches(ball, player, reach)) return null;
      return classifyStroke(who, ball, player);
    }

    /**
     * プレイヤーが動ける範囲。自分のサーブ中（トスから打つまで）だけ、
     * フットフォルトになる位置（ベースラインの内側／センターマークの反対側／サイドラインの外）
     * へは動けないよう狭める。
     */
    youBounds() {
      // 自分が実際にサーブする番のときだけ制限する（ダブルスで相方の番のときは対象外）
      if (!(this.phase === 'serve' && this.servingPlayer() === 'you')) {
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
      this.updateReactTimers(dt);

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

    /**
     * ball.last がチームをまたいで変わった瞬間（＝新しい球が飛んできた瞬間）に、
     * 守る側の CPU の反応遅延タイマーをセットする。この間は移動を止めるので、
     * 直前まで動いていた方向と逆を突かれると間に合わなくなる。
     */
    updateReactTimers(dt) {
      this.reactTimers.cpu = Math.max(0, this.reactTimers.cpu - dt);
      this.reactTimers.cpuMate = Math.max(0, this.reactTimers.cpuMate - dt);
      this.reactTimers.youMate = Math.max(0, this.reactTimers.youMate - dt);

      const owner = this.ball.last;
      if (this.phase === 'rally' && owner !== this.lastBallOwnerSeen) {
        if (owner === 'you') {
          this.reactTimers.cpu = PLAYER.CPU_REACT;
          this.reactTimers.cpuMate = PLAYER.CPU_REACT;
        } else if (owner === 'cpu') {
          this.reactTimers.youMate = PLAYER.CPU_REACT;
        }
      }
      this.lastBallOwnerSeen = owner;
    }

    /** シングルスの CPU 移動（従来どおり）。ダブルスでは使わない。 */
    moveSinglesCpu(cpuBefore, dt) {
      const incoming = this.phase === 'rally' && this.ball.last === 'you';
      if (incoming && this.reactTimers.cpu > 0) {
        this.cpu.speed = 0; // まだ反応できていない
        return;
      }
      const target = incoming ? chasePosition(this.ball) : homePosition();
      this.moveTowards(this.cpu, cpuBefore, target, incoming ? PLAYER.CPU_CHASE : PLAYER.CPU_RECOVER, dt);
    }

    /**
     * ダブルスの4人の移動。各ペアは、落下点に近い方（＝ isResponder ）が返球に向かい、
     * もう一方は相方の反対サイドのネット際で構える（本格的なフォーメーション戦略ではない簡易版）。
     *
     * サーブ待ち中（phase==='serve'）は4人とも動かさない。newPoint() が既にサーバー・
     * レシーバー・両者の相方を正しいスタンスへ置いているので、ここで通常のラリー用の
     * 追う/構えるロジックを適用すると、サーバーはサービススタンスからネット際の構え位置へ
     * 毎フレーム寄っていってフットフォルトに見えるし、レシーバー側もまだ来ていない
     * サーブへの構えを崩されてしまう（＝レシーブできない一因）。ボールが実際に
     * 生きる（phase==='rally'）まではみな静止させる。
     */
    moveDoublesTeams(dt) {
      if (this.phase === 'serve') {
        this.cpu.speed = 0;
        this.cpuMate.speed = 0;
        this.youMate.speed = 0;
        return;
      }

      const ball = this.ball;
      const cpuBefore = { x: this.cpu.x, z: this.cpu.z };
      const cpuMateBefore = { x: this.cpuMate.x, z: this.cpuMate.z };
      const youMateBefore = { x: this.youMate.x, z: this.youMate.z };

      // cpu チーム：you 側の打球が向かってくる番なら、cpu/cpuMate のうち近い方が追う。
      // 反応遅延タイマーが残っている間は、担当側でも静止したまま（＝逆を突かれる余地）。
      const cpuTeamChasing = this.phase === 'rally' && ball.last === 'you';
      if (cpuTeamChasing && isResponder(this.cpu, this.cpuMate, ball)) {
        if (this.reactTimers.cpu <= 0) {
          this.moveTowards(this.cpu, cpuBefore, chasePosition(ball, 1), PLAYER.CPU_CHASE, dt);
        } else {
          this.cpu.speed = 0;
        }
        this.moveTowards(this.cpuMate, cpuMateBefore, coverPosition(this.cpu.x, DOUBLES.NET_Z_CPU), PLAYER.CPU_RECOVER, dt);
      } else if (cpuTeamChasing) {
        if (this.reactTimers.cpuMate <= 0) {
          this.moveTowards(this.cpuMate, cpuMateBefore, chasePosition(ball, 1), PLAYER.CPU_CHASE, dt);
        } else {
          this.cpuMate.speed = 0;
        }
        this.moveTowards(this.cpu, cpuBefore, coverPosition(this.cpuMate.x, DOUBLES.NET_Z_CPU), PLAYER.CPU_RECOVER, dt);
      } else {
        this.moveTowards(this.cpu, cpuBefore, homePosition(), PLAYER.CPU_RECOVER, dt);
        this.moveTowards(this.cpuMate, cpuMateBefore, coverPosition(0, DOUBLES.NET_Z_CPU), PLAYER.CPU_RECOVER, dt);
      }

      // youMate：人間（you）の打球が向かってくる番で、自分の方が you より近ければ追う。
      // 自陣（z<0）を追わせるため chasePosition には side=-1 を渡す。
      const mateChasing = this.phase === 'rally' && ball.last === 'cpu'
        && isResponder(this.youMate, this.you, ball);
      if (mateChasing && this.reactTimers.youMate <= 0) {
        this.moveTowards(this.youMate, youMateBefore, chasePosition(ball, -1), PLAYER.CPU_CHASE, dt);
      } else if (mateChasing) {
        this.youMate.speed = 0;
      } else {
        const youMateZ = this.youMateFormation === 'back' ? DOUBLES.BACK_Z_YOU : DOUBLES.NET_Z_YOU;
        this.moveTowards(this.youMate, youMateBefore, coverPosition(this.you.x, youMateZ), PLAYER.CPU_RECOVER, dt);
      }
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
      // サーブはノーバウンドで返球できない（volleyしてはいけない）。1バウンドするまで待つ。
      const mustBounceFirst = this.serveInFlight && ball.bounces < 1;
      if (mustBounceFirst) return;

      // プレイヤーは Space を押した瞬間の前後だけ打てる。人間が優先（AIパートナーに横取りさせない）
      if (ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN && this.you.swing > 0) {
        if (reaches(ball, this.you, PLAYER.REACH) && ball.y < PLAYER.REACH_Y) {
          this.hit('you');
          this.you.swing = 0;
        }
      }

      // ダブルスの youMate：人間が届かなかった／振らなかった球を、CPUと同様に自動で拾う。
      // ただし自分が担当（isResponder、＝moveDoublesTeams() の追う/構える判定と同じ基準）の
      // ときだけ。そうしないと、人間が取るべき（＝人間の方が近い）球まで先に振ってしまう。
      if (this.doubles && ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN
        && isResponder(this.youMate, this.you, ball)) {
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
