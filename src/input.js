/**
 * キーボード／ポインタ入力。
 * KeyboardEvent.key ではなく code で見る：key は Shift 併用で 'a' → 'A' に変わるため、
 * keydown('a') と keyup('A') が食い違って「キーが押しっぱなし」になる。
 */
(function (RallyOne) {
  'use strict';

  const MOVE_LEFT = ['ArrowLeft', 'KeyA'];
  const MOVE_RIGHT = ['ArrowRight', 'KeyD'];
  const MOVE_UP = ['ArrowUp', 'KeyW'];
  const MOVE_DOWN = ['ArrowDown', 'KeyS'];
  const LOB = ['ShiftLeft', 'ShiftRight'];
  const SWING = ['Space'];
  /** ブラウザのスクロールを止めたいキー */
  const SWALLOW = MOVE_LEFT.concat(MOVE_RIGHT, MOVE_UP, MOVE_DOWN, SWING);

  class Input {
    constructor() {
      this.held = new Set();
    }

    /**
     * @param {{onStart:Function, onStartDoubles:Function, onSwing:Function, isStarted:Function}} handlers
     */
    attach(handlers) {
      addEventListener('keydown', (e) => {
        if (SWALLOW.indexOf(e.code) !== -1) e.preventDefault();
        if (e.repeat) return;
        this.held.add(e.code);
        if (!handlers.isStarted()) {
          if (e.code === 'KeyD') handlers.onStartDoubles();
          else handlers.onStart();
        } else if (SWING.indexOf(e.code) !== -1) {
          handlers.onSwing();
        }
      });

      addEventListener('keyup', (e) => this.held.delete(e.code));
      // ウィンドウを離れている間の keyup は届かないので、戻ったときに押下状態を捨てる
      addEventListener('blur', () => this.held.clear());

      addEventListener('pointerdown', () => {
        if (!handlers.isStarted()) handlers.onStart();
        else handlers.onSwing();
      });
    }

    any(codes) {
      return codes.some((c) => this.held.has(c));
    }

    /** 画面基準。-1 = 左, 0 = なし, 1 = 右（world の x へ渡すときは game.js で反転する） */
    get moveX() {
      return (this.any(MOVE_RIGHT) ? 1 : 0) - (this.any(MOVE_LEFT) ? 1 : 0);
    }

    /** -1 = 後ろ, 0 = なし, 1 = 前 */
    get moveZ() {
      return (this.any(MOVE_UP) ? 1 : 0) - (this.any(MOVE_DOWN) ? 1 : 0);
    }

    get lob() {
      return this.any(LOB);
    }
  }

  RallyOne.Input = Input;
})(window.RallyOne = window.RallyOne || {});
