/**
 * 会場のスコアボード（エンドのスタンドの上に立つ電光掲示板）。表示側のみ。
 * 中身は main.js が整えた表示用のスコア（world.setScoreboard）を、CanvasTexture に描くだけ。
 * 寸法・色は config.SCOREBOARD。
 */
(function (RallyOne) {
  'use strict';

  const { SCOREBOARD } = RallyOne.config;
  const scene3d = RallyOne.scene = RallyOne.scene || {};

  const SIDES = ['you', 'cpu'];

  /**
   * スコアの盤面を描く。
   * @param {CanvasRenderingContext2D} g
   * @param {{names:{you:string,cpu:string}, sets:{you:number,cpu:number}[], games:{you:number,cpu:number},
   *   points:{you:string,cpu:string}, server:'you'|'cpu'}} score
   */
  function draw(g, score) {
    const { W, H } = SCOREBOARD.CANVAS;
    const C = SCOREBOARD.COLORS;
    g.fillStyle = C.BG;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = C.FRAME;
    g.lineWidth = 10;
    g.strokeRect(5, 5, W - 10, H - 10);
    if (!score) return;
    const rowH = (H - 40) / 2;
    const pointsX = W - 70;
    const gamesX = pointsX - 130;
    g.textBaseline = 'middle';
    SIDES.forEach((side, i) => {
      const y = 20 + rowH * (i + 0.5);
      if (score.server === side) {
        g.fillStyle = C.SERVE;
        g.beginPath();
        g.arc(42, y, 11, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = C.TEXT;
      g.textAlign = 'left';
      g.font = 'bold 52px sans-serif';
      g.fillText(score.names[side], 72, y, gamesX - 90 - score.sets.length * 64 - 72);
      // 決まったセットのゲーム数（取った側を明るく）
      g.font = 'bold 50px sans-serif';
      g.textAlign = 'center';
      score.sets.forEach((set, k) => {
        const other = side === 'you' ? 'cpu' : 'you';
        g.fillStyle = set[side] > set[other] ? C.TEXT : C.DIM;
        g.fillText(String(set[side]), gamesX - 90 - (score.sets.length - 1 - k) * 64, y);
      });
      g.fillStyle = C.TEXT;
      g.font = 'bold 64px sans-serif';
      g.fillText(String(score.games[side]), gamesX, y);
      g.fillStyle = C.POINT;
      g.fillText(score.points[side], pointsX, y);
    });
  }

  /**
   * スコアボード2枚（SCOREBOARD.SPOTS）。会場（venue）に入れる＝チェンジエンズで会場と一緒に回る。
   * @returns {{group:THREE.Group, set:Function}}
   */
  scene3d.createScoreboards = function createScoreboards() {
    const { W, H } = SCOREBOARD.CANVAS;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    draw(g, null);
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding; // 盤面の色を指定どおりに出す（flags.js と同じ）
    const group = new THREE.Group();
    const frameMat = new THREE.MeshLambertMaterial({ color: SCOREBOARD.COLORS.FRAME });
    SCOREBOARD.SPOTS.forEach(({ x, z }) => {
      const spot = new THREE.Group();
      spot.position.set(x, 0, z);
      spot.rotation.y = z > 0 ? Math.PI : 0; // 盤面をコートへ向ける
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(SCOREBOARD.W, SCOREBOARD.H),
        new THREE.MeshBasicMaterial({ map: texture }),
      );
      face.position.y = SCOREBOARD.Y;
      face.position.z = 0.16; // 筐体の前面
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(SCOREBOARD.W + 0.3, SCOREBOARD.H + 0.3, 0.3),
        frameMat,
      );
      box.position.y = SCOREBOARD.Y;
      const postH = SCOREBOARD.Y - SCOREBOARD.H / 2;
      [-1, 1].forEach((s) => {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(SCOREBOARD.POST_W, postH, SCOREBOARD.POST_W),
          frameMat,
        );
        post.position.set(s * SCOREBOARD.W * 0.35, postH / 2, -0.1);
        spot.add(post);
      });
      spot.add(box, face);
      group.add(spot);
    });
    let lastKey = '';

    /** 表示するスコアを変える（中身が変わったときだけ描き直す）。 */
    function set(score) {
      const key = JSON.stringify(score);
      if (key === lastKey) return;
      lastKey = key;
      draw(g, score);
      texture.needsUpdate = true;
    }

    return { group, set };
  };
})(window.RallyOne = window.RallyOne || {});
