/**
 * 時間帯（デー／ナイト）と天候（にわか雨）の見た目。ゲームの判定には一切関わらず、
 * game.rain・game.wet を読んで雨粒・コートのシート・濡れたコートの暗さを出し、
 * ナイトセッションでは照明塔・星空・照明の当たり方に切り替える（config.SESSIONS／NIGHT／RAIN）。
 */
(function (RallyOne) {
  'use strict';

  const {
    COURT, COURT_PLANE, NIGHT, RAIN, SESSIONS,
  } = RallyOne.config;
  const { clamp, lerp } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  /** 灯具のにじみ（中心が白く、外へ透明になる丸）。Sprite に貼る。 */
  function glowTexture() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,250,230,0.95)');
    grad.addColorStop(0.25, 'rgba(255,240,200,0.45)');
    grad.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(canvas);
  }

  /**
   * 空のグラデーション（背景）。canvas に縦の帯を描き、色が変わったら描き直す。
   * 背景のテクスチャは画面に貼られるので、上端＝空の高いところ、下端＝地平線の色になる。
   */
  function createSky() {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 256;
    const g = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding; // 描いた色そのままに見せる（出力が sRGB のため）
    const top = new THREE.Color();
    const horizon = new THREE.Color();
    const rainyColor = new THREE.Color();
    let drawn = '';
    return {
      texture,
      horizon,
      /** @param {{TOP:number, HORIZON:number}} clear @param {{TOP:number, HORIZON:number}} rainy @param {number} k 雨の強さ */
      paint(clear, rainy, k) {
        top.setHex(clear.TOP).lerp(rainyColor.setHex(rainy.TOP), k);
        horizon.setHex(clear.HORIZON).lerp(rainyColor.setHex(rainy.HORIZON), k);
        const key = `${top.getHexString()}${horizon.getHexString()}`;
        if (key === drawn) return;
        drawn = key;
        const grad = g.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0, `#${top.getHexString()}`);
        grad.addColorStop(1, `#${horizon.getHexString()}`);
        g.fillStyle = grad;
        g.fillRect(0, 0, canvas.width, canvas.height);
        texture.needsUpdate = true;
      },
    };
  }

  /** 四隅の照明塔（柱・灯具の板・にじみ）と、そこからコートへ当てる光。 */
  function createTowers() {
    const group = new THREE.Group();
    const lights = [];
    const poleMat = new THREE.MeshLambertMaterial({ color: NIGHT.POLE_COLOR });
    const lampMat = new THREE.MeshBasicMaterial({ color: NIGHT.LAMP_COLOR, fog: false });
    const glowMat = new THREE.SpriteMaterial({
      map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true,
    });
    NIGHT.TOWERS.forEach((at) => {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, NIGHT.HEIGHT, 8), poleMat);
      pole.position.set(at.x, NIGHT.HEIGHT / 2, at.z);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(NIGHT.LAMP.W, NIGHT.LAMP.H, 0.25), lampMat);
      lamp.position.set(at.x, NIGHT.HEIGHT + NIGHT.LAMP.H / 2, at.z);
      lamp.lookAt(0, 0, 0);
      const glow = new THREE.Sprite(glowMat);
      glow.position.copy(lamp.position);
      glow.scale.set(NIGHT.GLOW, NIGHT.GLOW, 1);
      const light = new THREE.DirectionalLight(NIGHT.FLOOD_COLOR, NIGHT.FLOOD_INTENSITY);
      light.position.copy(lamp.position); // 向きは既定の target（原点）＝コートの真ん中
      lights.push(light);
      group.add(pole, lamp, glow, light);
    });
    return { group, lights };
  }

  /** 夜空の星（霧の向こう＝遠くに置くので fog は切る）。 */
  function createStars() {
    const pos = new Float32Array(NIGHT.STARS * 3);
    for (let i = 0; i < NIGHT.STARS; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.12 + Math.random() * 0.85; // 地平線より上だけ
      const r = 90;
      pos[i * 3] = r * Math.cos(up) * Math.cos(a);
      pos[i * 3 + 1] = r * Math.sin(up);
      pos[i * 3 + 2] = r * Math.cos(up) * Math.sin(a);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xdfe8ff, size: 0.35, fog: false, transparent: true, opacity: 0.8,
    }));
  }

  /** 雨粒（短い線分）。いちばん強い雨のぶんだけ確保し、強さに応じて描く本数を絞る。 */
  function createDrops() {
    const A = RAIN.AREA;
    const pos = new Float32Array(RAIN.DROPS * 6);
    for (let i = 0; i < RAIN.DROPS; i++) {
      const x = (Math.random() * 2 - 1) * A.X;
      const z = (Math.random() * 2 - 1) * A.Z;
      const y = Math.random() * A.TOP;
      pos.set([x, y, z, x, y + RAIN.STREAK, z], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: RAIN.DROP_COLOR, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    lines.frustumCulled = false; // 頂点を毎フレーム動かすので、境界球で切られないように
    return lines;
  }

  /** コートを覆う板（シートと、濡れたコートを暗くする膜）。 */
  function coverPlane(color, y, opacity) {
    const halfX = COURT.DW / 2 + RAIN.COVER_MARGIN;
    const halfZ = COURT.L / 2 + RAIN.COVER_MARGIN;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(halfX * 2, halfZ * 2),
      new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    return { mesh, halfZ };
  }

  /**
   * @param {{scene:THREE.Scene, hemi:THREE.HemisphereLight, sun:THREE.DirectionalLight}} stage
   */
  scene3d.createWeather = function createWeather(stage) {
    const { scene, hemi, sun } = stage;
    const towers = createTowers();
    const stars = createStars();
    const drops = createDrops();
    // シートは手前のベースラインの外から奥へ引いて掛ける（group の z の縮尺で伸ばす）
    const tarp = coverPlane(RAIN.COVER_COLOR, 0.03, 1);
    const tarpPivot = new THREE.Group();
    tarpPivot.position.z = -tarp.halfZ;
    tarp.mesh.position.z = tarp.halfZ;
    tarpPivot.add(tarp.mesh);
    tarpPivot.visible = false;
    const damp = coverPlane(0x000000, 0.004, 0);
    damp.mesh.scale.set(COURT_PLANE.HALF_X / (COURT.DW / 2 + RAIN.COVER_MARGIN),
      COURT_PLANE.HALF_Z / (COURT.L / 2 + RAIN.COVER_MARGIN), 1);
    damp.mesh.visible = false;
    scene.add(towers.group, stars, drops, tarpPivot, damp.mesh);

    const sky = createSky();
    let session = 'day';
    let level = 0; // 雨の強さ（0〜1。目標へ LEVEL_RATE で寄せる）

    function setSession(name) {
      session = SESSIONS[name] ? name : 'day';
      const S = SESSIONS[session];
      if (!S.SKY) {
        scene.background = new THREE.Color(S.BG);
        scene.fog.color.setHex(S.BG);
      }
      hemi.color.setHex(S.HEMI.SKY);
      hemi.groundColor.setHex(S.HEMI.GROUND);
      const night = session === 'night';
      towers.group.visible = night;
      stars.visible = night;
      applyLight();
    }

    /** 雨の強さぶん空と照明を暗くする（晴れなら時間帯の値そのまま）。 */
    function applyLight() {
      const S = SESSIONS[session];
      const dim = lerp(1, RAIN.SKY_DIM, level);
      hemi.intensity = S.HEMI.INTENSITY * dim;
      sun.intensity = S.SUN * dim;
      towers.lights.forEach((l) => { l.intensity = NIGHT.FLOOD_INTENSITY * lerp(1, 0.8, level); });
      stars.material.opacity = 0.8 * (1 - level);
      if (S.SKY) {
        sky.paint(S.SKY, S.RAIN_SKY || S.SKY, level);
        scene.background = sky.texture;
        // 霧の色は線形の値として出力時に sRGB へ直されるので、地平線の色を線形に戻して渡す
        scene.fog.color.copy(sky.horizon).convertSRGBToLinear();
      }
    }

    /** 雨の段階（game.rain）から、目指す強さとシートの掛かり具合（0〜1）を決める。 */
    function targets(rain) {
      if (!rain) return { level: 0, cover: 0 };
      if (rain.phase === 'drizzle') return { level: RAIN.DRIZZLE_LEVEL, cover: 0 };
      if (rain.phase === 'heavy') return { level: 1, cover: 0 };
      if (rain.phase === 'suspended') return { level: 1, cover: clamp(rain.t / RAIN.COVER_T, 0, 1) };
      return { level: RAIN.DRIZZLE_LEVEL, cover: 1 - clamp(rain.t / RAIN.CLEAR_T, 0, 1) }; // 'clearing'（小雨に戻る）
    }

    /**
     * @param {{rain:object|null, wet:number}} state
     * @param {number} dt
     */
    function update(state, dt) {
      const want = targets(state.rain);
      level += clamp(want.level - level, -RAIN.LEVEL_RATE * dt, RAIN.LEVEL_RATE * dt);
      applyLight();

      const count = Math.round(RAIN.DROPS * level);
      drops.visible = count > 0;
      drops.geometry.setDrawRange(0, count * 2);
      if (count > 0) {
        const pos = drops.geometry.attributes.position.array;
        const fall = RAIN.FALL * dt;
        for (let i = 0; i < count; i++) {
          const j = i * 6;
          let y = pos[j + 1] - fall;
          if (y < 0) y += RAIN.AREA.TOP;
          pos[j + 1] = y;
          pos[j + 4] = y + RAIN.STREAK;
        }
        drops.geometry.attributes.position.needsUpdate = true;
      }

      tarpPivot.visible = want.cover > 0.001;
      tarpPivot.scale.z = Math.max(want.cover, 0.001);
      const wet = state.wet || 0;
      damp.mesh.visible = wet > 0.001;
      damp.mesh.material.opacity = RAIN.WET_DARKEN * wet;
    }

    setSession('day');

    return {
      setSession,
      update,
      isNight: () => session === 'night',
      /** シートが掛かりきっている間（選手はコートを離れている）か。 */
      isCovered: (state) => !!state.rain && state.rain.phase === 'suspended' && state.rain.t >= RAIN.COVER_T * 0.5,
      rainLevel: () => level,
    };
  };
})(window.RallyOne = window.RallyOne || {});
