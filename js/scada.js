/* ==========================================================================
   EMALTED — симуляція диспетчерського інтерфейсу (лише у браузері).
   Жодних мережевих запитів: модель підстанції живе в об'єкті S, раз на
   секунду tick() перераховує режим, а render() малює його на сторінці.

   Структура файлу:
     1. Модель і похідні величини        5. Команди: вибір і виконання (SBO)
     2. Блокування (ті самі 7 умов)       6. Сценарії і режими
     3. Тривоги і журнал подій            7. Тренди на <canvas>
     4. Відображення стану                8. Запуск і обробники подій
   ========================================================================== */
(() => {
  'use strict';

  const hmi = document.querySelector('[data-hmi]');
  if (!hmi) return;

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const fmt = (v, d = 0) => v.toLocaleString('uk-UA', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const stamp = (t = new Date()) => `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
  const jitter = (v, k) => v + (Math.random() * 2 - 1) * k;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lower1 = (t) => t.charAt(0).toLowerCase() + t.slice(1);   // «QE», «REMOTE» лишаються великими

  /* --- 1. Модель ---------------------------------------------------------- */
  const S = {
    mode: 'REMOTE',          // місце керування: REMOTE (АРМ / ДЦ) або LOCAL (шафа)
    estop: false,            // аварійне відключення
    channel: 1,              // канал зв'язку з ДЦ: 1 — основний, 2 — резервний
    cooling: 'AUTO',         // охолодження Т1: AUTO або MANUAL
    fans: false,
    oil: 58,                 // температура верхніх шарів масла Т1, °C
    f: 50,
    u110: 115.2,
    fault: null,             // приєднання, на якому зараз «коротке замикання»
    br: {
      Q1:  { bay: 'Л-1 110 кВ', kind: 'hv' },
      Q10: { bay: 'Ввід 10 кВ', kind: 'incomer' },
      Q11: { bay: 'Ф-11', kind: 'feeder', load: 5.2 },
      Q12: { bay: 'Ф-12', kind: 'feeder', load: 6.4 },
      Q13: { bay: 'Ф-13', kind: 'feeder', load: 4.3 },
    },
  };
  Object.values(S.br).forEach((b) => Object.assign(b, { closed: true, tripped: false, protOk: true, spring: true, cart: true, earth: false }));

  const feeders = ['Q11', 'Q12', 'Q13'];
  const COS_PHI = 0.95;

  // Похідні величини: що під напругою, які струми і потужності
  const derive = () => {
    const hvLive = S.br.Q1.closed;
    const busLive = hvLive && S.br.Q10.closed;
    const P = {};
    feeders.forEach((id) => { P[id] = busLive && S.br[id].closed ? S.br[id].load : 0; });
    const pTotal = feeders.reduce((s, id) => s + P[id], 0);
    const u10 = busLive ? 10.58 - 0.011 * pTotal : 0;
    const amps = (p, u) => (u > 0 ? (p * 1000) / (Math.sqrt(3) * u * COS_PHI) : 0);
    const I = {};
    feeders.forEach((id) => { I[id] = amps(P[id], u10); });
    I.Q10 = feeders.reduce((s, id) => s + I[id], 0);
    I.Q1 = hvLive ? amps(pTotal, S.u110) : 0;
    P.Q10 = pTotal;
    P.Q1 = hvLive ? pTotal : 0;
    if (S.fault && busLive) { I[S.fault] = 3150; I.Q10 += 3150; }   // струм КЗ на один такт
    return { hvLive, busLive, u10, pTotal, P, I };
  };

  /* --- 2. Блокування ------------------------------------------------------
     Для приєднань 10 кВ — рівно ті сім умов, що на сторінці «Рішення». */
  const conditions = (id) => {
    const b = S.br[id];
    const d = derive();
    const list = [
      ['Немає аварійного відключення', !S.estop],
      ['Захист приєднання справний', b.protOk],
    ];
    if (b.kind === 'feeder') {
      list.push(['Візок вимикача в робочому положенні', b.cart]);
      list.push(['Заземлювальний ніж QE вимкнений', !b.earth]);
    }
    list.push(['Режим керування REMOTE', S.mode === 'REMOTE']);
    if (b.kind === 'feeder') list.push(['Напруга на секції шин у нормі', d.busLive && d.u10 >= 9.0]);
    if (b.kind === 'incomer') list.push(['Трансформатор Т1 під напругою', d.hvLive]);
    list.push(['Пружину приводу заведено', b.spring]);
    return list.map(([text, ok]) => ({ text, ok }));
  };

  /* --- 3. Тривоги і журнал ------------------------------------------------
     Життєвий цикл як у ISA-18.2: тривога може бути активною чи ні і
     квитованою чи ні. Зі списку вона зникає, лише коли обидва «так»:
     умова минула І оператор її побачив. */
  const alarms = new Map();
  const log = [];
  const LOG_MAX = 200;
  const logEl = $('[data-log]');
  const alarmsEl = $('[data-alarms]');

  const addLog = (prio, text) => {
    const entry = { t: new Date(), prio, text };
    log.unshift(entry);
    if (log.length > LOG_MAX) log.pop();
    const li = document.createElement('li');
    li.dataset.prio = prio;
    li.innerHTML = `<time>${stamp(entry.t)}</time><span class="prio prio--${prio}">${prio}</span><span></span>`;
    li.lastChild.textContent = text;
    logEl.prepend(li);
    while (logEl.children.length > LOG_MAX) logEl.lastChild.remove();
    $('[data-count="log"]').textContent = log.length;
  };

  const raise = (id, prio, text) => {
    const a = alarms.get(id);
    if (a && a.active) return;
    alarms.set(id, { id, prio, text, t: new Date(), active: true, acked: false });
    addLog(prio, text);
    renderAlarms();
  };
  const clear = (id) => {
    const a = alarms.get(id);
    if (!a || !a.active) return;
    a.active = false;
    addLog('INFO', `Повернення в норму: ${a.text}`);
    if (a.acked) alarms.delete(id);
    renderAlarms();
  };
  const ack = (id) => {
    const a = alarms.get(id);
    if (!a || a.acked) return;
    a.acked = true;
    addLog('INFO', `Квитовано оператором: ${a.text}`);
    if (!a.active) alarms.delete(id);
    renderAlarms();
  };
  let transientId = 0;
  const notice = (prio, text) => {   // разова подія, яку теж треба квитувати
    if (prio === 'INFO') { addLog(prio, text); return; }
    const id = `t${++transientId}`;
    alarms.set(id, { id, prio, text, t: new Date(), active: false, acked: false });
    addLog(prio, text);
    renderAlarms();
  };

  const renderAlarms = () => {
    const list = [...alarms.values()].sort((a, b) => (a.prio === b.prio ? b.t - a.t : a.prio === 'ALARM' ? -1 : 1));
    alarmsEl.replaceChildren(...list.map((a) => {
      const li = document.createElement('li');
      li.className = 'alarm';
      li.dataset.prio = a.prio;
      li.dataset.acked = String(a.acked);
      li.innerHTML = `
        <span class="prio prio--${a.prio}">${a.prio}</span>
        <span class="alarm__meta">${stamp(a.t)}</span>
        <span class="alarm__text"></span>
        <span class="alarm__state">${a.active ? 'активна' : 'умова минула'}${a.acked ? ', квитовано' : ''}</span>`;
      li.querySelector('.alarm__text').textContent = a.text;
      if (!a.acked) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--ghost btn--small';
        btn.textContent = 'Квитувати';
        btn.addEventListener('click', () => ack(a.id));
        li.append(btn);
      }
      return li;
    }));
    $('[data-count="active"]').textContent = alarms.size;
    renderStatus();
  };

  /* --- 4. Відображення стану ------------------------------------------------ */
  const STATE_TEXT = { closed: 'ВКЛ', open: 'ВИКЛ', tripped: 'ВІДКЛ. ЗАХИСТОМ' };
  const brState = (b) => (b.closed ? 'closed' : b.tripped ? 'tripped' : 'open');
  const setText = (sel, text) => $$(sel).forEach((el) => { el.textContent = text; });
  const setLamp = (name, cls, blink = false) => {
    const el = $(`[data-lamp="${name}"]`);
    el.className = `lamp ${cls}${blink ? ' lamp--blink' : ''}`;
  };

  let last = derive();

  const renderStatus = () => {
    const active = [...alarms.values()].filter((a) => a.active);
    const unacked = [...alarms.values()].filter((a) => !a.acked).length;
    const level = active.some((a) => a.prio === 'ALARM') ? 'alarm' : active.length ? 'warn' : 'ok';
    setText('[data-text="system"]', { alarm: 'АВАРІЯ', warn: 'ПОПЕРЕДЖЕННЯ', ok: 'НОРМА' }[level]);
    setLamp('system', { alarm: 'lamp--danger', warn: 'lamp--alarm', ok: 'lamp--on' }[level]);
    setText('[data-text="alarms"]', unacked);
    setLamp('alarms', unacked ? 'lamp--alarm' : '', unacked > 0);
    setText('[data-text="comms"]', S.channel === 1 ? 'Канал 1' : 'Канал 2, резерв');
    setLamp('comms', S.channel === 1 ? 'lamp--on' : 'lamp--alarm');
    setText('[data-text="mode"]', S.mode);
    setLamp('mode', S.mode === 'REMOTE' ? 'lamp--blue' : 'lamp--alarm');
  };

  const render = () => {
    const d = last;
    const live = {
      'q1-t1': d.hvLive, 't1-hv': d.hvLive, 't1-lv': d.hvLive, 't1-q10': d.hvLive,
      'q10-bus': d.busLive, bus: d.busLive,
    };
    feeders.forEach((id) => {
      live[`up-${id}`] = d.busLive;
      live[`down-${id}`] = d.busLive && S.br[id].closed;
      live[`arrow-${id}`] = live[`down-${id}`];
    });
    $$('[data-seg]').forEach((el) => el.classList.toggle('is-live', Boolean(live[el.dataset.seg])));

    Object.entries(S.br).forEach(([id, b]) => {
      const st = brState(b);
      const g = $(`[data-breaker="${id}"]`);
      g.dataset.state = st;
      $(`[data-state-text="${id}"]`).textContent = STATE_TEXT[st];
      const pill = $(`[data-pill="${id}"]`);
      pill.dataset.state = st;
      pill.textContent = STATE_TEXT[st];
      setText(`[data-v="I-${id}"]`, fmt(d.I[id] || 0));
      setText(`[data-v="P-${id}"]`, fmt(d.P[id] || 0, 1));
    });

    setText('[data-v="U110"]', fmt(S.u110, 1));
    setText('[data-v="U10"]', fmt(d.u10, 2));
    setText('[data-v="oil"]', fmt(S.oil, 1));
    setText('[data-v="fans"]', `${S.fans ? 'RUN' : 'STOP'}, ${S.cooling}`);
    renderStatus();
    if (dialog.open) renderDialog();
  };

  /* --- 5. Команди: вибір і виконання (select before operate) ---------------- */
  const dialog = $('[data-dialog]');
  const dlg = (k) => $(`[data-dlg="${k}"]`, dialog);
  const execBtn = $('[data-execute]', dialog);
  let current = null;        // вимикач, відкритий у діалозі
  let selected = null;       // { action, until }
  const SBO_MS = 10000;

  const say = (text, tone = '') => {
    const m = dlg('msg');
    m.textContent = text;
    m.dataset.tone = tone;
  };

  const renderDialog = () => {
    const b = S.br[current];
    dlg('id').textContent = current;
    dlg('bay').textContent = b.bay;
    dlg('state').textContent = STATE_TEXT[brState(b)];
    dlg('conds').replaceChildren(...conditions(current).map((c) => {
      const li = document.createElement('li');
      li.dataset.ok = String(c.ok);
      li.innerHTML = '<span class="lamp"></span><span></span>';
      li.lastChild.textContent = c.text;
      return li;
    }));
    dlg('simbox').hidden = b.kind !== 'feeder';
    $('[data-sim="cart"]', dialog).checked = b.cart;
    $('[data-sim="earth"]', dialog).checked = b.earth;
    $('[data-sim="spring"]', dialog).checked = b.spring;
    if (selected) {
      const left = Math.ceil((selected.until - Date.now()) / 1000);
      if (left <= 0) {
        selected = null;
        execBtn.disabled = true;
        say('Час на підтвердження минув, вибір скасовано.', 'bad');
      } else {
        execBtn.textContent = `Виконати (${left} с)`;
      }
    }
  };

  const openDialog = (id) => {
    current = id;
    selected = null;
    execBtn.disabled = true;
    execBtn.textContent = 'Виконати';
    say('');
    renderDialog();
    dialog.showModal();
  };

  const selectCmd = (action) => {
    const b = S.br[current];
    const verb = action === 'close' ? 'увімкнути' : 'вимкнути';
    selected = null;
    execBtn.disabled = true;
    execBtn.textContent = 'Виконати';
    if (S.mode !== 'REMOTE') {
      say('Команду відхилено: режим LOCAL, керування лише з шафи.', 'bad');
      addLog('WARNING', `${current}: команду «${verb}» з АРМ відхилено, режим LOCAL`);
      return;
    }
    if ((action === 'close') === b.closed) {
      say(`Вимикач уже ${b.closed ? 'увімкнений' : 'вимкнений'}.`, 'bad');
      return;
    }
    if (action === 'close') {
      const failed = conditions(current).filter((c) => !c.ok);
      if (failed.length) {
        say(`Блокування: ${failed.map((c) => lower1(c.text)).join('; ')}.`, 'bad');
        addLog('WARNING', `${current}: команду «увімкнути» заблоковано (${lower1(failed[0].text)})`);
        return;
      }
    }
    selected = { action, until: Date.now() + SBO_MS };
    execBtn.disabled = false;
    say(`Вибрано: ${verb} ${current}. Підтвердіть протягом 10 с.`, 'good');
    addLog('INFO', `${current}: вибрано команду «${verb}»`);
    renderDialog();
  };

  const execute = () => {
    if (!selected) return;
    const { action } = selected;
    const b = S.br[current];
    selected = null;
    execBtn.disabled = true;
    execBtn.textContent = 'Виконати';
    // між вибором і виконанням умови могли змінитися — перевіряємо ще раз
    if (action === 'close' && conditions(current).some((c) => !c.ok)) {
      say('За час підтвердження з’явилось блокування. Команду не виконано.', 'bad');
      addLog('WARNING', `${current}: виконання «увімкнути» скасовано блокуванням`);
      renderDialog();
      return;
    }
    b.closed = action === 'close';
    if (b.closed) { b.tripped = false; clear(`trip-${current}`); }
    addLog('INFO', `${current} (${b.bay}): ${b.closed ? 'увімкнено' : 'вимкнено'} командою з АРМ`);
    say(`Виконано: ${current} ${b.closed ? 'увімкнено' : 'вимкнено'}.`, 'good');
    last = derive();
    render();
  };

  // «Стан приєднання для експерименту» — з власними блокуваннями, як у КРУ:
  // візок не викотити під навантаженням, а ніж не увімкнути на робочий візок.
  const simChange = (e) => {
    const key = e.target.dataset.sim;
    if (!key) return;
    const b = S.br[current];
    const want = e.target.checked;
    if (key === 'cart' && !want && b.closed) {
      e.target.checked = true;
      say('Візок не можна викотити, поки вимикач увімкнений.', 'bad');
      return;
    }
    if (key === 'earth' && want && (b.closed || b.cart)) {
      e.target.checked = false;
      say('Заземлювальний ніж блоковано: спершу вимкніть вимикач і викотіть візок.', 'bad');
      return;
    }
    b[key] = want;
    const text = {
      cart: want ? 'візок вкочено в робоче положення' : 'візок викочено в контрольне положення',
      earth: want ? 'заземлювальний ніж QE увімкнено' : 'заземлювальний ніж QE вимкнено',
      spring: want ? 'пружину приводу заведено' : 'пружина приводу не заведена',
    }[key];
    addLog(key === 'spring' && !want ? 'WARNING' : 'INFO', `${b.bay}: ${text}`);
    say('');
    renderDialog();
  };

  /* --- 6. Сценарії і режими ---------------------------------------------------- */
  const RANDOM_EVENTS = [
    ['INFO', 'Т1: РПН перемкнувся на ступінь 9'],
    ['INFO', 'Сервер часу: синхронізацію з GNSS підтверджено'],
    ['INFO', 'LAN B: порт 7 комутатора відновив зв’язок'],
    ['WARNING', 'Шафа ШАП-3: відчинено двері'],
    ['WARNING', 'Акумуляторна батарея 220 В: напруга 212 В'],
    ['WARNING', 'Сервер SCADA 2: перехід у резерв, основний — сервер 1'],
  ];

  const scenarios = {
    fault() {
      if (!S.br.Q12.closed || !last.busLive) {
        addLog('INFO', 'Ф-12 знеструмлене: імітація КЗ не впливає на систему');
        return;
      }
      S.fault = 'Q12';   // один такт зі струмом КЗ, потім спрацьовує захист
    },
    protfail(btn) {
      const b = S.br.Q13;
      b.protOk = !b.protOk;
      if (b.protOk) clear('prot-Q13');
      else raise('prot-Q13', 'WARNING', 'Ф-13: несправність терміналу захисту, вмикання заблоковано');
      btn.textContent = b.protOk ? 'Несправність захисту Ф-13' : 'Відновити захист Ф-13';
    },
    comms(btn) {
      S.channel = S.channel === 1 ? 2 : 1;
      if (S.channel === 2) raise('comms', 'WARNING', 'ДЦ: обрив каналу 1, обмін IEC 104 переведено на резервний канал 2');
      else clear('comms');
      btn.textContent = S.channel === 1 ? 'Обрив каналу 1 до ДЦ' : 'Відновити канал 1';
    },
    event() {
      const [prio, text] = RANDOM_EVENTS[Math.floor(Math.random() * RANDOM_EVENTS.length)];
      notice(prio, text);
    },
    estop(btn) {
      S.estop = !S.estop;
      btn.setAttribute('aria-pressed', String(S.estop));
      btn.textContent = S.estop ? 'Скинути EMERGENCY' : 'EMERGENCY';
      if (S.estop) {
        ['Q1', 'Q10'].forEach((id) => { S.br[id].closed = false; });
        raise('estop', 'ALARM', 'EMERGENCY: аварійне відключення, Q1 і Q10 вимкнено');
      } else {
        clear('estop');
        addLog('INFO', 'EMERGENCY скинуто. Вмикання знову можливе за умовами блокувань');
      }
    },
  };

  /* --- 7. Тренди --------------------------------------------------------------- */
  const POINTS = 120;
  const MIN_SPAN = { u: 0.2, i: 60, p: 0.6, f: 0.06 };
  const DIGITS = { u: 2, i: 0, p: 1, f: 2 };
  const series = { u: [], i: [], p: [], f: [] };
  const canvases = Object.fromEntries($$('[data-trend]').map((c) => [c.dataset.trend, c]));

  const sample = (d) => ({ u: d.u10, i: d.I.Q10, p: d.pTotal, f: S.f });

  const drawTrend = (key) => {
    const canvas = canvases[key];
    const data = series[key];
    const css = getComputedStyle(document.documentElement);
    const color = (n) => css.getPropertyValue(n).trim();
    const { width, height } = canvas.getBoundingClientRect();
    if (!width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    let lo = Math.min(...data);
    let hi = Math.max(...data);
    if (hi - lo < MIN_SPAN[key]) { const mid = (hi + lo) / 2; lo = mid - MIN_SPAN[key] / 2; hi = mid + MIN_SPAN[key] / 2; }
    const padY = (hi - lo) * 0.12;
    const nonNegative = data.every((v) => v >= 0);   // струм, напруга, потужність не бувають < 0
    lo = nonNegative ? Math.max(0, lo - padY) : lo - padY;
    hi += padY;
    const left = 44;
    const x = (i) => left + (i / (POINTS - 1)) * (width - left - 4);
    const y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (height - 12);

    ctx.font = `600 11px ${color('--f-text')}`;
    ctx.fillStyle = color('--c-ink-2');
    ctx.strokeStyle = color('--c-line-soft');
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 2; k++) {
      const v = lo + ((hi - lo) * k) / 2;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(width, yy); ctx.stroke();
      ctx.fillText(fmt(v, DIGITS[key]), 0, yy);
    }

    ctx.strokeStyle = color('--c-blue');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();

    $(`[data-trend-value="${key}"]`).textContent = fmt(data[data.length - 1], DIGITS[key]);
  };
  const drawTrends = () => Object.keys(canvases).forEach(drawTrend);

  /* --- 8. Такт моделі і запуск ---------------------------------------------- */
  const tick = () => {
    // навантаження приєднань і частота повільно «дихають»
    feeders.forEach((id) => {
      const b = S.br[id];
      const base = { Q11: 5.2, Q12: 6.4, Q13: 4.3 }[id];
      b.load = clamp(jitter(b.load, 0.08), base * 0.9, base * 1.1);
    });
    S.f = clamp(jitter(S.f, 0.006), 49.96, 50.04);
    S.u110 = clamp(jitter(S.u110, 0.15), 114.2, 116.2);

    let d = derive();

    // КЗ: один такт струму короткого замикання, потім захист відключає вимикач
    if (S.fault) {
      const id = S.fault;
      S.fault = null;
      Object.values(series).forEach((s) => s.shift());
      const spike = sample(d);
      Object.keys(series).forEach((k) => series[k].push(spike[k]));
      Object.assign(S.br[id], { closed: false, tripped: true });
      raise(`trip-${id}`, 'ALARM', `${S.br[id].bay}: спрацював МСЗ, ${id} відключено захистом`);
      last = derive();
      render();
      drawTrends();
      return;
    }

    // Т1: прискорена теплова модель, щоб гістерезис AUTO було видно за хвилину
    const target = 30 + 3.0 * d.pTotal - (S.fans ? 24 : 0);
    S.oil += (target - S.oil) * 0.04;
    if (S.cooling === 'AUTO') {
      if (!S.fans && S.oil > 65) { S.fans = true; addLog('INFO', `Охолодження Т1: автоматичний пуск, масло ${fmt(S.oil, 1)} °C`); }
      if (S.fans && S.oil < 55) { S.fans = false; addLog('INFO', `Охолодження Т1: автоматична зупинка, масло ${fmt(S.oil, 1)} °C`); }
    }
    if (S.oil > 75) raise('oil', 'WARNING', 'Т1: температура масла понад 75 °C');
    if (S.oil < 73) clear('oil');

    last = d;
    Object.values(series).forEach((s) => s.shift());
    const s = sample(d);
    Object.keys(series).forEach((k) => series[k].push(s[k]));
    render();
    drawTrends();
  };

  // Початкове заповнення трендів, щоб графіки не були порожніми
  (() => {
    const d = derive();
    for (let i = 0; i < POINTS; i++) {
      series.u.push(jitter(d.u10, 0.01));
      series.i.push(jitter(d.I.Q10, 6));
      series.p.push(jitter(d.pTotal, 0.1));
      series.f.push(jitter(50, 0.01));
    }
  })();

  // Обробники
  $$('[data-breaker]').forEach((g) => {
    g.addEventListener('click', () => openDialog(g.dataset.breaker));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDialog(g.dataset.breaker); }
    });
  });
  $$('[data-open]').forEach((btn) => btn.addEventListener('click', () => openDialog(btn.dataset.open)));
  $$('[data-select]', dialog).forEach((btn) => btn.addEventListener('click', () => selectCmd(btn.dataset.select)));
  execBtn.addEventListener('click', execute);
  dialog.addEventListener('change', simChange);
  dialog.addEventListener('close', () => { selected = null; current = null; });

  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
    S.mode = r.value;
    addLog('INFO', `Місце керування: ${S.mode}`);
    render();
  }));
  const fanBtns = $$('[data-fans]');
  $$('input[name="cooling"]').forEach((r) => r.addEventListener('change', () => {
    S.cooling = r.value;
    fanBtns.forEach((b) => { b.disabled = S.cooling !== 'MANUAL'; });
    addLog('INFO', `Охолодження Т1: режим ${S.cooling}`);
    render();
  }));
  fanBtns.forEach((btn) => btn.addEventListener('click', () => {
    S.fans = btn.dataset.fans === 'START';
    addLog('INFO', `Охолодження Т1: ${btn.dataset.fans} вручну`);
    render();
  }));
  $$('[data-scenario]').forEach((btn) => btn.addEventListener('click', () => {
    scenarios[btn.dataset.scenario](btn);
    last = derive();
    render();
  }));
  $('[data-ack-all]').addEventListener('click', () => [...alarms.keys()].forEach(ack));

  const clock = $('[data-clock]');
  const tickClock = () => {
    const t = new Date();
    clock.textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    clock.dateTime = t.toISOString();
  };

  // перемальовуємо графіки при зміні розміру і теми
  new ResizeObserver(drawTrends).observe($('.trends'));
  document.addEventListener('emalted:theme', drawTrends);

  addLog('INFO', 'Симуляцію запущено. Усі вимикачі увімкнені, режим REMOTE');
  tickClock();
  render();
  drawTrends();
  setInterval(tickClock, 1000);
  setInterval(tick, 1000);
  setInterval(() => { if (dialog.open && selected) renderDialog(); }, 250);
})();
