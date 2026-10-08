/* ==========================================================================
   EMALTED — увесь JavaScript сайту.
   Сайт повністю працює і без нього: тут лише «приємності».
   ========================================================================== */
(() => {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- 1. Перемикач теми «Денний режим» -----------------------------------
     За замовчуванням сайт темний. Вибір запам'ятовуємо в localStorage, а
     застосовує його ще до відмальовування крихітний скрипт у <head>.
     Інші скрипти (графіки диспетчерської) слухають подію emalted:theme. */
  const themeBtn = document.querySelector('[data-theme-toggle]');
  if (themeBtn) {
    const isLight = () => root.dataset.theme === 'light';
    const sync = () => themeBtn.setAttribute('aria-pressed', String(isLight()));
    sync();

    themeBtn.addEventListener('click', () => {
      const next = isLight() ? 'dark' : 'light';
      root.dataset.theme = next;
      try { localStorage.setItem('emalted-theme', next); } catch (e) { /* приватний режим */ }
      sync();
      document.dispatchEvent(new CustomEvent('emalted:theme'));
    });
  }

  /* --- 2. «Живі» телевимірювання на головній ------------------------------
     Значення трохи коливаються навколо номіналу, як на справжньому ОІК.
     Для тих, хто вимкнув анімації в системі, — статичні цифри. */
  const readouts = document.querySelectorAll('[data-telemetry]');
  if (readouts.length && !reduceMotion) {
    const fmt = (value, digits) =>
      value.toLocaleString('uk-UA', { minimumFractionDigits: digits, maximumFractionDigits: digits });

    setInterval(() => {
      if (document.hidden) return;
      readouts.forEach((el) => {
        const base = parseFloat(el.dataset.base);
        const spread = parseFloat(el.dataset.spread);
        const digits = parseInt(el.dataset.digits, 10);
        el.textContent = fmt(base + (Math.random() * 2 - 1) * spread, digits);
      });
    }, 2000);
  }

  /* --- 3. «Режим ПНР»: сайт показує власну верстку -------------------------
     Проходимо по елементах сторінки, беремо обчислений браузером display
     і для кожного grid/flex-контейнера малюємо рамку. Для Grid ще й
     колонки — їхню ширину в пікселях браузер віддає в gridTemplateColumns. */
  const pnrBtn = document.querySelector('[data-pnr-toggle]');
  const overlay = document.querySelector('[data-pnr-overlay]');
  const panel = document.querySelector('[data-pnr-panel]');
  if (pnrBtn && overlay && panel) {
    let active = false;
    let frame = 0;

    const px = (v) => parseFloat(v) || 0;
    const shortName = (el) => (el.classList[0] ? '.' + el.classList[0] : el.tagName.toLowerCase());

    const draw = () => {
      frame = 0;
      overlay.replaceChildren();
      overlay.style.height = document.documentElement.scrollHeight + 'px';
      let grids = 0;
      let flexes = 0;

      document.querySelectorAll('main *, .site-footer *').forEach((el) => {
        if (el.closest('svg') || el.matches('a, button, label, summary')) return;   // кнопки й посилання — не розкладка
        const cs = getComputedStyle(el);
        const isGrid = cs.display === 'grid' || cs.display === 'inline-grid';
        const isFlex = cs.display === 'flex' || cs.display === 'inline-flex';
        if (!isGrid && !isFlex) return;

        const r = el.getBoundingClientRect();
        if (r.width < 140 || r.height < 40) return;   // дрібні рядки не засмічують картину

        const box = document.createElement('div');
        box.className = 'pnr-box ' + (isGrid ? 'pnr-box--grid' : 'pnr-box--flex');
        Object.assign(box.style, {
          left: r.left + scrollX + 'px', top: r.top + scrollY + 'px',
          width: r.width + 'px', height: r.height + 'px',
        });

        const tag = document.createElement('span');
        tag.className = 'pnr-tag';

        if (isGrid) {
          grids++;
          const cols = cs.gridTemplateColumns.split(' ').filter((v) => v.endsWith('px')).map(px);
          const rows = cs.gridTemplateRows.split(' ').filter((v) => v.endsWith('px')).length;
          tag.textContent = `grid ${cols.length}×${rows} ${shortName(el)}`;
          if (cols.length > 1 && cols.length <= 12) {
            const gap = px(cs.columnGap);
            let x = px(cs.paddingLeft) + px(cs.borderLeftWidth);
            cols.forEach((w) => {
              const col = document.createElement('span');
              col.className = 'pnr-col';
              col.style.left = x + 'px';
              col.style.width = w + 'px';
              box.append(col);
              x += w + gap;
            });
          }
        } else {
          flexes++;
          const dir = cs.flexDirection.startsWith('column') ? 'стовпчик' : 'рядок';
          tag.textContent = `flex ${dir} ${shortName(el)}`;
        }

        box.append(tag);
        overlay.append(box);
      });

      panel.querySelector('[data-pnr-width]').textContent = `${innerWidth} px`;
      panel.querySelector('[data-pnr-grid]').textContent = grids;
      panel.querySelector('[data-pnr-flex]').textContent = flexes;
    };

    const schedule = () => { if (active && !frame) frame = requestAnimationFrame(draw); };

    const setActive = (on) => {
      active = on;
      pnrBtn.setAttribute('aria-pressed', String(on));
      panel.hidden = !on;
      try { sessionStorage.setItem('emalted-pnr', on ? '1' : '0'); } catch (e) { /* ignore */ }
      if (on) schedule(); else overlay.replaceChildren();
    };

    pnrBtn.addEventListener('click', () => setActive(!active));
    addEventListener('resize', schedule);
    addEventListener('scroll', schedule, { passive: true });   // «липкі» блоки рухаються
    document.addEventListener('change', schedule);               // фільтр, тумблери
    document.addEventListener('toggle', schedule, true);          // <details> у FAQ
    new ResizeObserver(schedule).observe(document.body);
    document.fonts && document.fonts.ready.then(schedule);

    // режим лишається увімкненим при переході між сторінками
    try { if (sessionStorage.getItem('emalted-pnr') === '1') setActive(true); } catch (e) { /* ignore */ }
  }

  /* --- 4. Поточний рік у підвалі ------------------------------------------- */
  document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });
})();
