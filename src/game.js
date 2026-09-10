/**
 * ゲームのルールと状態。three.js にも DOM にも触らない。
 * 外へ伝えたいこと（音・コール・スコア更新）は hooks 経由で呼び出す。
 */
(function (RallyOne) {
  'use strict';

  const {
    ATTRS, BOUNDS, CHARGE, COURT, CPU, DOUBLES, DROP, FX, HALF_L, HALF_W, NET, PHYSICS, PLAYER,
    RETURN, SERVE, SHOT, SMASH_HINT, STAMINA, TIMING, TIMING_AIM, TRAIL, VOLLEY, WIND, shotSkill,
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

  /** 4人ぶんまとめて同じ処理をしたいとき用（スタミナの回復など） */
  const ACTORS = Object.keys(TEAM_OF);

  /**
   * 振り出しの早さ（スイングがボールを待った秒数）を -1〜+1 に直したもの。
   * +1＝早く振り出した＝引っ張り、0＝素直、-1＝引きつけて振った＝流し。
   */
  function swingTiming(waited) {
    const off = waited - TIMING_AIM.NEUTRAL_WAIT_T;
    return clamp(off / (off >= 0 ? TIMING_AIM.PULL_BAND_T : TIMING_AIM.FLOW_BAND_T), -1, 1);
  }

  /**
   * タイミングでずらした後の、着地点の左右(x)。
   * ←→ の狙い(baseX)から、ずれる側のコートの端(TIMING_AIM.EDGE_X)へ、タイミングの
   * 強さぶんだけ寄せる。フォアとバックでは体を横切る向きが逆なので、引っ張る方向も
   * 逆になる（pullDir）。ガイド表示（swingGuidePreview）も同じ式を通す＝ガイドと
   * 実際の打球が必ず一致する。
   *
   * 「一定の距離を足す」形にしないのは、それだと狙いより小さいずれ幅では絶対に反対側へ
   * 届かないため（config.js の EDGE_X のコメント参照）。端へ寄せる形なら、どんな狙いから
   * でも目一杯引きつければ必ず流し側へ、早く振れば必ず引っ張り側へ届く。
   * @param {number} baseX ←→ の狙い（タイミングを加える前の着地点の左右）
   * @param {number} timing swingTiming() の -1〜+1
   * @param {number} timingAttr 能力値「安定感」の倍率（高いほど＝1未満ほどずれにくい）
   */
  function aimWithTiming(baseX, stroke, timing, timingAttr) {
    const pullDir = (stroke === 'forehand' ? -1 : 1) * RACKET_SIDE.you;
    const edge = (timing >= 0 ? pullDir : -pullDir) * TIMING_AIM.EDGE_X;
    return lerp(baseX, edge, clamp(Math.abs(timing) * timingAttr, 0, 1));
  }

  /**
   * 狙いがサイドラインに近いほど大きくなる、着地点の左右のばらつき(±m)。
   * 「目一杯タイミングをずらして角度を作りにいくと、そのぶん狙いも荒れる」ぶんで、
   * ここが「やりすぎるとミスも起きる」の実体（config.js の RISK_SPREAD 参照）。
   * ←→ の狙い（最大2.7m）だけで打つぶんには 0＝素直に打てば絶対に外れない。
   * @param {number} x タイミングを反映した後の狙い
   * @param {number} timingAttr 能力値「安定感」の倍率（小さいほど散らない）
   */
  function aimRisk(x, timingAttr) {
    const over = (Math.abs(x) - TIMING_AIM.RISK_FROM_X)
      / (TIMING_AIM.EDGE_X - TIMING_AIM.RISK_FROM_X);
    return TIMING_AIM.RISK_SPREAD * clamp(over, 0, 1) * timingAttr;
  }

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
    // 走る速さは能力値「移動速度」で変わるので、ヒントの「間に合うか」も同じ速さで見積もる。
    const needT = Math.hypot(x - you.x, z - you.z) / (PLAYER.SPEED * you.attr.speed)
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
   * 呼び名ひとつに畳む。スマッシュ・ボレー・ロブは打ち方そのものが球種なのでスピンより
   * 優先し（実際これらは常にフラット固定）、グラウンドストロークとサーブはスピンで呼び分ける。
   * サーブはさらに狙ったコース（センター／ボディ／ワイド／角度）も添える：エースで決まった
   * ときに「何が良かったのか」が球種だけでは伝わらないため（以前は一律「サービス」だった）。
   * @param {'forehand'|'backhand'|'smash'|'serve'|'volley-forehand'|'volley-backhand'} stroke
   * @param {'flat'|'top'|'slice'|'drop'} spin
   * @param {boolean} [lob]
   * @param {string} [course] サーブのときだけ渡すコース名（serveCourse()）
   */
  const SPIN_LABELS = {
    top: 'スピンショット',
    slice: 'スライスショット',
    drop: 'ドロップショット',
    flat: 'フラットショット',
  };

  /** サーブのスピン別の呼び名。ドロップはサーブでは選べないので持たない。 */
  const SERVE_SPIN_LABELS = {
    top: 'スピンサービス',
    slice: 'スライスサービス',
    flat: 'フラットサービス',
  };

  /**
   * 狙った横位置（センターラインからの距離）を、コースの呼び名に畳む。
   * 区切りは SERVE.AIM_*_MAX と同じ＝実際に打ち分けている4コースの境界そのもの。
   * @param {number} magnitude serveAimMagnitude()／cpuServeAimMagnitude() が返す値(m)
   */
  function serveCourse(magnitude) {
    if (magnitude <= SERVE.AIM_T_MAX) return 'センター';
    if (magnitude <= SERVE.AIM_BODY_MAX) return 'ボディ';
    if (magnitude <= SERVE.AIM_WIDE_MAX) return 'ワイド';
    return '角度';
  }

  function shotLabel(stroke, spin, lob, course) {
    if (stroke === 'smash') return 'スマッシュ';
    if (stroke === 'serve') {
      const name = SERVE_SPIN_LABELS[spin] || SERVE_SPIN_LABELS.flat;
      return course ? `${name}（${course}）` : name;
    }
    if (typeof stroke === 'string' && stroke.startsWith('volley-')) return 'ボレー';
    if (lob) return 'ロブ';
    return SPIN_LABELS[spin] || SPIN_LABELS.flat;
  }

  /**
   * スタッツの入れ物（1チームぶん×2）。数え方はすべて「打った側／取った側」の視点で、
   * 表示（hud.js）はここの数字を並べるだけにする。
   * - points        取ったポイント数
   * - winners       自分の決め球で取ったポイント（サーブのエースは aces に数えるので含めない）
   * - unforced      自分のミス（ネット／アウト／届かず／ダブルフォルト）で落としたポイント
   * - firstServes   打った1本目のサーブの数／firstServeIn はそのうちサービスボックスに入った数
   * - maxServeKmh   そのマッチでいちばん速かったサーブの初速
   */
  function teamStats() {
    const blank = () => ({
      aces: 0, doubleFaults: 0, points: 0, winners: 0, unforced: 0,
      firstServes: 0, firstServeIn: 0, maxServeKmh: 0,
    });
    return { you: blank(), cpu: blank() };
  }

  /** phase: idle → serve → rally → over → (serve …) */
  class Game {
    /**
     * @param {object} deps
     * @param {object} deps.input RallyOne.Input
     * @param {{sound:Function, call:Function, clearCall:Function, score:Function,
     *   wind:Function, serveSpeed:Function, matchEnd:Function}} deps.hooks
     *   matchEnd は「1セットが終わって、その振り返り（スタッツ）を出す番」になったときに
     *   matchSummary() の結果を渡して1回だけ呼ばれる（表示側が画面を出す）。
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
        // 今テイクバック中／振っている最中の球種。打つフォーム（scene/player.js の
        // SWING.SPIN_FORM）を切り替えるためだけの表示用の値で、判定には一切使わない。
        spin: 'flat',
        charging: false, chargeTime: 0, swingCharge: 0, // 溜めキー押しっぱなしのテイクバック
        serveMiss: false, // このサーブは「溜めすぎ」の抽選に当たった＝狙いを外す（chargeRelease()で抽選）
        chargeFrac: 0, // 溜めている間だけ 0〜1 で増える、テイクバックの深さ用（chargeTime のポーズ表示版）
        chargeStroke: null, // chargeStart() の瞬間に固定するフォア/バック。溜めている間は変えない
        chargeSpin: 'flat', // chargeStart() の瞬間に固定するスピン（B/V/C）。実際に当たるまで押し続けなくてよい
        stamina: 1, // 0〜1。長いラリーで走るほど減り、ポイント間で少し回復する（newPoint()参照）
        // スタート画面の「選手設定」で決まる能力倍率（config.ATTRS）。オブジェクトの中身が
        // 書き換えられる形で更新されるので、ここで参照を1度持っておけば以後ずっと最新を指す。
        // 既定（全項目3）ならすべて 1.0＝設定を触らない限り従来と完全に同じ挙動になる。
        attr: ATTRS.you,
      };
      // chaseDist＝この球を追って走った距離、settleT＝目標地点に着いてから動かずに
      // 待っている秒数（どちらも moveTowards() が更新する。hit() の「余裕」判定に使う）。
      this.cpu = {
        x: 0, z: CPU.HOME_Z, anim: 0, speed: 0, chaseDist: 0, settleT: 0, stroke: 'forehand', prep: null, spin: 'flat', stamina: 1,
        attr: ATTRS.cpu,
      };
      // ダブルス（this.doubles === true）のときだけ動く AI パートナー。シングルスでは未使用のまま。
      this.youMate = {
        x: 0, z: DOUBLES.NET_Z_YOU, anim: 0, speed: 0, chaseDist: 0, settleT: 0, stroke: 'forehand', prep: null, spin: 'flat', stamina: 1,
        attr: ATTRS.youMate,
      };
      this.cpuMate = {
        x: 0, z: DOUBLES.NET_Z_CPU, anim: 0, speed: 0, chaseDist: 0, settleT: 0, stroke: 'forehand', prep: null, spin: 'flat', stamina: 1,
        attr: ATTRS.cpuMate,
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
      /**
       * ガイド付きモード（スタート画面で選ぶ）。true の間、溜めている最中ずっと
       * 「いま離したらどこへ飛ぶか」を swingGuide に入れ続ける。表示専用。
       */
      this.guide = false;
      /**
       * ガイド付きモードの表示内容。毎フレーム swingGuidePreview() が入れ直す
       * （ガイドを出す場面でなければ null）。smashHint と同じく表示専用の値で、
       * ゲームの判定はここを一切読まない（scene/hint.js と hud.js だけが使う）。
       */
      this.swingGuide = null;
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
      /**
       * チームごとの通算スタッツ。マッチ（1セット）を通して積算し、セットが終わって
       * 次のマッチが始まるとき（resetStats()）だけ0に戻す。エース／ダブルフォルトは
       * 試合中もスコアボードに出し、残りは試合後のスタッツ画面（matchSummary()）で使う。
       */
      this.stats = teamStats();
      /**
       * チームで分けられない、マッチ全体の集計（スタッツ画面のラリーの行に使う）。
       * totalShots はポイントが決まった時点の rallyShots の合計＝サーブも1本に数える。
       */
      this.matchStats = { points: 0, longestRally: 0, totalShots: 0 };

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
      // ゲージの線を超えて溜めたぶんだけ、この1本を外す抽選をここで引く（超えていなければ
      // 確率0＝必ず外れない）。実際にどう外れるかは serve() が決める。
      if (myServe) this.you.serveMiss = Math.random() < this.serveFaultChance(this.you.chargeTime);

      if (myServe && this.tossActive) {
        this.serve('you');
      } else if (this.phase === 'rally') {
        this.you.swing = PLAYER.SWING_WINDOW;
      }
    }

    /**
     * サーブの威力(0〜1)。ゲージの線（＝SERVE.CHARGE_SWEET_T まで溜めた地点。ゲージの
     * 9割の位置に出る）までは溜めるほど強くなり、線に届いたところで最大になる。
     * 線を超えて溜めても威力はもう増えず、代わりに serveFaultChance() が上がっていく。
     * @param {number} heldTime 溜めキーを押してから離すまでの実経過時間(秒)
     */
    serveTimingPower(heldTime) {
      return clamp(heldTime / SERVE.CHARGE_SWEET_T, 0, 1);
    }

    /**
     * ゲージの線を超えて溜めたときに、そのサーブがフォールトになる確率(0〜1)。
     * 線の直後は SERVE.CHARGE_SWEET_HOLD の間だけ猶予があり（60fps で線ちょうどに
     * 合わせるのは1〜2フレームの勝負なので、わずかな行き過ぎは見逃す）、そこから
     * SERVE.CHARGE_FAULT_T かけて100%まで上がる。
     * 能力値「サーブ」が高いほど猶予と ramp の両方が広い＝超えても粘れる（attr.serveWindow）。
     * @param {number} heldTime 溜めキーを押してから離すまでの実経過時間(秒)
     */
    serveFaultChance(heldTime) {
      const tolerance = this.you.attr.serveWindow;
      const over = heldTime - (SERVE.CHARGE_SWEET_T + SERVE.CHARGE_SWEET_HOLD * tolerance);
      if (over <= 0) return 0;
      return clamp(over / (SERVE.CHARGE_FAULT_T * tolerance), 0, 1);
    }

    /**
     * HUD のゲージ表示用。溜まり具合を 0〜1 で返す。溜めていなければ0。
     * サーブは「ゲージが満タンになるまでの保持時間」に対する割合（線は
     * SERVE.CHARGE_SWEET_MARK の位置＝9割に出る。満タンまでの時間はそこから逆算する）。
     * ラリーは従来どおり溜め時間の割合。
     */
    chargeMeter() {
      if (!this.you.charging) return 0;
      if (this.isServeCharging()) {
        const fullT = SERVE.CHARGE_SWEET_T / SERVE.CHARGE_SWEET_MARK;
        return clamp(this.you.chargeTime / fullT, 0, 1);
      }
      return clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);
    }

    /** 今この瞬間、自分のサーブを溜めている最中か（HUD がゲージの線を出すかの判定に使う）。 */
    isServeCharging() {
      return this.you.charging && this.phase === 'serve' && this.servingPlayer() === 'you';
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

    /**
     * 実際に走った距離ぶん、その選手のスタミナを減らす（0未満にはしない）。
     * 能力値「体力」が高い選手ほど同じ距離での消費が少ない（attr.drain）。
     */
    drainStamina(actor, moved) {
      actor.stamina = Math.max(0, actor.stamina - moved * STAMINA.DRAIN_PER_M * actor.attr.drain);
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
      // 回復量にも能力値「体力」が掛かる（attr.recover）。
      const recover = this.staminaRecoverAmount(this.match.games.you + this.match.games.cpu);
      ACTORS.forEach((who) => {
        const actor = this.actor(who);
        actor.stamina = Math.min(1, actor.stamina + recover * actor.attr.recover);
      });
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
      this.you.serveMiss = false; // 前のサーブの「溜めすぎ」の抽選結果も持ち越さない

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
          faultReason ? `${faultReason} — もう一度` : '←→ コース ／ ↑↓ 深さ ／ B/V/C 押しっぱなし → ゲージの線で離す',
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
      this.hooks.call('トス', 'ゲージの線まで溜めて離す（超えるとフォールト）');
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
        z: dir * (COURT.SERVICE - (who === 'you' ? this.serveDepth() : rand(SERVE.DEPTH_MIN, SERVE.DEPTH_AI_MAX))),
      };
      // ゲージの線を超えて溜めた（chargeRelease() の抽選に当たった）1本は、狙いそのものを
      // サービスボックスの外へずらして外す。「フォールト」の判定は普段どおり着地で決まる
      // （bounce()→inServiceBox()）ので、ロング／サイドアウトがそのまま画面に出る。
      const overcharged = who === 'you' && this.you.serveMiss;
      let clearance = SERVE.CLEARANCE;
      if (overcharged) {
        if (Math.random() < SERVE.FAULT_LONG_CHANCE) {
          target.z = dir * (COURT.SERVICE + rand(SERVE.FAULT_LONG_MIN, SERVE.FAULT_LONG_MAX));
        } else {
          target.x = targetSign * (HALF_W + rand(SERVE.FAULT_WIDE_MIN, SERVE.FAULT_WIDE_MAX));
        }
      } else if (Math.random() < SERVE.NET_CHANCE * (who === 'you' ? this.you.swingCharge : 1)) {
        // 強いサーブほどネットに掛かる（確率は威力に比例。CPU/AI は常に全力扱い）。
        // 深い狙いのままでは幾何的に白帯へ届かないので、「ネットのすぐ向こうを狙って
        // しまったミスヒット」として実現する（理由は config の NET_MISS_Z_MIN 参照）。
        target.z = dir * rand(SERVE.NET_MISS_Z_MIN, SERVE.NET_MISS_Z_MAX);
        clearance = SERVE.NET_MISS_CLEARANCE; // ネット回避で持ち上げさせない
      }
      // 人はトスを上げた瞬間に固定したスピン（V/C。chargeStart() 参照）でスライスサーブ・
      // スピンサーブが打てる。CPU/AI も同じ SPIN 設定（実効重力・バウンドの弾み方）で
      // 一定確率でスピンサーブを混ぜる（aiSpin()。以前は常にフラット固定だった）。
      const spin = who === 'you' ? this.you.chargeSpin : aiSpin();
      // プレイヤーは「打つ」瞬間の溜め量で威力が変わる。CPU/AI（cpu・cpuMate・youMate）は
      // 溜め演出がない代わりに、難易度で決まる一定の威力（CPU.SERVE_T）で打つ。
      // どちらにも能力値「サーブ」の倍率が掛かる（attr.serve。小さいほど速い＝強い）。
      // 飛翔時間は狙う距離で比例配分する（SERVE.DIST_REF）。以前は距離に関係なく時間が
      // 固定だったので、球速＝距離÷時間が狙いの深さで2倍以上ばらつき、「線ぴったりで
      // 離したのに 82km/h」という当たりが1割ほど混ざっていた（ユーザー報告）。
      // 正規化してあるので、威力（ゲージ）がそのまま球速に対応する。
      // 球種の倍率（SPIN_T_MULT）は最後に掛ける：擦って回転をかけるスライス／トップスピンは
      // フラットより球速が落ちる。
      const dist = Math.hypot(target.x - from.x, target.z - from.z);
      const flightT = (who === 'you'
        ? lerp(SERVE.T, SERVE.CHARGE_T, this.you.swingCharge)
        : CPU.SERVE_T) * (dist / SERVE.DIST_REF) * this.actor(who).attr.serve
        * SERVE.SPIN_T_MULT[spin];

      ball.y = from.y;
      Object.assign(ball, solveShot(from, target, flightT, clearance, spin));
      ball.spin = spin;
      // 打った瞬間の初速をそのままスコアボード脇に出す（次のポイントが始まるまで残す）
      const serveKmh = mpsToKmh(Math.hypot(ball.vx, ball.vy, ball.vz));
      this.hooks.serveSpeed(serveKmh);
      // スタッツ用。1本目の本数はここで数え、「入った本数」は bounce() が数える
      // （入るか入らないかは着地するまで決まらないため）。
      this.stats[team].maxServeKmh = Math.max(this.stats[team].maxServeKmh, serveKmh);
      if (this.serveNumber === 1) this.stats[team].firstServes++;
      ball.live = true;
      ball.bounces = 0;
      ball.age = 0;
      ball.last = team; // スコア判定・当たり判定はチーム単位（hit() と同じ扱い）
      this.lastShotBy[team] = shotLabel('serve', spin, false, serveCourse(magnitude));
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
      this.hooks.sound('serve', serveCharge, spin); // 球種で音色が変わる（audio.js#sfx.serve）
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
      // 無入力のときは、強く打つほど浅い狙いを引かないようにする（DEPTH_MAX→DEPTH_FULL_MAX)。
      // 浅いところへ速い球を通す軌道は幾何的に存在せず、引いてしまうと溜めが完璧でも
      // 山なりの遅い球になる（理由は config の DEPTH_FULL_MAX のコメント参照）。
      // それより浅く落としたいときは ↓ で明示的に選ぶ＝遅くなるのを承知のコースになる。
      const shallowest = lerp(SERVE.DEPTH_MAX, SERVE.DEPTH_FULL_MAX, this.you.swingCharge);
      return rand(SERVE.DEPTH_MIN, shallowest);
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
      // スマッシュだけは走行距離では「苦しさ」を測れない。ai.smashApproach() は高く
      // 上がった球に対して落下点へ先回りし、そこで待ってから叩く動きをするので、
      // 走った距離は長い（＝stretch は最大）のに打つ瞬間は棒立ちで余裕たっぷり、という
      // 組み合わせが普通に起きる。これが「ダブルスの味方が、十分間に合っているのに
      // 弱いスマッシュしか打てない」の正体だったので、落下点で待てていた時間
      // （settleT）のぶんだけ苦しさを打ち消す（SMASH_SETTLE_T 秒待てていれば余裕＝0）。
      const smashStretch = stretch
        * (1 - clamp(player.settleT / CPU.SMASH_SETTLE_T, 0, 1));
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
      // 打ち方に対応する能力（フォア／バック／ボレー／スマッシュ）と安定感を、倍率だけの
      // 小さなオブジェクトに畳んで渡す（ai.js は「誰が打つか」を知らないままでいられる）。
      const shot = who === 'you'
        ? this.playerShot(stroke, this.swingWaited())
        : isSmash
          ? cpuSmashShot(aimAt, aimDir, smashStretch, shotSkill(player.attr, 'smash'))
          : isVolley
            ? cpuVolleyShot(aimAt, aimDir, stretch, ball.y, shotSkill(player.attr, 'volley'))
            : cpuShot(aimAt, aimDir, stretch, lobScale, arcScale, shotSkill(player.attr, baseStroke));

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
          && Math.random() < CPU.APPROACH_CHANCE * this.cpu.attr.net) {
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
      player.spin = spin; // 振っている間のフォーム（scene/player.js）に使う
      this.lastShotBy[TEAM_OF[who]] = shotLabel(stroke, spin, shot.lob);
      // 音程はチーム単位（誰が打っても同じ）。音色は打ち方(stroke)とスピンで変わる。
      this.hooks.sound('hit', TEAM_OF[who], stroke, charge, spin);
    }

    /**
     * 今の1打で「スイングがボールを待った時間」(秒)。溜めキーを離してから実際に当たるまで
     * 何秒かかったか＝どれだけ早めに振り出したか、で、引っ張り／流しの打ち分けに使う
     * （TIMING_AIM 参照）。this.you.swing は離した瞬間に SWING_WINDOW から減り始めるので、
     * その残りから逆算できる。
     * スイングを介さずに hit('you') を直接呼んだ場合（テストなど）は、狙いがずれない
     * 「素直なタイミング」を返す。
     */
    swingWaited() {
      return this.you.swing > 0
        ? PLAYER.SWING_WINDOW - this.you.swing
        : TIMING_AIM.NEUTRAL_WAIT_T;
    }

    /**
     * ガイド付きモードの入/切（スタート画面から。試合中に切り替えても壊れない）。
     * @param {boolean} on
     */
    setGuide(on) {
      this.guide = !!on;
      if (!this.guide) this.swingGuide = null;
    }

    /**
     * いま溜めキーを離したとして、どこで・いつボールを捉えるか。checkSwings() が実際に
     * 当たりを取るのと同じ条件を、予測した軌道の上で探す。走って追いついている最中でも
     * 「今の立ち位置のまま待った場合」で見積もる（表示用の目安なので、実際に動きながら
     * 打てば多少ずれる）。
     * @returns {{t:number, x:number, y:number, z:number, bounces:number}|null}
     *   すでに届く位置なら t=0。スイングの有効時間内に届かないなら null（＝いま離すと空振り）。
     */
    predictContact() {
      const ball = this.ball;
      const you = this.you;
      const reach = PLAYER.REACH * you.attr.reach;
      // サーブは1バウンドするまで打てない（checkSwings() の mustBounceFirst と同じ条件）
      const canHit = (at, bounces) => at.z < PLAYER.NET_MARGIN && at.y < PLAYER.REACH_Y
        && !(this.serveInFlight && bounces < 1)
        && Math.hypot(at.x - you.x, at.z - you.z) < reach;
      if (canHit(ball, ball.bounces)) {
        return {
          t: 0, x: ball.x, y: ball.y, z: ball.z, bounces: ball.bounces,
        };
      }
      const window = predictWindow(ball, (at) => canHit(at, at.bounces), PLAYER.SWING_WINDOW, 1);
      return window ? window.enter : null;
    }

    /**
     * ガイド用：その打点で振ったら、どの打ち方になるか（hit() の判定と同じ条件）。
     * スマッシュ・ボレー・ドロップショットは打点タイミングでコースが変わらない打ち方なので、
     * ガイドでもそう見せる必要がある（グラウンドストロークのつもりで方向を出すと嘘になる）。
     * @param {{y:number, bounces:number}|null} contact predictContact() の結果
     * @param {number} charge いまの溜め量(0〜1)
     */
    previewStroke(contact, charge) {
      const at = contact || this.ball;
      const base = this.you.chargeStroke || classifyStroke('you', this.ball, this.you);
      if (at.y >= PLAYER.SMASH_MIN_Y && charge >= PLAYER.SMASH_MIN_CHARGE) return 'smash';
      if (at.bounces === 0 && this.you.z > -COURT.SERVICE) return `volley-${base}`;
      return base;
    }

    /**
     * ガイド付きモードの表示内容。「いまキーを離したら、どのタイミング（引っ張り／素直／
     * 流し）で当たって、どこへ飛ぶか」。着地点は実際に打つときと同じ式（aimWithTiming）を
     * 通すので、ガイドと実際の打球は必ず一致する（深さのばらつき SHOT.DRIVE_Z_SPREAD の
     * ぶんだけ前後する）。
     * @returns {{timing:number, x:number, z:number, waited:number, tooEarly:boolean}|null}
     */
    swingGuidePreview() {
      if (!this.guide || this.phase !== 'rally' || !this.you.charging) return null;
      const ball = this.ball;
      if (!ball.live || ball.last === 'you') return null;

      const contact = this.predictContact();
      // まだボールが遠い＝いま離しても当たらない。「早すぎる」ことだけ伝える（コースは、
      // 一番早く当たったときと同じ＝引っ張り最大の向きを出しておく）。
      const tooEarly = contact === null;
      const waited = tooEarly ? PLAYER.SWING_WINDOW : contact.t;
      const charge = clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);
      const stroke = this.previewStroke(contact, charge);
      // 実際に打つときと同じ関数を通す（preview=true でばらつきだけ中央値に固定）ので、
      // ここに出る着地点は「いま離したら本当に飛ぶ場所」そのものになる。
      const shot = this.playerShot(stroke, waited, true);
      return {
        timing: swingTiming(waited),
        tooEarly,
        waited,
        stroke,
        // 打点タイミングでコースが変わるのはグラウンドストロークだけ。ロブ・ドロップ
        // ショット・ボレー・スマッシュは、引きつけても早振りしても同じところへ飛ぶ。
        timingMatters: (stroke === 'forehand' || stroke === 'backhand')
          && !shot.lob && shot.spin !== 'drop',
        // 0 より大きければ「ライン際を狙っていて、この幅で散る＝外れることもある」
        risk: shot.risk || 0,
        x: shot.target.x,
        z: shot.target.z,
      };
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
     * 振り出すタイミングでもコースがずれる：ボールが来るより早く振り出すほど（waited が
     * 長いほど）体の前で捉えた形＝「引っ張り」、引きつけて振るほど「流れる」。フォアと
     * バックでは体を横切る向きが逆なので、引っ張る方向も逆になる（pullDir で吸収する）。
     * ロブは対象外。
     * スマッシュはフォア/バックの区別も打点タイミングのずれもなく、←→ でだけ狙う。
     * ボレー（'volley-forehand'|'volley-backhand'）も溜めの影響は受けず、代わりに
     * ボールとプレイヤーの左右距離（サービスラインより前で拾った場合のみ）で威力・角度が決まる。
     * @param {'forehand'|'backhand'|'smash'|'volley-forehand'|'volley-backhand'} [stroke]
     * @param {number} [waited] スイングがボールを待った時間(秒)。swingWaited() 参照
     * @param {boolean} [preview] true なら狙いのばらつき（深さの散らし）を中央値に固定する。
     *   ガイド表示（swingGuidePreview）が「実際に打ったらどこへ飛ぶか」を毎フレーム
     *   同じ値で出すために使う（乱数のままだと目印が毎フレーム跳ねる）。
     */
    playerShot(stroke = 'forehand', waited = TIMING_AIM.NEUTRAL_WAIT_T, preview = false) {
      /** 狙いのばらつき。プレビューでは中央値に固定する。 */
      const spread = preview ? (a, b) => (a + b) / 2 : rand;
      const lob = this.input.lob;
      const aim = this.input.moveX * INPUT_X_TO_WORLD;
      const charge = this.you.swingCharge;
      const baseX = aim !== 0 ? aim * SHOT.AIM_X : -signOr(this.you.x, 1) * SHOT.DEFAULT_X;

      // 能力値の倍率。打ち方ごとに対応する項目（スマッシュ／ボレー／フォア／バック）が
      // 飛翔時間に掛かる（小さいほど速い球）。既定（3）なら 1.0＝従来と完全に同じ。
      const attr = this.you.attr;

      if (stroke === 'smash') {
        return {
          target: { x: baseX, y: BALL_R, z: spread(SHOT.SMASH_Z, SHOT.SMASH_Z + SHOT.DRIVE_Z_SPREAD) },
          flight: SHOT.SMASH_T * attr.smash,
        };
      }

      if (stroke === 'volley-forehand' || stroke === 'volley-backhand') {
        // 真正面（距離0）や伸びきり（距離が離れすぎ）は普通のブロック、フォア/バック側に
        // 程よく離れているときだけ鋭く角度をつけた決め球になる（左右どちら側でも対称）。
        // 能力値「ボレー」が高いほど「程よい距離」の許容幅(WINDOW)が広い＝鋭い決め球に
        // しやすい。飛翔時間そのものにも同じ能力の倍率が掛かる。
        const sideDist = Math.abs(this.ball.x - this.you.x);
        const window = VOLLEY.WINDOW * attr.volleySharp;
        const sharpness = clamp(1 - Math.abs(sideDist - VOLLEY.SWEET_DIST) / window, 0, 1);
        const dir = aim !== 0 ? Math.sign(aim) : -signOr(this.you.x, 1);
        return {
          target: {
            x: dir * lerp(VOLLEY.BLOCK_X, VOLLEY.ANGLE_X, sharpness),
            y: BALL_R,
            z: lerp(VOLLEY.BLOCK_Z, VOLLEY.ANGLE_Z, sharpness) + spread(0, SHOT.DRIVE_Z_SPREAD),
          },
          flight: lerp(VOLLEY.BLOCK_T, VOLLEY.ANGLE_T, sharpness) * attr.volley,
        };
      }

      // 弱いスライス（Cで溜めずに離す）はドロップショット。深さを溜めで選ぶ通常の
      // グラウンドストロークとは別枠にして、狙いをネット際へ完全に移す。
      // スピンは chargeStart() の瞬間に固定した値をそのまま使う（hit() が ball.spin に
      // 入れるのと同じ値なので、弾道の計算と実際の飛翔がずれない）。
      if (!lob && this.you.chargeSpin === 'slice' && charge <= DROP.MAX_CHARGE) {
        const dir = aim !== 0 ? Math.sign(aim) : -signOr(this.you.x, 1);
        return {
          target: {
            x: dir * spread(DROP.X_MIN, DROP.X_MAX), y: BALL_R, z: spread(DROP.Z_MIN, DROP.Z_MAX),
          },
          flight: DROP.T * attr[stroke === 'backhand' ? 'backhand' : 'forehand'],
          clearance: DROP.CLEARANCE,
          spin: 'drop',
        };
      }

      // ロブは威力ではなくタッチの球なので能力の倍率は掛けない（CPU/AI 側の cpuShot() と同じ扱い）。
      const strokeAttr = attr[stroke === 'backhand' ? 'backhand' : 'forehand'];
      const flight = lob ? SHOT.LOB_T : lerp(SHOT.TAP_T, SHOT.CHARGE_T, charge) * strokeAttr;
      // 溜めるほど深く。速さと深さの両方が変わるので「強い球を打った」感が出る。
      const depth = lerp(SHOT.TAP_Z, SHOT.CHARGE_Z, charge);

      // 能力値「安定感」が高いほど、タイミングがずれてもコースが曲がりにくい（attr.timing）。
      const aimed = lob
        ? baseX
        : aimWithTiming(baseX, stroke, swingTiming(waited), attr.timing);
      // ライン際まで狙いを振ったぶんだけ、狙い自体が荒れる（やりすぎるとアウトになる）。
      const risk = lob ? 0 : aimRisk(aimed, attr.timing);

      return {
        target: {
          x: aimed + spread(-risk, risk),
          y: BALL_R,
          z: lob ? SHOT.LOB_Z : spread(depth, depth + SHOT.DRIVE_Z_SPREAD),
        },
        flight,
        lob,
        // ガイド表示用（この狙いがどれだけ荒れるか）。実際の打球には上で反映済み。
        risk,
      };
    }

    /** 次のマッチのためにスタッツを0へ戻す（スタッツ画面を出し終えた後に呼ぶ）。 */
    resetStats() {
      this.stats = teamStats();
      this.matchStats = { points: 0, longestRally: 0, totalShots: 0 };
    }

    /**
     * 試合後のスタッツ画面に渡す数字ひとまとめ（純粋な集計。表示の文言・並べ方は hud.js）。
     * 割合の分子・分母はそのまま渡す（「1stサーブ 62%」のような丸めは表示側の仕事）。
     * @param {'you'|'cpu'} winner セットを取った側
     */
    matchSummary(winner) {
      const { points, totalShots, longestRally } = this.matchStats;
      return {
        winner,
        doubles: this.doubles,
        games: { you: this.match.games.you, cpu: this.match.games.cpu },
        points,
        longestRally,
        // 1ポイントあたりの平均本数（サーブを1本目に数える）。0ポイントで割らない。
        avgRally: points ? totalShots / points : 0,
        you: { ...this.stats.you },
        cpu: { ...this.stats.cpu },
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

      // 試合後のスタッツ画面（matchSummary()）のための集計。決まり方（outcome）はもう
      // 出してあるので、それをそのまま「決め球で取った(winners)」「相手のミスで取った
      // (相手の unforced)」に振り分ける。エース／ダブルフォルトは専用の欄に数えるので
      // ここでは二重に数えない。
      this.stats[winner].points++;
      if (outcome === 'winner') this.stats[winner].winners++;
      else if (outcome === 'error') this.stats[opponent(winner)].unforced++;
      this.matchStats.points++;
      this.matchStats.totalShots += this.rallyShots;
      this.matchStats.longestRally = Math.max(this.matchStats.longestRally, this.rallyShots);

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
        // 「ゲームセット」のコール（と最後のポイントのリプレイ）を見せてから、一拍おいて
        // 振り返りのスタッツを出す。ここは setTimeout ではなく Game#after のタイマーなので
        // update() が止まっている間（＝リプレイ再生中）は進まない＝リプレイが終わってから
        // 数え始める。画面を出すのは表示側（main.js が hooks.matchEnd で受ける）。
        this.after(TIMING.MATCH_STATS, () => this.hooks.matchEnd(this.matchSummary(winner)));
        this.after(TIMING.NEXT_MATCH, () => {
          this.match.reset();
          this.resetStats(); // 次のマッチは0から数え直す（スタッツ画面はもう出した後）
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
        const step = Math.min(remaining, STEP);
        // スイングの有効時間も物理と同じ刻みで減らす。当たり判定（checkSwings）は
        // このループの中＝1/240秒刻みで見ているのに、ここを1フレーム（1/60秒）ぶん
        // まとめて引いていたため、「振ってから当たるまでの待ち時間」(swingWaited) が
        // 1/60秒刻みでしか測れず、引っ張り／流しの度合いが段階的に跳んでいた
        // （実測：離す距離を2cm刻みで変えても7段階しか出ず、流し側は2段階しかなかった）。
        this.you.swing = Math.max(0, this.you.swing - step);
        this.stepBall(step);
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
      this.swingGuide = this.swingGuidePreview();
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
      // 打つフォーム（scene/player.js の SWING.SPIN_FORM）に渡す球種。テイクバック中は
      // 押しているキー（chargeSpin）の球種、振っている最中は hit() が入れた実際の球種を
      // そのまま保ち、そのどちらでもない（構えているだけ）なら平常のフラットに戻す。
      // AI は溜めのキー入力がないので、打った球種が振り終わるまで残るだけになる。
      ACTORS.forEach((who) => {
        const actor = this.actor(who);
        if (actor.anim <= 0 && !actor.charging) actor.spin = 'flat';
      });
      if (this.you.charging) this.you.spin = this.you.chargeSpin;
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
        && Math.hypot(at.x - standX(at.x), at.z - standZ(at.z)) < PLAYER.REACH * this.you.attr.reach
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
        const maxSpeed = PLAYER.SPEED * this.you.attr.speed * this.staminaSpeedMult(this.you.stamina);
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
        // 能力値「リーチ・読み」が高い選手ほど反応遅延が短い（attr.react）。
        if (owner === 'you') {
          this.reactTimers.cpu = PLAYER.CPU_REACT * this.cpu.attr.react;
          this.reactTimers.cpuMate = PLAYER.CPU_REACT * this.cpuMate.attr.react;
        } else if (owner === 'cpu') {
          this.reactTimers.youMate = PLAYER.CPU_REACT * this.youMate.attr.react;
        }
      }
      this.lastBallOwnerSeen = owner;
    }

    /** シングルスの CPU 移動（従来どおり）。ダブルスでは使わない。 */
    moveSinglesCpu(cpuBefore, dt) {
      // サーブ待ち中（phase==='serve'）は動かさない。newPoint() が置いたレシーブの構え位置
      // （サーブが狙う対角のボックス付近）から、サーブが打たれる前に homePosition()（センター）
      // へ歩いて戻ってしまうと、実際にサーブが来る頃には構えが崩れてしまう。
      // フォールトのコール中（'fault'）も同じ：どうせ直後の beginServe() でスタンスへ
      // 置き直されるので、その1秒ほどのために定位置へ歩き出させない。
      if (this.phase === 'serve' || this.phase === 'fault') {
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
     * フォールトのコール中（phase==='fault'）も同じ理由で静止させる。
     */
    moveDoublesTeams(dt) {
      if (this.phase === 'serve' || this.phase === 'fault') {
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
      // 能力値「移動速度」×スタミナ。どちらも倍率なので掛ける順序には依存しない。
      const cappedSpeed = speed * actor.attr.speed * this.staminaSpeedMult(actor.stamina);
      const step = Math.min(cappedSpeed * dt, dist);
      if (dist > 0) {
        actor.x += (dx / dist) * step;
        actor.z += (dz / dist) * step;
      }
      const moved = Math.hypot(actor.x - before.x, actor.z - before.z);
      actor.speed = moved / dt;
      actor.chaseDist += moved;
      // 目標地点に着いて動かずにいる間だけ積む「待てている時間」。走り出したら0に戻る。
      // 走行距離(chaseDist)だけでは「遠くまで走ったが、先回りして落下点で待っていた」
      // 状況が「苦しい」と誤判定されるので、その打ち消しに使う（hit() のスマッシュ）。
      actor.settleT = actor.speed <= CPU.SETTLE_SPEED ? actor.settleT + dt : 0;
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
      // 着地の音量に使う「地面へ突っ込んだ速さ」。reflectBounce() が速度を書き換える前に取る。
      const impactSpeed = Math.hypot(ball.vx, ball.vy, ball.vz);
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
      // 音は跳ねる前の速さで鳴らす（reflectBounce() が速度を落とした後だと、
      // 速い球ほど反発で失う量が大きいぶん音量差が潰れて全部同じ大きさに聞こえる）。
      this.hooks.sound('bounce', ball.spin || 'flat', impactSpeed);

      if (ball.bounces === 1) {
        // サーブがまだ一度も返されていない間の1バウンド目は、通常のラリーの着地判定
        // （コート全体）ではなく、サービスボックスに入ったかどうかで判定する。
        if (this.serveInFlight) {
          if (this.inServiceBox(ball)) {
            // 1本目がサービスボックスに入った＝1stサーブが入った本数（スタッツ用）。
            if (this.serveNumber === 1) this.stats[ball.last].firstServeIn++;
            return false;
          }
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
      if (this.serveNumber !== 1) {
        this.endPoint(opponent(this.server), 'ダブルフォルト');
        return;
      }
      this.serveNumber = 2;
      // まず「フォールト」とコールし、一拍おいてからセカンドサーブの構えに入る。
      // 以前はここで即 beginServe() していたため、ネット／アウトになった瞬間に画面が
      // 次のサーブへ切り替わってしまい、1本目が失敗したことに気づけなかった。
      // この間は phase を 'fault' にして、入力（トス・スイング）も CPU/AI の動きも
      // 止めておく（サーブ待ちの 'serve' のままにすると、そのまま次のトスが上がる）。
      this.phase = 'fault';
      this.serveInFlight = false;
      this.ball.live = false; // 転がり続けずにその場で止める（ポイントが決まったときと同じ扱い）
      this.hooks.call('フォールト', reason);
      this.after(TIMING.FAULT_CALL, () => this.retryServe(reason));
    }

    checkSwings() {
      const ball = this.ball;
      // サーブはノーバウンドで返球できない（volleyしてはいけない）。1バウンドするまで待つ。
      const mustBounceFirst = this.serveInFlight && ball.bounces < 1;
      if (mustBounceFirst) return;

      // プレイヤーは溜めキーを押した瞬間の前後だけ打てる。人間が優先（AIパートナーに横取りさせない）
      if (ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN && this.you.swing > 0) {
        // 能力値「リーチ・読み」で手の届く範囲が広がる／狭まる（attr.reach）。
        if (reaches(ball, this.you, PLAYER.REACH * this.you.attr.reach) && ball.y < PLAYER.REACH_Y) {
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
        const mateReach = reactReach(ball.age, this.youMate.attr.reach);
        if (canReturn && reaches(ball, this.youMate, mateReach) && inRange) this.hit('youMate');
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
        // 能力値「リーチ・読み」の倍率は選手ごとに違うので、2人ぶん別々に求める。
        if (cpuCanReturn && reaches(ball, this.cpu, reactReach(ball.age, this.cpu.attr.reach)) && inRange) {
          this.hit('cpu');
        } else if (cpuMateCanReturn
          && reaches(ball, this.cpuMate, reactReach(ball.age, this.cpuMate.attr.reach)) && inRange) {
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
