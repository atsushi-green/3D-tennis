/**
 * スマッシュの先回りヒント。「ここに立てばスマッシュで打てる」地点をコート上に描く。
 * 地点そのものの計算は game.js の smashSpot()（純ロジック）が持ち、ここは描くだけ。
 */
(function (RallyOne) {
  'use strict';

  const { GUIDE, SMASH_HINT } = RallyOne.config;
  const { clamp } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  const GROUND_Y = 0.014; // コート面より少し上に置いて Z ファイティングを避ける

  function flatMaterial(opacity) {
    return new THREE.MeshBasicMaterial({
      color: SMASH_HINT.COLOR,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  function groundRing(inner, outer, material) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 44), material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = GROUND_Y;
    return ring;
  }

  /**
   * 立つべき地点の輪＋打点の高さを示す柱と印。外側の輪は打点までの残り時間で
   * 大きさが変わり、縮みきった（＝内側の輪に重なった）ときが打つ瞬間。
   */
  scene3d.createSmashHint = function createSmashHint() {
    const group = new THREE.Group();
    const body = flatMaterial(SMASH_HINT.OPACITY);
    const lead = flatMaterial(SMASH_HINT.LEAD_OPACITY);

    const spot = groundRing(SMASH_HINT.RING_R * 0.8, SMASH_HINT.RING_R, body);
    const timing = groundRing(SMASH_HINT.RING_R * 0.94, SMASH_HINT.RING_R, lead);

    // 打点の高さまで伸びる細い柱（高さ1で作り、scale.y で実際の打点の高さに伸ばす）
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(SMASH_HINT.POLE_R, SMASH_HINT.POLE_R, 1, 8),
      lead,
    );
    // 打点そのものの印
    const mark = new THREE.Mesh(new THREE.OctahedronGeometry(SMASH_HINT.MARK_R), body);

    group.add(spot, timing, pole, mark);
    group.visible = false;
    group.userData = { body, lead, timing, pole, mark };
    return group;
  };

  /**
   * @param {THREE.Group} group createSmashHint() が返したもの
   * @param {{x:number,y:number,z:number,t:number,ready:boolean,inTime:boolean}|null} hint
   *   RallyOne.Game#smashHint。null（スマッシュできる球が来ていない）なら隠す。
   */
  scene3d.placeSmashHint = function placeSmashHint(group, hint) {
    if (!hint) {
      group.visible = false;
      return;
    }
    const {
      body, lead, timing, pole, mark,
    } = group.userData;

    group.visible = true;
    group.position.set(hint.x, 0, hint.z);

    // 走れば間に合う／もう届く位置にいる／全力でも溜めが間に合わない、の3状態を色で出す
    const color = hint.ready
      ? SMASH_HINT.COLOR_READY
      : hint.inTime ? SMASH_HINT.COLOR : SMASH_HINT.COLOR_LATE;
    body.color.setHex(color);
    lead.color.setHex(color);

    // 残り時間に比例して外側の輪を大きく＝時間とともに縮んでくる（いつ振るかの目安）
    const remaining = clamp(hint.t / SMASH_HINT.LEAD_T, 0, 1);
    timing.scale.setScalar(1 + (SMASH_HINT.LEAD_RING_SCALE - 1) * remaining);

    pole.scale.y = hint.y;
    pole.position.y = hint.y / 2;
    mark.position.y = hint.y;
    mark.rotation.y += 0.06; // ゆっくり回して、止まっている輪と区別しやすくする
  };

  /* ------------------------------------------------ ガイド付きモードの打球方向 */

  function guideMaterial(opacity) {
    return new THREE.MeshBasicMaterial({
      color: GUIDE.COLOR_STRAIGHT,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /**
   * ガイド付きモードで出す「いま離したらここへ飛ぶ」の目印。予想着地点の輪と、
   * 打点からそこへ引く線の2つ。どこへ飛ぶかの計算は game.js の swingGuidePreview()
   * （純ロジック）が持ち、ここは描くだけ（スマッシュのヒントと同じ役割分担）。
   */
  scene3d.createSwingGuide = function createSwingGuide() {
    const group = new THREE.Group();
    const ringMat = guideMaterial(GUIDE.OPACITY);
    const lineMat = guideMaterial(GUIDE.LINE_OPACITY);

    const ring = groundRing(GUIDE.RING_R - GUIDE.RING_W, GUIDE.RING_R, ringMat);
    // 輪の中心にも小さな塗り。遠い（＝画面上では小さい）相手コートの奥でも
    // 「そこが狙い」と一目で分かるようにする。
    const dot = groundRing(0, GUIDE.DOT_R, ringMat);
    // 打点から着地点へ引く線。長さ1の板として作り、scale.y で実際の距離まで伸ばす
    // （PlaneGeometry は XY 平面に作られるので、寝かせた後のローカル y が奥行きになる）。
    const line = new THREE.Mesh(new THREE.PlaneGeometry(GUIDE.LINE_W, 1), lineMat);
    line.rotation.x = -Math.PI / 2;
    line.position.y = GROUND_Y;

    group.add(ring, dot, line);
    group.visible = false;
    group.userData = { ringMat, lineMat, ring, dot, line };
    return group;
  };

  /**
   * @param {THREE.Group} group createSwingGuide() が返したもの
   * @param {{x:number, z:number, timing:number, tooEarly:boolean}|null} guide
   *   RallyOne.Game#swingGuide。null（ガイドを出す場面ではない）なら隠す。
   * @param {{x:number, z:number}} from 打つ人の位置（線の始点）
   */
  scene3d.placeSwingGuide = function placeSwingGuide(group, guide, from) {
    if (!guide) {
      group.visible = false;
      return;
    }
    const {
      ringMat, lineMat, ring, dot, line,
    } = group.userData;
    group.visible = true;

    // 引っ張り／素直／流し／まだ早い（いま離すと空振り）を色で見分ける
    const color = guide.tooEarly ? GUIDE.COLOR_EARLY
      : guide.timing > GUIDE.NEUTRAL_BAND ? GUIDE.COLOR_PULL
        : guide.timing < -GUIDE.NEUTRAL_BAND ? GUIDE.COLOR_FLOW : GUIDE.COLOR_STRAIGHT;
    ringMat.color.setHex(color);
    lineMat.color.setHex(color);
    ringMat.opacity = guide.tooEarly ? GUIDE.OPACITY * 0.5 : GUIDE.OPACITY;

    ring.position.set(guide.x, GROUND_Y, guide.z);
    dot.position.set(guide.x, GROUND_Y, guide.z);

    const dx = guide.x - from.x;
    const dz = guide.z - from.z;
    const dist = Math.hypot(dx, dz);
    line.position.set(from.x + dx / 2, GROUND_Y, from.z + dz / 2);
    line.rotation.z = Math.atan2(dx, dz); // 寝かせた板の向き（x,z 平面での向き）
    line.scale.y = dist;
  };
})(window.RallyOne = window.RallyOne || {});
