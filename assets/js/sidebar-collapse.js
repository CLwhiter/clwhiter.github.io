/*!
 * Phase 5: Collapsible Desktop Sidebar — behavior script
 * Loaded deferred from _includes/metadata-hook.html.
 *
 * Responsibilities:
 *  - Re-enable CSS transitions AFTER the first paint (NAV-06 no-flash linchpin, D-05).
 *  - Wire the #sidebar-collapse click handler: toggle the data-sidebar-collapsed
 *    attribute on <html>, persist to localStorage, update aria-expanded/aria-label.
 *
 * Security (T-05-01 mitigation): the localStorage value is ONLY compared with
 * === 'true' / written as a literal string. It is never parsed as HTML, never
 * injected into the DOM via the inner-HTML sink, never executed via the eval
 * function, and never written via the document-write API. The glyph is a static
 * CSS content value, not user input. Every localStorage access is
 * try/catch-wrapped so private-mode / storage-disabled browsers degrade to
 * default-expanded (Pitfall 5).
 */
(function () {
  'use strict';

  var ROOT = document.documentElement;
  var PAUSED = 'sb-transition-paused';
  var btn = document.getElementById('sidebar-collapse');

  function isCollapsed() {
    return ROOT.hasAttribute('data-sidebar-collapsed');
  }

  function apply(collapsed) {
    /* D-03: toggle the root attribute that drives all collapse CSS */
    ROOT.toggleAttribute('data-sidebar-collapsed', collapsed);

    /* Persist across navigation/refresh (Pitfall 5: try/catch) */
    try {
      localStorage.setItem('sidebar-collapsed', collapsed ? 'true' : 'false');
    } catch (e) {
      /* localStorage unavailable — keep the in-memory toggle, skip persistence */
    }

    /* NAV-04 / a11y: reflect state on the button (WAI-ARIA disclosure pattern) */
    if (btn) {
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    }
  }

  /* D-05 / NAV-06: re-enable transitions AFTER the first paint.
     The inline <head> script added sb-transition-paused before <body> painted;
     one frame renders with transition:none — then we remove the pause so future
     clicks animate. The nested double-rAF guarantees a painted frame in between
     (requestAnimationFrame fires before paint; nesting twice ensures one frame
     has actually been rendered with transitions off). */
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      ROOT.classList.remove(PAUSED);
    });
  });

  /* Reflect the initial (pre-paint) state on the button and wire the click */
  if (btn) {
    btn.setAttribute('aria-expanded', String(!isCollapsed()));
    btn.setAttribute('aria-label', isCollapsed() ? 'Expand sidebar' : 'Collapse sidebar');
    btn.addEventListener('click', function () {
      apply(!isCollapsed());
    });
  }
})();
