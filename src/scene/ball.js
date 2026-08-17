/** ボール、擬似影（ブロブ）、着地マーカー。 */
(function (RallyOne) {
  'use strict';

  const { PHYSICS, THEME } = RallyOne.config;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  const GROUND_Y = 0.012; // 影はコート面より少し上に置いて Z ファイティングを避ける

  scene3d.createBall = function createBall() {
    return new THREE.Mesh(
      new THREE.SphereGeometry(PHYSICS.BALL_R, 18, 14),
      new THREE.MeshLambertMaterial({ color: THEME.BALL, emissive: THEME.BALL_EMISSIVE }),
    );
  };

  /** 影の代わりの黒い円。半透明なので depthWrite は切る。 */
  scene3d.createShadow = function createShadow(opacity) {
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity, depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = GROUND_Y;
    return mesh;
  };

  scene3d.createMarker = function createMarker() {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.36, 28),
      new THREE.MeshBasicMaterial({
        color: THEME.BALL, transparent: true, opacity: 0.65, depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = GROUND_Y + 0.002;
    return mesh;
  };

  /** 高いボールの影ほど大きく薄くする */
  scene3d.placeBallShadow = function placeBallShadow(shadow, ball) {
    const scale = Math.min(Math.max(0.28 - ball.y * 0.012, 0.13), 0.3);
    shadow.position.set(ball.x, GROUND_Y, ball.z);
    shadow.scale.setScalar(scale * (1 + ball.y * 0.14));
    shadow.material.opacity = Math.min(Math.max(0.34 - ball.y * 0.02, 0.06), 0.34);
  };

  scene3d.placeGroundShadow = function placeGroundShadow(shadow, actor) {
    shadow.position.set(actor.x, GROUND_Y, actor.z);
    shadow.scale.setScalar(0.34);
  };
})(window.RallyOne = window.RallyOne || {});
