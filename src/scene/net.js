/** ネット本体（中央がたわむ。球が当たると揺れる＝shakeNet()）とポスト。 */
(function (RallyOne) {
  'use strict';

  const { COURT, NET, THEME } = RallyOne.config;
  const { netHeightAt } = RallyOne.physics;
  const { clamp, lerp } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  function netTexture() {
    const cv = document.createElement('canvas');
    cv.width = 512;
    cv.height = 128;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 512, 128);
    g.strokeStyle = 'rgba(235,242,248,.55)';
    g.lineWidth = 1.2;
    for (let i = 0; i <= 64; i++) {
      g.beginPath();
      g.moveTo(i * 8, 0);
      g.lineTo(i * 8, 128);
      g.stroke();
    }
    for (let j = 0; j <= 16; j++) {
      g.beginPath();
      g.moveTo(0, j * 8);
      g.lineTo(512, j * 8);
      g.stroke();
    }
    g.fillStyle = '#f2f6fa';
    g.fillRect(0, 0, 512, 11); // 上部テープ
    return new THREE.CanvasTexture(cv);
  }

  /** 頂点の高さを netHeightAt() に合わせて、当たり判定と見た目を一致させる */
  function saggedNetGeometry() {
    const geo = new THREE.PlaneGeometry(COURT.NET_HALF * 2, COURT.NET_P, 48, 6);
    geo.translate(0, COURT.NET_P / 2, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, pos.getY(i) * (netHeightAt(pos.getX(i)) / COURT.NET_P));
    }
    pos.needsUpdate = true;
    return geo;
  }

  /**
   * @returns {THREE.Group} ネットとポスト。userData.mesh に網のメッシュ、userData.restY に
   *   揺れていないときの頂点の高さ（shakeNet() が白帯を沈ませる基準）。
   */
  scene3d.createNet = function createNet() {
    const group = new THREE.Group();

    const geo = saggedNetGeometry();
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: netTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    group.add(mesh);
    group.userData.mesh = mesh;
    group.userData.restY = Float32Array.from({ length: geo.attributes.position.count },
      (_, i) => geo.attributes.position.getY(i));
    group.userData.shaken = false;

    const postMat = new THREE.MeshLambertMaterial({ color: THEME.POST });
    [-COURT.NET_HALF, COURT.NET_HALF].forEach((x) => {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, COURT.NET_P, 10),
        postMat,
      );
      post.position.set(x, COURT.NET_P / 2, 0);
      group.add(post);
    });

    return group;
  };

  /**
   * 網を、球が当たってから age 秒後の形にする（hit が無い・揺れが収まった後は平らに戻す）。
   * 当たった点を中心にしたガウス分布の膨らみに、減衰する余弦振動を掛ける。網の両端（ポスト）と
   * 下端は止めてあるので、x は端へ、y は下端へ向かって 0 に落とす。白帯は膨らみの大きさに応じて
   * 当たった辺りが沈む（NET.SHAKE.DIP）。
   * @param {THREE.Group} net createNet() の戻り値
   * @param {{x:number, y:number, vz:number}|null} hit game.netHit
   * @param {number} age 当たってからの秒数（録画の時計。リプレイでも同じ瞬間に揺れる）
   */
  scene3d.shakeNet = function shakeNet(net, hit, age) {
    const S = NET.SHAKE;
    const live = hit && age >= 0 && age < S.DURATION;
    if (!live && !net.userData.shaken) return; // 平らなまま（毎フレーム頂点を書き換えない）
    const pos = net.userData.mesh.geometry.attributes.position;
    const restY = net.userData.restY;
    let amp = 0;
    if (live) {
      const size = clamp(Math.abs(hit.vz) * S.AMP_PER_MPS, S.AMP_MIN, S.AMP_MAX);
      amp = Math.sign(hit.vz || 1) * size * Math.exp(-S.DECAY * age) * Math.cos(2 * Math.PI * S.FREQ * age);
    }
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = restY[i];
      const ends = Math.max(0, 1 - (x / COURT.NET_HALF) ** 2); // ポストで 0
      // 揺れていない／ポストの上（浮動小数で端を越えると高さ0で割ってしまう）は元の形
      if (amp === 0 || ends === 0) { pos.setXYZ(i, x, y, 0); continue; }
      const base = clamp(y / netHeightAt(x), 0, 1);  // 下端で 0
      const tape = lerp(1, S.TOP_FREE, base ** 4);     // 白帯の近くは前後に動きにくい
      const nearX = Math.exp(-(((x - hit.x) / S.SPREAD_X) ** 2) / 2) * ends;
      const near = nearX * Math.exp(-(((y - hit.y) / S.SPREAD_Y) ** 2) / 2);
      pos.setXYZ(i, x, y - S.DIP * Math.abs(amp) * nearX * base, amp * near * Math.sin(base * Math.PI / 2) * tape);
    }
    pos.needsUpdate = true;
    net.userData.shaken = live;
  };
})(window.RallyOne = window.RallyOne || {});
