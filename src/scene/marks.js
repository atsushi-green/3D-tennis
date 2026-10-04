/**
 * クレーのボールマーク（球が弾んだ跡）。world.js が game.lastBounce を見て1つずつ足す。
 * ゲームロジックには一切関与しない（判定はすべて game.js が済ませている）。
 *
 * 跡は会場（world.js の venue）のグループに置く。会場はチェンジエンズで180°回る＝跡も
 * コートに付いたまま選手と一緒に入れ替わって見える。値は config.js の BALL_MARK。
 */
(function (RallyOne) {
  'use strict';

  const { BALL_MARK } = RallyOne.config;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  /** 楕円の跡のテクスチャ（縦長。暗い芯＋掻き出された明るい縁）。全部の跡で1枚を使い回す。 */
  function markTexture() {
    const W = 64;
    const H = 128;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    g.save();
    g.translate(W / 2, H / 2);
    g.scale(1, H / W); // 円を縦に引き伸ばして楕円にする
    const r = W / 2 - 0.5; // 板いっぱいに描く（描いた縁＝markShape() の楕円の縁になるように）
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.fillStyle = BALL_MARK.COLOR_RIM;
    g.fill();
    const fill = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.88);
    fill.addColorStop(0, BALL_MARK.COLOR_CORE);
    fill.addColorStop(1, BALL_MARK.COLOR_EDGE);
    g.beginPath();
    g.arc(0, 0, r * 0.88, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.restore();
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  /**
   * 跡の形と、ゲームの座標での中心。打球の進む向き u へ伸びた楕円（半径 a×b）。
   *
   * 線審のコールがあったバウンドだけ、跡を線の外向き（call.out）へずらし、コート側の端が
   * ちょうど接地点に来るようにする。判定は「接地点（球の中心）がラインの外縁より内側か」
   * なので、こう置くと「跡が線に掛かる ⇔ イン」が必ず成り立つ（真ん中に置くと、アウトの
   * 跡の半分が線に掛かって見えることがある）。ベースラインへ向かう球なら、跡は接地点から
   * 先へ滑った形になり、実際のクレーの跡とも同じ向きになる。
   * @param {{x:number, z:number, vx:number, vz:number, call:object|null}} bounce game.lastBounce
   */
  function markShape(bounce) {
    const speed = Math.hypot(bounce.vx, bounce.vz);
    const u = speed > 1e-6 ? { x: bounce.vx / speed, z: bounce.vz / speed } : { x: 0, z: 1 };
    const b = BALL_MARK.HALF_WIDTH;
    const a = b + Math.min(BALL_MARK.SKID_MAX, speed * BALL_MARK.SKID_PER_MPS);
    let { x, z } = bounce;
    if (bounce.call) {
      const n = bounce.call.out;
      // 楕円が n の向きにどこまで張り出すか（支持関数）
      const along = u.x * n.x + u.z * n.z;
      const across = -u.z * n.x + u.x * n.z;
      const reach = Math.hypot(a * along, b * across);
      x += n.x * reach;
      z += n.z * reach;
    }
    return { x, z, u, a, b };
  }

  // 跡の置き方（判定との整合）は tests/smoke.mjs が Node で確かめる（ここは THREE も DOM も使わない）
  scene3d.ballMarkShape = markShape;

  /**
   * @returns {{group:THREE.Group, add:Function, clear:Function}}
   *   add(bounce, swapped) は跡を1つ足し、ゲームの座標での形（markShape()）を返す。
   */
  scene3d.createBallMarks = function createBallMarks() {
    const group = new THREE.Group();
    // XZ 平面に寝かせた 1×1 の板。長さ方向がローカル z（rotation.y で打球の向きへ回す）
    const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const material = new THREE.MeshLambertMaterial({
      map: markTexture(),
      transparent: true,
      opacity: BALL_MARK.OPACITY,
      depthWrite: false,
      // コート面（y=0）と同じ高さに描くと z-fighting でちらつくので、深度だけ手前へずらす
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    const marks = [];

    /**
     * @param {object} bounce game.lastBounce
     * @param {boolean} swapped game.endsSwapped（会場の座標へ直すため）
     */
    function add(bounce, swapped) {
      const shape = markShape(bounce);
      const k = swapped ? -1 : 1;
      const mesh = marks.length >= BALL_MARK.MAX ? marks.shift() : new THREE.Mesh(geometry, material);
      mesh.position.set(shape.x * k, 0, shape.z * k);
      mesh.rotation.y = Math.atan2(shape.u.x * k, shape.u.z * k);
      mesh.scale.set(shape.b * 2, 1, shape.a * 2);
      group.add(mesh);
      marks.push(mesh);
      return shape;
    }

    /** セットが終わってコートにブラシがかかった（または試合を作り直した）。 */
    function clear() {
      marks.forEach((m) => group.remove(m));
      marks.length = 0;
    }

    return { group, add, clear };
  };
})(window.RallyOne = window.RallyOne || {});
