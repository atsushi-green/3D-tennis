/** スコアボード・コール表示・スタート画面。DOM に触るのはこのファイルだけ。 */
(function (RallyOne) {
  'use strict';

  const { pointLabel } = RallyOne.scoring;
  const {
    GUIDE, SERVE, WIND, STAMINA, SKILLS, ROSTER, SKILL_MIN, SKILL_MAX, SKILL_DEFAULT, getRating,
    CHARACTERS, CHARACTER_BUDGET, CHARACTER_DEFAULT, THEME, SURFACE_COLORS,
    SPECIAL, SPECIAL_MOVES, SPECIAL_PRESET, PRACTICE,
  } = RallyOne.config;
  /** 練習モードのレッスン一覧の見出し（config.PRACTICE.LESSONS の group ごと） */
  const LESSON_GROUPS = { basic: '基本', special: '必殺技' };
  /**
   * 選手一覧の最後に並べる「カスタム」（つまみで能力値を自由に決める）。config.CHARACTERS と
   * 同じ形にしてあるので、一覧・対戦カード・詳細のどこでも選手と同じように扱える。
   * look が無い＝似顔絵の代わりにつまみの絵を描く。
   */
  const CUSTOM = {
    key: 'custom',
    name: 'カスタム',
    type: '自由設定',
    text: '能力値をつまみで自由に決める。選手を選んでから動かすと、その選手がもとになる。',
    accent: '#e8eef5',
  };
  const PICKABLE = CHARACTERS.concat([CUSTOM]);
  const pickOf = (key) => PICKABLE.find((c) => c.key === key) || CUSTOM;
  const accentOf = (c) => (c.look ? c.look.accent : c.accent);
  /** レーダーチャートの軸＝人間にも効く項目（ネット志向は AI の動き方の好みなので外す）。 */
  const RADAR_SKILLS = SKILLS.filter((s) => !s.aiOnly);
  /**
   * ダブルスの「立ち位置の指示」の札（setFormation）の行。keys は input.js の
   * FORMATION_NET/BACK（パートナー）・STAND_NET/BACK（自分）と同じキー。duty は、サーブ待ちで
   * その人がサーバー／レシーバーの番のときに添える「指示がどう効くか」（Game#formationOrders）。
   */
  const FORMATION_ROWS = [
    { who: 'youMate', label: 'パートナー', keys: { net: 'Q', back: 'E' }, duty: '打ってから効く' },
    { who: 'you', label: '自分', keys: { net: 'R', back: 'F' }, duty: 'このポイントは動けない' },
  ];
  const FORMATION_LABEL = { net: '前', back: '後ろ' };
  /** レーダーチャートの半径（viewBox -100〜100 の単位）。軸の名前はこの外側に置く。 */
  const RADAR = { R: 56, LABEL_R: 67 };
  /** ガイドで「タイミングが効かない」と伝えるときの打ち方の呼び名。 */
  const STROKE_LABEL = {
    smash: 'スマッシュ',
    'volley-forehand': 'ボレー',
    'volley-backhand': 'ボレー',
    forehand: 'ロブ／ドロップ',
    backhand: 'ロブ／ドロップ',
  };
  /**
   * 試合後のスタッツ画面に並べる行。value() は game.matchSummary() の 1チームぶんを受け取り、
   * 出す文字列と、左右どちらが上かを比べるための数値（cmp）を返す。cmp が null の行
   * （ダブルフォルトのように「少ない方が良い」など、勝ち負けで色を付けたくない行）は
   * どちらも強調しない。
   */
  const STAT_ROWS = [
    { label: '獲得ポイント', value: (t) => ({ text: `${t.points}`, cmp: t.points }) },
    {
      label: '1stサーブ',
      // 分母が0（そのチームが一度もサーブしていない）ときは割合を出さずに「—」。
      value: (t) => (t.firstServes
        ? { text: `${Math.round((t.firstServeIn / t.firstServes) * 100)}%`, cmp: t.firstServeIn / t.firstServes }
        : { text: '—', cmp: null }),
    },
    { label: 'エース', value: (t) => ({ text: `${t.aces}`, cmp: t.aces }) },
    { label: 'ダブルフォルト', value: (t) => ({ text: `${t.doubleFaults}`, cmp: null }) },
    { label: 'ウィナー', value: (t) => ({ text: `${t.winners}`, cmp: t.winners }) },
    { label: 'ミス', value: (t) => ({ text: `${t.unforced}`, cmp: null }) },
    {
      label: 'ブレークポイント',
      // 「決めた本数／チャンスの本数」。上下を比べるのは**決めた本数**で、割合では
      // ない：1/1 の選手が 4/8 の選手を上回って見えるのはスタッツとしておかしいし、
      // セットを動かすのは実際に取ったブレークの数のほうだから。
      // どちらにもチャンスが無かった試合（全ゲーム 40-0 で終わった等）では行ごと出さない。
      skip: (you, cpu) => !you.breakPoints && !cpu.breakPoints,
      value: (t) => (t.breakPoints
        ? { text: `${t.breaksWon}/${t.breakPoints}`, cmp: t.breaksWon }
        : { text: '—', cmp: null }),
    },
    {
      label: '必殺技',
      // どちらも0（＝誰も技を使わなかった試合／技を1つも選んでいない試合）なら行ごと出さない。
      // Hard では CPU/AI 側も技を使うので、ここは人間ぶんだけを見るのでは足りない（SPECIAL.AI）。
      skip: (you, cpu) => !you.specials && !cpu.specials,
      value: (t) => ({ text: `${t.specials}`, cmp: t.specials }),
    },
    {
      label: '最速サーブ',
      value: (t) => (t.maxServeKmh
        ? { text: `${Math.round(t.maxServeKmh)}km/h`, cmp: t.maxServeKmh }
        : { text: '—', cmp: null }),
    },
  ];

  const $ = (id) => document.getElementById(id);
  /** その行（id）の中の選択ボタンを左から順に。 */
  const segs = (id) => Array.from($(id).querySelectorAll('.seg'));
  /** 中身が同じ集合か（必殺技のプリセットと今の選択を見比べる）。 */
  const sameSet = (a, b) => a.length === b.length && a.every((k) => b.indexOf(k) !== -1);

  /* ---------------------------------------------- 似顔絵（SVG） */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** SVG の要素を1つ作る。 */
  function svg(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, attrs[k]));
    return el;
  }
  /** THEME の 0xRRGGBB を CSS の色に。 */
  const cssColor = (n) => `#${n.toString(16).padStart(6, '0')}`;
  /** 目・口の色 */
  const FACE_INK = '#1a2230';

  // 髪の形（viewBox 0 0 64 64。頭は (32,27) 中心・半径11）。
  /** ふつうの短髪（前髪とこめかみまで）。ほかの髪型の前側にも使う */
  const HAIR_TOP = 'M20.6 27 C19.6 17 25.5 13.6 32 13.6 C38.5 13.6 44.4 17 43.4 27'
    + ' C41.6 21.4 37.4 19.4 32 19.4 C26.6 19.4 22.4 21.4 20.6 27 Z';
  const HAIR_BUZZ = 'M21.2 24 C21 17.5 26 15.2 32 15.2 C38 15.2 43 17.5 42.8 24'
    + ' C41 20 37 18.2 32 18.2 C27 18.2 23 20 21.2 24 Z';
  const HAIR_LONG = 'M19.5 26 C19 15 25 13 32 13 C39 13 45 15 44.5 26 L46 47'
    + ' C42 49 38.5 47.5 37.5 43 L26.5 43 C25.5 47.5 22 49 18 47 Z';
  const CAP_CROWN = 'M20.4 25 C20.4 15.5 25.8 13.2 32 13.2 C38.2 13.2 43.6 15.5 43.6 25 Z';
  const CURLS = [[21.5, 24, 4.2], [23, 18.5, 4.5], [27.5, 14.8, 4.6], [32, 13.6, 4.6],
    [36.5, 14.8, 4.6], [41, 18.5, 4.5], [42.5, 24, 4.2]];
  /** 王冠（最強の選手）。短髪の上に載せる。CROWN_TIPS は先の宝石の位置 */
  const CROWN = 'M22.5 15.5 L23.5 7.5 L28 11.5 L32 5 L36 11.5 L40.5 7.5 L41.5 15.5 Z';
  const CROWN_TIPS = [[23.5, 7.5], [32, 5], [40.5, 7.5]];

  /**
   * 選手の似顔絵（胸から上）。肌・髪・髪型は選手ごと（config.CHARACTERS の look）、
   * シャツはその枠のウェア（コート上の3Dモデルと同じ THEME の配色）。カスタムはつまみの絵。
   * @param {object} character config.CHARACTERS の1人、または CUSTOM
   * @param {{shirt:number, shorts:number}} kit THEME.YOU など
   */
  function portrait(character, kit) {
    const root = svg('svg', { viewBox: '0 0 64 64', class: 'face', 'aria-hidden': 'true' });
    const add = (tag, attrs) => root.appendChild(svg(tag, attrs));
    const look = character.look;
    add('rect', { width: 64, height: 64, fill: accentOf(character), 'fill-opacity': 0.2 });
    if (!look) {
      [[22, 25], [32, 39], [42, 30]].forEach(([y, x]) => {
        add('line', {
          x1: 17, x2: 47, y1: y, y2: y, stroke: CUSTOM.accent, 'stroke-opacity': 0.5,
          'stroke-width': 2.4, 'stroke-linecap': 'round',
        });
        add('circle', { cx: x, cy: y, r: 3.8, fill: CUSTOM.accent });
      });
      return root;
    }
    const hair = { fill: look.hair };
    // 頭の後ろに来る髪（長い髪・ポニーテール・お団子）
    if (look.style === 'long') add('path', { ...hair, d: HAIR_LONG });
    if (look.style === 'ponytail') {
      add('ellipse', { ...hair, cx: 45, cy: 31, rx: 3.6, ry: 8.5, transform: 'rotate(14 45 31)' });
    }
    if (look.style === 'bun') add('circle', { ...hair, cx: 32, cy: 12.6, r: 5.2 });
    // 肩（シャツ）と襟、首、耳、頭
    add('path', { d: 'M9 64 C9 51 19 45 32 45 C45 45 55 51 55 64 Z', fill: cssColor(kit.shirt) });
    add('path', {
      d: 'M26.5 45.4 L32 51.5 L37.5 45.4', fill: 'none', stroke: cssColor(kit.shorts), 'stroke-width': 2,
    });
    add('path', { d: 'M28 35 L36 35 L36.5 45.5 Q32 48 27.5 45.5 Z', fill: look.skin });
    add('circle', { cx: 21.2, cy: 28.5, r: 2.2, fill: look.skin });
    add('circle', { cx: 42.8, cy: 28.5, r: 2.2, fill: look.skin });
    add('circle', { cx: 32, cy: 27, r: 11, fill: look.skin });
    // 頭の上に来る髪・帽子・ヘアバンド
    if (look.style === 'buzz') add('path', { ...hair, d: HAIR_BUZZ });
    else if (look.style === 'curly') CURLS.forEach(([cx, cy, r]) => add('circle', { ...hair, cx, cy, r }));
    else if (look.style === 'cap') {
      add('path', { d: CAP_CROWN, fill: look.accent });
      add('rect', { x: 18.5, y: 23, width: 27, height: 4, rx: 2, fill: look.accent });
      add('rect', { x: 18.5, y: 25, width: 27, height: 2, rx: 1, fill: '#000', 'fill-opacity': 0.25 });
    } else add('path', { ...hair, d: HAIR_TOP });
    if (look.style === 'ponytail') add('circle', { cx: 42.6, cy: 22.4, r: 2, fill: look.accent });
    if (look.style === 'band') add('rect', { x: 20.8, y: 19.6, width: 22.4, height: 3.6, rx: 1, fill: look.accent });
    if (look.style === 'crown') {
      add('path', { d: CROWN, fill: look.accent });
      add('rect', { x: 22.6, y: 13, width: 18.8, height: 2.5, fill: '#000', 'fill-opacity': 0.2 });
      CROWN_TIPS.forEach(([cx, cy]) => add('circle', { cx, cy, r: 1.4, fill: '#fff6d6' }));
    }
    // 目と口
    add('circle', { cx: 28, cy: 28.3, r: 1.25, fill: FACE_INK });
    add('circle', { cx: 36, cy: 28.3, r: 1.25, fill: FACE_INK });
    add('path', {
      d: 'M29.2 32.6 Q32 34.6 34.8 32.6', fill: 'none', stroke: FACE_INK,
      'stroke-width': 1.1, 'stroke-linecap': 'round',
    });
    return root;
  }

  /**
   * 似顔絵の置き場所（holder）の中身を、その選手・そのウェアのものにする。
   * 能力値のつまみを動かすたびに一覧ごと描き直すので、中身が変わるときだけ作り直す。
   */
  function setPortrait(holder, character, kitKey) {
    const key = `${character.key}:${kitKey}`;
    if (holder.dataset.face === key) return;
    holder.dataset.face = key;
    holder.replaceChildren(portrait(character, THEME[kitKey]));
  }

  /**
   * スタッツ表の1行（YOU の値／項目名／CPU の値）。cmp が両方とも数値のときだけ、
   * 上回っている側に .lead を付けて色で分かるようにする。
   * @param {string} cls 追加のクラス（見出し行なら 'head'）
   */
  function row(cls, label, you, cpu) {
    const el = document.createElement('div');
    el.className = `msRow${cls ? ` ${cls}` : ''}`;
    const cell = (side, v, lead) => {
      const d = document.createElement('div');
      d.className = `msVal ${side}${lead ? ' lead' : ''}`;
      d.textContent = v.text;
      return d;
    };
    const comparable = typeof you.cmp === 'number' && typeof cpu.cmp === 'number' && you.cmp !== cpu.cmp;
    const name = document.createElement('div');
    name.className = 'msLabel';
    name.textContent = label;
    el.append(
      cell('you', you, comparable && you.cmp > cpu.cmp),
      name,
      cell('cpu', cpu, comparable && cpu.cmp > you.cmp),
    );
    return el;
  }

  class Hud {
    constructor() {
      this.el = {
        names: { you: $('n1'), cpu: $('n2') },
        games: { you: $('g1'), cpu: $('g2') },
        points: { you: $('p1'), cpu: $('p2') },
        aces: { you: $('ace1'), cpu: $('ace2') },
        doubleFaults: { you: $('df1'), cpu: $('df2') },
        stakes: $('stakes'),
        wind: $('wind'),
        serveSpeed: $('serveSpeed'),
        matchLevel: $('matchLevel'),
        staminaFillYou: $('staminaFillYou'),
        staminaFillCpu: $('staminaFillCpu'),
        staminaFillYouMate: $('staminaFillYouMate'),
        staminaFillCpuMate: $('staminaFillCpuMate'),
        staminaRowYouMate: $('staminaRowYouMate'),
        staminaRowCpuMate: $('staminaRowCpuMate'),
        shade: $('shade'),
        hud: $('hud'),
        lsKicker: $('lsKicker'),
        lsTitle: $('lsTitle'),
        lsText: $('lsText'),
        lsProgress: $('lsProgress'),
        practiceBtn: $('practiceBtn'),
        practiceMenu: $('practiceMenu'),
        lessonList: $('lessonList'),
        practiceBack: $('practiceBack'),
        call: $('call'),
        callBig: $('callBig'),
        callSub: $('callSub'),
        callShot: $('callShot'),
        start: $('start'),
        menuBody: $('menuBody'),
        playBtn: $('playBtn'),
        tossChoice: $('tossChoice'),
        charge: $('charge'),
        chargeFill: $('chargeFill'),
        chargeMark: $('chargeMark'),
        smashTip: $('smashTip'),
        specialTip: $('specialTip'),
        specialUses: $('specialUses'),
        formation: $('formation'),
        specialSegs: $('specialSegs'),
        specialPresets: $('specialPresets'),
        specialBadge: $('specialBadge'),
        specialNote: $('specialNote'),
        guide: $('guide'),
        guideText: $('guideText'),
        guideNeedle: $('guideNeedle'),
        replayTag: $('replayTag'),
        matchStats: $('matchStats'),
        msTitle: $('msTitle'),
        msScore: $('msScore'),
        msTable: $('msTable'),
        msRally: $('msRally'),
        msClose: $('msClose'),
        matchup: $('matchup'),
        teamYou: $('teamYou'),
        teamCpu: $('teamCpu'),
        pickHead: $('pickHead'),
        charGrid: $('charGrid'),
        charDetail: $('charDetail'),
        cdTop: $('cdTop'),
        radar: $('radar'),
        rosterRows: $('rosterRows'),
        rosterFoot: $('rosterFoot'),
        rosterReset: $('rosterReset'),
        rosterRandom: $('rosterRandom'),
        // 各設定行のボタン。個別に id を振らず、行の中の .seg をまとめて拾う
        // （選択肢を足すときは index.html に1行足すだけで済む）。
        modeOpts: segs('modeRow'),
        diffOpts: segs('diffRow'),
        surfaceOpts: segs('surfaceRow'),
        styleOpts: segs('styleRow'),
        firstServeOpts: segs('firstServeRow'),
        guideOpts: segs('guideRow'),
        tossOpts: segs('tossChoice'),
      };
    }

    /**
     * スタート画面のボタンを配線する（main.js から一度だけ呼ぶ）。押したときに何をするかは
     * main.js が持っていて、ここは「どのボタンがどのハンドラか」を結ぶだけ＝キーボード側
     * （input.js）とまったく同じハンドラを呼ぶので、マウスとキーで挙動がずれない。
     * @param {{onSelectMode:(doubles:boolean)=>void, onSelectDifficulty:Function,
     *   onSelectSurface:Function, onSelectStyle:Function, onSelectFirstServe:Function,
     *   onPlay:Function, onSelectToss:Function}} handlers
     */
    buildMenu(handlers) {
      const bind = (opts, fn) => opts.forEach((el) => {
        el.addEventListener('click', () => fn(el.dataset.level));
      });
      bind(this.el.modeOpts, (level) => handlers.onSelectMode(level === 'doubles'));
      bind(this.el.diffOpts, handlers.onSelectDifficulty);
      bind(this.el.surfaceOpts, handlers.onSelectSurface);
      bind(this.el.styleOpts, handlers.onSelectStyle);
      bind(this.el.firstServeOpts, handlers.onSelectFirstServe);
      bind(this.el.guideOpts, (level) => handlers.onSelectGuide(level === 'on'));
      // サーフェスのカードの色見本は、コートを塗る色そのもの（config.SURFACE_COLORS）で塗る
      this.el.surfaceOpts.forEach((el) => {
        const colors = SURFACE_COLORS[el.dataset.level];
        const sw = el.querySelector('.sw');
        if (!colors || !sw) return;
        sw.style.backgroundColor = colors.surface;
        sw.style.borderColor = colors.apron;
      });
      // 左のパネルのタブ（試合の設定／必殺技）。見た目だけの切り替えなので、ここで完結する
      const tabs = Array.from(document.querySelectorAll('#matchPanel .panelTab'));
      const pages = Array.from(document.querySelectorAll('#matchPanel .tabPage'));
      tabs.forEach((tab) => tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.toggle('on', t === tab));
        pages.forEach((page) => page.classList.toggle('on', page.dataset.page === tab.dataset.tab));
      }));
      this.el.playBtn.addEventListener('click', () => handlers.onPlay());
      this.el.tossOpts.forEach((el) => {
        el.addEventListener('click', () => handlers.onSelectToss(el.dataset.choice));
      });
    }

    /* -------------------------------------------------------- 必殺技 */

    /**
     * スタート画面の必殺技の選択ボタンを組み立てる（main.js から一度だけ呼ぶ）。
     * 中身は config.SPECIAL_MOVES から作るので、技を足すときは config だけ触ればよい。
     * 他の設定行と違い**複数選択**なので、押すたびにその技だけが入/切する
     * （選んだ集合そのものは main.js が持ち、game.setSpecials() へ渡す）。
     * 見出し右のプリセット（なし／おすすめ／すべて）は、キーボードの Z と同じ動作。
     * カードには技名の下に「どんな場面で出るか」（when）と「何が起きるか」（hint）を並べる。
     * @param {{onToggle:(key:string)=>void, onPreset:(name:'none'|'preset'|'all')=>void}} handlers
     */
    buildSpecials(handlers) {
      // 「いつ」「効果」の小さな札を頭に付けた1行
      const line = (tag, cls, caption, value) => {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        const label = document.createElement('i');
        label.textContent = caption;
        el.append(label, value);
        return el;
      };
      const chips = SPECIAL_MOVES.map((move) => {
        const el = document.createElement('div');
        el.className = 'seg spec';
        el.dataset.special = move.key;
        const name = document.createElement('b');
        name.className = 'optName';
        name.textContent = move.label;
        el.append(name, line('em', '', 'いつ', move.when), line('span', 'hint', '効果', move.hint));
        el.addEventListener('click', () => handlers.onToggle(move.key));
        return el;
      });
      const preset = (name, label, keys) => {
        const el = document.createElement('span');
        el.className = 'specPreset';
        el.textContent = label;
        el.addEventListener('click', () => handlers.onPreset(name));
        return { el, keys };
      };
      this.specialPresets = [
        preset('none', 'なし', []),
        preset('preset', 'おすすめ', SPECIAL_PRESET),
        preset('all', 'すべて', SPECIAL_MOVES.map((m) => m.key)),
      ];
      this.el.specialSegs.replaceChildren(...chips);
      this.el.specialPresets.replaceChildren(...this.specialPresets.map((p) => p.el));
      this.specialChips = chips;
    }

    /**
     * 選ばれている必殺技の表示を更新する（値そのものは main.js が持つ）。
     * いまの選択がプリセットのどれかとちょうど同じなら、そのプリセットも点灯させる。
     * @param {string[]} keys 選択中の技のキー
     */
    setSpecials(keys) {
      const on = keys || [];
      (this.specialChips || []).forEach((el) => {
        el.classList.toggle('on', on.indexOf(el.dataset.special) !== -1);
      });
      const preset = (this.specialPresets || []).find((p) => sameSet(on, p.keys));
      (this.specialPresets || []).forEach((p) => p.el.classList.toggle('on', p === preset));
      // タブの札：プリセットどおりならその名前、そうでなければ選んだ数
      this.el.specialBadge.textContent = preset ? preset.el.textContent : `${on.length}種`;
      this.el.specialBadge.classList.toggle('on', on.length > 0);
      this.el.specialNote.textContent = on.length
        ? `選択中 ${on.length} 種 — 条件を満たした1打で自動的に出ます（キックサーブだけは K でトスを上げて打つ。技ごとに1ゲーム ${SPECIAL.USES_PER_GAME} 回まで）。`
        : '必殺技なし（これまでどおりのテニス）。技を選ぶと、条件を満たした1打で自動的に出るようになります。';
    }

    /**
     * 「いま溜めキーを離したら何が出るか」（溜めバーの上）。必殺技は自動発動なので、
     * これは操作の案内ではなく「この1打がどうなるか」の予告。
     * @param {{move:string|null, label:string|null, spent:string|null,
     *   usesLeft:number, hint?:string}|null} armed Game#specialArmed。null（打つ場面ではない）なら非表示。
     *   spent は「回数さえ残っていれば出ていた技」の名前（使い切ったことを伝えるため）。
     *   hint はまだ技が乗っていないが、操作すれば出せるときの案内（キックサーブの K）。
     */
    setSpecialTip(armed) {
      const el = this.el.specialTip;
      el.classList.toggle('on', !!armed);
      if (!armed) return;
      const ready = !!armed.move;
      el.classList.toggle('ready', ready);
      el.classList.toggle('spent', !ready && !!armed.spent);
      // 回数が1回きりのときは「残りN」を出さない（○/● の表示と二重になるため）。
      const left = SPECIAL.USES_PER_GAME > 1 ? `（残り ${armed.usesLeft}）` : '';
      el.textContent = ready
        ? `⚡ ${armed.label}${left}`
        : armed.spent
          ? `⚡ ${armed.spent} はこのゲームでは使用済み`
          : armed.hint
            ? `⚡ ${armed.hint}${left}`
            : '⚡ この場面で出せる技はありません';
    }

    /**
     * 技ごとの残り回数（●＝使える／○＝このゲームは使用済み）。技どうしで融通はしないので、
     * 「どれがまだ残っているか」が分かるよう装備している技を1つずつ並べる。
     * 毎フレーム呼ばれるので、中身が変わったときだけ組み立て直す。
     * @param {string[]} specials Game#specials（装備している技のキー）
     * @param {{[key:string]: number}} uses Game#specialUses（技ごとの残り）
     */
    setSpecialUses(specials, uses) {
      const el = this.el.specialUses;
      const equipped = SPECIAL_MOVES.filter((m) => (specials || []).indexOf(m.key) !== -1);
      const key = equipped.map((m) => `${m.key}:${(uses && uses[m.key]) || 0}`).join(',');
      if (key === this.specialUsesKey) return;
      this.specialUsesKey = key;
      if (!equipped.length || SPECIAL.USES_PER_GAME <= 0) {
        el.replaceChildren();
        return;
      }
      const head = document.createElement('span');
      head.className = 'spUseHead';
      head.textContent = '⚡ 必殺技';
      const chips = equipped.map((m) => {
        const left = (uses && uses[m.key]) || 0;
        const chip = document.createElement('span');
        chip.className = `spUse${left > 0 ? ' on' : ''}`;
        const count = SPECIAL.USES_PER_GAME > 1 ? `×${left}` : '';
        chip.textContent = `${left > 0 ? '●' : '○'} ${m.short}${count}`;
        return chip;
      });
      el.replaceChildren(head, ...chips);
    }

    /* ------------------------------------------------ 選手（キャラクター・能力値） */

    /**
     * スタート画面の「選手」パネルを組み立てる（main.js から一度だけ呼ぶ）。
     * - 上：対戦カード。4つの枠（config.ROSTER）に、いま誰を選んでいるかが並ぶ。押した枠が
     *   「いま選手を選んでいる枠」になる（＝以前のタブ）。
     * - 中：選手の一覧（config.CHARACTERS ＋ カスタム）。押すとその枠の選手になる。
     * - 下：選んでいる選手の詳細。似顔絵・説明・レーダーチャートと、能力値のつまみ。
     *   つまみを動かすと、その枠は「カスタム」（選んでいた選手をもとにした自由設定）になる。
     * 中身は config から作るので、選手や項目を足したいときは config だけ触ればよい。
     * 値そのものは config が持ち、どの枠に誰を選んでいるか（picks）は main.js が持つ：ここは
     * 表示とクリックの受け付けだけで、実際の書き換えは main.js（onPick/onChange/onReset/
     * onRandom）が config.applyCharacter() 等で行い、setPicks() で結果を渡してくる
     * ＝「難易度・サーフェスの選択は main が config に適用する」という既存の流れと同じ。
     *
     * 1〜5は div で組んだ「つまみバー」（クリックでその値へ、つまみをドラッグで連続変更）。
     * `<input type=range>` を使わないのは、スタート画面が「どのキーを押しても開始」という
     * 作りで、フォーカスの当たる要素があると矢印キーや Space で意図せず試合が始まって
     * しまうため（div はフォーカスを取らない）。
     *
     * @param {{onPick:(who:string,key:string)=>void,
     *   onChange:(who:string,key:string,value:number)=>void,
     *   onReset:()=>void, onRandom:()=>void}} handlers
     */
    buildRoster(handlers) {
      this.rosterWho = ROSTER[0].key;
      this.picks = Object.fromEntries(ROSTER.map((r) => [r.key, CHARACTER_DEFAULT]));
      this.rosterBars = {}; // key ＝ 能力のキー、値 ＝ その行のバーの部品（renderRoster が使う）
      this.slots = {};      // key ＝ 枠（ROSTER のキー）、値 ＝ その枠の表示の部品

      const text = (tag, cls, value) => {
        const el = document.createElement(tag);
        el.className = cls;
        if (value != null) el.textContent = value;
        return el;
      };

      // 対戦カード。cpu で始まる枠は右（相手側）。パートナー／CPU2 はシングルスでは使われない
      this.el.teamCpu.classList.add('cpu');
      ROSTER.forEach((actor) => {
        const el = text('div', `slot${actor.key === 'you' || actor.key === 'cpu' ? '' : ' mate'}`);
        el.title = actor.note;
        const face = text('span', 'faceBox');
        const box = text('div', 'slotText');
        const name = text('b', 'slotName');
        const type = text('em', 'slotType');
        box.append(text('span', 'slotRole', actor.label), name, type);
        el.append(face, box);
        el.addEventListener('click', () => {
          this.rosterWho = actor.key;
          this.renderRoster();
        });
        const team = actor.key.indexOf('cpu') === 0 ? this.el.teamCpu : this.el.teamYou;
        team.appendChild(el);
        this.slots[actor.key] = { el, face, name, type };
      });

      // 選手の一覧（＋カスタム）
      this.charCards = PICKABLE.map((c) => {
        const el = text('div', `charCard${c.champion ? ' champion' : ''}`);
        el.style.setProperty('--accent', accentOf(c));
        el.title = `${c.name}（${c.type}）\n${c.text}`;
        const face = text('span', 'faceBox');
        const box = text('div', 'ccText');
        box.append(text('b', 'ccName', c.name), text('em', 'ccType', c.type));
        el.append(face, box);
        el.addEventListener('click', () => handlers.onPick(this.rosterWho, c.key));
        this.el.charGrid.appendChild(el);
        return { el, face, character: c };
      });

      // 詳細の上段（似顔絵・名前・タイプ・説明）
      this.detail = {
        face: text('span', 'faceBox'),
        name: text('span', 'cdName'),
        type: text('span', 'cdType'),
        text: text('div', 'cdText'),
      };
      const title = text('div', 'cdTitle');
      title.append(this.detail.name, this.detail.type);
      const words = text('div', '');
      words.append(title, this.detail.text);
      this.el.cdTop.append(this.detail.face, words);

      this.buildRadar();

      SKILLS.forEach((skill) => {
        const row = document.createElement('div');
        row.className = 'rosterRow';
        row.dataset.skill = skill.key;
        row.title = `${skill.label}：${skill.hint}`;
        row.appendChild(text('div', 'rosterName', skill.label));
        row.appendChild(this.buildSkillBar(skill, handlers));
        row.appendChild(text('div', 'rosterHint', skill.hint));
        this.el.rosterRows.appendChild(row);
      });

      this.el.rosterReset.addEventListener('click', () => handlers.onReset());
      this.el.rosterRandom.addEventListener('click', () => handlers.onRandom());
      this.renderRoster();
    }

    /**
     * レーダーチャートの動かない部分（目盛りの多角形・軸・軸の名前）を組み立てる。
     * 能力値の多角形（.area）と頂点の点は renderRadar() が毎回動かす。
     * 目盛りは 1〜5 の5重で、既定の 3 だけ破線にして「基準より上か下か」を見せる。
     */
    buildRadar() {
      const n = RADAR_SKILLS.length;
      const at = (i, r) => {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        return [Math.cos(a) * r, Math.sin(a) * r];
      };
      this.radarAt = at;
      const root = this.el.radar;
      for (let v = SKILL_MIN; v <= SKILL_MAX; v++) {
        const r = (RADAR.R * v) / SKILL_MAX;
        const pts = RADAR_SKILLS.map((s, i) => at(i, r).map((c) => c.toFixed(1)).join(',')).join(' ');
        root.appendChild(svg('polygon', { class: `ring${v === SKILL_DEFAULT ? ' base' : ''}`, points: pts }));
      }
      this.radarLabels = RADAR_SKILLS.map((s, i) => {
        const [x, y] = at(i, RADAR.R);
        root.appendChild(svg('line', { class: 'axis', x1: 0, y1: 0, x2: x.toFixed(1), y2: y.toFixed(1) }));
        const [lx, ly] = at(i, RADAR.LABEL_R);
        const label = svg('text', {
          class: 'lbl',
          x: lx.toFixed(1),
          y: ly.toFixed(1),
          'text-anchor': lx > 6 ? 'start' : lx < -6 ? 'end' : 'middle',
          'dominant-baseline': 'middle',
        });
        label.textContent = s.short;
        root.appendChild(label);
        return label;
      });
      this.radarArea = svg('polygon', { class: 'area' });
      root.appendChild(this.radarArea);
      this.radarDots = RADAR_SKILLS.map(() => {
        const dot = svg('circle', { class: 'dot', r: 2.6 });
        root.appendChild(dot);
        return dot;
      });
    }

    /** レーダーチャートを、いま選んでいる枠の能力値にする。得意（4以上）の軸の名前は明るく。 */
    renderRadar(who) {
      const pts = RADAR_SKILLS.map((s, i) => {
        const value = getRating(who, s.key);
        const [x, y] = this.radarAt(i, (RADAR.R * value) / SKILL_MAX);
        this.radarDots[i].setAttribute('cx', x.toFixed(1));
        this.radarDots[i].setAttribute('cy', y.toFixed(1));
        this.radarLabels[i].classList.toggle('hi', value > SKILL_DEFAULT);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      this.radarArea.setAttribute('points', pts.join(' '));
    }

    /**
     * 能力1項目ぶんの「つまみバー」。バーのどこかを押すとその位置の値になり、押したまま
     * 左右へ動かすと連続で変わる（`setPointerCapture` を使うので、つまみからカーソルが
     * はみ出してもドラッグは続く）。値を持つのは config なので、ここは押された位置を
     * 1〜5に直して onChange へ渡すだけ（表示は main.js が setPicks() で描き直させる）。
     * @param {{key:string,label:string}} skill config.SKILLS の1項目
     * @param {{onChange:(who:string,key:string,value:number)=>void}} handlers
     */
    buildSkillBar(skill, handlers) {
      const bar = document.createElement('div');
      bar.className = 'skillBar';
      bar.title = `${skill.label}（${SKILL_MIN}〜${SKILL_MAX}）`;
      const fill = document.createElement('div');
      fill.className = 'skillFill';
      const knob = document.createElement('div');
      knob.className = 'skillKnob';
      const value = document.createElement('div');
      value.className = 'skillValue';
      bar.appendChild(fill);
      bar.appendChild(knob);

      // 押された x 座標を 1〜5 に直す。バーの左端が SKILL_MIN、右端が SKILL_MAX に
      // ちょうど対応するよう、つまみの幅ぶん内側に縮めた区間で割り当てる。
      const valueAt = (clientX) => {
        const rect = bar.getBoundingClientRect();
        const pad = knob.offsetWidth / 2;
        const span = Math.max(rect.width - knob.offsetWidth, 1);
        const f = (clientX - rect.left - pad) / span;
        const v = Math.round(SKILL_MIN + f * (SKILL_MAX - SKILL_MIN));
        return Math.min(Math.max(v, SKILL_MIN), SKILL_MAX);
      };
      const apply = (e) => {
        const v = valueAt(e.clientX);
        if (v === getRating(this.rosterWho, skill.key)) return;
        handlers.onChange(this.rosterWho, skill.key, v);
      };
      bar.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // ドラッグ中にテキスト選択が始まらないように
        bar.setPointerCapture(e.pointerId);
        apply(e);
      });
      bar.addEventListener('pointermove', (e) => {
        if (bar.hasPointerCapture(e.pointerId)) apply(e);
      });
      bar.addEventListener('pointerup', (e) => bar.releasePointerCapture(e.pointerId));

      const wrap = document.createElement('div');
      wrap.className = 'skillWrap';
      wrap.appendChild(bar);
      wrap.appendChild(value);
      this.rosterBars[skill.key] = { fill, knob, value };
      return wrap;
    }

    /**
     * どの枠に誰を選んでいるかを受け取って描き直す（値そのものは main.js が持つ）。
     * @param {{[who:string]: string}} picks 枠ごとの config.CHARACTERS の key、または 'custom'
     */
    setPicks(picks) {
      this.picks = Object.assign({}, picks);
      this.renderRoster();
    }

    /** 「選手」パネル全体を、いまの選択と能力値に合わせる（操作のたびに呼ぶ）。 */
    renderRoster() {
      const who = this.rosterWho;
      const actor = ROSTER.find((r) => r.key === who);
      const current = pickOf(this.picks[who]);

      ROSTER.forEach((r) => {
        const slot = this.slots[r.key];
        const picked = pickOf(this.picks[r.key]);
        slot.el.classList.toggle('on', r.key === who);
        setPortrait(slot.face, picked, r.kit);
        slot.name.textContent = picked.name;
        slot.type.textContent = picked.type;
      });

      const head = document.createElement('b');
      head.textContent = actor.label;
      this.el.pickHead.replaceChildren(head, `（${actor.note}）の選手を選ぶ`);
      // 一覧の似顔絵も、いま選んでいる枠のウェアを着せる（＝コート上でどう見えるか）
      this.charCards.forEach((card) => {
        card.el.classList.toggle('on', card.character === current);
        setPortrait(card.face, card.character, actor.kit);
      });

      this.el.charDetail.style.setProperty('--accent', accentOf(current));
      setPortrait(this.detail.face, current, actor.kit);
      this.detail.name.textContent = current.name;
      this.detail.type.textContent = current.type;
      this.detail.text.textContent = current.text;
      this.renderRadar(who);

      let total = 0;
      SKILLS.forEach((skill) => {
        const value = getRating(who, skill.key);
        if (!skill.aiOnly) total += value;
        const bar = this.rosterBars[skill.key];
        const pct = ((value - SKILL_MIN) / (SKILL_MAX - SKILL_MIN)) * 100;
        bar.fill.style.width = `${pct}%`;
        // つまみは「バーの内側」を端から端まで動く（calc の 100% はバー幅、
        // その中でつまみ自身の幅ぶんを差し引いた区間を pct で進む）。
        bar.knob.style.left = `calc(${pct}% - ${pct / 100} * var(--knob))`;
        bar.value.textContent = value;
        // 人間（you）には効かない項目は薄く表示する（設定はできるが意味がない、と分かるように）
        const row = this.el.rosterRows.querySelector(`[data-skill="${skill.key}"]`);
        row.classList.toggle('off', !!skill.aiOnly && who === 'you');
      });
      // 選手は最強の選手を除いてみな合計が同じ（config.CHARACTER_BUDGET）なので、
      // カスタムと最強の選手のときだけ基準との差を見せる
      this.el.rosterFoot.textContent = current === CUSTOM
        ? `能力の合計 ${total}／基準 ${CHARACTER_BUDGET}（ネット志向を除く）。すべて${SKILL_DEFAULT}なら今までと同じ強さです。`
        : current.champion
          ? `能力の合計 ${total}（ネット志向を除く）— 全項目が最高。ほかの選手（合計 ${CHARACTER_BUDGET}）とは別格の強さ。`
          : `能力の合計 ${total}（ネット志向を除く）— 最強の選手を除き、みな同じ合計。違うのは得意・不得意だけ。`;
    }

    /**
     * 4人全員の残量を表示する（自分の分だけでなく、相手・パートナーの消耗具合も駆け引きの
     * 材料になる）。パートナー(youMate)/CPU2(cpuMate)の行はダブルスのときだけ出す。
     * @param {{you:number, cpu:number, youMate:number, cpuMate:number}} stamina 各アクターの残量(0〜1)
     * @param {boolean} doubles
     */
    setStamina(stamina, doubles) {
      this.setStaminaFill(this.el.staminaFillYou, stamina.you);
      this.setStaminaFill(this.el.staminaFillCpu, stamina.cpu);
      this.el.staminaRowYouMate.style.display = doubles ? '' : 'none';
      this.el.staminaRowCpuMate.style.display = doubles ? '' : 'none';
      if (doubles) {
        this.setStaminaFill(this.el.staminaFillYouMate, stamina.youMate);
        this.setStaminaFill(this.el.staminaFillCpuMate, stamina.cpuMate);
      }
    }

    setStaminaFill(el, fraction) {
      el.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      el.classList.toggle('low', fraction < STAMINA.LOW_THRESHOLD);
    }

    /** スタート画面の試合形式（シングルス／ダブルス）表示を切り替える。 */
    setMode(doubles) {
      const level = doubles ? 'doubles' : 'singles';
      this.el.modeOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === level));
      // シングルスではパートナー／CPU2 の枠を薄くする（選んでおくことはできる）
      this.el.matchup.classList.toggle('singles', !doubles);
    }

    /** スタート画面のCPUの強さ表示を切り替える（実際の適用は config.applyCpuLevel が行う）。 */
    setDifficulty(level) {
      this.el.diffOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === level));
    }

    /**
     * 試合画面の右上に、対戦しているCPU/AIの強さを出す（試合を始めるときに main.js が呼ぶ）。
     * 表記はスタート画面のカードの名前（.optName）をそのまま使う＝二重管理しない。
     * @param {string} level config.CPU_LEVELS のキー（'easy'|'normal'|'hard'|'extreme'）
     */
    setMatchLevel(level) {
      const opt = this.el.diffOpts.find((el) => el.dataset.level === level);
      const el = this.el.matchLevel;
      el.dataset.level = level;
      el.replaceChildren();
      if (!opt) return;
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = 'CPU';
      el.append(lbl, opt.querySelector('.optName').textContent.trim());
    }

    /** スタート画面のサーフェス表示を切り替える（実際の適用は config.applySurface が行う）。 */
    setSurface(level) {
      this.el.surfaceOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === level));
    }

    /**
     * スタート画面の「最初のサーブ」の表示（値そのものは main.js が持ち、試合を始めるときに
     * コイントスをするか、そのまま選んだ側のサーブで始めるかを決める）。
     * @param {'toss'|'serve'|'receive'} choice
     */
    setFirstServe(choice) {
      this.el.firstServeOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === choice));
    }

    /** スタート画面のプレースタイル表示を切り替える（実際の適用は config.applyCpuStyle が行う）。 */
    setStyle(name) {
      this.el.styleOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === name));
    }

    /** ガイド付きモードの選択表示（値そのものは main.js が持ち、game.setGuide() へ渡す）。 */
    setGuide(on) {
      const level = on ? 'on' : 'off';
      this.el.guideOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === level));
      // 選んでいないときはタイミング目盛りの場所ごと空ける（画面下の縦積みが1段減る）
      this.el.guide.classList.toggle('enabled', !!on);
    }

    /**
     * 風向き・強さの表示（ポイントごとに Game#newPoint() から呼ばれる）。矢印は画面上の
     * 向き（8方位）で、横より前後が強いときは自分（手前のチーム）から見た追い風／向かい風も添える。
     * @param {number} x 横方向の加速度(m/s²)。world +x はカメラの都合で画面の左に映る。
     * @param {number} z 前後方向の加速度(m/s²)。+z は画面の奥＝自分の打つ向き（追い風）。
     */
    setWind(x, z) {
      const strength = Math.hypot(x, z);
      if (strength < WIND.DISPLAY_THRESHOLD) {
        this.el.wind.textContent = '無風';
        return;
      }
      // 画面の右＝-x、上＝+z。右から反時計回りに45°刻み。
      const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
      const sector = Math.round(Math.atan2(z, -x) / (Math.PI / 4));
      const arrow = ARROWS[(sector + 8) % 8];
      const kind = Math.abs(z) <= Math.abs(x) ? '横風' : (z > 0 ? '追い風' : '向かい風');
      this.el.wind.textContent = `風 ${arrow} ${strength.toFixed(1)} ${kind}`;
    }

    /**
     * サーブの初速表示（次のポイントが始まるまで残る）。
     * @param {number|null} kmh null なら非表示（次のポイントが始まった直後）。
     */
    setServeSpeed(kmh) {
      this.el.serveSpeed.textContent = kmh == null ? '' : `サーブ ${Math.round(kmh)}km/h`;
    }

    /**
     * @param {object} match RallyOne.scoring.Match
     * @param {'you'|'cpu'} server
     * @param {{you:{aces:number,doubleFaults:number}, cpu:{aces:number,doubleFaults:number}}} stats RallyOne.Game#stats
     */
    renderScore(match, server, stats) {
      const {
        points, games, tiebreak, tiebreakPoints,
      } = match;
      if (tiebreak) {
        // タイブレーク中は 0/15/30/40 ではなく素点（1点刻み）で表示する
        this.el.points.you.textContent = tiebreakPoints.you;
        this.el.points.cpu.textContent = tiebreakPoints.cpu;
      } else {
        this.el.points.you.textContent = pointLabel(points.you, points.cpu);
        this.el.points.cpu.textContent = pointLabel(points.cpu, points.you);
      }
      this.el.games.you.textContent = games.you;
      this.el.games.cpu.textContent = games.cpu;
      this.el.names.you.className = 'nm' + (server === 'you' ? ' srv' : '');
      this.el.names.cpu.className = 'nm' + (server === 'cpu' ? ' srv' : '');
      this.el.aces.you.textContent = stats.you.aces;
      this.el.aces.cpu.textContent = stats.cpu.aces;
      this.el.doubleFaults.you.textContent = stats.you.doubleFaults;
      this.el.doubleFaults.cpu.textContent = stats.cpu.doubleFaults;
    }

    /**
     * 次の1点にかかっているもの（ブレーク／ゲーム／マッチポイント）をスコアボード脇に出す。
     * 毎フレーム呼ばれるので、中身が変わったときだけ組み立て直す（setSpecialUses と同じ作り）。
     * @param {{kind:'match'|'break'|'game', label:string, team:'you'|'cpu'}|null} stakes
     *   RallyOne.Game#stakes。null（何もかかっていない／ポイントが決着した）なら消す。
     */
    setStakes(stakes) {
      const key = stakes ? `${stakes.kind}:${stakes.team}` : '';
      if (key === this.stakesKey) return;
      this.stakesKey = key;
      const el = this.el.stakes;
      el.classList.toggle('brk', !!stakes && stakes.kind === 'break');
      el.classList.toggle('match', !!stakes && stakes.kind === 'match');
      if (!stakes) {
        el.replaceChildren(); // :empty で行ごと消える
        return;
      }
      const who = document.createElement('span');
      who.className = 'who';
      // スコアボードと同じ呼び名（ダブルスでもチーム名としてそのまま通る）
      who.textContent = stakes.team === 'you' ? 'YOU' : 'CPU';
      el.replaceChildren(document.createTextNode(stakes.label), who);
    }

    /**
     * ダブルスの立ち位置の指示のいまの状態（パートナー＝Q/E、自分＝R/F）。指示を受けたときの
     * コールはすぐ消えるので、いまどちらになっているかを常に出しておく。効いている方を点灯させて
     * 押すキーを添え、サーブ待ちでその人がサーバー／レシーバーの番なら、指示がどう効くかを添える。
     * 指示が変わった行は点灯をひと瞬き光らせる（担当の注記が変わっただけでは光らせない）。
     * 毎フレーム呼ばれるので、中身が変わったときだけ組み立て直す（setStakes と同じ作り）。
     * @param {{youMate:'net'|'back', you:'net'|'back', youMateDuty:string|null,
     *   youDuty:string|null}|null} orders RallyOne.Game#formationOrders()。null（シングルス）なら消す。
     */
    setFormation(orders) {
      const key = orders ? FORMATION_ROWS.map((r) => `${orders[r.who]}:${orders[`${r.who}Duty`]}`).join(',') : '';
      if (key === this.formationKey) return;
      this.formationKey = key;
      const prev = this.formationPrev;
      this.formationPrev = orders;
      const el = this.el.formation;
      if (!orders) {
        el.replaceChildren(); // :empty で行ごと消える
        return;
      }
      const span = (cls, text) => {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        return s;
      };
      const head = document.createElement('div');
      head.className = 'fmHead';
      head.textContent = '立ち位置の指示';
      const rows = FORMATION_ROWS.map((r) => {
        const row = document.createElement('div');
        row.className = 'fmRow';
        const flash = !!prev && prev[r.who] !== orders[r.who];
        const opts = ['net', 'back'].map((f) => {
          const on = orders[r.who] === f;
          const opt = span(`fmOpt${on ? ' on' : ''}${on && flash ? ' flash' : ''}`, FORMATION_LABEL[f]);
          opt.prepend(span('fmKey', r.keys[f]));
          return opt;
        });
        row.append(span('fmWho', r.label), ...opts);
        const duty = orders[`${r.who}Duty`];
        if (!duty) return [row];
        // 注記は行の外に置く：行（flex）の中に入れると、その幅までスコアボードの列が広がる
        const note = document.createElement('div');
        note.className = 'fmNote';
        note.textContent = `${duty}担当：${r.duty}`;
        return [row, note];
      });
      el.replaceChildren(head, ...[].concat(...rows));
    }

    /**
     * @param {string} big 大きい方の文字（'ポイント'・'失点'・コール）
     * @param {string} [sub] 補足（'ウィナー！'・'ゲーム — YOU' など）
     * @param {string} [shot] 決めた側が最後に放った球種（'スマッシュ' など）。
     *   サーブだけで決まった1点（エース）は球速も付く（'フラットサービス（センター） 187km/h'）。
     *   無いポイント（ダブルフォルト直後など）は空にして行ごと隠す。
     */
    showCall(big, sub, shot) {
      this.el.callBig.textContent = big;
      this.el.callSub.textContent = sub || '';
      this.el.callShot.textContent = shot || '';
      this.el.callShot.classList.toggle('on', !!shot);
      this.el.call.classList.add('on');
    }

    hideCall() {
      this.el.call.classList.remove('on');
    }

    /**
     * チェンジエンズの暗転幕の濃さ。毎フレーム呼ばれるので、変わったときだけ書き込む。
     * @param {number} amount 0（なし）〜1（真っ暗）。game.changeoverShade()
     */
    setShade(amount) {
      if (amount === this.shade) return;
      this.shade = amount;
      this.el.shade.style.opacity = amount;
    }

    /**
     * マッチポイントの演出（観客席を映すカット）の間だけ、上下に黒い帯を出して操作の案内を
     * 引っ込める。毎フレーム呼ばれるので、変わったときだけ書き込む。
     * @param {boolean} on game.matchPointCut があるか
     */
    setCinema(on) {
      if (on === this.cinema) return;
      this.cinema = on;
      this.el.hud.classList.toggle('cinema', on);
    }

    hideStartScreen() {
      this.el.start.style.display = 'none';
      this.el.hud.classList.remove('menu'); // 試合中の表示（スコアボード・操作一覧など）を出す
    }

    /**
     * 試合・練習からスタート画面へ戻る（練習モードの Esc）。試合中にだけ出ていた表示
     * （コール・暗転幕・溜めゲージ・技の予告・スマッシュの案内・ガイド・リプレイの札・
     * レッスンの札）も引っ込める。
     */
    showStartScreen() {
      this.el.start.style.display = '';
      this.el.hud.classList.add('menu');
      this.hideCall();
      this.setReplay(false);
      this.setShade(0);
      this.setCinema(false);
      this.setCharge(0);
      this.setSpecialTip(null);
      this.setSmashTip(null);
      this.setSwingGuide(null, 0);
      this.setPractice(null);
    }

    /* ------------------------------------------------------ 練習モード */

    /**
     * スタート画面の練習モードの入口と、レッスン一覧を組み立てる（main.js から一度だけ呼ぶ）。
     * 行は config.PRACTICE.LESSONS の並びどおりで、group ごとに見出しを挟む。
     * @param {{onOpen:Function, onSelect:(index:number)=>void, onBack:Function}} handlers
     */
    buildLessons(handlers) {
      this.lessonRows = [];
      let group = null;
      PRACTICE.LESSONS.forEach((lesson, i) => {
        if (lesson.group !== group) {
          group = lesson.group;
          const head = document.createElement('div');
          head.className = 'pmGroup';
          head.textContent = LESSON_GROUPS[group] || group;
          this.el.lessonList.append(head);
        }
        const row = document.createElement('div');
        row.className = 'lessonRow';
        row.title = lesson.text;
        const no = document.createElement('span');
        no.className = 'no';
        no.textContent = `${i + 1}`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = lesson.title;
        const done = document.createElement('span');
        done.className = 'done';
        done.textContent = '✓';
        row.append(no, name, done);
        row.addEventListener('click', () => handlers.onSelect(i));
        this.el.lessonList.append(row);
        this.lessonRows.push(row);
      });
      this.el.practiceBtn.addEventListener('click', () => handlers.onOpen());
      this.el.practiceBack.addEventListener('click', () => handlers.onBack());
    }

    /**
     * 設定（#menuBody）を隠してレッスン一覧を出す。
     * @param {number} cursor いま選んでいる行（↑↓ で動かす）
     * @param {Set<string>} cleared クリアしたレッスンの key（✓ を付ける）
     */
    showLessons(cursor, cleared) {
      this.el.menuBody.style.display = 'none';
      this.el.start.classList.add('lessons');
      this.el.practiceMenu.classList.add('on');
      this.renderLessons(cursor, cleared);
    }

    hideLessons() {
      this.el.start.classList.remove('lessons');
      this.el.practiceMenu.classList.remove('on');
      this.el.menuBody.style.display = '';
    }

    /** @param {number} cursor @param {Set<string>} cleared */
    renderLessons(cursor, cleared) {
      this.lessonRows.forEach((row, i) => {
        row.classList.toggle('cur', i === cursor);
        row.classList.toggle('cleared', cleared.has(PRACTICE.LESSONS[i].key));
      });
      const cur = this.lessonRows[cursor];
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    }

    /**
     * 練習中のレッスンの札（スコアボードの代わりに左上へ出す）。毎フレーム呼ばれるので、
     * 中身が変わったときだけ組み立て直す。null なら試合の表示に戻す。
     * @param {object|null} practice game.practice
     */
    setPractice(practice) {
      const key = practice
        ? `${practice.lesson.key}:${practice.done}:${practice.tries}:${practice.cleared}`
        : '';
      if (key === this.practiceKey) return;
      this.practiceKey = key;
      this.el.hud.classList.toggle('practice', !!practice);
      if (!practice) return;
      const { lesson, done, cleared } = practice;
      const index = PRACTICE.LESSONS.indexOf(lesson);
      this.el.lsKicker.textContent = `練習 ${index + 1} / ${PRACTICE.LESSONS.length} · ${LESSON_GROUPS[lesson.group] || ''}`;
      this.el.lsTitle.textContent = lesson.title;
      this.el.lsText.textContent = lesson.text;
      const dots = [];
      for (let i = 0; i < lesson.goal; i++) {
        const dot = document.createElement('span');
        dot.className = `dot${i < done ? ' on' : ''}`;
        dots.push(dot);
      }
      const count = document.createElement('span');
      count.textContent = ` 成功 ${done} / ${lesson.goal}`;
      dots.push(count);
      if (cleared) {
        const clear = document.createElement('span');
        clear.className = 'clear';
        clear.textContent = 'クリア！';
        dots.push(clear);
      }
      this.el.lsProgress.replaceChildren(...dots);
    }

    /**
     * トス（コイントス）に人間が勝ったとき、サーブ／レシーブの選択画面に切り替える
     * （実際の選択の適用は main.js#onSelectToss が行う）。
     */
    showTossChoice() {
      this.el.menuBody.style.display = 'none'; // 設定はもう終わっているので、選択だけを残す
      this.el.tossChoice.classList.add('on');
    }

    /**
     * スマッシュの先回りヒントの文言（コート上のマーカーと対で出す）。マーカーは
     * 「どこへ」を示すが、スマッシュにもう一つ要る「止まって溜める」までは伝わらないので、
     * 状態に応じてそこを言葉で補う。
     * @param {{ready:boolean, inTime:boolean}|null} hint RallyOne.Game#smashHint。null なら非表示。
     */
    setSmashTip(hint) {
      const el = this.el.smashTip;
      el.classList.toggle('on', !!hint);
      if (!hint) return;
      el.classList.toggle('ready', hint.ready);
      el.classList.toggle('late', !hint.ready && !hint.inTime);
      el.textContent = hint.ready
        ? '⚡ スマッシュ！ 止まって溜め、印の高さで離す'
        : hint.inTime ? '⚡ スマッシュのチャンス — 印まで先回り' : '⚡ スマッシュ — 急げば届く！';
    }

    /**
     * ガイド付きモードのタイミング目盛り。「いま溜めキーを離したら、引っ張り／素直／流しの
     * どれになるか」を針の位置と言葉で出す。値の計算は game.js の swingGuidePreview()
     * （純ロジック）が持ち、ここは出すだけ（コート上の輪 scene/hint.js と対）。
     * @param {{timing:number, tooEarly:boolean, timingMatters:boolean, stroke:string,
     *   x:number}|null} guide RallyOne.Game#swingGuide。null（ガイドを出す場面ではない）なら非表示。
     * @param {number} playerX 打つ人の x。矢印を「画面のどちら側へ飛ぶか」にするのに使う
     *   （world +x はカメラの都合で画面の左に映る。setWind() と同じ約束）。
     */
    setSwingGuide(guide, playerX) {
      const el = this.el.guide;
      el.classList.toggle('on', !!guide);
      if (!guide) return;
      // 打点タイミングでコースが変わらない打ち方（ボレー・スマッシュ・ロブ・ドロップ）の
      // ときは、引っ張り／流しの色分けをせず「効かない」ことをそのまま出す。
      const pull = guide.timingMatters && guide.timing > GUIDE.NEUTRAL_BAND;
      const flow = guide.timingMatters && guide.timing < -GUIDE.NEUTRAL_BAND;
      el.classList.toggle('early', guide.tooEarly);
      el.classList.toggle('risk', !guide.tooEarly && guide.risk > 0);
      el.classList.toggle('pull', !guide.tooEarly && pull);
      el.classList.toggle('flow', !guide.tooEarly && flow);
      // 目盛りは左＝引っ張り(+1)、右＝流し(-1)。timing をそのまま 0〜100% に直す。
      this.el.guideNeedle.style.left = `${(1 - guide.timing) * 50}%`;
      // 矢印は「画面のどちら側へ飛ぶか」。引っ張り／流しがどちら向きになるかはフォアと
      // バックで逆なので、言葉に固定の矢印を付けると必ず半分は嘘になる（実際に飛ぶ側を出す）。
      const dx = guide.x - playerX;
      const arrow = dx > 0.4 ? '◀' : dx < -0.4 ? '▶' : '↑';
      const label = !guide.timingMatters
        ? `${STROKE_LABEL[guide.stroke] || 'この球'}（タイミングは効かない）`
        : pull ? '引っ張り' : flow ? '流し' : '素直（狙ったところへ）';
      // ライン際まで狙いを振っている＝外れることもある、を言葉でも出す（輪の大きさと対）。
      const risky = guide.risk > 0 ? ' ⚠ライン際' : '';
      this.el.guideText.textContent = guide.tooEarly
        ? 'まだ早い — 離すと空振り'
        : `${arrow} ${label}${risky}`;
    }

    /**
     * 試合後のスタッツ画面の「次の試合へ」ボタンを配線する（main.js から一度だけ呼ぶ）。
     * キーボード（Space）側は input.js が同じハンドラを呼ぶので、どちらでも同じ結果になる。
     * @param {{onClose:Function}} handlers
     */
    buildMatchStats(handlers) {
      this.el.msClose.addEventListener('click', () => handlers.onClose());
    }

    /**
     * 1セットが終わったときの振り返り。数字は game.matchSummary()（純ロジック）が作り、
     * ここは並べて出すだけ。開いている間は main.js が試合の進行を止める。
     * @param {object} summary RallyOne.Game#matchSummary() の結果
     */
    showMatchStats(summary) {
      const mine = summary.winner === 'you';
      const label = summary.doubles
        ? { you: 'YOUチーム', cpu: 'CPUチーム' }
        : { you: 'YOU', cpu: 'CPU' };
      this.el.msTitle.textContent = mine ? 'あなたの勝ち' : 'CPU の勝ち';
      this.el.msTitle.classList.toggle('win', mine);
      this.el.msScore.textContent = `${label.you} ${summary.games.you} — ${summary.games.cpu} ${label.cpu}`;

      const rows = [row('head', '', { text: label.you }, { text: label.cpu })];
      STAT_ROWS.forEach((spec) => {
        // skip() は生の集計を受け取る（value() が畳んだ後の数字では「0回」と
        // 「そもそも機会が無かった」を見分けられない行があるため）。
        if (spec.skip && spec.skip(summary.you, summary.cpu)) return;
        rows.push(row('', spec.label, spec.value(summary.you), spec.value(summary.cpu)));
      });
      this.el.msTable.replaceChildren(...rows);

      // ラリーの長さは両チームで1本ずつ打ち合った結果なので、左右に分けず表の外に出す。
      this.el.msRally.textContent = summary.points
        ? `総ポイント ${summary.points} ／ 最長ラリー ${summary.longestRally}本 ／ 平均 ${summary.avgRally.toFixed(1)}本`
        : '';
      this.hideCall(); // 「ゲームセット」のコールと重ならないように引っ込める
      this.el.matchStats.classList.add('on');
    }

    hideMatchStats() {
      this.el.matchStats.classList.remove('on');
    }

    /**
     * リプレイ中の表示（「リプレイ ／ SPACE でスキップ」）。
     * 再生そのものは表示側（scene/world.js）が持っていて、ここはその状態を出すだけ。
     * @param {boolean} on world.isReplaying()
     */
    /**
     * @param {boolean} on リプレイ中か
     * @param {boolean} [mark] その最後で、クレーのボールマークを映しているか
     */
    setReplay(on, mark = false) {
      this.el.replayTag.classList.toggle('on', on);
      this.el.replayTag.classList.toggle('mark', on && mark);
    }

    /**
     * 溜めゲージ。サーブのときだけ「最大威力になる位置」の線を出す
     * （SERVE.CHARGE_SWEET_MARK＝9割の位置。game.serveTimingPower() と同じ基準）。
     * 線より長く押している間は赤く塗って、フォールトの確率が上がっていることを示す
     * （満タンの後は溜めが抜けて線より下へ戻るが、危険なのは変わらないので赤いまま）。
     * @param {number} fraction 溜め量 0〜1。0以下なら非表示。
     * @param {boolean} [serve] サーブの溜め中か（game.isServeCharging()）
     * @param {boolean} [special] いま離すと必殺技が出る状態か（バーを金色にする）
     * @param {boolean} [over] サーブを線より長く押しているか（game.isServeOvercharged()）
     */
    setCharge(fraction, serve = false, special = false, over = false) {
      const on = fraction > 0;
      this.el.charge.classList.toggle('on', on);
      this.el.charge.classList.toggle('serve', serve);
      this.el.charge.classList.toggle('special', special);
      if (!on) return;
      this.el.chargeMark.style.left = `${SERVE.CHARGE_SWEET_MARK * 100}%`;
      this.el.chargeFill.style.width = `${Math.min(fraction, 1) * 100}%`;
      // ラリーは「満タン＝最強」なので満タンで光らせる。サーブは線に届いた時点が最強
      // （そこから先は威力は増えずフォールトの危険だけが増える）ので、光る条件も線に合わせる。
      const sweet = serve ? SERVE.CHARGE_SWEET_MARK : 1;
      this.el.chargeFill.classList.toggle('full', fraction >= sweet);
      this.el.chargeFill.classList.toggle('over', serve && over);
    }
  }

  RallyOne.Hud = Hud;
})(window.RallyOne = window.RallyOne || {});
