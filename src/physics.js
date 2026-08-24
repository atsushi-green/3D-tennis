/**
 * 純粋シミュレーション層。描画にも DOM にも依存しないので単体テストできる。
 * ボールは {x, y, z, px, py, pz, vx, vy, vz} という素の物体として扱う。
 */
(function (RallyOne) {
  'use strict';

  const { COURT, PHYSICS, SPIN } = RallyOne.config;
  const { lerp } = RallyOne.math;
  const { GRAVITY, BALL_R } = PHYSICS;

  /**
   * スピンによる実効重力（トップスピン＝速く沈む／スライス＝滑るように伸びる）。
   * `b.spin` が未設定（トス中など）なら通常の GRAVITY と完全に同じ（倍率1）。
   */
  function spinGravity(spin) {
    const mult = SPIN.GRAVITY_MULT[spin];
    return GRAVITY * (mult === undefined ? 1 : mult);
  }

  /** ネットは中央がたわみ、ポストに向かって高くなる */
  function netHeightAt(x) {
    const t = Math.min(Math.abs(x) / COURT.NET_HALF, 1);
    return COURT.NET_C + (COURT.NET_P - COURT.NET_C) * t * t;
  }

  /**
   * 1ステップ進める。p* に進める前の位置を残す（ネット通過判定に使う）。
   * `b.wind`（横方向の弱い加速度、未設定なら0）が設定されていれば vx にも足す。
   * 打った側は狙いに織り込まない（＝解いた通りの初速で飛ばした後、風にさらされて
   * 実際の着地点だけがずれる）ので、ここでの加算だけで完結し `solveShot()` 側は変更不要。
   */
  function integrate(b, dt) {
    b.px = b.x;
    b.py = b.y;
    b.pz = b.z;
    b.vy += spinGravity(b.spin) * dt;
    b.vx += (b.wind || 0) * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
  }

  /** z = 0（ネット面）をまたいだか */
  function crossedNet(b) {
    return b.pz * b.z < 0;
  }

  /**
   * ネット面を通過した瞬間の位置。ステップ後の位置で判定すると
   * 速い球ほどネットを通り越した点を見てしまうので、線形補間で戻す。
   */
  function netCrossing(b) {
    const span = b.z - b.pz;
    const t = span === 0 ? 1 : -b.pz / span;
    return { x: lerp(b.px, b.x, t), y: lerp(b.py, b.y, t) };
  }

  /** このステップでネットに引っかかったか */
  function hitsNet(b) {
    if (!crossedNet(b)) return false;
    const at = netCrossing(b);
    return at.y < netHeightAt(at.x) + BALL_R;
  }

  /**
   * このステップで地面（y = BALL_R）を横切った瞬間の位置。netCrossing() と同じ考え方。
   * ステップ後の位置をそのまま着地点として使うと、速い球ほど進行方向へ行き過ぎた点に
   * なり、しかもずれは必ずコートの外向きに出る（＝入っているように見えるのにアウト判定）。
   * 直前位置が地面より上にない（＝このステップで横切っていない、あるいは px/py/pz が
   * 用意されていない）ときは補間できないので、今の位置をそのまま返す。
   */
  function groundCrossing(b) {
    if (!(b.py > BALL_R)) return { x: b.x, z: b.z };
    const span = b.y - b.py;
    const t = span === 0 ? 1 : (BALL_R - b.py) / span;
    return { x: lerp(b.px, b.x, t), z: lerp(b.pz, b.z, t) };
  }

  /**
   * バウンドの反射を1回分、その場で適用する（b を直接書き換える）。反発係数・摩擦は
   * スピン別倍率込み。game.js の bounce() と predictBounceApex() の両方から使う
   * （物理の実装を1箇所にまとめ、両者がずれないようにするため）。
   * 反射の前に、接地点そのものを groundCrossing() で補正する：IN/OUT 判定も軌跡も
   * ここで確定した x/z を読むので、行き過ぎた座標のままだと判定が外側へ偏る。
   */
  function reflectBounce(b) {
    const restMult = SPIN.BOUNCE_RESTITUTION_MULT[b.spin] || 1;
    const friMult = SPIN.BOUNCE_FRICTION_MULT[b.spin] || 1;
    const at = groundCrossing(b);
    b.x = at.x;
    b.z = at.z;
    b.y = BALL_R;
    b.vy = -b.vy * PHYSICS.RESTITUTION * restMult;
    b.vx *= PHYSICS.FRICTION * friMult;
    b.vz *= PHYSICS.FRICTION * friMult;
  }

  /**
   * 落下地点の予測。CPU の追跡と着地マーカーが使う。
   * @returns {{x:number, z:number, t:number, net:boolean}} net=true ならネットまで届かない
   */
  function predictLanding(b, maxT) {
    const limit = maxT === undefined ? 5 : maxT;
    const s = {
      x: b.x, y: b.y, z: b.z,
      px: b.x, py: b.y, pz: b.z,
      vx: b.vx, vy: b.vy, vz: b.vz,
      spin: b.spin, // スピンで実効重力が変わるので、予測にも同じ重力を使わないと着地点がずれる
      wind: b.wind, // 風で流されるぶんも予測に織り込まないと、CPUの追跡・着地マーカーが実際とずれる
    };
    const dt = 1 / 120;
    for (let t = 0; t < limit; t += dt) {
      integrate(s, dt);
      if (hitsNet(s)) return { x: s.x, z: s.z, t, net: true };
      if (s.y <= BALL_R && s.vy < 0) return { x: s.x, z: s.z, t, net: false };
    }
    return { x: s.x, z: s.z, t: limit, net: false };
  }

  /**
   * 現在の滞空区間の頂点（vy が正から負に転じる瞬間＝一番高く上がった位置）の予測。
   * バウンド直後の球を追うのに使う：predictLanding() は「次に地面に着く瞬間」＝
   * まだ1回もバウンドしていなければ狙い通り最初の着地点になるが、既にバウンドした
   * 球に使うと「次（＝2バウンド目）の着地点」という、実際に打つ場所よりずっと先の
   * 点になってしまう。頂点は現在の弾道だけから決まる固定の点（風がなければ）なので、
   * predictLanding(ball, 短い秒数) のように「今から何秒後か」で先読みする方式と違い、
   * ボールが近づくにつれて追跡目標がずるずる先へ動き続ける（＝CPUがいつまでも
   * 全力疾走のままになる）ことがない。
   * 頂点に達する前に着地／ネットしてしまう場合はそちらを返す。
   * @returns {{x:number, z:number, t:number, net:boolean}}
   */
  function predictApex(b, maxT) {
    const limit = maxT === undefined ? 5 : maxT;
    const s = {
      x: b.x, y: b.y, z: b.z,
      px: b.x, py: b.y, pz: b.z,
      vx: b.vx, vy: b.vy, vz: b.vz,
      spin: b.spin,
      wind: b.wind,
    };
    const dt = 1 / 120;
    for (let t = 0; t < limit; t += dt) {
      const vyBefore = s.vy;
      integrate(s, dt);
      if (hitsNet(s)) return { x: s.x, z: s.z, t, net: true };
      if (s.y <= BALL_R && s.vy < 0) return { x: s.x, z: s.z, t, net: false };
      if (vyBefore > 0 && s.vy <= 0) return { x: s.x, z: s.z, t, net: false };
    }
    return { x: s.x, z: s.z, t: limit, net: false };
  }

  /**
   * まだ1回もバウンドしていない球について、「1回バウンドした後、打ちやすい高さまで
   * 上がってきた頂点」を先読みする。CPU がまだ空中の球を追うとき、単純に着地点の
   * 少し後ろで待つ（predictLanding + 一定のオフセット）だけだと、着地点そのものが
   * ネットに近い（サービスボックス等）のに対して自分の定位置がベースライン付近と
   * 大きく離れているケースで、実際の打点（バウンド後さらに奥まで戻ってくる位置）と
   * 大きくずれてしまう。バウンドの反射までシミュレートして頂点を予測することで、
   * バウンド前から「実際どこで打つことになるか」を見越して動けるようにする。
   * @returns {{x:number, z:number, t:number, net:boolean}}
   */
  function predictBounceApex(b, maxT) {
    const limit = maxT === undefined ? 5 : maxT;
    const s = {
      x: b.x, y: b.y, z: b.z,
      px: b.x, py: b.y, pz: b.z,
      vx: b.vx, vy: b.vy, vz: b.vz,
      spin: b.spin,
      wind: b.wind,
    };
    const dt = 1 / 120;
    let bounced = false;
    for (let t = 0; t < limit; t += dt) {
      const vyBefore = s.vy;
      integrate(s, dt);
      if (hitsNet(s)) return { x: s.x, z: s.z, t, net: true };
      if (!bounced) {
        if (s.y <= BALL_R && s.vy < 0) {
          reflectBounce(s);
          bounced = true;
        }
        continue;
      }
      if (s.y <= BALL_R && s.vy < 0) return { x: s.x, z: s.z, t, net: false }; // 頂点前に2バウンド目
      if (vyBefore > 0 && s.vy <= 0) return { x: s.x, z: s.z, t, net: false }; // 頂点
    }
    return { x: s.x, z: s.z, t: limit, net: false };
  }

  /**
   * これから通る軌道のうち、条件を満たす「ひとつながりの区間」を最初のひとつだけ探す。
   * predict*() 群と同じ前向きシミュレーションだが、何を探すかは呼び出し側の述語に任せる
   * （スマッシュの先回り地点＝「打てる高さの帯を通り、かつ人間が立てる場所」のように、
   * 物理だけでは決まらない条件を game.js 側に書けるようにするため）。
   * バウンドも maxBounces 回まで跨いで追う（高く弾んだ球をスマッシュする場合があるため）。
   * @param {object} b ボール（{x,y,z,vx,vy,vz,spin,wind}）
   * @param {(sample:{x:number,y:number,z:number,t:number,bounces:number}) => boolean} accept
   * @param {number} [maxT] 何秒先まで探すか（既定3秒）
   * @param {number} [maxBounces] この回数までのバウンドを跨いで追い続ける（既定1）
   * @returns {{enter:object, exit:object, mid:{x:number,y:number,z:number,t:number}}|null}
   */
  function predictWindow(b, accept, maxT, maxBounces) {
    const limit = maxT === undefined ? 3 : maxT;
    const allowed = maxBounces === undefined ? 1 : maxBounces;
    const s = {
      x: b.x, y: b.y, z: b.z,
      px: b.x, py: b.y, pz: b.z,
      vx: b.vx, vy: b.vy, vz: b.vz,
      spin: b.spin,
      wind: b.wind,
    };
    const dt = 1 / 120;
    let bounces = b.bounces || 0;
    let enter = null;
    let exit = null;
    for (let t = 0; t < limit; t += dt) {
      integrate(s, dt);
      if (hitsNet(s)) break;
      if (s.y <= BALL_R && s.vy < 0) {
        if (bounces - (b.bounces || 0) >= allowed) break; // これ以上は追わない
        reflectBounce(s);
        bounces++;
      }
      const sample = {
        x: s.x, y: s.y, z: s.z, t: t + dt, bounces,
      };
      if (accept(sample)) {
        if (!enter) enter = sample;
        exit = sample;
      } else if (enter) {
        break; // 一度満たしてから外れたら、そこで区間はおしまい
      }
    }
    if (!enter) return null;
    return {
      enter,
      exit,
      // 区間の真ん中＝一番余裕をもって打てる点（両端は帯のふちで、少しずれると打てない）
      mid: {
        x: (enter.x + exit.x) / 2,
        y: (enter.y + exit.y) / 2,
        z: (enter.z + exit.z) / 2,
        t: (enter.t + exit.t) / 2,
      },
    };
  }

  /**
   * ボールが指定した z 平面を通過する瞬間の位置。通過する前に着地／ネットしてしまうなら null。
   * ダブルスの前衛が「まだ着地していないボールが自分の目の前を素通りするか（＝ポーチできるか）」
   * を判定するのに使う（isResponder が着地点だけで判断すると、前衛の近くを通る球でも
   * 着地点が深い相方任せになってしまうため）。
   * @param {number} [maxBounces] この回数までのバウンドは跨いで追い続ける。既定0＝
   *   ノーバウンドで通過する場合だけ（ポーチ判定はこちら）。1 を渡すと「1回バウンドした後、
   *   自分の深さを通過する瞬間」が取れる＝速い球を迎え撃つ位置の計算に使える。
   * @returns {{x:number, y:number, t:number}|null}
   */
  function predictAtZ(b, targetZ, maxT, maxBounces) {
    const limit = maxT === undefined ? 5 : maxT;
    const allowed = maxBounces === undefined ? 0 : maxBounces;
    const startSign = Math.sign(targetZ - b.z);
    if (startSign === 0) return { x: b.x, y: b.y, t: 0 };
    const s = {
      x: b.x, y: b.y, z: b.z,
      px: b.x, py: b.y, pz: b.z,
      vx: b.vx, vy: b.vy, vz: b.vz,
      spin: b.spin,
      wind: b.wind,
    };
    const dt = 1 / 120;
    let bounced = 0;
    for (let t = 0; t < limit; t += dt) {
      integrate(s, dt);
      if (hitsNet(s)) return null;
      if (s.y <= BALL_R && s.vy < 0) {
        if (bounced >= allowed) return null; // 通過する前に着地する
        // reflectBounce() は x/z を「本当の接地点」に戻すだけで、直前位置(px/pz)との間に
        // 収まるので、この下の線形補間はそのまま成り立つ。
        reflectBounce(s);
        bounced++;
      }
      if (Math.sign(targetZ - s.z) !== startSign) {
        const span = s.z - s.pz;
        const tt = span === 0 ? 1 : (targetZ - s.pz) / span;
        return { x: lerp(s.px, s.x, tt), y: lerp(s.py, s.y, tt), t };
      }
    }
    return null;
  }

  /**
   * from から target へ、baseT 秒で落とす初速を解く。
   * その軌道がネットに当たるなら、当たらなくなるまで滞空時間を伸ばして（＝山なりにして）解き直す。
   */
  /**
   * @param {'flat'|'top'|'slice'} [spin] 省略時（フラット）は従来と完全に同じ挙動になる。
   *   ここで使った実効重力(g)は、後で実際に飛ばすとき integrate() が `ball.spin` から
   *   同じ値を引けるよう、呼び出し側が返り値と一緒に `ball.spin = spin` も設定すること。
   */
  function solveShot(from, target, baseT, clearance, spin) {
    const margin = clearance === undefined ? 0.30 : clearance;
    const g = spinGravity(spin);
    const velocityFor = (t) => ({
      vx: (target.x - from.x) / t,
      vy: (target.y - from.y - 0.5 * g * t * t) / t,
      vz: (target.z - from.z) / t,
    });

    let t = baseT;
    for (let i = 0; i < 14; i++) {
      const v = velocityFor(t);
      const tNet = -from.z / v.vz;                  // ネット面に達する時刻
      if (!(tNet > 0 && tNet < t)) return v;        // ネットを通らない軌道
      const yNet = from.y + v.vy * tNet + 0.5 * g * tNet * tNet;
      if (yNet > netHeightAt(from.x + v.vx * tNet) + margin) return v;
      t *= 1.12;
    }
    return velocityFor(t); // 収束しなくても一番山なりな解を返す
  }

  RallyOne.physics = {
    netHeightAt,
    integrate,
    crossedNet,
    netCrossing,
    hitsNet,
    reflectBounce,
    predictLanding,
    predictApex,
    predictBounceApex,
    predictAtZ,
    predictWindow,
    solveShot,
    spinGravity,
  };
})(window.RallyOne = window.RallyOne || {});
