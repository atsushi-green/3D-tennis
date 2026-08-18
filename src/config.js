/**
 * ゲーム全体のチューニング値。
 * 「なぜこの数字なのか」はここに集約し、他ファイルにマジックナンバーを置かない。
 */
(function (RallyOne) {
  'use strict';

  /** コート寸法（メートル、公式値） */
  const COURT = {
    W: 8.23,        // シングルスコート幅
    L: 23.77,       // コート全長
    DW: 10.97,      // ダブルス幅（ライン描画用）
    SERVICE: 6.40,  // サービスライン（ネットから）
    NET_C: 0.914,   // ネット中央高さ
    NET_P: 1.07,    // ネットポスト高さ
    NET_HALF: 5.75, // ポスト位置
  };

  const HALF_W = COURT.W / 2;
  const HALF_L = COURT.L / 2;

  /** ボールの物理。リアル値ではなくアーケード寄りに調整してある */
  const PHYSICS = {
    GRAVITY: -14.0,
    BALL_R: 0.11,
    RESTITUTION: 0.72, // バウンドの反発係数
    FRICTION: 0.93,    // 接地時の水平減衰
    STEP: 1 / 240,     // 物理の固定ステップ
    MAX_DT: 0.05,      // 1フレームで進める上限（タブ復帰時の暴走よけ）
  };

  /** 選手の移動・スイング */
  const PLAYER = {
    SPEED: 7.2,            // プレイヤーの移動速度
    CPU_CHASE: 6.6,        // CPU が落下点へ寄る速度
    CPU_RECOVER: 4.2,      // CPU が定位置へ戻る速度
    REACH: 1.55,           // プレイヤーの打球可能距離
    REACH_Y: 2.5,          // これより高い球は打てない
    CPU_REACH: 1.45,
    CPU_REACH_Y: 2.4,
    CPU_REACH_Y_MIN: 0.15, // CPU は地を這う球を拾えない
    NET_MARGIN: 0.1,       // 自陣とみなす z の余白
    SWING_WINDOW: 0.22,    // スイング入力が有効な時間
    SWING_ANIM: 0.28,
    SERVE_ANIM: 0.30,
    X_LIMIT: 7.2,          // プレイヤーが動ける横幅
    Z_NEAR: -1.2,          // ネットにこれ以上寄れない
    Z_FAR_MARGIN: 3.2,     // ベースラインの後ろに下がれる距離
  };

  /** プレイヤーのショット目標 */
  const SHOT = {
    DRIVE_T: 0.86,       // 飛翔時間（短いほど速い球）
    LOB_T: 1.45,
    DRIVE_Z: 7.4,        // 狙う深さ（ネットからの距離）
    DRIVE_Z_SPREAD: 2.0, // 毎回少しばらつかせる
    LOB_Z: 10.2,
    AIM_X: 2.7,          // ←→ で狙う左右の位置
    DEFAULT_X: 1.4,      // 無入力時はクロス気味に返す
  };

  /** サーブ */
  const SERVE = {
    BALL_Y: 1.45,     // 構えているときのボールの高さ
    TOSS_Y: 1.9,      // 打点（CPUのサーブが使う固定値。プレイヤーは実際のトスの高さを使う）
    TOSS_PEAK: 2.55,  // プレイヤーのトスが届く最高到達点。ここから重力で落ちてくる
    T: 0.62,          // 飛翔時間
    CLEARANCE: 0.14,  // ネットを越す余裕（フラット気味に打つので小さめ）
    STANCE_X: 1.6,    // センターマークからの立ち位置
    AIM_X_MIN: 1.2,   // サービスボックス内の狙い（CPU が使う。おまかせでランダム）
    AIM_X_MAX: 2.8,
    // プレイヤーのコース狙い。センターマークからの距離（0＝センターライン際、HALF_W＝サイドライン際）
    AIM_T_MIN: 0.3,    // Tコース（センターライン沿い）
    AIM_T_MAX: 0.8,
    AIM_BODY_MIN: 1.6, // ボディ（無入力時のデフォルト）
    AIM_BODY_MAX: 2.2,
    AIM_WIDE_MIN: 3.3, // ワイド（サイドライン際）
    AIM_WIDE_MAX: 3.9,
    DEPTH_MIN: 0.6,   // サービスラインからどれだけ手前に落とすか
    DEPTH_MAX: 2.2,
  };

  /** ボールがこの範囲を出たら問答無用でアウト（計算が破綻したときの保険） */
  const BOUNDS = { X: 18, Z: 24 };

  /** CPU の戦術と気まぐれ（＝難易度） */
  const CPU = {
    SHOT_T: 0.92,       // 飛翔時間
    AIM_X_MIN: 1.4,     // プレイヤーの逆をつく横位置の幅
    AIM_X_MAX: 3.6,
    AIM_Z_MIN: 6.8,     // 狙う深さ（ネットからの距離）
    AIM_Z_MAX: 9.4,
    OUT_LONG: 0.10,     // わざとベースラインを割る確率
    OUT_WIDE: 0.06,     // わざとサイドを割る確率
    HOME_Z: HALF_L - 0.9,
    CHASE_X_LIMIT: 6.4, // 落下点を追う範囲
    CHASE_Z_MIN: 1.6,
    CHASE_Z_MAX: HALF_L + 2.4,
    CHASE_BEHIND: 0.5,  // 落下点の少し後ろに構える
  };

  /** スコアのルール（1セットマッチ） */
  const RULES = {
    GAME_POINTS: 4, // 40 の次でゲーム
    SET_GAMES: 6,
    MARGIN: 2,      // ゲーム／セットとも2差が必要
  };

  /** 演出の間（秒）。setTimeout ではなくゲームループで数える */
  const TIMING = {
    CPU_SERVE_DELAY: 0.9,
    NEXT_POINT: 1.5,
    NEXT_MATCH: 2.6,
  };

  /** 見た目 */
  const THEME = {
    BG: 0x0b1a2b,
    FOG_NEAR: 34,
    FOG_FAR: 62,
    BALL: 0xd8f24a,
    BALL_EMISSIVE: 0x2a3a06,
    COURT_SURFACE: '#2b6cb0',
    COURT_APRON: '#1d7a5f',
    COURT_LINE: '#eef3f8',
    APRON: 0x11304a,
    STAND: 0x0d2438,
    POST: 0x2a3b4d,
    SKIN: 0xecc6a0,
    GRIP: 0x22303f,
    YOU: { shirt: 0xe8eef5, shorts: 0x1e2c3c },
    CPU: { shirt: 0xef6b5a, shorts: 0x2a1c22 },
  };

  /**
   * 歩行/走行のプロシージャルアニメーション。
   * 真のIKではなく、股関節・膝の角度を速度に応じて数式で生成する簡易版。
   */
  const GAIT = {
    HIP_Y: 0.74,      // 股関節の高さ（脚の付け根＝旧レッグメッシュの上端）
    HIP_X: 0.12,      // 股関節の左右オフセット
    THIGH_LEN: 0.38,
    SHIN_LEN: 0.36,
    THIGH_R: [0.085, 0.07],  // 太もも半径 [上,下]
    SHIN_R: [0.06, 0.045],   // すね半径 [上,下]
    FOOT: [0.11, 0.05, 0.17], // 足のサイズ [幅, 高さ, 奥行き]
    MIN_SPEED: 0.15,   // これ未満は「静止」扱い（歩行アニメを止める）
    BLEND_RATE: 8,     // 静止⇔移動のブレンドが追従する速さ（大きいほど素早く切替）
    WALK_HZ: 1.8,      // 歩行のケイデンス（脚の往復/秒）
    RUN_HZ: 3.0,       // 走行のケイデンス
    WALK_SWING: 0.55,  // 歩行時の太もも振り角(rad)
    RUN_SWING: 1.0,    // 走行時の太もも振り角(rad)
    KNEE_BEND: 1.15,   // 膝の最大曲げ角(rad)
    ARM_SWING: 0.5,    // 逆手（ラケットを持たない腕）の振り角(rad)
    BOB_AMP: 0.045,    // 体幹の上下ゆれ(m)
    LEAN_MAX: 0.14,    // 走行時の前傾(rad)
  };

  /** カメラ（プレイヤー側からの中継カメラ風） */
  const CAMERA = {
    FOV: 52,
    HEIGHT: 3.55,
    BACK: HALF_L + 7.0, // ベースラインの後ろ
    FOLLOW_X: 0.42,     // プレイヤーの横移動への追従率
    LOOK_X: 0.16,
    LOOK_AT: { y: 0.95, z: 2.2 },
    LERP: 4,
  };

  RallyOne.config = {
    COURT, HALF_W, HALF_L, PHYSICS, PLAYER, SHOT, SERVE,
    BOUNDS, CPU, RULES, TIMING, THEME, CAMERA, GAIT,
  };
})(window.RallyOne = window.RallyOne || {});
