/**
 * CPU の判断だけを集めたファイル。難易度を触りたいときはここと config の CPU を見る。
 * 状態は持たず、入力から目標値を返すだけ。
 */
(function (RallyOne) {
  'use strict';

  const {
    CPU, DOUBLES, HALF_L, HALF_W, NEUTRAL_ATTR, PHYSICS, PLAYER, SERVE,
  } = RallyOne.config;
  const {
    clamp, lerp, rand, signOr,
  } = RallyOne.math;
  const {
    predictLanding, predictBounceApex, predictApex, predictAtZ, predictWindow,
  } = RallyOne.physics;

  /**
   * その球に対して CPU/AI が実際に使える守備範囲(m)。
   * 打たれてからボールが届くまでの時間（＝反応に使える時間）が短いほど狭くなる、2段の坂：
   *   CPU_BLIND_T(0.22秒)以下 …… CPU_BLIND_REACH。見てから体を動かす時間すらないので、
   *     体の正面へ来た球にラケットが当たるだけ。
   *   〜CPU_REFLEX_T_MIN(0.35秒) … CPU_REFLEX_REACH へ。その場で腕を伸ばす反射。
   *   〜CPU_REFLEX_T_MAX(0.80秒) … CPU_REACH へ。一歩動いて構えられる。
   * CPU/AI は打たれた瞬間から軌道を知っているので、この制限が無いとスマッシュや至近距離の
   * ボレーでも CPU_REACH の円をまるごと使えてしまう。1バウンドを挟む普通のラリー球は
   * 1秒以上かけて届くので、従来どおり CPU_REACH のまま。
   * @param {number} age ボールが打たれてからの経過時間(秒)。game.js の ball.age。
   * @param {number} [reachMult] その選手の能力値「リーチ・読み」による倍率（既定1＝中立）。
   */
  function reactReach(age, reachMult = 1) {
    const t = age || 0;
    const ramp = (from, to, min, max) => lerp(from, to, clamp((t - min) / (max - min), 0, 1));
    const reach = t < PLAYER.CPU_REFLEX_T_MIN
      ? ramp(PLAYER.CPU_BLIND_REACH, PLAYER.CPU_REFLEX_REACH,
        PLAYER.CPU_BLIND_T, PLAYER.CPU_REFLEX_T_MIN)
      : ramp(PLAYER.CPU_REFLEX_REACH, PLAYER.CPU_REACH,
        PLAYER.CPU_REFLEX_T_MIN, PLAYER.CPU_REFLEX_T_MAX);
    return reach * reachMult;
  }

  /**
   * その選手の能力倍率（config.ATTRS の1人ぶん）。game.js のアクターは自分の分を `attr` に
   * 持っているが、テストなどの素の {x, z} オブジェクトには無いので、その場合は中立
   * （すべて1.0＝能力値がすべて既定3のときと同じ）を返す。
   */
  function attrOf(player) {
    return (player && player.attr) || NEUTRAL_ATTR;
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
      && Math.hypot(player.x - ball.x, player.z - ball.z) <= reactReach(ball.age, attrOf(player).reach);
  }

  /**
   * 頭上へ上がってきた球（ロブ）を、バウンドを待たずに叩ける先回り地点。
   * 人間側の smashSpot()（game.js、ヒント表示用）の CPU/AI 版で、考え方は同じ：
   * 「まだバウンドしていないまま、打てる高さの帯（SMASH_MIN_Y 〜 CPU_REACH_Y の少し下）を
   * 通り、かつコートの中（SMASH_Z_MIN〜SMASH_Z_MAX）である区間」を先読みし、その真ん中で待つ。
   *
   * 帯の上端から入ってくること（enter.y が上端付近）を条件にしてあるのは、本当に上から
   * 落ちてくる球＝ロブだけを対象にするため。これが無いと、ネット際を胸の高さで通り過ぎる
   * だけの速い球にも「叩ける帯を通る」と反応して前へ飛び出してしまう。
   * 走って間に合わないなら null を返し、呼び出し側は従来どおりバウンド後の頂点を追う
   * （空中で叩きにいって届かず、そのまま頭上を抜かれる、という最悪の形を避ける）。
   * @param {1|-1} side 追う選手がいる陣地（1＝cpu 陣地 z>0）
   * @param {number} [nearZ] 叩きにいく範囲のネット側の限界（ネットからの深さ。正の値で渡す）。
   *   既定は CPU.SMASH_Z_MIN＝ネット際まで詰めて叩く。前へ出てはいけない選手——ダブルスで
   *   「下がれ」を指示されたパートナー（game.js#moveDoublesTeams）——はここを深くして渡す。
   *   これより手前を通るロブは「叩ける区間」と見なさないので、そのままバウンドを待つ
   *   （＝指示どおり下がったまま、1バウンドさせてグラウンドストロークで返す）。
   * @returns {{x:number, z:number}|null}
   */
  function smashApproach(ball, player, side, nearZ = CPU.SMASH_Z_MIN) {
    if (ball.bounces > 0) return null;
    const top = PLAYER.CPU_REACH_Y - CPU.SMASH_Y_SLACK;
    if (top <= CPU.SMASH_MIN_Y) return null;
    if (nearZ >= CPU.SMASH_Z_MAX) return null; // 叩ける区間が残っていない
    const zMin = side > 0 ? nearZ : -CPU.SMASH_Z_MAX;
    const zMax = side > 0 ? CPU.SMASH_Z_MAX : -nearZ;
    // 帯に入るまでに自陣の上空をどこまで高く通ったか。predictWindow() は軌道を時間順に
    // なめるので、帯へ降りてくる時点でこの値には「それ以前の最高到達点」が入っている。
    let peak = 0;
    const smashable = (at) => {
      const inCourt = at.z >= zMin && at.z <= zMax;
      if (inCourt) peak = Math.max(peak, at.y);
      return at.bounces === 0 && inCourt && at.y >= CPU.SMASH_MIN_Y && at.y <= top;
    };
    const window = predictWindow(ball, smashable, CPU.SMASH_LEAD_T, 0);
    if (!window) return null;
    if (window.enter.y < top - CPU.SMASH_ENTER_SLACK) return null; // 上から落ちてきた球ではない
    if (peak < CPU.SMASH_LOB_PEAK) return null; // そもそも高く上がっていない＝ロブではない
    const { mid } = window;
    const runT = Math.hypot(mid.x - player.x, mid.z - player.z) / PLAYER.CPU_CHASE;
    if (runT > mid.t * CPU.SMASH_CHASE_MARGIN) return null; // 走っても間に合わない
    return { x: clamp(mid.x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT), z: mid.z };
  }

  /**
   * ボールを追うときに立ちたい位置。
   * CPU.CHASE_Z_* はもともと cpu 陣地（z>0）基準の値なので、you 陣地（z<0）の
   * youMate が使うときは side=-1 を渡して z 方向を鏡映しにする（自陣を追わせるため）。
   * @param {1|-1} [side] 追う選手がいる陣地。既定は 1（cpu 陣地）。
   * @param {{x:number, z:number}} [player] 追う本人の現在位置。渡された場合のみ
   *   inReachOf() / smashApproach() / poachSpot() を見る。省略時（isResponder 用の
   *   距離比較など）は常に旧来の着地点基準。
   *   既に届く位置にいるならそこに留まり、ネット際で触れるときは着地点（＝深い場所）まで
   *   下がらせるのではなく、その球を捕まえられる地点まで寄らせるだけにする
   *   （＝ポーチできる態勢を保つ）。
   * @param {number} [smashNearZ] ロブを叩きにいく範囲のネット側の限界。そのまま
   *   smashApproach() に渡す（省略時はネット際まで詰めて叩く既定のまま）。
   * @returns {{x:number, z:number}}
   */
  function chasePosition(ball, side = 1, player, smashNearZ) {
    if (player && inReachOf(player, ball)) {
      return { x: player.x, z: player.z };
    }
    // 頭上に上がってきた球は、バウンドを待たずに叩ける位置へ先回りする（＝スマッシュ）。
    // 間に合わないと判断したときだけ null が返り、従来どおりバウンド後の頂点を追う。
    if (player) {
      const smash = smashApproach(ball, player, side, smashNearZ);
      if (smash) return smash;
      // ネット際にいるなら、バウンドを待たずに触れる地点（ポーチ）を優先する。
      // poachSpot() は自分の深さちょうどだけでなく前後の帯も見るので、半歩前へ踏み込んで
      // 早く触る／半歩下がって捕まえる、まで含めた地点が返る。
      const poach = poachSpot(player, ball);
      if (poach) return poach;
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

  /**
   * ネットへ詰めている最中（game.js の cpuNetRush）に、向かってくる球を迎え撃つ位置。
   * 通常の chasePosition() はバウンド後の頂点＝自陣の深いところを追わせるので、せっかく
   * 前に出ても相手が打った瞬間に後ろへ引き返してしまい、ボレーの機会が生まれない。
   * ここでは「ボールがある深さを通過する瞬間、そこに立って打てるか」をネット際
   * (NET_APPROACH_Z)から自分の今いる深さまで順に調べ、間に合ういちばん前の深さで待つ。
   * ネット際まで詰め切れない球でも、届く範囲でできるだけ前へ出て（＝ファーストボレー）
   * 少しずつ前進できる：一番前しか見ないと「間に合わない→ベースラインまで下がる」を
   * 繰り返すだけで、結局一度もネットに立てなかった。
   * 頭を越されるロブ（通過点が高すぎる）やどこでも間に合わない球では null を返し、
   * 呼び出し側は通常の追い方（＝下がって1バウンドさせる）に戻る。
   * @param {1|-1} side 詰めている選手がいる陣地（1＝cpu 陣地 z>0）
   * @returns {{x:number, z:number}|null}
   */
  function netRushPosition(ball, side, player) {
    if (ball.bounces > 0) return null;
    const near = side * CPU.NET_APPROACH_Z;
    for (let i = 0; i <= CPU.NET_RUSH_STEPS; i++) {
      const z = lerp(near, player.z, i / CPU.NET_RUSH_STEPS);
      const at = predictAtZ(ball, z, CPU.NET_RUSH_LEAD_T);
      if (at && at.y < PLAYER.CPU_REACH_Y && at.y > PLAYER.CPU_REACH_Y_MIN) {
        const runT = Math.hypot(at.x - player.x, z - player.z) / PLAYER.CPU_CHASE;
        if (runT <= at.t) return { x: clamp(at.x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT), z };
      }
    }
    return null; // どの深さでも迎え撃てない（頭を越された／間に合わない）＝素直に下がる
  }

  /**
   * ラリーが自分に関係ないときの定位置。
   * @param {boolean} [approachNet] true なら通常の定位置(HOME_Z)の代わりにネット際
   *   (NET_APPROACH_Z) を返す。プレースタイル「サーブ&ボレーヤー」がサーブを打った直後に
   *   使う（game.js#moveSinglesCpu() 参照）。
   */
  function homePosition(approachNet) {
    return { x: 0, z: approachNet ? CPU.NET_APPROACH_Z : CPU.HOME_Z };
  }

  /**
   * 打球の狙い先。相手プレイヤーの逆をつきつつ、一定確率でミスもする。
   * @param {number} opponentX 逆をつく相手（返球を受ける側）の現在位置
   * @param {1|-1} [dir] 打ち込む方向。既定は -1（z<0側＝you陣地。cpu が you を狙う従来の向き）。
   *   you 陣地の選手（youMate）が cpu 陣地（z>0）を狙うときは +1 を渡す。
   * @param {number} [stretch] 0〜1。ぎりぎり追いついて打った度合い（hit() が実速度から算出）。
   *   大きいほど狙いが浅く・中央寄りになり、ミスの確率も上がる（＝弱気な返球）。
   * @param {number} [outMult] 能力値「安定感」によるミス率の倍率（既定1＝中立）。
   * @returns {{x:number, y:number, z:number}} ワールド座標の目標地点
   */
  function shotTarget(opponentX, dir = -1, stretch = 0, outMult = 1) {
    const aimXMin = lerp(CPU.AIM_X_MIN, CPU.STRETCH_AIM_X_MIN, stretch);
    const aimXMax = lerp(CPU.AIM_X_MAX, CPU.STRETCH_AIM_X_MAX, stretch);
    const aimZMin = lerp(CPU.AIM_Z_MIN, CPU.STRETCH_AIM_Z_MIN, stretch);
    const aimZMax = lerp(CPU.AIM_Z_MAX, CPU.STRETCH_AIM_Z_MAX, stretch);
    const outLong = lerp(CPU.OUT_LONG, CPU.STRETCH_OUT_LONG, stretch) * outMult;
    const outWide = lerp(CPU.OUT_WIDE, CPU.STRETCH_OUT_WIDE, stretch) * outMult;

    const x = -signOr(opponentX, Math.random() - 0.5) * rand(aimXMin, aimXMax);
    const z = dir * rand(aimZMin, aimZMax);

    return scatterOut({ x, y: PHYSICS.BALL_R, z }, dir, outLong, outWide);
  }

  /**
   * ai.js の各ショットが受け取る「打つ人の能力」。能力値が既定（すべて3）ならこの中立値と
   * 完全に同じになるので、渡さなくても従来どおりの結果になる（config.shotSkill() が作る）。
   * power＝飛翔時間の倍率（小さいほど速い球）、out＝わざとミスする確率の倍率、
   * sharp＝ボレーで角度をつけにいく度合いの倍率。
   */
  const NEUTRAL_SKILL = { power: 1, out: 1, sharp: 1 };

  /**
   * わざとミスする（ライン際を狙い損なう）ぶんの上乗せ。狙いが決まった後の目標地点を、
   * 確率でコートの外へ動かす。ボレー・スマッシュも同じ形でミスを混ぜたいので関数に切り出す。
   * @param {{x:number, y:number, z:number}} target
   * @param {1|-1} dir 打ち込む方向
   * @param {number} longChance ベースラインを割る確率
   * @param {number} wideChance サイドを割る確率
   * @param {number} [wideX] サイドを割ったときの着地 x（正の値）。既定はシングルスの
   *   サイドライン(HALF_W)の外側。ダブルス幅を狙うショットは DOUBLES.PASS_OUT_X を渡す
   *   （既定のままだとダブルスではコートに収まってしまい「わざと外す」が効かない）。
   */
  function scatterOut(target, dir, longChance, wideChance, wideX = HALF_W + 0.7) {
    const out = target;
    if (Math.random() < longChance) out.z = dir * (HALF_L + 0.9);   // ベースラインオーバー
    if (Math.random() < wideChance) out.x = signOr(out.x, 1) * wideX; // サイドアウト
    return out;
  }

  /**
   * そのボレーがどれだけ「決めにいける」1本か（0〜1）。
   * 打点が高い(VOLLEY_HIGH_Y)ほど、そして走らされていない(stretch が小さい)ほど1に近づき、
   * 能力値「ボレー」で伸びる。狙いの鋭さ・球速・（ダブルスでは）相手を抜く幅に効く。
   */
  function volleySharp(contactY, stretch, skill) {
    const high = clamp(
      (contactY - CPU.VOLLEY_LOW_Y) / (CPU.VOLLEY_HIGH_Y - CPU.VOLLEY_LOW_Y), 0, 1,
    );
    return clamp(high * (1 - clamp(stretch, 0, 1)) * skill.sharp, 0, 1);
  }

  /**
   * CPU/AI のボレー（ノーバウンドで返す1本）。グラウンドストローク（shotTarget）とは別枠で、
   * 「高い打点を余裕をもって捕まえたときだけ鋭く決めにいく」形にしてある：
   * 打点が高い(VOLLEY_HIGH_Y)ほど、そして走らされていない(stretch が小さい)ほど sharp が
   * 1に近づき、サイドライン際へ短く角度をつけた速い球になる。逆に足元へ沈められた球
   * (VOLLEY_LOW_Y 以下)や大きく振られた球は、中央寄りでゆるいブロック返球にしかならない。
   * @param {{x:number, z:number}} opponent 返球を受ける側（逆をつく相手）
   * @param {1|-1} dir 打ち込む方向
   * @param {number} stretch 0〜1。ぎりぎり追いついて打った度合い
   * @param {number} contactY 打点の高さ(m)
   * @param {number} [aimX] 着地の横位置を明示する（ダブルスで「ネット際の相手を横切らない」
   *   ように狙いを決める doublesVolleyShot() が使う）。省略時は従来どおり相手の逆サイド。
   */
  function cpuVolleyShot(opponent, dir, stretch = 0, contactY = 1, skill = NEUTRAL_SKILL, aimX) {
    const sharp = volleySharp(contactY, stretch, skill);
    const x = aimX === undefined
      ? -signOr(opponent.x, Math.random() - 0.5)
        * lerp(CPU.VOLLEY_BLOCK_X, CPU.VOLLEY_ANGLE_X, sharp)
      : aimX;
    const z = dir * lerp(CPU.VOLLEY_BLOCK_Z, CPU.VOLLEY_ANGLE_Z, sharp);
    return {
      target: scatterOut(
        { x, y: PHYSICS.BALL_R, z },
        dir,
        CPU.OUT_LONG * CPU.VOLLEY_OUT_MULT * skill.out,
        CPU.OUT_WIDE * CPU.VOLLEY_OUT_MULT * skill.out,
      ),
      flight: lerp(CPU.VOLLEY_BLOCK_T, CPU.VOLLEY_ANGLE_T, sharp) * skill.power,
      lob: false,
    };
  }

  /**
   * CPU/AI のスマッシュ。相手の逆をついて深く、飛翔時間 SMASH_T（＝グラウンドストロークの
   * 1/3 近い速さ）で突き刺す決め球。追い込まれて打つ（stretch が大きい）ときだけ
   * SMASH_STRETCH_T まで威力が落ちる。
   * @param {number} [aimX] 着地の横位置を明示する（ダブルスでネット際の相手を横切らない
   *   ように狙う doublesSmashShot() が使う）。省略時は従来どおり相手の逆サイド。
   */
  function cpuSmashShot(opponent, dir, stretch = 0, skill = NEUTRAL_SKILL, aimX) {
    const x = aimX === undefined
      ? -signOr(opponent.x, Math.random() - 0.5) * rand(CPU.SMASH_AIM_X_MIN, CPU.SMASH_AIM_X_MAX)
      : aimX;
    const z = dir * rand(CPU.SMASH_AIM_Z_MIN, CPU.SMASH_AIM_Z_MAX);
    return {
      target: scatterOut(
        { x, y: PHYSICS.BALL_R, z },
        dir,
        CPU.OUT_LONG * CPU.SMASH_OUT_MULT * skill.out,
        CPU.OUT_WIDE * CPU.SMASH_OUT_MULT * skill.out,
      ),
      flight: lerp(CPU.SMASH_T, CPU.SMASH_STRETCH_T, clamp(stretch, 0, 1)) * skill.power,
      lob: false,
    };
  }

  /** ロブ（山なりの返球）の狙い。頭を越す攻めのロブにも、時間を稼ぐ逃げのロブにも使う共通の弾道。 */
  function lobShot(opponent, dir) {
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

  /** 足元へ沈める短い球。相手の現在位置（＝ネットに詰めている場所）を中心に、ネットぎりぎりの浅さで狙う。 */
  function netDropShot(opponent, dir) {
    return {
      target: {
        x: clamp(opponent.x + rand(-CPU.NET_DROP_X, CPU.NET_DROP_X), -HALF_W + 0.4, HALF_W - 0.4),
        y: PHYSICS.BALL_R,
        z: dir * rand(CPU.NET_DROP_Z_MIN, CPU.NET_DROP_Z_MAX),
      },
      flight: CPU.NET_DROP_T,
      lob: false,
    };
  }

  /** サイドライン際へ低く速いパッシング。相手が寄っている側と逆（＝空いている側）を狙う。 */
  function netPassShot(opponent, dir) {
    return {
      target: {
        x: -signOr(opponent.x, Math.random() - 0.5) * rand(CPU.NET_PASS_X_MIN, CPU.NET_PASS_X_MAX),
        y: PHYSICS.BALL_R,
        z: dir * rand(CPU.NET_PASS_Z_MIN, CPU.NET_PASS_Z_MAX),
      },
      flight: CPU.NET_PASS_T,
      lob: false,
    };
  }

  /**
   * 相手がネットに詰めている（CPU.NET_Z 以内）ときの配球。ロブ一辺倒だと単調なので、
   * 「足元へ沈める短い球」「サイドライン際へ低く速いパッシング」「ロブ」の3択を状況で撃ち分ける。
   * 相手が完全に詰め切っている（CPU.NET_PRESS_Z 以内）ときだけロブの比率を上げる
   * （意表をつく1本）。それ以外はネットの近さ（closeness）で「足元」、相手の中央寄り
   * 具合（centered）で「パッシング」の重みを連続的に変える。
   */
  function netPlayShot(opponent, dir, lobScale, skill = NEUTRAL_SKILL) {
    const pressed = Math.abs(opponent.z) <= CPU.NET_PRESS_Z;
    if (Math.random() < (pressed ? CPU.NET_LOB_PRESSED : CPU.NET_LOB) * lobScale) {
      return lobShot(opponent, dir);
    }
    const closeness = clamp(
      (CPU.NET_Z - Math.abs(opponent.z)) / (CPU.NET_Z - CPU.NET_PRESS_Z), 0, 1,
    );
    const centered = 1 - clamp(Math.abs(opponent.x) / CPU.NET_PASS_X_REF, 0, 1);
    const dropWeight = lerp(CPU.NET_DROP_MIN, CPU.NET_DROP_MAX, closeness);
    const passWeight = lerp(CPU.NET_PASS_MIN, CPU.NET_PASS_MAX, centered);
    const dropChance = dropWeight / (dropWeight + passWeight);
    const shot = Math.random() < dropChance ? netDropShot(opponent, dir) : netPassShot(opponent, dir);
    shot.flight *= skill.power; // 沈める球もパッシングも「打つ人の上手さ」で速さが変わる
    return shot;
  }

  /**
   * CPU/AI の返球1本ぶんの狙い（着地点と飛翔時間）。通常は shotTarget() の低い弾道だが、
   * 相手がネットに詰めている（CPU.NET_Z 以内）ときは netPlayShot() の3択に切り替わる。
   * ベースライン同士のラリーでは、一定確率でロブ（山なりの返球）を選ぶ：
   * 自分がぎりぎりで追いついた（stretch が大きい）＝時間を稼ぐ逃げのロブ。
   * ロブが無いと PLAYER.SMASH_MIN_Y を満たす高い球が来ず、人間がスマッシュを打つ機会が
   * シングルスでほぼ発生しなかった。
   * @param {{x:number, z:number}} opponent 返球を受ける側（逆をつく相手）
   * @param {1|-1} dir 打ち込む方向（shotTarget と同じ）
   * @param {number} stretch 0〜1。ぎりぎり追いついて打った度合い
   * @param {number} [lobScale] ロブを選ぶ確率全体（LOB_BASE・LOB_VS_STRETCH・NET_LOB・
   *   NET_LOB_PRESSED）に掛ける倍率。既定1（シングルス）。ダブルスはラリーが長引きやすく、
   *   同じ確率でも1ポイント中の絶対数が増えて目立つため、game.js が DOUBLES.LOB_SCALE を
   *   渡して抑える（config.js のコメント参照）。
   * @param {number} [arcScale] stretch が飛翔時間を STRETCH_T（山なり）へ引っ張る度合いに
   *   掛ける倍率。既定1。lob=false でも stretch が高いと弾道自体は山なりに近づく
   *   （「ロブではないのに山なりで打ち損なって見える」の原因）ので、lobScale とは別に
   *   game.js が DOUBLES.ARC_SCALE を渡して抑える。
   * @param {number} [attack] チャンスボールを叩きにいく度合い(0〜1。game.js#chanceAttack)。
   *   その分だけ飛翔時間を CPU.CHANCE_T（速い球）へ寄せ、ロブに逃げなくなる。既定0。
   * @returns {{target:{x:number,y:number,z:number}, flight:number, lob:boolean}}
   */
  function cpuShot(opponent, dir, stretch, lobScale = 1, arcScale = 1, skill = NEUTRAL_SKILL, attack = 0) {
    // 相手が自陣のどのあたりにいるかはネットからの距離で見る（dir の符号に依存させない）
    if (Math.abs(opponent.z) <= CPU.NET_Z) return netPlayShot(opponent, dir, lobScale, skill);
    // ロブは威力ではなくタッチの球なので、能力値による速さの倍率は掛けない（掛けると
    // 「上手い人のロブほど山なりでなくなる」というおかしな効き方になる）。
    if (Math.random() < (CPU.LOB_BASE + CPU.LOB_VS_STRETCH * stretch) * lobScale * (1 - attack)) {
      return lobShot(opponent, dir);
    }
    return {
      target: shotTarget(opponent.x, dir, stretch, skill.out),
      flight: rallyFlight(stretch * arcScale, attack) * skill.power,
      lob: false,
    };
  }

  /**
   * つなぎのグラウンドストロークの飛翔時間（能力の倍率を掛ける前）。走らされた度合い
   * （tight）で山なり（STRETCH_T）へ、チャンスボールを叩く度合い（attack）で速い球
   * （CHANCE_T）へ寄せる。
   */
  function rallyFlight(tight, attack) {
    return lerp(lerp(CPU.SHOT_T, CPU.STRETCH_T, tight), CPU.CHANCE_T, attack);
  }

  /* ---------------------------------------------- ダブルス（雁行陣） */

  /**
   * ネット際にいる選手が、まだ着地していないボールを待たずに横取り（ポーチ）できる地点。
   * isResponder() を着地点までの距離だけで決めると、前衛の目の前を素通りする球でも
   * 着地点は後衛側（深い場所）になるため常に後衛任せになり、前衛が全くボレーしない
   * （＝スルーする）事態になっていた。ここでは「まだバウンドしていない球が、ネット際の
   * ある深さ（z）を通過する瞬間、自分の届く範囲・高さにあるか」を直接シミュレートする。
   *
   * 以前は「自分がいまいる深さ z ちょうど」の1点しか調べていなかったため、半歩前・半歩
   * 後ろを通るだけの球は触れない扱いになり、目の前を素通りさせていた（ユーザー報告
   * 「近くに来たボールを見逃す」）。DOUBLES.POACH_Z_BAND の帯を刻んで調べ、間に合う
   * いちばんネット寄りの地点を返す（早く触るほど相手に時間を与えない＝ポーチの狙い）。
   * 距離も x だけでなく z の踏み込みぶんを含めた実距離で見る。
   * @returns {{x:number, z:number}|null}
   */
  function poachSpot(player, ball) {
    if (ball.bounces > 0 || Math.abs(player.z) > PLAYER.VOLLEY_Z) return null;
    const side = signOr(player.z, 1); // 自陣がどちら側か（1＝cpu 陣地 z>0）
    const reachMult = attrOf(player).reach * DOUBLES.POACH_REACH_MULT;
    for (let i = 0; i <= DOUBLES.POACH_Z_STEPS; i++) {
      // i=0 がいちばんネット寄り。side を掛けることで you 陣地（z<0）でも同じ向きになる。
      const z = player.z
        + side * lerp(-DOUBLES.POACH_Z_BAND, DOUBLES.POACH_Z_BAND, i / DOUBLES.POACH_Z_STEPS);
      if (z * side < DOUBLES.POACH_MIN_Z || Math.abs(z) > PLAYER.VOLLEY_Z) continue;
      const at = predictAtZ(ball, z);
      if (!at || at.y >= PLAYER.CPU_REACH_Y || at.y <= PLAYER.CPU_REACH_Y_MIN) continue;
      // 通過するのは at.t 秒後なので、そのときの反応時間は「今までの経過＋これから」。
      // 今の age だけで判断すると、まだ余裕があるのに反射扱いになって前衛が出て行かない。
      // ただし、この時間は CPU_POACH_T_MAX で頭打ちにする（config.js のコメント参照）：
      // 後衛への深い展開球でもネット際を通過するまでには相応の時間がかかり、そのぶんを
      // そのまま反応時間として渡すと reactReach() がほぼ CPU_REACH まで開いてしまい、
      // 「ポーチ」のはずが全力疾走の間合いで判定されてしまう。
      const poachT = Math.min((ball.age || 0) + at.t, PLAYER.CPU_POACH_T_MAX);
      if (Math.hypot(at.x - player.x, z - player.z) <= reactReach(poachT, reachMult)) {
        return { x: clamp(at.x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT), z };
      }
    }
    return null;
  }

  /**
   * 「出る」と決めた前衛が、全力で走って迎え撃てる地点。
   * poachSpot() が「立っていれば触れる球」だけを見るのに対し、こちらは走る時間を
   * 織り込んで探すので、クロス展開でストレートを守っている位置からでも中央へ
   * 出ていける（＝仕掛けるポーチ）。出るかどうかの判断そのものは game.js が
   * 球ごとに1回だけ決める（DOUBLES.POACH_CHANCE）。
   * ネット際(POACH_MIN_Z)からボレーできる限界(PLAYER.VOLLEY_Z)までを刻み、間に合う
   * いちばんネット寄りの地点を返す。どこにも間に合わなければ null＝仕掛けない。
   * @param {1|-1} side 前衛がいる陣地（1＝cpu 陣地 z>0）
   * @returns {{x:number, z:number}|null}
   */
  function poachRun(ball, player, side) {
    if (ball.bounces > 0) return null;
    for (let i = 0; i <= DOUBLES.POACH_RUN_STEPS; i++) {
      const z = side * lerp(DOUBLES.POACH_MIN_Z, PLAYER.VOLLEY_Z, i / DOUBLES.POACH_RUN_STEPS);
      const at = predictAtZ(ball, z);
      if (!at || at.y >= PLAYER.CPU_REACH_Y || at.y <= PLAYER.CPU_REACH_Y_MIN) continue;
      const runT = Math.hypot(at.x - player.x, z - player.z)
        / (PLAYER.CPU_CHASE * attrOf(player).speed);
      if (runT <= at.t * DOUBLES.POACH_RUN_MARGIN) {
        return { x: clamp(at.x, -CPU.CHASE_X_LIMIT, CPU.CHASE_X_LIMIT), z };
      }
    }
    return null;
  }

  /**
   * ダブルスのペアのうち、どちらが返球を担当するか（役割を持たない素朴な版）。
   * ネット際にいる方がポーチできるならそちらを優先し、そうでなければ落下点までの距離が
   * 近い方が応答し、もう一方は構えに回る。雁行陣（前衛・後衛の役割が決まっている形）では
   * pairResponder() を使う。こちらは役割が無いとき——パートナーに「下がれ」を指示して
   * 2人とも後衛になっているとき——に使う。
   * @returns {boolean} me（1人目）が担当するなら true
   */
  function isResponder(me, mate, ball) {
    const meCanPoach = !!poachSpot(me, ball);
    const mateCanPoach = !!poachSpot(mate, ball);
    if (meCanPoach !== mateCanPoach) return meCanPoach;

    const landing = chaseTarget(ball);
    const dMe = Math.hypot(me.x - landing.x, me.z - landing.z);
    const dMate = Math.hypot(mate.x - landing.x, mate.z - landing.z);
    return dMe <= dMate;
  }

  /**
   * 雁行陣のペアのうち、どちらが今の球を取りにいくか。
   * 前衛がポーチできるならポーチ（＝攻め）が最優先。そうでなければ「落下点がどちらの
   * 持ち場か」で決める：ネット寄り（DOUBLES.FRONT_ZONE_Z 以内）なら前衛、深い
   * （BACK_ZONE_Z 以遠）なら後衛。その持ち場ぶんの優先度を距離差のハンデ(bias)として渡す。
   *
   * 単純に「落下点に近い方」（isResponder）だと、中途半端な深さの球のたびに前衛が下がって
   * 雁行が崩れ、次の球でネット際ががら空きになっていた（＝役割が固定されず、ソフトテニスの
   * ダブルスに見えない）。逆に短い球は前衛の持ち場なので、後衛をわざわざ走らせない。
   * @param {{x:number, z:number}} back 後衛
   * @param {{x:number, z:number}} front 前衛
   * @returns {'front'|'back'}
   */
  function pairResponder(back, front, ball) {
    if (poachSpot(front, ball)) return 'front';
    const landing = chaseTarget(ball);
    const deep = clamp(
      (Math.abs(landing.z) - DOUBLES.FRONT_ZONE_Z) / (DOUBLES.BACK_ZONE_Z - DOUBLES.FRONT_ZONE_Z),
      0, 1,
    );
    const bias = lerp(-DOUBLES.FRONT_PRIORITY, DOUBLES.BACK_PRIORITY, deep);
    const dBack = Math.hypot(back.x - landing.x, back.z - landing.z);
    const dFront = Math.hypot(front.x - landing.x, front.z - landing.z);
    return dBack <= dFront + bias ? 'back' : 'front';
  }

  /**
   * 応答しない方が構える位置。相方の反対サイドへ寄って、ネット際で待つ。
   * 役割が無いとき（「下がれ」を指示されたパートナー）とサーブ時の立ち位置に使う。
   * 雁行陣の前衛は frontPosition()、その間の後衛は backPosition() を使う。
   * @param {number} responderX 応答している側の現在位置
   * @param {number} netZ 自陣のネット際の深さ（DOUBLES.NET_Z_YOU / NET_Z_CPU）
   */
  function coverPosition(responderX, netZ) {
    const x = clamp(-responderX * DOUBLES.MIRROR, -DOUBLES.SLOT_X, DOUBLES.SLOT_X);
    return { x, z: netZ };
  }

  /**
   * 雁行陣の前衛が構える位置。ソフトテニスの前衛と同じ考え方で、「相手後衛（次に打つ人）」と
   * 「味方後衛」がコートの同じ側にいるか・対角にいるかで立ち位置を連続的に変える。
   * コートの x は両陣で共通なので、「同じ符号＝ストレート展開／逆符号＝クロス展開」で判る。
   *
   * - クロス展開（対角）：相手後衛のストレートは味方後衛のいない側へ来るので、前衛が
   *   その線を塞ぐ＝相手後衛と同じサイドへ DOUBLES.FRONT_GUARD_X まで寄って守る。
   * - ストレート展開（同じ側）：ストレートは味方後衛が見られるので、前衛は真ん中を越えて
   *   ラリー側へ踏み込み（FRONT_LEAN_X）、深さもネット寄りへ詰める（FRONT_ATTACK_Z_MULT）。
   *   ＝いつでもポーチに出られる攻めの姿勢。
   *
   * 相手後衛が中央にいるときは寄り幅も0＝前衛も中央に構える（どちらへも出られる）。
   * @param {{x:number}} foeBack 相手の後衛（次にこちらへ打ってくる側）
   * @param {{x:number}} mateBack 味方の後衛
   * @param {number} netZ 自陣のネット際の深さ（符号つき。DOUBLES.NET_Z_YOU / NET_Z_CPU）
   */
  function frontPosition(foeBack, mateBack, netZ) {
    const foe = clamp(foeBack.x / DOUBLES.FRONT_SIDE_REF, -1, 1);
    const mate = clamp(mateBack.x / DOUBLES.FRONT_SIDE_REF, -1, 1);
    // 展開がどれだけはっきりしているか（どちらかが中央に近いほど0＝まだ決めつけない）。
    const conf = Math.min(Math.abs(foe), Math.abs(mate));
    // 1＝ストレート展開（2人が同じ側）／0＝クロス展開（対角）。間は連続。
    const straight = clamp(
      0.5 + Math.sign(foe * mate) * conf * DOUBLES.FRONT_ALIGN_GAIN, 0, 1,
    );
    // クロス展開で塞ぐストレートの線は相手後衛の真正面なので、寄り幅も相手の寄り具合に比例。
    const guard = foe * DOUBLES.FRONT_GUARD_X;
    // ストレート展開ではラリーの側がはっきりしているので、真ん中を越えてその側へ踏み込む。
    const lean = signOr(foe, mateBack.x || 1) * DOUBLES.FRONT_LEAN_X * conf;
    return {
      x: clamp(lerp(guard, lean, straight), -DOUBLES.SLOT_X, DOUBLES.SLOT_X),
      z: netZ * lerp(1, DOUBLES.FRONT_ATTACK_Z_MULT, straight),
    };
  }

  /**
   * 前衛がポーチに出ている間、後衛が構える位置。前衛が寄った側と逆へ開けて、
   * ベースライン付近（DOUBLES.BACK_HOME_Z）で待つ。
   * 以前はここでも coverPosition() を使っていたため、前衛がポーチに出ると後衛まで
   * ネット際へ上がってしまい、前衛が触れなかったときに自陣ががら空きになっていた。
   * @param {number} frontX ポーチに出ている前衛の現在位置
   * @param {1|-1} side 自陣（1＝cpu 陣地 z>0）
   */
  function backPosition(frontX, side) {
    return {
      x: clamp(-frontX * DOUBLES.MIRROR, -DOUBLES.SLOT_X, DOUBLES.SLOT_X),
      z: side * DOUBLES.BACK_HOME_Z,
    };
  }

  /**
   * ダブルスで、相手がネット際にいるときのボレー。
   *
   * 通常の cpuVolleyShot() は「相手の逆サイド」を狙う。相手がベースラインにいるならそれで
   * 正しいが、相手もネット際にいる場面では、逆サイドへ打つ球はその相手の**目の前を横切る**
   * ことになる——自分も相手もネットのすぐ両側にいるので、球が横へ開くより先に相手の深さを
   * 通過してしまう（実測：打った瞬間、相手から平均0.62mしか外れておらず、反応時間0.17秒の
   * 至近距離でボレーを打ち返されていた＝「前衛同士のボレー合戦」の正体）。
   *
   * そこで、横切らせずに「相手の外側（＝球がいまいる側）」へ抜く。抜ける隙間が無い
   * （相手が外を締めている）ときだけ、頭を越すロブボレーに切り替える。どちらも現実の
   * ダブルスでネット際の相手に対して実際に使う答えで、正面へ打ち込む選択肢が消える。
   * @param {{x:number, z:number}} netFoe ネット際にいる相手
   * @param {{x:number, z:number}} backFoe もう一人の相手（ロブボレーの逆をつく相手）
   * @param {number} fromX 打つ本人の横位置
   */
  function netClearX(netFoe, fromX, spread) {
    // 球がいま相手のどちら側にあるか＝横切らずに抜ける側。
    // 真正面（前衛同士が同じ横位置で向かい合う＝雁行のラリー側に2人とも寄っているとき、
    // 実測で頻発する）のときは、相手の外側＝サイドライン側へ逃がす。中央側へ逃がすと
    // 相手のいる x をそのまま通過することになり、いちばん避けたい形になる。
    const side = signOr(fromX - netFoe.x, signOr(netFoe.x, 1));
    const limit = DOUBLES.NET_CLEAR_LIMIT;
    const near = netFoe.x + side * DOUBLES.NET_CLEAR_MIN;
    if (Math.abs(near) > limit) return null; // 最低限の隙間すらサイドラインの外＝抜けない
    return rand(near, clamp(netFoe.x + side * spread, -limit, limit));
  }

  function doublesVolleyShot(netFoe, backFoe, fromX, dir, stretch, contactY, skill = NEUTRAL_SKILL) {
    // どれだけ外まで運べるかは、通常のボレーの鋭さと同じ尺度で決める：高い打点を余裕を
    // もって捕まえた1本だけが大きく外へ切れ、足元へ沈められた苦しいブロックは相手の
    // すぐ外を通すのが精一杯（＝苦しい球まで完璧に置けてしまうのを防ぐ）。
    const sharp = volleySharp(contactY, stretch, skill);
    const spread = lerp(
      DOUBLES.NET_CLEAR_MIN + DOUBLES.NET_CLEAR_SPREAD, DOUBLES.NET_CLEAR_MAX, sharp,
    );
    const aimX = netClearX(netFoe, fromX, spread);
    // 横に抜けないなら頭を越すしかない（ロブボレー）。現実のダブルスでも、ネット際の
    // 相手にサイドを締められたときの答えはこれ。
    if (aimX === null) return lobShot(backFoe, dir);
    return cpuVolleyShot(netFoe, dir, stretch, contactY, skill, aimX);
  }

  /**
   * ネット際から打つスマッシュ（ダンクスマッシュ等）の、ネット際の相手を避けた狙い。
   * ボレーとまったく同じ理由：相手の真ん前を至近距離で通す球は、現実には返らないのに
   * ゲーム上は反射でボレーし返されてしまう（実測：ネット際の即打ち返しのうち7割が
   * スマッシュ由来だった）。抜ける隙間が無いときだけ従来どおり後衛の逆をつく
   * （スマッシュを打った後にロブへ切り替えるのは形として不自然なので分岐させない）。
   * @param {number} fromX 打つ本人の横位置
   */
  function doublesSmashShot(netFoe, backFoe, fromX, dir, stretch, skill = NEUTRAL_SKILL) {
    const aimX = netClearX(netFoe, fromX, DOUBLES.NET_CLEAR_MAX);
    if (aimX === null) return cpuSmashShot(backFoe, dir, stretch, skill);
    return cpuSmashShot(netFoe, dir, stretch, skill, aimX);
  }

  /**
   * 雁行陣の後衛が打つ1本。ソフトテニスのダブルスと同じ考え方で、
   * 「基本は相手前衛を避けてクロスへ深く運び、前衛が中央へ寄って隙ができたときだけ、
   * 自分に余裕があればストレートをパッシングで抜く」。
   *
   * クロスへ運ぶのは shotTarget() に**前衛の x**を渡すだけで足りる（shotTarget は
   * 渡された相手の逆サイドへ深く狙う）。従来は常に相手チームの主力（人間の you ／
   * cpu）の x を渡していたので、相手前衛がどこに立っていようと配球が変わらず、
   * ネット際の前衛へ自分から打ち込んでしまうことがあった。
   * @param {{x:number, z:number}} front 相手の前衛
   * @param {{x:number, z:number}} back 相手の後衛
   * @param {1|-1} dir 打ち込む方向
   * @param {number} stretch 0〜1。ぎりぎり追いついて打った度合い
   * @param {number} [attack] チャンスボールを叩きにいく度合い(0〜1)。cpuShot() と同じ
   */
  function doublesRallyShot(front, back, dir, stretch, lobScale = 1, arcScale = 1, skill = NEUTRAL_SKILL, attack = 0) {
    const tight = clamp(stretch, 0, 1);
    // 前衛がストレートの線からどれだけ離れたか（0＝サイドを締めている／1＝中央まで寄った）。
    const gap = clamp(1 - Math.abs(front.x) / DOUBLES.PASS_GAP_X, 0, 1);
    // 隙があって、かつ自分に余裕があるときだけ抜きにいく。
    if (Math.random() < (DOUBLES.PASS_BASE + DOUBLES.PASS_GAP * gap) * (1 - tight)) {
      // 抜く先は前衛が空けたストレート側。前衛がちょうど中央のときだけ、相手後衛から
      // 遠い方（＝どちらも埋まっていない側）へ逃がす。
      const passSide = signOr(front.x, -signOr(back.x, 1));
      const out = CPU.OUT_LONG * DOUBLES.PASS_OUT_MULT * skill.out;
      const wide = CPU.OUT_WIDE * DOUBLES.PASS_OUT_MULT * skill.out;
      return {
        target: scatterOut({
          x: passSide * rand(DOUBLES.PASS_X_MIN, DOUBLES.PASS_X_MAX),
          y: PHYSICS.BALL_R,
          z: dir * rand(DOUBLES.PASS_Z_MIN, DOUBLES.PASS_Z_MAX),
        }, dir, out, wide, DOUBLES.PASS_OUT_X),
        flight: DOUBLES.PASS_T * skill.power,
        lob: false,
      };
    }
    // 前衛の頭を越すロブ／苦しいときの逃げのロブ。シングルスと同じ枠のまま
    // （ダブルスで多すぎないよう game.js が lobScale を渡して抑える）。
    // チャンスボール（attack）はロブに逃げずに叩く（cpuShot() と同じ）。
    if (Math.random() < (CPU.LOB_BASE + CPU.LOB_VS_STRETCH * tight) * lobScale * (1 - attack)) {
      return lobShot(back, dir);
    }
    // 基本形：前衛を避けてクロスへ深く。
    return {
      target: shotTarget(front.x, dir, tight, skill.out),
      flight: rallyFlight(tight * arcScale, attack) * skill.power,
      lob: false,
    };
  }

  /**
   * CPU/AI のスピン選択（サーブ・グラウンドストローク共通。ボレー・スマッシュは呼び出し側
   * ＝game.js が対象外にする）。以前は常にフラット固定で単調だったというユーザー報告を受け、
   * CPU.SPIN_FLAT_CHANCE の確率でフラットのまま、それ以外は CPU.SPIN_TOP_SHARE の割合で
   * トップスピン／スライスを混ぜる。
   * @param {boolean} [second] セカンドサーブ。実際のテニスと同じく、ほとんど回転をかけて
   *   （しかも多くはトップスピン＝キック）確実に入れにいく比率へ差し替える。
   * @returns {'flat'|'top'|'slice'}
   */
  function aiSpin(second) {
    const flatChance = second ? SERVE.SECOND_FLAT_CHANCE : CPU.SPIN_FLAT_CHANCE;
    const topShare = second ? SERVE.SECOND_TOP_SHARE : CPU.SPIN_TOP_SHARE;
    if (Math.random() < flatChance) return 'flat';
    return Math.random() < topShare ? 'top' : 'slice';
  }

  RallyOne.ai = {
    chasePosition, homePosition, netRushPosition, shotTarget, cpuShot, cpuVolleyShot,
    cpuSmashShot, smashApproach, isResponder, coverPosition, reactReach, aiSpin,
    poachSpot, poachRun, pairResponder, frontPosition, backPosition,
    doublesRallyShot, doublesVolleyShot, doublesSmashShot,
  };
})(window.RallyOne = window.RallyOne || {});
