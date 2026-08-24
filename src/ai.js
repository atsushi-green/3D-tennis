/**
 * CPU の判断だけを集めたファイル。難易度を触りたいときはここと config の CPU を見る。
 * 状態は持たず、入力から目標値を返すだけ。
 */
(function (RallyOne) {
  'use strict';

  const {
    CPU, DOUBLES, HALF_L, HALF_W, PHYSICS, PLAYER,
  } = RallyOne.config;
  const {
    clamp, lerp, rand, signOr,
  } = RallyOne.math;
  const {
    predictLanding, predictBounceApex, predictApex, predictAtZ,
  } = RallyOne.physics;

  /**
   * その球に対して CPU/AI が実際に使える守備範囲(m)。
   * 打たれてからボールが届くまでの時間（＝反応に使える時間）が短いほど狭くなり、
   * PLAYER.CPU_REFLEX_T_MIN 以下では反射で触れるだけの CPU_REFLEX_REACH まで落ちる。
   * CPU/AI は打たれた瞬間から軌道を知っているので、この制限が無いとスマッシュや至近距離の
   * ボレーでも CPU_REACH(1.45m) の円をまるごと使えてしまう。1バウンドを挟む普通のラリー球は
   * 1秒以上かけて届くので、従来どおり CPU_REACH のまま。
   * @param {number} age ボールが打たれてからの経過時間(秒)。game.js の ball.age。
   */
  function reactReach(age) {
    const t = clamp(
      ((age || 0) - PLAYER.CPU_REFLEX_T_MIN) / (PLAYER.CPU_REFLEX_T_MAX - PLAYER.CPU_REFLEX_T_MIN),
      0, 1,
    );
    return lerp(PLAYER.CPU_REFLEX_REACH, PLAYER.CPU_REACH, t);
  }

  /**
   * 「その深さ(z)でボールを迎える」と決めたときの、弾道上の x。
   * バウンド1回ぶんは跨いで追う（速い球は打点が必ずバウンドの後になるため）。
   * そこまで届かない／高すぎて打てないなら fallbackX をそのまま返す。
   */
  function pathXAt(ball, z, fallbackX) {
    const at = predictAtZ(ball, z, undefined, 1);
    return at && at.y < PLAYER.CPU_REACH_Y ? at.x : fallbackX;
  }

  /**
   * target（弾道上の打点）を、anchor から CPU.CHASE_APEX_LEAD_MAX 以上は離れないように引き寄せる。
   * z を引き寄せたときは、横位置もその深さでの弾道の x に取り直す：x と z を別々にクランプすると
   * 「深さは手前、横位置はずっと奥のもの」という、弾道上のどこにも存在しない点が目標になる。
   * フル溜めのフラットサーブのようにバウンド後も速い球ではこのずれが2m以上に達し、CPU は
   * ボールが自分の横を通り抜けるのに真横へ走って離れていく（＝立っていれば届いた球を自分から
   * 避ける）挙動になっていた。ボディへのフルパワーサーブが実測27.6%もエースになっていた原因。
   */
  function leadFrom(ball, anchor, target) {
    const z = anchor.z + clamp(target.z - anchor.z, -CPU.CHASE_APEX_LEAD_MAX, CPU.CHASE_APEX_LEAD_MAX);
    if (z === target.z) return { x: target.x, z };
    return { x: pathXAt(ball, z, target.x), z };
  }

  /**
   * 追跡目標として使う地点。
   * まだ一度もバウンドしていない球は predictBounceApex() で「1回バウンドした後、
   * 打ちやすい高さまで上がってきた頂点」を先読みする。単純な着地点（＋固定の後退量）
   * だけだと、サービスボックスのようにネットに近い場所へ着地する球でも、実際の打点は
   * バウンド後さらに奥まで戻ってくることを見逃してしまい、着地の瞬間になって初めて
   * 大きく方向転換する羽目になっていた（＝間に合わずぎりぎりの弱い返球になる）。
   * バウンド前から本当の打点を見越して動けるようにする。
   * ただし、その頂点は実際の着地点（predictLanding）から CPU.CHASE_APEX_LEAD_MAX を
   * 超えては先読みしない（威力の弱いサーブでもコートの縦の長さぶん初速自体は速いため、
   * 低く速い弾道だと頂点が着地点からコート外まで達するほど遠くなることがあり、
   * そのまま追わせると逆に打点から大きく外れてしまうため）。
   *
   * 既にバウンドした球にこれと同じ「頂点」を求める場合（predictApex()）は、まだ
   * 上がっている途中（vy>0）だけ使う。頂点は現在地から一意に決まる固定点（風が
   * なければ）なので、時間ベースの先読みと違い、球が近づいてもずるずる先へ動かない。
   * こちらは現在のボール位置（＝もう着地済みなので、着地点そのもの）からの先読み量を
   * 同じ CHASE_APEX_LEAD_MAX で制限する。頂点を過ぎて下り始めていたら素直に現在地を
   * 追わせる（頂点はもう過ぎているので、これ以上先読みする意味がない）。
   */
  function chaseTarget(ball) {
    if (ball.bounces === 0) return leadFrom(ball, predictLanding(ball), predictBounceApex(ball));
    if (ball.vy > 0) return leadFrom(ball, ball, predictApex(ball));
    return { x: ball.x, z: ball.z };
  }

  /**
   * 既にボールへ手が届く範囲にいるか（＝これ以上動く必要がない）。
   * バウンドした瞬間に追跡目標（着地点の後ろ→頂点や現在地）が切り替わるせいで、実際には
   * もう届く位置に構えられているのに「新しい目標までの距離」だけを見て全力で走り出したと
   * 判定され（＝打点での実速度が跳ね上がり stretch が最大になる＝ゆるい返球になる）てしまう
   * ことがあった。見た目には十分な余裕をもって追いついているのに返球が弱くなる主因だったので、
   * 目標地点がどこであれ「もう届く」ならそもそも動かさない（＝待球）。
   * 高さは上限（CPU_REACH_Y）だけ見る。下限（CPU_REACH_Y_MIN）まで入れると、バウンド直後の
   * まだ弾みきっていない一瞬（y が下限をわずかに下回る数フレーム）だけこの判定を素通りして
   * しまい、すぐ次のフレームには打てる高さまで上がってくるのに、その一瞬だけ切り取って
   * 「まだ届かない」→ 新しい目標へ全力で動き出した扱いになってしまっていた。
   */
  function inReachOf(player, ball) {
    return ball.y < PLAYER.CPU_REACH_Y
      && Math.hypot(player.x - ball.x, player.z - ball.z) <= reactReach(ball.age);
  }

  /**
   * ボールを追うときに立ちたい位置。
   * CPU.CHASE_Z_* はもともと cpu 陣地（z>0）基準の値なので、you 陣地（z<0）の
   * youMate が使うときは side=-1 を渡して z 方向を鏡映しにする（自陣を追わせるため）。
   * @param {1|-1} [side] 追う選手がいる陣地。既定は 1（cpu 陣地）。
   * @param {{x:number, z:number}} [player] 追う本人の現在位置。渡された場合のみ
   *   inReachOf() / canPoach() を見る。省略時（isResponder 用の距離比較など）は
   *   常に旧来の着地点基準。
   *   既に届く位置にいるならそこに留まり、ネット際で canPoach() できるときは
   *   着地点（＝深い場所）まで下がらせるのではなく、その場でボールが自分の前を通る
   *   位置まで横に寄らせるだけにする（＝ポーチできる態勢を保つ）。
   * @returns {{x:number, z:number}}
   */
  function chasePosition(ball, side = 1, player) {
    if (player && inReachOf(player, ball)) {
      return { x: player.x, z: player.z };
    }
    if (player && canPoach(player, ball)) {
      const at = predictAtZ(ball, player.z);
      return { x: clamp(at.x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT), z: player.z };
    }
    // chaseTarget() はバウンド前・後のどちらでも「実際に打ちやすい高さまで上がってきた
    // 頂点」を返す（predictBounceApex()/predictApex()）ので、そこからさらに下がる
    // 必要はない。世界座標としての妥当な範囲にだけ収める。
    const landing = chaseTarget(ball);
    const zMin = side > 0 ? CPU.CHASE_Z_MIN : -CPU.CHASE_Z_MAX;
    const zMax = side > 0 ? CPU.CHASE_Z_MAX : -CPU.CHASE_Z_MIN;
    // 打点が後方限界（CHASE_Z_MAX）より奥＝そこで待つことは物理的にできない。leadFrom() と
    // 同じ理由で、深さを手前へ寄せたら横位置もその深さでの弾道の x に取り直す。
    const z = clamp(landing.z, zMin, zMax);
    const x = z === landing.z ? landing.x : pathXAt(ball, z, landing.x);
    return {
      x: clamp(x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT),
      z,
    };
  }

  /** ラリーが自分に関係ないときの定位置 */
  function homePosition() {
    return { x: 0, z: CPU.HOME_Z };
  }

  /**
   * 打球の狙い先。相手プレイヤーの逆をつきつつ、一定確率でミスもする。
   * @param {number} opponentX 逆をつく相手（返球を受ける側）の現在位置
   * @param {1|-1} [dir] 打ち込む方向。既定は -1（z<0側＝you陣地。cpu が you を狙う従来の向き）。
   *   you 陣地の選手（youMate）が cpu 陣地（z>0）を狙うときは +1 を渡す。
   * @param {number} [stretch] 0〜1。ぎりぎり追いついて打った度合い（hit() が実速度から算出）。
   *   大きいほど狙いが浅く・中央寄りになり、ミスの確率も上がる（＝弱気な返球）。
   * @returns {{x:number, y:number, z:number}} ワールド座標の目標地点
   */
  function shotTarget(opponentX, dir = -1, stretch = 0) {
    const aimXMin = lerp(CPU.AIM_X_MIN, CPU.STRETCH_AIM_X_MIN, stretch);
    const aimXMax = lerp(CPU.AIM_X_MAX, CPU.STRETCH_AIM_X_MAX, stretch);
    const aimZMin = lerp(CPU.AIM_Z_MIN, CPU.STRETCH_AIM_Z_MIN, stretch);
    const aimZMax = lerp(CPU.AIM_Z_MAX, CPU.STRETCH_AIM_Z_MAX, stretch);
    const outLong = lerp(CPU.OUT_LONG, CPU.STRETCH_OUT_LONG, stretch);
    const outWide = lerp(CPU.OUT_WIDE, CPU.STRETCH_OUT_WIDE, stretch);

    let x = -signOr(opponentX, Math.random() - 0.5) * rand(aimXMin, aimXMax);
    let z = dir * rand(aimZMin, aimZMax);

    if (Math.random() < outLong) z = dir * (HALF_L + 0.9);          // ベースラインオーバー
    if (Math.random() < outWide) x = Math.sign(x) * (HALF_W + 0.7); // サイドアウト

    return { x, y: PHYSICS.BALL_R, z };
  }

  /**
   * CPU/AI の返球1本ぶんの狙い（着地点と飛翔時間）。通常は shotTarget() の低い弾道だが、
   * 一定確率でロブ（山なりの返球）を選ぶ。ロブを選ぶのは実際のテニスと同じ2つの場面：
   *   1. 相手がネットに詰めている（CPU.NET_Z 以内）＝頭を越す攻めのロブ
   *   2. 自分がぎりぎりで追いついた（stretch が大きい）＝時間を稼ぐ逃げのロブ
   * ロブが無いと PLAYER.SMASH_MIN_Y を満たす高い球が来ず、人間がスマッシュを打つ機会が
   * シングルスでほぼ発生しなかった。
   * @param {{x:number, z:number}} opponent 返球を受ける側（逆をつく相手）
   * @param {1|-1} dir 打ち込む方向（shotTarget と同じ）
   * @param {number} stretch 0〜1。ぎりぎり追いついて打った度合い
   * @returns {{target:{x:number,y:number,z:number}, flight:number, lob:boolean}}
   */
  function cpuShot(opponent, dir, stretch) {
    // 相手が自陣のどのあたりにいるかはネットからの距離で見る（dir の符号に依存させない）
    const atNet = Math.abs(opponent.z) <= CPU.NET_Z;
    const chance = atNet ? CPU.LOB_VS_NET : CPU.LOB_BASE + CPU.LOB_VS_STRETCH * stretch;
    if (Math.random() < chance) {
      return {
        target: {
          x: -signOr(opponent.x, Math.random() - 0.5) * rand(0, CPU.LOB_X),
          y: PHYSICS.BALL_R,
          z: dir * rand(CPU.LOB_Z_MIN, CPU.LOB_Z_MAX),
        },
        flight: CPU.LOB_T,
        lob: true,
      };
    }
    return {
      target: shotTarget(opponent.x, dir, stretch),
      flight: lerp(CPU.SHOT_T, CPU.STRETCH_T, stretch),
      lob: false,
    };
  }

  /**
   * ネット際にいる選手が、まだ着地していないボールを待たずに横取り（ポーチ）できるか。
   * isResponder() を着地点までの距離だけで決めると、前衛の目の前を素通りする球でも
   * 着地点は後衛側（深い場所）になるため常に後衛任せになり、前衛が全くボレーしない
   * （＝スルーする）事態になっていた。ここでは「まだバウンドしていない球が、自分の
   * いる深さ（z）を通過する瞬間、自分の届く範囲・高さにあるか」を直接シミュレートする。
   */
  function canPoach(player, ball) {
    if (ball.bounces > 0 || Math.abs(player.z) > PLAYER.VOLLEY_Z) return false;
    const at = predictAtZ(ball, player.z);
    if (!at) return false;
    // 通過するのは at.t 秒後なので、そのときの反応時間は「今までの経過＋これから」。
    // 今の age だけで判断すると、まだ余裕があるのに反射扱いになって前衛が出て行かない。
    return Math.abs(at.x - player.x) <= reactReach((ball.age || 0) + at.t)
      && at.y < PLAYER.CPU_REACH_Y && at.y > PLAYER.CPU_REACH_Y_MIN;
  }

  /**
   * ダブルスのペアのうち、どちらが返球を担当するか。
   * ネット際にいる方が canPoach() できるならそちらを優先し（ポーチ）、
   * そうでなければ落下点までの距離が近い方が応答し、もう一方は構えに回る。
   * @returns {boolean} me（1人目）が担当するなら true
   */
  function isResponder(me, mate, ball) {
    const meCanPoach = canPoach(me, ball);
    const mateCanPoach = canPoach(mate, ball);
    if (meCanPoach !== mateCanPoach) return meCanPoach;

    const landing = chaseTarget(ball);
    const dMe = Math.hypot(me.x - landing.x, me.z - landing.z);
    const dMate = Math.hypot(mate.x - landing.x, mate.z - landing.z);
    return dMe <= dMate;
  }

  /**
   * 応答しない方が構える位置。相方の反対サイドへ寄って、ネット際で待つ。
   * @param {number} responderX 応答している側の現在位置
   * @param {number} netZ 自陣のネット際の深さ（DOUBLES.NET_Z_YOU / NET_Z_CPU）
   */
  function coverPosition(responderX, netZ) {
    const x = clamp(-responderX * DOUBLES.MIRROR, -DOUBLES.SLOT_X, DOUBLES.SLOT_X);
    return { x, z: netZ };
  }

  RallyOne.ai = {
    chasePosition, homePosition, shotTarget, cpuShot, isResponder, coverPosition, reactReach,
  };
})(window.RallyOne = window.RallyOne || {});
