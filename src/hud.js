/** スコアボード・コール表示・スタート画面。DOM に触るのはこのファイルだけ。 */
(function (RallyOne) {
  'use strict';

  const { pointLabel } = RallyOne.scoring;
  const {
    GUIDE, WIND, STAMINA, SKILLS, ROSTER, SKILL_MIN, SKILL_MAX, SKILL_DEFAULT, getRating,
  } = RallyOne.config;
  /** ガイドで「タイミングが効かない」と伝えるときの打ち方の呼び名。 */
  const STROKE_LABEL = {
    smash: 'スマッシュ',
    'volley-forehand': 'ボレー',
    'volley-backhand': 'ボレー',
    forehand: 'ロブ／ドロップ',
    backhand: 'ロブ／ドロップ',
  };
  const $ = (id) => document.getElementById(id);
  /** その行（id）の中の選択ボタンを左から順に。 */
  const segs = (id) => Array.from($(id).querySelectorAll('.seg'));

  class Hud {
    constructor() {
      this.el = {
        names: { you: $('n1'), cpu: $('n2') },
        games: { you: $('g1'), cpu: $('g2') },
        points: { you: $('p1'), cpu: $('p2') },
        aces: { you: $('ace1'), cpu: $('ace2') },
        doubleFaults: { you: $('df1'), cpu: $('df2') },
        wind: $('wind'),
        serveSpeed: $('serveSpeed'),
        staminaFillYou: $('staminaFillYou'),
        staminaFillCpu: $('staminaFillCpu'),
        staminaFillYouMate: $('staminaFillYouMate'),
        staminaFillCpuMate: $('staminaFillCpuMate'),
        staminaRowYouMate: $('staminaRowYouMate'),
        staminaRowCpuMate: $('staminaRowCpuMate'),
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
        smashTip: $('smashTip'),
        guide: $('guide'),
        guideText: $('guideText'),
        guideNeedle: $('guideNeedle'),
        replayTag: $('replayTag'),
        roster: $('roster'),
        rosterTabs: $('rosterTabs'),
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
        guideOpts: segs('guideRow'),
        tossOpts: segs('tossChoice'),
      };
    }

    /**
     * スタート画面のボタンを配線する（main.js から一度だけ呼ぶ）。押したときに何をするかは
     * main.js が持っていて、ここは「どのボタンがどのハンドラか」を結ぶだけ＝キーボード側
     * （input.js）とまったく同じハンドラを呼ぶので、マウスとキーで挙動がずれない。
     * @param {{onSelectMode:(doubles:boolean)=>void, onSelectDifficulty:Function,
     *   onSelectSurface:Function, onSelectStyle:Function, onPlay:Function,
     *   onSelectToss:Function}} handlers
     */
    buildMenu(handlers) {
      const bind = (opts, fn) => opts.forEach((el) => {
        el.addEventListener('click', () => fn(el.dataset.level));
      });
      bind(this.el.modeOpts, (level) => handlers.onSelectMode(level === 'doubles'));
      bind(this.el.diffOpts, handlers.onSelectDifficulty);
      bind(this.el.surfaceOpts, handlers.onSelectSurface);
      bind(this.el.styleOpts, handlers.onSelectStyle);
      bind(this.el.guideOpts, (level) => handlers.onSelectGuide(level === 'on'));
      this.el.playBtn.addEventListener('click', () => handlers.onPlay());
      this.el.tossOpts.forEach((el) => {
        el.addEventListener('click', () => handlers.onSelectToss(el.dataset.choice));
      });
    }

    /* ------------------------------------------------ 選手設定（能力値） */

    /**
     * スタート画面の「選手設定」パネルを組み立てる（main.js から一度だけ呼ぶ）。
     * 中身は config.ROSTER / config.SKILLS から作るので、項目を足したいときは config だけ
     * 触ればよい。値そのものは config が持っていて、ここは表示とクリックの受け付けだけ：
     * 実際の書き換えは main.js（onChange/onReset/onRandom）が config.setRating() 等で行う
     * ＝「難易度・サーフェスの選択は main が config に適用する」という既存の流れと同じ。
     *
     * 1〜5は div で組んだ「つまみバー」（クリックでその値へ、つまみをドラッグで連続変更）。
     * `<input type=range>` を使わないのは、スタート画面が「どのキーを押しても開始」という
     * 作りで、フォーカスの当たる要素があると矢印キーや Space で意図せず試合が始まって
     * しまうため（div はフォーカスを取らない）。
     *
     * @param {{onChange:(who:string,key:string,value:number)=>void,
     *   onReset:()=>void, onRandom:()=>void}} handlers
     */
    buildRoster(handlers) {
      this.rosterWho = ROSTER[0].key;
      this.rosterBars = {}; // key ＝ 能力のキー、値 ＝ その行のバーの部品（renderRoster が使う）

      ROSTER.forEach((actor) => {
        const tab = document.createElement('div');
        tab.className = 'rosterTab';
        tab.textContent = actor.label;
        tab.title = actor.note;
        tab.addEventListener('click', () => {
          this.rosterWho = actor.key;
          this.renderRoster();
        });
        this.el.rosterTabs.appendChild(tab);
      });

      SKILLS.forEach((skill) => {
        const row = document.createElement('div');
        row.className = 'rosterRow';
        row.dataset.skill = skill.key;
        const name = document.createElement('div');
        name.className = 'rosterName';
        name.textContent = skill.label;
        row.appendChild(name);

        row.appendChild(this.buildSkillBar(skill, handlers));

        const hint = document.createElement('div');
        hint.className = 'rosterHint';
        hint.textContent = skill.hint;
        row.appendChild(hint);
        this.el.rosterRows.appendChild(row);
      });

      this.el.rosterReset.addEventListener('click', () => {
        handlers.onReset();
        this.renderRoster();
      });
      this.el.rosterRandom.addEventListener('click', () => {
        handlers.onRandom();
        this.renderRoster();
      });
      this.renderRoster();
    }

    /**
     * 能力1項目ぶんの「つまみバー」。バーのどこかを押すとその位置の値になり、押したまま
     * 左右へ動かすと連続で変わる（`setPointerCapture` を使うので、つまみからカーソルが
     * はみ出してもドラッグは続く）。値を持つのは config なので、ここは押された位置を
     * 1〜5に直して onChange へ渡すだけ。
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
        this.renderRoster();
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

    /** 今選ばれている選手の能力値をパネルに反映する（操作のたびに呼ぶ）。 */
    renderRoster() {
      const who = this.rosterWho;
      Array.from(this.el.rosterTabs.children).forEach((tab, i) => {
        tab.classList.toggle('on', ROSTER[i].key === who);
      });
      let total = 0;
      SKILLS.forEach((skill) => {
        const value = getRating(who, skill.key);
        total += value;
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
      const actor = ROSTER.find((r) => r.key === who);
      const neutral = SKILL_DEFAULT * SKILLS.length;
      this.el.rosterFoot.textContent = `${actor.label}（${actor.note}）— 合計 ${total}`
        + `／既定 ${neutral}。すべて${SKILL_DEFAULT}なら今までと同じ強さです。`;
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
    }

    /** スタート画面のCPUの強さ表示を切り替える（実際の適用は config.applyCpuLevel が行う）。 */
    setDifficulty(level) {
      this.el.diffOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === level));
    }

    /** スタート画面のサーフェス表示を切り替える（実際の適用は config.applySurface が行う）。 */
    setSurface(level) {
      this.el.surfaceOpts.forEach((el) => el.classList.toggle('on', el.dataset.level === level));
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
     * 風向き・強さの表示（ポイントごとに Game#newPoint() から呼ばれる）。
     * @param {number} accel 横方向の加速度(m/s²)。world +x はカメラの都合で画面の左に映るので、
     *   正の値（+x方向）は左向きの矢印にする。
     */
    setWind(accel) {
      const abs = Math.abs(accel);
      if (abs < WIND.DISPLAY_THRESHOLD) {
        this.el.wind.textContent = '無風';
        return;
      }
      const arrow = accel > 0 ? '←' : '→';
      this.el.wind.textContent = `風 ${arrow} ${abs.toFixed(1)}`;
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
     * @param {string} big 大きい方の文字（'ポイント'・'失点'・コール）
     * @param {string} [sub] 補足（'ウィナー！'・'ゲーム — YOU' など）
     * @param {string} [shot] 決めた側が最後に放った球種（'スマッシュ' など）。
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

    hideStartScreen() {
      this.el.start.style.display = 'none';
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
     * リプレイ中の表示（「リプレイ ／ SPACE でスキップ」）。
     * 再生そのものは表示側（scene/world.js）が持っていて、ここはその状態を出すだけ。
     * @param {boolean} on world.isReplaying()
     */
    setReplay(on) {
      this.el.replayTag.classList.toggle('on', on);
    }

    /** @param {number} fraction 溜め量 0〜1。0以下なら非表示。 */
    setCharge(fraction) {
      const on = fraction > 0;
      this.el.charge.classList.toggle('on', on);
      if (!on) return;
      this.el.chargeFill.style.width = `${Math.min(fraction, 1) * 100}%`;
      this.el.chargeFill.classList.toggle('full', fraction >= 1);
    }
  }

  RallyOne.Hud = Hud;
})(window.RallyOne = window.RallyOne || {});
