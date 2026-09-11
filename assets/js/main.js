/* ============================================================
   Triplipi — Main JavaScript
   All interactions, animations, navigation behaviors.
   Vanilla JS only. No dependencies.
   ============================================================ */

(function () {
  'use strict';

  // ============================================================
  // UTILITIES
  // ============================================================
  const $  = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);

  const debounce = (fn, ms = 100) => {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  // Lock body scroll (for modal/menu open)
  const lockScroll = (lock) => {
    document.body.classList.toggle('no-scroll', !!lock);
  };

  // Trap focus inside an element (for accessibility on modals)
  const trapFocus = (container) => {
    const focusables = $$('a,button,input,textarea,select,[tabindex]:not([tabindex="-1"])', container)
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!focusables.length) return () => {};
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const handler = (e) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    container.addEventListener('keydown', handler);
    first.focus();
    return () => container.removeEventListener('keydown', handler);
  };


  // ============================================================
  // STICKY HEADER + INVERTED STATE OVER DARK HEROES
  // ============================================================
  const header = $('.site-header');
  const initHeader = () => {
    if (!header) return;
    // Check if page has a dark hero (inverted state)
    const darkHero = $('.hero, .page-hero.has-image');
    if (darkHero) header.classList.add('is-inverted');

    let lastY = 0;
    const onScroll = () => {
      const y = window.scrollY;
      header.classList.toggle('is-scrolled', y > 40);
      lastY = y;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  };


  // ============================================================
  // MEGA MENU (Desktop)
  // ============================================================
  // Mark the nav tab matching the current page (FRS active-underline)
  const initActiveNav = () => {
    const path = (window.location.pathname.replace(/\/+$/, '') || '/');
    // Several links can share a path (a tab and a dropdown trigger can both lead
    // to /destinations) — underline only the first, best match.
    let best = null, bestLen = 0;
    $$('.nav-link').forEach((l) => {
      const href = l.getAttribute('href') || l.dataset.path || '';
      const p = href.replace(/\/+$/, '');
      if (!p) return;
      const hit = p === path || (p !== '/' && path.indexOf(p) === 0);
      if (hit && p.length > bestLen) { best = l; bestLen = p.length; }
    });
    if (best) best.classList.add('is-active');
  };

  const initMegaMenu = () => {
    const triggers = $$('.nav-link[data-mega]');
    const megas = $$('.mega');
    const backdrop = $('.mega-backdrop');
    let activeMega = null;
    let hoverTimer = null;

    const closeAll = () => {
      megas.forEach(m => m.classList.remove('is-open'));
      triggers.forEach(t => t.setAttribute('aria-expanded', 'false'));
      backdrop && backdrop.classList.remove('is-open');
      activeMega = null;
    };

    triggers.forEach(trigger => {
      const targetId = trigger.dataset.mega;
      const target = $(`#${targetId}`);
      if (!target) return;

      const open = () => {
        clearTimeout(hoverTimer);
        if (activeMega && activeMega !== target) {
          activeMega.classList.remove('is-open');
        }
        // moving straight from one trigger to the next: only the hovered one may look open
        triggers.forEach(t => { if (t !== trigger) t.setAttribute('aria-expanded', 'false'); });
        // Anchor list-style dropdowns under their trigger button
        if (target.classList.contains('mega-list')) {
          const rect = trigger.getBoundingClientRect();
          const maxLeft = window.innerWidth - target.offsetWidth - 12;
          const left = Math.max(12, Math.min(rect.left, maxLeft));
          target.style.left = Math.round(left) + 'px';
        }
        target.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        backdrop && backdrop.classList.add('is-open');
        activeMega = target;
      };
      const scheduleClose = () => {
        hoverTimer = setTimeout(closeAll, 200);
      };

      on(trigger, 'mouseenter', open);
      on(trigger, 'focus', open);
      on(trigger, 'mouseleave', scheduleClose);
      on(target, 'mouseenter', () => clearTimeout(hoverTimer));
      on(target, 'mouseleave', scheduleClose);

      // Click toggle (for keyboard/touch)
      on(trigger, 'click', (e) => {
        e.preventDefault();
        if (target.classList.contains('is-open')) closeAll();
        else open();
      });
    });

    on(backdrop, 'click', closeAll);
    on(document, 'keydown', (e) => { if (e.key === 'Escape') closeAll(); });
  };


  // ============================================================
  // MOBILE NAV
  // ============================================================
  const initMobileNav = () => {
    const toggle  = $('.menu-toggle');
    const drawer  = $('.mobile-nav');
    if (!toggle || !drawer) return;

    const open = () => {
      toggle.classList.add('is-open');
      drawer.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
      lockScroll(true);
    };
    const close = () => {
      toggle.classList.remove('is-open');
      drawer.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      lockScroll(false);
    };

    on(toggle, 'click', () => {
      if (drawer.classList.contains('is-open')) close(); else open();
    });

    // Bottom tab bar "Menu" button opens the same drawer
    $$('[data-action="open-menu"]').forEach(btn => on(btn, 'click', () => {
      if (drawer.classList.contains('is-open')) close(); else open();
    }));

    // Highlight the active bottom tab for the current page
    const path = location.pathname;
    $$('.mobile-tabbar .tab-item[data-tab]').forEach(t => {
      const tp = t.getAttribute('data-tab');
      if (tp === path || (tp !== '/' && path.indexOf(tp) === 0)) t.classList.add('is-active');
    });

    // Sub-menu collapsibles
    $$('.mobile-nav-link[data-sub]', drawer).forEach(btn => {
      on(btn, 'click', () => {
        const sub = btn.nextElementSibling;
        const isOpen = sub.classList.contains('is-open');
        // close siblings
        $$('.mobile-nav-sub.is-open', drawer).forEach(s => s.classList.remove('is-open'));
        $$('.mobile-nav-link[aria-expanded="true"]', drawer)
          .forEach(b => b.setAttribute('aria-expanded', 'false'));
        if (!isOpen) {
          sub.classList.add('is-open');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });

    // Close on link click within drawer
    $$('a', drawer).forEach(a => on(a, 'click', close));

    // ESC closes
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && drawer.classList.contains('is-open')) close();
    });
  };


  // ============================================================
  // SEARCH OVERLAY
  // ============================================================
  const initSearch = () => {
    const triggers = $$('[data-action="open-search"]');
    const overlay  = $('.search-overlay');
    if (!overlay) return;
    const input    = $('.search-input', overlay);
    const closeBtn = $('.search-close', overlay);

    const open = () => {
      overlay.classList.add('is-open');
      lockScroll(true);
      setTimeout(() => input && input.focus(), 60);
    };
    const close = () => {
      overlay.classList.remove('is-open');
      lockScroll(false);
    };

    triggers.forEach(t => on(t, 'click', (e) => { e.preventDefault(); open(); }));
    on(closeBtn, 'click', close);
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('is-open')) close();
      // Cmd/Ctrl + K to open
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (overlay.classList.contains('is-open')) close(); else open();
      }
    });

    // Filter chips
    $$('.filter-chip', overlay).forEach(chip => {
      on(chip, 'click', () => {
        $$('.filter-chip', overlay).forEach(c => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        const filter = chip.dataset.filter;
        $$('.search-result', overlay).forEach(r => {
          r.style.display = (filter === 'all' || r.dataset.type === filter) ? '' : 'none';
        });
      });
    });

    // Enter (or the form) runs a real site-wide search on the results page
    if (input) {
      const go = () => {
        const q = input.value.trim();
        if (q) window.location.href = '/search?q=' + encodeURIComponent(q);
      };
      on(input, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      const form = input.closest('form');
      if (form) on(form, 'submit', (e) => { e.preventDefault(); go(); });
      // live narrowing of the quick-links already shown in the overlay
      on(input, 'input', () => {
        const q = input.value.trim().toLowerCase();
        $$('.search-result', overlay).forEach(r => {
          r.style.display = (!q || r.textContent.toLowerCase().includes(q)) ? '' : 'none';
        });
      });
    }
  };


  // ============================================================
  // CONSENT MODAL — fires on outbound link click
  // ============================================================
  const initConsentModal = () => {
    const modal = $('#consent-modal');
    if (!modal) return;

    const providerNameEl = $('.modal-provider .pname', modal);
    const providerUrlEl  = $('.modal-provider .purl', modal);
    const providerIcoEl  = $('.modal-provider .ico', modal);
    const agreeBtn       = $('[data-action="consent-agree"]', modal);
    const declineBtn     = $('[data-action="consent-decline"]', modal);
    const closeBtn       = $('.modal-close', modal);
    const checks         = $$('input[type=checkbox]', modal);
    let pendingHref      = null;
    let releaseFocus     = null;

    const updateAgreeState = () => {
      const allChecked = checks.every(c => c.checked);
      agreeBtn.disabled = !allChecked;
      agreeBtn.classList.toggle('disabled', !allChecked);
    };
    checks.forEach(c => on(c, 'change', updateAgreeState));
    updateAgreeState();

    const open = (provider, url, display) => {
      providerNameEl.textContent = provider;
      providerUrlEl.textContent = display || url;
      providerIcoEl.textContent = (provider || '?').charAt(0).toUpperCase();
      checks.forEach(c => c.checked = false);
      updateAgreeState();
      pendingHref = url;
      modal.classList.add('is-open');
      lockScroll(true);
      releaseFocus = trapFocus(modal);
    };

    const close = () => {
      modal.classList.remove('is-open');
      lockScroll(false);
      pendingHref = null;
      if (releaseFocus) { releaseFocus(); releaseFocus = null; }
    };

    on(declineBtn, 'click', close);
    on(closeBtn,   'click', close);
    on($('.modal-backdrop', modal), 'click', close);
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-open')) close();
    });

    on(agreeBtn, 'click', () => {
      if (agreeBtn.disabled) return;
      const href = pendingHref;
      close();
      if (!href || href === '#') return;
      // External provider / affiliate site → new tab; internal (quote form) → same tab
      if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener');
      else window.location.href = href;
    });

    // Delegated so links added later (AJAX-filtered grids, etc.) also work
    on(document, 'click', (e) => {
      const link = e.target.closest('a[data-external]');
      if (!link) return;
      e.preventDefault();
      const provider = link.dataset.provider || 'External Provider';
      const url = link.dataset.url || link.getAttribute('href') || '#';
      open(provider, url, link.dataset.display || '');
    });

    // Public API for trigger from anywhere
    window.TriplipiConsent = { open, close };
  };


  // ============================================================
  // LIGHTBOX — gallery image / video preview
  // ============================================================
  const initLightbox = () => {
    const lightbox = $('#lightbox');
    if (!lightbox) return;
    const inner    = $('.lightbox-inner', lightbox);
    const closeBtn = $('.lightbox-close', lightbox);
    const prev     = $('.lightbox-nav.prev', lightbox);
    const next     = $('.lightbox-nav.next', lightbox);

    let items = [];
    let idx   = 0;

    const refresh = () => {
      items = $$('[data-lightbox]');
    };

    const render = () => {
      if (!items[idx]) return;
      const el = items[idx];
      const isVid = el.dataset.type === 'video';
      const src   = el.dataset.src || (el.querySelector('img,video') && el.querySelector('img,video').src);
      inner.innerHTML = isVid
        ? `<video src="${src}" controls autoplay playsinline></video>`
        : `<img src="${src}" alt="" loading="eager">`;
    };

    const open = (i) => {
      refresh();
      idx = i;
      render();
      lightbox.classList.add('is-open');
      lockScroll(true);
    };
    const close = () => {
      lightbox.classList.remove('is-open');
      lockScroll(false);
      inner.innerHTML = '';
    };
    const go = (dir) => {
      idx = (idx + dir + items.length) % items.length;
      render();
    };

    on(closeBtn, 'click', close);
    on(prev, 'click', () => go(-1));
    on(next, 'click', () => go(1));
    on(lightbox, 'click', (e) => { if (e.target === lightbox) close(); });
    on(document, 'keydown', (e) => {
      if (!lightbox.classList.contains('is-open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    });

    // Click delegation
    on(document, 'click', (e) => {
      const el = e.target.closest('[data-lightbox]');
      if (!el) return;
      e.preventDefault();
      refresh();
      const i = items.indexOf(el);
      if (i >= 0) open(i);
    });
  };


  // ============================================================
  // INTERSECTION REVEAL — animates [data-reveal] when visible
  // ============================================================
  const initReveals = () => {
    if (!('IntersectionObserver' in window)) {
      // Fallback: just show everything
      $$('[data-reveal], [data-stagger]').forEach(el => el.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -80px 0px' });

    $$('[data-reveal], [data-stagger]').forEach(el => io.observe(el));
  };


  // ============================================================
  // COUNTER ANIMATION — animates numbers up to target
  // ============================================================
  const initCounters = () => {
    if (!('IntersectionObserver' in window)) return;
    const counters = $$('[data-counter]');

    const animate = (el) => {
      const target = parseFloat(el.dataset.counter);
      const duration = parseInt(el.dataset.duration || '1800', 10);
      const prefix = el.dataset.prefix || '';
      const suffix = el.dataset.suffix || '';
      const decimals = parseInt(el.dataset.decimals || '0', 10);
      const start = performance.now();

      const step = (now) => {
        const p = Math.min((now - start) / duration, 1);
        // ease-out cubic
        const eased = 1 - Math.pow(1 - p, 3);
        const val = target * eased;
        el.textContent = prefix + val.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          animate(entry.target);
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    counters.forEach(c => io.observe(c));
  };


  // ============================================================
  // HOVER VIDEO PREVIEW — auto-plays videos on hover
  // ============================================================
  const initHoverVideos = () => {
    $$('[data-hover-video]').forEach(wrap => {
      const vid = wrap.querySelector('video');
      if (!vid) return;
      vid.muted = true;
      vid.playsInline = true;
      vid.loop = true;
      on(wrap, 'mouseenter', () => { vid.currentTime = 0; vid.play().catch(() => {}); });
      on(wrap, 'mouseleave', () => { vid.pause(); vid.currentTime = 0; });
    });
  };


  // ============================================================
  // AJAX FILTERS — category / list / pagination without a full reload
  // (Destinations, Packages, Our Picks). Falls back to normal navigation.
  // ============================================================
  const initAjaxFilters = () => {
    const main = document.querySelector('main');
    if (!main) return;
    const bar = main.querySelector('.pkg-filters, .category-pills, .picks-tabs');
    if (!bar) return; // only on the filter pages

    const SEL = '.pkg-filters a, .category-pills a, .picks-tabs a, .pagination a';

    const revealAll = () => {
      main.querySelectorAll('[data-reveal], [data-stagger]').forEach((el) => el.classList.add('is-visible'));
    };

    const swap = (href, push) => {
      main.classList.add('is-filtering');
      fetch(href, { headers: { 'X-Requested-With': 'fetch' } })
        .then((r) => r.text())
        .then((html) => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const newMain = doc.querySelector('main');
          if (!newMain) { window.location.href = href; return; }
          main.innerHTML = newMain.innerHTML;
          const t = doc.querySelector('title');
          if (t) document.title = t.textContent;
          if (push) history.pushState({ ajax: true }, '', href);
          revealAll();
          // bring the freshly-filtered results into view, just under the header
          const target = main.querySelector('.pkg-filters, .category-pills, .picks-tabs');
          if (target) {
            const top = target.getBoundingClientRect().top + window.scrollY - 90;
            if (window.scrollY > top + 40 || window.scrollY < top - 40) {
              window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
            }
          }
        })
        .catch(() => { window.location.href = href; })
        .finally(() => main.classList.remove('is-filtering'));
    };

    on(main, 'click', (e) => {
      const link = e.target.closest(SEL);
      if (!link || !main.contains(link)) return;
      const href = link.getAttribute('href');
      if (!href) return;
      const url = new URL(href, window.location.href);
      // only intercept same-page links — let real navigation happen otherwise
      if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return;
      e.preventDefault();
      if (url.href === window.location.href) return;
      swap(url.href, true);
    });

    on(window, 'popstate', () => {
      if (main.querySelector('.pkg-filters, .category-pills, .picks-tabs')) swap(window.location.href, false);
    });
  };


  // ============================================================
  // SHOP — selection + quote form
  // ============================================================
  const initShop = () => {
    const grid     = $('.shop-grid');
    const panel    = $('.selection-panel');
    if (!grid || !panel) return;

    const list     = $('.selection-list', panel);
    const empty    = $('.shop-empty', panel);
    const countEl  = $('.selection-count', panel);
    const seekBtn  = $('[data-action="seek-quote"]', panel);
    const formWrap = $('.quote-form', panel);
    const submitBtn = $('[data-action="submit-quote"]', panel);

    const selected = new Map();

    const render = () => {
      // Clear & rebuild rows
      list.innerHTML = '';
      if (selected.size === 0) {
        if (empty) empty.style.display = '';
        if (formWrap) formWrap.classList.remove('is-open');
      } else {
        if (empty) empty.style.display = 'none';
        selected.forEach((item, key) => {
          const row = document.createElement('div');
          row.className = 'selection-row';
          row.innerHTML = `
            <div class="row-thumb"><img src="${item.img}" alt="${item.serial}"></div>
            <div class="row-info">
              <div class="row-serial">${item.serial}</div>
              <div class="row-type">${item.type}</div>
            </div>
            <button class="remove" data-key="${key}" aria-label="Remove">×</button>
          `;
          list.appendChild(row);
        });
      }
      countEl.textContent = selected.size;
    };

    // Tile selection toggle
    on(grid, 'click', (e) => {
      const tile = e.target.closest('.shop-tile');
      if (!tile) return;
      const key = tile.dataset.serial;
      if (!key) return;
      if (selected.has(key)) {
        selected.delete(key);
        tile.classList.remove('is-selected');
      } else {
        selected.set(key, {
          serial: key,
          type: tile.dataset.mediaType || 'image',
          img: tile.querySelector('img,video') ? (tile.querySelector('img,video').poster || tile.querySelector('img,video').src) : ''
        });
        tile.classList.add('is-selected');
      }
      render();
    });

    // Remove row
    on(list, 'click', (e) => {
      const btn = e.target.closest('.remove');
      if (!btn) return;
      const key = btn.dataset.key;
      selected.delete(key);
      const tile = grid.querySelector(`[data-serial="${key}"]`);
      if (tile) tile.classList.remove('is-selected');
      render();
    });

    // Open quote form
    on(seekBtn, 'click', () => {
      if (selected.size === 0) {
        showToast('Select at least one item first');
        return;
      }
      formWrap.classList.toggle('is-open');
      if (formWrap.classList.contains('is-open')) {
        formWrap.querySelector('input').focus();
      }
    });

    // Submit — real POST to /submit (stored in admin Inbox + emailed if SMTP set)
    on(submitBtn, 'click', (e) => {
      e.preventDefault();
      const name = $('input[name=name]', formWrap).value.trim();
      const email = $('input[name=email]', formWrap).value.trim();
      const phone = $('input[name=phone]', formWrap).value.trim();
      const usage = formWrap.querySelector('textarea[name=usage]') ? formWrap.querySelector('textarea[name=usage]').value.trim() : '';
      if (!name || !email || !phone) {
        showToast('Please fill all fields');
        return;
      }
      if (selected.size === 0) {
        showToast('Select at least one item first');
        return;
      }
      const fd = new FormData();
      fd.append('_form', 'Shop quote request');
      fd.append('name', name);
      fd.append('email', email);
      fd.append('phone', phone);
      fd.append('usage', usage);
      // the selected media references the visitor is asking about
      fd.append('items', Array.from(selected.values()).map(i => i.serial + ' (' + i.type + ')').join(', '));
      const to = formWrap.dataset.quoteTo;
      if (to) fd.append('_to', to);

      submitBtn.disabled = true;
      fetch('/submit', { method: 'POST', body: fd, headers: { Accept: 'application/json' } })
        .then((r) => r.json())
        .then(() => {
          showToast('Quote request sent. We\'ll respond within 24 hours.');
          selected.clear();
          $$('.shop-tile.is-selected', grid).forEach(t => t.classList.remove('is-selected'));
          formWrap.classList.remove('is-open');
          $$('input, textarea', formWrap).forEach(i => i.value = '');
          render();
        })
        .catch(() => showToast('Could not send — please try again.'))
        .finally(() => { submitBtn.disabled = false; });
    });

    render();
  };


  // ============================================================
  // FORM SUBMIT — generic (contact, ask-for-guidance, etc.)
  // ============================================================
  const initForms = () => {
    $$('form[data-form]').forEach(form => {
      $$('input[type=checkbox][required]', form).forEach(c => on(c, 'change', () => {
        const wrap = c.closest('.check');
        if (wrap && c.checked) wrap.classList.remove('is-error');
      }));
      on(form, 'submit', (e) => {
        e.preventDefault();
        // Validate required fields
        const required = $$('[required]', form);
        let ok = true;
        let unticked = false;
        required.forEach(f => {
          const empty = f.type === 'checkbox' ? !f.checked : !f.value.trim();
          if (f.type === 'checkbox') {
            // the native box is hidden by .check — flag the drawn .box via its label instead
            const wrap = f.closest('.check');
            if (wrap) wrap.classList.toggle('is-error', empty);
            if (empty) unticked = true;
          } else {
            f.style.borderColor = empty ? 'var(--c-ember)' : '';
          }
          if (empty) ok = false;
        });
        if (!ok) {
          showToast(unticked ? 'Please agree to the policy to continue' : 'Please complete required fields');
          return;
        }
        // Real submission → /submit (stored in admin Inbox + emailed if SMTP set)
        const data = new FormData(form);
        if (!data.get('_form')) data.append('_form', form.dataset.form || form.dataset.successMessage || 'Form');
        const btn = $('[type=submit]', form);
        if (btn) btn.disabled = true;
        fetch('/submit', { method: 'POST', body: data, headers: { Accept: 'application/json' } })
          .then((r) => r.json())
          .then(() => { showToast(form.dataset.successMessage || 'Message sent. Thank you.'); form.reset(); })
          .catch(() => { showToast('Could not send — please try again.'); })
          .finally(() => { if (btn) btn.disabled = false; });
      });
    });
  };


  // ============================================================
  // SHOP — Category pills (single-select active state)
  // ============================================================
  const initPills = () => {
    $$('.category-pill, .pkg-filters .filter-chip').forEach(pill => {
      on(pill, 'click', () => {
        const siblings = pill.parentElement.querySelectorAll('.category-pill, .filter-chip');
        siblings.forEach(s => s.classList.remove('is-active'));
        pill.classList.add('is-active');
      });
    });

    // Search results page — filter rendered results by type
    $$('.search-filter .filter-chip').forEach((chip) => on(chip, 'click', () => {
      $$('.search-filter .filter-chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      const f = chip.dataset.filter;
      $$('.search-results .search-result').forEach((r) => {
        r.style.display = (f === 'all' || r.dataset.type === f) ? '' : 'none';
      });
    }));

    // Destination category filter — pills with data-cat filter the listing grid
    $$('.category-pills .category-pill[data-cat]').forEach(pill => {
      on(pill, 'click', () => {
        const cat = pill.dataset.cat;
        $$('.dest-listing-grid .dest-card').forEach(card => {
          const cats = (card.dataset.cats || '').split(/\s+/);
          card.style.display = (cat === 'all' || cats.includes(cat)) ? '' : 'none';
        });
      });
    });

    // Gallery filter — 'all', 'type:image'/'type:video', or a category slug
    $$('.gallery-filter .filter-chip').forEach(chip => {
      on(chip, 'click', () => {
        const filter = chip.dataset.filter;
        $$('.gallery-filter .filter-chip').forEach(c => c.classList.remove('is-active'));
        chip.classList.add('is-active');
        $$('.masonry > [data-cat]').forEach(item => {
          let show;
          if (filter === 'all') show = true;
          else if (filter.startsWith('type:')) show = item.dataset.kind === filter.slice(5);
          else show = item.dataset.cat === filter;
          item.style.display = show ? '' : 'none';
        });
      });
    });
  };


  // ============================================================
  // PKG TABS (Package detail)
  // ============================================================
  const initPkgTabs = () => {
    const tabs = $$('.pkg-tab');
    if (!tabs.length) return;
    tabs.forEach(tab => on(tab, 'click', () => {
      const tgt = tab.dataset.tab;
      tabs.forEach(t => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      $$('.pkg-tab-pane').forEach(p => {
        p.style.display = (p.dataset.pane === tgt) ? '' : 'none';
      });
    }));
  };


  // ============================================================
  // COPY PROTECTION (FR-OTHER-008)
  // Right-click disable, drag block, common shortcuts blocked
  // ============================================================
  const initCopyProtect = () => {
    // Prevent right-click on images and videos
    document.addEventListener('contextmenu', (e) => {
      if (e.target.matches('img, video, .gallery-tile, .shop-tile, .dest-card, [data-protect]')) {
        e.preventDefault();
      }
    });
    // Prevent drag of images
    document.addEventListener('dragstart', (e) => {
      if (e.target.matches('img')) e.preventDefault();
    });
    // Block Ctrl+S, Ctrl+P on media-heavy pages (only inside protected areas)
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && ['s', 'p', 'u'].includes(e.key.toLowerCase())) {
        // Don't aggressively block — let it through unless we're focused on media
        if (e.target.matches('img, video')) e.preventDefault();
      }
    });
  };


  // ============================================================
  // PARALLAX (subtle, performant)
  // ============================================================
  const initParallax = () => {
    const items = $$('[data-parallax]');
    if (!items.length) return;
    let ticking = false;
    const update = () => {
      const vh = window.innerHeight;
      items.forEach(el => {
        const rect = el.getBoundingClientRect();
        const center = rect.top + rect.height / 2;
        const offset = (center - vh / 2) * (parseFloat(el.dataset.parallax) || 0.1);
        el.style.transform = `translate3d(0, ${-offset}px, 0)`;
      });
      ticking = false;
    };
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    }, { passive: true });
    update();
  };


  // ============================================================
  // TOAST
  // ============================================================
  let toastTimer = null;
  const showToast = (msg) => {
    let toast = $('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML = `<span class="check-icon">✓</span><span class="msg"></span>`;
      document.body.appendChild(toast);
    }
    $('.msg', toast).textContent = msg;
    toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-show'), 3500);
  };
  window.TriplipiToast = showToast;


  // ============================================================
  // PAGE LOAD COMPLETE — hide loader
  // ============================================================
  const initLoader = () => {
    const loader = $('.page-loader');
    if (!loader) return;
    window.addEventListener('load', () => {
      setTimeout(() => loader.classList.add('is-done'), 350);
      setTimeout(() => loader.remove(), 1200);
    });
  };


  // ============================================================
  // SMOOTH IN-PAGE ANCHOR SCROLL
  // ============================================================
  const initSmoothAnchors = () => {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;
      const id = link.getAttribute('href');
      if (id.length < 2) return;
      const target = $(id);
      if (!target) return;
      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  };


  // ============================================================
  // PACKAGES — destination filter via ?d= (e.g. packages.html?d=ladakh)
  // ============================================================
  const initPkgDestFilter = () => {
    const grid = $('.pkg-grid');
    if (!grid) return;
    const d = (new URLSearchParams(location.search).get('d') || '').toLowerCase();
    if (!d) return;

    // slug -> keywords matched against each package card's text
    const KEYWORDS = {
      ladakh: ['ladakh'],
      andaman: ['andaman', 'havelock'],
      spiti: ['spiti', 'himachal'],
      manali: ['manali', 'himachal'],
      kerala: ['kerala', 'backwater'],
      munnar: ['munnar', 'kerala'],
      meghalaya: ['meghalaya', 'cherrapunji'],
      jaisalmer: ['jaisalmer', 'rajasthan'],
      goa: ['goa'],
      coorg: ['coorg'],
      sikkim: ['sikkim'],
      lakshadweep: ['lakshadweep'],
    };
    const keys = KEYWORDS[d] || [d];
    const cards = $$('.pkg-card');
    let shown = 0;
    cards.forEach((c) => {
      const hit = keys.some((k) => c.textContent.toLowerCase().includes(k));
      c.style.display = hit ? '' : 'none';
      if (hit) shown++;
    });

    const label = d.replace(/[^a-z]/g, '');
    const pretty = label.charAt(0).toUpperCase() + label.slice(1);
    const note = document.createElement('div');
    note.className = 'pkg-dest-note';
    if (shown === 0) {
      cards.forEach((c) => { c.style.display = ''; });
      note.innerHTML = `No packages for <strong>${pretty}</strong> yet — showing all packages. <a href="/packages">Clear filter</a>`;
    } else {
      note.innerHTML = `Showing ${shown} package${shown > 1 ? 's' : ''} for <strong>${pretty}</strong>. <a href="/packages">Show all</a>`;
    }
    grid.parentNode.insertBefore(note, grid);
  };

  // ============================================================
  // CAROUSEL — horizontal sliding slideshow (Travel Highlights, etc.)
  // ============================================================
  const initCarousel = () => {
    $$('[data-carousel]').forEach((root) => {
      const track = $('[data-carousel-track]', root);
      if (!track) return;
      const prevBtn = $('[data-carousel-prev]', root);
      const nextBtn = $('[data-carousel-next]', root);
      const autoplayMs = parseInt(root.dataset.autoplay || '0', 10);

      // Width of one "page" step = card width + gap
      const stepBy = () => {
        const card = track.querySelector('*');
        if (!card) return track.clientWidth;
        const cs = getComputedStyle(track);
        const gap = parseFloat(cs.columnGap || cs.gap || '0') || 0;
        return card.getBoundingClientRect().width + gap;
      };

      const EPS = 4;
      const atEnd   = () => track.scrollLeft + track.clientWidth >= track.scrollWidth - EPS;
      const atStart = () => track.scrollLeft <= EPS;

      const next = () => {
        const target = atEnd() ? 0 : track.scrollLeft + stepBy();
        track.scrollTo({ left: target, behavior: 'smooth' });
      };
      const prev = () => {
        const target = atStart() ? track.scrollWidth : track.scrollLeft - stepBy();
        track.scrollTo({ left: target, behavior: 'smooth' });
      };

      // Autoplay (pausable). Runs unconditionally — this is a presentation slideshow.
      let timer = null;
      const stop  = () => { if (timer) { clearInterval(timer); timer = null; } };
      const start = () => {
        if (!autoplayMs || timer) return;
        timer = setInterval(next, autoplayMs);
      };
      const restart = () => { stop(); start(); };

      on(prevBtn, 'click', () => { prev(); restart(); });
      on(nextBtn, 'click', () => { next(); restart(); });

      // Pause on hover / touch / when the tab is hidden
      on(root, 'mouseenter', stop);
      on(root, 'mouseleave', start);
      on(track, 'touchstart', stop, { passive: true });
      on(track, 'touchend', () => setTimeout(start, 2500), { passive: true });
      on(document, 'visibilitychange', () => { document.hidden ? stop() : start(); });

      start();
    });
  };

  // ============================================================
  // IMAGE FALLBACK — graceful degradation if a remote image 404s
  // ============================================================
  const initImageFallback = () => {
    // A neutral, branded placeholder (inline SVG, no network dependency)
    const placeholder =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
        '<rect width="800" height="600" fill="#FBF1DA"/>' +
        '<rect width="800" height="6" fill="#D05527"/>' +
        '<text x="50%" y="50%" font-family="Georgia, serif" font-size="42" fill="#c0a98f" ' +
        'text-anchor="middle" dominant-baseline="middle" font-style="italic">Triplipi</text>' +
        '</svg>'
      );

    const handle = (img) => {
      if (img.dataset.fallbackApplied) return;
      img.dataset.fallbackApplied = '1';
      img.src = placeholder;
      img.style.objectFit = 'cover';
    };

    $$('img').forEach((img) => {
      // Already failed before this script ran
      if (img.complete && img.naturalWidth === 0 && img.src) handle(img);
      on(img, 'error', () => handle(img));
    });
  };

  // ============================================================
  // CONTACT — one page for everyone. /contact#partner ("Become a partner")
  // keeps the same page but swaps the subject dropdown for partner packages.
  // ============================================================
  const initContactMode = () => {
    const form = $('form.contact-form');
    if (!form) return;
    const formName = $('input[name="_form"]', form);
    const apply = () => {
      const partner = location.hash === '#partner';
      $$('[data-mode]', form).forEach(el => {
        const active = el.dataset.mode === (partner ? 'partner' : 'general');
        el.hidden = !active;
        if (el.tagName === 'SELECT') el.disabled = !active;   // only the visible dropdown submits
      });
      if (formName) formName.value = partner ? 'Partner application' : 'Contact';
    };
    apply();
    on(window, 'hashchange', apply);
  };

  // ============================================================
  // PACKAGES CATEGORY RAIL — on phones the rail is one swipeable row, so
  // after picking a category bring its (now active) tile into view instead
  // of leaving the row parked back at "All".
  // ============================================================
  const initPkgCatRail = () => {
    const rail = $('.pkg-cats');
    const active = rail && $('.pkg-cat.is-active', rail);
    if (!active || rail.scrollWidth <= rail.clientWidth) return;
    const offset = active.getBoundingClientRect().left - rail.getBoundingClientRect().left;
    rail.scrollLeft += offset - (rail.clientWidth - active.offsetWidth) / 2;
  };

  // ============================================================
  // READ MORE — open the extended destination guide in place
  // ============================================================
  const initReadMore = () => {
    const btn = $('[data-action="toggle-more"]');
    const panel = $('[data-dest-more]');
    if (!btn || !panel) return;
    const label = $('.rm-label', btn) || btn;
    // the row holding both buttons (Read More + Check Packages) — it follows
    // the extended guide while open, so the CTAs always sit at the bottom
    const ctaRow = btn.closest('.dest-foot-cta');
    const revealInner = () =>
      panel.querySelectorAll('[data-reveal], [data-stagger]').forEach(e => e.classList.add('is-visible'));

    on(btn, 'click', () => {
      const opening = !panel.classList.contains('is-open');
      if (opening) {
        // move the buttons below the panel first: it is still 0px tall, so
        // they stay put visually and get pushed down as the guide expands
        if (ctaRow) panel.after(ctaRow);
        panel.classList.add('is-open');
        revealInner();
        panel.style.maxHeight = panel.scrollHeight + 'px';
        btn.setAttribute('aria-expanded', 'true');
        label.textContent = 'Show Less';
        // let it grow freely once the open transition finishes
        setTimeout(() => { if (panel.classList.contains('is-open')) panel.style.maxHeight = 'none'; }, 650);
      } else {
        // fix the height first, then animate to 0
        panel.style.maxHeight = panel.scrollHeight + 'px';
        requestAnimationFrame(() => { panel.style.maxHeight = '0px'; });
        panel.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
        label.textContent = 'Read More About Destination';
        // once collapsed, put the buttons back above the (now empty) panel —
        // same spot on screen, so there is no jump — then bring them into view
        setTimeout(() => {
          if (panel.classList.contains('is-open')) return;
          if (ctaRow) panel.before(ctaRow);
          btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 650);
      }
    });
  };

  // ============================================================
  // INIT EVERYTHING
  // ============================================================
  const init = () => {
    initLoader();
    initHeader();
    initMegaMenu();
    initActiveNav();
    initMobileNav();
    initSearch();
    initContactMode();
    initPkgCatRail();
    initConsentModal();
    initLightbox();
    initReveals();
    initCounters();
    initHoverVideos();
    initAjaxFilters();
    initShop();
    initForms();
    initPills();
    initPkgTabs();
    initCopyProtect();
    initParallax();
    initSmoothAnchors();
    initCarousel();
    initImageFallback();
    initReadMore();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
