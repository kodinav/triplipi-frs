/* Triplipi CMS — admin interactions (vanilla JS) */
(function () {
  'use strict';

  /* ---------- drag-to-reorder list items (slide anywhere) ---------- */
  document.querySelectorAll('[data-sortable]').forEach((list) => {
    const key = list.dataset.key;
    let dragEl = null;

    const rowAfter = (y) => {
      const rows = Array.from(list.querySelectorAll('.adm-row:not(.dragging)'));
      for (const r of rows) {
        const box = r.getBoundingClientRect();
        if (y < box.top + box.height / 2) return r;
      }
      return null;
    };

    // After a reorder: renumber rows and re-point each row's action URLs so
    // Edit/Delete/▲▼ still target the right item without a page reload.
    const reindex = () => {
      const rows = Array.from(list.querySelectorAll('.adm-row'));
      rows.forEach((row, i) => {
        row.dataset.idx = i;
        const num = row.querySelector('.row-num');
        if (num) num.textContent = '#' + (i + 1);
        const mv = row.querySelector('.row-actions form[action*="/move"]');
        if (mv) {
          mv.setAttribute('action', '/admin/section/' + key + '/' + i + '/move');
          const up = mv.querySelector('button[value="up"]');
          const down = mv.querySelector('button[value="down"]');
          if (up) up.disabled = i === 0;
          if (down) down.disabled = i === rows.length - 1;
        }
        const ed = row.querySelector('a[href*="/edit"]');
        if (ed) ed.setAttribute('href', '/admin/section/' + key + '/' + i + '/edit');
        const del = row.querySelector('form[action*="/delete"]');
        if (del) del.setAttribute('action', '/admin/section/' + key + '/' + i + '/delete');
      });
    };

    const persist = () => {
      const order = Array.from(list.querySelectorAll('.adm-row'))
        .map((r) => r.dataset.idx).join(',');
      list.classList.add('is-saving');
      fetch('/admin/section/' + key + '/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'order=' + encodeURIComponent(order),
      }).then((r) => {
        if (!r.ok) throw new Error('reorder failed');
        reindex();
      }).catch(() => window.location.reload())
        .finally(() => list.classList.remove('is-saving'));
    };

    list.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.adm-row');
      if (!row || !list.contains(row)) return;
      if (e.target.closest('.row-actions')) { e.preventDefault(); return; } // buttons aren't drag-grips
      dragEl = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', row.dataset.idx); } catch (_) { /* noop */ }
    });

    list.addEventListener('dragover', (e) => {
      if (!dragEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const after = rowAfter(e.clientY);
      const addBtn = list.querySelector('a.adm-btn.primary');
      if (after == null) list.insertBefore(dragEl, addBtn);
      else if (after !== dragEl) list.insertBefore(dragEl, after);
    });

    list.addEventListener('drop', (e) => { e.preventDefault(); persist(); });

    list.addEventListener('dragend', () => {
      if (dragEl) dragEl.classList.remove('dragging');
      dragEl = null;
    });
  });

  /* ---------- multiselect dropdowns: live feedback + outside-click close ---------- */
  document.querySelectorAll('.adm-dd').forEach((dd) => {
    const summary = dd.querySelector('summary');

    const sync = () => {
      const picked = Array.from(dd.querySelectorAll('.dd-option input:checked'))
        .map((i) => i.parentElement.textContent.trim());
      summary.textContent = '';
      if (picked.length) {
        picked.forEach((label) => {
          const chip = document.createElement('span');
          chip.className = 'dd-chip';
          chip.textContent = label;
          summary.appendChild(chip);
        });
      } else {
        const ph = document.createElement('span');
        ph.className = 'dd-placeholder';
        ph.textContent = 'Choose from the list…';
        summary.appendChild(ph);
      }
      const arrow = document.createElement('span');
      arrow.className = 'dd-arrow';
      arrow.textContent = '▾';
      summary.appendChild(arrow);
    };

    /* update the header chips the instant a box is ticked */
    dd.addEventListener('change', sync);

    /* belt-and-braces: clicking an option row always toggles its checkbox,
       even if some browser/extension swallows the native label behaviour */
    dd.querySelectorAll('.dd-option').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;        // native click already did it
        e.preventDefault();
        const box = row.querySelector('input');
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });

    /* close when clicking anywhere outside */
    document.addEventListener('click', (e) => {
      if (dd.open && !dd.contains(e.target)) dd.removeAttribute('open');
    });
  });

  /* ---------- rich text editor (Word-like) for [data-rich] fields ---------- */
  document.querySelectorAll('.rte[data-rich]').forEach((wrap) => {
    const source = wrap.querySelector('.rte-source');
    if (!source) return;
    const inline = wrap.dataset.rich === 'inline';

    const toolbar = document.createElement('div');
    toolbar.className = 'rte-toolbar';
    const editor = document.createElement('div');
    editor.className = 'rte-editor';
    editor.contentEditable = 'true';
    editor.setAttribute('spellcheck', 'true');
    editor.innerHTML = source.value.trim() || (inline ? '' : '<p><br></p>');
    wrap.appendChild(toolbar);
    wrap.appendChild(editor);

    try {
      document.execCommand('defaultParagraphSeparator', false, 'p');
      document.execCommand('styleWithCSS', false, true);
    } catch (e) { /* older browsers */ }

    const sync = () => { source.value = editor.innerHTML.trim(); };
    editor.addEventListener('input', sync);
    editor.addEventListener('blur', sync);
    const form = wrap.closest('form');
    if (form) form.addEventListener('submit', sync);

    /* inline fields stay on one line for headings; Enter inserts a soft break */
    if (inline) {
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); sync(); }
      });
    }

    /* preserve the selection so toolbar/colour controls act on it */
    let savedRange = null;
    const saveSel = () => {
      const s = window.getSelection();
      if (s.rangeCount && editor.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
    };
    const restoreSel = () => {
      if (!savedRange) return;
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(savedRange);
    };
    editor.addEventListener('keyup', saveSel);
    editor.addEventListener('mouseup', saveSel);

    const run = (cmd, val) => {
      editor.focus(); restoreSel();
      document.execCommand(cmd, false, val);
      saveSel(); sync();
    };
    /* wrap the selection in a semantic tag (<strong>/<em>/<u>) — clean output */
    const wrapTag = (tag) => {
      editor.focus(); restoreSel();
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return;
      // if the whole selection already sits in <tag>, unwrap it (toggle off)
      let anc = sel.anchorNode;
      while (anc && anc !== editor) {
        if (anc.nodeName && anc.nodeName.toLowerCase() === tag) {
          const parent = anc.parentNode;
          while (anc.firstChild) parent.insertBefore(anc.firstChild, anc);
          parent.removeChild(anc);
          saveSel(); sync(); return;
        }
        anc = anc.parentNode;
      }
      const el = document.createElement(tag);
      try { el.appendChild(range.extractContents()); range.insertNode(el);
        sel.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); sel.addRange(r); saveSel();
      } catch (e) { /* cross-node selection; ignore */ }
      sync();
    };

    const blockGroups = [
      [
        { label: 'Paragraph', title: 'Normal text', act: () => run('formatBlock', 'P') },
        { label: 'Heading',   title: 'Section heading', act: () => run('formatBlock', 'H2') },
        { label: 'Subhead',   title: 'Sub-heading', act: () => run('formatBlock', 'H3') },
      ],
      [
        { label: 'B', cls: 'is-b', title: 'Bold', act: () => wrapTag('strong') },
        { label: 'I', cls: 'is-i', title: 'Italic / highlight', act: () => wrapTag('em') },
        { label: 'U', cls: 'is-u', title: 'Underline', act: () => wrapTag('u') },
      ],
      [
        { label: '• List', title: 'Bullet list', act: () => run('insertUnorderedList') },
        { label: '1. List', title: 'Numbered list', act: () => run('insertOrderedList') },
        { label: 'Link', title: 'Add link', act: () => { const u = prompt('Link address (e.g. /contact or https://…):'); if (u) run('createLink', u); } },
      ],
      [
        { label: '⯇', title: 'Align left', act: () => run('justifyLeft') },
        { label: '≡', title: 'Align centre', act: () => run('justifyCenter') },
        { label: '⯈', title: 'Align right', act: () => run('justifyRight') },
      ],
    ];
    const inlineGroups = [
      [
        { label: 'B', cls: 'is-b', title: 'Bold', act: () => wrapTag('strong') },
        { label: 'I', cls: 'is-i', title: 'Italic / highlight', act: () => wrapTag('em') },
        { label: 'U', cls: 'is-u', title: 'Underline', act: () => wrapTag('u') },
      ],
      [
        { label: 'Link', title: 'Add link', act: () => { const u = prompt('Link address (e.g. /contact or https://…):'); if (u) run('createLink', u); } },
        { label: 'Clear', title: 'Clear formatting', act: () => run('removeFormat') },
      ],
    ];

    (inline ? inlineGroups : blockGroups).forEach((group, gi, arr) => {
      group.forEach((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rte-btn' + (b.cls ? ' ' + b.cls : '');
        btn.textContent = b.label;
        btn.title = b.title;
        btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
        btn.addEventListener('click', b.act);
        toolbar.appendChild(btn);
      });
      if (gi < arr.length - 1) {
        const sep = document.createElement('span'); sep.className = 'rte-sep'; toolbar.appendChild(sep);
      }
    });

    /* text colour — applies to the selected text (headings or body) */
    const sep = document.createElement('span'); sep.className = 'rte-sep'; toolbar.appendChild(sep);
    const colorWrap = document.createElement('label');
    colorWrap.className = 'rte-color';
    colorWrap.title = 'Text colour';
    colorWrap.innerHTML = '<span>A</span>';
    const color = document.createElement('input');
    color.type = 'color';
    color.value = '#231F20';
    color.addEventListener('mousedown', saveSel);
    color.addEventListener('input', () => run('foreColor', color.value));
    colorWrap.appendChild(color);
    toolbar.appendChild(colorWrap);
  });
})();