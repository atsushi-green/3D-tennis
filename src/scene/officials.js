/**
 * 審判台・主審・線審・ボールボーイ。すべて静止した装飾用メッシュで、ゲームロジックには
 * 一切関与しない（試合中に動かず、当たり判定も持たない）。world.js が起動時に1回だけ
 * createOfficials() をシーンへ追加する。
 */
(function (RallyOne) {
  'use strict';

  const { OFFICIALS, THEME } = RallyOne.config;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

  /**
   * 主審・線審・ボールボーイに共通の簡易な人型（胴＋頭＋腕2本＋脚2本）。
   * @param {{uniform:number, scale?:number, seated?:boolean}} opts seated＝椅子に座る主審用。脚を省く。
   */
  function createFigure({ uniform, scale = 1, seated = false }) {
    const group = new THREE.Group();
    const torsoH = (seated ? 0.5 : 0.62) * scale;

    const torso = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16 * scale, 0.19 * scale, torsoH, 10),
      mat(uniform),
    );
    torso.position.y = torsoH / 2 + (seated ? 0 : 0.7 * scale);
    group.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13 * scale, 14, 10), mat(THEME.SKIN));
    head.position.y = torso.position.y + torsoH / 2 + 0.13 * scale;
    group.add(head);

    [-1, 1].forEach((side) => {
      const arm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04 * scale, 0.035 * scale, 0.42 * scale, 8),
        mat(uniform),
      );
      arm.position.set(side * 0.2 * scale, torso.position.y + 0.06 * scale, 0);
      arm.rotation.z = side * 0.12;
      group.add(arm);
    });

    if (!seated) {
      [-1, 1].forEach((side) => {
        const leg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.055 * scale, 0.05 * scale, 0.7 * scale, 8),
          mat(0x1c2531),
        );
        leg.position.set(side * 0.08 * scale, 0.35 * scale, 0);
        group.add(leg);
      });
    }

    return group;
  }

  /** コート中心（原点付近）へ体を向ける回転(rad)。線審・ボールボーイの向きに使う。 */
  function faceInward(x, z) {
    return Math.atan2(-x, -z);
  }

  /** 主審が座る審判台。脚・座面・背もたれ・昇降用ステップ＋座った主審を1グループにまとめる。 */
  function createUmpireChair() {
    const { CHAIR } = OFFICIALS;
    const group = new THREE.Group();
    const fp = CHAIR.FOOTPRINT;

    [[-fp, -fp], [fp, -fp], [-fp, fp], [fp, fp]].forEach(([lx, lz]) => {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, CHAIR.HEIGHT, 8),
        mat(THEME.UMPIRE_CHAIR),
      );
      leg.position.set(lx, CHAIR.HEIGHT / 2, lz);
      group.add(leg);
    });

    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(fp * 2 + 0.15, 0.08, fp * 2 + 0.15),
      mat(THEME.UMPIRE_CHAIR),
    );
    seat.position.y = CHAIR.HEIGHT;
    group.add(seat);

    const back = new THREE.Mesh(
      new THREE.BoxGeometry(fp * 2 + 0.15, 0.5, 0.06),
      mat(THEME.UMPIRE_CHAIR),
    );
    back.position.set(0, CHAIR.HEIGHT + 0.29, -fp);
    group.add(back);

    for (let i = 1; i <= 3; i++) {
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(fp * 1.6, 0.03, 0.14),
        mat(THEME.UMPIRE_CHAIR),
      );
      step.position.set(0, (i * CHAIR.HEIGHT) / 4, fp + 0.05);
      group.add(step);
    }

    const umpire = createFigure({ uniform: THEME.OFFICIAL_UNIFORM, seated: true });
    umpire.position.y = CHAIR.HEIGHT + 0.08;
    group.add(umpire);

    group.position.set(CHAIR.X, 0, CHAIR.Z);
    group.rotation.y = faceInward(CHAIR.X, CHAIR.Z);
    return group;
  }

  function createLineJudges() {
    const group = new THREE.Group();
    [...OFFICIALS.LINE.BASE, ...OFFICIALS.LINE.SIDE].forEach(({ x, z }) => {
      const judge = createFigure({ uniform: THEME.OFFICIAL_UNIFORM });
      judge.position.set(x, 0, z);
      judge.rotation.y = faceInward(x, z);
      group.add(judge);
    });
    return group;
  }

  function createBallKids() {
    const { BALLKID } = OFFICIALS;
    const group = new THREE.Group();
    [...BALLKID.NET, ...BALLKID.CORNER].forEach(({ x, z }) => {
      const kid = createFigure({ uniform: THEME.BALLKID_SHIRT, scale: BALLKID.SCALE });
      kid.position.set(x, 0, z);
      kid.rotation.y = faceInward(x, z);
      group.add(kid);
    });
    return group;
  }

  /** @returns {THREE.Group} 審判台＋主審＋線審＋ボールボーイ一式。world.js が1回だけシーンへ追加する。 */
  scene3d.createOfficials = function createOfficials() {
    const group = new THREE.Group();
    group.add(createUmpireChair(), createLineJudges(), createBallKids());
    return group;
  };
})(window.RallyOne = window.RallyOne || {});
