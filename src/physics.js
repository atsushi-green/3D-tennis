/**
 * 純粋シミュレーション層。描画にも DOM にも依存しないので単体テストできる。
 * ボールは {x, y, z, px, py, pz, vx, vy, vz} という素の物体として扱う。
 */
(function (RallyOne) {
  'use strict';

  const { COURT, PHYSICS } = RallyOne.config;
  const { lerp } = RallyOne.math;
  const { GRAVITY, BALL_R } = PHYSICS;

  /** ネットは中央がたわみ、ポストに向かって高くなる */
  function netHeightAt(x) {
    const t = Math.min(Math.abs(x) / COURT.NET_HALF, 1);
    return COURT.NET_C + (COURT.NET_P - COURT.NET_C) * t * t;
  }

  /** 1ステップ進める。p* に進める前の位置を残す（ネット通過判定に使う） */
  function integrate(b, dt) {
    b.px = b.x;
    b.py = b.y;
    b.pz = b.z;
    b.vy += GRAVITY * dt;
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
   * 落下地点の予測。CPU の追跡と着地マーカーが使う。
   * @returns {{x:number, z:number, t:number, net:boolean}} net=true ならネットまで届かない
   */
  function predictLanding(b, maxT) {
    const limit = maxT === undefined ? 5 : maxT;
    const s = {
      x: b.x, y: b.y, z: b.z,
      px: b.x, py: b.y, pz: b.z,
      vx: b.vx, vy: b.vy, vz: b.vz,
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
   * from から target へ、baseT 秒で落とす初速を解く。
   * その軌道がネットに当たるなら、当たらなくなるまで滞空時間を伸ばして（＝山なりにして）解き直す。
   */
  function solveShot(from, target, baseT, clearance) {
    const margin = clearance === undefined ? 0.30 : clearance;
    const velocityFor = (t) => ({
      vx: (target.x - from.x) / t,
      vy: (target.y - from.y - 0.5 * GRAVITY * t * t) / t,
      vz: (target.z - from.z) / t,
    });

    let t = baseT;
    for (let i = 0; i < 14; i++) {
      const v = velocityFor(t);
      const tNet = -from.z / v.vz;                  // ネット面に達する時刻
      if (!(tNet > 0 && tNet < t)) return v;        // ネットを通らない軌道
      const yNet = from.y + v.vy * tNet + 0.5 * GRAVITY * tNet * tNet;
      if (yNet > netHeightAt(from.x + v.vx * tNet) + margin) return v;
      t *= 1.12;
    }
    return velocityFor(t); // 収束しなくても一番山なりな解を返す
  }

  RallyOne.physics = {
    netHeightAt, integrate, crossedNet, netCrossing, hitsNet, predictLanding, solveShot,
  };
})(window.RallyOne = window.RallyOne || {});
