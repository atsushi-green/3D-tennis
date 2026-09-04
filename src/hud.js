/** スコアボード・コール表示・スタート画面。DOM に触るのはこのファイルだけ。 */
(function (RallyOne) {
  'use strict';

  const { pointLabel } = RallyOne.scoring;
  const {
    WIND, STAMINA, SKILLS, ROSTER, SKILL_MIN, SKILL_MAX, SKILL_DEFAULT, getRating,
  } = RallyOne.config;
  const $ = (id) => document.getElementById(id);

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
        startCta: $('startCta'),
        doublesCta: $('doublesCta'),
        tossChoice: $('tossChoice'),
        charge: $('charge'),
        chargeFill: $('chargeFill'),
        smashTip: $('smashTip'),
        roster: $('roster'),
        rosterTabs: $('rosterTabs'),
        rosterRows: $('rosterRows'),
        rosterFoot: $('rosterFoot'),
        rosterReset: $('rosterReset'),
        rosterRandom: $('rosterRandom'),
        diffOpts: [$('diffEasy'), $('diffNormal'), $('diffHard')],
        surfaceOpts: [$('surfHard'), $('surfClay'), $('surfGrass')],
        styleOpts: [
          $('styleNone'), $('styleServeVolley'), $('styleRetriever'), $('styleBaseliner'),
        ],
      };
    }

    /* ------------------------------------------------ 選手設定（能力値） */

    /**
     * スタート画面の「選手設定」パネルを組み立てる（main.js から一度だけ呼ぶ）。
     * 中身は config.ROSTER / config.SKILLS から作るので、項目を足したいときは config だけ
     * 触ればよい。値そのものは config が持っていて、ここは表示とクリックの受け付けだけ：
     * 実際の書き換えは main.js（onChange/onReset/onRandom）が config.setRating() 等で行う
     * ＝「難易度・サーフェスの選択は main が config に適用する」という既存の流れと同じ。
     *
     * 5段階を `<input type=range>` ではなく素の div の並びにしてあるのは、スタート画面が
     * 「どのキーを押しても開始」という作りで、フォーカスの当たる要素があると矢印キーや
     * Space で意図せず試合が始まってしまうため（div はフォーカスを取らない）。
     *
     * @param {{onChange:(who:string,key:string,value:number)=>void,
     *   onReset:()=>void, onRandom:()=>void}} handlers
     */
    buildRoster(handlers) {
      this.rosterWho = ROSTER[0].key;
      this.rosterDots = {}; // key ＝ 能力のキー、値 ＝ その行のドット要素の配列

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

        const dots = document.createElement('div');
        dots.className = 'rosterDots';
        this.rosterDots[skill.key] = [];
        for (let v = SKILL_MIN; v <= SKILL_MAX; v++) {
          const dot = document.createElement('div');
          dot.className = 'rosterDot';
          dot.title = `${skill.label} ${v}`;
          dot.addEventListener('click', () => {
            handlers.onChange(this.rosterWho, skill.key, v);
            this.renderRoster();
          });
          dots.appendChild(dot);
          this.rosterDots[skill.key].push(dot);
        }
        row.appendChild(dots);

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

    /** 今選ばれている選手の能力値をパネルに反映する（クリックのたびに呼ぶ）。 */
    renderRoster() {
      const who = this.rosterWho;
      Array.from(this.el.rosterTabs.children).forEach((tab, i) => {
        tab.classList.toggle('on', ROSTER[i].key === who);
      });
      let total = 0;
      SKILLS.forEach((skill) => {
        const value = getRating(who, skill.key);
        total += value;
        this.rosterDots[skill.key].forEach((dot, i) => {
          dot.classList.toggle('on', SKILL_MIN + i <= value);
        });
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
     * そのクリックが選手設定パネルの中で起きたか（＝「クリックで開始」に使ってはいけないか）。
     * スタート画面はどこをクリックしても始まる作りなので、この中だけは例外にする。
     */
    isRosterClick(target) {
      return !!(target && this.el.roster.contains(target));
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
      this.el.startCta.style.display = 'none';
      this.el.doublesCta.style.display = 'none';
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
