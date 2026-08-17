/** コート面・外周・スタンド。ラインは CanvasTexture に焼いて1メッシュで済ませる。 */
(function (RallyOne) {
  'use strict';

  const { COURT, HALF_L, HALF_W, THEME } = RallyOne.config;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  /** テクスチャが覆うワールド範囲（±RX, ±RZ）。コート平面のサイズと対応させること。 */
  const RX = 8;
  const RZ = 18;
  const PLANE_W = 16;
  const PLANE_L = 36;

  function courtTexture() {
    const W = 1024;
    const H = 2048;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');

    const px = (x) => (x + RX) / (2 * RX) * W;
    const pz = (z) => (z + RZ) / (2 * RZ) * H;
    const uw = (m) => m / (2 * RX) * W;

    g.fillStyle = THEME.COURT_APRON;
    g.fillRect(0, 0, W, H);
    g.fillStyle = THEME.COURT_SURFACE;
    g.fillRect(px(-COURT.DW / 2), pz(-HALF_L), uw(COURT.DW), pz(HALF_L) - pz(-HALF_L));

    g.strokeStyle = THEME.COURT_LINE;
    g.lineWidth = uw(0.06);
    const seg = (x1, z1, x2, z2) => {
      g.beginPath();
      g.moveTo(px(x1), pz(z1));
      g.lineTo(px(x2), pz(z2));
      g.stroke();
    };

    const HDW = COURT.DW / 2;
    seg(-HDW, -HALF_L, HDW, -HALF_L);                     // ベースライン
    seg(-HDW, HALF_L, HDW, HALF_L);
    seg(-HDW, -HALF_L, -HDW, HALF_L);                     // ダブルスサイドライン
    seg(HDW, -HALF_L, HDW, HALF_L);
    seg(-HALF_W, -HALF_L, -HALF_W, HALF_L);               // シングルスサイドライン
    seg(HALF_W, -HALF_L, HALF_W, HALF_L);
    seg(-HALF_W, -COURT.SERVICE, HALF_W, -COURT.SERVICE); // サービスライン
    seg(-HALF_W, COURT.SERVICE, HALF_W, COURT.SERVICE);
    seg(0, -COURT.SERVICE, 0, COURT.SERVICE);             // センターサービスライン
    seg(0, -HALF_L, 0, -HALF_L + 0.3);                    // センターマーク
    seg(0, HALF_L, 0, HALF_L - 0.3);

    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 8;
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  /** スケール感を出すためのスタンド代わりの低い壁 */
  function createStands() {
    const group = new THREE.Group();
    const material = new THREE.MeshLambertMaterial({ color: THEME.STAND });
    [[0, 20], [0, -20], [26, 0], [-26, 0]].forEach(([x, z]) => {
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(x ? 2 : 54, 2.6, x ? 42 : 2),
        material,
      );
      wall.position.set(x, 1.3, z);
      group.add(wall);
    });
    return group;
  }

  scene3d.createCourt = function createCourt() {
    const group = new THREE.Group();

    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(PLANE_W, PLANE_L),
      new THREE.MeshLambertMaterial({ map: courtTexture() }),
    );
    surface.rotation.x = -Math.PI / 2;
    group.add(surface);

    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 70),
      new THREE.MeshLambertMaterial({ color: THEME.APRON }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.02;
    group.add(apron);

    group.add(createStands());
    return group;
  };
})(window.RallyOne = window.RallyOne || {});
