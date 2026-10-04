/**
 * 観客。スタンドの壁（STANDS、court.js#createStands）の上に、簡易な人型を
 * ひな壇状に並べる。ゲームロジックには一切関与しない。
 * 壁4枚ぶんで数百体になり得るため、1体ずつ Mesh を作らず InstancedMesh 3つ
 * （胴・頭・腕）だけで描く（world.js が起動時に1回だけシーンへ追加する）。
 * ふだんは座ったまま動かない。盛り上がり（hype、updateCrowd()）が乗っている間だけ、
 * 立ち上がって跳ねたり両手を振ったりし、客席のあちこちでカメラのフラッシュが光る
 * （マッチポイントの演出と、試合が決まってからスタッツ画面が出るまで。MATCH_POINT.CROWD）。
 */
(function (RallyOne) {
  'use strict';

  const {
    STANDS, SPECTATORS, THEME, MATCH_POINT,
  } = RallyOne.config;
  const { rand } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  // 人型の寸法（観客1人ぶんの大きさ＝1 のとき。実際は人ごとの scale を掛ける）
  const TORSO = { W: 0.34, H: 0.5, D: 0.28, Y: 0.26 }; // Y＝座面から胴の中心まで
  const HEAD = { R: 0.14, Y: 0.54 };
  const ARM = { W: 0.09, L: 0.42, X: TORSO.W / 2 + 0.045, Y: 0.47 }; // X/Y＝肩の位置

  /** コート中心（原点付近）へ体を向ける回転(rad)。officials.js の faceInward() と同じ考え方。 */
  function faceInward(x, z) {
    return Math.atan2(-x, -z);
  }

  /** 壁1枚ぶんの観客席の座標を、ひな壇（ROWS段）ぶん列挙する。 */
  function seatsForWall({ axis, fixed, span }) {
    const seats = [];
    const halfSpan = span / 2 - SPECTATORS.EDGE_MARGIN;
    const count = Math.max(1, Math.floor((halfSpan * 2) / SPECTATORS.SEAT_SPACING));
    const outSign = Math.sign(fixed) || 1;

    for (let row = 0; row < SPECTATORS.ROWS; row++) {
      const outward = STANDS.THICKNESS / 2 + SPECTATORS.ROW_GAP * (row + 1);
      const y = STANDS.HEIGHT + SPECTATORS.ROW_RISE * row;
      for (let i = 0; i < count; i++) {
        const along = -halfSpan + (i + 0.5) * ((halfSpan * 2) / count)
          + (Math.random() - 0.5) * SPECTATORS.JITTER_ALONG;
        const x = axis === 'x' ? along : fixed + outSign * outward;
        const z = axis === 'x' ? fixed + outSign * outward : along;
        seats.push({ x, y: y + (Math.random() - 0.5) * SPECTATORS.JITTER_UP, z });
      }
    }
    return seats;
  }

  /** 光が丸くにじむ点のテクスチャ（フラッシュ用。中心が白く、外へ向かって透ける）。 */
  function flashTexture() {
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(cv);
  }

  /** カメラのフラッシュ（光る点の束）。光っていない点は色を黒にする＝加算合成で見えない。 */
  function createFlashes() {
    const F = MATCH_POINT.CROWD.FLASH;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(F.POOL * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(F.POOL * 3), 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: F.SIZE,
      map: flashTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    points.frustumCulled = false; // 光る位置が毎回変わる（境界球を作り直さない）
    points.userData.life = new Float32Array(F.POOL);
    return points;
  }

  /** @returns {THREE.Group} InstancedMesh(胴・頭・腕) とフラッシュをまとめたグループ */
  scene3d.createCrowd = function createCrowd() {
    const C = MATCH_POINT.CROWD;
    const seats = STANDS.WALLS.flatMap(seatsForWall);
    const count = seats.length;

    const torsos = new THREE.InstancedMesh(
      new THREE.BoxGeometry(TORSO.W, TORSO.H, TORSO.D),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      count,
    );
    const heads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(HEAD.R, 8, 6),
      new THREE.MeshLambertMaterial({ color: THEME.SKIN }),
      count,
    );
    // 腕は肩を原点にして下へ垂らす（肩を中心に振り上げられるように）
    const armGeometry = new THREE.BoxGeometry(ARM.W, ARM.L, ARM.W);
    armGeometry.translate(0, -ARM.L / 2, 0);
    const arms = new THREE.InstancedMesh(
      armGeometry,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      count * 2,
    );
    // InstancedMesh の視錐台カリングは元の形（原点付近の小さな箱）で判定されるので、原点が
    // 画面外になる向き（マッチポイントの演出で客席だけを映すとき）だと全員が消えてしまう。
    [torsos, heads, arms].forEach((mesh) => { mesh.frustumCulled = false; });

    const color = new THREE.Color();
    const people = seats.map((seat, i) => {
      color.set(SPECTATORS.SHIRTS[Math.floor(Math.random() * SPECTATORS.SHIRTS.length)]);
      torsos.setColorAt(i, color);
      arms.setColorAt(i * 2, color); // 袖＝シャツと同じ色
      arms.setColorAt(i * 2 + 1, color);
      return {
        ...seat,
        scale: SPECTATORS.SCALE + Math.random() * SPECTATORS.SCALE_JITTER,
        rotY: faceInward(seat.x, seat.z),
        // 盛り上がり方の個性：跳ねるか手を振るか、速さ・位相・腕の上げ方
        jumper: Math.random() < C.JUMPERS,
        hz: rand(C.HZ[0], C.HZ[1]),
        phase: Math.random() * Math.PI * 2,
        reach: 1 - Math.random() * C.ARM_SPREAD,
      };
    });
    if (torsos.instanceColor) torsos.instanceColor.needsUpdate = true;
    if (arms.instanceColor) arms.instanceColor.needsUpdate = true;

    const flashes = createFlashes();
    const group = new THREE.Group();
    group.add(torsos, heads, arms, flashes);
    group.userData.crowd = {
      torsos, heads, arms, flashes, people, clock: 0, posedHype: -1,
    };
    poseCrowd(group.userData.crowd, 0);
    return group;
  };

  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ'; // 体の向き(Y)を最後に掛ける＝腕の振り上げ(Z)は体から見た向き

  /**
   * 全員の姿勢を hype（0〜1）のぶんだけ盛り上がった形にする。0 なら座ったまま両手を下ろす。
   * 立ち上がるのは胴を縦に伸ばして見せ（脚は作っていない。浮かせると座面との間に隙間が
   * 見える）、跳ねる人は体ごと上下させる。
   */
  function poseCrowd(crowd, hype) {
    const C = MATCH_POINT.CROWD;
    const t = crowd.clock;
    crowd.people.forEach((p, i) => {
      const s = p.scale;
      const beat = Math.sin(t * p.hz * Math.PI * 2 + p.phase);
      const stand = hype * C.STAND_UP;
      const hop = p.jumper ? hype * C.JUMP * Math.max(0, beat) : 0;
      const stretch = 1 + stand / TORSO.H;
      const base = p.y + hop * s;

      dummy.position.set(p.x, base + (TORSO.Y + stand / 2) * s, p.z);
      dummy.rotation.set(0, p.rotY, 0);
      dummy.scale.set(s, s * stretch, s);
      dummy.updateMatrix();
      crowd.torsos.setMatrixAt(i, dummy.matrix);

      dummy.position.y = base + (HEAD.Y + stand) * s;
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      crowd.heads.setMatrixAt(i, dummy.matrix);

      // 腕：跳ねる人は振り上げたまま拍子に合わせて少し揺らし、手を振る人は大きく左右に振る
      const wave = p.jumper ? 0.4 * C.WAVE * beat : C.WAVE * beat;
      const lift = hype * (C.ARM_UP * p.reach + wave);
      const cos = Math.cos(p.rotY);
      const sin = Math.sin(p.rotY);
      [1, -1].forEach((side, k) => {
        const sx = side * ARM.X * s;
        dummy.position.set(p.x + sx * cos, base + (ARM.Y + stand) * s, p.z - sx * sin);
        dummy.rotation.set(0, p.rotY, side * lift);
        dummy.updateMatrix();
        crowd.arms.setMatrixAt(i * 2 + k, dummy.matrix);
      });
    });
    crowd.torsos.instanceMatrix.needsUpdate = true;
    crowd.heads.instanceMatrix.needsUpdate = true;
    crowd.arms.instanceMatrix.needsUpdate = true;
    crowd.posedHype = hype;
  }

  /** フラッシュを光らせ、光っている分を消していく。hype が高いほどよく光る。 */
  function updateFlashes(crowd, hype, dt) {
    const F = MATCH_POINT.CROWD.FLASH;
    const points = crowd.flashes;
    const life = points.userData.life;
    const pos = points.geometry.attributes.position;
    const col = points.geometry.attributes.color;
    let spawn = hype * F.RATE * dt;
    let changed = false;
    for (let i = 0; i < F.POOL; i++) {
      if (life[i] > 0) {
        life[i] = Math.max(0, life[i] - dt);
        const v = life[i] / F.LIFE;
        col.setXYZ(i, v, v, v);
        changed = true;
      } else if (spawn > 0 && Math.random() < spawn) {
        // 端数は確率で：1フレームに平均 spawn 個ずつ光る
        spawn -= 1;
        const p = crowd.people[Math.floor(Math.random() * crowd.people.length)];
        const out = F.FORWARD * p.scale;
        pos.setXYZ(i, p.x + Math.sin(p.rotY) * out,
          p.y + (HEAD.Y + MATCH_POINT.CROWD.STAND_UP) * p.scale, p.z + Math.cos(p.rotY) * out);
        col.setXYZ(i, 1, 1, 1);
        life[i] = F.LIFE;
        changed = true;
      }
    }
    if (changed) {
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }
  }

  /**
   * 毎フレーム world.js から呼ぶ。hype（0〜1）は盛り上がりの度合い（マッチポイントの演出中に
   * 上がり、終わると収まる）。0 のまま変わらない間は何もしない（座ったまま動かない）。
   * @param {THREE.Group} group createCrowd() の戻り値
   * @param {number} hype
   * @param {number} dt
   */
  scene3d.updateCrowd = function updateCrowd(group, hype, dt) {
    const crowd = group.userData.crowd;
    crowd.clock += dt;
    if (hype > 0 || crowd.posedHype !== 0) poseCrowd(crowd, hype);
    updateFlashes(crowd, hype, dt);
  };
})(window.RallyOne = window.RallyOne || {});
