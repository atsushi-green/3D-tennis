/**
 * ゲームのルールと状態。three.js にも DOM にも触らない。
 * 外へ伝えたいこと（音・コール・スコア更新）は hooks 経由で呼び出す。
 */
(function (RallyOne) {
  'use strict';

  const {
    BOUNDS, CHARGE, COURT, CPU, DOUBLES, DROP, FX, HALF_L, HALF_W, NET, PHYSICS, PLAYER, RETURN, SERVE,
    SHOT, SMASH_HINT, STAMINA, TIMING, TIMING_AIM, TRAIL, VOLLEY, WIND,
  } = RallyOne.config;
  const {
    approach2D, clamp, lerp, mpsToKmh, rand, signOr,
  } = RallyOne.math;
  const {
    hitsNet, integrate, predictWindow, reflectBounce, solveShot,
  } = RallyOne.physics;
  const {
    chasePosition, homePosition, netRushPosition, cpuShot, cpuVolleyShot, cpuSmashShot,
    isResponder, coverPosition, reactReach, aiSpin,
  } = RallyOne.ai;
  const { Match } = RallyOne.scoring;

  const { BALL_R, STEP } = PHYSICS;

  const opponent = (who) => (who === 'you' ? 'cpu' : 'you');

  /**
   * サーブが狙う対角の符号（targetSign）と、打ち込む方向（dir、+1＝you→cpu向き）。
   * serve()・beginServe()・inServiceBox() の3箇所で同じ式が必要になるので一箇所にまとめる。
   * @param {'you'|'cpu'} serverTeam
   * @param {1|-1} side match.serveSide（クロス/逆クロス）
   */
  function serveAim(serverTeam, side) {
    const dir = serverTeam === 'you' ? 1 : -1;
    const targetSign = serverTeam === 'you' ? -side : side;
    return { dir, targetSign };
  }

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

  /**
   * ボールが今の速度のまま直進した場合、プレイヤーの奥行き(z)まで届く瞬間の x 座標（仮想延長線）。
   * バウンドは vx/vz を同じ係数で減速させるだけで比（＝軌道の向き）は変えないので、
   * バウンドをまたいでもこの直線予測はそのまま成立する。まだボールが遠いうちに判定しても、
   * 「今のボールの位置」ではなく「届く頃にどちら側へ来るか」で見積もれる。
   */
  function virtualBallX(ball, player) {
    if (Math.abs(ball.vz) < 1e-6) return ball.x;
    const t = (player.z - ball.z) / ball.vz;
    if (!(t > 0)) return ball.x; // 既に通り過ぎた/向かっていない場合は現在位置で代用
    return ball.x + ball.vx * t;
  }

  /**
   * CPU/AI がその球を「今」返してよいか（ノーバウンドで手を出してよいか）。
   * 原則は1バウンド待ってから返すが、ネット際（PLAYER.VOLLEY_Z 以内）にいるならボレー、
   * 頭上へ上がってきた球（CPU.SMASH_MIN_Y 以上でコートの中）ならスマッシュで叩ける。
   * 後者を許さないと、ai.js#smashApproach() が先回りさせた位置に立っていても
   * 打点が高いまま素通りさせてしまい、結局バウンド後に打ち直すことになる。
   */
  function aiCanReturnNow(actor, ball) {
    return ball.bounces >= 1
      || Math.abs(actor.z) <= PLAYER.VOLLEY_Z
      || (ball.y >= CPU.SMASH_MIN_Y && ball.vy <= CPU.SMASH_FALLING_VY
        && Math.abs(actor.z) <= CPU.SMASH_Z_MAX);
  }

  /** ボールの仮想延長線が、ラケット側か逆側（体の反対側に手を伸ばす＝バックハンド）か */
  function classifyStroke(who, ball, player) {
    const x = virtualBallX(ball, player);
    return RACKET_SIDE[who] * (x - player.x) >= 0 ? 'forehand' : 'backhand';
  }

  /**
   * 打てる区間（physics.predictWindow() の結果）から、立つべき地点と間に合うかどうかを作る。
   * 立つ場所は区間の真ん中（両端は帯のふちなので、少しずれると打てなくなる）。
   * @param {{mid:object, exit:object}} hitWindow
   * @param {{x:number, z:number}} you
   * @param {(x:number) => number} standX コート内（動ける範囲）へ丸める
   * @param {(z:number) => number} standZ
   */
  function smashHintFrom(hitWindow, you, standX, standZ) {
    const { mid, exit } = hitWindow;
    const x = standX(mid.x);
    const z = standZ(mid.z);
    // 走る時間（加速は無視した楽観値）＋着いてから溜める時間。走っている間は溜まらない
    // （CHARGE.MOVE_CAP_FLOOR=0）ので、この2つは重ならず足し算になる。帯を抜けきる
    // 時刻(exit.t)までに済むなら間に合う。
    const needT = Math.hypot(x - you.x, z - you.z) / PLAYER.SPEED
      + CHARGE.MAX_TIME * PLAYER.SMASH_MIN_CHARGE;
    return {
      x,
      y: mid.y,
      z,
      t: mid.t,
      ready: Math.hypot(you.x - mid.x, you.z - mid.z) <= SMASH_HINT.READY_DIST,
      inTime: needT <= exit.t,
    };
  }

  /**
   * ポイントが決まったときに「何で決めたか」を出すための球種名。
   * 打ち方（stroke）とスピン（spin）とロブかどうかの組み合わせを、観戦者から見た
   * 呼び名ひとつに畳む。スマッシュ・ボレー・ロブ・サーブは打ち方そのものが球種なので
   * スピンより優先し（実際これらは常にフラット固定）、通常のグラウンドストロークだけ
   * スピンで呼び分ける。
   * @param {'forehand'|'backhand'|'smash'|'serve'|'volley-forehand'|'volley-backhand'} stroke
   * @param {'flat'|'top'|'slice'|'drop'} spin
   * @param {boolean} [lob]
   */
  const SPIN_LABELS = {
    top: 'スピンショット',
    slice: 'スライスショット',
    drop: 'ドロップショット',
    flat: 'フラットショット',
  };

  function shotLabel(stroke, spin, lob) {
    if (stroke === 'smash') return 'スマッシュ';
    if (stroke === 'serve') return 'サービス';
    if (typeof stroke === 'string' && stroke.startsWith('volley-')) return 'ボレー';
    if (lob) return 'ロブ';
    return SPIN_LABELS[spin] || SPIN_LABELS.flat;
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
        spin: 'flat',   // 'flat'|'top'|'slice'。飛翔中の実効重力とバウンドの弾み方に効く
        age: 0,         // 最後に打たれてからの経過時間(秒)。CPU/AIが「反応する時間」に使う（ai.reactReach）
        wind: 0,        // 横風（m/s²、vxに継続的に加算）。サーブの飛翔中は常に0、返球後だけ this.wind になる
      };
      this.you = {
        x: 0, z: -HALF_L - 0.6, vx: 0, vz: 0, // vx/vz は実速度（加速度で目標速度に近づける）
        swing: 0, anim: 0, speed: 0, stroke: 'forehand', prep: null,
        charging: false, chargeTime: 0, swingCharge: 0, // 溜めキー押しっぱなしのテイクバック
        chargeFrac: 0, // 溜めている間だけ 0〜1 で増える、テイクバックの深さ用（chargeTime のポーズ表示版）
        chargeStroke: null, // chargeStart() の瞬間に固定するフォア/バック。溜めている間は変えない
        chargeSpin: 'flat', // chargeStart() の瞬間に固定するスピン（B/V/C）。実際に当たるまで押し続けなくてよい
        stamina: 1, // 0〜1。長いラリーで走るほど減り、ポイント間で少し回復する（newPoint()参照）
      };
      this.cpu = {
        x: 0, z: CPU.HOME_Z, anim: 0, speed: 0, chaseDist: 0, stroke: 'forehand', prep: null, stamina: 1,
      };
      // ダブルス（this.doubles === true）のときだけ動く AI パートナー。シングルスでは未使用のまま。
      this.youMate = {
        x: 0, z: DOUBLES.NET_Z_YOU, anim: 0, speed: 0, chaseDist: 0, stroke: 'forehand', prep: null, stamina: 1,
      };
      this.cpuMate = {
        x: 0, z: DOUBLES.NET_Z_CPU, anim: 0, speed: 0, chaseDist: 0, stroke: 'forehand', prep: null, stamina: 1,
      };

      this.phase = 'idle';
      /**
       * 各チームがこのポイントで最後に打った球種の名前（shotLabel()）。ポイントが決まったとき、
       * 取った側が何で決めた（あるいは何で相手のミスを誘った）かを表示するのに使う。
       * newPoint() で毎ポイント消す。
       */
      this.lastShotBy = { you: null, cpu: null };
      /** このポイントで何本打たれたか（サーブも1本に数える）。beginServe() で数え直す。 */
      this.rallyShots = 0;
      /**
       * スマッシュの先回りヒント。毎フレーム smashSpot() が入れ直す（打てる球が来ていなければ null）。
       * 表示専用の値なので、ゲームの判定はここを一切読まない（scene/hint.js と hud.js だけが使う）。
       */
      this.smashHint = null;
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
      /** true の間、ボールはトス中（重力で上下するだけ）。溜めキーを離して打つまで待つ。 */
      this.tossActive = false;
      /**
       * true の間、CPU/AI（cpu・cpuMate・youMate）のサーブ前トスを重力任せで上下させる。
       * tossActive は「自分（人間）が離すまで待つ」入力待ちの意味も兼ねる（movePlayers()の
       * 動作停止やchargeStart()の分岐に使われる）ため、AIのサーブでも流用すると人間側の
       * 移動まで止まってしまう。見た目だけのトスなので別フラグにする（実際の打点・威力は
       * serve() が SERVE.TOSS_Y 固定で計算するため、この演出の値には影響されない）。
       */
      this.aiTossActive = false;
      /** true の間はサーブがまだ一度も返球されていない＝ノーバウンドで打ち返してはいけない。 */
      this.serveInFlight = false;
      /**
       * プレースタイル「サーブ&ボレーヤー」用。cpu が自分のサーブを打った瞬間に true になり、
       * そのポイントの間ずっと（返球された後も）ネット際へ詰め続ける。以前は serveInFlight
       * （＝自分のサーブがまだ返されていない、ごく短い間）と誤って連動させていたため、
       * 人間が返球した瞬間にネットへの接近そのものをやめてしまい、実質ほとんど前に出られ
       * ていなかった（ユーザー報告）。moveSinglesCpu() 参照。
       */
      this.cpuNetRush = false;
      /** setTimeout ではなくゲームループで数える。ポイント間で確実に破棄できる。 */
      this.timers = [];
      /**
       * ラリー中の直近1打の軌跡（{x,y,z}の配列）。誰か（you/cpu/youMate/cpuMate）が新しく
       * 打つ（serve()/hit()）たびに描き直す＝常に「そのポイントを決めた最後の1打」だけが
       * 残る。ポイントが終わった後は、次に誰かが打つまでポイントをまたいで残り続ける
       * （アウトの結果を振り返れるように）。ラリー中に表示するか（phase==='rally'の間は
       * 隠す）は scene 側の仕事。
       */
      this.trail = [];
      /**
       * CPU 側の反応遅延タイマー（cpu/cpuMate/youMate）。新しい球が飛んできた瞬間に
       * PLAYER.CPU_REACT にセットし、0になるまで移動を止める（＝逆を突かれると間に合わない）。
       */
      this.reactTimers = { cpu: 0, cpuMate: 0, youMate: 0 };
      /**
       * 打球後の硬直タイマー（cpu/cpuMate/youMate/you）。振り抜いた瞬間に
       * PLAYER.CPU_RECOVER_DELAY（you は PLAYER.HIT_RECOVER_DELAY）にセットし、0になるまで
       * 動けなくする（＝打った直後は棒立ちで、すぐにミドルへ戻れるわけではない）。
       * you の分は moveIfRecovered() ではなく movePlayers() 内で直接見る（you は目標位置へ
       * 寄せる自動移動ではなく、入力をそのまま速度に反映する方式のため）。
       */
      this.recoverTimers = {
        cpu: 0, cpuMate: 0, youMate: 0, you: 0,
      };
      /** 直前フレームの ball.last。変化を検知して反応遅延タイマーを起動するために使う。 */
      this.lastBallOwnerSeen = null;
      /** 今のポイントのサーブが1本目(1)か、1本目がフォールトした後のセカンドサーブ(2)か。 */
      this.serveNumber = 1;
      /** チームごとの通算スタッツ（HUD表示用）。マッチ全体（1セット）を通して積算し、リセットしない。 */
      this.stats = {
        you: { aces: 0, doubleFaults: 0 },
        cpu: { aces: 0, doubleFaults: 0 },
      };

      /**
       * このポイント中に吹いている風（横方向の加速度、m/s²）。newPoint() で決め直す。
       * サーブの飛翔（トス〜1本目の着地）は風の影響を受けない（サーブ自体のバランス調整を
       * 崩さないため）。ball.wind は beginServe() で0にリセットし、hit()（サーブの返球も含む）
       * のたびにこの値へ差し替えることで、「サーブは常に無風、返ってきてからのラリーだけ
       * 風に流される」という区別を作っている。
       */
      this.wind = 0;
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

    /**
     * ダブルスで、今の球にチームのどちらが応答するか。
     * サーブがまだ一度も返されていない間（serveInFlight）は、実際のダブルスと同じく
     * レシーバーが固定：落下点に近くても、レシーブ側でない相方（ネット際で構えている方）は
     * 手を出さない。一度でも返球された後は通常のラリーとして、落下点に近い方が応答する。
     * @param {'you'|'cpu'} team 応答する側のチーム
     * @returns {'you'|'youMate'|'cpu'|'cpuMate'}
     */
    doublesResponder(team) {
      if (this.serveInFlight) return this.receivingPlayer(team, this.match.serveSide);
      const primaryKey = team === 'you' ? 'you' : 'cpu';
      const mateKey = team === 'you' ? 'youMate' : 'cpuMate';
      return isResponder(this[primaryKey], this[mateKey], this.ball) ? primaryKey : mateKey;
    }

    /* -------------------------------------------------------------- 入力 */

    /**
     * @param {boolean} [doubles] true ならダブルス（you+youMate vs cpu+cpuMate）で開始
     * @param {'you'|'cpu'} [initialServer] トス（コイントス）で決まった最初のサーバー。
     *   省略時は既定の 'you'（コンストラクタで設定済み）のまま。以降のゲームごとの交代は
     *   endPoint() の既存ロジックがそのまま続ける（ここは開始時の1回だけに効く）。
     */
    start(doubles, initialServer) {
      if (this.started) return;
      this.started = true;
      this.doubles = !!doubles;
      if (initialServer) this.server = initialServer;
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
     * 溜めキー（B＝フラット／V＝トップスピン／C＝スライス。クリックも可）を押した瞬間。
     * サーブは押しっぱなしにする間トスが上がり続け、離した瞬間に打つ
     * （＝トス開始とテイクバックの溜め開始は同じ1回の押下）。ラリー中はテイクバックを
     * 溜め始める。実際に打つのは chargeRelease()（離した瞬間）。
     * @param {'flat'|'top'|'slice'} [spin] 押したキーに対応するスピン。省略時はフラット。
     */
    chargeStart(spin = 'flat') {
      // 自分がサーブする番（＝ダブルスで味方が回ってきているときは対象外）のときだけ反応する
      const myServe = this.phase === 'serve' && this.servingPlayer() === 'you';
      if (myServe && !this.tossActive) {
        this.tossBall();
        this.you.charging = true;
        this.you.chargeTime = 0;
        // サーブのスピン（V/C＝トップスピン／スライス）もトスを上げた瞬間に固定する。
        // グラウンドストロークと同じ理由で、当たる瞬間まで押し続けなくてよい。
        this.you.chargeSpin = spin;
        return;
      }
      if ((myServe && this.tossActive) || this.phase === 'rally') {
        this.you.charging = true;
        this.you.chargeTime = 0;
        if (this.phase === 'rally') {
          // フォア/バックはテイクバックを始めた瞬間、ボールの仮想延長線（今の速度のまま
          // 届いたときの左右関係）と自分の位置関係で決め、溜めている間は変えない。
          // 毎フレーム判定し直すと、溜めている最中に左右が入れ替わってテイクバックの
          // 向きが急に反転して見えることがあった。
          this.you.chargeStroke = classifyStroke('you', this.ball, this.you);
          // スピン（B/V/C）も同じタイミングで固定する。押したキーがそのまま結果になるので、
          // 当たる瞬間まで押し続ける必要はない。
          this.you.chargeSpin = spin;
        }
      }
    }

    /** 溜めキー（B/V/C）／クリックを離した瞬間。溜めた量（サーブはタイミング）に応じた威力で打つ。 */
    chargeRelease() {
      if (!this.you.charging) return;
      this.you.charging = false;
      const myServe = this.phase === 'serve' && this.servingPlayer() === 'you';
      this.you.swingCharge = myServe
        ? this.serveTimingPower(this.you.chargeTime)
        : clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);

      if (myServe && this.tossActive) {
        this.serve('you');
      } else if (this.phase === 'rally') {
        this.you.swing = PLAYER.SWING_WINDOW;
      }
    }

    /**
     * サーブの威力(0〜1)。長く溜めるほど強いのではなく、SERVE.CHARGE_SWEET_T にちょうど
     * 近いタイミングで離したときに最大になり、早すぎても遅すぎても CHARGE_WINDOW の幅で
     * 弱くなる（三角形のカーブ）。
     * @param {number} heldTime 溜めキーを押してから離すまでの実経過時間(秒)
     */
    serveTimingPower(heldTime) {
      const { CHARGE_SWEET_T, CHARGE_WINDOW } = SERVE;
      return clamp(1 - Math.abs(heldTime - CHARGE_SWEET_T) / CHARGE_WINDOW, 0, 1);
    }

    /**
     * HUD のゲージ表示用。「今この瞬間に離したら」どれくらいの威力になるかを 0〜1 で返す
     * （サーブはタイミングのカーブ、ラリーは溜め時間の割合）。溜めていなければ0。
     */
    chargeMeter() {
      if (!this.you.charging) return 0;
      const myServe = this.phase === 'serve' && this.servingPlayer() === 'you';
      return myServe
        ? this.serveTimingPower(this.you.chargeTime)
        : clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);
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
      if (myServe) {
        // サーブ中はトス中ずっと（item2 により）静止しているので、移動によるキャップは
        // 掛けない。タイミングのカーブ自体が「早すぎ／遅すぎ」を弱くするので、実経過
        // 時間をそのまま溜め時間として使う（MAX_TIME で頭打ちにしない）。
        this.you.chargeTime += dt;
        return;
      }
      const capTime = CHARGE.MAX_TIME * this.chargeSpeedCap(this.you.speed) * this.staminaChargeMult(this.you.stamina);
      // 動き出してキャップが今の溜め量を下回ったら、溜めた分はキャップまで抜けていく。
      // 以前は「減らさない」仕様だったため、止まって溜め切ってから走り出せばフル溜めを
      // そのまま持ち運べ、移動によるキャップが実質的に効いていなかった。
      this.you.chargeTime = this.you.chargeTime > capTime
        ? Math.max(capTime, this.you.chargeTime - CHARGE.MOVE_DECAY * dt)
        : Math.min(this.you.chargeTime + dt, capTime);
    }

    /** 移動速度から溜め上限（0〜1、MAX_TIMEに対する割合）を求める。動くほど溜めにくくなる。 */
    chargeSpeedCap(speed) {
      const { MOVE_CAP_SPEED_START, MOVE_CAP_SPEED_FULL, MOVE_CAP_FLOOR } = CHARGE;
      if (speed <= MOVE_CAP_SPEED_START) return 1;
      const t = clamp(
        (speed - MOVE_CAP_SPEED_START) / (MOVE_CAP_SPEED_FULL - MOVE_CAP_SPEED_START), 0, 1,
      );
      return 1 - t * (1 - MOVE_CAP_FLOOR);
    }

    /**
     * スタミナ(0〜1)から性能倍率を求める共通カーブ。STAMINA.LOW_THRESHOLD より上では
     * ゆるやかに、それを下回ると floor へ向けて急勾配で落ちる（体力が少ないときの
     * 失速をはっきり体感できるようにする）。
     */
    staminaCurve(stamina, floor, thresholdMult) {
      const { LOW_THRESHOLD } = STAMINA;
      if (stamina >= LOW_THRESHOLD) {
        return lerp(thresholdMult, 1, (stamina - LOW_THRESHOLD) / (1 - LOW_THRESHOLD));
      }
      return lerp(floor, thresholdMult, stamina / LOW_THRESHOLD);
    }

    /** スタミナ(0〜1)から移動速度の倍率を求める。尽きても STAMINA.SPEED_FLOOR までしか落ちない。 */
    staminaSpeedMult(stamina) {
      return this.staminaCurve(stamina, STAMINA.SPEED_FLOOR, STAMINA.LOW_SPEED_MULT);
    }

    /** スタミナ(0〜1)から溜め速度（CHARGE.MAX_TIME に対する倍率）を求める。人間の溜めにだけ効く。 */
    staminaChargeMult(stamina) {
      return this.staminaCurve(stamina, STAMINA.CHARGE_FLOOR, STAMINA.LOW_CHARGE_MULT);
    }

    /** 実際に走った距離ぶん、その選手のスタミナを減らす（0未満にはしない）。 */
    drainStamina(actor, moved) {
      actor.stamina = Math.max(0, actor.stamina - moved * STAMINA.DRAIN_PER_M);
    }

    /**
     * ポイント間の回復量。そのセットで消化したゲーム数（gamesPlayed）が増えるほど
     * RECOVER_FATIGUE_PER_GAME ぶんずつ目減りし、下限は RECOVER_PER_POINT の
     * RECOVER_MIN_RATIO 倍まで（＝終盤ほど疲れが抜けにくくなるが、回復が完全に
     * 止まりはしない）。
     */
    staminaRecoverAmount(gamesPlayed) {
      const min = STAMINA.RECOVER_PER_POINT * STAMINA.RECOVER_MIN_RATIO;
      return Math.max(min, STAMINA.RECOVER_PER_POINT - gamesPlayed * STAMINA.RECOVER_FATIGUE_PER_GAME);
    }

    /* ------------------------------------------------------ ポイント進行 */

    newPoint() {
      this.serveNumber = 1;
      this.lastShotBy = { you: null, cpu: null };
      // 風は毎ポイント、前のポイントの風から WIND.DRIFT_ACCEL の範囲だけ変える（無関係な
      // 値へ決め直すと点ごとに向きが唐突に入れ替わって見えるため）。フォールトによる
      // セカンドサーブ（beginServe の再実行）をまたいでも同じポイント中は吹き続ける
      // （beginServe() 側では ball.wind を0に戻すだけ）。
      this.wind = clamp(this.wind + rand(-WIND.DRIFT_ACCEL, WIND.DRIFT_ACCEL), -WIND.MAX_ACCEL, WIND.MAX_ACCEL);
      this.hooks.wind(this.wind);
      this.hooks.serveSpeed(null); // 前のポイントのサーブ速度表示を消す
      // スタミナはポイント間で少し回復するが、そのセットで消化したゲーム数が増えるほど
      // 回復量そのものが目減りする（staminaRecoverAmount()）＝長いセットの終盤ほど
      // 疲れが抜けなくなる。4人全員に同じルールで効く。
      const recover = this.staminaRecoverAmount(this.match.games.you + this.match.games.cpu);
      this.you.stamina = Math.min(1, this.you.stamina + recover);
      this.cpu.stamina = Math.min(1, this.cpu.stamina + recover);
      this.youMate.stamina = Math.min(1, this.youMate.stamina + recover);
      this.cpuMate.stamina = Math.min(1, this.cpuMate.stamina + recover);
      this.beginServe();
    }

    /**
     * フォールト（ネット／アウト）になった1本目のサーブに続けて、セカンドサーブとして
     * トスからやり直させる。失点にはしない（サーバー・レシーバーは変わらない）。
     * @param {string} reason 'ネット'|'アウト'（HUDのコールに使う）
     */
    retryServe(reason) {
      this.beginServe(reason);
    }

    /**
     * サーブ待ちの状態を作る共通処理。newPoint()（1本目）と retryServe()（フォールト後の
     * セカンドサーブ）の両方から呼ぶ。タイマー・ボール・溜めをリセットし、サーバー／
     * レシーバー（ダブルスは両者の相方も）をスタンスへ置いてから案内を出す。
     * @param {string} [faultReason] セカンドサーブのときだけ渡す（'ネット'|'アウト'）
     */
    beginServe(faultReason) {
      this.clearTimers();
      this.phase = 'serve';
      this.tossActive = false;
      this.aiTossActive = false;
      this.serveInFlight = false;
      this.cpuNetRush = false;
      this.rallyShots = 0; // このサーブ（フォールトからのやり直しも含む）から数え直す

      const ball = this.ball;
      ball.live = false;
      ball.bounces = 0;
      ball.vx = ball.vy = ball.vz = 0;
      ball.spin = 'flat'; // 前のポイントのスピンを持ち越さない
      ball.wind = 0; // サーブの飛翔中（1本目の着地まで）は無風にする。返球後は hit() で this.wind に差し替える

      this.you.charging = false;
      this.you.chargeTime = 0; // 前のサーブの溜めを持ち越さない
      this.you.chargeStroke = null;
      this.you.chargeSpin = 'flat';

      // 前のサーブの反応遅延・打球後硬直を持ち越さない（moveDoublesTeams()/moveSinglesCpu() は
      // phase==='serve' 中は動かないので実害はないが、次のラリー開始時に混乱しないよう明示的に戻す）
      this.reactTimers.cpu = 0;
      this.reactTimers.cpuMate = 0;
      this.reactTimers.youMate = 0;
      this.recoverTimers.cpu = 0;
      this.recoverTimers.cpuMate = 0;
      this.recoverTimers.youMate = 0;
      this.recoverTimers.you = 0;
      this.lastBallOwnerSeen = null;

      const side = this.match.serveSide; // クロス(-1)から始まり、ポイントごとに逆クロス(+1)と交互になる
      const serverTeam = this.server;
      const receiverTeam = opponent(serverTeam);
      const server = this.servingPlayer();
      const receiver = this.receivingPlayer(receiverTeam, side);
      const { targetSign } = serveAim(serverTeam, side); // serve()/inServiceBox() と同じ式

      // サーバーをサービススタンスに置く（既存のサーブ位置ロジックと同じ式をチーム単位に一般化。
      // サーバーの立ち位置は、狙う対角(targetSign)の反対サイドになる）
      const serverActor = this.actor(server);
      serverActor.x = -targetSign * SERVE.STANCE_X;
      serverActor.z = serverTeam === 'you' ? -HALF_L - 0.5 : HALF_L + 0.5;
      if (server === 'you') this.you.vx = this.you.vz = 0; // 前のサーブの勢いを持ち越さない

      // レシーバーを、サーブが飛んでくる対角のボックス付近に置く（構える位置が見えるように）
      const receiverActor = this.actor(receiver);
      receiverActor.x = targetSign * RETURN.STANCE_X;
      receiverActor.z = receiverTeam === 'you' ? -HALF_L - RETURN.BACK : HALF_L + RETURN.BACK;
      if (receiver === 'you') this.you.vx = this.you.vz = 0;

      if (this.doubles) {
        this.positionDoublesMates(server, serverActor, serverTeam, receiver, receiverActor, receiverTeam);
      }

      if (server === 'you') {
        this.hooks.call(
          faultReason ? 'セカンドサーブ' : 'サーブ',
          faultReason ? `${faultReason} — もう一度` : '←→ 左右のコース ／ ↑↓ 深さ ／ B/V/C 押しっぱなしで打つ',
        );
      } else if (server === 'youMate') {
        // 人間のチームだが、今回は相方の番。人間は何もしなくてよい
        this.hooks.call(faultReason ? 'パートナーのセカンドサーブ' : 'パートナーのサーブ', faultReason || '');
        this.after(TIMING.CPU_SERVE_DELAY, () => {
          if (this.phase === 'serve') this.serve('youMate');
        });
      } else {
        this.hooks.call(faultReason ? 'セカンドサーブ' : 'リターン', faultReason ? `${faultReason}／CPU` : 'CPU のサーブ');
        this.after(TIMING.CPU_SERVE_DELAY, () => {
          if (this.phase === 'serve') this.serve(server);
        });
      }
      this.placeServeBall();
      // CPU/AI（cpu・cpuMate・youMate）も見た目だけトスを上げる。placeServeBall() の後で
      // 呼ぶ必要がある（先に呼ぶと上のボール位置をトス前の手元に戻されてしまう）。
      if (server !== 'you') this.aiTossBall();
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

    /** 1回目の溜めキー押下。ボールを真上にトスし、重力で自然に落ちてくるのに任せる。 */
    tossBall() {
      const ball = this.ball;
      ball.vx = 0;
      ball.vz = 0;
      ball.vy = Math.sqrt(2 * Math.abs(PHYSICS.GRAVITY) * (SERVE.TOSS_PEAK - SERVE.BALL_Y));
      this.tossActive = true;
      this.hooks.call('トス', 'いいタイミングで離す！');
    }

    /**
     * CPU/AI（cpu・cpuMate・youMate）のサーブ前トス。tossBall() と同じ弾道を見た目だけ
     * 再現する（人間の入力待ちを表す tossActive とは別に aiTossActive を立てる。理由は
     * aiTossActive のコメント参照）。実際の打点・威力は serve() が SERVE.TOSS_Y 固定で
     * 計算するので、ここでの軌道そのものは結果に影響しない。TIMING.CPU_SERVE_DELAY の間に
     * 上がって落ちてくるので、リプレイでもちゃんとトスが見える。
     */
    aiTossBall() {
      const ball = this.ball;
      ball.vx = 0;
      ball.vz = 0;
      ball.vy = Math.sqrt(2 * Math.abs(PHYSICS.GRAVITY) * (SERVE.TOSS_PEAK - SERVE.BALL_Y));
      this.aiTossActive = true;
    }

    serve(who) {
      const ball = this.ball;
      const team = TEAM_OF[who];
      const side = this.match.serveSide;
      const { dir, targetSign } = serveAim(team, side);
      // プレイヤーはトス中の実際の高さで打つ。CPU はトス演出を挟まないので固定の打点高さを使う。
      const contactY = who === 'you' ? Math.max(ball.y, SERVE.BALL_Y) : SERVE.TOSS_Y;
      const from = { x: ball.x, y: contactY, z: ball.z };
      // サービスはコートの対角へ入れる。狙う横位置（コース）はプレイヤーが ←→ で選び、
      // CPU/AI はランダムに選ぶ（どちらも T／ボディ／ワイドの3コース）
      const magnitude = who === 'you'
        ? this.serveAimMagnitude(targetSign)
        : this.cpuServeAimMagnitude();
      const target = {
        x: targetSign * magnitude,
        y: BALL_R,
        z: dir * (COURT.SERVICE - (who === 'you' ? this.serveDepth() : rand(SERVE.DEPTH_MIN, SERVE.DEPTH_MAX))),
      };
      // プレイヤーは「打つ」瞬間の溜め量で威力が変わる。CPU/AI（cpu・cpuMate・youMate）は
      // 溜め演出がない代わりに、難易度で決まる一定の威力（CPU.SERVE_T）で打つ。
      const flightT = who === 'you' ? lerp(SERVE.T, SERVE.CHARGE_T, this.you.swingCharge) : CPU.SERVE_T;
      // 人間はトスを上げた瞬間に固定したスピン（V/C。chargeStart() 参照）でスライスサーブ・
      // スピンサーブが打てる。CPU/AI も同じ SPIN 設定（実効重力・バウンドの弾み方）で
      // 一定確率でスピンサーブを混ぜる（aiSpin()。以前は常にフラット固定だった）。
      const spin = who === 'you' ? this.you.chargeSpin : aiSpin();

      ball.y = from.y;
      Object.assign(ball, solveShot(from, target, flightT, SERVE.CLEARANCE, spin));
      ball.spin = spin;
      // 打った瞬間の初速をそのままスコアボード脇に出す（次のポイントが始まるまで残す）
      this.hooks.serveSpeed(mpsToKmh(Math.hypot(ball.vx, ball.vy, ball.vz)));
      ball.live = true;
      ball.bounces = 0;
      ball.age = 0;
      ball.last = team; // スコア判定・当たり判定はチーム単位（hit() と同じ扱い）
      this.lastShotBy[team] = shotLabel('serve', spin);
      this.resetTrail();

      this.tossActive = false;
      this.aiTossActive = false;
      this.serveInFlight = true; // 一度も返球されていない＝ノーバウンドで打ち返してはいけない
      // プレースタイル「サーブ&ボレーヤー」：cpu が自分のサーブを打った瞬間から、このポイントの
      // 間ずっとネットへ詰め続ける（moveSinglesCpu() 参照）。
      if (who === 'cpu' && CPU.APPROACH_NET_AFTER_SERVE) this.cpuNetRush = true;
      this.phase = 'rally';
      this.rallyShots++; // サーブも1本に数える（観客の歓声・実況の盛り上がりに使う）
      this.resetChase(); // レシーバーが「このサーブを追った距離」を数え始める
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
     * トス中に ←→ で狙うコースを選ぶ。狙い先（targetSign）と同じ向きに入力すればワイド
     * （さらに Shift を押しながら離すと、ワイドより切れ込む代わりにフォールトもしやすい
     * 角度サーブ＝AIM_ANGLE）、逆向きなら T、無入力ならボディへ。
     * @param {1|-1} targetSign このサーブが入るボックスの符号
     */
    serveAimMagnitude(targetSign) {
      const aim = this.input.moveX * INPUT_X_TO_WORLD;
      if (aim === 0) return rand(SERVE.AIM_BODY_MIN, SERVE.AIM_BODY_MAX);
      if (aim !== targetSign) return rand(SERVE.AIM_T_MIN, SERVE.AIM_T_MAX);
      return this.input.lob
        ? rand(SERVE.AIM_ANGLE_MIN, SERVE.AIM_ANGLE_MAX)
        : rand(SERVE.AIM_WIDE_MIN, SERVE.AIM_WIDE_MAX);
    }

    /**
     * プレイヤーのサーブの深さ（サービスラインからどれだけ手前に落とすか。小さいほど深い）。
     * トス中は移動入力が無視される（movePlayers() が tossActive の間は動かさない）ので、
     * ↑↓ をそのまま深さの選択に使える＝新しいキーを増やさずにコースを 3→9 通りにできる。
     * 無入力なら全域からランダム。
     */
    serveDepth() {
      const aim = this.input.moveZ; // 1 = 前（＝深く）, -1 = 後ろ（＝浅く）
      if (aim > 0) return rand(SERVE.DEPTH_MIN, SERVE.DEPTH_DEEP_MAX);
      if (aim < 0) return rand(SERVE.DEPTH_SHORT_MIN, SERVE.DEPTH_MAX);
      return rand(SERVE.DEPTH_MIN, SERVE.DEPTH_MAX);
    }

    /**
     * CPU/AI のサーブのコース選択。プレイヤーと同じ T／ボディ／ワイドから毎回ランダムに選ぶ。
     * ワイドを引いたときだけ、さらに CPU.CPU_ANGLE_CHANCE の確率で角度サーブに格上げする
     * （T／ボディの発生確率は従来どおり1/3ずつのまま変えない）。
     */
    cpuServeAimMagnitude() {
      const roll = Math.random();
      if (roll < 1 / 3) return rand(SERVE.AIM_T_MIN, SERVE.AIM_T_MAX);
      if (roll < 2 / 3) return rand(SERVE.AIM_BODY_MIN, SERVE.AIM_BODY_MAX);
      return Math.random() < SERVE.CPU_ANGLE_CHANCE
        ? rand(SERVE.AIM_ANGLE_MIN, SERVE.AIM_ANGLE_MAX)
        : rand(SERVE.AIM_WIDE_MIN, SERVE.AIM_WIDE_MAX);
    }

    hit(who) {
      const ball = this.ball;
      const player = this.actor(who);
      const from = { x: ball.x, y: Math.max(ball.y, 0.5), z: ball.z };
      this.serveInFlight = false; // 一度でも打ち返されたら「ノーバウンド禁止」の制約は解除
      this.rallyShots++; // 観客の歓声・実況の盛り上がりに使う（ラリーが長いほど盛り上がる）

      // 打った直後は（人間も含めて）すぐには動けない。フォロースルー中は追加入力があっても
      // 動き出せないはず、という想定（CPU/AIはすぐにミドルへ戻れるほど強くない、という意味も兼ねる）。
      this.recoverTimers[who] = who === 'you' ? PLAYER.HIT_RECOVER_DELAY : PLAYER.CPU_RECOVER_DELAY;

      // ball.x/z はまだ打点のまま（solveShot が書き換えるのは vx/vy/vz だけ）なので、
      // ここで打点とプレイヤー位置からフォア/バックを判定できる。shot の計算より前に
      // 必要（playerShot() がタイミングのずれを出すのに使う）。
      // 人間はテイクバックを始めた瞬間に chargeStart() が固定した向きをそのまま使う。
      // ここで改めて判定すると、溜めている間にボールと自分の位置関係が変わった場合、
      // テイクバックで見せていた向きと実際に振る向きがずれてしまう。
      const baseStroke = (who === 'you' && this.you.chargeStroke) || classifyStroke(who, ball, player);

      // 人間の打球だけ溜め量に応じて演出を強める（AIは常に0＝通常の演出）
      const charge = who === 'you' ? this.you.swingCharge : 0;
      // 高くて緩いボール(SMASH_MIN_Y以上)を、しっかり溜めてから(SMASH_MIN_CHARGE以上)離すと
      // スマッシュになる。フォア/バックの区別はなく、専用の振り下ろしモーション＋強打になる。
      // CPU/AI には溜めが無いので、条件は「打点の高さ」＋「コートの中で打てていること」
      // （CPU.SMASH_MIN_Y / SMASH_Z_MAX。ベースラインのはるか後ろで高く弾んだ球は
      // スマッシュではなく、ただ高い打点の返球）。
      const isSmash = who === 'you'
        ? ball.y >= PLAYER.SMASH_MIN_Y && charge >= PLAYER.SMASH_MIN_CHARGE
        : ball.y >= CPU.SMASH_MIN_Y && ball.vy <= CPU.SMASH_FALLING_VY
          && Math.abs(player.z) <= CPU.SMASH_Z_MAX;
      // サービスラインより前（ネット寄り）で、ノーバウンドの球を返すときはボレー。
      // フォア/バックの区別はテイクバックのモーションにだけ使い、実際の威力・角度は
      // 溜めではなくボールとの左右距離で決まる（playerShot() 側で計算する）。
      // CPU/AI がノーバウンドで返せるのは元々ネット際（PLAYER.VOLLEY_Z 以内。
      // checkSwings() のゲート）だけなので、その1本がそのままボレーになる。
      const isVolley = !isSmash && ball.bounces === 0 && (who === 'you'
        ? player.z > -COURT.SERVICE
        : Math.abs(player.z) <= PLAYER.VOLLEY_Z);
      const stroke = isSmash ? 'smash' : isVolley ? `volley-${baseStroke}` : baseStroke;

      // AI（cpu/cpuMate は人間の逆をつきつつ you 陣地(z<0)へ、youMate はダブルスで唯一の
      // AI仲間なので相手チームの主力 cpu の逆をつきつつ cpu 陣地(z>0)へ）。
      // 人間の 'you' だけ playerShot() で自分の入力を使う。
      // AI は「この球を追い始めてから実際に走った距離」を stretch(0〜1) として使う：
      // 大きく走らされた球ほど、山なりで浅く・中央寄りの弱気な返球になる。
      // 以前は打点での実速度(player.speed / CPU_CHASE)で測っていたが、それだと
      // 「打つ瞬間にまだ動いていたか」という実質2値の判定にしかならず、余裕をもって
      // 1歩詰めただけの球まで最弱の返球になっていた（実測：サーブリターンの stretch は
      // ほぼ全て 1.00＝ユーザー報告「返球が全体的に弱い」の主因）。走った距離なら
      // 「どれだけ苦しかったか」が連続量として出る。
      const stretch = who === 'you'
        ? 0
        : clamp((player.chaseDist - CPU.STRETCH_DIST_MIN)
          / (CPU.STRETCH_DIST_MAX - CPU.STRETCH_DIST_MIN), 0, 1);
      // ダブルスはラリーが長引きやすく、同じロブ選択率・同じ山なり化の度合いでも
      // 1ポイント中の絶対数が増えて目立つため、DOUBLES.LOB_SCALE / ARC_SCALE で
      // 抑える（config.js のコメント参照）。
      const lobScale = this.doubles ? DOUBLES.LOB_SCALE : 1;
      const arcScale = this.doubles ? DOUBLES.ARC_SCALE : 1;
      // CPU/AI は打ち方（スマッシュ／ボレー／グラウンドストローク）ごとに狙いを変える。
      // 以前はどの打ち方でも一律 cpuShot()（中速のグラウンドストローク）だったため、
      // ネット際で捕まえた球も頭上に上がってきた球も同じ速さ・深さで返っていた。
      const aimAt = TEAM_OF[who] === 'cpu' ? this.you : this.cpu; // 逆をつく相手
      const aimDir = TEAM_OF[who] === 'cpu' ? -1 : 1;             // 打ち込む方向
      const shot = who === 'you'
        ? this.playerShot(stroke, ball.z - player.z)
        : isSmash
          ? cpuSmashShot(aimAt, aimDir, stretch)
          : isVolley
            ? cpuVolleyShot(aimAt, aimDir, stretch, ball.y)
            : cpuShot(aimAt, aimDir, stretch, lobScale, arcScale);

      // スピン選択は通常のグラウンドストローク限定（スマッシュ・ボレーはフラット固定）。
      // 人間は C＝スライス／V＝トップスピン。chargeStart() の瞬間に固定した値を使う（当たる
      // 瞬間まで押し続けなくてよい。詳細はchargeStart()のコメント参照）。何も押していなければ
      // フラット。CPU/AI（cpu・cpuMate・youMate）は aiSpin() が一定確率で混ぜる
      // （以前は常にフラット固定で単調だった）。
      // ドロップショットだけは playerShot() が専用の spin('drop') を返す（弾道・バウンドとも
      // 通常のスライスとは別扱いにするため）。それ以外は上記のとおり。
      const spin = shot.spin || (stroke === 'forehand' || stroke === 'backhand'
        ? (who === 'you' ? this.you.chargeSpin : aiSpin())
        : 'flat');

      // シングルスの cpu のネットへの詰め（moveSinglesCpu() 参照）。ダブルスは元々2人とも
      // ネット際が基本位置なのでボレーの機会が自然に生まれるが、シングルスの cpu は常に
      // ベースラインへ戻るだけで、一度も前に出ないためボレー・スマッシュが皆無だった。
      // 余裕をもって（stretch が小さい）深く狙えた1本＝アプローチショットの後だけ詰め、
      // 逆にロブなどで深く押し戻されたら（打点が APPROACH_FROM_Z より奥）詰めるのをやめる
      // （＝中途半端な位置に立ち続けない）。
      if (who === 'cpu' && !this.doubles) {
        if (this.cpuNetRush) {
          if (Math.abs(player.z) > CPU.APPROACH_FROM_Z) this.cpuNetRush = false;
        } else if (!shot.lob
          && Math.abs(shot.target.z) >= CPU.APPROACH_DEPTH
          && stretch <= CPU.APPROACH_MAX_STRETCH
          && Math.random() < CPU.APPROACH_CHANCE) {
          this.cpuNetRush = true;
        }
      }

      this.resetChase(); // ここから相手側の「この球を追った距離」を数え直す
      // shot.clearance を返すのはドロップショットだけ（ネットぎりぎりを狙う）。
      // 他は undefined ＝ solveShot() の既定の余裕を使う。
      Object.assign(ball, solveShot(from, shot.target, shot.flight, shot.clearance, spin));
      ball.spin = spin;
      // サーブの返球も含め、ここで打たれた球は以降このポイントの風(this.wind)にさらされる
      // （サーブ自体の飛翔だけは beginServe() が ball.wind=0 にしているので無風のまま）。
      ball.wind = this.wind;
      ball.last = TEAM_OF[who]; // スコア判定はチーム単位。誰が打ったかは player.stroke 側で個別に持つ
      ball.bounces = 0;
      ball.age = 0; // ここから相手の「反応に使える時間」を数え直す
      ball.impact = FX.IMPACT_DURATION * lerp(1, FX.CHARGE_TIME_BOOST, charge);
      ball.impactPower = charge; // フラッシュの大きさに使う
      this.resetTrail();

      // スマッシュだけは跳んで打つぶんモーションが長い（scene/player.js 参照）。
      player.anim = stroke === 'smash' ? PLAYER.SMASH_ANIM : PLAYER.SWING_ANIM;
      player.stroke = stroke;
      this.lastShotBy[TEAM_OF[who]] = shotLabel(stroke, spin, shot.lob);
      this.hooks.sound('hit', TEAM_OF[who], stroke, charge); // 音程はチーム単位（誰が打っても同じ）
    }

    /** 誰か（serve()/hit()の呼び出し元）が新しく打った瞬間、軌跡をその打点1点から描き直す。 */
    resetTrail() {
      this.trail = [{ x: this.ball.x, y: this.ball.y, z: this.ball.z }];
    }

    /**
     * ←→ で左右に打ち分け、Shift でロブ。威力は溜めキーを離した瞬間の溜め量
     * （chargeRelease() が計算した this.you.swingCharge、0〜1）で決まる。
     * 無入力ならクロス気味に返す。
     *
     * 打点のタイミングでもコースがずれる：ボールを前（遠く）で捉えるほど「引っ張り」、
     * 引きつけて近くで打つほど「流れる」。フォアとバックでは体を横切る向きが逆なので、
     * 引っ張る方向も逆になる（pullDir で吸収する）。ロブは対象外。
     * スマッシュはフォア/バックの区別も打点タイミングのずれもなく、←→ でだけ狙う。
     * ボレー（'volley-forehand'|'volley-backhand'）も溜めの影響は受けず、代わりに
     * ボールとプレイヤーの左右距離（サービスラインより前で拾った場合のみ）で威力・角度が決まる。
     * @param {'forehand'|'backhand'|'smash'|'volley-forehand'|'volley-backhand'} [stroke]
     * @param {number} [contactDz] 打点の z - プレイヤーの z（前にあるほど大きい）
     */
    playerShot(stroke = 'forehand', contactDz = TIMING_AIM.NEUTRAL_DZ) {
      const lob = this.input.lob;
      const aim = this.input.moveX * INPUT_X_TO_WORLD;
      const charge = this.you.swingCharge;
      const baseX = aim !== 0 ? aim * SHOT.AIM_X : -signOr(this.you.x, 1) * SHOT.DEFAULT_X;

      if (stroke === 'smash') {
        return {
          target: { x: baseX, y: BALL_R, z: rand(SHOT.SMASH_Z, SHOT.SMASH_Z + SHOT.DRIVE_Z_SPREAD) },
          flight: SHOT.SMASH_T,
        };
      }

      if (stroke === 'volley-forehand' || stroke === 'volley-backhand') {
        // 真正面（距離0）や伸びきり（距離が離れすぎ）は普通のブロック、フォア/バック側に
        // 程よく離れているときだけ鋭く角度をつけた決め球になる（左右どちら側でも対称）。
        const sideDist = Math.abs(this.ball.x - this.you.x);
        const sharpness = clamp(1 - Math.abs(sideDist - VOLLEY.SWEET_DIST) / VOLLEY.WINDOW, 0, 1);
        const dir = aim !== 0 ? Math.sign(aim) : -signOr(this.you.x, 1);
        return {
          target: {
            x: dir * lerp(VOLLEY.BLOCK_X, VOLLEY.ANGLE_X, sharpness),
            y: BALL_R,
            z: lerp(VOLLEY.BLOCK_Z, VOLLEY.ANGLE_Z, sharpness) + rand(0, SHOT.DRIVE_Z_SPREAD),
          },
          flight: lerp(VOLLEY.BLOCK_T, VOLLEY.ANGLE_T, sharpness),
        };
      }

      // 弱いスライス（Cで溜めずに離す）はドロップショット。深さを溜めで選ぶ通常の
      // グラウンドストロークとは別枠にして、狙いをネット際へ完全に移す。
      // スピンは chargeStart() の瞬間に固定した値をそのまま使う（hit() が ball.spin に
      // 入れるのと同じ値なので、弾道の計算と実際の飛翔がずれない）。
      if (!lob && this.you.chargeSpin === 'slice' && charge <= DROP.MAX_CHARGE) {
        const dir = aim !== 0 ? Math.sign(aim) : -signOr(this.you.x, 1);
        return {
          target: { x: dir * rand(DROP.X_MIN, DROP.X_MAX), y: BALL_R, z: rand(DROP.Z_MIN, DROP.Z_MAX) },
          flight: DROP.T,
          clearance: DROP.CLEARANCE,
          spin: 'drop',
        };
      }

      const flight = lob ? SHOT.LOB_T : lerp(SHOT.TAP_T, SHOT.CHARGE_T, charge);
      // 溜めるほど深く。速さと深さの両方が変わるので「強い球を打った」感が出る。
      const depth = lerp(SHOT.TAP_Z, SHOT.CHARGE_Z, charge);

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
        lob,
      };
    }

    endPoint(winner, reason) {
      if (this.phase === 'over') return;
      // ダブルフォルト＝サーバー側の失点。エース＝サーブがリターンに一度も触れられずに
      // (serveInFlight のまま)2バウンドで決まった場合（＝サーバー側の得点）。
      const isAce = reason === 'ツーバウンド' && this.serveInFlight;
      if (reason === 'ダブルフォルト') {
        this.stats[this.server].doubleFaults++;
      } else if (isAce) {
        this.stats[winner].aces++;
      }
      this.phase = 'over';
      this.ball.live = false;
      // 観客の歓声（sfx.point）用の決まり方。エース／ウィナーは相手の非（凡ミス）とは
      // 違う盛り上がり方をする。ラリーの本数（rallyShots）も渡し、長引くほど盛り上げる。
      const outcome = reason === 'ダブルフォルト' ? 'doubleFault'
        : isAce ? 'ace'
          : reason === 'ツーバウンド' ? 'winner' : 'error';
      this.hooks.sound('point', winner, outcome, this.rallyShots);

      const result = this.match.awardPoint(winner);
      const mine = winner === 'you';
      if (result.tiebreak && result.type === 'point') {
        // タイブレーク中は1本目だけ今のサーバーのまま、以降は2ポイントごとに交代
        // （ダブルスのチーム内の個人ローテーションはここでは変えない簡略化。詳細は roadmap-done.md）。
        const total = this.match.tiebreakPoints.you + this.match.tiebreakPoints.cpu;
        if (total % 2 === 1) this.server = opponent(this.server);
      } else if (result.type !== 'point') {
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

      // 「ツーバウンド」は判定としては正しいが表現として味気ないので、実況らしく言い換える：
      // サーブが一度も触れられずに決まったなら「エース！」、ラリー中の決定打なら「ウィナー！」。
      const twoBounceCall = isAce ? 'エース！' : 'ウィナー！';
      const sub = result.type === 'game'
        ? `ゲーム — ${mine ? 'YOU' : 'CPU'}${result.tiebreak ? '（6-6 タイブレーク！）' : ''}`
        : reason === 'ツーバウンド' ? twoBounceCall : reason;
      // 取った側がこのポイントで最後に放ったショット（決め球、または相手のミスを誘った球）。
      // 相手のネット／アウトで決まった場合は「その1本前に自分が打った球」になる。
      this.hooks.call(mine ? 'ポイント' : '失点', sub, this.lastShotBy[winner]);
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

      // 直近の1打が飛んでいる間だけ軌跡を伸ばす。誰かに打ち返された瞬間は resetTrail() が
      // 軌跡を打ち返した側の打点から描き直すので、ここで伸ばすのは常に「今まさに飛んでいる
      // 最新の1打」。ポイントが終わった瞬間から先は（ball.live===false になり）伸びず、
      // その時点の軌跡がそのまま残る（＝次に誰かが打つまで、最新の1本として表示され続ける）。
      if (this.ball.live && this.trail.length < TRAIL.MAX_POINTS) {
        this.trail.push({ x: this.ball.x, y: this.ball.y, z: this.ball.z });
      }

      // スイング入力の有効時間が、一度も hit() を呼ばずに（＝届かず）尽きた瞬間。
      // hit() は成功した時点で this.you.swing を自分で 0 にするので、ここで
      // 0 を検知できるのは「振ったのに届かなかった」ときだけ。届いたかどうかが
      // 見た目でも分かるよう、空振りでもスイングモーションだけは再生する。
      if (swingBefore > 0 && this.you.swing === 0) this.missSwing();

      // 構えの決定（updatePrep）が「スマッシュで打てる位置にいるか」を見るので、先に更新する。
      this.smashHint = this.smashSpot();
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
     * 見分けられる。人間は溜めキーを押している間は距離に関わらず常にテイクバックを出す
     * （＝打つ意思がすでに明確なため）。
     */
    updatePrep() {
      // 溜めキーを押している間だけ 0〜1 で伸びる、テイクバックの深さ表示用の値。
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
      // 溜めている間は chargeStart() で固定した向きを使い続ける（毎フレーム判定し直さない）。
      // ただし、スマッシュで打てる位置に立って溜めているときだけは、フォア/バックの
      // テイクバックではなく「頭の後ろに担ぐ振りかぶり」の構えにする（そのまま離せば
      // スマッシュになる、ということが構えの時点で見て分かる）。
      const windUpSmash = this.you.charging && !!this.smashHint && this.smashHint.ready;
      this.you.prep = windUpSmash
        ? 'smash'
        : this.you.charging
          ? this.you.chargeStroke
          : this.computePrep('you', PLAYER.PREP_REACH);
      this.cpu.prep = this.computePrep('cpu', PLAYER.CPU_PREP_REACH);
      this.youMate.prep = this.doubles ? this.computePrep('youMate', PLAYER.CPU_PREP_REACH) : null;
      this.cpuMate.prep = this.doubles ? this.computePrep('cpuMate', PLAYER.CPU_PREP_REACH) : null;
    }

    /**
     * スマッシュで打てる球が来ているとき、「どこに先回りして立てばよいか」を返す（表示専用）。
     *
     * スマッシュの条件は hit() 側にある通り「打点が PLAYER.SMASH_MIN_Y 以上」＋「溜めが
     * PLAYER.SMASH_MIN_CHARGE 以上」の2つ。溜めは足を止めていないと貯まらない
     * （CHARGE.MOVE_CAP_FLOOR=0）ので、打点まで走ってから溜め始めたのでは間に合わず、
     * 「打点の場所へ早めに着いて止まっておく」必要がある。これが難しさの正体なので、
     * 打てる高さの帯（SMASH_MIN_Y〜REACH_Y）をボールが通る区間を先読みし、その真ん中を
     * 立つべき地点として返す（帯の両端はふちなので、少しずれると打てなくなる）。
     *
     * 帯を通っていても、そこがコートの外＝人間が立てない場所（youBounds() の外）なら
     * ヒントは出さない。ボールの位置そのものではなく「立てる場所からラケットが届くか」で
     * 判定するので、ライン際でも実際に打てるならちゃんと出る。
     *
     * 対象は「ノーバウンドで叩ける球」だけ。ルール上はバウンド後に高く弾んだ球も溜めれば
     * スマッシュになるが、それを案内するとベースラインのはるか後ろに立たせることになり、
     * 「決めにいくスマッシュ」の案内としては役に立たない（実際そうなっていた）。
     * ノーバウンド限定にしたことで、サーブ（1バウンドするまで返せない）にも自動的に
     * ヒントは出なくなる。ベースライン付近（SMASH_HINT.HIDE_BASELINE_Z 以内）に
     * 立っている間も出さない＝前に詰めているときだけの案内になる。
     *
     * @returns {{x:number, z:number, y:number, t:number, ready:boolean, inTime:boolean}|null}
     *   x/z＝立つべき地点、y＝そこでの打点の高さ、t＝打点までの残り時間、
     *   ready＝もう届く位置にいる（あとは溜めて離すだけ）、inTime＝今から走っても間に合う
     */
    smashSpot() {
      const ball = this.ball;
      // 自分が打つ番の、飛んでいる球だけが対象（自分が打った直後の球にヒントを出さない）
      if (this.phase !== 'rally' || !ball.live || ball.last === 'you') return null;
      // ベースライン付近に立っている間は出さない（そこからでは走る時間だけで滞空時間を
      // 使い切ってしまい、どのみち溜めが間に合わない。SMASH_HINT.HIDE_BASELINE_Z 参照）
      if (this.you.z <= -(HALF_L - SMASH_HINT.HIDE_BASELINE_Z)) return null;

      const bounds = this.youBounds();
      const standX = (x) => clamp(x, bounds.xMin, bounds.xMax);
      const standZ = (z) => clamp(z, bounds.zMin, bounds.zMax);
      /** その瞬間のボールが「ノーバウンドでスマッシュできる球」か */
      const smashable = (at) => (
        at.bounces === 0                                       // 落ちる前に叩ける球だけ
        && at.y >= PLAYER.SMASH_MIN_Y && at.y < PLAYER.REACH_Y // 打てる高さの帯（下は溜めても通常打になる高さ、上は届かない高さ）
        && at.z < PLAYER.NET_MARGIN                            // 自陣に入ってから
        // 立てる場所（コート内へ丸めた位置）からラケットが届くか
        && Math.hypot(at.x - standX(at.x), at.z - standZ(at.z)) < PLAYER.REACH
      );

      // maxBounces=0：最初の着地でシミュレーションを打ち切る（バウンド後は対象外なので追わない）
      const window = predictWindow(ball, smashable, SMASH_HINT.LEAD_T, 0);
      return window && smashHintFrom(window, this.you, standX, standZ);
    }

    /**
     * @returns {'forehand'|'backhand'|'smash'|null} 圏内かつ自分が拾うべき球なら見込みの
     *   ストロークを返す。CPU/AI は、そのまま打てばスマッシュになる高い球（hit() と同じ条件）
     *   のときだけ「頭の後ろに担ぐ振りかぶり」の構えになる（人間の windUpSmash と同じ見せ方）。
     */
    computePrep(who, reach) {
      const ball = this.ball;
      if (!ball.live || TEAM_OF[who] === ball.last) return null;
      const player = this.actor(who);
      const onMySide = TEAM_OF[who] === 'you' ? ball.z < PLAYER.NET_MARGIN : ball.z > PLAYER.NET_MARGIN;
      if (!onMySide || !reaches(ball, player, reach)) return null;
      if (who !== 'you' && ball.y >= CPU.SMASH_MIN_Y && ball.vy <= CPU.SMASH_FALLING_VY
        && Math.abs(player.z) <= CPU.SMASH_Z_MAX) {
        return 'smash';
      }
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

      const cpuBefore = { x: this.cpu.x, z: this.cpu.z };

      // トス中（自分のサーブで、まだ打っていない間）は、打点がトスした位置からずれてしまう
      // ので入力があっても一切動かさない（＝ボールはプレイヤーの手元ではなく静止したトス
      // 位置から放たれる、という見た目のずれをなくす）。打った直後のフォロースルー中
      // （recoverTimers.you）も同様に、入力があっても動き出せない。
      if (!this.tossActive && this.recoverTimers.you <= 0) {
        const youBefore = { x: this.you.x, z: this.you.z };
        const mx = this.input.moveX * INPUT_X_TO_WORLD;
        const mz = this.input.moveZ;
        const len = Math.hypot(mx, mz) || 1; // 斜め移動が速くならないように正規化
        const bounds = this.youBounds();

        // 目標速度（入力なしなら0）へ、加速度で少しずつ近づける。
        // 急停止・瞬間方向転換にならないので、コート上で滑るような自然さが出る。
        const hasInput = mx !== 0 || mz !== 0;
        const maxSpeed = PLAYER.SPEED * this.staminaSpeedMult(this.you.stamina);
        const desiredVx = hasInput ? (mx / len) * maxSpeed : 0;
        const desiredVz = hasInput ? (mz / len) * maxSpeed : 0;
        const rate = (hasInput ? PLAYER.ACCEL : PLAYER.DECEL) * dt;
        const v = approach2D(this.you.vx, this.you.vz, desiredVx, desiredVz, rate);
        this.you.vx = v.x;
        this.you.vz = v.z;

        this.you.x = clamp(this.you.x + this.you.vx * dt, bounds.xMin, bounds.xMax);
        this.you.z = clamp(this.you.z + this.you.vz * dt, bounds.zMin, bounds.zMax);
        // 歩行/走行アニメーションが参照する実速度。壁際でクランプされた分は含めない
        // （実際に動いていないのに走って見えるのを防ぐ）。
        const moved = Math.hypot(this.you.x - youBefore.x, this.you.z - youBefore.z);
        this.you.speed = moved / dt;
        this.drainStamina(this.you, moved);
      } else {
        this.you.vx = 0;
        this.you.vz = 0;
        this.you.speed = 0;
      }

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
      this.recoverTimers.cpu = Math.max(0, this.recoverTimers.cpu - dt);
      this.recoverTimers.cpuMate = Math.max(0, this.recoverTimers.cpuMate - dt);
      this.recoverTimers.youMate = Math.max(0, this.recoverTimers.youMate - dt);
      this.recoverTimers.you = Math.max(0, this.recoverTimers.you - dt);

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
      // サーブ待ち中（phase==='serve'）は動かさない。newPoint() が置いたレシーブの構え位置
      // （サーブが狙う対角のボックス付近）から、サーブが打たれる前に homePosition()（センター）
      // へ歩いて戻ってしまうと、実際にサーブが来る頃には構えが崩れてしまう。
      if (this.phase === 'serve') {
        this.cpu.speed = 0;
        return;
      }
      const incoming = this.phase === 'rally' && this.ball.last === 'you';
      if (incoming && this.reactTimers.cpu > 0) {
        this.cpu.speed = 0; // まだ反応できていない
        return;
      }
      // ネットへ詰めている最中（cpuNetRush）は、通常の定位置(HOME_Z)へ戻る代わりに
      // ネット際へ向かう。この旗が立つのは2箇所：プレースタイル「サーブ&ボレーヤー」が
      // 自分のサーブを打った瞬間（serve()）と、アプローチショットを打った瞬間（hit()）。
      // どちらもこのポイントの間ずっと立ったままにする：以前 serveInFlight（＝サーブが
      // まだ返球されていない、コンマ数秒しかない間）で見ていた頃は、人間が返球した瞬間に
      // ネットへの接近そのものをやめてしまい、ベースライン付近からほとんど動けていなかった。
      // CPU_RECOVER（定位置へゆっくり戻る速度）ではなく CPU_CHASE（球を追う速い速度）を
      // 使い、実際に間に合う勢いで詰めさせる。
      const approachingNet = !incoming && this.cpuNetRush;
      // ネットへ詰めている最中は、向かってくる球もネット際で迎え撃つ（netRushPosition）。
      // 通常の追い方（chasePosition）はバウンド後の頂点＝自陣の深いところを追わせるため、
      // 相手が打った瞬間に引き返してしまい、せっかく前に出てもボレーにならない。
      // 迎え撃てない球（頭を越すロブ／間に合わない球）では null が返り、従来どおり下がる。
      const rushTarget = incoming && this.cpuNetRush
        ? netRushPosition(this.ball, 1, this.cpu)
        : null;
      const target = incoming
        ? rushTarget || chasePosition(this.ball, 1, this.cpu)
        : homePosition(approachingNet);
      const speed = incoming || approachingNet ? PLAYER.CPU_CHASE : PLAYER.CPU_RECOVER;
      this.moveIfRecovered('cpu', this.cpu, cpuBefore, target, speed, dt);
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

      // cpu チーム：you 側の打球が向かってくる番なら、cpu/cpuMate のうち応答すべき方が追う
      // （doublesResponder：サーブリターン中はレシーバー固定、それ以外は近い方）。
      // 反応遅延タイマーが残っている間は、担当側でも静止したまま（＝逆を突かれる余地）。
      const cpuTeamChasing = this.phase === 'rally' && ball.last === 'you';
      if (cpuTeamChasing && this.doublesResponder('cpu') === 'cpu') {
        if (this.reactTimers.cpu <= 0) {
          this.moveIfRecovered('cpu', this.cpu, cpuBefore, chasePosition(ball, 1, this.cpu), PLAYER.CPU_CHASE, dt);
        } else {
          this.cpu.speed = 0;
        }
        this.moveIfRecovered('cpuMate', this.cpuMate, cpuMateBefore, coverPosition(this.cpu.x, DOUBLES.NET_Z_CPU), PLAYER.CPU_RECOVER, dt);
      } else if (cpuTeamChasing) {
        if (this.reactTimers.cpuMate <= 0) {
          this.moveIfRecovered('cpuMate', this.cpuMate, cpuMateBefore, chasePosition(ball, 1, this.cpuMate), PLAYER.CPU_CHASE, dt);
        } else {
          this.cpuMate.speed = 0;
        }
        this.moveIfRecovered('cpu', this.cpu, cpuBefore, coverPosition(this.cpuMate.x, DOUBLES.NET_Z_CPU), PLAYER.CPU_RECOVER, dt);
      } else {
        this.moveIfRecovered('cpu', this.cpu, cpuBefore, homePosition(), PLAYER.CPU_RECOVER, dt);
        this.moveIfRecovered('cpuMate', this.cpuMate, cpuMateBefore, coverPosition(0, DOUBLES.NET_Z_CPU), PLAYER.CPU_RECOVER, dt);
      }

      // youMate：人間（you）の打球が向かってくる番で、自分が応答すべき側なら追う
      // （doublesResponder：サーブリターン中はレシーバー固定、それ以外は近い方）。
      // 自陣（z<0）を追わせるため chasePosition には side=-1 を渡す。
      const mateChasing = this.phase === 'rally' && ball.last === 'cpu'
        && this.doublesResponder('you') === 'youMate';
      if (mateChasing && this.reactTimers.youMate <= 0) {
        this.moveIfRecovered('youMate', this.youMate, youMateBefore, chasePosition(ball, -1, this.youMate), PLAYER.CPU_CHASE, dt);
      } else if (mateChasing) {
        this.youMate.speed = 0;
      } else {
        const youMateZ = this.youMateFormation === 'back' ? DOUBLES.BACK_Z_YOU : DOUBLES.NET_Z_YOU;
        this.moveIfRecovered('youMate', this.youMate, youMateBefore, coverPosition(this.you.x, youMateZ), PLAYER.CPU_RECOVER, dt);
      }
    }

    /**
     * cpu/cpuMate/youMate 用。打った直後の硬直中（recoverTimers）はまだ動けないので棒立ちにし、
     * そうでなければ通常どおり moveTowards で目標へ寄せる。
     */
    moveIfRecovered(recoverKey, actor, before, target, speed, dt) {
      if (this.recoverTimers[recoverKey] > 0) {
        actor.speed = 0;
        return;
      }
      this.moveTowards(actor, before, target, speed, dt);
    }

    /**
     * 新しい球が打たれた瞬間に、AI が「その球を追って走った距離」の積算を0に戻す。
     * hit()・serve()・newPoint() から呼ぶ。打った直後の定位置戻り（recover）も同じ
     * moveTowards() を通って積算されるが、次に相手が打った時点でここが0に戻すので、
     * 実際に stretch を読む hit() の時点では常に「この球を追った距離」だけが入っている。
     */
    resetChase() {
      this.cpu.chaseDist = 0;
      this.youMate.chaseDist = 0;
      this.cpuMate.chaseDist = 0;
    }

    /**
     * cpu/cpuMate/youMate 共通の移動：目標位置へ一定速度で寄せ、実速度も記録する（歩行アニメ用）。
     * x と z に別々に step を割り振ると斜めが √2 倍速くなってしまうので、人間の移動
     * （movePlayers() の `len = Math.hypot(mx, mz)` による正規化）と同じく、進む向きの
     * 長さで割ってから進める。これを直すまで CPU の斜め移動は 5.8→8.2m/s と設定値を
     * 超えており、実速度から求める stretch（＝ぎりぎり度）が斜めに動いた瞬間に必ず
     * 1（＝最弱の返球）へ振り切れていた。
     */
    moveTowards(actor, before, target, speed, dt) {
      const dx = target.x - actor.x;
      const dz = target.z - actor.z;
      const dist = Math.hypot(dx, dz);
      const cappedSpeed = speed * this.staminaSpeedMult(actor.stamina);
      const step = Math.min(cappedSpeed * dt, dist);
      if (dist > 0) {
        actor.x += (dx / dist) * step;
        actor.z += (dz / dist) * step;
      }
      const moved = Math.hypot(actor.x - before.x, actor.z - before.z);
      actor.speed = moved / dt;
      actor.chaseDist += moved;
      this.drainStamina(actor, moved);
    }

    stepBall(dt) {
      const ball = this.ball;

      if (this.tossActive) {
        integrate(ball, dt); // 重力だけで自然に上下させる（ラリーの当たり判定は通さない）
        if (ball.y <= SERVE.BALL_Y) {
          // 打たずに落ちてきた。トスをやり直せるようにリセットする（フォルトにはしない）
          this.tossActive = false;
          this.placeServeBall();
          this.hooks.call('サーブ', '←→ 左右のコース ／ ↑↓ 深さ ／ B/V/C 押しっぱなしで打つ');
        }
        return;
      }

      if (this.aiTossActive) {
        integrate(ball, dt); // tossActive と同じく重力だけで上下させる（見た目のみ）
        // 通常は serve() が TIMING.CPU_SERVE_DELAY 経過時に打って aiTossActive を落とすが、
        // 難易度設定などで間に合わなかった場合の保険として、人間のトスと同じく自然に
        // 落ちきったら手元へ戻す（フォルト扱いにはしない＝サーブは after() 側の予定通り来る）。
        if (ball.y <= SERVE.BALL_Y) {
          this.aiTossActive = false;
          this.placeServeBall();
        }
        return;
      }

      if (!ball.live) {
        if (this.phase === 'serve') this.placeServeBall();
        return;
      }

      integrate(ball, dt);
      ball.age += dt;

      if (hitsNet(ball)) {
        // サーブは対象外（実際のルールのレットと混同しないよう常にフォールトのまま。
        // config.js の NET のコメント参照）。ラリー中だけ、ごく低い確率でネットコードに
        // 救われてそのまま相手コートへ入り続ける＝ネットイン。
        if (!this.serveInFlight && Math.random() < NET.IN_CHANCE) {
          ball.vz *= NET.IN_VZ_MULT;
          ball.vx *= NET.IN_VX_MULT;
          ball.vy *= NET.IN_VY_MULT;
          this.hooks.sound('netIn');
          this.hooks.call('ネットイン！', '');
          this.after(TIMING.NET_IN_CALL, () => this.hooks.clearCall());
          return;
        }
        ball.vz *= NET.FAULT_VZ_MULT;
        ball.vx *= NET.FAULT_VX_MULT;
        ball.vy *= NET.FAULT_VY_MULT;
        if (this.serveInFlight) this.serveFault('ネット');
        else this.endPoint(opponent(ball.last), 'ネット');
        return;
      }

      if (ball.y <= BALL_R && ball.vy < 0 && this.bounce()) return;

      if (this.phase === 'rally') this.checkSwings();

      if (Math.abs(ball.z) > BOUNDS.Z || Math.abs(ball.x) > BOUNDS.X) {
        // bounces>=1 ＝ bounce() が1バウンド目をイン（サーブならサービスボックス内）と
        // 認めたということ。つまりこの球は「アウト」ではなく、インで弾んだ後レシーバーが
        // 返せず、2バウンド目より先にこの範囲まで転がり出ただけ。ベースライン際に落ちた
        // 深い球は反発(RESTITUTION)が残っているので、2バウンド目の前に軽く 10m 以上
        // 転がっていく＝この分岐は「計算破綻の保険」ではなく決定打の通常経路として頻繁に
        // 通る。ここを一律アウト扱いにしていたため、シングルスコートのど真ん中に落ちた
        // 球まで「アウト」とコールされ、しかも点が打った側ではなく返せなかった側に入って
        // いた（実測：1セットのアウトのコール190本中98本がこれ）。2バウンドで決まった
        // 場合と同じく、打った側の得点として扱う。
        if (ball.bounces >= 1) this.endPoint(ball.last, 'ツーバウンド');
        // まだ一度も弾んでいない＝本当にこの極端な範囲まで飛んでいったケース。通常の狙い
        // では届かない範囲なので計算が破綻したときの保険だが、バウンド判定と同様にサーブ中は
        // フォールト扱いにする（即失点にしてサーブのやり直しルールを迂回してしまわないように）。
        else if (this.serveInFlight) this.serveFault('アウト');
        else this.endPoint(opponent(ball.last), 'アウト');
      }
    }

    /** @returns {boolean} このバウンドでポイントが決まったか */
    bounce() {
      const ball = this.ball;
      // トップスピンは高く弾み、スライスは低く滑る（フラットは倍率1＝従来通り）。反発係数・
      // 摩擦の実装は physics.js の reflectBounce() に一本化してあり（predictBounceApex() も
      // 同じ実装を使う）、ここではその結果の座標を読むだけ。
      reflectBounce(ball);
      // 軌跡は通常 update() が1フレームに1点ずつ記録するだけなので、速い球ほど着地の瞬間を
      // 挟む2点の間隔が開き、IN/OUT判定に実際に使うこの着地座標（x,z）と、直線で結んだ軌跡が
      // 見せる「着地したように見える位置」がずれることがあった（＝軌跡ではINに見えるのに
      // 実際はOUT）。判定に使う座標そのものをここで明示的に1点追加しておくことで、
      // 軌跡が必ずこの座標を通るようにする。
      if (this.trail.length < TRAIL.MAX_POINTS) {
        this.trail.push({ x: ball.x, y: ball.y, z: ball.z });
      }
      ball.bounces++;
      this.hooks.sound('bounce');

      if (ball.bounces === 1) {
        // サーブがまだ一度も返されていない間の1バウンド目は、通常のラリーの着地判定
        // （コート全体）ではなく、サービスボックスに入ったかどうかで判定する。
        if (this.serveInFlight) {
          if (this.inServiceBox(ball)) return false;
          this.serveFault('アウト');
          return true;
        }
        const ownSide = (ball.last === 'you' && ball.z < 0) || (ball.last === 'cpu' && ball.z > 0);
        // ダブルスはコート幅がダブルスサイドラインまで広がる（サービスボックスの幅は変えない）
        const rallyHalfWidth = this.doubles ? COURT.DW / 2 : HALF_W;
        const inCourt = Math.abs(ball.x) <= rallyHalfWidth + COURT.LINE_SLACK
          && Math.abs(ball.z) <= HALF_L + COURT.LINE_SLACK;
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

    /**
     * このバウンド位置が、今のサーブが入るべきサービスボックス（ネット〜サービスライン、
     * センターサービスラインより狙った側）に収まっているか。ダブルスでもシングルスと
     * 同じ幅を使う（実際のルール通り、サービスボックスの幅はダブルスでも広がらない）。
     */
    inServiceBox(ball) {
      const { dir, targetSign } = serveAim(this.server, this.match.serveSide);
      const zOk = dir > 0
        ? ball.z > 0 && ball.z <= COURT.SERVICE + COURT.LINE_SLACK
        : ball.z < 0 && ball.z >= -(COURT.SERVICE + COURT.LINE_SLACK);
      const xOk = targetSign > 0
        ? ball.x >= -COURT.LINE_SLACK && ball.x <= HALF_W + COURT.LINE_SLACK
        : ball.x <= COURT.LINE_SLACK && ball.x >= -(HALF_W + COURT.LINE_SLACK);
      return zOk && xOk;
    }

    /**
     * サーブがフォールト（ネット／アウト）になったとき。1本目ならセカンドサーブとして
     * トスからやり直させ（失点にしない）、2本目（既にセカンドサーブだった）ならダブル
     * フォルトとして相手に得点を与える。
     * @param {string} reason 'ネット'|'アウト'
     */
    serveFault(reason) {
      if (this.serveNumber === 1) {
        this.serveNumber = 2;
        this.retryServe(reason);
      } else {
        this.endPoint(opponent(this.server), 'ダブルフォルト');
      }
    }

    checkSwings() {
      const ball = this.ball;
      // サーブはノーバウンドで返球できない（volleyしてはいけない）。1バウンドするまで待つ。
      const mustBounceFirst = this.serveInFlight && ball.bounces < 1;
      if (mustBounceFirst) return;

      // プレイヤーは溜めキーを押した瞬間の前後だけ打てる。人間が優先（AIパートナーに横取りさせない）
      if (ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN && this.you.swing > 0) {
        if (reaches(ball, this.you, PLAYER.REACH) && ball.y < PLAYER.REACH_Y) {
          this.hit('you');
          this.you.swing = 0;
        }
      }

      // ダブルスの youMate：人間が届かなかった／振らなかった球を、CPUと同様に自動で拾う。
      // ただし自分が応答すべき側（doublesResponder：サーブリターン中はレシーバー固定、それ
      // 以外は近い方）のときだけ。そうしないと、人間が取るべき球やレシーブの権利がない球まで
      // 先に振ってしまう。ノーバウンドで返す（ボレー）のはネット際（VOLLEY_Z 以内）にいるときだけ。
      // それより後ろにいるなら、前に詰めていない＝1バウンド待ってグラウンドストロークで返す。
      if (this.doubles && ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN
        && this.doublesResponder('you') === 'youMate') {
        const inRange = ball.y < PLAYER.CPU_REACH_Y && ball.y > PLAYER.CPU_REACH_Y_MIN;
        const canReturn = aiCanReturnNow(this.youMate, ball);
        if (canReturn && reaches(ball, this.youMate, reactReach(ball.age)) && inRange) this.hit('youMate');
      }

      // CPU は届く範囲なら自動で振る。ダブルスでは応答すべき側（doublesResponder）だけが
      // 手を出す。youMate と同様、前に出ていなければ1バウンド待つ。
      if (ball.last !== 'cpu' && ball.z > PLAYER.NET_MARGIN) {
        const inRange = ball.y < PLAYER.CPU_REACH_Y && ball.y > PLAYER.CPU_REACH_Y_MIN;
        const responder = this.doubles ? this.doublesResponder('cpu') : 'cpu';
        const cpuCanReturn = responder === 'cpu' && aiCanReturnNow(this.cpu, ball);
        const cpuMateCanReturn = this.doubles && responder === 'cpuMate'
          && aiCanReturnNow(this.cpuMate, ball);
        // 反応に使える時間ぶんに狭めた守備範囲で判定する（ai.reactReach 参照）。
        // 打たれてすぐ届く球（スマッシュ・至近距離のボレー）は体の近くしか触れない。
        const reach = reactReach(ball.age);
        if (cpuCanReturn && reaches(ball, this.cpu, reach) && inRange) {
          this.hit('cpu');
        } else if (cpuMateCanReturn && reaches(ball, this.cpuMate, reach) && inRange) {
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
