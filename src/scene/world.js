/**
 * 3D 表示の組み立てと、ゲーム状態 → メッシュへの反映。
 * ここはゲームの状態を読むだけで、書き換えない（ロジックは game.js のみが持つ）。
 */
(function (RallyOne) {
  'use strict';

  const { CAMERA, FX, PLAYER, THEME } = RallyOne.config;
  const { lerp } = RallyOne.math;
  const { predictLanding } = RallyOne.physics;
  const scene3d = RallyOne.scene;

  scene3d.createWorld = function createWorld() {
    const stage = scene3d.createStage();
    const { scene, camera } = stage;

    scene.add(scene3d.createCourt(), scene3d.createNet());

    const you = scene3d.createPlayer(THEME.YOU);
    const cpu = scene3d.createPlayer(THEME.CPU);
    cpu.rotation.y = Math.PI; // CPU は手前を向く
    // ダブルスのパートナー。シングルスでは this.doubles===false の間 sync() で visible=false のまま
    const youMate = scene3d.createPlayer(THEME.YOU);
    const cpuMate = scene3d.createPlayer(THEME.CPU);
    cpuMate.rotation.y = Math.PI;
    const ballMesh = scene3d.createBall();
    const shadows = {
      ball: scene3d.createShadow(0.34),
      you: scene3d.createShadow(0.26),
      cpu: scene3d.createShadow(0.26),
      youMate: scene3d.createShadow(0.26),
      cpuMate: scene3d.createShadow(0.26),
    };
    const marker = scene3d.createMarker();
    const impactFlash = scene3d.createImpactFlash();
    scene.add(
      you, cpu, youMate, cpuMate, ballMesh,
      shadows.ball, shadows.you, shadows.cpu, shadows.youMate, shadows.cpuMate,
      marker, impactFlash,
    );

    addEventListener('resize', stage.resize);

    /** 着地マーカーは「プレイヤーが追うべき球」だけに出す */
    function syncMarker(ball) {
      if (!(ball.live && ball.bounces === 0 && ball.last === 'cpu')) {
        marker.visible = false;
        return;
      }
      const landing = predictLanding(ball);
      marker.visible = !landing.net;
      marker.position.x = landing.x;
      marker.position.z = landing.z;
    }

    function syncCamera(player, dt) {
      const t = Math.min(1, dt * CAMERA.LERP);
      camera.position.x = lerp(camera.position.x, player.x * CAMERA.FOLLOW_X, t);
      camera.position.y = lerp(camera.position.y, CAMERA.HEIGHT, t);
      camera.position.z = lerp(camera.position.z, -CAMERA.BACK, t);
      camera.lookAt(player.x * CAMERA.LOOK_X, CAMERA.LOOK_AT.y, CAMERA.LOOK_AT.z);
    }

    /** プレイヤー1人ぶんの位置・スイング・歩行ポーズと影をまとめて反映する */
    function syncPlayer(mesh, shadow, state, maxSpeed, dt, tossing) {
      mesh.position.set(state.x, 0, state.z);
      scene3d.setSwingPose(mesh, state.anim, state.stroke, !!tossing, state.prep, state.chargeFrac, state.swingCharge);
      scene3d.setGaitPose(mesh, state.speed, maxSpeed, dt);
      scene3d.placeGroundShadow(shadow, state);
    }

    /** @param {{ball:object, you:object, cpu:object, youMate:object, cpuMate:object, doubles:boolean}} state */
    function sync(state, dt) {
      const ball = state.ball;
      const youTossing = state.tossActive === true && state.server === 'you';

      syncPlayer(you, shadows.you, state.you, PLAYER.SPEED, dt, youTossing);
      syncPlayer(cpu, shadows.cpu, state.cpu, PLAYER.CPU_CHASE, dt, false);

      youMate.visible = cpuMate.visible = shadows.youMate.visible = shadows.cpuMate.visible = state.doubles;
      if (state.doubles) {
        syncPlayer(youMate, shadows.youMate, state.youMate, PLAYER.CPU_CHASE, dt, false);
        syncPlayer(cpuMate, shadows.cpuMate, state.cpuMate, PLAYER.CPU_CHASE, dt, false);
      }

      ballMesh.position.set(ball.x, ball.y, ball.z);
      ballMesh.rotation.x += dt * 9;
      ballMesh.rotation.z += dt * 5;
      scene3d.applyImpactPunch(ballMesh, ball, FX);
      scene3d.placeImpact(impactFlash, ball, FX);
      scene3d.placeBallShadow(shadows.ball, ball);

      syncMarker(ball);
      syncCamera(state.you, dt);
    }

    return { sync, render: stage.render, scene, camera };
  };
})(window.RallyOne = window.RallyOne || {});
