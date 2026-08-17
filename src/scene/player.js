/** 選手のメッシュ（胴・頭・ラケットを持つ腕）とスイングのポーズ。 */
(function (RallyOne) {
  'use strict';

  const { PLAYER, THEME } = RallyOne.config;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  const ARM_REST = -0.9;   // 構えたときの腕の角度
  const ARM_START = -1.2;  // スイング開始
  const ARM_SWEEP = 2.4;   // 振り抜く角度
  const ARM_SPAN = PLAYER.SERVE_ANIM; // アニメーションの基準時間

  function createArm(shirt, mat) {
    const arm = new THREE.Group();
    arm.position.set(0, 1.2, 0);

    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.5, 8), mat(shirt));
    upper.rotation.z = -Math.PI / 2;
    upper.position.x = 0.28;

    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 8, 20), mat(THEME.BALL));
    frame.position.set(0.72, 0, 0);

    const strings = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.14, side: THREE.DoubleSide,
      }),
    );
    strings.position.set(0.72, 0, 0);

    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.2, 8), mat(THEME.GRIP));
    grip.rotation.z = Math.PI / 2;
    grip.position.set(0.53, 0, 0);

    arm.add(upper, frame, strings, grip);
    return arm;
  }

  /**
   * @param {{shirt:number, shorts:number}} colors
   * @returns {THREE.Group} userData.arm にラケットを持つ腕が入る
   */
  scene3d.createPlayer = function createPlayer({ shirt, shorts }) {
    const group = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.15, 0.74, 12), mat(shorts));
    legs.position.y = 0.37;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.27, 0.68, 12), mat(shirt));
    body.position.y = 1.08;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), mat(THEME.SKIN));
    head.position.y = 1.55;
    group.add(legs, body, head);

    const arm = createArm(shirt, mat);
    group.add(arm);
    group.userData.arm = arm;
    return group;
  };

  /**
   * スイングの残り時間から腕の角度を決める。
   * @param {THREE.Group} player
   * @param {number} anim 残り時間（秒）。0 なら構えの姿勢
   */
  scene3d.setSwingPose = function setSwingPose(player, anim) {
    const progress = (ARM_SPAN - anim) / ARM_SPAN;
    player.userData.arm.rotation.y = anim > 0 ? ARM_START + progress * ARM_SWEEP : ARM_REST;
  };
})(window.RallyOne = window.RallyOne || {});
