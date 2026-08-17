/** レンダラー・シーン・カメラ・ライトという「箱」だけを組む。中身は各 scene/*.js が足す。 */
(function (RallyOne) {
  'use strict';

  const { CAMERA, THEME } = RallyOne.config;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  scene3d.createStage = function createStage() {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    document.body.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(THEME.BG);
    scene.fog = new THREE.Fog(THEME.BG, THEME.FOG_NEAR, THEME.FOG_FAR);

    const camera = new THREE.PerspectiveCamera(CAMERA.FOV, innerWidth / innerHeight, 0.1, 200);
    camera.position.set(0, CAMERA.HEIGHT, -CAMERA.BACK);

    scene.add(new THREE.HemisphereLight(0xdfefff, 0x0c2033, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(-8, 16, -6);
    scene.add(sun);

    return {
      renderer,
      scene,
      camera,
      render: () => renderer.render(scene, camera),
      resize: () => {
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(innerWidth, innerHeight);
      },
    };
  };
})(window.RallyOne = window.RallyOne || {});
