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
  const F = OFFICIALS.BALLKID.FEED;
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

    // サーバーへの投げ渡し（feed）。投げた瞬間の手の位置（会場の座標）を覚えておき、そこから飛ばす
    let feedFrom = null;
    const feedOut = {
      ball: new THREE.Vector3(), kid: new THREE.Vector3(), caught: false, feeder: null,
    };
    const local = new THREE.Vector3();
    let path = null; // 投げた球の道のり（feedPath）

    /**
     * ワンバウンドの投げ渡しの道のり（会場の座標）。弾んでから手（to）に届くまでを UP_T 秒と
     * 決めて、後ろから逆算する：
     * - 弾んだ直後の上向きの速さ up … UP_T 秒で地面から手の高さへ届く速さ
     * - 弾む直前の下向きの速さ V … up を反発係数で割り戻したもの
     * - 投げてから弾むまで t1 … 手を離れた高さ h0 から、落ちきったとき V になる時間
     *   （h0 + v0·t − G·t²/2 = 0 と v0 − G·t = −V の短い方の解＝下へ投げ下ろす）
     * 横は弾むところで KEEP_VX まで落ちるので、弾む点は全体の t1/(t1+KEEP_VX·UP_T) の位置。
     */
    function feedPath(from, to) {
      const R = PHYSICS.BALL_R;
      const G = PHYSICS.REAL_G;
      const h0 = Math.max(0, from.y - R);
      const t2 = F.UP_T;
      const up = (to.y - R + G * t2 * t2 / 2) / t2;
      const V = up / F.RESTITUTION;
      const t1 = (V - Math.sqrt(Math.max(0, V * V - 2 * G * h0))) / G;
      const f = t1 / (t1 + F.KEEP_VX * t2);
      return {
        from: from.clone(), to: to.clone(), t1, t2, up, v0: G * t1 - V,
        bounce: new THREE.Vector3(lerp(from.x, to.x, f), R, lerp(from.z, to.z, f)),
      };
    }

    /** 投げてから s 秒の球の位置（会場の座標）を out に入れる。 */
    function feedAt(s, out) {
      const R = PHYSICS.BALL_R;
      const G = PHYSICS.REAL_G;
      if (s < path.t1) {
        const k = s / path.t1;
        return out.set(lerp(path.from.x, path.bounce.x, k),
          path.from.y + path.v0 * s - G * s * s / 2, lerp(path.from.z, path.bounce.z, k));
      }
      const s2 = s - path.t1;
      const k = clamp(s2 / path.t2, 0, 1);
      return out.set(lerp(path.bounce.x, path.to.x, k),
        R + path.up * s2 - G * s2 * s2 / 2, lerp(path.bounce.z, path.to.z, k));
    }

    /**
     * 後ろのコーナーの子が、サーバーの手（target）へ球を投げ渡す（OFFICIALS.BALLKID.FEED）。
     * 投げ渡すのは target にいちばん近いコーナーの子。振りかぶり（〜WIND）→上から投げ下ろし、
     * 球はコートで一度弾んで手に届く（feedPath）。
     * @param {number} t 投げ渡しを始めてからの秒数
     * @param {{x:number, y:number, z:number}} target 受け取る手（ゲームの座標＝ワールド）
     * @returns {{ball:THREE.Vector3, kid:THREE.Vector3, caught:boolean}} ball＝球、kid＝その子の胸元
     *   （どちらもワールドの座標。一人称の目が追う）、caught＝もう手に届いた
     */
    function feed(t, target) {
      venue.updateMatrixWorld(true);
      venue.worldToLocal(local.set(target.x, target.y, target.z));
      const kid = corner.reduce((best, k) => (
        Math.hypot(k.x - local.x, k.z - local.z) < Math.hypot(best.x - local.x, best.z - local.z) ? k : best));
      goHome(kid);
      kid.yaw = Math.atan2(local.x - kid.x, local.z - kid.z);
      kid.mesh.rotation.y = kid.yaw;
      // 球を持つ腕（+x 側）：頭の上へ振りかぶって、前下へ振り下ろし、ゆっくり下ろす
      const s = t - F.WIND; // 手を離れてからの秒数
      if (s < 0) path = null;
      const flight = path ? path.t1 + path.t2 : 0;
      const arm = s < 0 ? lerp(0, F.ARM_BACK, ease(t / F.WIND))
        : s < F.THROW_T ? lerp(F.ARM_BACK, F.ARM_THROW, ease(s / F.THROW_T))
          : lerp(F.ARM_THROW, 0, ease(clamp((s - F.THROW_T) / Math.max(flight, F.THROW_T), 0, 1)));
      kid.arms[1].rotation.x = arm;
      kid.mesh.updateMatrixWorld(true);
      feedOut.kid.set(kid.x, kid.hipY * F.CHEST, kid.z);
      venue.localToWorld(feedOut.kid);
      feedOut.feeder = kid;
      if (s >= 0 && !path) path = feedPath(feedFrom || handOf(kid).clone(), local);
      feedOut.caught = !!path && s >= path.t1 + path.t2;
      if (feedOut.caught) return feedOut; // 手に届いた＝本物の球に入れ替わる
      const p = prop('feed');
      if (s < 0) {
        feedFrom = handOf(kid).clone();
        place(p, feedFrom.x, feedFrom.y, feedFrom.z);
      } else {
        const at = feedAt(s, feedOut.ball);
        place(p, at.x, at.y, at.z); // 影も出す（サーバーの持つ本物の球は、届くまで影ごと隠れている）
      }
      venue.localToWorld(feedOut.ball.copy(p.ball.position));
      return feedOut;
    }

    /**
     * game の状態どおりにボールボーイと見た目だけの球を置く。replaying の間（リプレイ・
     * ハイライト）はボールボーイを持ち場に立たせ、球もすべて隠す（再生のコマの球と二重に
     * 見えないように。試合の時計も止まっているので、再生が終われば続きから動く）。
     * @param {{t:number, target:object}|null} [feedReq] サーバーへの投げ渡し（feed() 参照）
     * @returns {object|null} 投げ渡しの様子（feed() の戻り値）。投げ渡していなければ null
     */
    function update(state, dt, replaying, feedReq) {
      used = new Set();
      const busy = new Set();
      let fed = null;
      if (!replaying && feedReq) {
        fed = feed(feedReq.t, feedReq.target);
        busy.add(fed.feeder);
      } else {
        feedFrom = null;
        path = null;
      }
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
        trips.forEach(({ left, balls }, trip) => {
          if (!busy.has(corner[trip.kid])) busy.add(fetch(corner[trip.kid], trip, left, balls, dt));
        });
      }
      all.forEach((kid) => { if (!busy.has(kid)) goHome(kid); });
      props.forEach((p, key) => {
        if (used.has(key)) return;
        p.ball.visible = p.shadow.visible = false;
        props.delete(key);
        spare.push(p);
      });
      return fed;
    }

    return { update, active };
  };
})(window.RallyOne = window.RallyOne || {});
