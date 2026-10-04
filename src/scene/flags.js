/**
 * 風向きを見せる旗。両エンドのスタンドの後ろにポールを立てて揚げる（配置・寸法は config.FLAG）。
 * ゲームロジックには関与せず、world.js が毎フレーム渡す風（会場の座標）に合わせて
 * 向き・垂れ具合・はためきを変えるだけ。布の物理は解かず、頂点を数式で動かす簡易版
 * （先端ほど大きく揺れる進行波＋風が弱いほど下へ垂れる）。
 */
(function (RallyOne) {
  'use strict';

  const { FLAG } = RallyOne.config;
  const { lerp, clamp } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  /** 架空の大会旗（地の色・ポール側の帯・テニスボールの紋章）を CanvasTexture に焼く。 */
  function flagTexture({ field, band, emblem }) {
    const W = 256;
    const H = Math.round(W * FLAG.HEIGHT / FLAG.LENGTH);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = field;
    g.fillRect(0, 0, W, H);
    g.fillStyle = band;
    g.fillRect(0, 0, W * 0.16, H);

    const cx = W * 0.58;
    const cy = H / 2;
    const r = H * 0.3;
    g.fillStyle = emblem;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    // ボールの縫い目（左右の外側に中心を置いた円の、内側へ張り出す弧を2本）
    g.strokeStyle = field;
    g.lineWidth = r * 0.14;
    [[-1, 0], [1, Math.PI]].forEach(([side, facing]) => {
      g.beginPath();
      g.arc(cx + side * r * 1.25, cy, r * 0.95, facing - 0.95, facing + 0.95);
      g.stroke();
    });

    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  /** ポール1本＋旗1枚。旗は pivot（ポールの先端）の下に吊るし、pivot を回して風下へ向ける。 */
  function createFlag(x, z, design, phase) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const poleMat = new THREE.MeshLambertMaterial({ color: FLAG.POLE_COLOR });
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(FLAG.POLE_RADIUS, FLAG.POLE_RADIUS * 1.3, FLAG.POLE_HEIGHT, 8),
      poleMat,
    );
    pole.position.y = FLAG.POLE_HEIGHT / 2;
    const finial = new THREE.Mesh(new THREE.SphereGeometry(FLAG.POLE_RADIUS * 2, 10, 8), poleMat);
    finial.position.y = FLAG.POLE_HEIGHT;
    group.add(pole, finial);

    // 旗の布。ポール側の辺（x=0）を pivot の位置に揃え、+x へ伸ばし、上辺から下へ垂らす。
    const geometry = new THREE.PlaneGeometry(FLAG.LENGTH, FLAG.HEIGHT, FLAG.SEG_X, FLAG.SEG_Y);
    geometry.translate(FLAG.LENGTH / 2, -FLAG.HEIGHT / 2, 0);
    const cloth = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
      map: flagTexture(design), side: THREE.DoubleSide,
    }));
    const pivot = new THREE.Group();
    pivot.position.y = FLAG.POLE_HEIGHT - FLAG.POLE_RADIUS * 2;
    pivot.add(cloth);
    group.add(pivot);

    group.userData = {
      pivot,
      geometry,
      base: Float32Array.from(geometry.attributes.position.array), // 平らなときの頂点
      phase, // はためきの位相（旗ごとにずらして、並んだ2本が揃って揺れないようにする）
    };
    return group;
  }

  /**
   * 頂点を動かして、垂れ具合 droop(rad)・はためき（振幅 amp、位相 phase）の形にする。
   * ポール側の辺（x=0）は動かさない。
   */
  function shapeCloth(flag, droop, amp) {
    const { geometry, base, phase } = flag.userData;
    const pos = geometry.attributes.position.array;
    const cos = Math.cos(droop);
    const sin = Math.sin(droop);
    for (let i = 0; i < pos.length; i += 3) {
      const x0 = base[i];
      const y0 = base[i + 1];
      const u = x0 / FLAG.LENGTH; // 0＝ポール側〜1＝先端
      pos[i] = FLAG.POLE_RADIUS + x0 * cos;
      pos[i + 1] = y0 - x0 * sin;
      pos[i + 2] = amp * u * (Math.sin(FLAG.WAVE_K * x0 - phase)
        + 0.35 * Math.sin(1.7 * FLAG.WAVE_K * x0 + 2.3 * y0 - 1.3 * phase));
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  /** @returns {THREE.Group} 両エンドの旗（POLES とその原点対称の位置） */
  scene3d.createFlags = function createFlags() {
    const group = new THREE.Group();
    const spots = FLAG.POLES.flatMap((p) => [p, { x: -p.x, z: -p.z }]);
    const flags = spots.map((p, i) => createFlag(
      p.x, p.z, FLAG.DESIGNS[i % FLAG.DESIGNS.length], i * 1.9,
    ));
    group.add(...flags);
    group.userData = { flags, wind: { x: 0, z: 0 }, yaw: 0 };
    scene3d.updateFlags(group, 0, 0, 0);
    return group;
  };

  /**
   * 風に合わせて旗をなびかせる（world.js が毎フレーム呼ぶ）。風が変わっても一瞬で
   * 向きを変えず、FLAG.RESPONSE の速さで追いつく。
   * @param {THREE.Group} group createFlags() が返したグループ
   * @param {number} windX 会場の座標での風の横成分(m/s²)
   * @param {number} windZ 会場の座標での風の前後成分(m/s²)
   * @param {number} dt
   */
  scene3d.updateFlags = function updateFlags(group, windX, windZ, dt) {
    const state = group.userData;
    const t = Math.min(1, dt * FLAG.RESPONSE);
    state.wind.x = lerp(state.wind.x, windX, t);
    state.wind.z = lerp(state.wind.z, windZ, t);
    const strength = Math.hypot(state.wind.x, state.wind.z);
    // ほぼ無風のときは向きを決めない（垂れたまま、前の向きを保つ＝くるくる回らない）
    if (strength > 1e-3) state.yaw = Math.atan2(-state.wind.z, state.wind.x); // 旗の +x を風下へ
    const s = clamp(strength / FLAG.FULL_ACCEL, 0, 1);
    const droop = lerp(FLAG.DROOP_CALM, FLAG.DROOP_STRONG, s);
    const amp = lerp(FLAG.WAVE_AMP[0], FLAG.WAVE_AMP[1], s);
    const speed = lerp(FLAG.WAVE_SPEED[0], FLAG.WAVE_SPEED[1], s);
    state.flags.forEach((flag) => {
      flag.userData.phase += dt * speed;
      flag.userData.pivot.rotation.y = state.yaw;
      shapeCloth(flag, droop, amp);
    });
  };
})(window.RallyOne = window.RallyOne || {});
