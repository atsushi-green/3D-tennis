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
  /**
   * 溜め・スイングのキー（グラウンドストローク・サーブのスピン選択を兼ねる。スマッシュ・
   * ボレー・ロブは対象外、常にフラット）。B/V/C は横並びの3キーで、押している間だけ溜め、
   * 離した瞬間にそのキーに対応するスピンで打つ。Ctrl/Alt はOS・ブラウザのショートカット
   * （macOSのCtrl+←→でSpaces切替、ブラウザのAlt+←→で戻る/進む等）と衝突し矢印キー移動と
   * 同時押しできないため、衝突のない素のキーを充てる。
   * @type {{[code: string]: 'flat'|'top'|'slice'}}
   */
  const SWING = { KeyB: 'flat', KeyV: 'top', KeyC: 'slice' };
  const SWING_CODES = Object.keys(SWING);
  /** ダブルスのAIパートナーへの指示。Q＝ネットへ前へ、E＝ベースラインまで下がれ */
  const FORMATION_NET = ['KeyQ'];
  const FORMATION_BACK = ['KeyE'];
  /** スタート画面でのみ有効。CPU/AIの強さ（Easy/Normal/Hard）を選ぶ */
  const DIFFICULTY_KEYS = { Digit1: 'easy', Digit2: 'normal', Digit3: 'hard' };
  /** スタート画面でのみ有効。コートサーフェス（ハード／クレー／芝）を選ぶ */
  const SURFACE_KEYS = { Digit4: 'hard', Digit5: 'clay', Digit6: 'grass' };
  /** スタート画面でのみ有効。CPU/AIのプレースタイルを選ぶ（強さとは直交） */
  const STYLE_KEYS = {
    Digit7: 'none', Digit8: 'serveAndVolley', Digit9: 'retriever', Digit0: 'aggressiveBaseliner',
  };
  /**
   * トス（コイントス）に勝った人間だけが選ぶ。スタート画面の各種選択が終わった後の
   * 別画面（handlers.isAwaitingToss()）でだけ意味を持つので、Digit1/2 を使い回しても
   * 難易度選択（Digit1〜3）とは表示上・時間軸上で重ならない。
   */
  const TOSS_KEYS = { Digit1: 'serve', Digit2: 'receive' };
  /** ブラウザのスクロールを止めたいキー */
  const SWALLOW = MOVE_LEFT.concat(MOVE_RIGHT, MOVE_UP, MOVE_DOWN, SWING_CODES);

  class Input {
    constructor() {
      this.held = new Set();
      // 溜め始めに使った1つのキー（B/V/C いずれか、またはポインタなら 'Pointer'）。
      // 溜めている間に他の2キーを押しても無視し、この打鍵が離されたときだけ離した扱いにする。
      this.chargeKey = null;
    }

    /**
     * @param {{onStart:Function, onStartDoubles:Function, onChargeStart:Function,
     *   onChargeRelease:Function, onFormationNet:Function, onFormationBack:Function,
     *   onSelectDifficulty:Function, onSelectSurface:Function, onSelectStyle:Function,
     *   onSelectToss:Function, isAwaitingToss:Function,
     *   onAnyKey:Function, isStarted:Function}} handlers
     */
    attach(handlers) {
      addEventListener('keydown', (e) => {
        if (SWALLOW.indexOf(e.code) !== -1) e.preventDefault();
        if (e.repeat) return;
        this.held.add(e.code);
        if (!handlers.isStarted()) {
          if (handlers.isAwaitingToss()) {
            if (TOSS_KEYS[e.code]) handlers.onSelectToss(TOSS_KEYS[e.code]);
            return; // トスの結果待ちの間は、他の開始キーには反応しない
          }
          if (e.code === 'KeyD') handlers.onStartDoubles();
          else if (DIFFICULTY_KEYS[e.code]) handlers.onSelectDifficulty(DIFFICULTY_KEYS[e.code]);
          else if (SURFACE_KEYS[e.code]) handlers.onSelectSurface(SURFACE_KEYS[e.code]);
          else if (STYLE_KEYS[e.code]) handlers.onSelectStyle(STYLE_KEYS[e.code]);
          else handlers.onStart();
          return;
        }
        // ポイント間のリプレイをスキップするための合図。ラリー中の操作にも毎回飛ぶが、
        // リプレイ中でなければ何もしないので実害はない（world.js#skipReplay() 参照）。
        handlers.onAnyKey();
        if (SWING[e.code] && !this.chargeKey) {
          this.chargeKey = e.code;
          handlers.onChargeStart(SWING[e.code]);
        } else if (FORMATION_NET.indexOf(e.code) !== -1) {
          handlers.onFormationNet();
        } else if (FORMATION_BACK.indexOf(e.code) !== -1) {
          handlers.onFormationBack();
        }
      });

      addEventListener('keyup', (e) => {
        this.held.delete(e.code);
        if (handlers.isStarted() && e.code === this.chargeKey) {
          this.chargeKey = null;
          handlers.onChargeRelease();
        }
      });
      // ウィンドウを離れている間の keyup は届かないので、戻ったときに押下状態を捨てる。
      // 溜めキーを押しっぱなしのまま離脱された場合に備え、溜めも強制的に離す。
      addEventListener('blur', () => {
        this.held.clear();
        if (handlers.isStarted() && this.chargeKey) {
          this.chargeKey = null;
          handlers.onChargeRelease();
        }
      });

      addEventListener('pointerdown', () => {
        if (!handlers.isStarted()) {
          if (!handlers.isAwaitingToss()) handlers.onStart(); // トス結果待ちの間はクリックでは進めない
        } else if (!this.chargeKey) {
          this.chargeKey = 'Pointer';
          handlers.onChargeStart(this.heldSpin());
        }
      });
      addEventListener('pointerup', () => {
        if (handlers.isStarted() && this.chargeKey === 'Pointer') {
          this.chargeKey = null;
          handlers.onChargeRelease();
        }
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

    /**
     * クリック/タップで溜め始めたときのスピン。B/V/C を押しっぱなしのまま同時にクリックする
     * 組み合わせのための救済で、通常はキーボードのみで B/V/C が直接スピンを決める。
     * @returns {'flat'|'top'|'slice'}
     */
    heldSpin() {
      const code = SWING_CODES.find((c) => this.held.has(c));
      return code ? SWING[code] : 'flat';
    }
  }

  RallyOne.Input = Input;
})(window.RallyOne = window.RallyOne || {});
