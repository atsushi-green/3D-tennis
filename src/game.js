/**
 * ゲームのルールと状態。three.js にも DOM にも触らない。
 * 外へ伝えたいこと（音・コール・スコア更新）は hooks 経由で呼び出す。
 */
(function (RallyOne) {
  'use strict';

  const {
    ATTRS, BOUNDS, CHANGEOVER, CHARGE, COURT, CPU, DOUBLES, DROP, FX, HALF_L, HALF_W, LINE_CALL, NET, PHYSICS,
    PLAYER, PRACTICE, RETURN, RULES, SERVE, SHOT, SMASH_HINT, SPECIAL, SPECIAL_MOVES, STAMINA, TIMING,
    TIMING_AIM, TRAIL, VOLLEY, WIND, shotSkill,
  } = RallyOne.config;
  const {
    approach2D, clamp, lerp, mpsToKmh, rand, signOr,
  } = RallyOne.math;
  const {
    hitsNet, integrate, predictLanding, predictWindow, reflectBounce, solveShot,
  } = RallyOne.physics;
  const {
    chasePosition, homePosition, netRushPosition, cpuShot, cpuVolleyShot, cpuSmashShot,
    isResponder, coverPosition, reactReach, aiSpin,
    pairResponder, poachRun, frontPosition, backPosition,
    doublesRallyShot, doublesVolleyShot, doublesSmashShot,
  } = RallyOne.ai;
  const { Match, pointStakes, changeoverAfter } = RallyOne.scoring;

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
   * 1バウンド目の判定に関わる線のうち、いちばん外寄り（内側への距離が最小）の線。
   * アウトならそれが割った線、インならいちばん際どかった線になる（線審のコールに使う）。
   * @param {{line:string, inside:number, out:{x:number, z:number}}[]} lines
   *   inside＝球の中心から線までの内側への距離(m、負なら外)、out＝線から外へ向かう向き
   */
  function closestLine(lines) {
    return lines.reduce((a, b) => (b.inside < a.inside ? b : a));
  }

  /**
   * カメラはベースライン後方（-z）から +z を向いているので、world の +x は画面の左に映る。
   * 入力は画面基準（右キー = +1）なので、world の x へ渡すときに反転させる。
   */
  const INPUT_X_TO_WORLD = -1;

  // physics.predictWindow()／predictAtZ() が軌道を刻む幅(秒)。predictWindow は
  // 「上限を越えた次の1コマ」までサンプルを返しうるので、上限を渡す側がこのぶん
  // 手前で打ち切る必要がある（predictContact() 参照）。
  // 予測の刻みは実際の物理と同じ（physics.js 側で PHYSICS.STEP を使う）。別の値に
  // しておくと、予測と実物理でボールの落ち方そのものがずれる（physics.js の
  // landedAt() のコメント参照）ので、ここもそこから引く。
  const PREDICT_STEP = PHYSICS.STEP;

  function reaches(ball, player, reach) {
    return Math.hypot(ball.x - player.x, ball.z - player.z) < reach;
  }

  /**
   * 各選手のラケット側（＝フォアハンドで打つ側）が world のどちら側か。全員**右利き**。
   * カメラはベースライン後方から +z を向いているので world の +x が画面の左に映る
   * ＝手前を向いている 'you'/'youMate' の右手side（画面の右）は world -x。
   * 'cpu'/'cpuMate' は180°回転して手前を向いているので、その右手side は world +x になる。
   * モデル側（scene/player.js の HAND）も同じ向きに揃えてあるので、フォアと判定した球は
   * ちゃんとラケットを持っている側で振られる。
   */
  const RACKET_SIDE = { you: -1, youMate: -1, cpu: 1, cpuMate: 1 };

  /** 個々の選手が、チームとしてはどちら側か（ダブルスの味方はチームメイトと同じチーム） */
  const TEAM_OF = { you: 'you', youMate: 'you', cpu: 'cpu', cpuMate: 'cpu' };

  /** ダブルスで、その選手の相方 */
  const MATE_OF = { you: 'youMate', youMate: 'you', cpu: 'cpuMate', cpuMate: 'cpu' };

  /** 4人ぶんまとめて同じ処理をしたいとき用（スタミナの回復など） */
  const ACTORS = Object.keys(TEAM_OF);

  /**
   * その選手にとっての「前」＝ネット越しに打ち込む向き（world の z 方向）。
   * 手前側（you/youMate、z<0）は +z、奥側（cpu/cpuMate、z>0）は -z。
   * 狙いの向き（hit() の aimDir）と、前進しているかの判定（actor.fwd）が同じ値を通る。
   */
  const NET_DIR = { you: 1, youMate: 1, cpu: -1, cpuMate: -1 };

  /**
   * バギーホイップで打球が曲がる向き（world の x 方向）。曲がる先＝落とす先でもある。
   * 振り抜く方向は打ち方（フォアハンド）で決まっているので、ラケット側の逆＝
   * コート中央を横切る側へ常に曲がる。手前の人間（RACKET_SIDE=-1）なら +x
   * （画面では右から左）、向かい側の AI（+1）ならその鏡で -x。
   */
  function buggyCurveSign(who) {
    return -RACKET_SIDE[who];
  }

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

  /* ------------------------------------------------------------ 必殺技 */

  /** キー → 表示名。config.SPECIAL_MOVES を畳んだだけの引き当て表。 */
  const SPECIAL_LABEL = Object.fromEntries(SPECIAL_MOVES.map((m) => [m.key, m.label]));
  /** トスを上げる前、キックサーブが打てるときの案内（HUD の溜めバーの上に出す） */
  const KICK_HINT = `K を押してトス → ${SPECIAL_LABEL.kickServe}`;

  /**
   * その必殺技を出している間だけ広がる「打てる範囲」。
   * mult＝PLAYER.REACH に掛ける倍率、y＝PLAYER.REACH_Y に足す高さ(m)。
   * 「出せる」と表示する判定（specialContext）と実際の当たり判定（checkSwings）が
   * 同じ値を通るので、「出ると出ていたのに届かない」が起きない。
   */
  const SPECIAL_REACH = {
    divingVolley: { mult: SPECIAL.DIVE.REACH_MULT, y: 0 },
    tweener: { mult: SPECIAL.TWEENER.REACH_MULT, y: 0 },
    dunkSmash: { mult: 1, y: SPECIAL.DUNK.REACH_Y_BONUS },
  };
  const NO_EXTRA_REACH = { mult: 1, y: 0 };
  function specialReach(move) {
    return SPECIAL_REACH[move] || NO_EXTRA_REACH;
  }

  /**
   * 飛びつきボレーで伸ばした体が、高さ y(m) の球に届く水平距離(m)。足元（当たる瞬間には
   * DIVE.CONTACT_LIFT だけ浮いている）を支点に、長さ DIVE.BODY_REACH の体を倒して届く範囲。
   * 高い球ほど体を立てて届かせるので短くなる。
   */
  function diveStretch(y) {
    const { DIVE } = SPECIAL;
    return Math.sqrt(Math.max(0, DIVE.BODY_REACH ** 2 - (y - DIVE.CONTACT_LIFT) ** 2));
  }

  /**
   * その打点が「ボレー」になるか（hit() の isVolley とまったく同じ条件）。
   * ボレーを担当する技（飛びつき／ドライブボレー）が出られる場面と、グラウンド
   * ストロークの技（バギーホイップ）が出てはいけない場面を、この1つで判定する。
   * @param {Game} g
   * @param {{bounces:number}|null} at predictContact() の打点、または実際のボール
   */
  function isVolleyContact(g, at) {
    return !!at && at.bounces === 0 && g.you.z > -COURT.SERVICE;
  }

  /**
   * その打点は「自分の後ろを抜けている」か＝ツイーナー（股抜き）の場面か。
   * **後ろへの距離と向きの両方**を見る：真後ろから左右 45°（TWEENER.SIDE_RATIO=1.0）の
   * 扇の中に、TWEENER.BEHIND より深く入っていること。
   * 以前は z の差だけを見ていたため、**真横 2m ほどを通り過ぎる球がほんの少し後ろに
   * 入った瞬間**にも成立し、ふつうのストロークが勝手にツイーナーになっていた
   * （ユーザー報告。SPECIAL.TWEENER のコメント参照）。人間と AI の両方から使う。
   * @param {string} who 打つ本人（ネット方向 NET_DIR で「後ろ」の向きを揃える）
   * @param {{x:number, z:number}} player
   * @param {{x:number, z:number}|null} at 打点（predictContact の結果、または実際のボール）
   */
  function passedBehind(who, player, at) {
    if (!at) return false;
    const { TWEENER } = SPECIAL;
    const behind = (player.z - at.z) * NET_DIR[who];
    return behind >= TWEENER.BEHIND
      && Math.abs(at.x - player.x) <= behind * TWEENER.SIDE_RATIO;
  }

  /**
   * その打点は「ベースライン付近で、弾んだ直後の上がりばな」か＝ライジングの場面か。
   * 見るのは3つ：打つ本人がベースラインの近く（内側 BASE_IN〜後ろ BASE_OUT）に立っている、
   * 球がバウンド済みでまだ上昇中、弾んでから MAX_SINCE 秒以内。
   * 立ち位置は深さ（|z|＝ネットからの距離）で見るので、手前と奥のどちらの選手にもそのまま
   * 使える。人間（打点の先読み／当たった瞬間）と AI（当たった瞬間）の両方から使う。
   * @param {{z:number}} player 打つ本人
   * @param {{bounces:number, vy:number, sinceBounce:number|null}|null} at 打点
   *   （predictContact の結果、または実際のボール）
   */
  function risingContact(player, at) {
    if (!at || !(at.bounces > 0) || !(at.vy > 0)) return false;
    const { RISING } = SPECIAL;
    // 弾んでからの時間が分からない球（null）は数えない＝上がりばなとは言えない
    if (!(at.sinceBounce <= RISING.MAX_SINCE)) return false;
    const depth = Math.abs(player.z);
    return depth >= HALF_L - RISING.BASE_IN && depth <= HALF_L + RISING.BASE_OUT;
  }

  /**
   * 技が乗った1打が、実際に当たった時点でもまだその技の場面かどうか。
   * 技が乗るのは「溜めを離した瞬間」（chargeRelease）で、実際に当たるのはその少し後
   * なので、その間に前へ詰めた・バウンドを待ったなどで場面が変わることがある。
   * false を返した技は hit() が下ろし、普通の1打として打つ（回数も減らない）。
   * **打ち方が変わってしまう技だけ**ここに書く：hit() は技が乗った1打の打ち方を技に
   * 決めさせるので（isSmash / isVolley）、場面が変わったまま乗せ続けると
   * 「ボレーがバギーホイップとして曲がって飛ぶ」「ワンバウンドの球がダンクになる」。
   * @type {{[key:string]: (g: Game, ball: object) => boolean}}
   */
  const SPECIAL_STILL_VALID = {
    buggyWhip: (g, ball) => !isVolleyContact(g, ball),
    dunkSmash: (g, ball) => ball.bounces === 0,
    // 離した瞬間は「バウンドした球に抜かれていた」のに、当たったのはノーバウンドの球
    // ／もう自分より前にある球、という取り違え（ユーザー報告「ボレーのときに勝手に
    // ツイーナーが発動する」）を防ぐ。専用モーション（体ごと反転して股下へ）に切り替わる
    // 技なので、場面が変わったまま乗せ続けると普通のボレーが股抜きの形で飛ぶ。
    tweener: (g, ball) => ball.bounces > 0 && passedBehind('you', g.you, ball),
    // 溜めている間はワンバウンドの球だったのに、前へ詰めてノーバウンドで触った
    // ／跳ね上がってスマッシュの高さになった、という取り違えを防ぐ。
    hawkEye: (g, ball) => ball.bounces > 0
      && !naturalStroke(g, 'you', ball, g.you, g.you.swingCharge).smash,
    // 弾んだ高い球を叩く技なので、ノーバウンドで触ってしまった／落ちてくるのを待って
    // しまった（打点が下がった）1打では下ろす。跳んで叩く専用モーションに切り替わるため。
    jackknife: (g, ball) => ball.bounces > 0 && ball.y >= SPECIAL.JACK.MIN_Y,
    // 上がりばなを叩く技なので、離した後に引きつけすぎた（弾んでから時間が経った／もう頂点を
    // 越えた）1打や、下がって・前へ出て打った1打では下ろす。ジャックナイフの逆で、
    // こちらは「待ちすぎると技にならない」。
    rising: (g, ball) => risingContact(g.you, ball)
      && !naturalStroke(g, 'you', ball, g.you, g.you.swingCharge).smash,
  };

  /**
   * 各必殺技が「今この場面で出せるか」。装備している技を SPECIAL_MOVES の並び順
   * （＝優先度）に上から当てていき、最初に true になったひとつだけが**自動で**発動する
   * （Game#pickSpecial）。条件が重ならないよう、技ごとに担当する場面を分けてある：
   * サーブ／前に詰めながらの高いノーバウンド／抜かれた球／届かない球／
   * 届かないノーバウンド／浮いたノーバウンド／
   * 走らされているフォアハンド／ベースライン付近の上がりばな／足を止めて溜めたグラウンドストローク。
   * @type {{[key:string]: (g: Game, c: object) => boolean}}
   */
  const SPECIAL_MATCH = {
    // 自分のサーブを、キックサーブのキー（K）でトスを上げたときだけ（B/V/C のサーブでは出ない）
    kickServe: (g, c) => c.serving && c.kick,
    // 「前へ踏み込みながら、高いノーバウンドの球を叩く」場面だけ。
    // ・バウンド後の球（bounces > 0）では出さない。跳ね上がった球を打つのはスマッシュ
    //   ではなく高い打点の返球で、そこまで技にすると普通のラリー中に暴発する。
    // ・前進（you.fwd）を見るのがこの技の本体。止まって待って叩くのは普通のスマッシュ。
    // ・**溜めは見ない**（通常のスマッシュが要る PLAYER.SMASH_MIN_CHARGE は掛からない）。
    //   走っている間は溜まらない（CHARGE.MOVE_CAP_FLOOR=0）ので、前に詰めながら溜めを
    //   要求すると、そもそも成立しない条件になってしまう。
    dunkSmash: (g, c) => !c.serving && !!c.contact('dunkSmash')
      && c.contact('dunkSmash').bounces === 0
      && c.contact('dunkSmash').y >= SPECIAL.DUNK.MIN_Y
      && g.you.fwd >= SPECIAL.DUNK.MIN_FWD,
    // 「もう自分より後ろを通っている（抜かれた）、**バウンド済みの**球」だけ。
    // リーチが伸びる（TWEENER.REACH_MULT）ので、普通なら触れない距離の球も拾える＝
    // これが技の本体。
    // ・**ノーバウンドの球では出さない**（contact.bounces > 0）。股抜きはバウンドした球を
    //   拾う打ち方で、ノーバウンドのままなら普通のボレー／スマッシュの場面。リーチを
    //   1.35→1.8 に広げたあと、ネット際で体の横を通り過ぎる速い球が「わずかに後ろ」に
    //   入った瞬間に拾われ、**普通のボレーが勝手にツイーナーになる**というユーザー報告が
    //   出た。ボレーは飛びつき／ドライブボレーの担当なので、ここで線を引く。
    // ・**縮地より先に判定する**（SPECIAL_MOVES の並び順）：抜かれた球は「離れていて
    //   走っても間に合わない球」にも当てはまることが多く、逆順だと両方を装備したときに
    //   縮地が先に拾ってしまう。
    tweener: (g, c) => !c.serving && !!c.contact('tweener')
      && c.contact('tweener').bounces > 0
      && c.contact('tweener').y >= SPECIAL.TWEENER.MIN_Y
      && passedBehind('you', g.you, c.contact('tweener')),
    // 「ボールが十分に離れていて、普通に振っても届かず、走っても間に合わない」球だけ。
    // ・ボールとの距離（MIN_DIST）を見ないと、すぐ横を速く通り過ぎる球——手を伸ばせば
    //   届きそうな「ギリギリ届かない」球——にも出てしまう（そういう球でも2バウンド目は
    //   遠いので dashUnreachable は成立する）。
    // ・走っても間に合わない（dashUnreachable）を見ないと、溜めを少し早く離しただけの
    //   普通の球（走れば余裕で届く球）まで縮地の対象になり、他の技が出る場面がなくなる。
    shukuchi: (g, c) => {
      if (c.serving || c.contact('shukuchi')) return false;
      if (g.ballDistance() < SPECIAL.DASH.MIN_DIST) return false;
      return !!c.dashSpot() && c.dashUnreachable();
    },
    // 「ノーバウンドだが、普通に振ったのでは届かない」球だけ。伸びたリーチ（DIVE.REACH_MULT）
    // でなら捉えられて、通常のリーチでは同じノーバウンドを捉えられない、という差が発動条件。
    // これを見ないと、正面に来たふつうのボレー——手を伸ばさなくても届く球——にまで飛び込んで
    // しまい、硬直（DIVE.RECOVER）だけ背負って次の球が返せなくなる。
    divingVolley: (g, c) => !c.serving
      && isVolleyContact(g, c.contact('divingVolley'))
      && !isVolleyContact(g, c.contact(null)),
    // 「ノーバウンドで、腰から頭までの高さに浮いた球」を横振りで叩く場面だけ。
    // ・ネット前に限らない（ベースライン寄りで浮いたノーバウンドを叩くのもドライブ
    //   ボレー）ので、isVolleyContact ではなく「ノーバウンド＋高さ」で見る。
    // ・上（MAX_Y）を切らないと、スマッシュになる高さの球まで拾ってしまう。ダンク
    //   スマッシュのほうが優先度は上だが、ダンクを装備していない／使い切った／前へ
    //   詰めていない場面では、頭上の球がそのままドライブボレーに落ちてきていた。
    driveVolley: (g, c) => !c.serving && !!c.contact('driveVolley')
      && c.contact('driveVolley').bounces === 0
      && c.contact('driveVolley').y >= SPECIAL.DRIVE.MIN_Y
      && c.contact('driveVolley').y < SPECIAL.DRIVE.MAX_Y,
    // 「高く弾んだ球を、足を止めてフラットのバックハンドで叩く」場面だけ。
    // バギーホイップ（フォア／トップスピン／走らされている）とちょうど背中合わせの条件で、
    // 同じ1打で両方が成立することはない。
    // ・バウンド済みの高い球（MIN_Y＝肩の高さ）に限る。ノーバウンドの高い球はダンク
    //   スマッシュ／ドライブボレーの領分で、そちらのほうが優先度も上にある。
    // ・押したキーが B（フラット）であること。高い打点から下向きに叩き込む打ち方なので、
    //   擦り上げるトップスピンやスライスでは成立しない（バギーホイップの逆）。
    // ・足が止まっていること（MAX_SPEED）。跳び上がる踏み切りが要る＝走らされている
    //   ときはバギーホイップ、止まって叩けるときはこちら、と場面が分かれる。
    jackknife: (g, c) => {
      if (c.serving || c.spin !== 'flat' || g.currentStroke() !== 'backhand') return false;
      const { JACK } = SPECIAL;
      return !!c.contact('jackknife')
        // 見るのは「最初に届く点」ではなく「この1振りでいちばん高く捉えられる点」
        // （Game#contactPeakY のコメント参照）。バウンド後の打点だけを数える。
        && c.peak().y >= JACK.MIN_Y
        && c.charge >= JACK.MIN_CHARGE
        && g.you.speed <= JACK.MAX_SPEED;
    },
    // 「フォア側へ大きく振り回されて、追いつきざまにトップスピンで振り抜く」場面だけ：
    // V（トップスピン）で溜めたフォアハンドで、直前まで走っていて（sinceRunT）、ラケット側の
    // サイドへ大きく走って（runX）、実際にそちらへ寄って立っている（you.x）。
    // 「走っていた」は離した瞬間の速さではなく直近 RECENT_RUN_T 秒で見る＝追いついて
    // 止まってから振っても出る（SPECIAL.BUGGY.RECENT_RUN_T のコメント参照）。
    buggyWhip: (g, c) => {
      if (c.serving || !c.contact('buggyWhip')) return false;
      // ボレーの場面では出さない（走りながら擦り上げるグラウンドストロークの技なので、
      // ネット前でノーバウンドを触る1打とは別物。ボレーは飛びつき／ドライブボレーの担当）。
      if (isVolleyContact(g, c.contact('buggyWhip'))) return false;
      if (c.spin !== 'top' || g.currentStroke() !== 'forehand') return false;
      const { BUGGY } = SPECIAL;
      const side = RACKET_SIDE.you; // ラケット側を正にするための符号
      return g.you.sinceRunT <= BUGGY.RECENT_RUN_T
        && g.you.runX * side >= BUGGY.MIN_RUN_X
        && g.you.x * side >= BUGGY.MIN_X;
    },
    // 「ベースライン付近で下がらずに、弾んだ直後の上がりばなを捉える」場面だけ。
    // ・判定は「最初に届く点」（predictContact）で見る。弾んで上がってくる球では、そこが
    //   ちょうど上がりばな＝この技の打点になる（ジャックナイフが最高点を見るのと逆）。
    // ・**溜めは見ない**。相手の球威を使ってコンパクトに合わせる打ち方なので、溜めが
    //   浅くても速い球になる（specialShot 参照）。
    // ・ただし**ロブ（Shift）とドロップショット（C をほとんど溜めずに離す）では出さない**。
    //   どちらも「叩かない」ことを選んだ1打で、溜めを見ない技がそこまで拾うと、
    //   ベースラインでつなぎのロブ／ドロップを打つたびに強打へ化けてしまう。
    rising: (g, c) => {
      if (c.serving || g.input.lob) return false;
      if (c.spin === 'slice' && c.charge <= DROP.MAX_CHARGE) return false;
      const at = c.contact('rising');
      return risingContact(g.you, at)
        && !naturalStroke(g, 'you', at, g.you, c.charge).smash;
    },
    // 「足を止めて狙い澄ますグラウンドストローク」だけ。**ノーバウンドを触る1打（ボレー）
    // と、頭上から叩く1打（スマッシュ）では出さない。** hit() は技が乗った1打の打ち方を
    // 技に決めさせる（isSmash / isVolley）ので、場面を見ずに乗せるとボレーが
    // グラウンドストロークとして飛んでいた（実測：ネット前の同じ1打が 45.7→71.6km/h、
    // 着地が z=4.3→9.9 まで伸び、フォームもボレーではなくフォアハンドになる）。
    // AI 側（AI_SPECIAL_MATCH.hawkEye）は最初からこの条件で除いてあり、人間側だけが
    // 抜けていた。バウンド済み（bounces > 0）ならボレーの場面ではないので、あとは
    // スマッシュになる高さ・溜めだけを外せばよい。
    hawkEye: (g, c) => {
      if (c.serving || c.charge < SPECIAL.HAWK.MIN_CHARGE) return false;
      const at = c.contact('hawkEye');
      return !!at && at.bounces > 0
        && !naturalStroke(g, 'you', at, g.you, c.charge).smash;
    },
  };

  /**
   * 必殺技が乗っていなければ、この打点はどういう1打になるか。hit() の打ち方の判定
   * （isSmash / isVolley）と、AI が技を選ぶときの材料が同じ式を通るように切り出した。
   * @param {Game} g
   * @param {string} who
   * @param {object} ball 打点（通常は g.ball）
   * @param {object} player 打つ本人
   * @param {number} charge 人間の溜め量(0〜1)。AI は 0
   * @returns {{smash:boolean, volley:boolean}}
   */
  function naturalStroke(g, who, ball, player, charge) {
    const smash = who === 'you'
      ? ball.y >= PLAYER.SMASH_MIN_Y && charge >= PLAYER.SMASH_MIN_CHARGE
      : ball.y >= CPU.SMASH_MIN_Y && ball.vy <= CPU.SMASH_FALLING_VY
        && Math.abs(player.z) <= CPU.SMASH_Z_MAX;
    const volley = !smash && ball.bounces === 0 && (who === 'you'
      ? player.z > -COURT.SERVICE
      : Math.abs(player.z) <= PLAYER.VOLLEY_Z);
    return { smash, volley };
  }

  /**
   * CPU/AI 版の「今この場面でその技が出せるか」。人間の SPECIAL_MATCH と対になるが、
   * 見るタイミングが違う：AI には溜め（これから打つ、という前置き）が無いので、
   * **実際に当たる瞬間**の場面だけで決める（hit() から一度だけ呼ばれる）。
   * 条件そのものは人間と同じ config の値（SPECIAL.DUNK.MIN_Y など）を使い、溜めや
   * ←→ の入力を要求するところだけ AI 向けの代わり（settleT・runX）に置き換える。
   * キックサーブだけはラリーではなくサーブなので、ここではなく serve() が拾う。
   * @type {{[key:string]: (g: Game, c: object) => boolean}}
   *   c ＝ {who, ball, player, bounces, contactY, stroke, natural{smash,volley}}
   *   （「抜かれた量」は人間と同じ passedBehind() で見るので、ここには持たない）
   */
  const AI_SPECIAL_MATCH = {
    // 頭上の高いノーバウンドを叩き落とす。高さ（SPECIAL.DUNK.MIN_Y）は人間とまったく
    // 同じで、人間の「前へ踏み込みながら」（DUNK.MIN_FWD）だけが AI 向けの代わりに
    // 置き換わる——ai.smashApproach() は頭上の球の打点へ**先回りして止まって待つ**動きを
    // するので、叩く瞬間はほぼ必ず静止していて踏み込みが出ない（実測：ダブルス Hard
    // 900秒で AI のスマッシュ59本の fwd は中央値 0.00・最大 0.12 で、MIN_FWD=2.2 を
    // 満たしたのは0本＝この技だけ事実上 AI に存在しなかった）。代わりに「攻めの位置で
    // 叩けている」＝打点がサービスライン付近（SPECIAL.AI.DUNK_MAX_Z）より前、で見る。
    dunkSmash: (g, c) => c.bounces === 0
      && c.contactY >= SPECIAL.DUNK.MIN_Y
      && Math.abs(c.player.z) <= SPECIAL.AI.DUNK_MAX_Z,
    // 球に抜かれた（自分より後ろを通っている）ときの股抜き。人間と同じく、
    // ノーバウンドの球では出さない（そこはボレー／スマッシュの場面）。
    tweener: (g, c) => c.bounces > 0
      && c.contactY >= SPECIAL.TWEENER.MIN_Y
      && passedBehind(c.who, c.player, c.ball),
    // 腰から頭の高さに浮いたノーバウンドを、待たずに強打する。
    driveVolley: (g, c) => c.bounces === 0
      && c.contactY >= SPECIAL.DRIVE.MIN_Y
      && c.contactY < SPECIAL.DRIVE.MAX_Y,
    // 高く弾んだ球を、足を止めて跳びながらバックハンドで叩き込む。人間の
    // 「B（フラット）で溜めた」に当たる条件は AI には無いので、残りの3条件
    // （バウンド済みの高い打点・バックハンド・足が止まっている）で見る。
    jackknife: (g, c) => {
      const { JACK } = SPECIAL;
      return c.bounces > 0 && c.contactY >= JACK.MIN_Y
        && c.stroke === 'backhand'
        && c.player.speed <= JACK.MAX_SPEED;
    },
    // フォア側へ大きく振り回されて、追いつきざまに振り抜くグラウンドストローク。
    // 人間の「V（トップスピン）で溜めた」に当たる条件は AI には無いので、残りの
    // 3条件（フォアハンド・まだ止まりきっていない・ラケット側へ大きく走って寄った）で見る。
    // 「止まりきっていない」は人間と違い**当たった瞬間の速さ**のまま（人間の猶予
    // RECENT_RUN_T は持たせない）。AI は目標に着くとぴたりと止まって待つので、猶予を
    // 与えると「間に合って待てた球」でも出るようになり、打ってくる回数が増える。
    buggyWhip: (g, c) => {
      if (c.natural.smash || c.natural.volley || c.stroke !== 'forehand') return false;
      const { BUGGY } = SPECIAL;
      const side = RACKET_SIDE[c.who]; // ラケット側を正にするための符号
      return c.player.speed >= BUGGY.MIN_SPEED
        && c.player.runX * side >= BUGGY.MIN_RUN_X
        && c.player.x * side >= BUGGY.MIN_X;
    },
    // ベースライン付近で、弾んだ直後の上がりばなを叩く。条件は人間とまったく同じ
    // （人間にもともと溜めの条件が無いので、置き換えるものがない）。
    rising: (g, c) => !c.natural.smash && !c.natural.volley && risingContact(c.player, c.ball),
    // 足を止めて構えられた1打を、狙い澄ましてライン際へ。人間の「溜め5割以上」に
    // 当たるのが settleT（目標地点に着いてから動かずに待てている秒数）。
    hawkEye: (g, c) => !c.natural.smash && !c.natural.volley && c.bounces > 0
      && c.player.settleT >= SPECIAL.AI.SETTLE_T,
  };

  /**
   * スタッツの入れ物（1チームぶん×2）。数え方はすべて「打った側／取った側」の視点で、
   * 表示（hud.js）はここの数字を並べるだけにする。
   * - points        取ったポイント数
   * - winners       自分の決め球で取ったポイント（サーブのエースは aces に数えるので含めない）
   * - unforced      自分のミス（ネット／アウト／届かず／ダブルフォルト）で落としたポイント
   * - firstServes   打った1本目のサーブの数／firstServeIn はそのうちサービスボックスに入った数
   * - maxServeKmh   そのマッチでいちばん速かったサーブの初速
   * - specials      決めた必殺技の回数（難易度 Hard では CPU/AI 側も増える。SPECIAL.AI 参照）
   * - breakPoints   自分がレシーブ側で「あと1点でそのゲームを取れる」状態だった回数
   *                 （＝ブレークのチャンス）／breaksWon はそのうち実際に取った回数。
   *                 タイブレークは数えない（scoring.pointStakes() 参照）
   */
  function teamStats() {
    const blank = () => ({
      aces: 0, doubleFaults: 0, points: 0, winners: 0, unforced: 0,
      firstServes: 0, firstServeIn: 0, maxServeKmh: 0, specials: 0,
      breakPoints: 0, breaksWon: 0,
    });
    return { you: blank(), cpu: blank() };
  }

  /** チェンジエンズのコールの補足（休憩の種類ごと。種類は scoring.changeoverAfter()）。 */
  const CHANGEOVER_CALLS = {
    firstGame: '第1ゲームの後は休憩なし',
    tiebreak: `タイブレーク ${RULES.TIEBREAK_CHANGE_EVERY}ポイントごと（休憩なし）`,
    rest: `${CHANGEOVER.RULE_SEC.rest}秒の休憩 ／ SPACE でスキップ`,
    setBreak: `セット間の休憩（${CHANGEOVER.RULE_SEC.setBreak}秒） ／ SPACE でスキップ`,
  };

  /** phase: idle → serve → rally → over → (serve …) */
  class Game {
    /**
     * @param {object} deps
     * @param {object} deps.input RallyOne.Input
     * @param {{sound:Function, call:Function, clearCall:Function, score:Function,
     *   wind:Function, serveSpeed:Function, matchEnd:Function}} deps.hooks
     *   wind(x, z) は風の横成分・前後成分（m/s²。z>0 が人間のチームにとっての追い風）。
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
        curve: 0,       // 横方向の加速度(m/s²)。バギーホイップ（必殺技）だけが使い、バウンドで消える
        age: 0,         // 最後に打たれてからの経過時間(秒)。CPU/AIが「反応する時間」に使う（ai.reactReach）
        // 最後にバウンドしてからの経過時間(秒)。bounces>0 のときだけ意味を持つ。必殺技ライジング
        // の「弾んだ直後の上がりばなか」の判定に使う（physics.predictWindow も同じ数え方をする）。
        sinceBounce: 0,
        wind: 0,        // 横風（m/s²、vxに継続的に加算）。サーブの飛翔中は常に0、返球後だけ this.wind になる
        windZ: 0,       // 前後の風（m/s²、vzに継続的に加算）。wind と同じく返球後だけ this.windZ になる
      };
      this.you = {
        x: 0, z: -HALF_L - 0.6, vx: 0, vz: 0, // vx/vz は実速度（加速度で目標速度に近づける）
        swing: 0, anim: 0, speed: 0, stroke: 'forehand', prep: null,
        // 今テイクバック中／振っている最中の球種。打つフォーム（scene/player.js の
        // MOTION の球種ごとの振り付け）を切り替えるためだけの表示用の値で、判定には一切使わない。
        spin: 'flat',
        charging: false, chargeTime: 0, swingCharge: 0, // 溜めキー押しっぱなしのテイクバック
        // この1振りが実際にボールを捉えたか。update() が「振ったのに届かなかった」を
        // 見分けるために使う（hit() は成功した時点で swing を0にするので、残り時間だけでは
        // 空振りと区別できない。詳細は update() の missSwing() の呼び出し箇所を参照）。
        swingConnected: false,
        // 直前に振ったときのスイング入力の有効時間(秒)。レシーブだけ長い
        // （RETURN.SWING_WINDOW）ので、引っ張り／流しの換算（swingWaited()）に使う。
        swingSpan: PLAYER.SWING_WINDOW,
        serveMiss: false, // このサーブは「溜めすぎ」の抽選に当たった＝狙いを外す（chargeRelease()で抽選）
        chargeFrac: 0, // 溜めている間だけ 0〜1 で増える、テイクバックの深さ用（chargeTime のポーズ表示版）
        chargeStroke: null, // chargeStart() の瞬間に固定するフォア/バック。溜めている間は変えない
        chargeSpin: 'flat', // chargeStart() の瞬間に固定するスピン（B/V/C）。実際に当たるまで押し続けなくてよい
        chargeKick: false, // このサーブのトスをキックサーブのキー（K）で上げたか（chargeStart()）
        // この1打に乗っている必殺技のキー（chargeRelease() が入れる。出していなければ null）。
        // 打ち終わってモーションが尽きたところで update() が消す＝振っている間は残るので、
        // 打球の計算（hit/playerShot）だけでなくフォーム（scene/player.js）にも使える。
        special: null,
        // 直前に出した必殺技の呼び名（コースで変わる技があるので、技のキーとは別に持つ）。
        specialLabel: null,
        // 縮地の残像（表示専用）。{x, z, t}＝瞬間移動する前に立っていた位置と、消えるまでの残り時間。
        dash: null,
        // 跳んで打つ1打（スマッシュ／ダンクスマッシュ／ジャックナイフ）の跳躍（表示専用）。
        // {t: 着地までの残り秒, kind: 'smash'|'jackknife'}。**打球のモーション（anim）とは
        // 別の時計**で、tickLeap() が「もうすぐ球が届く」ところで離す前から始める
        // ＝跳んでから空中で振り始める絵になる。
        leap: null,
        // 飛びつきボレーの、打つ前の飛び込み（startDive() が入れ、当たった瞬間に null）。
        // 飛び込んでいる間は足元が球のほうへ動き、他の誰も球に触らない（AI も同じ）。
        dive: null,
        // 相手が打ってからこのフレームまでに左右へ動いた量（符号つき、m）。CPU/AI の
        // chaseDist の人間版で、resetChase() が新しい球のたびに0へ戻す。必殺技
        // バギーホイップの「フォア側へ大きく振り回されたか」の判定に使う。
        runX: 0,
        // 最後に SPECIAL.BUGGY.MIN_SPEED 以上で走っていたときからの秒数。バギーホイップの
        // 「まだ止まりきっていない」を、離した瞬間の速さではなく直近の走りで見るのに使う
        // （SPECIAL.BUGGY.RECENT_RUN_T）。走っていなければ大きな値のまま。
        sinceRunT: Infinity,
        // いまネット方向(+z)へ動いている速さ(m/s、符号つき。後ろへ下がっていれば負)。
        // speed と同じく「実際に動いた分」から出す＝コートの端でクランプされた分は入らない。
        // 必殺技ダンクスマッシュの「前へ踏み込みながら叩いたか」の判定に使う。
        fwd: 0,
        stamina: 1, // 0〜1。長いラリーで走るほど減り、ポイント間で少し回復する（newPoint()参照）
        // スタート画面の「選手設定」で決まる能力倍率（config.ATTRS）。オブジェクトの中身が
        // 書き換えられる形で更新されるので、ここで参照を1度持っておけば以後ずっと最新を指す。
        // 既定（全項目3）ならすべて 1.0＝設定を触らない限り従来と完全に同じ挙動になる。
        attr: ATTRS.you,
        netDir: NET_DIR.you,
      };
      // chaseDist＝この球を追って走った距離、settleT＝目標地点に着いてから動かずに
      // 待っている秒数（どちらも moveTowards() が更新する。hit() の「余裕」判定に使う）。
      // 必殺技まわり（special / specialLabel / specialUses / runX / fwd）は人間と同じ
      // 意味の値を AI も持つ：Hard では AI も技を使うので、打球の計算もフォーム
      // （scene/player.js は player.special を見る）も人間とまったく同じ道を通る。
      const aiActor = (x, z, who) => ({
        x, z, anim: 0, speed: 0, chaseDist: 0, settleT: 0, stroke: 'forehand', prep: null, spin: 'flat', stamina: 1,
        runX: 0, fwd: 0, special: null, specialLabel: null, specialUses: {}, leap: null,
        // dash＝縮地で跳ぶ前の位置（表示専用の残像。人間の you.dash と同じもの）、
        // diveVolley＝この1打は飛びつきボレーだ、という旗（swingAiAt が立て hit が下ろす）、
        // dive＝その打つ前の飛び込み（人間の you.dive と同じもの）。
        // どれも Extreme でだけ立つ（SPECIAL.AI.MOVES_ALL）。
        dash: null, diveVolley: false, dive: null,
        attr: ATTRS[who], netDir: NET_DIR[who],
      });
      this.cpu = aiActor(0, CPU.HOME_Z, 'cpu');
      // ダブルス（this.doubles === true）のときだけ動く AI パートナー。シングルスでは未使用のまま。
      this.youMate = aiActor(0, DOUBLES.NET_Z_YOU, 'youMate');
      this.cpuMate = aiActor(0, DOUBLES.NET_Z_CPU, 'cpuMate');

      this.phase = 'idle';
      /**
       * 装備している必殺技のキー（スタート画面で選んだもの。setSpecials() が入れる）。
       * 空＝必殺技なし＝これまでと完全に同じゲーム。
       */
      this.specials = [];
      /**
       * 技ごとの残り回数（キー → 残り）。技どうしで融通はしない＝それぞれが
       * 1ゲームに SPECIAL.USES_PER_GAME 回ずつ使える。ゲームが替わると全部戻る。
       */
      this.specialUses = {};
      this.refreshSpecials();
      /**
       * 「いま溜めキーを離したらどうなるか」（表示専用）。毎フレーム specialAim() が
       * 入れ直す。打つ場面（溜めている間／自分のサーブ）でなければ null＝HUD には何も出さない。
       */
      this.specialArmed = null;
      /**
       * 各チームがこのポイントで最後に打った球種の名前（shotLabel()）。ポイントが決まったとき、
       * 取った側が何で決めた（あるいは何で相手のミスを誘った）かを表示するのに使う。
       * newPoint() で毎ポイント消す。
       */
      this.lastShotBy = { you: null, cpu: null };
      /**
       * 直近に打たれたサーブの初速(km/h)。サーブだけで決まった1点（エース）のとき、球種名に
       * 添えて「何km/h のサーブだったか」を出すのに使う。serve() で入れ、newPoint() で消す。
       */
      this.lastServeKmh = null;
      /**
       * 次の1点に何がかかっているか（scoring.pointStakes() の結果。かかっていなければ null）。
       * beginServe() で毎ポイント決め直し、ポイントが決まった時点（endPoint）で消す。
       * 表示（スコアボードの見出し）とスタッツ（ブレークポイントの本数）の両方がここを読む。
       */
      this.stakes = null;
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
       * タイブレーク中も同じ順番のまま、サーブ権が移るたびに回る（passServe()）。
       * シングルスでは参照されない。
       */
      this.serverPartner = { you: 'you', cpu: 'cpu' };
      /**
       * タイブレークの1本目をサーブしたチーム（タイブレーク中でなければ null）。
       * タイブレークで決まったセットの次は、このチームの相手からサーブする（ITF ルール 5(b)）。
       */
      this.tiebreakOpener = null;
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
      /**
       * ダブルスで、人間(you)がサーブ前に立つ位置。'net'（前）か 'back'（後ろ）。
       * 相方がサーバー／レシーバーの番にだけ効き（placeDoublesMate）、次のポイント以降も
       * 覚えておく（youMateFormation と同じ）。ポイントが始まれば人間は自由に走れるので、
       * ラリー中の動きには関係しない。以前は人間の立ち位置も youMateFormation で決めていた
       * ため、パートナーに「下がれ」と言うと、パートナーがサーブする番では人間まで
       * ベースラインに下げられていた。
       */
      this.youFormation = 'net';
      /**
       * ダブルスで、いまのポイントの前衛（個人キー）。後衛はその相方（MATE_OF）。
       * cpu チームはポイントごとに決め直す（beginServe）：サーバー／レシーバーが後衛、
       * その相方（placeDoublesMate() がネット際に置いた方）が前衛で、ポイントの間は
       * 入れ替えない。以前は cpu＝後衛・cpuMate＝前衛で固定だったため、cpuMate が
       * サーブ／レシーブする番では、ベースラインから始めた cpuMate がネットへ、ネット際から
       * 始めた cpu がベースラインへとポイント中にすれ違っていた（ユーザー報告）。
       * you チームは人間が自由に動くので、相方(youMate)を前衛のまま固定する。
       */
      this.frontOf = { you: 'youMate', cpu: 'cpuMate' };
      /** true の間、ボールはトス中（重力で上下するだけ）。溜めキーを離して打つまで待つ。 */
      this.tossActive = false;
      /**
       * true の間、CPU/AI（cpu・cpuMate・youMate）のサーブ前トスを重力任せで上下させる。
       * tossActive は「自分（人間）が離すまで待つ」入力待ちの意味も兼ねる（movePlayers()の
       * 動作停止やchargeStart()の分岐に使われる）ため、AIのサーブでも流用すると人間側の
       * 移動まで止まってしまう。AI 専用のトスなので別フラグにする。
       */
      this.aiTossActive = false;
      /**
       * サーブを振り出して、まだ当たっていない間だけ
       * { who: 振り出した選手, t: 当たるまでの残り秒数, y: 当たる高さ } が入る。
       * それ以外は null。swingServe() 参照。
       */
      this.serveSwing = null;
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
      /** flashCall() が最後に出したコールの番号（古いコールの消去タイマーを無効にする） */
      this.flashCallId = 0;
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
      /**
       * ダブルスの前衛が、いま飛んできている1球に対して「ポーチに出る」と決めたか。
       * 相手が打った瞬間に球ごと1回だけ抽選し（updateReactTimers）、次の球まで持ち越さない。
       * true の間だけ、前衛は構え位置ではなく ai.poachRun() の迎撃点へ全力で走る。
       */
      this.poachCommit = { cpu: false, cpuMate: false, youMate: false };
      /**
       * AI の「救済技」（縮地・飛びつきボレー。Extreme のみ）を、いま飛んできている1球に
       * 対して出す気でいるか。ポーチ（poachCommit）と同じく相手が打った瞬間に球ごと1回だけ
       * 抽選する（updateReactTimers → rollAiRescue）。**毎フレーム引いてはいけない**：
       * どちらも「条件を満たしたフレームで出す」判定なので、フレームごとに CHANCE を
       * 引くと条件を満たした最初の数フレームでほぼ必ず当たり＝確率の意味がなくなる。
       */
      this.dashCommit = { cpu: false, cpuMate: false, youMate: false };
      this.diveCommit = { cpu: false, cpuMate: false, youMate: false };
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
       * このポイント中に吹いている風（加速度、m/s²）。wind＝横(±x)、windZ＝前後(±z。+z＝
       * 人間のチームから相手側へ吹く＝人間にとっての追い風)。newPoint() で決め直す。
       * サーブの飛翔（トス〜1本目の着地）は風の影響を受けない（サーブ自体のバランス調整を
       * 崩さないため）。ball.wind/windZ は beginServe() で0にリセットし、hit()（サーブの返球も
       * 含む）のたびにこの値へ差し替えることで、「サーブは常に無風、返ってきてからのラリー
       * だけ風に流される」という区別を作っている。
       */
      this.wind = 0;
      this.windZ = 0;
      /**
       * 直近の線審のコール（callLine()）。コールのたびに新しいオブジェクトに替わり、表示側
       * （scene/world.js）はそれを見て担当の線審に合図を出させ、main.js は decisive（この
       * コールでポイントが決まった）を見てリプレイの前に一拍置く。ポイントごとに null へ戻す
       * （newPoint()）。
       */
      this.lineCall = null;
      /**
       * 直近のバウンド（bounce()）。接地点と、弾む直前の速度。コールが出たバウンドなら call に
       * その lineCall が入る。バウンドのたびに新しいオブジェクトに替わり、表示側はそれを見て
       * クレーのボールマークを残す（scene/marks.js）。
       */
      this.lastBounce = null;
      /**
       * この会場に吹いている卓越風（試合を通してほぼ一定の向きと強さ）。angle は +z（人間の
       * チームから相手側）を0とし、+x 側へ回る向き（rad）。ゲームの座標で持つので、チェンジ
       * エンズで選手が入れ替わるたびに π 回す（swapEnds()）。ポイントごとの風は、ここから
       * windStrength・windAngleOff だけ揺れたもの（newPoint() が前のポイントから少しずつ動かす）。
       */
      const baseStrength = rand(WIND.BASE_MIN, WIND.BASE_MAX);
      this.windBase = { angle: rand(-Math.PI, Math.PI), strength: baseStrength };
      this.windStrength = baseStrength;
      this.windAngleOff = 0;
      /**
       * 両チームが試合開始時と反対のエンドにいるか（チェンジエンズのたびに反転する）。
       * ゲームの座標は常に「人間のチームが手前（-z）」のままにしておき、入れ替わるのは会場の
       * ほう＝表示側（scene/world.js）が審判台・線審・観客・太陽を180°回して映す（コートと
       * ネットは点対称なので回しても同じ）。ロジック側で効くのは、会場に吹いている風の向き
       * だけ（swapEnds()）。
       */
      this.endsSwapped = false;
      /**
       * チェンジエンズの最中だけ { kind, t, hold, swapped, rested } が入る（それ以外は null）。
       * kind＝scoring.changeoverAfter() の休憩の種類、t＝始まってからの秒数、hold＝暗転した
       * まま待つ秒数、swapped＝もう入れ替えて次のポイントの構えに入ったか、rested＝休憩ぶんの
       * スタミナをどこまで戻したか(0〜1)。tickChangeover() が進める。
       */
      this.changeover = null;
      /**
       * 練習モード（startPractice()）の進み具合。試合中は null。
       * { lesson, done, tries, rep, cleared, shot, fired, target }：lesson＝config.PRACTICE の
       * レッスン、done／tries＝成功した本数／打った本数、rep＝何本目か（立ち位置・出す球を
       * 順に使い回す）、cleared＝目標の本数に届いたか、shot／fired＝この1本で自分が打った
       * 打ち方（hit()/serve() が入れる）と出た必殺技（spendSpecial() が入れる）、
       * target＝移動のレッスンの目印（表示もここを読む）。
       */
      this.practice = null;
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
     * 手を出さない。
     *
     * 一度でも返球された後は、雁行陣（前衛＝frontOf、後衛＝その相方）の役割で決める
     * （ai.pairResponder）：前衛がポーチできるならポーチ優先、そうでなければ落下点が
     * どちらの持ち場かで決まる。単に「落下点に近い方」だと中途半端な深さの球のたびに
     * 前衛が下がって雁行が崩れていた。
     * パートナーに「下がれ」を指示している間は前衛がいない＝従来どおり近い方（isResponder）。
     * @param {'you'|'cpu'} team 応答する側のチーム
     * @returns {'you'|'youMate'|'cpu'|'cpuMate'}
     */
    doublesResponder(team) {
      if (this.serveInFlight) return this.receivingPlayer(team, this.match.serveSide);
      const frontKey = this.frontOf[team];
      const backKey = MATE_OF[frontKey];
      if (!this.hasFrontPlayer(team)) {
        return isResponder(this[backKey], this[frontKey], this.ball) ? backKey : frontKey;
      }
      return pairResponder(this[backKey], this[frontKey], this.ball) === 'back' ? backKey : frontKey;
    }

    /**
     * そのチームが雁行陣を敷いているか（＝相方が前衛として前にいるか）。
     * you チームだけは人間がパートナーに「下がれ」（E）を指示できるので、その間は
     * 2人とも後衛＝前衛なしとして扱う。
     * @param {'you'|'cpu'} team
     */
    hasFrontPlayer(team) {
      if (!this.doubles) return false;
      return team === 'cpu' || this.youMateFormation !== 'back';
    }

    /**
     * ダブルスで、who から見た相手ペアの並び。
     * - near / far：単純にネットに近い方／遠い方（常にどちらも入る）
     * - atNet：near がネット際（DOUBLES.FRONT_MAX_Z 以内）にいればその選手。ボレーの狙いを
     *   「その人の逆」にするために使う（目の前の相手へ打ち込んで至近距離のボレー合戦に
     *   なるのを防ぐ）。2人とも下がっていれば null。
     * - front / back：雁行（前衛がネット際・後衛はそれより深く）になっているときだけ
     *   front が入る。2人とも下がっている／2人とも前に出ているときは front=null で、
     *   後衛の配球は従来どおり（cpuShot）に戻る。
     * @param {'you'|'youMate'|'cpu'|'cpuMate'} who 打つ本人
     * @returns {{near: object, far: object, atNet: object|null, front: object|null, back: object}}
     */
    doublesFoes(who) {
      const foeTeam = TEAM_OF[who] === 'cpu' ? 'you' : 'cpu';
      const main = this.actor(foeTeam);
      const mate = this.actor(foeTeam === 'you' ? 'youMate' : 'cpuMate');
      const near = Math.abs(main.z) <= Math.abs(mate.z) ? main : mate;
      const far = near === main ? mate : main;
      const atNet = Math.abs(near.z) <= DOUBLES.FRONT_MAX_Z ? near : null;
      const gankou = atNet && Math.abs(far.z) > DOUBLES.FRONT_MAX_Z;
      return {
        near, far, atNet, front: gankou ? near : null, back: far,
      };
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
     * 定位置と、次のポイント開始時の立ち位置（placeDoublesMate）の両方に反映される。
     * サーブ待ちの間は、その場で立ち位置も置き直す。ただしパートナーがサーバー／
     * レシーバーの番は動かさない（立つ位置がルールで決まっている）：そのときの指示は
     * ラリーの定位置にだけ効く（＝打ってから前へ出る／下がったままでいる）。
     * @param {'net'|'back'} formation
     */
    setYouMateFormation(formation) {
      if (!this.doubles) return;
      const changed = this.youMateFormation !== formation;
      this.youMateFormation = formation;
      const moved = this.placeBeforeServe('youMate');
      if (!changed && !moved) return;
      const order = formation === 'net' ? '前へ' : '下がれ';
      const duty = this.phase === 'serve' && this.serveDuty('youMate');
      this.flashCall('パートナー', duty ? `${order}（${duty}担当なので、打ってから）` : order);
    }

    /**
     * ダブルスで、サーブ前の自分（人間）の立ち位置を指示する。'net'＝前（ネット際）、
     * 'back'＝後ろ（ベースライン付近）。サーブ待ちの間（phase==='serve'）だけ効き、
     * その場で置き直す。自分がサーバー／レシーバーの番は動かさない。
     * 選んだ位置は覚えておき、次に相方が担当する番でもそこに立つ（youFormation）。
     * @param {'net'|'back'} formation
     */
    setYouFormation(formation) {
      if (!this.doubles || this.phase !== 'serve') return;
      const duty = this.serveDuty('you');
      if (duty) {
        this.flashCall('自分', `${duty}担当は立ち位置を変えられません`);
        return;
      }
      this.youFormation = formation;
      this.placeBeforeServe('you');
      this.flashCall('自分', formation === 'net' ? '前に立つ' : '後ろに立つ');
    }

    /**
     * いまのポイントで who がサーバーなら 'サーブ'、レシーバーなら 'レシーブ'、
     * どちらでもない（相方が担当している）なら null。
     * @param {'you'|'youMate'|'cpu'|'cpuMate'} who
     */
    serveDuty(who) {
      if (this.servingPlayer() === who) return 'サーブ';
      if (this.receivingPlayer(opponent(this.server), this.match.serveSide) === who) return 'レシーブ';
      return null;
    }

    /**
     * サーブ待ちの間に限り、who（サーバー／レシーバーでない方）を指示どおりの構え位置へ
     * 置き直す。ポイント開始時に beginServe() が置くのと同じ位置（placeDoublesMate）。
     * @returns {boolean} 置き直したら true
     */
    placeBeforeServe(who) {
      if (this.phase !== 'serve' || this.serveDuty(who)) return false;
      this.placeDoublesMate(who);
      return true;
    }

    /**
     * 指示を受けた合図のような短いコールを、TIMING.ORDER_CALL 秒だけ出す。続けて押されたら
     * 後のコールを出し直し、前のコールの消去タイマーでは消さない（F→E と続けて押すと、
     * E の返事が F のタイマーで一瞬で消えていた）。
     */
    flashCall(big, sub) {
      this.hooks.call(big, sub);
      const id = ++this.flashCallId;
      this.after(TIMING.ORDER_CALL, () => {
        if (id === this.flashCallId) this.hooks.clearCall();
      });
    }

    /**
     * 溜めキー（B＝フラット／V＝トップスピン／C＝スライス。クリックも可）を押した瞬間。
     * サーブは押しっぱなしにする間トスが上がり続け、離した瞬間に打つ
     * （＝トス開始とテイクバックの溜め開始は同じ1回の押下）。ラリー中はテイクバックを
     * 溜め始める。実際に打つのは chargeRelease()（離した瞬間）。
     * @param {'flat'|'top'|'slice'} [spin] 押したキーに対応するスピン。省略時はフラット。
     * @param {boolean} [kick] キックサーブのキー（K）。自分のサーブのトスを上げるときだけ
     *   受け付け、キックサーブを選んであれば（回数が残っていれば）それで打つ。
     * @returns {boolean} 溜め（トス）を始めたか。K はサーブ以外では何もしない（false）ので、
     *   input.js はそのときキーを「溜めているキー」として握らない（B/V/C を塞がない）。
     */
    chargeStart(spin = 'flat', kick = false) {
      // 自分がサーブする番（＝ダブルスで味方が回ってきているときは対象外）のときだけ反応する
      const myServe = this.phase === 'serve' && this.servingPlayer() === 'you';
      // もう振り出していて、トスが落ちてくるのを待っているだけ（swingServe()）。押し直しても
      // 2回目のスイングにはならない。
      if (myServe && this.serveSwing) return false;
      // キックサーブのキーは、自分のサーブでトスを上げるときにしか意味がない
      if (kick && !(myServe && !this.tossActive)) return false;
      if (myServe && !this.tossActive) {
        this.tossBall();
        this.you.charging = true;
        this.you.chargeTime = 0;
        // サーブのスピン（V/C＝トップスピン／スライス）もトスを上げた瞬間に固定する。
        // グラウンドストロークと同じ理由で、当たる瞬間まで押し続けなくてよい。
        this.you.chargeSpin = spin;
        // キックサーブは B/V/C とは別のキー（K）で上げたトスだけ。以前は「自分のサーブ」
        // だけが条件で、技を選んでいると回数が残る限り**どのサーブもキックサーブになり**、
        // 普通のサーブを打ち分けられなかった（ユーザー報告）。
        this.you.chargeKick = kick;
        return true;
      }
      // レシーブ側は、サーブが飛んでくる前からラケットを引いて待てる（実際のテニスと
      // 同じ「テイクバックして待つ」）。以前はここが素通りで、サーブが打たれて
      // phase が 'rally' になるまで溜め始めることすらできず、0.6秒しかない猶予の中で
      // 「反応する→走る→押す→離す」を全部やる必要があった（＝レシーブが返せない一因）。
      // フォア/バックはボールがまだ静止していて決められないので、サーブが打たれた
      // 瞬間（serve()）に確定させる。
      // 'serve' だけでなく 'fault'（1本目が外れてから2本目の構えに入るまで）と
      // 'over'（ポイントが決まってから次のサーブ待ちに入るまで）も受け付ける：
      // この1〜2秒の間に押してしまうと、以前はどこにも引っかからず握り直しになっていた
      // （キーは押されたままなので keydown は二度と来ない）。tickCharge() 側で
      // 実際に溜まり始めるのは 'serve'/'fault' になってからなので、ここで構えを
      // 受け付けても「ポイント間に溜めておける」ことにはならない。
      if (this.servingPlayer() !== 'you'
        && (this.phase === 'serve' || this.phase === 'fault' || this.phase === 'over')) {
        this.you.charging = true;
        this.you.chargeTime = 0;
        this.you.chargeSpin = spin;
        this.you.chargeStroke = null;
        return true;
      }
      // 飛びつきボレーで飛び込んでいる最中は構え直せない（当たるのを待つだけ）
      if (this.phase === 'rally' && this.you.dive) return false;
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
        return true;
      }
      return false;
    }

    /**
     * 溜めキー（B/V/C）／クリックを離した瞬間。溜めた量（サーブはタイミング）に応じた威力で打つ。
     * その場面の条件を満たしていれば、必殺技が1つだけ自動で乗る（specialAim）。
     */
    chargeRelease() {
      if (!this.you.charging) return;
      const myServe = this.phase === 'serve' && this.servingPlayer() === 'you';
      this.you.swingCharge = myServe
        ? this.serveTimingPower(this.you.chargeTime)
        : clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);
      // 離した瞬間に「必殺技が乗るか」を確定させる（＝この1振りにだけ乗る）。
      // specialAim() はラリー中「溜めている間」だけ候補を出すので、charging を
      // 落とすより先に聞くこと。回数を減らすのは実際に技が起きたとき（spendSpecial）。
      const armed = this.specialAim();
      const move = (armed && armed.move) || null;
      this.armSpecial(move); // 技が出ないときは null で上書きする（前の1振りを持ち越さない）
      this.you.charging = false;
      // ゲージの線を超えて溜めたぶんだけ、この1本を外す抽選をここで引く（超えていなければ
      // 確率0＝必ず外れない）。実際にどう外れるかは serve() が決める。
      // キックサーブだけは山なりに高く通すので、溜めすぎてもフォールトにしない。
      if (myServe) {
        this.you.serveMiss = move !== 'kickServe'
          && Math.random() < this.serveFaultChance(this.you.chargeTime);
      }

      if (myServe && this.tossActive) {
        this.swingServe('you'); // トスがまだ高ければ、落ちてきて届いたところで当たる
      } else if (this.phase === 'rally') {
        this.you.swingConnected = false; // この1振りはまだ当たっていない
        // 縮地だけは打点まで瞬間移動するぶん、届くまでスイングの有効時間を伸ばす
        // （通常の SWING_WINDOW のままでは、跳んだ先で待っている間に振り終わってしまう）。
        this.you.swing = move === 'shukuchi' ? this.dashToBall() : this.swingWindow();
        this.you.swingSpan = this.you.swing; // 引っ張り／流しの換算（swingWaited()）に使う
        // 跳んで打つ1打なら、まだ跳んでいなければここで跳ぶ。ふつうは tickLeap() が
        // 溜めている間に（球が届く少し前に）跳ばせているので、ここに来るのは
        // 「球がまだ遠いのに離した」ような場合だけの保険。
        this.startLeap(this.leapKind(move, this.you.swingCharge));
      }
    }

    /* ------------------------------------------------------------ 必殺技 */

    /**
     * 「いま溜めキーを離したら何が起きるか」。HUD の表示と、chargeRelease() の実際の
     * 発動判定の両方がこれ1つを通る（＝出ると出た技が必ず出る）。専用の操作キーはなく、
     * 条件を満たしていれば普通に打つだけで自動的に乗る。
     * 出すのは「これから打つ」場面だけ：ラリー中は溜めている間、サーブは自分の番の間。
     * 必殺技を1つも装備していない／打つ場面ではないときは null。
     * @returns {{move:string|null, label:string|null, spent:string|null, usesLeft:number}|null}
     *   move が null なら「この場面で出せる技がない（または残り0回）」。
     */
    specialAim() {
      if (!this.specials.length) return null;
      const serving = this.phase === 'serve' && this.servingPlayer() === 'you';
      if (!serving && !(this.phase === 'rally' && this.you.charging)) return null;
      // サーブで出る技はキックサーブだけで、それは K で上げたトスにしか乗らない。
      // トスを上げる前は「K で打てる」ことを案内し、B/V/C で上げたトスには何も出さない。
      if (serving && !this.you.chargeKick) {
        if (this.tossActive || this.specials.indexOf('kickServe') === -1
          || this.usesLeft('kickServe') <= 0) return null;
        return {
          move: null, label: null, spent: null, usesLeft: this.usesLeft('kickServe'), hint: KICK_HINT,
        };
      }
      const ctx = this.specialContext(); // 打点の先読みは重いので1回だけ作って使い回す
      const move = this.pickSpecial(ctx);
      // 出せる技がないときだけ、「回数さえ残っていれば出せた技」を探して理由を伝える
      // （残り0の技が場面に合っているのか、そもそも合う技がないのかで案内を変える）。
      const spent = move ? null : this.pickSpecial(ctx, false);
      return {
        move,
        label: move ? SPECIAL_LABEL[move] : null,
        spent: spent ? SPECIAL_LABEL[spent] : null,
        usesLeft: move ? this.usesLeft(move) : 0,
      };
    }

    /**
     * バギーホイップのストレート（ポール回し）に必要な横加速度(m/s²)。
     * 曲がりを織り込んだ軌道の横位置は、solveShot() が「flight 秒後にちょうど target へ
     * 届く」初速を解くので
     *   x(t) ＝ 打点と target を結ぶ直線補間 ＋ ½c·t·(t − flight)
     * になる（t < flight なので後ろの項は c と逆向き＝いったん外へ膨らむ）。これを
     * 「ネット面(z=0)を通過する瞬間にポストの POST_CLEAR だけ外側を通る」で解く。
     * コートの内側すぎて回りきれない（必要な曲がりが MAX_CURVE を超える）ときは、
     * ふつうの曲がるストレート（BUGGY.LINE_CURVE）として打つ。
     * @param {{x:number, z:number}} target 落とす場所
     * @param {number} flight 飛翔時間(秒)
     * @param {string} who 打つ選手（手前/奥で曲がる向きもネットを通る向きも反転する）
     * @returns {number} ball.curve に入れる横加速度
     */
    aroundPostCurve(target, flight, who = 'you') {
      const { BUGGY } = SPECIAL;
      const sign = buggyCurveSign(who); // 曲がる向き（コート中央へ向かう側）
      const plain = sign * BUGGY.LINE_CURVE; // 回りきれないときのふつうの曲がるストレート
      const from = this.ball; // まだ打点のまま（solveShot が書き換えるのは速度だけ）
      const vz = (target.z - from.z) / flight;
      if (!(vz * NET_DIR[who] > 0)) return plain; // 相手コートへ向かっていない
      const tNet = -from.z / vz; // ネット面(z=0)を通過する時刻
      if (!(tNet > 0 && tNet < flight)) return plain;
      const clearX = RACKET_SIDE[who] * (COURT.NET_HALF + BUGGY.POST_CLEAR);
      const chordX = from.x + (target.x - from.x) * (tNet / flight);
      const need = (2 * (clearX - chordX)) / (tNet * (tNet - flight));
      // 大きさで比べる（向きは sign 側が持っている）。既にポストの外にいる等で
      // ふつうの曲がり以下しか要らない／内側すぎて回りきれない、のどちらも plain。
      const mag = need * sign;
      if (!(mag > BUGGY.LINE_CURVE)) return plain;
      return mag > BUGGY.MAX_CURVE ? plain : need;
    }

    /**
     * いま振ったらフォアハンドとバックハンドのどちらになるか。溜め始めに固定した向き
     * （chargeStroke）があればそれ、なければ今のボールとの位置関係で見積もる。
     * @returns {'forehand'|'backhand'}
     */
    currentStroke() {
      return this.you.chargeStroke || classifyStroke('you', this.ball, this.you);
    }

    /**
     * その技がこのゲームであと何回使えるか。回数は選手ごとに独立していて、
     * 人間は this.specialUses、AI は actor.specialUses に持つ。
     * @param {string} move
     * @param {string} [who] 省略時は人間（'you'）
     */
    usesLeft(move, who = 'you') {
      const from = who === 'you' ? this.specialUses : this.actor(who).specialUses;
      return from[move] || 0;
    }

    /**
     * AI_SPECIAL_MATCH に渡す「当たる瞬間の場面」。hit() の途中で作るが、テストや
     * 見積もりからも同じものを作れるように切り出してある（引数を省けば今の状態から作る）。
     * @param {string} who
     * @param {string} [stroke] フォア／バック（省略時は今のボールとの位置関係で見る）
     * @param {{smash:boolean, volley:boolean}} [natural] 技が乗らなければどうなる1打か
     */
    aiSpecialContext(who, stroke, natural) {
      const ball = this.ball;
      const player = this.actor(who);
      return {
        who,
        ball,
        player,
        bounces: ball.bounces,
        contactY: ball.y,
        stroke: stroke || classifyStroke(who, ball, player),
        natural: natural || naturalStroke(this, who, ball, player, 0),
      };
    }

    /**
     * いまの難易度で AI が使える技の一覧（＝回数を配る対象でもある）。
     * Hard は守備範囲を広げない8種（SPECIAL.AI.MOVES）、Extreme は飛びつきボレー・縮地を
     * 含む全10種（MOVES_ALL）。どちらを使うかは難易度プリセットの CPU.SPECIAL_ALL_MOVES。
     * @returns {string[]}
     */
    aiMoves() {
      return CPU.SPECIAL_ALL_MOVES ? SPECIAL.AI.MOVES_ALL : SPECIAL.AI.MOVES;
    }

    /**
     * Hard の AI がこの1打に乗せる必殺技（無ければ null）。人間の pickSpecial() と
     * 同じ「並び順＝優先度、上から最初に条件の合った1つ」の拾い方をする。
     * 回数が残っていない技は飛ばして次の候補へ落ちる。
     * 条件がそろっても SPECIAL.AI.CHANCE で外すので、同じ場面で必ず出るわけではない
     * （回数は実際に出たときだけ減るので、外れたぶんは後の場面に取っておかれる）。
     * @param {string} who cpu / cpuMate / youMate
     * @param {object} ctx AI_SPECIAL_MATCH に渡す「当たる瞬間の場面」
     * @returns {string|null}
     */
    pickAiSpecial(who, ctx) {
      if (!this.aiSpecialsOn()) return null;
      // 飛びつきボレー・縮地（Extreme のみ）は AI_SPECIAL_MATCH を持たない＝ここでは拾われない。
      // どちらも「当たる瞬間」より前に決まる技なので、それぞれ swingAiAt() / tryAiDash() が持つ。
      const found = this.aiMoves().find((move) => AI_SPECIAL_MATCH[move]
        && this.usesLeft(move, who) > 0
        && AI_SPECIAL_MATCH[move](this, ctx));
      if (!found) return null;
      return Math.random() < CPU.SPECIAL_CHANCE ? found : null;
    }

    /**
     * Hard の AI がこのサーブに乗せる必殺技（無ければ null）。ラリー中の技と違って
     * 場面の条件は「自分のサーブであること」だけなので、ここは確率だけで決める。
     * @param {string} who
     * @returns {string|null}
     */
    pickAiServeSpecial(who) {
      if (!this.aiSpecialsOn()) return null;
      if (this.aiMoves().indexOf('kickServe') === -1) return null;
      if (this.usesLeft('kickServe', who) <= 0) return null;
      return Math.random() < CPU.SPECIAL_CHANCE ? 'kickServe' : null;
    }

    /**
     * AI が必殺技を使える状態か。難易度 Hard（CPU.SPECIALS）が前提で、既定ではさらに
     * 「人間が技を1つ以上選んでいること」も要る（スタート画面で何も選ばなければ
     * 従来とまったく同じゲーム、という約束を壊さないため。SPECIAL.AI 参照）。
     */
    aiSpecialsOn() {
      // 練習モードの CPU は球出し役なので、技は使わない（レッスンで技を装備していても）
      if (!CPU.SPECIALS || this.practice) return false;
      return !SPECIAL.AI.REQUIRE_PLAYER_SPECIALS || this.specials.length > 0;
    }

    /**
     * 装備している技のうち、この場面で出せる最初のひとつ（SPECIAL_MOVES の並び順＝優先度）。
     * 残り回数が尽きた技は飛ばして次の候補へ落ちる＝「ダンクスマッシュはもう使ったので、
     * 同じ場面でも鷹の目が出る」という拾い方になる。
     * @param {object} [ctx] specialContext()。省略時はその場で作る
     * @param {boolean} [requireUses] false なら回数を無視して「場面に合う技」だけを探す
     * @returns {string|null}
     */
    pickSpecial(ctx, requireUses = true) {
      const context = ctx || this.specialContext();
      const found = SPECIAL_MOVES.find((m) => this.specials.indexOf(m.key) !== -1
        && (!requireUses || this.usesLeft(m.key) > 0)
        && SPECIAL_MATCH[m.key](this, context));
      return found ? found.key : null;
    }

    /**
     * 必殺技の判定に使う「今の場面」。打点の先読み（predictContact）は技ごとに広がる
     * リーチが違うだけなので、同じリーチの組み合わせは1回しか計算しない。
     * 縮地の跳び先（dashSpot）も、聞かれたときに1回だけ計算する。
     */
    specialContext() {
      const contacts = {};
      let dash;
      let unreachable;
      let peak;
      return {
        serving: this.phase === 'serve' && this.servingPlayer() === 'you',
        // いまの溜め量(0〜1)。自動発動なので「どれくらい本気の1打か」を条件に使える技がある。
        charge: clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1),
        // 押しているキーの球種（B=flat / V=top / C=slice。chargeStart() の瞬間に固定）。
        // 「その打ち方でしか成立しない技」の条件に使う。
        spin: this.you.chargeSpin,
        // このサーブのトスをキックサーブのキー（K）で上げたか
        kick: this.you.chargeKick,
        contact: (move) => {
          const r = specialReach(move);
          const key = `${r.mult}:${r.y}`;
          if (!(key in contacts)) contacts[key] = this.predictContact(r.mult, r.y);
          return contacts[key];
        },
        // バウンド後の球を、この1振りでいちばん高く捉えられる高さ(m)。
        // 「高い球を叩く」技（ジャックナイフ）の判定に使う。
        // 高さの線はジャックナイフのもの（この先読みを使う技がそれだけなので）。
        peak: () => {
          if (peak === undefined) peak = this.contactPeak(SPECIAL.JACK.MIN_Y);
          return peak;
        },
        dashSpot: () => {
          if (dash === undefined) dash = this.dashSpot();
          return dash;
        },
        dashUnreachable: () => {
          if (unreachable === undefined) unreachable = this.dashUnreachable();
          return unreachable;
        },
      };
    }

    /**
     * この1振りに必殺技を乗せる（回数はまだ減らさない）。実際に消費するのは
     * spendSpecial()＝「本当にその技が起きた瞬間」で、空振りしたら回数は減らない
     * （自動発動なので、届かない球に振ってしまっただけで技を失うのは理不尽なため）。
     * **技が乗らない振りでは必ず null を渡すこと**：前の1打の技は振り終わるまで
     * this.you.special に残っている（フォーム表示のため）ので、ここで上書きしないと
     * 「連続して振ったとき、2振り目にも前の技が乗って回数がもう1回減る」ことになる。
     * @param {string|null} move
     */
    armSpecial(move) {
      this.you.special = move || null;
    }

    /**
     * 必殺技が実際に起きた。回数を1つ減らし、音とコールを出す。
     * 呼ぶのは「その技が確定した瞬間」：ふつうの技は当たった瞬間（hit）、サーブは
     * 打った瞬間（serve）、縮地は跳んだ瞬間（dashToBall。跳んだ時点で効果は済んでいる）。
     * @param {string} move
     * @param {string} [label] 呼び名の上書き（同じ技でもコースで呼び方が変わる場合に使う）
     */
    spendSpecial(move, label, who = 'you') {
      const actor = this.actor(who);
      if (this.practice && who === 'you') this.practice.fired = move;
      if (who === 'you') this.specialUses[move] = this.usesLeft(move) - 1;
      else actor.specialUses[move] = this.usesLeft(move, who) - 1;
      this.stats[TEAM_OF[who]].specials++;
      actor.specialLabel = label || SPECIAL_LABEL[move];
      this.hooks.sound('special');
      this.hooks.call(`${actor.specialLabel}！`, '必殺技');
      // ポイントが決まった後のコール（ポイント／ウィナー！）を消してしまわないよう、
      // まだラリーが続いているときだけ引っ込める。
      this.after(SPECIAL.CALL_T, () => {
        if (this.phase === 'rally') this.hooks.clearCall();
      });
    }

    /**
     * ゲームが替わった（またはタイブレークでサーブ権が移った）ときに、全技の使用回数を戻す。
     * 人間だけでなく AI（Hard で技を使う）の持ち分も同じタイミングで回復させる。
     */
    refreshSpecials() {
      SPECIAL_MOVES.forEach((m) => { this.specialUses[m.key] = SPECIAL.USES_PER_GAME; });
      const moves = this.aiMoves();
      ACTORS.forEach((who) => {
        if (who === 'you') return;
        const uses = this.actor(who).specialUses;
        // 前の難易度で配った持ち分を残さない（Extreme→Hard と選び直したとき、
        // Hard では使えないはずの技の回数が残ったままになるのを防ぐ）。
        Object.keys(uses).forEach((key) => { delete uses[key]; });
        moves.forEach((move) => { uses[move] = CPU.SPECIAL_USES; });
      });
    }

    /**
     * 縮地：これから打てる打点を先読みし、そこへ立てる位置へ瞬間移動する。
     * 跳ぶ前の位置は残像（you.dash、表示専用）として残す。
     * @returns {number} この1打のスイングの有効時間(秒)。打点まで待てる長さに伸ばす。
     */
    dashToBall() {
      const spot = this.dashSpot();
      if (!spot) return PLAYER.SWING_WINDOW;
      // 跳んだ時点で効果は済んでいる（この後に空振りしても回数は戻らない）。
      this.spendSpecial('shukuchi');
      this.you.dash = { x: this.you.x, z: this.you.z, t: SPECIAL.DASH.FX_T };
      this.you.x = spot.x;
      this.you.z = spot.z;
      this.you.vx = 0;
      this.you.vz = 0;
      this.you.speed = 0;
      this.you.fwd = 0;
      // 打点に着くまでの時間ぶん（＋わずかな余裕）だけ振り続けられるようにする。
      return clamp(spot.t + SPECIAL.DASH.WINDOW_MARGIN, PLAYER.SWING_WINDOW, SPECIAL.DASH.WINDOW);
    }

    /**
     * AI の縮地（Extreme のみ。SPECIAL.AI.MOVES_ALL 参照）を、必要なら全員ぶん出す。
     * 人間は「溜めを離した瞬間」に跳ぶ（chargeRelease → dashToBall）が、AI には溜めが
     * 無いので、飛んできた球がネットを越えた瞬間に1回だけ判断する（tryAiDash）。
     * **movePlayers() のいちばん
     * 最初に呼ぶこと**：移動量は「このフレームの開始位置からどれだけ動いたか」で測って
     * いるので（moveTowards）、位置を記録した後に瞬間移動すると、その1フレームだけ
     * 実速度もスタミナ消費も跳ね上がった扱いになる。
     */
    tickAiDash() {
      if (!this.aiSpecialsOn() || this.aiMoves().indexOf('shukuchi') === -1) return;
      ACTORS.forEach((who) => {
        if (who === 'you') return;
        // シングルスでコートに立っているのは cpu だけ。相方（cpuMate / youMate）は状態としては
        // 居続けるので、ここで外さないと「見えない選手が縮地を使い、その回数まで減る」ことになる
        // （実測：1ゲーム3回のはずの縮地が7回出ていた原因）。
        if (!this.doubles && who !== 'cpu') return;
        this.tryAiDash(who);
      });
    }

    /**
     * その AI が、いま飛んできている球に対して縮地を出すか。出すなら打点へ瞬間移動する
     * （跳んだ時点で効果は済んでいる＝人間の dashToBall() と同じ扱い）。
     * 条件は人間の SPECIAL_MATCH.shukuchi と同じ3つ——跳び先で打てること（dashSpotFor）・
     * その跳び先が十分遠いこと（DASH.MIN_DIST）・走ったのでは間に合わないこと——で、
     * 人間の「溜めを離した」に当たるのが球ごと1回の抽選（dashCommit）。
     * 追う担当でない選手（ダブルスの相方）は出さない：2人とも同じ球へ跳んでしまうため。
     * @param {string} who cpu / cpuMate / youMate
     */
    tryAiDash(who) {
      if (!this.dashCommit[who]) return;
      if (this.phase !== 'rally' || !this.ball.live) return;
      if (TEAM_OF[who] === this.ball.last) return;   // 自陣へ向かってくる球だけ
      if (this.recoverTimers[who] > 0) return;       // 打った直後は動けない（硬直中）
      if (this.actor(who).dive) return;              // 飛びつきボレーで飛び込んでいる最中
      if (this.reactTimers[who] > 0) return;         // まだ反応できていない
      const actor = this.actor(who);
      // ボールが自陣に入るまで待つ（ネットの向こうにある間は判断しない）。相手が打った
      // 瞬間に跳ぶと、まだネットも越えていない球に対して消えて現れることになる。
      if (this.ball.z * actor.netDir >= PLAYER.NET_MARGIN) return;
      if (this.doubles && this.doublesResponder(TEAM_OF[who]) !== who) return;
      // **この球についての判断はこの1回だけ**（ネットを越えてきた最初のフレーム＝すでに
      // 半分走った地点で「この足では間に合わない」と見たとき）。毎フレーム見てはいけない：
      // 下で比べる「残り時間に走れる距離」は打点が近づくほど短くなるので、どんな球も
      // いずれ「間に合わない」側に倒れる＝条件を満たすたび必ず跳ぶことになる
      // （実測：毎フレーム判定だと1800秒で555回＝1ポイントに2回も跳んでいた）。
      this.dashCommit[who] = false;
      if (this.usesLeft('shukuchi', who) <= 0) return;
      const spot = this.dashSpotFor(who);
      if (!spot) return;
      const dist = Math.hypot(spot.x - actor.x, spot.z - actor.z);
      // 跳ぶ意味がある距離か（人間の「ボールとの距離」＝SPECIAL.DASH.MIN_DIST に当たる線を、
      // AI では「瞬間移動で詰める距離」で見る。目の前の球に跳んでも技を捨てるだけ）。
      if (dist < SPECIAL.DASH.MIN_DIST) return;
      // 走って間に合うなら跳ばない＝人間の dashUnreachable() に当たる線。期限は
      // 「打点に球が来る時刻」（spot.t）で、人間版が使う「次の着地」より正確：AI が打つのは
      // バウンド後に上がってきた頂点なので、着地の瞬間を期限にすると実際には間に合う球まで
      // 「間に合わない」と見てしまう（実測：それだと1800秒で458回＝ほぼ毎ポイント跳んでいた）。
      const canRun = PLAYER.CPU_CHASE * actor.attr.speed * spot.t * SPECIAL.DASH.RUNNABLE
        + PLAYER.CPU_REACH * actor.attr.reach;
      if (dist <= canRun) return;
      this.spendSpecial('shukuchi', undefined, who);
      actor.dash = { x: actor.x, z: actor.z, t: SPECIAL.DASH.FX_T };
      actor.x = spot.x;
      actor.z = spot.z;
      actor.speed = 0;
      actor.fwd = 0;
      // 跳んだ先では「走らされていない」扱いにする。人間が縮地の後にきちんと溜めて打てる
      // （dashToBall がスイングの有効時間を打点まで伸ばす）のと同じ意味で、AI 側で
      // 「余裕のあるなし」を持っているのがこの2つ（hit() の stretch / settleT）。
      actor.chaseDist = 0;
      actor.settleT = 0;
    }

    /**
     * AI の縮地の跳び先＝**その球を打つために本来そこへ走りたかった場所**（ai.chasePosition）。
     * 人間の dashSpot() は「軌道のうち打てる区間の真ん中」を選ぶが、AI に同じものを渡しては
     * いけない：AI は打てる条件がそろった最初のフレームで振るので、軌道の上に立たせると
     * **足元でバウンドした直後（高さ CPU_REACH_Y_MIN＝0.15m）を打つ**ことになり、そこから
     * 深く狙った返球はネットを越えられない（実測：Extreme の縮地の後の返球が1800秒で32本
     * ネットに掛かり、その全部がこの足元の打点だった）。ai.chasePosition() はバウンド後に
     * 打ちやすい高さまで上がってきた頂点（や、スマッシュ・ポーチの打点）を返すので、
     * 跳んだ先でそのまま普通の1打が打てる。
     * 跳び先で本当に打てるか（コートの外へ弾む球ではないか）は、その位置から手が届く瞬間が
     * この先にあるかで確かめる。無ければ null＝跳ばない（回数を捨てない）。
     * @returns {{x:number, z:number, t:number}|null} t＝そこに立った場合に球が打てるようになる時刻(秒)
     */
    dashSpotFor(who) {
      const ball = this.ball;
      const actor = this.actor(who);
      const dir = actor.netDir;    // +1＝you 陣地(z<0)の選手、-1＝cpu 陣地(z>0)の選手
      const side = -dir;           // ai.js の側の符号（1＝cpu 陣地 z>0）
      // 動ける範囲（youBounds() の AI 版）。ネット側の限界と後ろの限界を netDir で鏡にする。
      const nearZ = dir * PLAYER.Z_NEAR;
      const farZ = dir * -(HALF_L + PLAYER.Z_FAR_MARGIN);
      const spot = chasePosition(ball, side, actor);
      const x = clamp(spot.x, -PLAYER.X_LIMIT, PLAYER.X_LIMIT);
      const z = clamp(spot.z, Math.min(nearZ, farZ), Math.max(nearZ, farZ));
      const reach = PLAYER.CPU_REACH * actor.attr.reach;
      const hittable = (at) => at.z * dir < PLAYER.NET_MARGIN
        && at.y < PLAYER.CPU_REACH_Y && at.y > PLAYER.CPU_REACH_Y_MIN
        && !(this.serveInFlight && at.bounces < 1)
        && Math.hypot(at.x - x, at.z - z) < reach;
      const window = predictWindow(ball, hittable, SPECIAL.DASH.LEAD_T, 1);
      if (!window) return null;
      // t＝その位置に立ったとき球が打てるようになる時刻（＝間に合うかを測る期限）。
      return { x, z, t: window.enter.t };
    }

    /** いまのボールと自分の距離(m)。コート面での距離なので高さは見ない。 */
    ballDistance() {
      return Math.hypot(this.ball.x - this.you.x, this.ball.z - this.you.z);
    }

    /**
     * この球が「走っても間に合わない」か＝縮地を出す価値がある場面か。
     * 返球の期限は次の着地（サーブ以外なら、そこで2バウンド目になる＝それまでに
     * 追いつけなければ失点する球）。そこまでの距離が、残り時間に全力で走れる距離
     * （＋ラケットの届く分）より遠ければ「取れない球」とみなす。
     */
    dashUnreachable() {
      const landing = predictLanding(this.ball, SPECIAL.DASH.LEAD_T);
      if (landing.net) return false; // ネットに掛かる球は追う必要がない
      const reach = PLAYER.REACH * this.you.attr.reach;
      const gap = Math.hypot(landing.x - this.you.x, landing.z - this.you.z) - reach;
      return gap > PLAYER.SPEED * this.you.attr.speed * landing.t * SPECIAL.DASH.RUNNABLE;
    }

    /**
     * 縮地の跳び先。これから通る軌道のうち「コート内に立って、そこからラケットが届く」
     * 最初の区間を探し、その真ん中のわずかに手前（自陣側）を立ち位置として返す。
     * smashSpot() と同じ考え方だが、高さの条件は「打てる高さならどこでも」と広い。
     * @returns {{x:number, z:number, t:number, dist:number}|null}
     *   dist＝今の立ち位置からそこまでの距離（「走っても間に合わないか」の判定に使う）
     */
    dashSpot() {
      const ball = this.ball;
      if (this.phase !== 'rally' || !ball.live || ball.last === 'you') return null;
      const bounds = this.youBounds();
      const standX = (x) => clamp(x, bounds.xMin, bounds.xMax);
      const standZ = (z) => clamp(z, bounds.zMin, bounds.zMax);
      const reach = PLAYER.REACH * this.you.attr.reach;
      const hittable = (at) => at.z < PLAYER.NET_MARGIN && at.y < PLAYER.REACH_Y && at.y > BALL_R
        && !(this.serveInFlight && at.bounces < 1)
        && Math.hypot(at.x - standX(at.x), at.z - standZ(at.z)) < reach;
      const window = predictWindow(ball, hittable, SPECIAL.DASH.LEAD_T, 1);
      if (!window) return null;
      const x = standX(window.mid.x);
      const z = standZ(window.mid.z - SPECIAL.DASH.BACK_OFF);
      return {
        x, z, t: window.mid.t, dist: Math.hypot(x - this.you.x, z - this.you.z),
      };
    }

    /**
     * サーブの溜め量（溜め秒）。ゲージが満タンになる（CHARGE_SWEET_T / CHARGE_SWEET_MARK）
     * までは押している時間そのもの。満タンの後も押し続けると SERVE.CHARGE_DRAIN の速さで
     * 抜けていく（0 で止まる）。ゲージ（chargeMeter()）も威力（serveTimingPower()）もこれを読む。
     * @param {number} heldTime 溜めキーを押してからの実経過時間(秒)
     */
    serveCharge(heldTime) {
      const fullT = SERVE.CHARGE_SWEET_T / SERVE.CHARGE_SWEET_MARK;
      if (heldTime <= fullT) return heldTime;
      return Math.max(0, fullT - (heldTime - fullT) * SERVE.CHARGE_DRAIN);
    }

    /**
     * サーブの威力(0〜1)。ゲージの線（＝SERVE.CHARGE_SWEET_T まで溜めた地点。ゲージの
     * 9割の位置に出る）までは溜めるほど強くなり、線に届いたところで最大になる。
     * 線を超えて溜めても威力はもう増えず、代わりに serveFaultChance() が上がっていく。
     * 満タンの後も押し続けると溜めが抜けていき（serveCharge()）、ゲージが線より下へ
     * 戻ったところから威力も落ちる。
     * @param {number} heldTime 溜めキーを押してから離すまでの実経過時間(秒)
     */
    serveTimingPower(heldTime) {
      return clamp(this.serveCharge(heldTime) / SERVE.CHARGE_SWEET_T, 0, 1);
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
     * サーブは「ゲージが満タンになるまでの保持時間」に対する溜め量（serveCharge()）の割合
     * （線は SERVE.CHARGE_SWEET_MARK の位置＝9割に出る。満タンまでの時間はそこから逆算する）。
     * 満タンの後も押し続けると減っていく。ラリーは従来どおり溜め時間の割合。
     */
    chargeMeter() {
      if (!this.you.charging) return 0;
      if (this.isServeCharging()) {
        const fullT = SERVE.CHARGE_SWEET_T / SERVE.CHARGE_SWEET_MARK;
        return clamp(this.serveCharge(this.you.chargeTime) / fullT, 0, 1);
      }
      return clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);
    }

    /** 今この瞬間、自分のサーブを溜めている最中か（HUD がゲージの線を出すかの判定に使う）。 */
    isServeCharging() {
      return this.you.charging && this.phase === 'serve' && this.servingPlayer() === 'you';
    }

    /**
     * 自分のサーブを線より長く押している最中か（HUD がゲージを赤くするのに使う）。
     * ゲージの位置ではなく押している時間で見る：満タンの後は溜めが抜けてゲージが線より
     * 下へ戻るが、フォールトの確率（serveFaultChance()）は押している時間で決まるので、
     * 戻っても危険なままであることを見せ続ける。
     */
    isServeOvercharged() {
      return this.isServeCharging() && this.you.chargeTime > SERVE.CHARGE_SWEET_T;
    }

    /**
     * いま人間が「サーブを打ち返す1打」に向かっているか（＝RETURN の緩和が効く場面か）。
     * サーブが一度も返球されていない間（serveInFlight）で、かつ飛んできているのが
     * 自分の打った球ではないとき。自分がサーバーのときも serveInFlight は立っているので、
     * ball.last でチームを確かめる。
     */
    returningServe() {
      return this.serveInFlight && this.ball.last !== 'you';
    }

    /**
     * いま溜めを離したときの、スイング入力の有効時間(秒)。レシーブだけ長い
     * （RETURN.SWING_WINDOW）。理由は config.js の RETURN のコメント参照。
     */
    swingWindow() {
      return this.returningServe() ? RETURN.SWING_WINDOW : PLAYER.SWING_WINDOW;
    }

    /**
     * いまの「手の届く範囲」の倍率（PLAYER.REACH に掛ける）。能力値「リーチ・読み」に、
     * レシーブのときだけ RETURN.REACH_MULT を重ねる。
     */
    reachMult() {
      return this.you.attr.reach * (this.returningServe() ? RETURN.REACH_MULT : 1);
    }

    /**
     * 溜め時間を毎フレーム加算する。ラリー中・トス中以外の文脈になったら
     * （ポイントが終わった、トスが自動リセットされた等）溜めを打ち切ってキャンセルする。
     */
    tickCharge(dt) {
      if (!this.you.charging) return;
      const myServe = this.phase === 'serve' && this.servingPlayer() === 'you';
      // 相手のサーブを待っている間も、テイクバックを引いたまま溜め続けられる
      // （chargeStart() のコメント参照）。1本目がフォールトしてから2本目の構えに入る
      // までの間（phase==='fault'）も含める：ここで切ってしまうと、キーを押したままでも
      // ゲージが空になり、握り直さないと溜まらなくなる。
      const waitingReturn = this.servingPlayer() !== 'you'
        && (this.phase === 'serve' || this.phase === 'fault');
      const validContext = this.phase === 'rally' || (myServe && this.tossActive) || waitingReturn;
      if (!validContext) {
        // 自分のサーブでトスが流れた（＝上げたまま離さずに落としてしまった）ときだけは、
        // 押しっぱなしを解除する。この場面で押し直すことには「もう一度トスを上げる」と
        // いう意味があるので、握ったままの状態を残しても使い道がない。
        if (myServe) {
          this.you.charging = false;
          return;
        }
        // それ以外（ポイント間＝phase 'over' など）では **charging を落とさない**：
        // this.you.charging は「溜めキーが今も押されているか」そのものなので、ここで
        // false にすると、押しっぱなしのままポイントをまたいだときに二度と戻せなくなる
        // （キーは押されたままなので keydown が来ない＝chargeStart() が呼ばれない）。
        // 実際そうなっていて、ポイント間ずっと握っていた人は次のポイントで構えが出ず、
        // 離しても chargeRelease() が素通りしていた。溜めだけを0に戻して、打てる場面に
        // 入ったところ（次のサーブ待ち）から改めて溜め直させる。
        this.you.chargeTime = 0;
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
      this.lastServeKmh = null;
      this.driftWind();
      this.lineCall = null; // 前のポイントのコールを「このポイントを決めたコール」と取り違えない
      this.hooks.serveSpeed(null); // 前のポイントのサーブ速度表示を消す
      // スタミナはポイント間で少し回復するが、そのセットで消化したゲーム数が増えるほど
      // 回復量そのものが目減りする（staminaRecoverAmount()）＝長いセットの終盤ほど
      // 疲れが抜けなくなる。4人全員に同じルールで効く。
      this.recoverStamina(1);
      this.beginServe();
    }

    /**
     * 4人全員のスタミナを、ポイント間の回復量（staminaRecoverAmount()）の scale 倍だけ戻す。
     * 回復量にも能力値「体力」が掛かる（attr.recover）。
     */
    recoverStamina(scale) {
      const recover = this.staminaRecoverAmount(this.match.games.you + this.match.games.cpu) * scale;
      ACTORS.forEach((who) => {
        const actor = this.actor(who);
        actor.stamina = Math.min(1, actor.stamina + recover * actor.attr.recover);
      });
    }

    /**
     * チェンジエンズを始める（ポイント間の一拍 TIMING.NEXT_POINT の後、セットの終わりは
     * 次のセットを始める直前に呼ぶ）。暗転 → 暗いうちにコートを入れ替えて次のポイントの
     * 構えへ → 明転、を update() の時計で進める（tickChangeover()）。
     * @param {'firstGame'|'tiebreak'|'rest'|'setBreak'} kind scoring.changeoverAfter() の結果
     */
    beginChangeover(kind) {
      this.changeover = {
        kind, t: 0, hold: CHANGEOVER.HOLD_T[kind], swapped: false, rested: 0,
      };
      this.hooks.call('チェンジエンズ', CHANGEOVER_CALLS[kind]);
    }

    tickChangeover(dt) {
      const co = this.changeover;
      if (!co) return;
      co.t += dt;
      const swapAt = CHANGEOVER.FADE_T + co.hold;
      if (co.swapped) {
        if (co.t >= swapAt + CHANGEOVER.FADE_T) this.changeover = null;
        return;
      }
      // 休憩のぶんのスタミナは、真っ暗になってから入れ替えるまでの間に少しずつ戻す
      // （スコアボード脇のバーが満ちていくのが見える）。休憩なしの入れ替わりは倍率0。
      const rested = clamp((co.t - CHANGEOVER.FADE_T) / co.hold, 0, 1);
      this.recoverStamina(CHANGEOVER.RECOVER_MULT[co.kind] * (rested - co.rested));
      co.rested = rested;
      if (co.t < swapAt) return;
      // 明転はここから数える（このフレームのはみ出しを持ち越すと、入れ替えた直後の
      // 1コマが真っ暗にならず、選手が構えへ瞬間移動するところが薄く見えてしまう）。
      co.t = swapAt;
      co.swapped = true;
      this.swapEnds();
      this.newPoint(); // 選手を構えに置き直す＝ここから明転
    }

    /** 休憩を切り上げる（Space）。暗転しきったところへ飛び、次の更新で入れ替えて明転する。 */
    skipChangeover() {
      const co = this.changeover;
      if (co && !co.swapped) co.t = Math.max(co.t, CHANGEOVER.FADE_T + co.hold);
    }

    /**
     * チェンジエンズの暗転の濃さ（0＝なし〜1＝真っ暗）。表示専用（hud が画面に幕を掛ける）。
     * 入れ替える瞬間（選手が構えへ瞬間移動し、会場が180°回る）は必ず真っ暗の間に来る。
     */
    changeoverShade() {
      const co = this.changeover;
      if (!co) return 0;
      if (!co.swapped) return clamp(co.t / CHANGEOVER.FADE_T, 0, 1);
      return clamp(1 - (co.t - CHANGEOVER.FADE_T - co.hold) / CHANGEOVER.FADE_T, 0, 1);
    }

    /** コートを入れ替わる。会場の向きは表示側が endsSwapped を見て回す。 */
    swapEnds() {
      this.endsSwapped = !this.endsSwapped;
      // 風は会場に吹いているので、選手から見た向き（ゲームの座標）は横も前後も逆になる
      // ＝風上と風下のエンドが入れ替わる。強さはそのままで、続く newPoint() がいつもどおり
      // そこから少しだけ揺らす。
      this.windBase.angle += Math.PI;
      this.setWindVector();
    }

    /**
     * ポイントごとの風の揺らぎ。前のポイントの風から強さを WIND.DRIFT_ACCEL、向きを
     * WIND.ANGLE_DRIFT の範囲だけ動かす（無関係な値へ決め直すと点ごとに向きが唐突に
     * 入れ替わって見えるため）。どちらも卓越風（windBase）から GUST_RANGE／ANGLE_SPREAD
     * より離れない＝試合を通して風向きはほぼ一定。フォールトによるセカンドサーブ
     * （beginServe の再実行）をまたいでも同じポイント中は吹き続ける（beginServe() 側では
     * ball.wind/windZ を0に戻すだけ）。
     */
    driftWind() {
      const base = this.windBase.strength;
      this.windStrength = clamp(
        this.windStrength + rand(-WIND.DRIFT_ACCEL, WIND.DRIFT_ACCEL),
        Math.max(0, base - WIND.GUST_RANGE),
        Math.min(WIND.MAX_ACCEL, base + WIND.GUST_RANGE),
      );
      this.windAngleOff = clamp(
        this.windAngleOff + rand(-WIND.ANGLE_DRIFT, WIND.ANGLE_DRIFT),
        -WIND.ANGLE_SPREAD, WIND.ANGLE_SPREAD,
      );
      this.setWindVector();
    }

    /** windBase・windStrength・windAngleOff から、このポイントの風（wind/windZ）を作って知らせる。 */
    setWindVector() {
      const angle = this.windBase.angle + this.windAngleOff;
      this.wind = this.windStrength * Math.sin(angle);
      this.windZ = this.windStrength * Math.cos(angle);
      this.hooks.wind(this.wind, this.windZ);
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
      this.resetPointState();
      this.phase = 'serve';
      // この1点に何がかかっているか（ブレークポイント／セットポイント）。スコアと
      // サーバーだけで決まる＝ポイント中は変わらないので、ここで一度だけ求める
      // （セカンドサーブでもう一度通っても同じ結果になる）。
      this.stakes = pointStakes(this.match, this.server);
      this.placeForServe(faultReason);
    }

    /**
     * 1本の球を始める前の後始末（タイマー・ボール・溜め・技・反応の遅れを持ち越さない）。
     * サーブ待ち（beginServe）と、練習モードの球出し前（nextRep）の両方から呼ぶ。
     * phase はここでは変えない（呼び出し側が決める）。
     */
    resetPointState() {
      this.clearTimers();
      this.tossActive = false;
      this.aiTossActive = false;
      this.serveSwing = null;
      this.serveInFlight = false;
      this.cpuNetRush = false;
      this.rallyShots = 0; // このサーブ（フォールトからのやり直しも含む）から数え直す

      const ball = this.ball;
      ball.live = false;
      ball.bounces = 0;
      ball.vx = ball.vy = ball.vz = 0;
      ball.spin = 'flat'; // 前のポイントのスピンを持ち越さない
      ball.wind = 0; // サーブの飛翔中（1本目の着地まで）は無風にする。返球後は hit() で this.wind に差し替える
      ball.windZ = 0;
      ball.curve = 0; // 前の打球の曲がり（バギーホイップ）を持ち越さない

      // 自分のサーブなら、前のトスの溜めを持ち越さないよう完全に解除する。
      // 相手（または味方）のサーブを待つ側は、溜めキーを押したままならテイクバックを
      // 引いたまま構え続けられる（chargeStart() 参照）。1本目がフォールトして2本目の
      // 構えに入り直すときも、握り直さずにそのまま待てるようにするため、ここでは
      // charging も chargeSpin（押しているキー＝球種）も落とさない。
      const iServe = this.servingPlayer() === 'you';
      if (iServe) {
        this.you.charging = false;
        this.you.chargeSpin = 'flat';
        this.you.chargeKick = false;
      }
      this.you.chargeTime = 0; // 前のサーブの溜めを持ち越さない
      this.you.chargeStroke = null;
      this.you.serveMiss = false; // 前のサーブの「溜めすぎ」の抽選結果も持ち越さない
      this.you.special = null;    // 前の1打に乗っていた必殺技も持ち越さない
      this.you.sinceRunT = Infinity; // 前のポイントの走りも持ち越さない（バギーホイップの条件）
      ACTORS.forEach((w) => { this.actor(w).dash = null; }); // 縮地の残像も持ち越さない
      ACTORS.forEach((w) => { this.actor(w).leap = null; }); // 跳躍も持ち越さない
      ACTORS.forEach((w) => { this.actor(w).dive = null; }); // 飛びつきボレーの飛び込みも
      // AI（Hard / Extreme）ぶんも同じく持ち越さない
      ACTORS.forEach((w) => {
        if (w === 'you') return;
        this.actor(w).special = null;
        this.actor(w).diveVolley = false;
      });
      this.specialArmed = null;
      ball.kick = false;

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
      ACTORS.forEach((w) => {
        if (w === 'you') return;
        this.poachCommit[w] = false;
        this.dashCommit[w] = false;
        this.diveCommit[w] = false;
      });
    }

    /**
     * サーバー／レシーバー（ダブルスは両者の相方も）をスタンスへ置き、案内を出して、
     * CPU/AI のサーブなら予約する（beginServe() の後半）。
     * @param {string} [faultReason] セカンドサーブのときだけ渡す（'ネット'|'アウト'）
     */
    placeForServe(faultReason) {
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
        // サーバー・レシーバーの相方を構えに置く
        this.placeDoublesMate(MATE_OF[server]);
        this.placeDoublesMate(MATE_OF[receiver]);
        // cpu チームの前衛は、いまネット際に置いた方（サーバー／レシーバーの相方）。
        this.frontOf.cpu = MATE_OF[serverTeam === 'cpu' ? server : receiver];
      }
      // 自分がサーバーでもレシーバーでもない番（ダブルス）は、サーブ前に立ち位置を選べる
      const standHint = this.doubles && !this.serveDuty('you') ? 'R/F で自分が前／後ろに立つ' : '';

      if (server === 'you') {
        this.hooks.call(
          faultReason ? 'セカンドサーブ' : 'サーブ',
          faultReason ? `${faultReason} — もう一度` : '←→ コース ／ ↑↓ 深さ ／ B/V/C 押しっぱなし → ゲージの線で離す',
        );
      } else if (server === 'youMate') {
        // 人間のチームだが、今回は相方の番。人間は（立ち位置を選ぶ以外）何もしなくてよい
        this.hooks.call(faultReason ? 'パートナーのセカンドサーブ' : 'パートナーのサーブ', faultReason || standHint);
        this.scheduleAiServe('youMate');
      } else {
        const sub = standHint ? `CPU のサーブ ／ ${standHint}` : 'CPU のサーブ';
        this.hooks.call(faultReason ? 'セカンドサーブ' : 'リターン', faultReason ? `${faultReason}／CPU` : sub);
        this.scheduleAiServe(server);
      }
      this.placeServeBall();
    }

    /**
     * CPU/AI（cpu・cpuMate・youMate）のサーブ動作を予約する。構えてから
     * TIMING.CPU_SERVE_READY だけ一拍おいてトスを上げ、そこからさらに
     * TIMING.CPU_SERVE_DELAY 後に振り出す（当たるのはトスが打点まで落ちてきたとき。
     * swingServe() 参照）。以前は一拍が無く、ポイントが始まった瞬間にトスが
     * 上がって 0.9秒後には球が飛んできていた＝レシーバー（人間）が構える間がなかった。
     * トスは placeServeBall() の後に上げる必要がある（先に上げるとボール位置をトス前の
     * 手元に戻されてしまう）が、ここは必ずタイマー経由なので順序は自動的に満たされる。
     */
    scheduleAiServe(who) {
      this.after(TIMING.CPU_SERVE_READY, () => {
        if (this.phase !== 'serve') return;
        this.aiTossBall();
        this.after(TIMING.CPU_SERVE_DELAY, () => {
          if (this.phase === 'serve') this.swingServe(who);
        });
      });
    }

    /**
     * サーブを振り出す（人間は溜めを離した瞬間、CPU/AI は scheduleAiServe() の予定どおり）。
     * 振り出してから当たるまでは SERVE.SWING_T（跳び上がってラケットを振り上げる時間）。
     * そのときトスがある高さが打点になる＝**離すのが遅いほど、落ちてきた球を低い打点で打つ**。
     * ただしラケットが届く高さには限りがある：
     * - 上限は跳んで届く高さ（人間 SERVE.CONTACT_Y、CPU/AI SERVE.AI_CONTACT_Y）。振り終わる
     *   時点でトスがまだそれより上なら、その高さまで落ちてくるのを待って打つ（早く離しても
     *   打点はそれ以上高くならない。早すぎたぶんは威力が弱くなるだけ）。
     * - 下限は跳ばずに届く SERVE.STAND_CONTACT_Y。振り終わる前にトスがそれより下へ
     *   落ちてしまう（離すのが遅すぎた）なら、その高さを通ったところで打つ。
     * 当たる瞬間は stepBall() が物理の刻みで数えて serve() を呼ぶ。
     * 以前は離した瞬間のトスの高さ（ゲージの線ちょうどなら頂点近くの 3.3m、すぐ離せば
     * 手元の 1.45m）で打っていて、ラケット（約2m）から大きく離れたところから球が
     * 飛び出していた（ユーザー報告：軌跡の始点が選手の頭上高くに浮いて見える）。
     * 威力・フォールトの抽選は chargeRelease() が離した瞬間に決めてあるので、待つ間に
     * 変わるのは狙い（serve() がその時点の ←→↑↓ を読む）だけ。
     */
    swingServe(who) {
      const ball = this.ball;
      const reach = who === 'you' ? SERVE.CONTACT_Y : SERVE.AI_CONTACT_Y;
      // トスは重力だけで動く（beginServe() がスピン・風・曲がりを消している）ので、
      // 何秒後にどの高さにあるかは放物線の式からそのまま解ける。
      const g = Math.abs(PHYSICS.GRAVITY);
      const heightAt = (t) => ball.y + ball.vy * t - 0.5 * g * t * t;
      /** 高さ h を落ちながら通るまでの秒数（既にそれより下なら 0） */
      const fallTo = (h) => Math.max(0,
        (ball.vy + Math.sqrt(Math.max(ball.vy * ball.vy + 2 * g * (ball.y - h), 0))) / g);
      const swingY = heightAt(SERVE.SWING_T);
      let t = SERVE.SWING_T;
      if (swingY > reach) t = fallTo(reach);
      else if (swingY < SERVE.STAND_CONTACT_Y) t = fallTo(SERVE.STAND_CONTACT_Y);
      if (t <= 0) {
        this.serve(who);
        return;
      }
      // y（当たる高さ）はジャンプの高さを決めるのに見た目側が使う（tickServeSwing()）
      this.serveSwing = { who, t, y: heightAt(t) };
      this.tickServeSwing(); // もう当たる寸前なら、この場で踏み切る
    }

    /**
     * 振り出して待っているサーブの時計を、物理の1ステップぶん進める。当たる瞬間が来たら true。
     * @param {number} dt
     */
    tickServeClock(dt) {
      const swing = this.serveSwing;
      if (!swing) return false;
      swing.t -= dt;
      return swing.t <= 1e-9;
    }

    /**
     * サーブを振り出して当たるのを待っている間、「あと SERVE_LEAP_RISE_T 秒で当たる」
     * ところで跳び始める（表示専用）。跳躍の頂点がちょうど当たる瞬間に来るよう、上昇に
     * かける時間を当たるまでの残り時間に合わせる。跳ぶ高さは打点の高さで決まる
     * （reach。低い打点ほど低く、跳ばずに届く高さなら跳ばずに腕だけ振り上げる）。
     */
    tickServeSwing() {
      const swing = this.serveSwing;
      if (!swing || this.actor(swing.who).leap) return;
      const until = swing.t;
      if (until > PLAYER.SERVE_LEAP_RISE_T) return;
      const span = until + PLAYER.SERVE_LEAP_FALL_T;
      this.startLeap('serve', swing.who, { span, rise: until / span, reach: swing.y });
    }

    /**
     * ダブルスで、サーバー・レシーバーでない方（who）をサーブ前の構えに置く。横は相方
     * （そのチームのサーバー／レシーバー）の反対サイドへ寄り（ai.coverPosition）、深さは
     * 前（ネット際）か後ろ（ベースライン付近）。you チームは指示された位置
     * （人間＝youFormation、パートナー＝youMateFormation）、cpu チームは常に前。
     * @param {'you'|'youMate'|'cpu'|'cpuMate'} who
     */
    placeDoublesMate(who) {
      const formation = { you: this.youFormation, youMate: this.youMateFormation }[who] || 'net';
      const z = TEAM_OF[who] === 'cpu' ? DOUBLES.NET_Z_CPU
        : formation === 'back' ? DOUBLES.BACK_Z_YOU : DOUBLES.NET_Z_YOU;
      const spot = coverPosition(this.actor(MATE_OF[who]).x, z);
      const actor = this.actor(who);
      actor.x = spot.x;
      actor.z = spot.z;
      if (who === 'you') this.you.vx = this.you.vz = 0; // 歩いていた勢いを持ち越さない
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
     * CPU/AI（cpu・cpuMate・youMate）のサーブ前トス。tossBall() と同じ弾道で上げる
     * （人間の入力待ちを表す tossActive とは別に aiTossActive を立てる。理由は
     * aiTossActive のコメント参照）。振り出したあと（swingServe()）、このトスが打点
     * （SERVE.AI_CONTACT_Y）まで落ちてきたところで当たる。呼ぶのは scheduleAiServe()
     * だけ（構えてから一拍おいて上げる）。
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
      // 必殺技「キックサーブ」。ネットのはるか上を通してボックスの深いところへ落とし、
      // 着地後に大きく跳ね上げる（bounce()）。溜めすぎのフォールト抽選も、強打のネット
      // 掛かりも起きない＝確実に入る代わりに、球速そのものは速くない。
      // 人間は溜めを離した瞬間に決まっている（you.special）。AI（Hard のみ）はサーブに
      // 「これから打つ」瞬間が無く、ここが唯一の判断どころなのでこの場で選ぶ。
      if (who !== 'you') this.actor(who).special = this.pickAiServeSpecial(who);
      const kick = this.actor(who).special === 'kickServe';
      const side = this.match.serveSide;
      // CPU/AI のセカンドサーブ。1本目より遅く、コースも深さもラインから余裕を取り、回転で
      // 確実に入れにいく（SERVE.SECOND_*）。人間は溜め量とコース入力で自分で加減するので、
      // ここでは切り替えない。
      const second = who !== 'you' && this.serveNumber === 2;
      const { dir, targetSign } = serveAim(team, side);
      // 打点はラケットが届く高さ。swingServe() が届く高さに来るのを待ってから呼ぶので、
      // 人間はボールの今の高さがそのまま打点になる（離すのが遅いほど低い。上限は保険）。
      // CPU/AI は常に AI_CONTACT_Y（トスは物理の刻みの分だけずれうるが、2cm 未満）。
      const contactY = who === 'you'
        ? clamp(ball.y, SERVE.BALL_Y, SERVE.CONTACT_Y)
        : SERVE.AI_CONTACT_Y;
      this.serveSwing = null; // 振り出して待っていた1本が、いま当たった
      const from = { x: ball.x, y: contactY, z: ball.z };
      // サービスはコートの対角へ入れる。狙う横位置（コース）はプレイヤーが ←→ で選び、
      // CPU/AI はランダムに選ぶ（どちらも T／ボディ／ワイドの3コース）
      const magnitude = who === 'you'
        ? this.serveAimMagnitude(targetSign)
        : this.cpuServeAimMagnitude(second);
      const target = {
        x: targetSign * magnitude,
        y: BALL_R,
        z: dir * (COURT.SERVICE - (who === 'you'
          ? (kick ? SPECIAL.KICK.DEPTH : this.serveDepth())
          : (second
            ? rand(SERVE.SECOND_DEPTH_MIN, SERVE.SECOND_DEPTH_MAX)
            : rand(SERVE.DEPTH_MIN, SERVE.DEPTH_AI_MAX)))),
      };
      // ゲージの線を超えて溜めた（chargeRelease() の抽選に当たった）1本は、狙いそのものを
      // サービスボックスの外へずらして外す。「フォールト」の判定は普段どおり着地で決まる
      // （bounce()→inServiceBox()）ので、ロング／サイドアウトがそのまま画面に出る。
      const overcharged = who === 'you' && this.you.serveMiss;
      // CPU/AI は「実際のテニスと同じ割合で外す」抽選をここで引く（1本目は6割強しか入らない
      // 代わりに攻められる、という関係を作るため。理由は config の CPU_FIRST_MISS 参照）。
      // 外し方は人間の溜めすぎとまったく同じ＝狙いをサービスボックスの外へずらす。
      const aiMiss = who !== 'you'
        && Math.random() < (second ? SERVE.CPU_SECOND_MISS : SERVE.CPU_FIRST_MISS);
      let clearance = kick ? SPECIAL.KICK.CLEARANCE : SERVE.CLEARANCE;
      if (overcharged || aiMiss) {
        if (Math.random() < SERVE.FAULT_LONG_CHANCE) {
          target.z = dir * (COURT.SERVICE + rand(SERVE.FAULT_LONG_MIN, SERVE.FAULT_LONG_MAX));
        } else {
          target.x = targetSign * (HALF_W + rand(SERVE.FAULT_WIDE_MIN, SERVE.FAULT_WIDE_MAX));
        }
      } else if (!kick && Math.random() < SERVE.NET_CHANCE * (who === 'you'
        ? this.you.swingCharge
        : (second ? SERVE.SECOND_NET_MULT : 1))) {
        // 強いサーブほどネットに掛かる（確率は威力に比例。CPU/AI は常に全力扱い）。
        // 深い狙いのままでは幾何的に白帯へ届かないので、「ネットのすぐ向こうを狙って
        // しまったミスヒット」として実現する（理由は config の NET_MISS_Z_MIN 参照）。
        target.z = dir * rand(SERVE.NET_MISS_Z_MIN, SERVE.NET_MISS_Z_MAX);
        clearance = SERVE.NET_MISS_CLEARANCE; // ネット回避で持ち上げさせない
      }
      // 人はトスを上げた瞬間に固定したスピン（V/C。chargeStart() 参照）でスライスサーブ・
      // スピンサーブが打てる。CPU/AI も同じ SPIN 設定（実効重力・バウンドの弾み方）で
      // 一定確率でスピンサーブを混ぜる（aiSpin()。以前は常にフラット固定だった）。
      const spin = kick ? 'top' : (who === 'you' ? this.you.chargeSpin : aiSpin(second));
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
        * SERVE.SPIN_T_MULT[spin] * (kick ? SPECIAL.KICK.T_MULT : 1)
        * (second ? SERVE.SECOND_T_MULT : 1);

      ball.y = from.y;
      Object.assign(ball, solveShot(from, target, flightT, clearance, spin));
      ball.spin = spin;
      ball.curve = 0;   // サーブは曲がらない（バギーホイップ専用の効果）
      ball.reactBonus = 0; // 前のツイーナーの「読みにくさ」も持ち越さない
      ball.kick = kick; // 1バウンド目だけ大きく跳ね上げる目印（bounce() が読んで消す）
      if (kick) this.spendSpecial('kickServe', undefined, who); // サーブは必ず「起きる」ので打った時点で消費
      // 打った瞬間の初速をそのままスコアボード脇に出す（次のポイントが始まるまで残す）
      const serveKmh = mpsToKmh(Math.hypot(ball.vx, ball.vy, ball.vz));
      this.hooks.serveSpeed(serveKmh);
      this.lastServeKmh = serveKmh; // エースで決まったとき、球種名に球速を添えるのに使う
      // スタッツ用。1本目の本数はここで数え、「入った本数」は bounce() が数える
      // （入るか入らないかは着地するまで決まらないため）。
      this.stats[team].maxServeKmh = Math.max(this.stats[team].maxServeKmh, serveKmh);
      if (this.serveNumber === 1) this.stats[team].firstServes++;
      ball.live = true;
      ball.bounces = 0;
      ball.age = 0;
      ball.last = team; // スコア判定・当たり判定はチーム単位（hit() と同じ扱い）
      this.lastShotBy[team] = kick
        ? SPECIAL_LABEL.kickServe
        : shotLabel('serve', spin, false, serveCourse(magnitude));
      if (this.practice && who === 'you') this.practice.shot = { stroke: 'serve', spin, lob: false };
      this.resetTrail();

      // レシーブ側の人間が、サーブが来る前からラケットを引いて待っていた場合
      // （chargeStart()）、フォア/バックはここで確定させる。chargeStart() の時点では
      // ボールがまだサーバーの手元で静止していて、左右のどちらへ来るか決められない。
      if (who !== 'you' && this.you.charging && !this.you.chargeStroke) {
        this.you.chargeStroke = classifyStroke('you', ball, this.you);
      }

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
      const serveCharge = kick ? SPECIAL.IMPACT_POWER : (who === 'you' ? this.you.swingCharge : 0);
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
     * @param {boolean} [second] セカンドサーブ。角度サーブには格上げせず、ワイドも
     *   SERVE.SECOND_AIM_WIDE_MAX までに抑えてサイドラインから余裕を取る。
     */
    cpuServeAimMagnitude(second) {
      const roll = Math.random();
      if (roll < 1 / 3) return rand(SERVE.AIM_T_MIN, SERVE.AIM_T_MAX);
      if (roll < 2 / 3) return rand(SERVE.AIM_BODY_MIN, SERVE.AIM_BODY_MAX);
      // セカンドサーブはサイドラインから余裕を取る＝角度サーブには格上げせず、ワイドも手前まで。
      if (second) return rand(SERVE.AIM_WIDE_MIN, SERVE.SECOND_AIM_WIDE_MAX);
      return Math.random() < SERVE.CPU_ANGLE_CHANCE
        ? rand(SERVE.AIM_ANGLE_MIN, SERVE.AIM_ANGLE_MAX)
        : rand(SERVE.AIM_WIDE_MIN, SERVE.AIM_WIDE_MAX);
    }

    hit(who) {
      const ball = this.ball;
      const player = this.actor(who);
      const from = { x: ball.x, y: Math.max(ball.y, SHOT.SOLVE_MIN_Y), z: ball.z };
      this.serveInFlight = false; // 一度でも打ち返されたら「ノーバウンド禁止」の制約は解除
      this.rallyShots++; // 観客の歓声・実況の盛り上がりに使う（ラリーが長いほど盛り上がる）

      // この1打に乗っている必殺技。人間は chargeRelease() が溜めを離した瞬間に決めて
      // あるので、場面が変わっていないか（前へ詰めてボレーになった／バウンドを待った）
      // だけ確かめ、外れていたら下ろして普通の1打として打つ（SPECIAL_STILL_VALID）。
      // AI（Hard のみ）は溜めが無く「これから打つ」瞬間が存在しないので、下の
      // 打ち方の判定を済ませてからこの場で決める（後追い判定は要らない）。
      let special = who === 'you' ? this.you.special : null;
      const stillValid = special && SPECIAL_STILL_VALID[special];
      if (stillValid && !stillValid(this, ball)) {
        special = null;
        this.you.special = null;
      }
      // AI の飛びつきボレー（Extreme のみ）だけは、他の技と決まる場所が違う：普通のリーチでは
      // 届かない球へ手を伸ばす瞬間＝ swingAiAt() で決まっている。ここでは旗を受け取るだけ
      // （実際に乗せるのは下の「AI の必殺技はここで決まる」の分岐）。
      const dove = who !== 'you' && player.diveVolley === true;
      if (dove) player.diveVolley = false;

      if (who === 'you') this.you.swingConnected = true; // この1振りは当たった（空振りではない）

      // 打った直後は（人間も含めて）すぐには動けない。フォロースルー中は追加入力があっても
      // 動き出せないはず、という想定（CPU/AIはすぐにミドルへ戻れるほど強くない、という意味も兼ねる）。
      // 飛びつきボレーだけは飛び込んで倒れ込むぶん、起き上がるまで長く動けない（技の代償）。
      this.recoverTimers[who] = who === 'you'
        ? (special === 'divingVolley' ? SPECIAL.DIVE.RECOVER : PLAYER.HIT_RECOVER_DELAY)
        : (dove ? SPECIAL.DIVE.RECOVER : PLAYER.CPU_RECOVER_DELAY);

      // ball.x/z はまだ打点のまま（solveShot が書き換えるのは vx/vy/vz だけ）なので、
      // ここで打点とプレイヤー位置からフォア/バックを判定できる。shot の計算より前に
      // 必要（playerShot() がタイミングのずれを出すのに使う）。
      // 人間はテイクバックを始めた瞬間に chargeStart() が固定した向きをそのまま使う。
      // ここで改めて判定すると、溜めている間にボールと自分の位置関係が変わった場合、
      // テイクバックで見せていた向きと実際に振る向きがずれてしまう。
      // 飛びつきボレーは飛び込んだ先（startDive() が決めた向き）で打つ。
      const baseStroke = (player.dive && player.dive.stroke)
        || (who === 'you' && this.you.chargeStroke) || classifyStroke(who, ball, player);

      // 人間の打球だけ溜め量に応じて演出を強める（AIは常に0＝通常の演出）
      const charge = who === 'you' ? this.you.swingCharge : 0;
      // 高くて緩いボール(SMASH_MIN_Y以上)を、しっかり溜めてから(SMASH_MIN_CHARGE以上)離すと
      // スマッシュになる。フォア/バックの区別はなく、専用の振り下ろしモーション＋強打になる。
      // CPU/AI には溜めが無いので、条件は「打点の高さ」＋「コートの中で打てていること」
      // （CPU.SMASH_MIN_Y / SMASH_Z_MAX。ベースラインのはるか後ろで高く弾んだ球は
      // スマッシュではなく、ただ高い打点の返球）。
      // 必殺技を出した1打は、どの打ち方になるかも技が決める（＝場面で選ばれた技どおりの
      // モーション・狙いになる。溜め量や打点の高さでの再判定は挟まない）。
      // 技が乗っていなければどうなる1打か（＝AI が技を選ぶときの材料でもある）。
      const natural = naturalStroke(this, who, ball, player, charge);

      // AI の必殺技はここで決まる（人間の specialAim() に当たる分岐点）。
      if (who !== 'you') {
        special = dove
          ? 'divingVolley'
          : this.pickAiSpecial(who, this.aiSpecialContext(who, baseStroke, natural));
        player.special = special;
      }

      const isSmash = special ? special === 'dunkSmash' : natural.smash;
      // サービスラインより前（ネット寄り）で、ノーバウンドの球を返すときはボレー。
      // フォア/バックの区別はテイクバックのモーションにだけ使い、実際の威力・角度は
      // 溜めではなくボールとの左右距離で決まる（playerShot() 側で計算する）。
      // CPU/AI がノーバウンドで返せるのは元々ネット際（PLAYER.VOLLEY_Z 以内。
      // checkSwings() のゲート）だけなので、その1本がそのままボレーになる。
      const isVolley = special ? special === 'divingVolley' : natural.volley;
      // ツイーナー（股抜き）とジャックナイフ（跳んで高い打点を叩く）は、
      // 他のどれでもない専用のモーション。
      const stroke = special === 'tweener' ? 'tweener'
        : special === 'jackknife' ? 'jackknife'
          : isSmash ? 'smash' : isVolley ? `volley-${baseStroke}` : baseStroke;

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
      // 逆をつく相手。ダブルスでは相手ペアのうち「実際に拾いにくる方」＝後衛を見る
      // （前衛はネット際にいるので、その逆をついても意味がない）。
      const foes = this.doubles ? this.doublesFoes(who) : null;
      const aimAt = foes ? foes.back : (TEAM_OF[who] === 'cpu' ? this.you : this.cpu);
      // ボレーだけは別枠。相手がネット際にいる場面では「逆サイドを狙う」＝その相手の目の前を
      // 横切らせることになり、至近距離のボレーの打ち合いになる（ユーザー報告）。
      // ai.doublesVolleyShot() は横切らずに相手の外側へ抜くか、抜けなければ頭を越す。
      // 雁行かどうかではなく「ネット際に誰かいるか」で見る：2人とも前に出ている場面でも
      // 目の前の相手は避けたい。
      const netFoe = foes && foes.atNet;
      // 自分もネット際にいるか。ここが「目の前を横切らせない」配慮が要る条件で、
      // ベースラインから打つスマッシュには不要（コートの長さぶん横に開く余裕がある）。
      const atNetToo = netFoe && Math.abs(player.z) <= PLAYER.VOLLEY_Z;
      const aimDir = NET_DIR[who];                                // 打ち込む方向
      // 打ち方に対応する能力（フォア／バック／ボレー／スマッシュ）と安定感を、倍率だけの
      // 小さなオブジェクトに畳んで渡す（ai.js は「誰が打つか」を知らないままでいられる）。
      // 必殺技が乗った1打は、人間も AI も同じ specialShot() を通る（技の効果・狙い・
      // 球速は同じもの）。狙いが技そのもので決まっているので打点タイミング（引っ張り／
      // 流し）は効かず、常に素直なタイミングとして扱う。AI は ←→ を持たないので
      // aim=0＝常にクロス側、溜めの代わりに SPECIAL.AI.CHARGE を渡す。
      const shot = who === 'you'
        ? this.playerShot(stroke, special ? TIMING_AIM.NEUTRAL_WAIT_T : this.swingWaited(), false, special)
        : special
          ? this.specialShot(special, baseStroke, 0, SPECIAL.AI.CHARGE, rand, who)
          : isSmash
            // ネット際からのスマッシュも、ボレーと同じ理由で相手の真ん前を横切らせない。
            ? (atNetToo
              ? doublesSmashShot(netFoe, foes.far, player.x, aimDir, smashStretch,
                shotSkill(player.attr, 'smash'))
              : cpuSmashShot(aimAt, aimDir, smashStretch, shotSkill(player.attr, 'smash')))
            : isVolley
              ? (atNetToo
                ? doublesVolleyShot(netFoe, foes.far, player.x, aimDir, stretch, ball.y,
                  shotSkill(player.attr, 'volley'))
                : cpuVolleyShot(aimAt, aimDir, stretch, ball.y, shotSkill(player.attr, 'volley')))
              // ダブルスで相手が雁行（前衛がネット際・後衛が深く）なら、後衛の配球は
              // 「前衛を避けてクロス、隙があればストレートをパッシング」に切り替える。
              : foes && foes.front
                ? doublesRallyShot(foes.front, foes.back, aimDir, stretch, lobScale, arcScale,
                  shotSkill(player.attr, baseStroke))
                : cpuShot(aimAt, aimDir, stretch, lobScale, arcScale, shotSkill(player.attr, baseStroke));

      // 必殺技はここで初めて回数を使う（空振りしただけでは減らない）。縮地はこの1打では
      // なく「跳んだ瞬間」に済ませてあるので、ここでは数えない。呼び名は技が決めた
      // shot.label があればそれ（バギーホイップのポール回しなど）。
      if (special && special !== 'shukuchi') this.spendSpecial(special, shot.label, who);

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
      // shot.curve を返すのはバギーホイップだけ（飛翔中ずっと横に曲がる）。solveShot にも
      // 同じ値を渡して「曲がったうえで狙い通りに落ちる」初速を解かせる。
      const curve = shot.curve || 0;
      Object.assign(ball, solveShot(from, shot.target, shot.flight, shot.clearance, spin, curve));
      ball.spin = spin;
      ball.curve = curve;
      // 背を向けたまま打つツイーナー、空中で曲がるバギーホイップ、相手が読み負けたドロップ
      // だけ、相手の反応がこの秒数ぶん余計に遅れる（updateReactTimers）。他の1打では 0 に
      // 戻す＝前の1打を持ち越さない。
      ball.reactBonus = shot.reactBonus || 0;
      // サーブの返球も含め、ここで打たれた球は以降このポイントの風(this.wind/windZ)に
      // さらされる（サーブ自体の飛翔だけは beginServe() が0にしているので無風のまま）。
      ball.wind = this.wind;
      ball.windZ = this.windZ;
      ball.last = TEAM_OF[who]; // スコア判定はチーム単位。誰が打ったかは player.stroke 側で個別に持つ
      ball.bounces = 0;
      ball.age = 0; // ここから相手の「反応に使える時間」を数え直す
      // 必殺技はフル溜め扱いの演出にする（溜めずに出しても「必殺技を打った」感が出る）。
      const fxPower = special ? SPECIAL.IMPACT_POWER : charge;
      ball.impact = FX.IMPACT_DURATION * lerp(1, FX.CHARGE_TIME_BOOST, fxPower);
      ball.impactPower = fxPower; // フラッシュの大きさに使う
      ball.kick = false; // 前のキックサーブの跳ね上げを持ち越さない
      this.resetTrail();

      // スマッシュとツイーナーは跳んで打つぶんモーションが長い（scene/player.js 参照）。
      // 飛びつきボレーは飛び込んで伏せ、起き上がるまでが1つのモーションなので、硬直と同じ長さ。
      player.anim = stroke === 'smash' ? PLAYER.SMASH_ANIM
        : stroke === 'tweener' ? SPECIAL.TWEENER.ANIM
          : stroke === 'jackknife' ? SPECIAL.JACK.ANIM
            : special === 'divingVolley' ? SPECIAL.DIVE.RECOVER
              : PLAYER.SWING_ANIM;
      player.stroke = stroke;
      // AI には「溜めを離す瞬間」も先読みも無いので、跳躍はここ（当たった瞬間）から。
      // 人間は tickLeap()／chargeRelease() で既に跳んでいるので、その続きをそのまま使う。
      if (who !== 'you') this.startLeap(stroke === 'smash' || stroke === 'jackknife' ? stroke : null, who);
      player.spin = spin; // 振っている間のフォーム（scene/player.js）に使う
      // 必殺技で決めたときは球種名ではなく技名を出す（「何で取ったか」がそのまま伝わる）。
      // 技名は打った本人（who）の specialLabel を見る。以前はここで常に this.you を見て
      // いたため、cpu/cpuMate/youMate が技を決めても「you」側の（多くは無関係な）技名が
      // 出てしまっていた。
      this.lastShotBy[TEAM_OF[who]] = special
        ? (player.specialLabel || SPECIAL_LABEL[special])
        : shotLabel(stroke, spin, shot.lob);
      // 練習モードは、この1本が狙いどおりの打ち方だったかを決着のときに見る（practiceMiss()）
      if (this.practice && who === 'you') this.practice.shot = { stroke, spin, lob: !!shot.lob };
      // 音程はチーム単位（誰が打っても同じ）。音色は打ち方(stroke)とスピンで変わる。
      this.hooks.sound('hit', TEAM_OF[who], stroke, charge, spin);
    }

    /**
     * 今の1打で「スイングがボールを待った時間」(秒)。溜めキーを離してから実際に当たるまで
     * 何秒かかったか＝どれだけ早めに振り出したか、で、引っ張り／流しの打ち分けに使う
     * （TIMING_AIM 参照）。this.you.swing は離した瞬間に有効時間（swingSpan）から
     * 減り始めるので、その残りから逆算できる。
     * 測った時間はそのまま秒で使わず、「有効時間に対する割合」を通常の
     * PLAYER.SWING_WINDOW に換算して返す。レシーブだけ有効時間が長い
     * （RETURN.SWING_WINDOW）ため、秒のまま測ると早振りが必ず引っ張り最大になり、
     * レシーブがいつもサイドライン際へ散ってしまう（TIMING_AIM.RISK_SPREAD）。
     * 割合で測れば、窓が広がっても「早めに振れば引っ張り／引きつければ流し」という
     * 打ち分けの関係はそのまま保たれる。
     * スイングを介さずに hit('you') を直接呼んだ場合（テストなど）は、狙いがずれない
     * 「素直なタイミング」を返す。
     */
    swingWaited() {
      if (this.you.swing <= 0) return TIMING_AIM.NEUTRAL_WAIT_T;
      const span = this.you.swingSpan || PLAYER.SWING_WINDOW;
      return (span - this.you.swing) * (PLAYER.SWING_WINDOW / span);
    }

    /**
     * 装備する必殺技（スタート画面で選んだもの）。試合中に呼んでも壊れない。
     * 空配列を渡せば必殺技なし＝これまでと同じゲームになる（既定）。
     * @param {string[]} keys config.SPECIAL_MOVES の key
     */
    setSpecials(keys) {
      const known = SPECIAL_MOVES.map((m) => m.key);
      this.specials = (keys || []).filter((k) => known.indexOf(k) !== -1);
      this.specialArmed = null;
      this.you.special = null;
      this.refreshSpecials(); // 選び直したら、このゲームぶんの回数も入れ直す
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
     * @param {number} [reachMult] 必殺技でリーチが広がるぶんの倍率（既定1＝通常）
     * @param {number} [reachYBonus] 必殺技で打点の高さの上限が上がるぶん(m)（既定0）
     * @returns {{t:number, x:number, y:number, z:number, bounces:number, vy:number,
     *   sinceBounce:number|null}|null}
     *   すでに届く位置なら t=0。スイングの有効時間内に届かないなら null（＝いま離すと空振り）。
     *   vy／sinceBounce はその打点での縦の速さと、弾んでからの経過時間（ライジングの判定用）。
     */
    predictContact(reachMult = 1, reachYBonus = 0) {
      const ball = this.ball;
      const you = this.you;
      const reach = PLAYER.REACH * this.reachMult() * reachMult;
      const reachY = PLAYER.REACH_Y + reachYBonus;
      // サーブは1バウンドするまで打てない（checkSwings() の mustBounceFirst と同じ条件）
      const canHit = (at, bounces) => at.z < PLAYER.NET_MARGIN && at.y < reachY
        && !(this.serveInFlight && bounces < 1)
        && Math.hypot(at.x - you.x, at.z - you.z) < reach;
      if (canHit(ball, ball.bounces)) {
        return {
          t: 0,
          x: ball.x,
          y: ball.y,
          z: ball.z,
          bounces: ball.bounces,
          vy: ball.vy,
          sinceBounce: ball.bounces > 0 ? ball.sinceBounce : null,
        };
      }
      // predictWindow() は上限を越えた次の1コマまでサンプルを返しうる（刻みは
      // PREDICT_STEP）。そのコマを「いま離せば当たる」として返すと、スイングの有効時間が
      // 尽きた直後にボールが届く＝必ず空振りになる1本をガイドが「当たる」と言ってしまう
      // （実測：この取りこぼしが空振りの主因だった）。しかも predictWindow() は
      // PREDICT_STEP（1/120秒）刻みなのに対し実際の物理は PHYSICS.STEP（1/240秒）刻みで、
      // 同じ軌道でも打点に届く時刻が1コマぶん前後しうる。両方を吸収するため2コマ手前で
      // 打ち切る＝「当たる」と言ったら必ず当たる側に倒す。
      const window = predictWindow(
        ball, (at) => canHit(at, at.bounces), this.swingWindow() - 2 * PREDICT_STEP, 1,
      );
      return window ? window.enter : null;
    }

    /**
     * いま溜めを離してから振り終わるまでの間に、**バウンド後の球をいちばん高く捉えられる
     * 高さ**(m)。届く範囲にバウンド後の球が来ないなら 0。
     *
     * predictContact() が返すのは「最初に届く1点」なので、**弾んで上がってくる球では
     * ほぼ必ず上がりはじめの低いところ**になる（実測：ラリー中の打点の中央値は 0.16m、
     * 99パーセンタイルでも 0.9m）。「高い球を叩く」ことが条件の技（ジャックナイフ）が
     * そこを見ると、条件を満たす球が事実上存在しなくなる——ユーザー報告
     * 「結構高めでバックフラットを打っているつもりがなかなか発動しない」の原因がこれ。
     * 発動の判定には区間の中の最高点を使い、**実際にその高さで捉えられたかどうかは
     * 当たった瞬間に SPECIAL_STILL_VALID が見る**（引きつけて高い打点で打てたときだけ
     * 技になり、待ちきれずに低く打てば普通の1打に戻る）。
     * @param {number} [minY] 「この高さを最初に超えるのはいつか」を一緒に測りたいときの線(m)。
     *   跳躍の踏み切り（tickLeap）が使う：技が成立する**最初の瞬間**から逆算して跳ぶので、
     *   いちばん高い点（＝引きつけきったとき）ではなくこちらが基準になる。
     * @returns {{y:number, t:number, tAbove:number|null}}
     *   y＝いちばん高い打点(m)、t＝そこまでの時間(秒)、tAbove＝minY を最初に超える時間(秒)。
     *   届く範囲にバウンド後の球が来ないなら y=0, t=0, tAbove=null。
     */
    contactPeak(minY) {
      const ball = this.ball;
      const you = this.you;
      const reach = PLAYER.REACH * this.reachMult();
      const line = minY === undefined ? Infinity : minY;
      const canHit = (at, bounces) => at.z < PLAYER.NET_MARGIN && at.y < PLAYER.REACH_Y
        && !(this.serveInFlight && bounces < 1)
        && Math.hypot(at.x - you.x, at.z - you.z) < reach;
      let peak = 0;
      let peakT = 0;
      let tAbove = null;
      if (ball.bounces > 0 && canHit(ball, ball.bounces)) {
        peak = ball.y;
        if (ball.y >= line) tAbove = 0;
      }
      // predictWindow() は「届く区間」を1つだけ追う。その間のサンプルを覗いて最高点と、
      // 高さの線を最初に超える時刻を拾う（accept は区間の判定と兼用で、副作用で更新する）。
      predictWindow(ball, (at) => {
        const ok = canHit(at, at.bounces);
        if (ok && at.bounces > 0) {
          if (at.y > peak) { peak = at.y; peakT = at.t; }
          if (tAbove === null && at.y >= line) tAbove = at.t;
        }
        return ok;
      }, this.swingWindow() - 2 * PREDICT_STEP, 1);
      return { y: peak, t: peakT, tAbove };
    }

    /**
     * ガイド用：その打点で振ったら、どの打ち方になるか（hit() の判定と同じ条件）。
     * スマッシュ・ボレー・ドロップショットは打点タイミングでコースが変わらない打ち方なので、
     * ガイドでもそう見せる必要がある（グラウンドストロークのつもりで方向を出すと嘘になる）。
     * @param {{y:number, bounces:number}|null} contact predictContact() の結果
     * @param {number} charge いまの溜め量(0〜1)
     * @param {string|null} [special] いま出せる必殺技（あれば打ち方は技が決める）
     */
    previewStroke(contact, charge, special) {
      const at = contact || this.ball;
      const base = this.you.chargeStroke || classifyStroke('you', this.ball, this.you);
      if (special === 'dunkSmash') return 'smash';
      if (special === 'divingVolley') return `volley-${base}`;
      if (special === 'tweener') return 'tweener';
      if (special === 'jackknife') return 'jackknife';
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

      // いま必殺技が乗る場面なら、その技での着地点を出す（＝ガイドと実際の打球が、
      // 必殺技が出るときも一致する）。
      const special = (this.specialArmed && this.specialArmed.move) || null;
      const extra = specialReach(special);
      const contact = this.predictContact(extra.mult, extra.y);
      // まだボールが遠い＝いま離しても当たらない。「早すぎる」ことだけ伝える（コースは、
      // 一番早く当たったときと同じ＝引っ張り最大の向きを出しておく）。
      const tooEarly = contact === null;
      // swingWaited() と同じ換算（有効時間に対する割合 → PLAYER.SWING_WINDOW 相当）。
      // ここを揃えないと、レシーブのときだけガイドと実際の打球がずれる。
      const span = this.swingWindow();
      const waited = tooEarly
        ? PLAYER.SWING_WINDOW
        : contact.t * (PLAYER.SWING_WINDOW / span);
      const charge = clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);
      const stroke = this.previewStroke(contact, charge, special);
      // 実際に打つときと同じ関数を通す（preview=true でばらつきだけ中央値に固定）ので、
      // ここに出る着地点は「いま離したら本当に飛ぶ場所」そのものになる。
      const shot = this.playerShot(stroke, special ? TIMING_AIM.NEUTRAL_WAIT_T : waited, true, special);
      return {
        timing: swingTiming(waited),
        tooEarly,
        waited,
        stroke,
        // 打点タイミングでコースが変わるのはグラウンドストロークだけ。ロブ・ドロップ
        // ショット・ボレー・スマッシュ・必殺技は、引きつけても早振りしても同じところへ飛ぶ。
        timingMatters: !special && (stroke === 'forehand' || stroke === 'backhand')
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
     * @param {string|null} [special] この1打に乗っている必殺技のキー。あれば狙いは
     *   specialShot() が決める（＝溜め量・打点タイミングではなく技そのものが決める）。
     */
    playerShot(stroke = 'forehand', waited = TIMING_AIM.NEUTRAL_WAIT_T, preview = false, special = null) {
      /** 狙いのばらつき。プレビューでは中央値に固定する。 */
      const spread = preview ? (a, b) => (a + b) / 2 : rand;
      const lob = this.input.lob;
      const aim = this.input.moveX * INPUT_X_TO_WORLD;
      const charge = this.you.swingCharge;
      const baseX = aim !== 0 ? aim * SHOT.AIM_X : -signOr(this.you.x, 1) * SHOT.DEFAULT_X;

      // 能力値の倍率。打ち方ごとに対応する項目（スマッシュ／ボレー／フォア／バック）が
      // 飛翔時間に掛かる（小さいほど速い球）。既定（3）なら 1.0＝従来と完全に同じ。
      const attr = this.you.attr;

      // 必殺技が乗っている1打は、通常の「溜め量と打点タイミングで決まる狙い」ではなく
      // 技そのものが狙いを決める。キックサーブ（serve() 側）と縮地（打点まで跳ぶだけで
      // 球は普通）は null が返り、そのまま下の通常計算に落ちる。
      if (special) {
        const specialShot = this.specialShot(special, stroke, aim, charge, spread);
        if (specialShot) return specialShot;
      }

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
        // 相手が読み負けた1本だけ出足が遅れる（DROP.MISREAD_T 参照）。抽選は1球に1回で、
        // ダブルスでも読むのは相手の主力（cpu）の能力値で代表させる。プレビューでは引かない。
        const misread = !preview
          && Math.random() < CPU.DROP_MISREAD_CHANCE * this.cpu.attr.react;
        return {
          target: {
            x: dir * spread(DROP.X_MIN, DROP.X_MAX), y: BALL_R, z: spread(DROP.Z_MIN, DROP.Z_MAX),
          },
          flight: DROP.T * attr[stroke === 'backhand' ? 'backhand' : 'forehand'],
          clearance: DROP.CLEARANCE,
          spin: 'drop',
          reactBonus: misread ? DROP.MISREAD_T : 0,
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

    /**
     * 必殺技1つぶんの狙い（playerShot() の特例）。返り値の形は playerShot() と同じで、
     * そのまま hit() の solveShot() に渡る。どの技も risk:0＝狙いが荒れない
     * （「やりすぎるとミスも起きる」通常のライン際狙いに対する、技のご褒美）。
     * @param {string} move 技のキー
     * @param {string} stroke hit() が決めた打ち方（フォーム用。狙いには最小限しか使わない）
     * @param {number} aim ←→ の入力（world 基準。0＝無入力）
     * @param {number} charge 溜め量(0〜1)
     * @param {(a:number,b:number)=>number} spread ばらつき（プレビューでは中央値に固定される rand）
     * @returns {object|null} null＝この技は狙いを変えない（通常の計算に落ちる）
     */
    specialShot(move, stroke, aim, charge, spread, who = 'you') {
      const actor = this.actor(who);
      const attr = actor.attr;
      const ground = attr[stroke === 'backhand' ? 'backhand' : 'forehand'];
      // 打ち込む向き（手前の人間は +z、向かい側の AI は -z）。技ごとの狙いの深さは
      // config に「相手コート側を正」で書いてあるので、最後にこれを掛けて鏡にする。
      const zDir = NET_DIR[who];
      // 左右の向き。←→ の入力があればその側、無ければ通常のショットと同じくクロス側
      // （AI は ←→ を持たないので常にクロス＝aim は 0 で呼ばれる）。
      const dir = aim !== 0 ? Math.sign(aim) : -signOr(actor.x, 1);

      if (move === 'dunkSmash') {
        const { DUNK } = SPECIAL;
        const target = {
          x: aim !== 0 ? aim * SHOT.AIM_X : -signOr(actor.x, 1) * SHOT.DEFAULT_X,
          y: BALL_R,
          z: zDir * DUNK.Z,
        };
        // 打点が遠いほど飛翔時間を伸ばして初速を頭打ちにする（DUNK.MAX_SPEED 参照）。
        // ネット際で叩くぶんには SHOT.SMASH_T×T_MULT のまま＝いちばん速い。
        const dist = Math.hypot(target.x - this.ball.x, target.z - this.ball.z);
        return {
          target,
          flight: Math.max(SHOT.SMASH_T * DUNK.T_MULT, dist / DUNK.MAX_SPEED) * attr.smash,
          clearance: DUNK.CLEARANCE,
          spin: 'flat',
          risk: 0,
        };
      }

      if (move === 'divingVolley') {
        const { DIVE } = SPECIAL;
        return {
          target: { x: dir * DIVE.X, y: BALL_R, z: zDir * DIVE.Z },
          flight: DIVE.T * attr.volley,
          spin: 'flat',
          risk: 0,
        };
      }

      if (move === 'driveVolley') {
        const { DRIVE } = SPECIAL;
        return {
          target: { x: dir * DRIVE.X, y: BALL_R, z: zDir * DRIVE.Z },
          flight: DRIVE.T * attr.volley,
          clearance: DRIVE.CLEARANCE,
          spin: 'top',
          risk: 0,
        };
      }

      if (move === 'tweener') {
        const { TWEENER } = SPECIAL;
        // 抜かれた体勢から打つ1本なので、**相手がどこにいるか**で打ち分ける。
        // 詰めてきている相手に低い球を打てば触られるだけ、下がっている相手にロブを
        // 上げればただのつなぎ球——以前は場面を問わず後者（ロブ）しか出なかった。
        const foe = this.doubles
          ? this.doublesFoes(who).near
          : this.actor(TEAM_OF[who] === 'you' ? 'cpu' : 'you');
        const rushing = Math.abs(foe.z) <= TWEENER.NET_Z;
        // 狙う左右は ←→ の入力が最優先。無入力なら相手のいない側へ逃がす
        // （背中を向けて打つので、自分の立ち位置ではなく相手の位置で決めるほうが自然）。
        const away = aim !== 0 ? Math.sign(aim) : -signOr(foe.x, 1);
        if (rushing) {
          return {
            target: { x: away * TWEENER.LOB_X, y: BALL_R, z: zDir * TWEENER.LOB_Z },
            flight: TWEENER.LOB_T,
            clearance: TWEENER.LOB_CLEARANCE,
            spin: 'top',
            lob: true,
            risk: 0,
            reactBonus: TWEENER.REACT_BONUS,
          };
        }
        return {
          target: { x: away * TWEENER.PASS_X, y: BALL_R, z: zDir * TWEENER.PASS_Z },
          flight: TWEENER.PASS_T * ground,
          clearance: TWEENER.PASS_CLEARANCE,
          spin: 'top',
          risk: 0,
          reactBonus: TWEENER.REACT_BONUS,
        };
      }

      if (move === 'jackknife') {
        const { JACK } = SPECIAL;
        // **打点が高いほど速く・深くなる。** 弾んだ球を落ちるまで待つと苦しいまま、
        // 頂点を叩けてはじめて攻撃になる——という実際のテニスの理屈をそのまま値にした。
        // 高さは打点そのもの（this.ball.y）で見る。MAX_Y を超えても頭打ち。
        const high = clamp((this.ball.y - JACK.MIN_Y) / (JACK.MAX_Y - JACK.MIN_Y), 0, 1);
        // 既定はダウン・ザ・ライン＝**自分が立っている側**のサイドライン際（他の技が
        // 既定にしているクロスの逆）。コート中央にいるときだけバックハンド側へ倒す。
        // ←→ を入れればそちらへ振れる＝クロスにも打てる。
        const line = signOr(actor.x, -RACKET_SIDE[who]);
        return {
          target: {
            x: (aim !== 0 ? Math.sign(aim) : line) * JACK.X,
            y: BALL_R,
            z: zDir * lerp(JACK.Z_MIN, JACK.Z_MAX, high),
          },
          // バックハンドの技なので能力も「バックハンド」を見る（stroke は専用の
          // 'jackknife' に変わっているので、上の ground（フォア/バックの引き当て）は使わない）。
          flight: lerp(JACK.T_LOW, JACK.T_HIGH, high) * attr.backhand,
          clearance: JACK.CLEARANCE,
          spin: 'flat',
          risk: 0,
        };
      }

      if (move === 'buggyWhip') {
        const { BUGGY } = SPECIAL;
        // 曲がる**向き**は打ち方（フォアハンド）で決まっているので常に同じ＝画面の右から左
        // （world の +x 方向。カメラの都合で world +x が画面の左に映る）。
        // コースは ←→ で2択：自分のいる側（＝ラケット側）を指せばストレート、
        // 無入力か逆側ならクロス。同じ曲がりでも、ストレートは「外へ膨らんでから戻る」
        // ＝ネットポストの外を回る軌道になる。
        const sign = buggyCurveSign(who);
        const straight = aim !== 0 && Math.sign(aim) === RACKET_SIDE[who];
        if (!straight) {
          return {
            target: { x: sign * BUGGY.X, y: BALL_R, z: zDir * spread(BUGGY.Z_MIN, BUGGY.Z_MAX) },
            flight: BUGGY.T * ground,
            clearance: BUGGY.CLEARANCE,
            // 空中で曲がる（solveShot が曲がるぶんを見越して内側へ打ち出すので、落ちる場所は
            // target のまま＝ほぼ真っ直ぐ飛び出してサイドライン際へ切れ込む）。
            curve: sign * BUGGY.CURVE,
            spin: 'top',
            risk: 0,
            reactBonus: BUGGY.REACT_BONUS, // 曲がりを読みきるまで相手の出足が遅れる
          };
        }
        const target = {
          x: RACKET_SIDE[who] * BUGGY.LINE_X,
          y: BALL_R,
          z: zDir * spread(BUGGY.LINE_Z_MIN, BUGGY.LINE_Z_MAX),
        };
        const flight = BUGGY.LINE_T * ground;
        const curve = this.aroundPostCurve(target, flight, who);
        return {
          target,
          flight,
          clearance: BUGGY.LINE_CLEARANCE,
          curve,
          spin: 'top',
          risk: 0,
          reactBonus: BUGGY.REACT_BONUS,
          // ポールを回れたときだけ呼び名を変える（何が起きたのかが分かるように）
          label: curve * sign > BUGGY.LINE_CURVE ? `${SPECIAL_LABEL.buggyWhip}（ポール回し）` : undefined,
        };
      }

      if (move === 'rising') {
        const { RISING } = SPECIAL;
        // 溜めは見ない（相手の球威を使ってコンパクトに合わせる）。狙いは ←→ の入力が最優先、
        // 無入力なら相手のいない側（オープンコート）へ：早いタイミングで打ち返すので、相手は
        // まだ前の1打から戻りきっていない。
        const foe = this.doubles
          ? this.doublesFoes(who).back
          : this.actor(TEAM_OF[who] === 'you' ? 'cpu' : 'you');
        const away = aim !== 0 ? Math.sign(aim) : -signOr(foe.x, 1);
        return {
          target: { x: away * RISING.X, y: BALL_R, z: zDir * spread(RISING.Z_MIN, RISING.Z_MAX) },
          flight: RISING.T * ground,
          // 上がりばなの打点は低い（0.2〜0.4m）。hit() は SHOT.SOLVE_MIN_Y の高さから打った
          // として弾道を解くので、その差だけ実際の球は低く飛ぶ——足し戻さないと余裕を
          // 食い潰してネットに掛かる（実測：足し戻す前はライジングの1割強がネット）。
          clearance: RISING.CLEARANCE + Math.max(0, SHOT.SOLVE_MIN_Y - this.ball.y),
          spin: RISING.SPIN,
          risk: 0,
          reactBonus: RISING.REACT_BONUS, // 時間を奪われて、相手の出足が遅れる
        };
      }

      if (move === 'hawkEye') {
        const { HAWK } = SPECIAL;
        return {
          target: {
            x: dir * (HALF_W - HAWK.INSET),
            y: BALL_R,
            z: zDir * lerp(HAWK.Z_MIN, HAWK.Z_MAX, charge),
          },
          flight: lerp(SHOT.TAP_T, SHOT.CHARGE_T, charge) * ground * HAWK.T_MULT,
          // 球種は押したキー（B/V/C）のまま。溜めずに離したスライスでもドロップには
          // ならない（ドロップの分岐より手前で返しているため）＝ライン際を突く技になる。
          // AI には押したキーが無いので、通常の返球と同じ aiSpin() で混ぜる。
          spin: who === 'you' ? this.you.chargeSpin : aiSpin(),
          risk: 0,
        };
      }

      // kickServe は serve() が、shukuchi は chargeRelease() の瞬間移動が担当する
      // ＝打球そのものは通常どおり。
      return null;
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

    /**
     * サーブ権を相手チームへ渡す（ゲームの終わりと、タイブレークの2ポイントごとの交代）。
     * ダブルスは、今サーブし終えたチームの中で次に回ってくるまで担当者も交代する
     * （実際のルール通り。タイブレーク中もセットと同じ順番のまま回る＝A1→C1→A2→C2→A1…）。
     */
    passServe() {
      if (this.doubles) {
        const finishedTeam = this.server;
        const mate = finishedTeam === 'you' ? 'youMate' : 'cpuMate';
        this.serverPartner[finishedTeam] = this.serverPartner[finishedTeam] === finishedTeam
          ? mate
          : finishedTeam;
      }
      this.server = opponent(this.server);
    }

    endPoint(winner, reason) {
      if (this.phase === 'over') return;
      if (this.practice) {
        this.endRep(winner, reason); // 練習は得点をつけず、この1本の成否だけを数える
        return;
      }
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
      // 飛びつきボレーで飛び込んでいる最中に決まった（めったにない）なら、当てずにそこで止める
      ACTORS.forEach((w) => { this.actor(w).dive = null; });
      // 観客の歓声（sfx.point）用の決まり方。エース／ウィナーは相手の非（凡ミス）とは
      // 違う盛り上がり方をする。ラリーの本数（rallyShots）も渡し、長引くほど盛り上げる。
      const outcome = reason === 'ダブルフォルト' ? 'doubleFault'
        : isAce ? 'ace'
          : reason === 'ツーバウンド' ? 'winner' : 'error';
      // かかっていた1点（ブレークポイント／セットポイント）は、取っても凌いでも
      // 観客の沸き方が変わる。取った＝その技の見出しそのまま、凌いだ＝'saved'。
      const stakes = this.stakes;
      const stakeKey = !stakes ? null : (stakes.team === winner ? stakes.kind : 'saved');
      this.hooks.sound('point', winner, outcome, this.rallyShots, stakeKey);

      // ブレークポイントの本数（スタッツ画面用）。チャンスを持っていたのはレシーブ側で、
      // 実際に取れたかどうかで converted を分ける（実際のテニスの「3/5」と同じ数え方）。
      if (stakes && stakes.breakPoint) {
        this.stats[stakes.team].breakPoints++;
        if (stakes.team === winner) this.stats[stakes.team].breaksWon++;
      }
      // 決着した1点なので、この先（リプレイ中も含めて）見出しは出しっぱなしにしない。
      this.stakes = null;

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
      // この1点でコートを入れ替わるか（チェンジエンズ）。決まった直後のスコアで判定する
      // ＝セットの終わりは match.reset() の前（最終スコアのゲーム数）で見る。
      const changeover = changeoverAfter(result, this.match);
      if (result.tiebreak && result.type === 'point') {
        // タイブレーク中は1本目だけ今のサーバーのまま、以降は2ポイントごとに交代
        // （＝奇数本目が終わった直後）。ダブルスは通常のゲームと同じ順番で4人が回る。
        const total = this.match.tiebreakPoints.you + this.match.tiebreakPoints.cpu;
        if (total % 2 === 1) {
          this.passServe();
          // タイブレーク中は「ゲーム」が進まないので、必殺技はサーブ権が移る節目で回復させる
          // （通常のゲームで「ゲームが替わる＝サーブが替わる」瞬間に回復するのと揃える）。
          const turns = (total + 1) / 2;
          if (turns % SPECIAL.TIEBREAK_REFRESH_TURNS === 0) this.refreshSpecials();
        }
      } else if (result.type !== 'point') {
        // タイブレークで決まったセットは、タイブレークの1本目をサーブしたチームが最後の
        // ゲームをサーブした扱い＝次のセットはその相手から（最後の1本を打った側ではない）。
        if (this.tiebreakOpener) this.server = this.tiebreakOpener;
        this.tiebreakOpener = null;
        this.passServe(); // ゲームごとにサーブ交代
        if (result.tiebreak) this.tiebreakOpener = this.server; // 6-6：ここからタイブレーク
        this.refreshSpecials(); // 必殺技はゲームが替わるたびに回復する
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
          // セット間の休憩。ゲーム数が奇数で終わったセットなら、その間にコートも入れ替わる。
          // 偶数なら入れ替わらず（次のセットの第1ゲームの後に入れ替わる）、休憩ぶんの
          // スタミナだけ戻して始める。
          if (changeover) {
            this.beginChangeover(changeover);
          } else {
            this.recoverStamina(CHANGEOVER.RECOVER_MULT.setBreak);
            this.newPoint();
          }
        });
        return;
      }

      // 「ツーバウンド」は判定としては正しいが表現として味気ないので、実況らしく言い換える：
      // サーブが一度も触れられずに決まったなら「エース！」、ラリー中の決定打なら「ウィナー！」。
      const twoBounceCall = isAce ? 'エース！' : 'ウィナー！';
      // ブレークで取ったゲームはそう言う（サーブを持っていない側が取った＝試合が動く1ゲーム）。
      const broke = stakes && stakes.breakPoint && stakes.team === winner;
      const sub = result.type === 'game'
        ? `ゲーム — ${mine ? 'YOU' : 'CPU'}${broke ? '（ブレーク！）' : ''}${result.tiebreak ? '（6-6 タイブレーク！）' : ''}`
        : reason === 'ツーバウンド' ? twoBounceCall : reason;
      // 取った側がこのポイントで最後に放ったショット（決め球、または相手のミスを誘った球）。
      // 相手のネット／アウトで決まった場合は「その1本前に自分が打った球」になる。
      // サーブに一度も触れられずに決まった1点（エース）だけは球速も添える：そのときの
      // 決め手は球種とコースより速さそのものなので、スコアボード脇の表示（serveSpeed）を
      // 見に行かなくても中央のコールだけで分かるようにする。
      const shot = isAce && this.lastServeKmh != null
        ? `${this.lastShotBy[winner]} ${Math.round(this.lastServeKmh)}km/h`
        : this.lastShotBy[winner];
      this.hooks.call(mine ? 'ポイント' : '失点', sub, shot);
      this.hooks.score();
      // 入れ替わるときも、決まったコールを読む一拍（NEXT_POINT）を置いてから暗転する
      this.after(TIMING.NEXT_POINT, () => {
        if (changeover) this.beginChangeover(changeover);
        else this.newPoint();
      });
    }

    /* ---------------------------------------------------------- 練習モード */

    /**
     * 練習モード（チュートリアル）を始める。得点・スタッツ・チェンジエンズは動かさず、
     * レッスン（config.PRACTICE.LESSONS）の球を1本ずつ出し続ける。試合の start() と同じく
     * 1つの Game で1回だけ（別のレッスンへ移るときは main.js が Game を作り直す）。
     * @param {string} key レッスンの key
     */
    startPractice(key) {
      const lesson = PRACTICE.LESSONS.find((l) => l.key === key);
      if (this.started || !lesson) return;
      this.started = true;
      this.doubles = false;
      this.practice = {
        lesson, done: 0, tries: 0, rep: 0, cleared: false, shot: null, fired: null, target: null,
      };
      // そのレッスンの技だけを装備する（優先度が上の技が先に出て、練習したい技を横取りしない）
      this.setSpecials(lesson.special ? [lesson.special] : []);
      // 無風（ポイントが進まないので newPoint() の風の揺らぎも起きない）
      this.windStrength = 0;
      this.setWindVector();
      this.nextRep();
    }

    /** 練習の次の1本を用意する（立ち位置へ置き、球を出す／サーブを待つ／目印を出す）。 */
    nextRep() {
      const p = this.practice;
      const L = p.lesson;
      p.shot = null;
      p.fired = null;
      p.target = null;
      // 1本ごとに疲れも技の回数も戻す（練習なので尽きない）
      ACTORS.forEach((who) => { this.actor(who).stamina = 1; });
      this.refreshSpecials();
      if (L.kind === 'serve' || L.kind === 'return') {
        this.server = L.kind === 'serve' ? 'you' : 'cpu';
        // サーブのサイドは合計ポイントの奇偶で決まる（match.serveSide）。得点はつけないので、
        // デュース／アドを1本ごとに入れ替えるためだけにここを使う。
        this.match.points = { you: p.rep % 2, cpu: 0 };
        // レシーブの練習の CPU は、遅く確実なセカンドサーブ（SERVE.SECOND_*）で打ってくる。
        // 練習ではフォールトしてもダブルフォルトにならない（serveFault()）。
        this.serveNumber = L.kind === 'return' ? 2 : 1;
        this.beginServe();
        return;
      }
      // 自分のサーブではない＝球が出る前から溜めキーを押して待てる（chargeStart()）
      this.server = 'cpu';
      this.resetPointState();
      this.phase = 'rally';
      this.hooks.clearCall();
      // 移動のレッスンは走った先から次の目印へ続けて動く（最初の1本だけ立ち位置へ置く）
      if (L.kind !== 'move' || p.rep === 0) {
        const at = L.start[p.rep % L.start.length];
        Object.assign(this.you, {
          x: at.x, z: at.z, vx: 0, vz: 0, speed: 0,
        });
      }
      const { FEEDER } = PRACTICE;
      Object.assign(this.cpu, { x: FEEDER.x, z: FEEDER.z, speed: 0 });
      // 出すまでは球出し役の手元に止めておく（live=false のまま）
      Object.assign(this.ball, {
        x: FEEDER.x, y: FEEDER.y, z: FEEDER.z, px: FEEDER.x, py: FEEDER.y, pz: FEEDER.z,
      });
      if (L.kind === 'move') {
        p.target = L.targets[p.rep % L.targets.length];
        return;
      }
      const feed = L.feeds[p.rep % L.feeds.length];
      this.after(PRACTICE.FEED_DELAY, () => this.feedBall(feed));
    }

    /**
     * 球出し役（CPU）が1球出す。打ち返されてきた球とまったく同じ扱い（ball.last='cpu'）
     * なので、当たり判定・構え・スマッシュの先回り印・必殺技の予告は試合と同じに働く。
     * @param {{to:{x:number,z:number}, t:number, spin?:string, clearance?:number,
     *   from?:{x?:number,y?:number,z?:number}}} feed config.PRACTICE のレッスンの feeds の1つ
     */
    feedBall(feed) {
      if (!this.practice || this.phase !== 'rally') return;
      const { FEEDER } = PRACTICE;
      const from = Object.assign({ x: FEEDER.x, y: FEEDER.y, z: FEEDER.z }, feed.from);
      const spin = feed.spin || 'flat';
      const ball = this.ball;
      Object.assign(ball, {
        x: from.x, y: from.y, z: from.z, px: from.x, py: from.y, pz: from.z,
        live: true, last: 'cpu', bounces: 0, age: 0, sinceBounce: 0,
        spin, curve: 0, wind: 0, windZ: 0, kick: false, reactBonus: 0,
        impact: FX.IMPACT_DURATION, impactPower: 0,
      }, solveShot(from, { x: feed.to.x, y: BALL_R, z: feed.to.z }, feed.t, feed.clearance, spin));
      this.rallyShots = 1;
      this.resetTrail();
      this.resetChase(); // バギーホイップの「相手が打ってから走った距離」はここから数える
      // 球が出る前から構えていたなら、フォア／バックはここで決め直す（押した瞬間は球が
      // 止まっていて、どちらへ来るか分からなかった）
      if (this.you.charging) this.you.chargeStroke = classifyStroke('you', ball, this.you);
      this.cpu.anim = PLAYER.SWING_ANIM;
      this.cpu.stroke = 'forehand';
      this.cpu.spin = spin;
      this.hooks.sound('hit', 'cpu', 'forehand', 0, spin);
    }

    /** 移動のレッスン：目印に入ったら成功。毎フレーム update() から呼ぶ。 */
    tickPractice() {
      const p = this.practice;
      if (!p || !p.target || this.phase !== 'rally') return;
      if (Math.hypot(this.you.x - p.target.x, this.you.z - p.target.z) > PRACTICE.MOVE_RADIUS) return;
      p.target = null;
      this.phase = 'over';
      this.scoreRep(true);
    }

    /**
     * 練習の1本が決着した（endPoint() の代わり）。CPU は打ち返さないので、自分の球が入れば
     * 必ず相手コートで2バウンドして winner==='you' になる。そのうえで狙いどおりの打ち方
     * だったかを見る。入らなかったときは決まり方（ネット／アウト／届かず）がそのまま理由。
     */
    endRep(winner, reason) {
      this.phase = 'over';
      this.ball.live = false;
      ACTORS.forEach((w) => { this.actor(w).dive = null; });
      const why = winner === 'you'
        ? this.practiceMiss()
        : (reason === 'ツーバウンド' ? '届かなかった' : reason);
      this.scoreRep(!why, why);
    }

    /**
     * 入った1本が、レッスンの need を満たしていたか。満たしていれば null、そうでなければ
     * 何を変えればよいかの一言（lesson.hint）。
     */
    practiceMiss() {
      const { lesson, shot, fired } = this.practice;
      const need = lesson.need || {};
      if (need.special) return fired === need.special ? null : lesson.hint;
      if (!shot) return null;
      const ok = (!need.strokes || need.strokes.indexOf(shot.stroke) !== -1)
        && (!need.spin || shot.spin === need.spin)
        && (need.lob === undefined || shot.lob === need.lob);
      return ok ? null : lesson.hint;
    }

    /**
     * 練習の1本の成否を数え、コールを出して次の1本を予約する。目標の本数に届いたら
     * 「レッスンクリア」（その後も同じレッスンを続けられる。次へ進むのは main.js の N）。
     * @param {boolean} ok
     * @param {string} [why] 失敗の理由（コールの補足）
     */
    scoreRep(ok, why) {
      const p = this.practice;
      const { goal } = p.lesson;
      p.tries++;
      if (ok) p.done++;
      const cleared = ok && !p.cleared && p.done >= goal;
      const last = PRACTICE.LESSONS.indexOf(p.lesson) === PRACTICE.LESSONS.length - 1;
      // サーブは入ったときに球速も添える（試合ではスコアボード脇に出る数字）
      const kmh = ok && p.shot && p.shot.stroke === 'serve' && this.lastServeKmh
        ? ` · ${Math.round(this.lastServeKmh)}km/h` : '';
      if (cleared) {
        p.cleared = true;
        this.hooks.call('レッスンクリア！', last
          ? '最後のレッスン！ N か Esc でレッスン一覧へ'
          : 'N で次のレッスンへ ／ このまま続けて練習してもよい');
      } else if (ok) {
        this.hooks.call('ナイス！', `${p.cleared ? `${p.done}本目` : `${p.done} / ${goal}`}${kmh}`);
      } else {
        this.hooks.call('もう一度', why);
      }
      // 試合と同じ観客の反応（クリアは長いラリーの末のウィナー並みに沸く）
      this.hooks.sound('point', ok ? 'you' : 'cpu', ok ? 'winner' : 'error', cleared ? 12 : 1, null);
      p.rep++;
      this.after(cleared ? PRACTICE.CLEAR_PAUSE : PRACTICE.NEXT_REP, () => this.nextRep());
    }

    /* -------------------------------------------------------- 毎フレーム */

    update(dt) {
      this.tickTimers(dt);
      this.tickChangeover(dt);

      const swingBefore = this.you.swing;
      this.you.anim = Math.max(0, this.you.anim - dt);
      this.cpu.anim = Math.max(0, this.cpu.anim - dt);
      if (this.doubles) {
        this.youMate.anim = Math.max(0, this.youMate.anim - dt);
        this.cpuMate.anim = Math.max(0, this.cpuMate.anim - dt);
      }
      this.ball.impact = Math.max(0, this.ball.impact - dt);

      this.movePlayers(dt);
      this.tickPractice();

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

      // スイング入力の有効時間が、一度も当たらないまま尽きた瞬間＝空振り。届いたかどうかが
      // 見た目でも分かるよう、空振りでもスイングモーションだけは再生する。
      // 当たったかどうかは swingConnected で見る：hit() は成功した時点で this.you.swing を
      // 0 にするので、「残り時間が0になった」だけでは成功と空振りを区別できない。
      // （区別していなかった頃は、成功した1打の直後に必ず missSwing() が走って
      // player.stroke と anim を上書きしており、人間のスマッシュ・ボレー・必殺技の
      // モーションが一度も再生されていなかった）。
      if (swingBefore > 0 && this.you.swing === 0 && !this.you.swingConnected) this.missSwing();

      // 構えの決定（updatePrep）が「スマッシュで打てる位置にいるか」を見るので、先に更新する。
      this.smashHint = this.smashSpot();
      // 必殺技の候補は、ガイド（swingGuidePreview）が「その技で打ったらどこへ飛ぶか」を
      // 出すのに使うので、ガイドより先に決める。
      this.specialArmed = this.specialAim();
      this.swingGuide = this.swingGuidePreview();
      this.updatePrep();
      this.tickLeap(); // 跳んで打つ1打は、離す前（球が届く少し前）から跳び始める
      this.tickSpecial(dt);
      // 振り出したサーブは、トスが打点に届く少し前から跳び始める。跳躍の時計を進める
      // tickSpecial() の後に置く：前に置くと、踏み切ったフレームにもう1フレームぶん
      // 時計が進み、頂点が当たる瞬間より1フレーム早く来てしまう。
      this.tickServeSwing();

      // トスの自動リセットなど、このフレームの stepBall() の結果を見てから
      // 溜めを継続してよいか判定する（先に判定すると1フレーム遅れてしまう）。
      this.tickCharge(dt);
    }

    /**
     * 跳躍の長さ(秒)と、そのうち踏み切りに使う割合。打ち方ごとの定数を1か所に引き当てる。
     * @param {'smash'|'jackknife'} kind
     */
    leapTiming(kind) {
      return kind === 'jackknife'
        ? { span: SPECIAL.JACK.LEAP_T, rise: SPECIAL.JACK.LEAP_RISE }
        : { span: PLAYER.SMASH_LEAP_T, rise: PLAYER.SMASH_LEAP_RISE };
    }

    /**
     * この1振りが「跳んで打つ打ち方」になるなら、その種類。ならなければ null。
     * 判定はガイドと同じ previewStroke() を通す＝画面に出ている予告と必ず一致する。
     * @param {string|null} move この1振りに乗る必殺技
     * @param {number} charge 溜め量(0〜1)
     */
    leapKind(move, charge) {
      const extra = specialReach(move);
      const stroke = this.previewStroke(this.predictContact(extra.mult, extra.y), charge, move);
      return stroke === 'smash' || stroke === 'jackknife' ? stroke : null;
    }

    /**
     * 跳び始める（表示専用）。既に跳んでいる最中なら何もしない＝1回の振りで一度だけ跳ぶ。
     * 跳躍の長さ(span)と踏み切りの割合(rise)は leap に持たせる：サーブの跳躍は、球が打点に
     * 届くまでの残り時間から毎回決まる（tickServeSwing()）ので定数で引き当てられない。
     * @param {'smash'|'jackknife'|'serve'|null} kind
     * @param {{span:number, rise:number, reach?:number}} [timing] 省略時は leapTiming(kind)。
     *   サーブだけ reach（打点の高さ）も持たせる
     */
    startLeap(kind, who = 'you', timing = kind && this.leapTiming(kind)) {
      if (!kind) return;
      const actor = this.actor(who);
      if (actor.leap) return;
      actor.leap = { ...timing, t: timing.span, kind };
    }

    /**
     * **溜めている間に、球が届く少し前から跳び始める。**
     *
     * 打球のモーション（anim）は hit() が「当たった瞬間」に入れるので、跳躍をそこから
     * 始めると跳ぶのと振るのが同時になる。かといって「溜めを離した瞬間」から跳ばせても、
     * **人はボールが来たところで離す**ので離してから当たるまでがほぼ0秒で、やはり同時に
     * 見えた（ユーザー報告：スマッシュもジャックナイフも「飛びはじめるのと打つのが同時」）。
     *
     * そこで、まだ離していなくても「あと踏み切りぶんの時間で球が届く」ところまで来たら
     * 跳び始める。こうすると当たるころには頂点にいて、**空中でラケットを振り始める**絵に
     * なる。予測（predictContact）はガイドが使っているのと同じものなので、画面に出ている
     * 予告と跳ぶタイミングがずれない。
     * 跳んだあと振らなかった（空振りした／離さなかった）ときは、そのまま着地するだけ。
     */
    tickLeap() {
      const you = this.you;
      if (you.leap || !you.charging || this.phase !== 'rally') return;
      const move = (this.specialArmed && this.specialArmed.move) || null;
      const charge = clamp(this.you.chargeTime / CHARGE.MAX_TIME, 0, 1);
      const kind = this.leapKind(move, charge);
      if (!kind) return;
      // 「あと何秒で打てるようになるか」から逆算して踏み切る。
      // ・スマッシュ … 落ちてくる球を上で叩くので、最初に届く点がそのまま打点。
      // ・ジャックナイフ … 弾んで上がってくる球なので、最初に届く瞬間はまだ低い。
      //   **高さの条件（JACK.MIN_Y）を最初に満たす時刻**を基準にする。いちばん高い点
      //   （引きつけきったとき）を基準にすると、「出せる」と言われてすぐ離した人が
      //   跳ぶ前に打ってしまう＝跳ぶのと打つのが同時に見える（ユーザー報告）。
      const extra = specialReach(move);
      const contact = this.predictContact(extra.mult, extra.y);
      if (!contact) return;
      const until = kind === 'jackknife'
        ? this.contactPeak(SPECIAL.JACK.MIN_Y).tAbove
        : contact.t;
      if (until === null) return;
      const { span, rise } = this.leapTiming(kind);
      if (until <= span * rise) this.startLeap(kind);
    }

    /**
     * 必殺技の後始末。振り終わって（スイングの有効時間もモーションも尽きて）から
     * this.you.special を消す＝振っている間は技が残るので、打球の計算だけでなく
     * フォーム（scene/player.js）や決め球の呼び名にもそのまま使える。
     * 縮地の残像（表示専用）もここで薄れさせる。
     */
    tickSpecial(dt) {
      const you = this.you;
      // サーブを振り出して当たるのを待っている間（swingServe()）も技を残す。サーブはラリーの
      // スイングの有効時間（swing）を使わないので、これを見ないと離した次のフレームで消え、
      // 約0.2秒後に当たる serve() がキックサーブを打てなかった（普通のサーブとして飛んでいた）。
      const servePending = !!(this.serveSwing && this.serveSwing.who === 'you');
      // 飛びつきボレーで飛び込んでいる間（dive）も、まだ当たっていないので残す。
      if (you.special && you.swing <= 0 && you.anim <= 0 && !you.charging && !servePending && !you.dive) {
        you.special = null;
      }
      // AI（Hard）も同じ扱い：振っている間は技が残るのでフォームに使え、モーションが
      // 尽きたところで消える。AI には溜め（charging）もスイングの有効時間（swing）も
      // 無いので、見るのはモーションの残り（anim）だけ。
      ACTORS.forEach((w) => {
        if (w === 'you') return;
        const actor = this.actor(w);
        if (actor.special && actor.anim <= 0) actor.special = null;
      });
      // 縮地の残像（表示専用）。人間も AI（Extreme）も同じ持ち方なので、まとめて薄れさせる。
      ACTORS.forEach((w) => {
        const actor = this.actor(w);
        if (!actor.dash) return;
        actor.dash.t -= dt;
        if (actor.dash.t <= 0) actor.dash = null;
      });
      ACTORS.forEach((w) => {
        const actor = this.actor(w);
        if (!actor.leap) return;
        actor.leap.t -= dt;
        if (actor.leap.t <= 0) actor.leap = null;
      });
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
      // 打つフォーム（scene/player.js・config の MOTION）に渡す球種。テイクバック中は
      // 押しているキー（chargeSpin）の球種、振っている最中は hit() が入れた実際の球種を
      // そのまま保ち、そのどちらでもない（構えているだけ）なら平常のフラットに戻す。
      // AI は溜めのキー入力がないので、打った球種が振り終わるまで残るだけになる。
      ACTORS.forEach((who) => {
        const actor = this.actor(who);
        if (actor.anim <= 0 && !actor.charging) actor.spin = 'flat';
      });
      if (this.you.charging) this.you.spin = this.you.chargeSpin;
      if (this.phase !== 'rally') {
        // 相手のサーブを待っている間も、溜めキーを押していればテイクバックの構えを出す
        // （サーブが来る前からラケットを引いて待てる＝chargeStart()。構えが画面に出ないと
        // 「もう引いて待てている」ことが分からない）。フォア/バックはサーブが打たれた
        // 瞬間に決まる（serve()）ので、それまではラケット側＝フォアの構えにしておく。
        const waitingReturn = this.you.charging && this.servingPlayer() !== 'you'
          && (this.phase === 'serve' || this.phase === 'fault');
        this.you.prep = waitingReturn ? (this.you.chargeStroke || 'forehand') : null;
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

    /**
     * ツイーナーを狙って背走している間だけ掛かる足の速さの倍率（それ以外は常に1）。
     * ロブで抜かれた球はバウンド後 12m/s 前後で後ろへ抜けていくので、通常の足
     * （PLAYER.SPEED=7.2m/s）では「ボールに追い越される一瞬」にしか手が届かない
     * ＝ツイーナーが事実上出せない技になっていた（SPECIAL.TWEENER のコメント参照）。
     * 「抜かれた球を追う背走ダッシュ」そのものを技の一部として扱い、この間だけ速くする。
     * 掛かる条件は狭く、ふだんの走りの感触は変えない：
     *   ・ツイーナーを装備していて、このゲームの回数がまだ残っている
     *   ・ラリー中で、相手の打った球が生きている
     *   ・その球が自陣にあって、すでに自分より後ろ（＝抜かれている）
     *   ・後ろへ入力している（前や横へ走るぶんには速くならない）
     * @returns {number}
     */
    tweenerChaseMult() {
      const { TWEENER } = SPECIAL;
      if (this.specials.indexOf('tweener') === -1 || this.usesLeft('tweener') <= 0) return 1;
      if (this.phase !== 'rally') return 1;
      const ball = this.ball;
      if (!ball.live || ball.last === 'you') return 1;
      if (ball.z >= PLAYER.NET_MARGIN) return 1;          // まだ自陣に入っていない
      // ここは向き（passedBehind の45°の扇）までは見ない：追いかけている最中は
      // まだボールの線に乗れていないのが普通で、乗るために走る足を速くするのが目的。
      if (ball.z >= this.you.z - TWEENER.BEHIND) return 1; // まだ抜かれていない
      if (this.input.moveZ >= 0) return 1;                // 後ろへ追っている間だけ
      return TWEENER.CHASE_MULT;
    }

    movePlayers(dt) {
      this.updateReactTimers(dt);
      // 縮地（Extreme の AI）は、このフレームの移動を測り始める前に済ませる
      // （tickAiDash() のコメント参照）。
      this.tickAiDash();

      const cpuBefore = { x: this.cpu.x, z: this.cpu.z };

      // トス中（自分のサーブで、まだ打っていない間）は、打点がトスした位置からずれてしまう
      // ので入力があっても一切動かさない（＝ボールはプレイヤーの手元ではなく静止したトス
      // 位置から放たれる、という見た目のずれをなくす）。打った直後のフォロースルー中
      // （recoverTimers.you）も同様に、入力があっても動き出せない。
      // 飛びつきボレーで飛び込んでいる間（you.dive）は、足元を tickDives() が動かす。
      if (!this.tossActive && this.recoverTimers.you <= 0 && !this.you.dive) {
        const youBefore = { x: this.you.x, z: this.you.z };
        const mx = this.input.moveX * INPUT_X_TO_WORLD;
        const mz = this.input.moveZ;
        const len = Math.hypot(mx, mz) || 1; // 斜め移動が速くならないように正規化
        const bounds = this.youBounds();

        // 目標速度（入力なしなら0）へ、加速度で少しずつ近づける。
        // 急停止・瞬間方向転換にならないので、コート上で滑るような自然さが出る。
        const hasInput = mx !== 0 || mz !== 0;
        const maxSpeed = PLAYER.SPEED * this.you.attr.speed
          * this.staminaSpeedMult(this.you.stamina) * this.tweenerChaseMult();
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
        // ＋＝ネット方向へ前進している（netDir で4人とも同じ意味に揃える）
        this.you.fwd = this.you.netDir * (this.you.z - youBefore.z) / dt;
        // 左右の移動は符号つきで積む（行って戻れば打ち消される＝「振り回された」量になる）
        this.you.runX += this.you.x - youBefore.x;
        this.you.sinceRunT = this.you.speed >= SPECIAL.BUGGY.MIN_SPEED ? 0 : this.you.sinceRunT + dt;
        this.drainStamina(this.you, moved);
      } else {
        this.you.vx = 0;
        this.you.vz = 0;
        this.you.speed = 0;
        this.you.fwd = 0;
        this.you.sinceRunT += dt;
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

      // ラリー外（サーブ待ち・フォールトのコール・ポイント間）では「打った側」を
      // 覚えない。ball.last は beginServe() をまたいでも前のポイントの値のまま残るので、
      // ここで覚えてしまうと「前のポイントで最後に打ったチーム」＝「次のサーバー」の
      // ときだけ owner が変化せず、そのサーブに対する反応遅延が丸ごと飛んでいた
      // （＝自分のミスやウィナーでポイントを終えた次の自分のサーブでは、CPU が
      // ノータイムでリターンに動き出していた）。null に戻しておけば、サーブが打たれて
      // phase が 'rally' になった最初のフレームで必ず「変化した」と見なされる。
      if (this.phase !== 'rally') {
        this.lastBallOwnerSeen = null;
        return;
      }
      const owner = this.ball.last;
      if (owner !== this.lastBallOwnerSeen) {
        // 能力値「リーチ・読み」が高い選手ほど反応遅延が短い（attr.react）。
        // コースが読みにくい1打（ツイーナー／バギーホイップ／読み負けたドロップ）は、
        // その分だけ反応の出足を遅らせる。
        const bonus = this.ball.reactBonus || 0;
        if (owner === 'you') {
          // 人間側のサーブ（serveInFlight）だけは、ラリー中の反応ではなく「サーブの読み」の
          // 範囲から毎回引き直す（CPU.SERVE_REACT_MIN/MAX のコメント参照）。
          const react = this.serveInFlight
            ? rand(CPU.SERVE_REACT_MIN, CPU.SERVE_REACT_MAX)
            : PLAYER.CPU_REACT;
          this.reactTimers.cpu = react * this.cpu.attr.react + bonus;
          this.reactTimers.cpuMate = react * this.cpuMate.attr.react + bonus;
          this.rollPoach(this.frontOf.cpu, 'cpu');
          this.rollAiRescue('cpu');
          this.rollAiRescue('cpuMate');
        } else if (owner === 'cpu') {
          this.reactTimers.youMate = PLAYER.CPU_REACT * this.youMate.attr.react + bonus;
          this.rollPoach('youMate', 'you');
          this.rollAiRescue('youMate');
        }
      }
      this.lastBallOwnerSeen = owner;
    }

    /**
     * 飛んできた1球に対して、その前衛が「ポーチに出る」かどうかを1回だけ決める。
     * 立っていれば触れる球（ai.poachSpot）は担当の判定で自然に拾うので、ここで決めるのは
     * 「ストレートを守る位置を捨てて中央へ仕掛けにいくか」だけ。能力値「ネット志向」
     * （attr.net）が高い選手ほどよく仕掛ける。
     * @param {'cpu'|'cpuMate'|'youMate'} mate 前衛（frontOf）
     * @param {'cpu'|'you'} team その前衛のチーム
     */
    rollPoach(mate, team) {
      // サーブへは仕掛けない。実際のダブルスと同じくレシーバー以外は手を出せない球なので、
      // 飛び出しても触れず、ネット際を空けるだけになる。
      this.poachCommit[mate] = this.doubles && !this.serveInFlight && this.hasFrontPlayer(team)
        && Math.random() < DOUBLES.POACH_CHANCE * this.actor(mate).attr.net;
    }

    /**
     * 飛んできた1球に対して、その AI が「救済技（縮地・飛びつきボレー）を出す気でいるか」を
     * 1回だけ決める。どちらも条件を満たしたフレームで出る技なので、毎フレーム
     * CPU.SPECIAL_CHANCE を引くと事実上必ず出てしまう＝確率の意味がなくなる
     * （他の技は「当たる瞬間」という1回きりの機会なので pickAiSpecial の中で引いている）。
     * @param {'cpu'|'cpuMate'|'youMate'} who
     */
    rollAiRescue(who) {
      const on = this.aiSpecialsOn();
      const moves = this.aiMoves();
      this.dashCommit[who] = on && moves.indexOf('shukuchi') !== -1
        && Math.random() < CPU.SPECIAL_CHANCE;
      this.diveCommit[who] = on && moves.indexOf('divingVolley') !== -1
        && Math.random() < CPU.SPECIAL_CHANCE;
    }

    /**
     * ポーチに出ると決めている前衛の、いまの迎撃点。出ると決めていない／どこにも
     * 間に合わない（＝仕掛けても届かない）なら null で、通常どおり構え位置に戻る。
     * @param {'cpu'|'cpuMate'|'youMate'} mate 前衛（frontOf）
     * @param {1|-1} side その前衛がいる陣地
     */
    poachTarget(mate, side) {
      if (!this.poachCommit[mate] || this.phase !== 'rally') return null;
      return poachRun(this.ball, this.actor(mate), side);
    }

    /** シングルスの CPU 移動（従来どおり）。ダブルスでは使わない。 */
    moveSinglesCpu(cpuBefore, dt) {
      // サーブ待ち中（phase==='serve'）は動かさない。newPoint() が置いたレシーブの構え位置
      // （サーブが狙う対角のボックス付近）から、サーブが打たれる前に homePosition()（センター）
      // へ歩いて戻ってしまうと、実際にサーブが来る頃には構えが崩れてしまう。
      // フォールトのコール中（'fault'）も同じ：どうせ直後の beginServe() でスタンスへ
      // 置き直されるので、その1秒ほどのために定位置へ歩き出させない。
      // 練習モードの CPU は球出し役なので、その場から動かない（打ち返しもしない。checkSwings()）
      if (this.phase === 'serve' || this.phase === 'fault' || this.practice) {
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
     * ダブルスの4人の移動。ソフトテニスの雁行陣（前衛＝frontOf、後衛＝その相方）を敷き、
     * 取りにいく側（doublesResponder）が返球に向かい、もう一方は役割どおりの位置で構える：
     * - 後衛が追っている間、前衛は展開（クロス／ストレート）に応じた構え（ai.frontPosition）。
     * - 前衛がポーチに出ている間、後衛はベースライン付近で逆サイドを開ける（ai.backPosition）。
     * 以前はどちらの場合も coverPosition()＝ネット際の鏡映しだったので、前衛がポーチに
     * 出ると後衛までネット際へ上がってしまい、触れなかったときに自陣ががら空きになっていた。
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
      // cpu チームの前衛・後衛（このポイントの間は入れ替わらない。frontOf 参照）
      const frontKey = this.frontOf.cpu;
      const backKey = MATE_OF[frontKey];
      const front = this.actor(frontKey);
      const back = this.actor(backKey);
      const frontBefore = { x: front.x, z: front.z };
      const backBefore = { x: back.x, z: back.z };
      const youMateBefore = { x: this.youMate.x, z: this.youMate.z };

      // cpu チーム：you 側の打球が向かってくる番なら、前衛・後衛のうち応答すべき方が追う
      // （doublesResponder：サーブリターン中はレシーバー固定、それ以外は持ち場で決める）。
      // 反応遅延タイマーが残っている間は、担当側でも静止したまま（＝逆を突かれる余地）。
      const cpuTeamChasing = this.phase === 'rally' && ball.last === 'you';
      // cpu 陣地の前衛の構え。相手の後衛（you チームの深い方）と味方後衛の
      // 位置関係＝展開で、ストレートを守るか・真ん中を越えて攻めに出るかが決まる。
      const cpuFront = () => frontPosition(this.doublesFoes(frontKey).back, back, DOUBLES.NET_Z_CPU);
      if (cpuTeamChasing && this.doublesResponder('cpu') === backKey) {
        if (this.reactTimers[backKey] <= 0) {
          this.moveIfRecovered(backKey, back, backBefore, chasePosition(ball, 1, back), PLAYER.CPU_CHASE, dt);
        } else {
          back.speed = 0;
        }
        // 後衛が追っている間、前衛は「仕掛ける」と決めていれば迎撃点へ全力で出て
        // （＝ポーチ）、そうでなければ展開に応じた構え位置へ寄る。
        const poach = this.reactTimers[frontKey] <= 0 ? this.poachTarget(frontKey, 1) : null;
        this.moveIfRecovered(frontKey, front, frontBefore,
          poach || cpuFront(), poach ? PLAYER.CPU_CHASE : DOUBLES.FRONT_MOVE, dt);
      } else if (cpuTeamChasing) {
        if (this.reactTimers[frontKey] <= 0) {
          this.moveIfRecovered(frontKey, front, frontBefore, chasePosition(ball, 1, front), PLAYER.CPU_CHASE, dt);
        } else {
          front.speed = 0;
        }
        this.moveIfRecovered(backKey, back, backBefore, backPosition(front.x, 1), PLAYER.CPU_RECOVER, dt);
      } else {
        this.moveIfRecovered(backKey, back, backBefore, homePosition(), PLAYER.CPU_RECOVER, dt);
        this.moveIfRecovered(frontKey, front, frontBefore, cpuFront(), DOUBLES.FRONT_MOVE, dt);
      }

      // youMate：人間（you）の打球が向かってくる番で、自分が応答すべき側なら追う
      // （doublesResponder：サーブリターン中はレシーバー固定、それ以外は近い方）。
      // 自陣（z<0）を追わせるため chasePosition には side=-1 を渡す。
      // 「下がれ」を指示されている間は、ロブを叩きにネット際まで走り出ていかない
      // （DOUBLES.BACK_SMASH_Z より手前のロブは、下がったままバウンドを待って返す）。
      const mateChasing = this.phase === 'rally' && ball.last === 'cpu'
        && this.doublesResponder('you') === 'youMate';
      const mateSmashNearZ = this.youMateFormation === 'back' ? DOUBLES.BACK_SMASH_Z : undefined;
      if (mateChasing && this.reactTimers.youMate <= 0) {
        this.moveIfRecovered('youMate', this.youMate, youMateBefore, chasePosition(ball, -1, this.youMate, mateSmashNearZ), PLAYER.CPU_CHASE, dt);
      } else if (mateChasing) {
        this.youMate.speed = 0;
      } else if (this.hasFrontPlayer('you')) {
        // 前衛として構える。cpu 側の前衛と同じ考え方（ポーチに出るか／展開に応じた構え）。
        const poach = this.reactTimers.youMate <= 0 ? this.poachTarget('youMate', -1) : null;
        this.moveIfRecovered('youMate', this.youMate, youMateBefore,
          poach || frontPosition(this.doublesFoes('youMate').back, this.you, DOUBLES.NET_Z_YOU),
          poach ? PLAYER.CPU_CHASE : DOUBLES.FRONT_MOVE, dt);
      } else {
        // 「下がれ」を指示されている間は前衛ではない＝従来どおり人間の逆サイドで構える。
        this.moveIfRecovered('youMate', this.youMate, youMateBefore, coverPosition(this.you.x, DOUBLES.BACK_Z_YOU), PLAYER.CPU_RECOVER, dt);
      }
    }

    /**
     * cpu/cpuMate/youMate 用。打った直後の硬直中（recoverTimers）はまだ動けないので棒立ちにし、
     * そうでなければ通常どおり moveTowards で目標へ寄せる。
     */
    moveIfRecovered(recoverKey, actor, before, target, speed, dt) {
      // 飛びつきボレーで飛び込んでいる間も、足元は tickDives() が動かす
      if (this.recoverTimers[recoverKey] > 0 || actor.dive) {
        actor.speed = 0;
        return;
      }
      this.moveTowards(actor, before, target, speed, dt);
    }

    /**
     * 新しい球が打たれた瞬間に、「その球を追って走った距離」の積算を0に戻す
     * （AI は chaseDist、人間は左右ぶんの runX）。
     * hit()・serve()・newPoint() から呼ぶ。打った直後の定位置戻り（recover）も同じ
     * moveTowards() を通って積算されるが、次に相手が打った時点でここが0に戻すので、
     * 実際に stretch を読む hit() の時点では常に「この球を追った距離」だけが入っている。
     */
    resetChase() {
      ACTORS.forEach((who) => {
        const actor = this.actor(who);
        actor.runX = 0;
        if (who !== 'you') actor.chaseDist = 0;
      });
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
      // 人間の you と同じ意味の2つ。Hard の AI が必殺技を出せるかの判定に使う
      // （fwd＝ネット方向へ前進している速さ、runX＝相手が打ってから左右へ動いた量）。
      actor.fwd = actor.netDir * (actor.z - before.z) / dt;
      actor.runX += actor.x - before.x;
      // 目標地点に着いて動かずにいる間だけ積む「待てている時間」。走り出したら0に戻る。
      // 走行距離(chaseDist)だけでは「遠くまで走ったが、先回りして落下点で待っていた」
      // 状況が「苦しい」と誤判定されるので、その打ち消しに使う（hit() のスマッシュ）。
      actor.settleT = actor.speed <= CPU.SETTLE_SPEED ? actor.settleT + dt : 0;
      this.drainStamina(actor, moved);
    }

    stepBall(dt) {
      const ball = this.ball;

      // トス中に振り出して待っていたサーブ（swingServe()）は、当たる時刻が来たステップで
      // 打つ。物理の刻み（1/240秒）で数えるので、打点のずれは 2cm 未満に収まる。
      if (this.tossActive) {
        integrate(ball, dt); // 重力だけで自然に上下させる（ラリーの当たり判定は通さない）
        if (this.tickServeClock(dt)) {
          this.serve(this.serveSwing.who);
          return;
        }
        if (ball.y <= SERVE.BALL_Y) {
          // 打たずに落ちてきた。トスをやり直せるようにリセットする（フォルトにはしない）
          this.tossActive = false;
          this.you.chargeKick = false; // 次のトスをどのキーで上げるかは、そのとき決め直す
          this.placeServeBall();
          this.hooks.call('サーブ', '←→ 左右のコース ／ ↑↓ 深さ ／ B/V/C 押しっぱなしで打つ');
        }
        return;
      }

      if (this.aiTossActive) {
        integrate(ball, dt); // tossActive と同じく重力だけで上下させる
        if (this.tickServeClock(dt)) {
          this.serve(this.serveSwing.who);
          return;
        }
        // 通常は TIMING.CPU_SERVE_DELAY 後に振り出し、打点まで落ちてきたところで serve() が
        // aiTossActive を落とすが、間に合わなかった場合の保険として、人間のトスと同じく自然に
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
      ball.sinceBounce += dt;

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
      const impactV = { vx: ball.vx, vz: ball.vz };
      // トップスピンは高く弾み、スライスは低く滑る（フラットは倍率1＝従来通り）。反発係数・
      // 摩擦の実装は physics.js の reflectBounce() に一本化してあり（predictBounceApex() も
      // 同じ実装を使う）、ここではその結果の座標を読むだけ。
      reflectBounce(ball);
      ball.sinceBounce = 0;
      this.lastBounce = { x: ball.x, z: ball.z, ...impactV, call: null };
      // 軌跡は通常 update() が1フレームに1点ずつ記録するだけなので、速い球ほど着地の瞬間を
      // 挟む2点の間隔が開き、IN/OUT判定に実際に使うこの着地座標（x,z）と、直線で結んだ軌跡が
      // 見せる「着地したように見える位置」がずれることがあった（＝軌跡ではINに見えるのに
      // 実際はOUT）。判定に使う座標そのものをここで明示的に1点追加しておくことで、
      // 軌跡が必ずこの座標を通るようにする。
      if (this.trail.length < TRAIL.MAX_POINTS) {
        this.trail.push({ x: ball.x, y: ball.y, z: ball.z });
      }
      ball.bounces++;
      // キックサーブは1バウンド目だけ大きく跳ね上げる（＝レシーバーを押し下げる）。
      // 目印はここで消すので、2バウンド目以降は普通に弾む。
      if (ball.kick) {
        ball.vy *= SPECIAL.KICK.BOUNCE_MULT;
        ball.kick = false;
      }
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
            this.callLine('safe', this.serveLines());
            return false;
          }
          this.callLine('fault', this.serveLines()); // serveFault() が serveNumber を進める前に
          this.serveFault('アウト');
          return true;
        }
        const ownSide = (ball.last === 'you' && ball.z < 0) || (ball.last === 'cpu' && ball.z > 0);
        // ダブルスはコート幅がダブルスサイドラインまで広がる（サービスボックスの幅は変えない）
        const rallyHalfWidth = this.doubles ? COURT.DW / 2 : HALF_W;
        const inCourt = Math.abs(ball.x) <= rallyHalfWidth + COURT.LINE_SLACK
          && Math.abs(ball.z) <= HALF_L + COURT.LINE_SLACK;
        if (ownSide || !inCourt) {
          // 自陣に落ちた球（ネットを越えなかった）は線の判定ではないので線審は動かない
          if (!ownSide) this.callLine('out', this.rallyLines(rallyHalfWidth));
          this.endPoint(opponent(ball.last), ownSide ? '相手コートに届かず' : 'アウト');
          return true;
        }
        this.callLine('safe', this.rallyLines(rallyHalfWidth));
        return false;
      }

      // 2バウンド＝返せなかった
      this.endPoint(ball.last, 'ツーバウンド');
      return true;
    }

    /** ラリーの1バウンド目に関わる線（ベースライン・サイドライン）。closestLine() 参照。 */
    rallyLines(halfWidth) {
      const { x, z } = this.ball;
      return [
        { line: 'base', inside: HALF_L - Math.abs(z), out: { x: 0, z: signOr(z, 1) } },
        { line: 'side', inside: halfWidth - Math.abs(x), out: { x: signOr(x, 1), z: 0 } },
      ];
    }

    /**
     * サーブの1バウンド目に関わる線（サービスライン・シングルスのサイドライン・センター
     * サービスライン）。inServiceBox() と同じ箱を、線ごとの距離に分けたもの。
     */
    serveLines() {
      const { x, z } = this.ball;
      const { dir, targetSign } = serveAim(this.server, this.match.serveSide);
      return [
        { line: 'service', inside: COURT.SERVICE - Math.abs(z), out: { x: 0, z: dir } },
        { line: 'side', inside: HALF_W - targetSign * x, out: { x: targetSign, z: 0 } },
        { line: 'center', inside: targetSign * x, out: { x: -targetSign, z: 0 } },
      ];
    }

    /**
     * 線審のコール。bounce() が1バウンド目を判定するたびに呼ぶ。アウト／フォールトは割った線、
     * インはいちばん際どい線が LINE_CALL.SAFE_MARGIN 以内のときだけ「セーフ」の合図になる
     * （余裕をもって入った球に線審は何もしない）。腕の合図は表示側が lineCall を読んで出し、
     * 声（アウト／フォルト。セーフは無言）はここで鳴らす。
     * @param {'out'|'fault'|'safe'} kind
     * @param {{line:string, inside:number, out:{x:number, z:number}}[]} lines
     */
    callLine(kind, lines) {
      const at = closestLine(lines);
      if (kind === 'safe' && at.inside > LINE_CALL.SAFE_MARGIN) return;
      this.lineCall = {
        kind,
        line: at.line,
        out: at.out,
        inside: at.inside, // 線までの内側への距離(m、負なら外)。際どさ（ボールマークを映すか）に使う
        x: this.ball.x,
        z: this.ball.z,
        // このコールでポイントが決まったか（アウト、またはセカンドサーブのフォールト）。
        // 練習はリプレイを流さないので立てない。
        decisive: !this.practice && (kind === 'out' || (kind === 'fault' && this.serveNumber !== 1)),
      };
      // このバウンドの跡（ボールマーク）を、判定どおりに線へ掛かる／掛からない位置に置くのに使う
      if (this.lastBounce) this.lastBounce.call = this.lineCall;
      if (kind !== 'safe') this.hooks.sound('lineCall', kind);
      // 際どさは音の側が見る（ライン際なら観客が「おぉ…」と漏らす。AUDIO.CROWD.OOH）
      this.hooks.sound('nearLine', at.inside);
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
      if (this.practice) {
        // 練習ではダブルフォルトにしない：自分のサーブなら失敗として数えて打ち直し、
        // CPU のサーブ（レシーブの練習）なら数えずにもう一度打たせる。
        this.phase = 'fault';
        this.serveInFlight = false;
        this.ball.live = false;
        if (this.server === 'you') {
          this.scoreRep(false, `フォールト（${reason}）`);
        } else {
          this.hooks.call('フォールト', 'CPU のサーブをもう一度');
          this.after(TIMING.FAULT_CALL, () => this.nextRep());
        }
        return;
      }
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

      // 飛びつきボレーで飛び込んでいる最中の選手がいれば、その1人が当たるまで誰も触らない
      // （相方に横取りさせない。当たる瞬間は tickDives() が決める）。
      const diving = ACTORS.find((w) => this.actor(w).dive);
      if (diving) {
        this.tickDives(diving);
        return;
      }

      // プレイヤーは溜めキーを押した瞬間の前後だけ打てる。人間が優先（AIパートナーに横取りさせない）
      if (ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN && this.you.swing > 0) {
        // 能力値「リーチ・読み」で手の届く範囲が広がる／狭まる（attr.reach）。
        // 必殺技（飛びつきボレー・ツイーナー・ダンクスマッシュ）はさらにその上から広がる。
        const extra = specialReach(this.you.special);
        // レシーブ（サーブを打ち返す1打）だけ RETURN.REACH_MULT ぶん広い（reachMult()）。
        const reach = PLAYER.REACH * this.reachMult() * extra.mult;
        if (this.you.special === 'divingVolley') {
          // 飛びつきボレーは、球に届く瞬間が迫った（DIVE.LUNGE_MIN 以内）ところで飛び込み、
          // 届いたところで当たる（startDive）。振りの有効時間がこの刻みで尽きるなら、
          // 届く瞬間がもう少し先でも今飛ぶ（待つと空振りになる）。ただし伸びたリーチに
          // 球が入ってくるのは、振りの有効時間のうちでなければならない（他の打ち方と同じ。
          // 入ってこない球は空振り）。
          const plan = this.diveTarget('you', () => reach);
          if (plan && plan.first.t <= this.you.swing
            && (plan.best.t <= SPECIAL.DIVE.LUNGE_MIN || this.you.swing <= STEP)) {
            this.you.swingConnected = true; // 振りは届いた（空振りの扱いにしない）
            this.you.swing = 0;
            this.startDive('you', plan.contact);
            return;
          }
        } else if (reaches(ball, this.you, reach) && ball.y < PLAYER.REACH_Y + extra.y) {
          this.hit('you');
          this.you.swing = 0;
        }
      }

      // ダブルスの youMate：人間が届かなかった／振らなかった球を、CPUと同様に自動で拾う。
      // 基本は自分が応答すべき側（doublesResponder）のときだけ——そうしないと人間が取る
      // べき球まで先に振ってしまう——だが、人間がどうやっても届かない球だけは担当外でも
      // 拾わせる（目の前に来た球を「担当ではないから」と見逃さないため。ユーザー報告）。
      // サーブリターン中だけはこの救済を外す：レシーバー以外が返してはいけない球なので。
      // ノーバウンドで返す（ボレー）のはネット際（VOLLEY_Z 以内）にいるときだけ。
      // それより後ろにいるなら、前に詰めていない＝1バウンド待ってグラウンドストロークで返す。
      if (this.doubles && ball.last !== 'you' && ball.z < PLAYER.NET_MARGIN) {
        const rescue = !this.serveInFlight
          && !reaches(ball, this.you, PLAYER.REACH * this.you.attr.reach);
        if (this.doublesResponder('you') === 'youMate' || rescue) this.swingAiAt('youMate', ball);
      }

      // CPU は届く範囲なら自動で振る。ダブルスでは応答すべき側（doublesResponder）を
      // 先に試し、その人が実際には届かなかったときだけ相方に回す（同じく見逃し防止）。
      // サーブリターン中はレシーバー固定なので相方には回さない。
      // 練習モードの CPU は打ち返さない＝自分の球は、入れば相手コートで2バウンドして決着する
      if (!this.practice && ball.last !== 'cpu' && ball.z > PLAYER.NET_MARGIN) {
        const responder = this.doubles ? this.doublesResponder('cpu') : 'cpu';
        const order = !this.doubles || this.serveInFlight
          ? [responder]
          : (responder === 'cpu' ? ['cpu', 'cpuMate'] : ['cpuMate', 'cpu']);
        order.some((key) => this.swingAiAt(key, ball));
      }
    }

    /**
     * その CPU/AI がいま実際にその球を打てるなら打つ。
     * 反応に使える時間ぶんに狭めた守備範囲で判定する（ai.reactReach 参照）。
     * 打たれてすぐ届く球（スマッシュ・至近距離のボレー）は体の近くしか触れない。
     * 能力値「リーチ・読み」の倍率は選手ごとに違うので、1人ずつ求める。
     * @returns {boolean} 実際に振ったら true
     */
    swingAiAt(who, ball) {
      const actor = this.actor(who);
      if (!aiCanReturnNow(actor, ball)) return false;
      if (ball.y >= PLAYER.CPU_REACH_Y || ball.y <= PLAYER.CPU_REACH_Y_MIN) return false;
      const reach = reactReach(ball.age, actor.attr.reach);
      if (reaches(ball, actor, reach)) {
        this.hit(who);
        return true;
      }
      // 普通のリーチでは届かない球でも、飛びつきボレー（Extreme のみ）なら手が届く。
      // 人間と同じく、ここから球へ飛び込んで、届いたところで当たる（startDive）。
      const dive = this.tryAiDive(who, ball, reach);
      if (!dive) return false;
      this.startDive(who, dive.at);
      return true;
    }

    /**
     * AI の飛びつきボレー（Extreme のみ。SPECIAL.AI.MOVES_ALL 参照）。
     * 人間の条件（SPECIAL_MATCH.divingVolley＝「ノーバウンドだが、普通に振ったのでは
     * 届かない」）をそのまま AI の当たり判定へ移したもので、伸びたリーチ
     * （SPECIAL.DIVE.REACH_MULT）でだけ届く球のときに飛び込むと決め、この1打に技が乗る旗を
     * 立てる（hit() が受け取る）。代償——打った後の長い硬直（DIVE.RECOVER）——も人間と同じ。
     * 出すかどうかの抽選は球ごとに1回（diveCommit）。
     * **飛び込むと決める瞬間は、伸びたリーチに球が入った瞬間のまま**（打点の見込みで早めに
     * 決めると、後ずさりしてネット際を離れる前に決まる＝取れる球が増え、強さが変わる）。
     * 当たるのはその後、diveTarget() で選んだ打点（普通のリーチに入る前まで）。
     * @param {number} reach いま普通に手を伸ばして届く距離(m)（reactReach の結果）
     * @returns {{at:object|null}|null} 飛び込むなら打点（diveTarget の contact。見込みが
     *   立たなければ null＝この場で当てる）。飛び込まないなら null
     */
    tryAiDive(who, ball, reach) {
      if (!this.aiSpecialsOn() || !this.diveCommit[who]) return null;
      if (this.aiMoves().indexOf('divingVolley') === -1) return null;
      if (this.usesLeft('divingVolley', who) <= 0) return null;
      if (ball.bounces !== 0) return null; // ボレーの場面だけ（バウンド後の球は対象外）
      const actor = this.actor(who);
      if (Math.abs(actor.z) > PLAYER.VOLLEY_Z) return null; // ネット際にいるときだけ
      const { REACH_MULT } = SPECIAL.DIVE;
      if (!reaches(ball, actor, reach * REACH_MULT)) return null;
      this.diveCommit[who] = false;
      actor.diveVolley = true;
      // 手の届く範囲は打たれてからの時間で広がる（reactReach）ので、見込みの各瞬間には
      // その瞬間の範囲を使う。普通のリーチに入ってくる瞬間より後は選ばない（体のそばまで
      // 来た球へ飛び込むことになる）。
      const plan = this.diveTarget(who, (t) => reactReach(ball.age + t, actor.attr.reach) * REACH_MULT,
        1 / REACH_MULT);
      return { at: plan && plan.contact };
    }

    /**
     * 飛びつきボレーの打点の見込み。これから DIVE.LUNGE_MAX 秒の軌道のうち、伸びたリーチ
     * （reachAt）の中にいる間（ノーバウンドで、自陣の、打てる高さ）から、**伸ばした体で
     * いちばん届きやすい瞬間**を選ぶ。届きやすさは「足元からの水平距離 − その高さで伸ばした
     * 体が届く水平距離（diveStretch）」の小ささで、同じくらいなら早いほうを選ぶ
     * （DIVE.LATE_COST。真上から落ちてくるだけの球を、低くなるまで待たないため）。
     * いま立っている場所のままで見積もる。
     * @param {string} who
     * @param {(t:number) => number} reachAt t 秒後の伸びたリーチ(m)
     * @param {number} [inner] 足元からの水平距離が伸びたリーチのこの割合より近づいたら、
     *   そこで打ち切る（普通のリーチに入ってくる球を、その手前で捉えるため）
     * @returns {{first:object, best:object, contact:object}|null}
     *   first＝リーチに入る最初の瞬間、best＝いちばん届きやすい瞬間、contact＝飛び込みに
     *   要る時間（LUNGE_MIN）より後でいちばん届きやすい瞬間（そんな瞬間が無ければ best）。
     *   リーチに入ってこないなら null。瞬間はどれも predictWindow() のサンプル
     *   （t は今からの秒数）。
     */
    diveTarget(who, reachAt, inner = 0) {
      const actor = this.actor(who);
      const { DIVE } = SPECIAL;
      const score = (at) => Math.hypot(at.x - actor.x, at.z - actor.z) - diveStretch(at.y)
        + DIVE.LATE_COST * at.t;
      let first = null;
      let best = null;
      let late = null;
      let over = false; // リーチに入ってから出た（ひとつながりの区間はそこまで）
      const consider = (at) => {
        const ratio = Math.hypot(at.x - actor.x, at.z - actor.z) / reachAt(at.t);
        const ok = !over && ratio < 1 && ratio >= inner && at.y < PLAYER.REACH_Y
          && at.z * NET_DIR[who] < PLAYER.NET_MARGIN;
        if (!ok) {
          if (first) over = true;
          return false;
        }
        if (!first) first = at;
        if (!best || score(at) < score(best)) best = at;
        if (at.t >= DIVE.LUNGE_MIN && (!late || score(at) < score(late))) late = at;
        return true;
      };
      // いまの位置も候補に入れる（predictWindow は1刻み先から。離れていく球には、いまが
      // 最後の届く瞬間ということがある）。この先はノーバウンドのまま（弾んだら打ち切る）。
      const ball = this.ball;
      consider({ x: ball.x, y: ball.y, z: ball.z, t: 0 });
      predictWindow(ball, consider, DIVE.LUNGE_MAX, 0);
      return best ? { first, best, contact: late || best } : null;
    }

    /**
     * 飛びつきボレーの飛び込みを始める（人間は checkSwings から、球に届く瞬間が飛び込みに
     * 要る時間 DIVE.LUNGE_MIN 以内に迫ったとき。AI は swingAiAt から、伸びたリーチに球が
     * 入ったとき＝飛び込むと決めたとき）。
     *
     * **すぐには打たない。** 以前は伸びたリーチに球が入った瞬間に当てていたので、3m 先の
     * 球を直立したまま打ち返す＝ラケットと球が離れて見えた（ユーザー報告）。代わりに
     * 見込んだ打点（at）まで体ごと球へ飛び込む：伸ばした体で届く水平距離（diveStretch）
     * まで、足元も球のほうへ移す（DIVE.MAX_TRAVEL まで）。実際に当てるのは tickDives()。
     * 打点の向き（フォア／バック）も、溜め始めの見込みではなく飛び込む先で決める
     * ＝ラケットを持つ手が球の側に来る。
     * @param {string} who
     * @param {{x:number, y:number, z:number, t:number}|null} at 打点（diveTarget の contact）。
     *   null ならいまの球の位置でこの場で当てる
     */
    startDive(who, at) {
      const actor = this.actor(who);
      const ball = this.ball;
      const { DIVE } = SPECIAL;
      const point = at || {
        x: ball.x, y: ball.y, z: ball.z, t: 0,
      };
      const dx = point.x - actor.x;
      const dz = point.z - actor.z;
      const dist = Math.hypot(dx, dz);
      const travel = clamp(dist - diveStretch(point.y), 0, DIVE.MAX_TRAVEL);
      const k = dist > 1e-6 ? travel / dist : 0;
      let x1 = actor.x + dx * k;
      let z1 = actor.z + dz * k;
      if (who === 'you') {
        const bounds = this.youBounds();
        x1 = clamp(x1, bounds.xMin, bounds.xMax);
        z1 = clamp(z1, bounds.zMin, bounds.zMax);
      }
      actor.dive = {
        t: 0,
        span: point.t,
        age0: ball.age, // 経過時間は球の ball.age で測る（tickDives）
        x0: actor.x,
        z0: actor.z,
        x1,
        z1,
        ball: { x: point.x, y: point.y, z: point.z },
        stroke: RACKET_SIDE[who] * dx >= 0 ? 'forehand' : 'backhand',
      };
      actor.speed = 0;
      if (who === 'you') {
        this.you.vx = 0;
        this.you.vz = 0;
      }
      if (point.t <= 0) this.tickDives(who); // 飛び込む間もない球は、この場で当てる
    }

    /**
     * 飛び込んでいる選手を1刻みぶん進める（checkSwings から物理の刻みごとに）。足元を
     * 飛び込む先へ寄せ、打点の時刻に届いたら当てる。時刻は球の ball.age（打たれてからの
     * 経過時間）で測る＝物理の刻みとぴったり揃う。
     * @param {string} who 飛び込んでいる選手
     */
    tickDives(who) {
      const actor = this.actor(who);
      const dive = actor.dive;
      dive.t = this.ball.age - dive.age0;
      const u = dive.span > 0 ? clamp(dive.t / dive.span, 0, 1) : 1;
      // 踏み切りで一気に出て、伸びきるところでは足元がほぼ止まっている
      const move = 1 - (1 - u) * (1 - u);
      actor.x = lerp(dive.x0, dive.x1, move);
      actor.z = lerp(dive.z0, dive.z1, move);
      // 打点の時刻（予測と同じ刻みで数えた時間）。足し算の誤差で1刻み遅れないよう少し甘く見る
      if (dive.t < dive.span - 1e-6) return;
      actor.x = dive.x1;
      actor.z = dive.z1;
      this.hit(who); // 打ち方の向きは dive.stroke（hit() が見る）
      actor.dive = null;
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
