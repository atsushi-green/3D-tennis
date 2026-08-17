/** ネット本体（中央がたわむ）とポスト。 */
(function (RallyOne) {
  'use strict';

  const { COURT, THEME } = RallyOne.config;
  const { netHeightAt } = RallyOne.physics;
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

  scene3d.createNet = function createNet() {
    const group = new THREE.Group();

    group.add(new THREE.Mesh(saggedNetGeometry(), new THREE.MeshBasicMaterial({
      map: netTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    })));

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
})(window.RallyOne = window.RallyOne || {});
