/**
 * ボールボーイが球を拾いに行く演出と、決まった後も転がる球の表示（表示側のみ）。
 * - ネットに掛かった球：game.netBallRest（game.js#planBallKid）の段取りどおり、ネット際の子が拾う
 * - アウト・ツーバウンドなどで決まった球：game.looseBalls（game.js#releaseBall）が弾んで転がり、
 *   止まったらコーナーの子が拾う
 * 段取りの時計は game 側の残り秒数（left）から逆算する＝試合の時計と同じで、リプレイの間は進まない。
 * 拾われる球は本物の球とは別の見た目だけの球で、その間は本物の球を隠す（world.js）。
 * 調整値は OFFICIALS.BALLKID。
 */
(function (RallyOne) {
  'use strict';

  const { OFFICIALS, PHYSICS } = RallyOne.config;
  const { clamp, lerp } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  const P = OFFICIALS.BALLKID.PICKUP;
  const ease = (u) => u * u * (3 - 2 * u);

  /** a から b へ最短で回る角度差(rad)。 */
  function angleDiff(b, a) {
    return Math.atan2(Math.sin(b - a), Math.cos(b - a));
  }

  /**
   * 人型（officials.js#createFigure）を、腰で曲がり、股関節で脚を振れる形に組み直す。
   * 胴・頭・肩を腰の Group の下へ、脚をそれぞれ股関節の Group の下へ移す。
   */
  function rig(kid) {
    const fig = kid.mesh;
    const { torso, head, legs } = fig.userData.parts;
    const arms = fig.userData.arms;
    const hipY = legs[0].position.y * 2; // 脚の円柱の中心は脚の長さの半分
    const waist = new THREE.Group();
    waist.position.y = hipY;
    [torso, head, ...arms].forEach((part) => {
      fig.remove(part);
      part.position.y -= hipY;
      waist.add(part);
    });
    fig.add(waist);
    const hips = legs.map((leg) => {
      const hip = new THREE.Group();
      hip.position.set(leg.position.x, hipY, 0);
      fig.remove(leg);
      leg.position.set(0, -hipY / 2, 0);
      hip.add(leg);
      fig.add(hip);
      return hip;
    });
    const armLen = -2 * arms[0].children[0].position.y;
    const restZ = arms.map((arm) => arm.rotation.z);
    return { ...kid, waist, hips, arms, hipY, armLen, restZ, yaw: kid.facing };
  }

  /**
   * かがみ具合 crouch（0〜1）・走りの位相 phase（rad）・走っているか run・球を持っているか
   * carry（0〜1＝持った腕を前へ出しきるまで）で姿勢を決める。
   */
  function pose(kid, crouch, phase, run, carry) {
    const c = ease(clamp(crouch, 0, 1));
    const hip = kid.hipY * lerp(1, P.HIP, c);
    const bob = run ? Math.abs(Math.sin(phase)) * P.BOB : 0;
    kid.waist.position.y = hip + bob;
    kid.waist.rotation.x = P.BEND * c + (run ? P.RUN_LEAN : 0);
    const swing = run ? Math.sin(phase) : 0;
    kid.hips.forEach((h, i) => {
      h.position.y = hip + bob;
      h.scale.y = lerp(1, P.HIP, c); // 縮めた脚＝膝を曲げた代わり
      h.rotation.x = (i === 0 ? 1 : -1) * swing * P.LEG_SWING;
    });
    // かがむと上体と一緒に前へ倒れる腕を、真下（少し前）へ戻して足元へ手を伸ばす
    const reach = -(P.BEND + P.ARM_FORWARD) * c;
    kid.arms.forEach((arm, i) => {
      let x = reach + (i === 0 ? -1 : 1) * swing * P.ARM_SWING;
      if (i === 1 && carry > 0) x = lerp(reach, P.CARRY_ARM, ease(clamp(carry, 0, 1)));
      arm.rotation.set(x, 0, kid.restZ[i]);
    });
  }

  /**
   * @param {{netKids:object[], cornerKids:object[]}} kids officials.js が並べたボールボーイ
   *   （{mesh, x, z, facing}、会場の座標）
   * @param {THREE.Group} venue 会場（チェンジエンズで回る）。拾われる球・転がる球もここに置く
   */
  scene3d.createBallPickup = function createBallPickup({ netKids, cornerKids }, venue) {
    const net = netKids.map(rig);
    const corner = cornerKids.map(rig);
    const all = [...net, ...corner];
    const hand = new THREE.Vector3();
    const props = new Map(); // 見た目だけの球（key → {ball, shadow}）。使わなくなったら隠して使い回す
    const spare = [];
    let used = new Set();

    function prop(key) {
      used.add(key);
      let p = props.get(key);
      if (!p) {
        p = spare.pop();
        if (!p) {
          p = { ball: scene3d.createBall(), shadow: scene3d.createShadow(0.34) };
          venue.add(p.ball, p.shadow);
        }
        props.set(key, p);
      }
      p.ball.visible = p.shadow.visible = true;
      return p;
    }

    function place(p, x, y, z) {
      p.ball.position.set(x, y, z);
      scene3d.placeBallShadow(p.shadow, { x, y, z });
    }

    function goHome(kid) {
      kid.mesh.position.set(kid.x, 0, kid.z);
      kid.yaw = kid.facing;
      kid.mesh.rotation.y = kid.facing;
      pose(kid, 0, 0, false, 0);
    }

    /** ネットに掛かった球を拾いに出ている間（その間は本物の球を隠す）か。 */
    function active(state) {
      return !!state.netBallRest && state.netBallRest.left > 0;
    }

    /**
     * 道のり plan（game.js#planRoute）の時刻 t の位置へ kid を置いて姿勢を決める。最初の球を
     * 拾ってからは、+x 側の腕を前へ出して持ったまま走る。
     */
    function act(kid, plan, t, dt) {
      const seg = plan.segments.find((s) => t < s.t1) || plan.segments[plan.segments.length - 1];
      let pos = { x: kid.x, z: kid.z };
      let target = kid.facing;
      let crouch = 0;
      let run = false;
      let phase = 0;
      if (t >= seg.t0 && seg.kind === 'run') {
        const u = clamp((t - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0), 0, 1);
        pos = { x: lerp(seg.from.x, seg.to.x, u), z: lerp(seg.from.z, seg.to.z, u) };
        target = Math.atan2(seg.to.x - seg.from.x, seg.to.z - seg.from.z);
        run = true;
        phase = ((t - seg.t0) * plan.speed / P.STRIDE) * Math.PI;
      } else if (t >= seg.t0) {
        const u = t - seg.t0;
        pos = seg.stand;
        target = Math.atan2(seg.ball.x - seg.stand.x, seg.ball.z - seg.stand.z);
        crouch = u < P.DOWN ? u / P.DOWN : u < P.DOWN + P.HOLD ? 1 : 1 - (u - P.DOWN - P.HOLD) / P.UP;
      }
      const first = plan.picks[0];
      const carry = t >= first ? (t - first) / (P.HOLD / 2 + P.UP) : 0;
      kid.yaw += angleDiff(target, kid.yaw) * Math.min(1, P.TURN * dt);
      kid.mesh.position.set(pos.x, 0, pos.z);
      kid.mesh.rotation.y = kid.yaw;
      pose(kid, crouch, phase, run, carry);
    }

    /** 球を持つ手（+x 側の腕の先）の位置（会場の座標）。 */
    function handOf(kid) {
      kid.mesh.updateMatrixWorld(true);
      hand.set(0, -kid.armLen - PHYSICS.BALL_R, 0);
      kid.arms[1].localToWorld(hand);
      return venue.worldToLocal(hand);
    }

    /**
     * ボールボーイ1人ぶんの道のりを進め、拾いに行く球を置く。balls は [{key, ball:{x,z}, pickAt}]。
     * 拾った球は手に持ち、2つ目からはその上に重ねて持つ。
     */
    function fetch(kid, plan, left, balls, dt) {
      const t = plan.end - left;
      act(kid, plan, t, dt);
      const held = handOf(kid);
      let k = 0;
      balls.slice().sort((a, b) => a.pickAt - b.pickAt).forEach(({ key, ball, pickAt }) => {
        const p = prop(key);
        if (t < pickAt) {
          place(p, ball.x, PHYSICS.BALL_R, ball.z);
          return;
        }
        place(p, held.x, held.y + k * PHYSICS.BALL_R * 1.8, held.z);
        k++;
      });
      return kid;
    }

    /**
     * game の状態どおりにボールボーイと見た目だけの球を置く。replaying の間（リプレイ・
     * ハイライト）はボールボーイを持ち場に立たせ、球もすべて隠す（再生のコマの球と二重に
     * 見えないように。試合の時計も止まっているので、再生が終われば続きから動く）。
     */
    function update(state, dt, replaying) {
      used = new Set();
      const busy = new Set();
      if (!replaying) {
        const plan = state.netBallRest;
        if (active(state)) {
          busy.add(fetch(net[plan.kid], plan, plan.left, [{ key: 'net', ball: plan.ball, pickAt: plan.picks[0] }], dt));
        }
        const trips = new Map(); // 道のり → その道のりで拾う球
        (state.looseBalls || []).forEach((b) => {
          if (b.plan) {
            if (!trips.has(b.plan)) trips.set(b.plan, { left: b.left, balls: [] });
            trips.get(b.plan).balls.push({ key: b.id, ball: { x: b.x, z: b.z }, pickAt: b.pickAt });
          } else {
            const p = prop(b.id);
            place(p, b.x, b.y, b.z);
            if (b.crowd) p.shadow.visible = false; // 客席の段の上（地面の影は壁の裏に落ちる）
          }
        });
        trips.forEach(({ left, balls }, trip) => busy.add(fetch(corner[trip.kid], trip, left, balls, dt)));
      }
      all.forEach((kid) => { if (!busy.has(kid)) goHome(kid); });
      props.forEach((p, key) => {
        if (used.has(key)) return;
        p.ball.visible = p.shadow.visible = false;
        props.delete(key);
        spare.push(p);
      });
    }

    return { update, active };
  };
})(window.RallyOne = window.RallyOne || {});
