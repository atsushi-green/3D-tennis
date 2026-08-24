/**
 * スマッシュの先回りヒント。「ここに立てばスマッシュで打てる」地点をコート上に描く。
 * 地点そのものの計算は game.js の smashSpot()（純ロジック）が持ち、ここは描くだけ。
 */
(function (RallyOne) {
  'use strict';

  const { SMASH_HINT } = RallyOne.config;
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
})(window.RallyOne = window.RallyOne || {});
