// Nio site — sidebar rendering + state + mobile toggle.
// Renders the left nav from a single config; each page only needs <aside data-sidebar></aside>.
(() => {
  const LS_PREFIX = 'nio-sb-';

  // NAV config — paths are absolute from the site root.
  // Rendered to relative URLs based on the current page's depth so GitHub Pages
  // project sites (served at /<repo>/) work without a <base> tag.
  const NAV = [
    { id: 'overview', title: 'Overview', openByDefault: true, items: [
      { label: 'Home', path: '/' },
      { label: 'Getting Started', path: '/docs/getting-started.html' },
    ]},
    { id: 'install', title: 'Install', openByDefault: false, items: [
      { label: 'Claude Code', path: '/docs/install-claude-code.html' },
      { label: 'OpenClaw', path: '/docs/install-openclaw.html' },
    ]},
    { id: 'skill', title: 'Skill', openByDefault: true, items: [
      { label: '/nio commands', path: '/docs/skill.html' },
    ]},
    { id: 'configuration', title: 'Configuration', openByDefault: true, items: [
      { label: 'Config reference', path: '/docs/configuration.html' },
    ]},
    { id: 'pipeline', title: 'Pipeline', openByDefault: false, items: [
      { label: 'Overview', path: '/docs/phases/' },
      { label: 'Scoring', path: '/docs/phases/scoring.html' },
      { label: 'Phase 0 — Tool Gate', path: '/docs/phases/phase-0-tool-gate.html' },
      { label: 'Phase 1 — Allowlist', path: '/docs/phases/phase-1-allowlist.html' },
      { label: 'Phase 2 — Pattern', path: '/docs/phases/phase-2-pattern.html' },
      { label: 'Phase 3 — Static', path: '/docs/phases/phase-3-static.html' },
      { label: 'Phase 4 — Behavioural', path: '/docs/phases/phase-4-behavioural.html' },
      { label: 'Phase 5 — LLM', path: '/docs/phases/phase-5-llm.html' },
      { label: 'Phase 6 — External', path: '/docs/phases/phase-6-external.html' },
    ]},
  ];

  function detectBase() {
    // Find the deepest ancestor path of the current page that matches a known site
    // folder. For GitHub Pages project sites the URL starts with /<repo>/; everything
    // else is "same as path". We infer base by locating '/assets/shared.js' in <script>.
    const scripts = document.querySelectorAll('script[src*="assets/shared.js"]');
    for (const s of scripts) {
      const src = s.getAttribute('src') || '';
      const abs = new URL(src, document.baseURI);
      const idx = abs.pathname.lastIndexOf('/assets/shared.js');
      if (idx >= 0) return abs.pathname.slice(0, idx) || '/';
    }
    return '/';
  }

  function joinUrl(base, p) {
    // base ends with '/' or is '/'. p starts with '/'.
    if (base === '/') return p;
    if (p === '/') return base + '/';
    return base.replace(/\/$/, '') + p;
  }

  function currentPath() {
    let p = window.location.pathname;
    // canonical form: directories end with '/', 'index.html' → directory
    if (p.endsWith('/index.html')) p = p.slice(0, -'index.html'.length);
    return p;
  }

  function render(sidebar, base) {
    const here = currentPath();
    let matchedGroupId = null;

    const frag = document.createDocumentFragment();

    for (const group of NAV) {
      const d = document.createElement('details');
      d.dataset.group = group.id;

      const s = document.createElement('summary');
      s.textContent = group.title;
      d.appendChild(s);

      const nav = document.createElement('nav');
      for (const item of group.items) {
        const a = document.createElement('a');
        const href = joinUrl(base, item.path);
        a.href = href;
        a.textContent = item.label;

        // current-match: exact, or with/without trailing 'index.html'
        const normalizedHere = here.endsWith('/') ? here : here;
        const normalizedHref = (() => {
          const u = new URL(href, document.baseURI);
          let hp = u.pathname;
          if (hp.endsWith('/index.html')) hp = hp.slice(0, -'index.html'.length);
          return hp;
        })();
        if (normalizedHref === normalizedHere) {
          a.classList.add('current');
          matchedGroupId = group.id;
        }
        nav.appendChild(a);
      }
      d.appendChild(nav);
      frag.appendChild(d);
    }

    sidebar.innerHTML = '';
    sidebar.appendChild(frag);

    // determine open/closed state per group
    sidebar.querySelectorAll('details[data-group]').forEach((d) => {
      const id = d.dataset.group;
      const cfg = NAV.find((g) => g.id === id);
      const saved = localStorage.getItem(LS_PREFIX + id);
      if (id === matchedGroupId) {
        d.open = true;
      } else if (saved === 'open') {
        d.open = true;
      } else if (saved === 'closed') {
        d.open = false;
      } else {
        d.open = !!(cfg && cfg.openByDefault);
      }
      d.addEventListener('toggle', () => {
        localStorage.setItem(LS_PREFIX + id, d.open ? 'open' : 'closed');
      });
    });
  }

  function wireMobile(sidebar) {
    const hamburger = document.querySelector('.hamburger');
    if (!hamburger) return;
    hamburger.addEventListener('click', (ev) => {
      ev.stopPropagation();
      document.body.classList.toggle('sidebar-open');
    });
    document.addEventListener('click', (ev) => {
      if (!document.body.classList.contains('sidebar-open')) return;
      if (sidebar.contains(ev.target) || hamburger.contains(ev.target)) return;
      document.body.classList.remove('sidebar-open');
    });
    sidebar.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'A') {
        document.body.classList.remove('sidebar-open');
      }
    });
  }

  function wireBackToTop() {
    const btn = document.createElement('button');
    btn.className = 'back-to-top';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Back to top');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 8l4-4 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    document.body.appendChild(btn);

    let ticking = false;
    function update() {
      btn.classList.toggle('visible', window.scrollY > 100);
      ticking = false;
    }
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });
    update();

    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.querySelector('aside[data-sidebar]');
    if (sidebar) {
      const base = detectBase();
      render(sidebar, base);
      wireMobile(sidebar);
    }
    wireBackToTop();
  });
})();
