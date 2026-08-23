/** ボール、擬似影（ブロブ）、直近1打の軌跡。 */
(function (RallyOne) {
  'use strict';

  const { PHYSICS, THEME, TRAIL } = RallyOne.config;
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

  /** 打点にパッと出て一瞬で消える着弾フラッシュ。「当たった」ことを一目で伝える。 */
  scene3d.createImpactFlash = function createImpactFlash() {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(PHYSICS.BALL_R, 12, 10),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
      }),
    );
    mesh.visible = false;
    return mesh;
  };

  /**
   * その打球の演出の総時間。溜めた強打ほど長く残る（game.js が ball.impact に
   * 同じ倍率をかけて入れているので、正規化にも同じ式を使う）。
   */
  function impactDuration(ball, fx) {
    const power = ball.impactPower || 0;
    return fx.IMPACT_DURATION * (1 + (fx.CHARGE_TIME_BOOST - 1) * power);
  }

  /** 残り時間を 1(打った瞬間)→0(消える) に正規化する */
  function impactProgress(ball, fx) {
    return ball.impact > 0 ? Math.min(ball.impact / impactDuration(ball, fx), 1) : 0;
  }

  /**
   * @param {THREE.Mesh} flash
   * @param {object} ball
   * @param {object} fx RallyOne.config.FX
   */
  scene3d.placeImpact = function placeImpact(flash, ball, fx) {
    const t = impactProgress(ball, fx);
    if (t <= 0) {
      flash.visible = false;
      return;
    }
    const power = ball.impactPower || 0;
    // 溜めた強打ほど大きく弾ける
    const boost = 1 + (fx.CHARGE_FLASH_BOOST - 1) * power;
    flash.visible = true;
    flash.position.set(ball.x, ball.y, ball.z);
    // 最初から目立つ大きさで出て、さらに膨らみながら消えていく
    const grow = fx.FLASH_START_SCALE + (1 - t) * (fx.FLASH_SCALE - fx.FLASH_START_SCALE);
    flash.scale.setScalar(grow * boost);
    flash.material.opacity = t * 0.9;
  };

  /** 打点でボール本体も一瞬だけ膨らませ、当たった衝撃を強調する（t=1＝打った瞬間が最大） */
  scene3d.applyImpactPunch = function applyImpactPunch(ballMesh, ball, fx) {
    const t = impactProgress(ball, fx);
    const power = ball.impactPower || 0;
    const peak = fx.IMPACT_SCALE * (1 + (fx.CHARGE_FLASH_BOOST - 1) * power * 0.5);
    const punch = 1 + t * t * (peak - 1); // 出た直後が一番大きく、すぐ戻る
    ballMesh.scale.setScalar(punch);
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

  /**
   * ラリー中の直近1打の軌跡。点数が毎フレーム変わる（伸びる／描き直る）ので、
   * TRAIL.MAX_POINTS 分の頂点を先に確保しておき、setDrawRange() で実際に使う分だけ描く
   * （フレームごとに geometry を作り直さない）。
   */
  scene3d.createTrail = function createTrail() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL.MAX_POINTS * 3), 3));
    geometry.setDrawRange(0, 0);
    const mesh = new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color: THEME.BALL, transparent: true, opacity: TRAIL.OPACITY,
    }));
    mesh.frustumCulled = false; // 点の数に応じて境界が変わるため、簡易に無効化しておく
    mesh.visible = false;
    return mesh;
  };

  /**
   * @param {{x:number,y:number,z:number}[]} points ラリー中は呼び出し側が空配列を渡して
   *   非表示にする（world.js 参照）。その間は pointCount 比較に触れないため、次に本物の
   *   配列が渡ってきたとき、たまたま前のラリーと同じ点数だと更新をスキップしてしまう
   *   （＝古いラリーの軌跡が残り続ける）。resetTrail() は毎回新しい配列を作るので、
   *   参照が変わったかどうかも合わせて見ることで、点数の偶然の一致による更新漏れを防ぐ。
   */
  scene3d.updateTrail = function updateTrail(mesh, points) {
    if (points.length < 2) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    if (mesh.userData.trailRef !== points || mesh.userData.pointCount !== points.length) {
      const position = mesh.geometry.attributes.position;
      for (let i = 0; i < points.length; i++) {
        position.setXYZ(i, points[i].x, points[i].y, points[i].z);
      }
      position.needsUpdate = true;
      mesh.geometry.setDrawRange(0, points.length);
      mesh.userData.trailRef = points;
      mesh.userData.pointCount = points.length;
    }
  };
})(window.RallyOne = window.RallyOne || {});
