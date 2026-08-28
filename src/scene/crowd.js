/**
 * 観客。スタンドの壁（STANDS、court.js#createStands）の上に、簡易な人型を
 * ひな壇状に並べる。静止した装飾のみでゲームロジックには一切関与しない。
 * 壁4枚ぶんで数百体になり得るため、1体ずつ Mesh を作らず InstancedMesh 2つ
 * （胴・頭）だけで描く（world.js が起動時に1回だけシーンへ追加する）。
 */
(function (RallyOne) {
  'use strict';

  const { STANDS, SPECTATORS, THEME } = RallyOne.config;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  /** コート中心（原点付近）へ体を向ける回転(rad)。officials.js の faceInward() と同じ考え方。 */
  function faceInward(x, z) {
    return Math.atan2(-x, -z);
  }

  /** 壁1枚ぶんの観客席の座標を、ひな壇（ROWS段）ぶん列挙する。 */
  function seatsForWall({ axis, fixed, span }) {
    const seats = [];
    const halfSpan = span / 2 - SPECTATORS.EDGE_MARGIN;
    const count = Math.max(1, Math.floor((halfSpan * 2) / SPECTATORS.SEAT_SPACING));
    const outSign = Math.sign(fixed) || 1;

    for (let row = 0; row < SPECTATORS.ROWS; row++) {
      const outward = STANDS.THICKNESS / 2 + SPECTATORS.ROW_GAP * (row + 1);
      const y = STANDS.HEIGHT + SPECTATORS.ROW_RISE * row;
      for (let i = 0; i < count; i++) {
        const along = -halfSpan + (i + 0.5) * ((halfSpan * 2) / count)
          + (Math.random() - 0.5) * SPECTATORS.JITTER_ALONG;
        const x = axis === 'x' ? along : fixed + outSign * outward;
        const z = axis === 'x' ? fixed + outSign * outward : along;
        seats.push({ x, y: y + (Math.random() - 0.5) * SPECTATORS.JITTER_UP, z });
      }
    }
    return seats;
  }

  /** @returns {THREE.Group} InstancedMesh(胴・頭) をまとめたグループ */
  scene3d.createCrowd = function createCrowd() {
    const seats = STANDS.WALLS.flatMap(seatsForWall);
    const count = seats.length;

    const torsos = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.34, 0.5, 0.28),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      count,
    );
    const heads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.14, 8, 6),
      new THREE.MeshLambertMaterial({ color: THEME.SKIN }),
      count,
    );

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    seats.forEach((seat, i) => {
      const scale = SPECTATORS.SCALE + Math.random() * SPECTATORS.SCALE_JITTER;
      const rotY = faceInward(seat.x, seat.z);

      dummy.position.set(seat.x, seat.y + 0.26 * scale, seat.z);
      dummy.rotation.set(0, rotY, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      torsos.setMatrixAt(i, dummy.matrix);
      color.set(SPECTATORS.SHIRTS[Math.floor(Math.random() * SPECTATORS.SHIRTS.length)]);
      torsos.setColorAt(i, color);

      dummy.position.set(seat.x, seat.y + 0.54 * scale, seat.z);
      dummy.updateMatrix();
      heads.setMatrixAt(i, dummy.matrix);
    });

    torsos.instanceMatrix.needsUpdate = true;
    if (torsos.instanceColor) torsos.instanceColor.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;

    const group = new THREE.Group();
    group.add(torsos, heads);
    return group;
  };
})(window.RallyOne = window.RallyOne || {});
