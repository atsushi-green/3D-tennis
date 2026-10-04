/**
 * 審判台・主審・線審・ボールボーイ。ゲームロジックには一切関与しない装飾用メッシュで、
 * 当たり判定も持たない。world.js が起動時に1回だけ createOfficials() をシーンへ追加する。
 * 動くのは線審の腕だけ（コールの合図。setLineJudgePose()）。
 */
(function (RallyOne) {
  'use strict';

  const { OFFICIALS, THEME, LINE_CALL } = RallyOne.config;
  const { clamp, lerp } = RallyOne.math;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  /** 腕を下ろしているときの、体から外へ開く角度(rad)。 */
  const ARM_REST_Z = 0.12;

  /** ズボン（脚）の色。 */
  const TROUSERS = 0x1c2531;

  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });

  /**
   * 主審・線審・ボールボーイに共通の簡易な人型（胴＋頭＋腕2本＋脚2本）。
   * @param {{uniform:number, scale?:number, seated?:boolean}} opts seated＝椅子に座る主審用。
   *   原点が座面になり、脚は太ももを前へ水平に出して膝から下を垂らす。
   *   userData.lap に膝の前後位置と足裏の高さ（審判台が足置きを合わせる）。
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

    // 腕は肩を支点に回せるよう、肩の位置に置いた空の Group の下に吊るす（線審の合図で回す）。
    // 並びは [体の -x 側, +x 側]。
    const armLen = 0.42 * scale;
    const arms = [-1, 1].map((side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.2 * scale, torso.position.y + 0.06 * scale + armLen / 2, 0);
      shoulder.rotation.z = side * ARM_REST_Z;
      const arm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04 * scale, 0.035 * scale, armLen, 8),
        mat(uniform),
      );
      arm.position.y = -armLen / 2;
      shoulder.add(arm);
      group.add(shoulder);
      return shoulder;
    });
    group.userData.arms = arms;

    if (!seated) {
      [-1, 1].forEach((side) => {
        const leg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.055 * scale, 0.05 * scale, 0.7 * scale, 8),
          mat(TROUSERS),
        );
        leg.position.set(side * 0.08 * scale, 0.35 * scale, 0);
        group.add(leg);
      });
    } else {
      // 座った脚：太ももは股関節から前（+z）へ水平に、すねは膝から真下へ。足は靴の箱を置く
      const hipY = 0.07 * scale;
      const thighLen = 0.4 * scale;
      const shinLen = 0.42 * scale;
      const footH = 0.06 * scale;
      [-1, 1].forEach((side) => {
        const x = side * 0.09 * scale;
        const thigh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.065 * scale, 0.055 * scale, thighLen, 8),
          mat(TROUSERS),
        );
        thigh.rotation.x = -Math.PI / 2; // 円柱の軸（+y）を -z へ倒す＝太い上端が股関節側
        thigh.position.set(x, hipY, thighLen / 2);
        const shin = new THREE.Mesh(
          new THREE.CylinderGeometry(0.05 * scale, 0.045 * scale, shinLen, 8),
          mat(TROUSERS),
        );
        shin.position.set(x, hipY - shinLen / 2, thighLen);
        const foot = new THREE.Mesh(
          new THREE.BoxGeometry(0.1 * scale, footH, 0.2 * scale),
          mat(TROUSERS),
        );
        foot.position.set(x, hipY - shinLen - footH / 2, thighLen + 0.05 * scale);
        group.add(thigh, shin, foot);
      });
      group.userData.lap = { kneeZ: thighLen, soleY: hipY - shinLen - footH };
    }

    return group;
  }

  /** コート中心（原点付近）へ体を向ける回転(rad)。線審・ボールボーイの向きに使う。 */
  function faceInward(x, z) {
    return Math.atan2(-x, -z);
  }

  /**
   * 主審が座る審判台。脚・座面・背もたれ・足置き・昇降用ステップ＋座った主審を1グループに
   * まとめる。+z が正面（コート側）。座面は奥側だけにして、主審はその前の縁から膝を出し、
   * すねを一段下の足置きへ垂らす（実際の審判台と同じ作り）。前の脚は足置きの高さまで。
   */
  function createUmpireChair() {
    const { CHAIR } = OFFICIALS;
    const group = new THREE.Group();
    const fp = CHAIR.FOOTPRINT;
    const width = fp * 2 + 0.15;
    const rear = -fp - 0.075; // 座面・足置きの奥の縁
    const front = fp + 0.075; // 足置きの手前の縁

    const umpire = createFigure({ uniform: THEME.OFFICIAL_UNIFORM, seated: true });
    umpire.position.set(0, CHAIR.HEIGHT + 0.04, -fp + CHAIR.SIT_BACK);
    const { kneeZ, soleY } = umpire.userData.lap;
    const footrestY = umpire.position.y + soleY - 0.02; // 足置きの板の中心（厚み0.04の上面に足裏が乗る）

    [[-fp, -fp, CHAIR.HEIGHT], [fp, -fp, CHAIR.HEIGHT], [-fp, fp, footrestY], [fp, fp, footrestY]]
      .forEach(([lx, lz, h]) => {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, h, 8), mat(THEME.UMPIRE_CHAIR));
        leg.position.set(lx, h / 2, lz);
        group.add(leg);
      });

    const seatFront = rear + CHAIR.SEAT_DEPTH;
    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.08, CHAIR.SEAT_DEPTH),
      mat(THEME.UMPIRE_CHAIR),
    );
    seat.position.set(0, CHAIR.HEIGHT, (rear + seatFront) / 2);
    group.add(seat);
    // 座面の前の縁を足置きから支える柱（左右の端。主審の脚とは重ならない）
    [-fp, fp].forEach((lx) => {
      const h = CHAIR.HEIGHT - footrestY;
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, h, 8), mat(THEME.UMPIRE_CHAIR));
      strut.position.set(lx, footrestY + h / 2, seatFront - 0.045);
      group.add(strut);
    });

    const back = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.5, 0.06),
      mat(THEME.UMPIRE_CHAIR),
    );
    back.position.set(0, CHAIR.HEIGHT + 0.29, -fp);
    group.add(back);

    // 足置き：膝の少し手前から正面の縁まで（座面の真下の奥側は空けておく）
    const restBack = umpire.position.z + kneeZ - 0.15;
    const footrest = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.04, front - restBack),
      mat(THEME.UMPIRE_CHAIR),
    );
    footrest.position.set(0, footrestY, (restBack + front) / 2);
    group.add(footrest);

    // 昇降用ステップ：足置きまでを3等分した2段（いちばん上の段は足置きそのもの）
    for (let i = 1; i <= 2; i++) {
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(fp * 1.6, 0.03, 0.14),
        mat(THEME.UMPIRE_CHAIR),
      );
      step.position.set(0, (i * footrestY) / 3, fp + 0.05);
      group.add(step);
    }

    group.add(umpire);

    group.position.set(CHAIR.X, 0, CHAIR.Z);
    group.rotation.y = faceInward(CHAIR.X, CHAIR.Z);
    return group;
  }

  /**
   * 線審。userData.lineJudges に、合図を出させるための情報（担当の線・会場の座標・腕）を
   * 並べておく（world.js の pickLineJudge() が担当を選び、setLineJudgePose() が腕を動かす）。
   * BASE はそれぞれ自分の側のベースライン、SIDE は自分の側のサイドラインと、自分のいる半面の
   * サービスライン・センターサービスラインを受け持つ。
   */
  function createLineJudges() {
    const group = new THREE.Group();
    const judges = [];
    const add = (role) => ({ x, z }) => {
      const judge = createFigure({ uniform: THEME.OFFICIAL_UNIFORM });
      judge.position.set(x, 0, z);
      judge.rotation.y = faceInward(x, z);
      group.add(judge);
      judges.push({ role, x, z, facing: judge.rotation.y, arms: judge.userData.arms });
    };
    OFFICIALS.LINE.BASE.forEach(add('base'));
    OFFICIALS.LINE.SIDE.forEach(add('side'));
    group.userData.lineJudges = judges;
    return group;
  }

  /**
   * 線審の腕の構え。w＝合図の出し具合（0＝下ろしている〜1＝出しきった）。
   * - 'out'/'fault'：会場の座標での向き dir（線から外へ）を指して、その側の腕を水平に伸ばす
   * - 'safe'：両腕を体の前へ出し、手を寄せて下向きにそろえる
   * 腕の Euler は既定の XYZ 順＝下げた腕をまず z で開き、y で水平に振り、x で前へ出す。
   * @param {{facing:number, arms:THREE.Group[]}} judge
   * @param {'out'|'fault'|'safe'|null} kind
   * @param {{x:number, z:number}} [dir]
   * @param {number} w
   */
  function setLineJudgePose(judge, kind, dir, w) {
    const pose = [-1, 1].map((side) => ({ x: 0, y: 0, z: side * ARM_REST_Z }));
    if (kind === 'safe') {
      [-1, 1].forEach((side, i) => {
        pose[i] = { x: LINE_CALL.SAFE_ARM_PITCH, y: 0, z: -side * LINE_CALL.SAFE_ARM_IN };
      });
    } else if (kind && dir) {
      // 会場の向き → この線審の体の向き（+z が正面）へ回す
      const c = Math.cos(judge.facing);
      const s = Math.sin(judge.facing);
      const lx = dir.x * c - dir.z * s;
      const lz = dir.x * s + dir.z * c;
      const side = lx >= 0 ? 1 : -1;
      const yaw = clamp(Math.atan2(-side * lz, side * lx), -LINE_CALL.ARM_YAW_MAX, LINE_CALL.ARM_YAW_MAX);
      pose[side > 0 ? 1 : 0] = { x: 0, y: yaw, z: side * Math.PI / 2 };
    }
    judge.arms.forEach((arm, i) => {
      const rest = (i === 0 ? -1 : 1) * ARM_REST_Z;
      arm.rotation.set(lerp(0, pose[i].x, w), lerp(0, pose[i].y, w), lerp(rest, pose[i].z, w));
    });
  }
  scene3d.setLineJudgePose = setLineJudgePose;

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

  /**
   * @returns {THREE.Group} 審判台＋主審＋線審＋ボールボーイ一式。world.js が1回だけシーンへ追加する。
   *   userData.lineJudges に線審の一覧（createLineJudges() 参照）。
   */
  scene3d.createOfficials = function createOfficials() {
    const group = new THREE.Group();
    const lineJudges = createLineJudges();
    group.add(createUmpireChair(), lineJudges, createBallKids());
    group.userData.lineJudges = lineJudges.userData.lineJudges;
    return group;
  };
})(window.RallyOne = window.RallyOne || {});
