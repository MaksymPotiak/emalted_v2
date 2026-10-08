/* ==========================================================================
   Вкладки за шаблоном WAI-ARIA Tabs.
   У HTML усі панелі відкриті: без JS їх просто видно одна під одною.
   Скрипт при запуску ховає неактивні і вмикає перемикання.
   Клавіатура: ← → між вкладками, Home / End — перша й остання.
   ========================================================================== */
(() => {
  'use strict';

  document.querySelectorAll('[data-tabs]').forEach((box) => {
    const tabs = [...box.querySelectorAll(':scope > [role="tablist"] [role="tab"]')];
    const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'));

    const select = (tab, focus = true) => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        panelOf(t).hidden = !on;
      });
      if (focus) tab.focus();
      box.dispatchEvent(new CustomEvent('tabs:change', { detail: tab.id }));
    };

    select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0], false);

    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (e) => {
        const last = tabs.length - 1;
        const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        select(tabs[next]);
      });
    });
  });
})();
