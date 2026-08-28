/** コート面・外周・スタンド。ラインは CanvasTexture に焼いて1メッシュで済ませる。 */
(function (RallyOne) {
  'use strict';

  const {
    COURT, HALF_L, HALF_W, THEME, SURFACE_COLORS, STANDS,
  } = RallyOne.config;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  /** テクスチャが覆うワールド範囲（±RX, ±RZ）。コート平面のサイズと対応させること。 */
  const RX = 8;
  const RZ = 18;
  const PLANE_W = 16;
  const PLANE_L = 36;

  /** @param {'hard'|'clay'|'grass'} [surfaceName] 省略時はハード（現状の配色）。 */
  function colorsFor(surfaceName) {
    return SURFACE_COLORS[surfaceName] || SURFACE_COLORS.hard;
  }

  function courtTexture(surfaceName) {
    const { surface: surfaceColor, apron: apronColor } = colorsFor(surfaceName);
    const W = 1024;
    const H = 2048;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');

    const px = (x) => (x + RX) / (2 * RX) * W;
    const pz = (z) => (z + RZ) / (2 * RZ) * H;
    const uw = (m) => m / (2 * RX) * W;

    g.fillStyle = apronColor;
    g.fillRect(0, 0, W, H);
    g.fillStyle = surfaceColor;
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

  /** スケール感を出すためのスタンド代わりの低い壁。形状は STANDS（config.js）を参照する。 */
  function createStands() {
    const group = new THREE.Group();
    const material = new THREE.MeshLambertMaterial({ color: THEME.STAND });
    STANDS.WALLS.forEach(({ axis, fixed, span }) => {
      const w = axis === 'x' ? span : STANDS.THICKNESS;
      const d = axis === 'x' ? STANDS.THICKNESS : span;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, STANDS.HEIGHT, d), material);
      wall.position.set(axis === 'x' ? 0 : fixed, STANDS.HEIGHT / 2, axis === 'x' ? fixed : 0);
      group.add(wall);
    });
    return group;
  }

  /** @param {'hard'|'clay'|'grass'} [surfaceName] 省略時はハード（現状の配色）。 */
  scene3d.createCourt = function createCourt(surfaceName) {
    const group = new THREE.Group();

    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(PLANE_W, PLANE_L),
      new THREE.MeshLambertMaterial({ map: courtTexture(surfaceName) }),
    );
    surface.rotation.x = -Math.PI / 2;
    group.add(surface);
    group.userData.surfaceMesh = surface; // setCourtSurface() が後から塗り替えるときの参照

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

  /**
   * スタート画面でサーフェスを選び直したときに、既に作った同じコートの見た目だけを
   * 塗り替える（テクスチャを焼き直す）。試合中は呼ばない想定。
   * @param {THREE.Group} court createCourt() が返したグループ
   * @param {'hard'|'clay'|'grass'} surfaceName
   */
  scene3d.setCourtSurface = function setCourtSurface(court, surfaceName) {
    const mesh = court.userData.surfaceMesh;
    const oldTexture = mesh.material.map;
    mesh.material.map = courtTexture(surfaceName);
    mesh.material.needsUpdate = true;
    oldTexture.dispose();
  };
})(window.RallyOne = window.RallyOne || {});
