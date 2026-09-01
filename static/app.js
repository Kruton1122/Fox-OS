/* Fox OS frontend — window manager + apps v3.1 */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  let CFG = null;
  let zTop = 20;
  const windows = new Map();
  let trayTimer = null;
  const ICON_POS_KEY = 'foxos.iconPositions.v1';
  let ctxMenuEl = null;
  let cycleIdx = -1;

  const CODE_EXTS = new Set([
    'py', 'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'go', 'rs', 'c', 'cpp', 'cc', 'h', 'hpp',
    'java', 'kt', 'swift', 'rb', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'r', 'lua',
    'json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'xml', 'html', 'css',
    'scss', 'less', 'vue', 'svelte', 'dockerfile', 'makefile', 'cmake', 'gradle',
  ]);

  const fmtSize = (n) => {
    if (n == null || n === 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  };

  function apiUrl(path) {
    return String(path).replace(/^\//, '');
  }
  async function api(path, opts) {
    const r = await fetch(apiUrl(path), opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText || 'request failed');
    return data;
  }

  function tickClock() {
    const el = $('#clock');
    if (!el) return;
    const d = new Date();
    el.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function bootDone() {
    $('#boot')?.classList.add('hidden');
    $('#desktop')?.classList.remove('hidden');
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fileIcon(entry) {
    if (entry.is_dir) return '📁';
    const e = (entry.ext || '').toLowerCase();
    const m = entry.mime || '';
    if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(e)) return '🖼';
    if (m.startsWith('video/') || ['mp4', 'mkv', 'webm', 'mov'].includes(e)) return '🎬';
    if (m.startsWith('audio/') || ['mp3', 'wav', 'flac', 'ogg'].includes(e)) return '🎵';
    if (['py', 'js', 'ts', 'jsx', 'tsx', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'sh', 'bash'].includes(e)) return '💻';
    if (['json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env'].includes(e)) return '⚙';
    if (['md', 'txt', 'log', 'csv'].includes(e)) return '📄';
    if (['html', 'css', 'scss'].includes(e)) return '🌐';
    if (['zip', 'tar', 'gz', '7z', 'rar', 'bz2'].includes(e)) return '📦';
    if (['pdf'].includes(e)) return '📕';
    return '📄';
  }

  function stateBadge(state) {
    const s = String(state || '').toLowerCase();
    let cls = 'badge-muted';
    if (['running', 'active', 'up'].includes(s)) cls = 'badge-ok';
    else if (['exited', 'inactive', 'dead', 'failed', 'down'].includes(s)) cls = 'badge-bad';
    else if (['restarting', 'activating', 'deactivating'].includes(s)) cls = 'badge-warn';
    return `<span class="badge ${cls}">${escapeHtml(state || '?')}</span>`;
  }

  /* ── Desktop chrome ─────────────────────────────────────────────────── */
  function loadIconPositions() {
    try {
      return JSON.parse(localStorage.getItem(ICON_POS_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }
  function saveIconPositions(map) {
    try { localStorage.setItem(ICON_POS_KEY, JSON.stringify(map)); } catch { /* */ }
  }

  function renderDesktopIcons() {
    const host = $('#icons');
    if (!host || !CFG) return;
    const apps = CFG.apps || [];
    const pos = loadIconPositions();
    const hasAny = apps.some((a) => pos[a.id] && Number.isFinite(pos[a.id].x));
    host.classList.toggle('icon-freeform', hasAny);
    host.innerHTML = apps.map((a) => {
      const p = pos[a.id];
      const style = p && Number.isFinite(p.x)
        ? `left:${Math.max(0, p.x)}px;top:${Math.max(0, p.y)}px;`
        : '';
      const placed = style ? ' placed' : '';
      return `
      <button type="button" class="desk-icon${placed}" data-app="${a.id}" title="${escapeHtml(a.desc || a.label)}" style="${style}">
        <span class="ico">${a.icon || '📦'}</span>
        <span class="lbl">${escapeHtml(a.label)}</span>
      </button>`;
    }).join('');
    host.querySelectorAll('.desk-icon').forEach((btn) => {
      btn.addEventListener('dblclick', () => openApp(btn.dataset.app));
      btn.addEventListener('click', (e) => {
        $$('.desk-icon').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        if (e.detail === 1 && window.matchMedia('(pointer: coarse)').matches) {
          openApp(btn.dataset.app);
        }
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        $$('.desk-icon').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Open', action: () => openApp(btn.dataset.app) },
          { sep: true },
          { label: 'Reset icon position', action: () => {
            const m = loadIconPositions();
            delete m[btn.dataset.app];
            saveIconPositions(m);
            renderDesktopIcons();
          }},
        ]);
      });
      makeIconDraggable(btn);
    });
  }

  function makeIconDraggable(btn) {
    let sx, sy, ox, oy, dragging = false, moved = false;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      sx = e.clientX; sy = e.clientY;
      const host = $('#icons');
      const hr = host.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      ox = br.left - hr.left;
      oy = br.top - hr.top;
      btn.setPointerCapture(e.pointerId);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      const host = $('#icons');
      host.classList.add('icon-freeform');
      btn.classList.add('placed');
      const maxX = Math.max(0, host.clientWidth - btn.offsetWidth);
      const maxY = Math.max(0, host.clientHeight - btn.offsetHeight);
      const nx = Math.min(maxX, Math.max(0, ox + dx));
      const ny = Math.min(maxY, Math.max(0, oy + dy));
      btn.style.left = `${nx}px`;
      btn.style.top = `${ny}px`;
    });
    btn.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      if (!moved) return;
      const m = loadIconPositions();
      m[btn.dataset.app] = {
        x: parseFloat(btn.style.left) || 0,
        y: parseFloat(btn.style.top) || 0,
      };
      saveIconPositions(m);
    });
  }

  function startMenuEntries() {
    const apps = (CFG?.apps || []).map((a) => ({
      kind: 'app',
      id: a.id,
      label: a.label || a.id,
      desc: a.desc || '',
      icon: a.icon || '📦',
      search: `${a.label || ''} ${a.desc || ''} ${a.id || ''}`.toLowerCase(),
    }));
    const links = (CFG?.links || []).map((l) => ({
      kind: 'link',
      id: `link:${l.id || l.url}`,
      label: l.label || l.id || 'Bookmark',
      desc: l.group ? `Bookmark · ${l.group}` : (l.url || 'Bookmark'),
      icon: l.icon || '🔗',
      url: l.url,
      search: `${l.label || ''} ${l.group || ''} ${l.url || ''} ${l.id || ''}`.toLowerCase(),
    }));
    const about = {
      kind: 'app',
      id: '__about',
      label: 'About Fox OS',
      desc: `Version ${CFG?.version || '2'}`,
      icon: '🦊',
      search: `about fox os version ${CFG?.version || ''}`.toLowerCase(),
    };
    return [...apps, ...links, about];
  }

  function renderStartMenu(filterText) {
    const host = $('#startItems');
    if (!host || !CFG) return;
    const q = String(filterText || '').trim().toLowerCase();
    const entries = startMenuEntries().filter((e) => !q || e.search.includes(q));
    if (!entries.length) {
      host.innerHTML = `<div class="start-empty">No matches for “${escapeHtml(q)}”</div>`;
      return;
    }
    host.innerHTML = entries.map((e) => `
      <button type="button" class="start-item" data-kind="${e.kind}" data-id="${escapeHtml(e.id)}"
        ${e.url ? `data-url="${escapeHtml(e.url)}"` : ''} role="menuitem">
        <span class="ico">${e.icon || '📦'}</span>
        <span class="meta">
          <span class="name">${escapeHtml(e.label)}</span>
          <span class="desc">${escapeHtml(e.desc || '')}</span>
        </span>
      </button>
    `).join('');
    host.querySelectorAll('.start-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeStart();
        if (btn.dataset.kind === 'link' && btn.dataset.url) {
          openWebApp({
            id: btn.dataset.id,
            title: btn.querySelector('.name')?.textContent || 'Bookmark',
            icon: btn.querySelector('.ico')?.textContent || '🔗',
            url: btn.dataset.url,
            externalUrl: btn.dataset.url,
          });
          return;
        }
        openApp(btn.dataset.id);
      });
    });
  }

  function filterStartMenu() {
    const input = $('#startSearch');
    renderStartMenu(input?.value || '');
  }

  function toggleStart() {
    const m = $('#startMenu');
    const b = $('#startBtn');
    const open = m.classList.toggle('hidden') === false;
    b.classList.toggle('open', open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const input = $('#startSearch');
      if (input) {
        input.value = '';
        renderStartMenu('');
        setTimeout(() => input.focus(), 0);
      } else {
        renderStartMenu('');
      }
    }
  }
  function closeStart() {
    $('#startMenu')?.classList.add('hidden');
    $('#startBtn')?.classList.remove('open');
    $('#startBtn')?.setAttribute('aria-expanded', 'false');
    const input = $('#startSearch');
    if (input) input.value = '';
  }

  async function refreshTrayAndWidgets() {
    try {
      const s = await api('api/system');
      const cpu = s.cpu_percent;
      const mem = s.memory?.percent;
      const setMeter = (el, barId, label, pct) => {
        if (!el) return;
        const span = el.querySelector('span') || el;
        span.textContent = label;
        const bar = barId ? document.getElementById(barId) : el.querySelector('i');
        if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
      };
      setMeter($('#trayCpu'), 'trayCpuBar', cpu != null ? `CPU ${cpu}%` : 'CPU —', cpu);
      setMeter($('#trayMem'), 'trayMemBar', mem != null ? `RAM ${mem}%` : 'RAM —', mem);
      const tempEl = $('#trayTemp');
      if (tempEl) {
        tempEl.textContent = s.cpu_temp_c != null ? `${s.cpu_temp_c}°C` : '';
        tempEl.style.display = s.cpu_temp_c != null ? '' : 'none';
      }
      const diskEl = $('#trayDisk');
      if (diskEl) {
        const rootDisk = (s.disks || []).find((d) => d.mount === '/') || (s.disks || [])[0];
        if (rootDisk) {
          diskEl.textContent = `${fmtSize(rootDisk.available)} free`;
          diskEl.title = `${rootDisk.mount}: ${rootDisk.percent} used · ${fmtSize(rootDisk.available)} free of ${fmtSize(rootDisk.size)}`;
          diskEl.style.display = '';
        } else {
          diskEl.textContent = '';
          diskEl.style.display = 'none';
        }
      }

      const w = $('#widgets');
      if (w) {
        const rootDisk = (s.disks || []).find((d) => d.mount === '/') || (s.disks || [])[0];
        const diskHtml = rootDisk ? `
            <div class="widget-row"><span>Disk ${escapeHtml(rootDisk.mount)}</span><strong>${rootDisk.percent}</strong></div>
            <div class="meter"><i style="width:${parseInt(rootDisk.percent, 10) || 0}%"></i></div>
            <div class="disk-row">${fmtSize(rootDisk.available)} free · ${fmtSize(rootDisk.size)}</div>` : '';
        w.innerHTML = `
          <div class="widget">
            <div class="widget-title">🦊 ${escapeHtml(s.hostname || '')}</div>
            <div class="widget-row"><span>Uptime</span><strong>${escapeHtml(s.uptime_human || '—')}</strong></div>
            <div class="widget-row"><span>Load</span><strong>${(s.load?.['1'] ?? 0).toFixed?.(2) ?? s.load?.['1']}</strong></div>
            <div class="widget-row"><span>CPU</span><strong>${cpu != null ? cpu + '%' : '—'}${s.cpu_temp_c != null ? ' · ' + s.cpu_temp_c + '°C' : ''}</strong></div>
            <div class="meter hot"><i style="width:${cpu || 0}%"></i></div>
            <div class="widget-row"><span>RAM</span><strong>${mem != null ? mem + '%' : '—'}</strong></div>
            <div class="meter"><i style="width:${mem || 0}%"></i></div>
            ${diskHtml}
          </div>`;
      }
    } catch {
      /* ignore tray errors */
    }
  }

  /* ── Context menu ───────────────────────────────────────────────────── */
  function closeContextMenu() {
    if (ctxMenuEl) {
      ctxMenuEl.remove();
      ctxMenuEl = null;
    }
  }
  function showContextMenu(x, y, items) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (it.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        return;
      }
      if (it.hint) {
        const h = document.createElement('div');
        h.className = 'ctx-hint';
        h.textContent = it.hint;
        menu.appendChild(h);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-item' + (it.danger ? ' ctx-danger' : '');
      btn.textContent = it.label;
      btn.disabled = !!it.disabled;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu();
        if (it.action) it.action();
      });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.min(x, vw - mw - 4)}px`;
    menu.style.top = `${Math.min(y, vh - mh - 4)}px`;
    ctxMenuEl = menu;
  }

  /* ── Window manager ─────────────────────────────────────────────────── */
  function focusWin(id) {
    windows.forEach((w, wid) => {
      w.el.classList.toggle('active', wid === id);
      w.el.classList.remove('minimized');
      if (w.task) w.task.classList.toggle('active', wid === id);
    });
    const w = windows.get(id);
    if (w) {
      zTop += 1;
      w.el.style.zIndex = String(zTop);
    }
  }

  function closeWin(id) {
    const w = windows.get(id);
    if (!w) return;
    if (w.onClose) try { w.onClose(); } catch { /* */ }
    w.el.remove();
    w.task?.remove();
    windows.delete(id);
  }


  const SNAP_EDGE = 28;

  function deskBounds() {
    const desk = $('#windows');
    const w = desk?.clientWidth || window.innerWidth;
    const h = desk?.clientHeight || window.innerHeight;
    return { w, h };
  }

  function clearSnapClasses(el) {
    el.classList.remove('snapped-left', 'snapped-right', 'maximized');
  }

  function saveWinGeom(rec, el) {
    rec.restore = {
      left: el.style.left,
      top: el.style.top,
      width: el.style.width || `${el.offsetWidth}px`,
      height: el.style.height || `${el.offsetHeight}px`,
    };
  }

  function restoreWinGeom(rec, el) {
    if (!rec.restore) return;
    clearSnapClasses(el);
    el.style.left = rec.restore.left;
    el.style.top = rec.restore.top;
    el.style.width = rec.restore.width;
    el.style.height = rec.restore.height;
    const maxBtn = $('.win-max', el);
    if (maxBtn) maxBtn.title = 'Maximize';
  }

  function snapWindow(rec, side) {
    const el = rec.el;
    const { w, h } = deskBounds();
    if (!rec.restore || el.classList.contains('maximized') || el.classList.contains('snapped-left') || el.classList.contains('snapped-right')) {
      if (!el.classList.contains('maximized') && !el.classList.contains('snapped-left') && !el.classList.contains('snapped-right')) {
        saveWinGeom(rec, el);
      }
    } else {
      saveWinGeom(rec, el);
    }
    clearSnapClasses(el);
    if (side === 'left') {
      el.classList.add('snapped-left');
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.width = `${Math.floor(w / 2)}px`;
      el.style.height = `${h}px`;
    } else if (side === 'right') {
      el.classList.add('snapped-right');
      const half = Math.floor(w / 2);
      el.style.left = `${w - half}px`;
      el.style.top = '0px';
      el.style.width = `${half}px`;
      el.style.height = `${h}px`;
    } else if (side === 'max') {
      el.classList.add('maximized');
      $('.win-max', el).title = 'Restore';
    }
    hideSnapGuide();
  }

  function showSnapGuide(side) {
    const g = $('#snapGuide');
    if (!g) return;
    const { w, h } = deskBounds();
    g.classList.remove('hidden', 'left', 'right', 'top');
    if (side === 'left') {
      g.classList.add('left');
      g.style.left = '0'; g.style.top = '0';
      g.style.width = `${Math.floor(w / 2)}px`; g.style.height = `${h}px`;
    } else if (side === 'right') {
      g.classList.add('right');
      const half = Math.floor(w / 2);
      g.style.left = `${w - half}px`; g.style.top = '0';
      g.style.width = `${half}px`; g.style.height = `${h}px`;
    } else if (side === 'top') {
      g.classList.add('top');
      g.style.left = '0'; g.style.top = '0';
      g.style.width = `${w}px`; g.style.height = `${h}px`;
    }
  }
  function hideSnapGuide() {
    $('#snapGuide')?.classList.add('hidden');
  }

  function activeWindowRec() {
    for (const rec of windows.values()) {
      if (rec.el.classList.contains('active') && !rec.el.classList.contains('minimized')) return rec;
    }
    return null;
  }

  function createWindow({ id, title, icon, bodyHtml, width, height }) {
    if (windows.has(id)) {
      focusWin(id);
      return windows.get(id);
    }
    const tpl = $('#tpl-window');
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.dataset.win = id;
    $('.win-title', el).textContent = title;
    $('.win-ico', el).textContent = icon || '📦';
    $('.win-body', el).innerHTML = bodyHtml || '';

    const n = windows.size;
    const left = 36 + (n % 8) * 28;
    const top = 24 + (n % 8) * 22;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    if (width) el.style.width = typeof width === 'number' ? `${width}px` : width;
    if (height) el.style.height = typeof height === 'number' ? `${height}px` : height;

    // Resize handles (edges + corners)
    ;['n', 's', 'e', 'w'].forEach((dir) => {
      const h = document.createElement('div');
      h.className = `win-resize ${dir}`;
      h.dataset.dir = dir;
      el.appendChild(h);
    });
    ;['ne', 'nw', 'se', 'sw'].forEach((dir) => {
      const h = document.createElement('div');
      h.className = `win-resize-corner ${dir}`;
      h.dataset.dir = dir;
      el.appendChild(h);
    });

    $('#windows').appendChild(el);

    const task = document.createElement('button');
    task.type = 'button';
    task.className = 'task-tab';
    task.textContent = `${icon || ''} ${title}`.trim();
    task.addEventListener('click', () => {
      if (el.classList.contains('minimized')) el.classList.remove('minimized');
      else if (el.classList.contains('active')) el.classList.add('minimized');
      focusWin(id);
    });
    $('#taskTabs').appendChild(task);

    const rec = { el, task, kind: id, state: {}, onClose: null, restore: null };
    windows.set(id, rec);

    const toggleMax = () => {
      if (el.classList.contains('maximized') || el.classList.contains('snapped-left') || el.classList.contains('snapped-right')) {
        restoreWinGeom(rec, el);
      } else {
        snapWindow(rec, 'max');
      }
    };

    $('.win-close', el).addEventListener('click', () => closeWin(id));
    $('.win-min', el).addEventListener('click', () => {
      el.classList.add('minimized');
      task.classList.remove('active');
    });
    $('.win-max', el).addEventListener('click', toggleMax);
    el.addEventListener('mousedown', () => focusWin(id));
    $('.win-titlebar', el).addEventListener('dblclick', toggleMax);

    makeDraggable(el, $('.win-titlebar', el));
    makeResizable(el);
    focusWin(id);
    return rec;
  }

  function makeDraggable(win, bar) {
    let sx, sy, ox, oy, dragging = false, pendingSide = null;
    const recOf = () => windows.get(win.dataset.win);
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      const rec = recOf();
      // Unsnap / unmaximize on drag start, keeping pointer offset sensible
      if (win.classList.contains('maximized') || win.classList.contains('snapped-left') || win.classList.contains('snapped-right')) {
        const rw = rec?.restore?.width ? parseInt(rec.restore.width, 10) : Math.min(640, deskBounds().w - 40);
        const rh = rec?.restore?.height ? parseInt(rec.restore.height, 10) : Math.min(420, deskBounds().h - 40);
        clearSnapClasses(win);
        win.style.width = `${rw}px`;
        win.style.height = `${rh}px`;
        const left = Math.max(0, e.clientX - Math.floor(rw / 2));
        const top = Math.max(0, e.clientY - 12);
        win.style.left = `${left}px`;
        win.style.top = `${top}px`;
        $('.win-max', win).title = 'Maximize';
        ox = left; oy = top;
      } else {
        ox = win.offsetLeft; oy = win.offsetTop;
      }
      dragging = true;
      pendingSide = null;
      sx = e.clientX; sy = e.clientY;
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const desk = $('#windows');
      const maxL = Math.max(0, (desk?.clientWidth || window.innerWidth) - 80);
      const maxT = Math.max(0, (desk?.clientHeight || window.innerHeight) - 40);
      win.style.left = `${Math.min(maxL, Math.max(0, ox + e.clientX - sx))}px`;
      win.style.top = `${Math.min(maxT, Math.max(0, oy + e.clientY - sy))}px`;
      const { w } = deskBounds();
      if (e.clientY <= SNAP_EDGE) pendingSide = 'top';
      else if (e.clientX <= SNAP_EDGE) pendingSide = 'left';
      else if (e.clientX >= w - SNAP_EDGE) pendingSide = 'right';
      else pendingSide = null;
      if (pendingSide) showSnapGuide(pendingSide);
      else hideSnapGuide();
    });
    bar.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const rec = recOf();
      const side = pendingSide;
      pendingSide = null;
      hideSnapGuide();
      if (!rec || !side) return;
      if (side === 'left') snapWindow(rec, 'left');
      else if (side === 'right') snapWindow(rec, 'right');
      else if (side === 'top') snapWindow(rec, 'max');
    });
  }

  function makeResizable(win) {
    const minW = 280;
    const minH = 180;
    win.querySelectorAll('.win-resize, .win-resize-corner').forEach((handle) => {
      let sx, sy, ol, ot, ow, oh, resizing = false;
      const dir = handle.dataset.dir || '';
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (win.classList.contains('maximized') || win.classList.contains('snapped-left') || win.classList.contains('snapped-right')) return;
        e.preventDefault();
        e.stopPropagation();
        resizing = true;
        sx = e.clientX; sy = e.clientY;
        ol = win.offsetLeft; ot = win.offsetTop;
        ow = win.offsetWidth; oh = win.offsetHeight;
        handle.setPointerCapture(e.pointerId);
        focusWin(win.dataset.win);
      });
      handle.addEventListener('pointermove', (e) => {
        if (!resizing) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        let left = ol, top = ot, width = ow, height = oh;
        if (dir.includes('e')) width = Math.max(minW, ow + dx);
        if (dir.includes('s')) height = Math.max(minH, oh + dy);
        if (dir.includes('w')) {
          width = Math.max(minW, ow - dx);
          left = ol + (ow - width);
        }
        if (dir.includes('n')) {
          height = Math.max(minH, oh - dy);
          top = ot + (oh - height);
        }
        win.style.left = `${Math.max(0, left)}px`;
        win.style.top = `${Math.max(0, top)}px`;
        win.style.width = `${width}px`;
        win.style.height = `${height}px`;
      });
      handle.addEventListener('pointerup', () => { resizing = false; });
    });
  }

  function cycleWindows(backward) {
    const ids = [...windows.keys()].filter((id) => {
      const w = windows.get(id);
      return w && !w.el.classList.contains('minimized');
    });
    if (!ids.length) return;
    if (cycleIdx < 0 || cycleIdx >= ids.length) {
      const active = ids.findIndex((id) => windows.get(id)?.el.classList.contains('active'));
      cycleIdx = active >= 0 ? active : 0;
    }
    cycleIdx = backward
      ? (cycleIdx - 1 + ids.length) % ids.length
      : (cycleIdx + 1) % ids.length;
    focusWin(ids[cycleIdx]);
  }

  /**
   * Map external hostnames → same-origin /embed/<app>/ paths (optional reverse-proxy).
   * Config: embed_map { "app.example.com": "appkey" }. Hostname without map is left as-is.
   */
  function embedHosts() {
    const fromCfg = CFG?.embed_map || {};
    // Built-in empty; site-specific maps live in config.json only
    return { ...fromCfg };
  }

  function toEmbedUrl(url) {
    if (!url) return url;
    // already same-origin embed
    if (String(url).startsWith('/embed/')) return url;
    try {
      const u = new URL(url, window.location.origin);
      // relative path on this host
      if (!u.hostname || u.hostname === window.location.hostname) {
        if (u.pathname.startsWith('/embed/')) return u.pathname + u.search + u.hash;
      }
      const map = embedHosts();
      const key = map[u.hostname] || map[u.host];
      if (!key) return url;
      let path = u.pathname || '/';
      // pihole links often include /admin
      if (key === 'pihole' && (path === '/admin' || path.startsWith('/admin/'))) {
        path = path.slice('/admin'.length) || '/';
      }
      if (!path.startsWith('/')) path = `/${path}`;
      // ensure trailing structure: /embed/key + path
      const base = `/embed/${key}`;
      const full = path === '/' ? `${base}/` : `${base}${path}`;
      return full + (u.search || '') + (u.hash || '');
    } catch {
      return url;
    }
  }

  function openApp(appId) {
    if (appId === '__about') {
      createWindow({
        id: 'about',
        title: 'About Fox OS',
        icon: '🦊',
        width: 440,
        height: 360,
        bodyHtml: `
          <div class="settings">
            <h2>🦊 Fox OS <span class="badge badge-ok">v${escapeHtml(CFG?.version || '2')}</span></h2>
            <p>Web desktop for headless servers — files, system stats, programs, Docker, logs, and bookmarks. Inspired by Cockpit, CasaOS, and classic Win 3.1.</p>
            <p>Host: <code>${escapeHtml(CFG?.hostname || '')}</code> · User: <code>${escapeHtml(CFG?.user || '')}</code></p>
            <p class="muted" style="font-size:12px;margin-top:12px">Fox OS v${escapeHtml(CFG?.version || '')}</p>
          </div>`,
      });
      return;
    }
    const app = (CFG.apps || []).find((a) => a.id === appId);
    if (!app) return;
    const actions = {
      files: openFiles,
      trash: openTrash,
      system: openSystem,
      settings: openSettings,
      processes: openProcesses,
      programs: openPrograms,
      docker: openDocker,
      services: openServices,
      network: openNetwork,
      logs: openLogs,
      launcher: openLauncher,
      notes: openNotes,
      calc: openCalc,
    };
    if (app.action && actions[app.action]) return actions[app.action]();
    const openUrl = app.embed || app.url;
    if (openUrl) {
      openWebApp({
        id: `app:${app.id}`,
        title: app.label || app.id,
        icon: app.icon || '🌐',
        url: openUrl,
        externalUrl: app.url || openUrl,
      });
      return;
    }
  }

  /** Open a URL inside a Fox OS window (same-origin /embed iframe when possible). */
  function openWebApp({ id, title, icon, url, externalUrl, width, height }) {
    if (!url) return;
    const embedUrl = toEmbedUrl(url);
    const popoutUrl = externalUrl || url;
    const winId = id || `web:${embedUrl}`;
    if (windows.has(winId)) {
      focusWin(winId);
      return windows.get(winId);
    }
    const rec = createWindow({
      id: winId,
      title: title || 'App',
      icon: icon || '🌐',
      width: width || Math.min(960, window.innerWidth - 48),
      height: height || Math.min(640, window.innerHeight - 80),
      bodyHtml: `
        <div class="webapp">
          <div class="webapp-bar">
            <button type="button" data-act="back" title="Back">←</button>
            <button type="button" data-act="fwd" title="Forward">→</button>
            <button type="button" data-act="reload" title="Reload">↻</button>
            <input class="webapp-url" data-act="url" readonly value="${escapeHtml(embedUrl)}" />
            <button type="button" data-act="popout" title="Open in browser tab">↗</button>
          </div>
          <div class="webapp-frame-wrap">
            <div class="webapp-loading" data-act="loading">Loading ${escapeHtml(title || 'app')}…</div>
            <iframe
              class="webapp-frame"
              data-act="frame"
              src="${escapeHtml(embedUrl)}"
              title="${escapeHtml(title || 'app')}"
              allow="fullscreen; clipboard-read; clipboard-write"
              referrerpolicy="no-referrer-when-downgrade"
            ></iframe>
          </div>
          <div class="webapp-hint hidden" data-act="hint">
            <p>This app could not load in a window.</p>
            <button type="button" data-act="popout2">Open in new tab instead</button>
          </div>
        </div>`,
    });

    const shell = $('.webapp', rec.el);
    const frame = $('[data-act="frame"]', shell);
    const loading = $('[data-act="loading"]', shell);
    const hint = $('[data-act="hint"]', shell);
    const urlInput = $('[data-act="url"]', shell);

    rec.el.classList.add('win-webapp');

    const hideLoading = () => loading?.classList.add('hidden');
    frame.addEventListener('load', () => {
      hideLoading();
      try {
        const href = frame.contentWindow?.location?.href;
        if (href && href !== 'about:blank') urlInput.value = href.replace(window.location.origin, '');
      } catch {
        /* ignore */
      }
    });
    setTimeout(hideLoading, 10000);

    $('[data-act="reload"]', shell).onclick = () => {
      loading?.classList.remove('hidden');
      try {
        frame.contentWindow.location.reload();
      } catch {
        frame.src = frame.src;
      }
    };
    $('[data-act="back"]', shell).onclick = () => {
      try { frame.contentWindow.history.back(); } catch { /* */ }
    };
    $('[data-act="fwd"]', shell).onclick = () => {
      try { frame.contentWindow.history.forward(); } catch { /* */ }
    };
    // Pop out to real hostname (user may need cert trust there)
    const popout = () => window.open(popoutUrl, '_blank', 'noopener');
    $('[data-act="popout"]', shell).onclick = popout;
    $('[data-act="popout2"]', shell).onclick = popout;

    frame.addEventListener('error', () => {
      hideLoading();
      hint?.classList.remove('hidden');
    });

    return rec;
  }


  /* ── Recycle Bin ────────────────────────────────────────────────────── */
  function openTrash() {
    const id = 'trash';
    if (windows.has(id)) { focusWin(id); return; }
    const rec = createWindow({
      id,
      title: 'Recycle Bin',
      icon: '🗑',
      width: 720,
      height: 480,
      bodyHtml: `
        <div class="trash-app app-shell">
          <div class="app-toolbar">
            <button type="button" data-act="restore" disabled>Restore</button>
            <button type="button" data-act="delete" class="exp-danger" disabled>Delete permanently</button>
            <button type="button" data-act="empty" class="exp-danger">Empty Recycle Bin</button>
            <span class="exp-spacer"></span>
            <button type="button" data-act="refresh">↻ Refresh</button>
          </div>
          <div class="trash-body">
            <div class="file-list" data-act="list"><div class="empty">Loading…</div></div>
          </div>
          <div class="exp-status">
            <span data-act="status-left">Ready</span>
            <span data-act="status-right"></span>
          </div>
        </div>`,
    });
    const root = $('.trash-app', rec.el);
    const state = { items: [], selected: null };
    rec.state = state;

    const setStatus = (left, right) => {
      const a = $('[data-act="status-left"]', root);
      const b = $('[data-act="status-right"]', root);
      if (a) a.textContent = left || '';
      if (b) b.textContent = right || '';
    };

    const syncBtns = () => {
      const has = !!state.selected;
      $('[data-act="restore"]', root).disabled = !has;
      $('[data-act="delete"]', root).disabled = !has;
    };

    const render = (data) => {
      state.items = data.items || [];
      state.selected = null;
      syncBtns();
      const list = $('[data-act="list"]', root);
      if (!data.enabled) {
        list.innerHTML = `<div class="empty">Recycle Bin is disabled (<code>trash_enabled</code>).</div>`;
        setStatus('Disabled', '');
        return;
      }
      if (!state.items.length) {
        list.innerHTML = `<div class="empty">Recycle Bin is empty.</div>`;
        setStatus('0 items', fmtSize(data.total_size || 0));
        return;
      }
      list.innerHTML = `
        <table class="file-table trash-table">
          <thead><tr>
            <th>Name</th><th>Original location</th><th>Deleted</th><th>Size</th>
          </tr></thead>
          <tbody>
            ${state.items.map((it) => `
              <tr data-id="${escapeHtml(it.id)}" tabindex="0">
                <td>${it.is_dir ? '📁' : '📄'} ${escapeHtml(it.name || '')}</td>
                <td><code>${escapeHtml((it.original_root || '') + '/' + (it.path || ''))}</code></td>
                <td>${escapeHtml(it.deleted_iso || '')}</td>
                <td>${it.is_dir ? '—' : fmtSize(it.size || 0)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
      list.querySelectorAll('tr[data-id]').forEach((row) => {
        row.addEventListener('click', () => {
          list.querySelectorAll('.selected').forEach((r) => r.classList.remove('selected'));
          row.classList.add('selected');
          state.selected = row.dataset.id;
          syncBtns();
        });
        row.addEventListener('dblclick', () => {
          state.selected = row.dataset.id;
          $('[data-act="restore"]', root).click();
        });
      });
      const caps = [];
      if (data.max_mb) caps.push(`max ${data.max_mb} MB`);
      if (data.max_age_days) caps.push(`${data.max_age_days}d`);
      setStatus(
        `${state.items.length} item${state.items.length === 1 ? '' : 's'} · ${fmtSize(data.total_size || 0)}`,
        caps.join(' · ')
      );
    };

    const load = async () => {
      setStatus('Loading…', '');
      try {
        const data = await api('api/trash');
        render(data);
      } catch (e) {
        $('[data-act="list"]', root).innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
        setStatus(e.message, '');
      }
    };

    $('[data-act="refresh"]', root).onclick = load;
    $('[data-act="restore"]', root).onclick = async () => {
      if (!state.selected) return;
      try {
        const res = await api('api/trash/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.selected }),
        });
        if (res.renamed) setStatus(`Restored as ${res.name}`, '');
        await load();
      } catch (e) { alert(e.message); }
    };
    $('[data-act="delete"]', root).onclick = async () => {
      if (!state.selected) return;
      const it = state.items.find((x) => x.id === state.selected);
      if (!confirm(`Permanently delete '${it?.name || 'item'}'?`)) return;
      try {
        await api('api/trash/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: state.selected }),
        });
        await load();
      } catch (e) { alert(e.message); }
    };
    $('[data-act="empty"]', root).onclick = async () => {
      if (!state.items.length) return;
      if (!confirm(`Permanently delete all ${state.items.length} item(s) in the Recycle Bin?`)) return;
      try {
        await api('api/trash/empty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        await load();
      } catch (e) { alert(e.message); }
    };

    load();
  }

  /* ── File Explorer (Windows-style) ──────────────────────────────────── */
  function openFiles() {
    const id = 'files';
    const rootDefault = CFG.default_root || 'home';
    const rec = createWindow({
      id,
      title: 'File Explorer',
      icon: '📁',
      width: 920,
      height: 580,
      bodyHtml: `
        <div class="explorer">
          <div class="exp-cmd">
            <button type="button" data-act="newfolder" title="New folder">📁+ New folder</button>
            <span class="exp-sep"></span>
            <button type="button" data-act="cut" disabled title="Coming soon">Cut</button>
            <button type="button" data-act="copy" title="Copy path">Copy path</button>
            <button type="button" data-act="paste" disabled>Paste</button>
            <span class="exp-sep"></span>
            <button type="button" data-act="rename">Rename</button>
            <button type="button" data-act="delete" class="exp-danger" title="Move to Recycle Bin (Shift+Delete = permanent)">Delete</button>
            <span class="exp-sep"></span>
            <label class="exp-upload">Upload<input type="file" data-act="upload" hidden /></label>
            <button type="button" data-act="download">Download</button>
            <span class="exp-spacer"></span>
            <button type="button" data-act="view-details" class="active" title="Details">☰</button>
            <button type="button" data-act="view-icons" title="Icons">▦</button>
          </div>
          <div class="exp-navrow">
            <button type="button" data-act="back" title="Back" disabled>←</button>
            <button type="button" data-act="forward" title="Forward" disabled>→</button>
            <button type="button" data-act="up" title="Up">↑</button>
            <button type="button" data-act="refresh" title="Refresh">↻</button>
            <div class="exp-address" data-act="address"></div>
            <input class="exp-search" data-act="filter" placeholder="Search this folder" />
          </div>
          <div class="exp-main">
            <aside class="exp-sidebar" data-act="sidebar">
              <div class="exp-side-loading">Loading places…</div>
            </aside>
            <div class="exp-content">
              <div class="file-list" data-act="list"><div class="empty">Loading…</div></div>
            </div>
            <aside class="exp-details" data-act="details">
              <div class="exp-details-empty">Select a file to see details</div>
            </aside>
          </div>
          <div class="exp-status">
            <span data-act="status-left">Ready</span>
            <span data-act="status-right"></span>
          </div>
        </div>`,
    });

    const root = $('.explorer', rec.el);
    const state = {
      view: 'thispc', // thispc | network | folder
      root: rootDefault,
      path: '',
      selected: null,
      selectedEntry: null,
      entries: [],
      filter: '',
      places: null,
      history: [],
      histIdx: -1,
      layout: 'details', // details | icons
      suppressHist: false,
    };
    rec.state = state;

    const setStatus = (left, right) => {
      const a = $('[data-act="status-left"]', root);
      const b = $('[data-act="status-right"]', root);
      if (a) a.textContent = left || '';
      if (b) b.textContent = right || '';
    };

    const pushHist = () => {
      if (state.suppressHist) return;
      const snap = { view: state.view, root: state.root, path: state.path };
      // drop forward stack
      state.history = state.history.slice(0, state.histIdx + 1);
      const last = state.history[state.history.length - 1];
      if (last && last.view === snap.view && last.root === snap.root && last.path === snap.path) return;
      state.history.push(snap);
      state.histIdx = state.history.length - 1;
      updateNavButtons();
    };

    const updateNavButtons = () => {
      const back = $('[data-act="back"]', root);
      const fwd = $('[data-act="forward"]', root);
      if (back) back.disabled = state.histIdx <= 0;
      if (fwd) fwd.disabled = state.histIdx >= state.history.length - 1;
    };

    const goHist = (idx) => {
      const snap = state.history[idx];
      if (!snap) return;
      state.suppressHist = true;
      state.histIdx = idx;
      state.view = snap.view;
      state.root = snap.root;
      state.path = snap.path;
      load().finally(() => {
        state.suppressHist = false;
        updateNavButtons();
      });
    };

    const renderAddress = (data) => {
      const host = $('[data-act="address"]', root);
      if (!host) return;
      if (state.view === 'thispc') {
        host.innerHTML = `<button type="button" data-jump="thispc">This PC</button>`;
      } else if (state.view === 'network') {
        host.innerHTML = `<button type="button" data-jump="network">Network</button>`;
      } else {
        const label = data?.root_label || placeLabel(state.root);
        let html = `<button type="button" data-jump="thispc">This PC</button>`;
        if (data?.root_kind === 'network' || placeKind(state.root) === 'network') {
          html += `<span class="exp-addr-sep">›</span><button type="button" data-jump="network">Network</button>`;
        }
        html += `<span class="exp-addr-sep">›</span><button type="button" data-root="${escapeHtml(state.root)}" data-p="">${escapeHtml(label)}</button>`;
        (data?.crumbs || []).forEach((c) => {
          html += `<span class="exp-addr-sep">›</span><button type="button" data-root="${escapeHtml(state.root)}" data-p="${escapeHtml(c.path)}">${escapeHtml(c.name)}</button>`;
        });
        host.innerHTML = html;
      }
      host.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          if (b.dataset.jump === 'thispc') { state.view = 'thispc'; state.path = ''; load(); return; }
          if (b.dataset.jump === 'network') { state.view = 'network'; state.path = ''; load(); return; }
          state.view = 'folder';
          state.root = b.dataset.root || state.root;
          state.path = b.dataset.p || '';
          load();
        };
      });
    };

    const placeLabel = (rid) => {
      const p = (state.places?.all || CFG.roots || []).find((x) => x.id === rid);
      return p?.label || rid;
    };
    const placeKind = (rid) => {
      const p = (state.places?.all || CFG.roots || []).find((x) => x.id === rid);
      return p?.kind || 'local';
    };

    const renderSidebar = () => {
      const side = $('[data-act="sidebar"]', root);
      if (!side || !state.places) return;
      const qa = state.places.quick_access || [];
      const pc = state.places.this_pc || [];
      const net = state.places.network || [];
      side.innerHTML = `
        <div class="exp-group">
          <div class="exp-group-title">Quick access</div>
          ${qa.map((q) => `
            <button type="button" class="exp-navitem ${state.view === 'folder' && state.root === q.root && state.path === (q.path || '') ? 'active' : ''}"
              data-nav="folder" data-root="${escapeHtml(q.root)}" data-path="${escapeHtml(q.path || '')}">
              <span class="exp-ico">${q.icon || '📁'}</span>
              <span class="exp-navlabel">${escapeHtml(q.label)}</span>
            </button>
          `).join('')}
        </div>
        <div class="exp-group">
          <button type="button" class="exp-navitem exp-navhead ${state.view === 'thispc' ? 'active' : ''}" data-nav="thispc">
            <span class="exp-ico">💻</span>
            <span class="exp-navlabel">This PC</span>
          </button>
          ${pc.map((p) => `
            <button type="button" class="exp-navitem exp-indent ${state.view === 'folder' && state.root === p.id ? 'active' : ''} ${p.exists ? '' : 'missing'}"
              data-nav="folder" data-root="${escapeHtml(p.id)}" data-path="">
              <span class="exp-ico">${p.icon || '🖴'}</span>
              <span class="exp-navlabel">${escapeHtml(p.label)}</span>
            </button>
          `).join('')}
        </div>
        <div class="exp-group">
          <button type="button" class="exp-navitem exp-navhead ${state.view === 'network' ? 'active' : ''}" data-nav="network">
            <span class="exp-ico">🌐</span>
            <span class="exp-navlabel">Network</span>
          </button>
          ${net.map((p) => `
            <button type="button" class="exp-navitem exp-indent ${state.view === 'folder' && state.root === p.id ? 'active' : ''} ${p.exists || p.mounted ? '' : 'missing'}"
              data-nav="folder" data-root="${escapeHtml(p.id)}" data-path="">
              <span class="exp-ico">${p.icon || '🖧'}</span>
              <span class="exp-navlabel">${escapeHtml(p.label)}</span>
              ${p.source ? `<span class="exp-navmeta" title="${escapeHtml(p.source)}">🖧</span>` : ''}
            </button>
          `).join('') || '<div class="exp-side-empty">No network locations</div>'}
        </div>`;
      side.querySelectorAll('[data-nav]').forEach((btn) => {
        btn.onclick = () => {
          const nav = btn.dataset.nav;
          if (nav === 'thispc') { state.view = 'thispc'; state.selected = null; load(); return; }
          if (nav === 'network') { state.view = 'network'; state.selected = null; load(); return; }
          state.view = 'folder';
          state.root = btn.dataset.root;
          state.path = btn.dataset.path || '';
          state.selected = null;
          load();
        };
      });
    };

    const renderPlacesGrid = (places, title, emptyMsg) => {
      const list = $('[data-act="list"]', root);
      if (!places.length) {
        list.innerHTML = `<div class="empty">${escapeHtml(emptyMsg)}</div>`;
        return;
      }
      list.innerHTML = `
        <div class="exp-places">
          <div class="exp-places-title">${escapeHtml(title)}</div>
          <div class="exp-places-grid">
            ${places.map((p) => {
              const free = p.usage ? fmtSize(p.usage.free) + ' free' : '';
              const total = p.usage ? fmtSize(p.usage.total) : '';
              const pct = p.usage?.percent ?? 0;
              return `
                <button type="button" class="exp-drive ${p.exists === false ? 'missing' : ''}" data-root="${escapeHtml(p.id)}">
                  <div class="exp-drive-ico">${p.icon || (p.kind === 'network' ? '🖧' : '🖴')}</div>
                  <div class="exp-drive-meta">
                    <div class="exp-drive-name">${escapeHtml(p.label)}</div>
                    <div class="exp-drive-path">${escapeHtml(p.desc || p.source || p.path || '')}</div>
                    ${p.usage ? `
                      <div class="exp-drive-bar"><i style="width:${pct}%"></i></div>
                      <div class="exp-drive-free">${escapeHtml(free)} of ${escapeHtml(total)}</div>
                    ` : `<div class="exp-drive-free">${p.exists === false ? 'Not available' : (p.mounted ? 'Mounted' : '')}</div>`}
                  </div>
                </button>`;
            }).join('')}
          </div>
        </div>`;
      list.querySelectorAll('.exp-drive').forEach((btn) => {
        btn.ondblclick = () => {
          state.view = 'folder';
          state.root = btn.dataset.root;
          state.path = '';
          load();
        };
        btn.onclick = () => {
          list.querySelectorAll('.exp-drive').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          state.selected = null;
          state.selectedEntry = null;
          const p = places.find((x) => x.id === btn.dataset.root);
          showDetailsPlace(p);
        };
      });
    };

    const showDetailsPlace = (p) => {
      const d = $('[data-act="details"]', root);
      if (!d || !p) { if (d) d.innerHTML = '<div class="exp-details-empty">Select a location</div>'; return; }
      d.innerHTML = `
        <div class="exp-details-ico">${p.icon || '🖴'}</div>
        <div class="exp-details-name">${escapeHtml(p.label)}</div>
        <div class="exp-details-rows">
          <div><span>Type</span><span>${p.kind === 'network' ? 'Network location' : 'Local disk'}</span></div>
          <div><span>Path</span><span>${escapeHtml(p.path || '')}</span></div>
          ${p.source ? `<div><span>Remote</span><span>${escapeHtml(p.source)}</span></div>` : ''}
          ${p.fstype ? `<div><span>File system</span><span>${escapeHtml(p.fstype)}</span></div>` : ''}
          ${p.usage ? `
            <div><span>Used</span><span>${fmtSize(p.usage.used)} (${p.usage.percent}%)</span></div>
            <div><span>Free</span><span>${fmtSize(p.usage.free)}</span></div>
            <div><span>Total</span><span>${fmtSize(p.usage.total)}</span></div>
          ` : ''}
          <div><span>Access</span><span>${p.writable ? 'Read / write' : 'Read-only'}</span></div>
        </div>`;
    };

    const showDetailsEntry = (e) => {
      const d = $('[data-act="details"]', root);
      if (!d) return;
      if (!e) {
        d.innerHTML = '<div class="exp-details-empty">Select a file to see details</div>';
        return;
      }
      d.innerHTML = `
        <div class="exp-details-ico">${fileIcon(e)}</div>
        <div class="exp-details-name">${escapeHtml(e.name)}</div>
        <div class="exp-details-rows">
          <div><span>Type</span><span>${escapeHtml(e.type_label || (e.is_dir ? 'File folder' : 'File'))}</span></div>
          ${!e.is_dir ? `<div><span>Size</span><span>${fmtSize(e.size)}</span></div>` : ''}
          <div><span>Modified</span><span>${escapeHtml(e.mtime_iso || '')}</span></div>
          <div><span>Location</span><span>${escapeHtml(state.path || placeLabel(state.root))}</span></div>
          ${e.mode ? `<div><span>Mode</span><span>${escapeHtml(e.mode)}</span></div>` : ''}
        </div>`;
    };

    const renderFileTable = (data) => {
      const list = $('[data-act="list"]', root);
      let entries = data.entries || state.entries || [];
      const f = (state.filter || '').toLowerCase();
      if (f) entries = entries.filter((e) => e.name.toLowerCase().includes(f));
      if (!entries.length) {
        list.innerHTML = `<div class="empty">${f ? 'No items match your search.' : 'This folder is empty.'}</div>`;
        return;
      }
      if (state.layout === 'icons') {
        list.innerHTML = `
          <div class="exp-icons">
            ${entries.map((e) => `
              <button type="button" class="exp-icon-item" data-path="${escapeHtml(e.path)}" data-dir="${e.is_dir ? '1' : '0'}">
                <span class="ico">${fileIcon(e)}</span>
                <span class="lbl">${escapeHtml(e.name)}</span>
              </button>
            `).join('')}
          </div>`;
        list.querySelectorAll('.exp-icon-item').forEach((el) => bindEntryEl(el, data, false));
        return;
      }
      list.innerHTML = `
        <table class="exp-table">
          <thead>
            <tr>
              <th class="col-name">Name</th>
              <th class="col-date">Date modified</th>
              <th class="col-type">Type</th>
              <th class="col-size">Size</th>
            </tr>
          </thead>
          <tbody>
            ${entries.map((e) => `
              <tr data-path="${escapeHtml(e.path)}" data-dir="${e.is_dir ? '1' : '0'}">
                <td class="col-name"><span class="name">${fileIcon(e)} <span>${escapeHtml(e.name)}</span></span></td>
                <td class="col-date">${escapeHtml(e.mtime_iso || '')}</td>
                <td class="col-type">${escapeHtml(e.type_label || (e.is_dir ? 'File folder' : 'File'))}</td>
                <td class="col-size">${e.is_dir ? '' : fmtSize(e.size)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
      list.querySelectorAll('tr[data-path]').forEach((el) => bindEntryEl(el, data, true));
    };

    const openEntry = (entry) => {
      if (!entry) return;
      if (entry.is_dir) {
        state.view = 'folder';
        state.path = entry.path;
        load();
      } else {
        openPreview(state.root, entry.path, entry.name || 'File');
      }
    };

    const bindEntryEl = (el, data, isRow) => {
      const select = () => {
        const list = $('[data-act="list"]', root);
        list.querySelectorAll('.selected').forEach((r) => r.classList.remove('selected'));
        el.classList.add('selected');
        state.selected = el.dataset.path;
        state.selectedEntry = (state.entries || []).find((x) => x.path === state.selected) || null;
        showDetailsEntry(state.selectedEntry);
      };
      el.addEventListener('click', select);
      el.addEventListener('dblclick', () => {
        select();
        openEntry(state.selectedEntry || {
          path: el.dataset.path,
          is_dir: el.dataset.dir === '1',
          name: el.dataset.path?.split('/').pop(),
        });
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        select();
        const entry = state.selectedEntry;
        const writable = !!data?.writable;
        const items = [
          { label: 'Open', action: () => openEntry(entry) },
          { label: 'Preview', disabled: !entry || entry.is_dir, action: () => openPreview(state.root, entry.path, entry.name) },
          { label: 'Download', disabled: !entry || entry.is_dir, action: () => {
            const q = new URLSearchParams({ root: state.root, path: entry.path });
            window.open(apiUrl(`api/files/download?${q}`), '_blank');
          }},
          { sep: true },
          { label: 'Rename', disabled: !entry || !writable, action: () => $('[data-act="rename"]', root).click() },
          { label: (CFG?.features?.trash === false ? 'Delete' : 'Move to Recycle Bin'), disabled: !entry || !writable, action: () => deleteSelected(false) },
          { label: 'Delete permanently', disabled: !entry || !writable, danger: true, action: () => deleteSelected(true) },
          { sep: true },
          { label: 'New folder', disabled: !writable, action: () => $('[data-act="newfolder"]', root).click() },
          { label: 'Refresh', action: () => $('[data-act="refresh"]', root).click() },
        ];
        showContextMenu(e.clientX, e.clientY, items);
      });
    };

    const load = async () => {
      setStatus('Loading…', '');
      try {
        if (!state.places) {
          state.places = await api('api/places');
          // keep CFG.roots fresh for labels
          if (state.places.all) CFG.roots = state.places.all;
        }
        renderSidebar();

        if (state.view === 'thispc') {
          renderAddress(null);
          renderPlacesGrid(state.places.this_pc || [], 'Devices and drives', 'No local locations configured.');
          setStatus(`${(state.places.this_pc || []).length} location(s)`, 'This PC');
          pushHist();
          $('.win-title', rec.el).textContent = 'This PC';
          return;
        }
        if (state.view === 'network') {
          renderAddress(null);
          renderPlacesGrid(state.places.network || [], 'Network locations', 'No network shares found.');
          const n = (state.places.network || []).length;
          setStatus(`${n} network location${n === 1 ? '' : 's'}`, 'Network');
          pushHist();
          $('.win-title', rec.el).textContent = 'Network';
          return;
        }

        // folder view
        const q = new URLSearchParams({ root: state.root, path: state.path });
        const data = await api(`api/files?${q}`);
        state.path = data.path || '';
        state.selected = null;
        state.selectedEntry = null;
        state.entries = data.entries || [];
        renderAddress(data);
        renderFileTable(data);
        showDetailsEntry(null);
        const n = state.entries.length;
        const free = data.usage ? `${fmtSize(data.usage.free)} free` : '';
        setStatus(
          `${n} item${n === 1 ? '' : 's'}${data.writable ? '' : '  ·  Read-only'}`,
          free
        );
        $('.win-title', rec.el).textContent = data.root_label || 'File Explorer';
        pushHist();
      } catch (e) {
        $('[data-act="list"]', root).innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
        setStatus(e.message, '');
      }
    };

    // actions
    $('[data-act="back"]', root).onclick = () => {
      if (state.histIdx > 0) goHist(state.histIdx - 1);
    };
    $('[data-act="forward"]', root).onclick = () => {
      if (state.histIdx < state.history.length - 1) goHist(state.histIdx + 1);
    };
    $('[data-act="up"]', root).onclick = () => {
      if (state.view !== 'folder') return;
      if (!state.path) {
        state.view = placeKind(state.root) === 'network' ? 'network' : 'thispc';
        load();
        return;
      }
      const parts = state.path.split('/').filter(Boolean);
      parts.pop();
      state.path = parts.join('/');
      load();
    };
    $('[data-act="refresh"]', root).onclick = async () => {
      state.places = null; // refresh mounts
      await load();
    };
    $('[data-act="filter"]', root).oninput = (e) => {
      state.filter = e.target.value || '';
      if (state.view === 'folder') renderFileTable({ entries: state.entries, root: state.root });
    };
    $('[data-act="view-details"]', root).onclick = (e) => {
      state.layout = 'details';
      e.currentTarget.classList.add('active');
      $('[data-act="view-icons"]', root).classList.remove('active');
      if (state.view === 'folder') renderFileTable({ entries: state.entries, root: state.root });
    };
    $('[data-act="view-icons"]', root).onclick = (e) => {
      state.layout = 'icons';
      e.currentTarget.classList.add('active');
      $('[data-act="view-details"]', root).classList.remove('active');
      if (state.view === 'folder') renderFileTable({ entries: state.entries, root: state.root });
    };
    $('[data-act="newfolder"]', root).onclick = async () => {
      if (state.view !== 'folder') { alert('Open a folder first.'); return; }
      const name = prompt('New folder name:');
      if (!name) return;
      try {
        await api('api/files/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: state.root, path: state.path, name }),
        });
        load();
      } catch (e) { alert(e.message); }
    };
    $('[data-act="copy"]', root).onclick = async () => {
      const text = state.selected
        ? `${placeLabel(state.root)}/${state.selected}`
        : (state.view === 'folder' ? `${placeLabel(state.root)}/${state.path}` : state.view);
      try { await navigator.clipboard.writeText(text); setStatus('Path copied', ''); } catch { /* */ }
    };
    $('[data-act="rename"]', root).onclick = async () => {
      if (!state.selected) { alert('Select a file or folder first.'); return; }
      const base = state.selected.split('/').pop();
      const name = prompt('Rename to:', base);
      if (!name || name === base) return;
      try {
        await api('api/files/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: state.root, path: state.selected, name }),
        });
        load();
      } catch (e) { alert(e.message); }
    };
    const deleteSelected = async (permanent) => {
      if (!state.selected) { alert('Select a file or folder first.'); return; }
      const name = state.selected.split('/').pop();
      if (permanent) {
        if (!confirm(`Permanently delete '${name}'? This cannot be undone.`)) return;
      } else if (CFG?.features?.trash === false) {
        if (!confirm(`Delete '${name}'?`)) return;
      }
      try {
        const body = { root: state.root, path: state.selected };
        if (permanent) body.permanent = true;
        const res = await api('api/files/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.trashed) setStatus(`Moved '${name}' to Recycle Bin`, '');
        load();
      } catch (e) { alert(e.message); }
    };
    $('[data-act="delete"]', root).onclick = () => deleteSelected(false);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && state.selected) {
        e.preventDefault();
        deleteSelected(!!e.shiftKey);
      }
    });
    $('[data-act="upload"]', root).onchange = async (e) => {
      if (state.view !== 'folder') { alert('Open a folder first.'); e.target.value = ''; return; }
      const file = e.target.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      fd.append('root', state.root);
      fd.append('path', state.path);
      try {
        const r = await fetch(apiUrl('api/files/upload'), { method: 'POST', body: fd });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'upload failed');
        load();
      } catch (err) { alert(err.message); }
      e.target.value = '';
    };
    $('[data-act="download"]', root).onclick = () => {
      if (!state.selected) { alert('Select a file first.'); return; }
      if (state.selectedEntry?.is_dir) { alert('Pick a file to download.'); return; }
      const q = new URLSearchParams({ root: state.root, path: state.selected });
      window.open(apiUrl(`api/files/download?${q}`), '_blank');
    };

    $('[data-act="list"]', root).addEventListener('contextmenu', (e) => {
      if (e.target.closest('tr[data-path], .exp-icon-item, .exp-drive')) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'New folder', action: () => $('[data-act="newfolder"]', root).click() },
        { label: 'Refresh', action: () => $('[data-act="refresh"]', root).click() },
      ]);
    });

    // start at This PC so network is obvious
    state.view = 'thispc';
    load();
  }

  function extOf(name) {
    const n = String(name || '');
    const i = n.lastIndexOf('.');
    return i >= 0 ? n.slice(i + 1).toLowerCase() : '';
  }

  /** Minimal safe markdown → HTML (no raw HTML passthrough). */
  function renderMarkdownSafe(src) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inCode = false;
    let codeLang = '';
    let codeBuf = [];
    let inUl = false;
    let inOl = false;
    let inBq = false;

    const closeLists = () => {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (inBq) { out.push('</blockquote>'); inBq = false; }
    };

    const inline = (s) => {
      let t = escapeHtml(s);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return t;
    };

    for (const raw of lines) {
      if (raw.startsWith('```')) {
        if (inCode) {
          out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
          codeBuf = [];
          inCode = false;
          codeLang = '';
        } else {
          closeLists();
          inCode = true;
          codeLang = raw.slice(3).trim();
        }
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }

      if (/^\s*$/.test(raw)) { closeLists(); continue; }

      const h = raw.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        closeLists();
        const lvl = h[1].length;
        out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
        continue;
      }
      if (/^>\s?/.test(raw)) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (!inBq) { out.push('<blockquote>'); inBq = true; }
        out.push(`<p>${inline(raw.replace(/^>\s?/, ''))}</p>`);
        continue;
      }
      const ul = raw.match(/^\s*[-*]\s+(.*)$/);
      if (ul) {
        if (inOl) { out.push('</ol>'); inOl = false; }
        if (inBq) { out.push('</blockquote>'); inBq = false; }
        if (!inUl) { out.push('<ul>'); inUl = true; }
        out.push(`<li>${inline(ul[1])}</li>`);
        continue;
      }
      const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (inBq) { out.push('</blockquote>'); inBq = false; }
        if (!inOl) { out.push('<ol>'); inOl = true; }
        out.push(`<li>${inline(ol[1])}</li>`);
        continue;
      }
      closeLists();
      out.push(`<p>${inline(raw)}</p>`);
    }
    if (inCode) out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
    closeLists();
    return out.join('\n');
  }

  async function openPreview(rootId, path, title) {
    const id = `preview:${path}`;
    const rec = createWindow({
      id,
      title: title || 'Preview',
      icon: '📄',
      width: 720,
      height: 540,
      bodyHtml: `<div class="preview"><div class="bar">Loading…</div><div class="preview-body"></div></div>`,
    });
    const body = $('.preview', rec.el);
    try {
      const q = new URLSearchParams({ root: rootId, path });
      const data = await api(`api/files/read?${q}`);
      const name = data.name || title || path;
      const ext = extOf(name);
      const dl = `<a href="${apiUrl('api/files/download')}?${q}"><button type="button">Download</button></a>`;
      if (data.image && data.data_url) {
        $('.bar', body).innerHTML = `<span>${escapeHtml(name)} · ${fmtSize(data.size)} · image</span>${dl}`;
        $('.preview-body', body).innerHTML = `<div class="img-preview" data-act="imgwrap"><img src="${data.data_url}" alt="${escapeHtml(name)}" /></div>`;
        const wrap = $('[data-act="imgwrap"]', body);
        wrap?.addEventListener('click', () => wrap.classList.toggle('zoomed'));
      } else if (data.binary) {
        $('.bar', body).innerHTML = `<span>Binary · ${fmtSize(data.size)} · ${escapeHtml(data.mime || '')}</span>${dl}`;
        $('.preview-body', body).innerHTML = `<pre class="empty-pre">(binary — use Download)</pre>`;
      } else if (ext === 'md' || ext === 'markdown') {
        $('.bar', body).innerHTML = `<span>${escapeHtml(name)} · ${fmtSize(data.size)} · Markdown</span>${dl}`;
        $('.preview-body', body).innerHTML = `<div class="preview-md"></div>`;
        $('.preview-md', body).innerHTML = renderMarkdownSafe(data.content || '');
      } else if (CODE_EXTS.has(ext) || (data.mime || '').includes('json') || (data.mime || '').includes('javascript')) {
        $('.bar', body).innerHTML = `<span>${escapeHtml(name)} · ${fmtSize(data.size)} · code</span>${dl}`;
        $('.preview-body', body).innerHTML = `<pre class="preview-code"></pre>`;
        $('.preview-code', body).textContent = data.content || '';
      } else {
        $('.bar', body).innerHTML = `<span>${escapeHtml(name)} · ${fmtSize(data.size)}</span>${dl}`;
        $('.preview-body', body).innerHTML = `<pre></pre>`;
        $('pre', body).textContent = data.content || '';
      }
    } catch (e) {
      $('.bar', body).textContent = e.message;
      $('.preview-body', body).innerHTML = '';
    }
  }

  /* ── System (live) ──────────────────────────────────────────────────── */
  async function openSystem() {
    const id = 'system';
    const rec = createWindow({
      id,
      title: 'System',
      icon: '🖥',
      width: 700,
      height: 520,
      bodyHtml: `
        <div class="app-shell">
          <div class="app-toolbar">
            <button type="button" data-act="refresh">↻ Refresh</button>
            <label class="chk"><input type="checkbox" data-act="live" checked /> Live</label>
            <span class="muted" data-act="ts"></span>
          </div>
          <div class="system"><div class="empty">Loading…</div></div>
        </div>`,
    });
    const host = $('.system', rec.el);
    let timer = null;

    const paint = (s) => {
      const memPct = s.memory?.percent || 0;
      const cpu = s.cpu_percent;
      const swapUsed = (s.memory?.swap_total || 0) - (s.memory?.swap_free || 0);
      host.innerHTML = `
        <div class="stat-card">
          <h3>Machine</h3>
          <div class="big">${escapeHtml(s.hostname)}</div>
          <div class="row"><span>User</span><span>${escapeHtml(s.user)}</span></div>
          <div class="row"><span>OS</span><span>${escapeHtml(s.os_pretty || s.os)}</span></div>
          <div class="row"><span>Kernel</span><span>${escapeHtml(s.os)}</span></div>
          <div class="row"><span>Arch</span><span>${escapeHtml(s.machine)} · ${s.cpu_count || '?'} cores</span></div>
          <div class="row"><span>Python</span><span>${escapeHtml(s.python || '—')}</span></div>
          <div class="row"><span>Uptime</span><span>${escapeHtml(s.uptime_human)}</span></div>
          <div class="row"><span>Time</span><span>${escapeHtml(s.time)}</span></div>
        </div>
        <div class="stat-card">
          <h3>CPU</h3>
          <div class="big">${cpu != null ? cpu + '%' : '—'}</div>
          <div class="meter"><i style="width:${cpu || 0}%"></i></div>
          <div class="row"><span>Load 1 / 5 / 15</span>
            <span>${[s.load?.['1'], s.load?.['5'], s.load?.['15']].map((x) => (typeof x === 'number' ? x.toFixed(2) : x)).join(' · ')}</span></div>
          <div class="row"><span>Temp</span><span>${s.cpu_temp_c != null ? s.cpu_temp_c + ' °C' : '—'}</span></div>
        </div>
        <div class="stat-card">
          <h3>Memory</h3>
          <div class="big">${memPct}%</div>
          <div class="meter"><i style="width:${memPct}%"></i></div>
          <div class="row"><span>Used</span><span>${fmtSize(s.memory?.used)}</span></div>
          <div class="row"><span>Available</span><span>${fmtSize(s.memory?.available)}</span></div>
          <div class="row"><span>Total</span><span>${fmtSize(s.memory?.total)}</span></div>
          <div class="row"><span>Swap</span><span>${fmtSize(swapUsed)} / ${fmtSize(s.memory?.swap_total)}</span></div>
        </div>
        <div class="stat-card" style="grid-column:1/-1">
          <h3>Disks</h3>
          ${(s.disks || []).map((d) => `
            <div class="row"><span><code>${escapeHtml(d.mount)}</code> <span class="muted">${escapeHtml(d.filesystem)}</span></span>
              <span>${d.percent} · ${fmtSize(d.used)} / ${fmtSize(d.size)}</span></div>
            <div class="meter"><i style="width:${parseInt(d.percent, 10) || 0}%"></i></div>
          `).join('') || '<div class="muted">No disk data</div>'}
        </div>`;
      const ts = $('[data-act="ts"]', rec.el);
      if (ts) ts.textContent = s.time || '';
    };

    const load = async () => {
      try {
        paint(await api('api/system'));
      } catch (e) {
        host.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
      }
    };

    const setLive = (on) => {
      if (timer) { clearInterval(timer); timer = null; }
      if (on) timer = setInterval(load, 2500);
    };

    $('[data-act="refresh"]', rec.el).onclick = load;
    $('[data-act="live"]', rec.el).onchange = (e) => setLive(e.target.checked);
    rec.onClose = () => { if (timer) clearInterval(timer); };
    await load();
    setLive(true);
  }

  /* ── Processes ──────────────────────────────────────────────────────── */
  async function openProcesses() {
    const id = 'processes';
    const rec = createWindow({
      id,
      title: 'Processes',
      icon: '⚙',
      width: 780,
      height: 520,
      bodyHtml: `
        <div class="app-shell">
          <div class="app-toolbar">
            <button type="button" data-act="refresh">↻</button>
            <input class="search" data-act="filter" placeholder="Filter name / cmd…" />
            <span class="muted" data-act="count"></span>
          </div>
          <div class="table-wrap"><div class="empty">Loading…</div></div>
        </div>`,
    });
    let rows = [];
    const wrap = $('.table-wrap', rec.el);

    const paint = () => {
      const f = ($('[data-act="filter"]', rec.el).value || '').toLowerCase();
      const list = f
        ? rows.filter((p) => `${p.name} ${p.cmd} ${p.user}`.toLowerCase().includes(f))
        : rows;
      $('[data-act="count"]', rec.el).textContent = `${list.length} shown`;
      if (!list.length) {
        wrap.innerHTML = '<div class="empty">No processes match.</div>';
        return;
      }
      wrap.innerHTML = `
        <table class="data-table">
          <thead><tr><th>PID</th><th>User</th><th>Name</th><th>RSS</th><th>State</th><th>Command</th></tr></thead>
          <tbody>
            ${list.map((p) => `
              <tr>
                <td class="muted">${p.pid}</td>
                <td>${escapeHtml(p.user)}</td>
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td class="muted">${fmtSize(p.rss)}</td>
                <td>${escapeHtml(p.state)}</td>
                <td class="cmd-cell" title="${escapeHtml(p.cmd)}">${escapeHtml(p.cmd)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
    };

    const load = async () => {
      try {
        const data = await api('api/processes?limit=50');
        rows = data.processes || [];
        paint();
      } catch (e) {
        wrap.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
      }
    };

    $('[data-act="refresh"]', rec.el).onclick = load;
    $('[data-act="filter"]', rec.el).oninput = paint;
    await load();
  }

  async function postControl(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /* ── Docker ─────────────────────────────────────────────────────────── */
  async function openDocker() {
    const id = 'docker';
    const canCtrl = !!(CFG.features?.docker_control);
    const rec = createWindow({
      id,
      title: 'Docker',
      icon: '🐳',
      width: 900,
      height: 520,
      bodyHtml: `
        <div class="app-shell">
          <div class="app-toolbar">
            <button type="button" data-act="refresh">↻ Refresh</button>
            <label class="chk"><input type="checkbox" data-act="live" checked /> Live</label>
            <span class="muted" data-act="count"></span>
            <span class="ctrl-hint" data-act="hint">${canCtrl ? 'Controls enabled' : 'Controls disabled (allow_docker_control)'}</span>
          </div>
          <div class="table-wrap"><div class="empty">Loading…</div></div>
        </div>`,
    });
    const wrap = $('.table-wrap', rec.el);
    let timer = null;

    const doCtrl = async (name, action) => {
      if (!canCtrl) return;
      if (!confirm(`${action} container "${name}"?`)) return;
      try {
        await postControl('api/docker/control', { name, action });
        await load();
      } catch (e) { alert(e.message); }
    };

    const load = async () => {
      try {
        const data = await api('api/docker');
        if (!data.available) {
          wrap.innerHTML = `<div class="empty">Docker not available${data.error ? ': ' + escapeHtml(data.error) : ''}</div>`;
          return;
        }
        if (data.error && !data.containers?.length) {
          wrap.innerHTML = `<div class="empty">${escapeHtml(data.error)}</div>`;
          return;
        }
        const list = data.containers || [];
        $('[data-act="count"]', rec.el).textContent = `${list.filter((c) => c.state === 'running').length} running · ${list.length} total`;
        if (!list.length) {
          wrap.innerHTML = '<div class="empty">No containers.</div>';
          return;
        }
        wrap.innerHTML = `
          <table class="data-table">
            <thead><tr><th>Name</th><th>State</th><th>Image</th><th>Status</th><th>Ports</th><th>Control</th></tr></thead>
            <tbody>
              ${list.map((c) => `
                <tr>
                  <td><strong>${escapeHtml(c.name)}</strong><div class="muted tiny">${escapeHtml(c.id)}</div></td>
                  <td>${stateBadge(c.state)}</td>
                  <td class="cmd-cell">${escapeHtml(c.image)}</td>
                  <td class="muted">${escapeHtml(c.status)}</td>
                  <td class="muted tiny">${escapeHtml(c.ports || '—')}</td>
                  <td>
                    <div class="ctrl-btns">
                      <button type="button" data-c="${escapeHtml(c.name)}" data-a="start" ${canCtrl ? '' : 'disabled'} title="${canCtrl ? 'Start' : 'Disabled in config'}">Start</button>
                      <button type="button" data-c="${escapeHtml(c.name)}" data-a="stop" ${canCtrl ? '' : 'disabled'} title="${canCtrl ? 'Stop' : 'Disabled in config'}">Stop</button>
                      <button type="button" data-c="${escapeHtml(c.name)}" data-a="restart" ${canCtrl ? '' : 'disabled'} title="${canCtrl ? 'Restart' : 'Disabled in config'}">Restart</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>`;
        wrap.querySelectorAll('.ctrl-btns button').forEach((btn) => {
          btn.onclick = () => doCtrl(btn.dataset.c, btn.dataset.a);
        });
      } catch (e) {
        wrap.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
      }
    };

    const setLive = (on) => {
      if (timer) { clearInterval(timer); timer = null; }
      if (on) timer = setInterval(load, 5000);
    };
    $('[data-act="refresh"]', rec.el).onclick = load;
    $('[data-act="live"]', rec.el).onchange = (e) => setLive(e.target.checked);
    rec.onClose = () => { if (timer) clearInterval(timer); };
    await load();
    setLive(true);
  }

  /* ── Services ───────────────────────────────────────────────────────── */
  async function openServices() {
    const id = 'services';
    const canCtrl = !!(CFG.features?.service_control);
    const rec = createWindow({
      id,
      title: 'Services',
      icon: '🛠',
      width: 820,
      height: 500,
      bodyHtml: `
        <div class="app-shell">
          <div class="app-toolbar">
            <button type="button" data-act="refresh">↻</button>
            <span class="muted">${canCtrl ? 'systemd · controls enabled' : 'systemd · read-only'}</span>
            <span class="ctrl-hint">${canCtrl ? '' : 'Enable allow_service_control in config.json to start/stop/restart'}</span>
          </div>
          <div class="table-wrap"><div class="empty">Loading…</div></div>
        </div>`,
    });
    const wrap = $('.table-wrap', rec.el);

    const doCtrl = async (unit, action) => {
      if (!canCtrl) return;
      if (!confirm(`${action} unit "${unit}"?`)) return;
      try {
        await postControl('api/services/control', { unit, action });
        await load();
      } catch (e) { alert(e.message); }
    };

    const load = async () => {
      try {
        const data = await api('api/services');
        const list = data.services || [];
        wrap.innerHTML = `
          <table class="data-table">
            <thead><tr><th>Unit</th><th>Active</th><th>Sub</th><th>Enabled</th><th>Description</th><th>Control</th></tr></thead>
            <tbody>
              ${list.map((s) => {
                const bare = s.unit.replace(/\.service$/, '');
                return `
                <tr>
                  <td><strong>${escapeHtml(bare)}</strong></td>
                  <td>${stateBadge(s.active)}</td>
                  <td class="muted">${escapeHtml(s.sub)}</td>
                  <td class="muted">${escapeHtml(s.enabled || '—')}</td>
                  <td class="cmd-cell">${escapeHtml(s.description)}</td>
                  <td>
                    <div class="ctrl-btns">
                      <button type="button" data-u="${escapeHtml(s.unit)}" data-a="start" ${canCtrl ? '' : 'disabled'}>Start</button>
                      <button type="button" data-u="${escapeHtml(s.unit)}" data-a="stop" ${canCtrl ? '' : 'disabled'}>Stop</button>
                      <button type="button" data-u="${escapeHtml(s.unit)}" data-a="restart" ${canCtrl ? '' : 'disabled'}>Restart</button>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`;
        wrap.querySelectorAll('.ctrl-btns button').forEach((btn) => {
          btn.onclick = () => doCtrl(btn.dataset.u, btn.dataset.a);
        });
      } catch (e) {
        wrap.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
      }
    };
    $('[data-act="refresh"]', rec.el).onclick = load;
    await load();
  }

  /* ── Network ────────────────────────────────────────────────────────── */
  async function openNetwork() {
    const id = 'network';
    const rec = createWindow({
      id,
      title: 'Network',
      icon: '🌐',
      width: 720,
      height: 500,
      bodyHtml: `
        <div class="app-shell">
          <div class="app-toolbar">
            <button type="button" data-act="refresh">↻</button>
          </div>
          <div class="net-body"><div class="empty">Loading…</div></div>
        </div>`,
    });
    const body = $('.net-body', rec.el);
    const load = async () => {
      try {
        const n = await api('api/network');
        const ifaces = (n.interfaces || []).filter((i) => {
          const name = i.name || '';
          return !name.startsWith('veth') && !name.startsWith('br-');
        });
        // still show docker0
        const extra = (n.interfaces || []).filter((i) => i.name === 'docker0' || (i.name || '').startsWith('wg'));
        const show = [...ifaces];
        extra.forEach((e) => { if (!show.find((x) => x.name === e.name)) show.push(e); });

        body.innerHTML = `
          <div class="system" style="padding:10px">
            <div class="stat-card">
              <h3>Host</h3>
              <div class="row"><span>Hostname</span><span>${escapeHtml(n.hostname)}</span></div>
              <div class="row"><span>FQDN</span><span>${escapeHtml(n.fqdn)}</span></div>
            </div>
            ${(show).map((i) => `
              <div class="stat-card">
                <h3>${escapeHtml(i.name)} ${stateBadge(i.state)}</h3>
                ${(i.addrs || []).map((a) => `
                  <div class="row"><span>${escapeHtml(a.family || 'addr')}</span>
                    <span><code>${escapeHtml(a.address)}${a.prefix != null ? '/' + a.prefix : ''}</code></span></div>
                `).join('') || '<div class="muted">No addresses</div>'}
                ${i.mac ? `<div class="row"><span>MAC</span><span class="muted">${escapeHtml(i.mac)}</span></div>` : ''}
              </div>
            `).join('')}
            <div class="stat-card" style="grid-column:1/-1">
              <h3>Listening TCP (sample)</h3>
              <div class="table-wrap" style="max-height:160px">
                <table class="data-table">
                  <thead><tr><th>Local</th><th>Process</th></tr></thead>
                  <tbody>
                    ${(n.listeners || []).slice(0, 25).map((l) => `
                      <tr><td><code>${escapeHtml(l.local)}</code></td><td class="muted tiny">${escapeHtml(l.process)}</td></tr>
                    `).join('') || '<tr><td colspan="2">—</td></tr>'}
                  </tbody>
                </table>
              </div>
            </div>
          </div>`;
      } catch (e) {
        body.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
      }
    };
    $('[data-act="refresh"]', rec.el).onclick = load;
    await load();
  }

  /* ── Logs ───────────────────────────────────────────────────────────── */
  async function openLogs() {
    const id = 'logs';
    const units = ['', 'foxos', 'docker', 'nginx', 'crowdsec', 'ssh', 'camera-dashboard'];
    const rec = createWindow({
      id,
      title: 'Logs',
      icon: '📜',
      width: 820,
      height: 520,
      bodyHtml: `
        <div class="app-shell">
          <div class="app-toolbar">
            <button type="button" data-act="refresh">↻</button>
            <select data-act="unit">
              ${units.map((u) => `<option value="${u}">${u || 'all (system)'}</option>`).join('')}
            </select>
            <button type="button" data-act="copy">Copy</button>
            <span class="muted">journalctl · last 100</span>
          </div>
          <pre class="log-view">Loading…</pre>
        </div>`,
    });
    const pre = $('.log-view', rec.el);
    const load = async () => {
      pre.textContent = 'Loading…';
      try {
        const unit = $('[data-act="unit"]', rec.el).value;
        const q = new URLSearchParams({ n: '100' });
        if (unit) q.set('unit', unit);
        const data = await api(`api/logs?${q}`);
        if (data.error && !data.lines?.length) {
          pre.textContent = data.error;
          return;
        }
        pre.textContent = (data.lines || []).join('\n') || '(empty)';
        pre.scrollTop = pre.scrollHeight;
      } catch (e) {
        pre.textContent = e.message;
      }
    };
    $('[data-act="refresh"]', rec.el).onclick = load;
    $('[data-act="unit"]', rec.el).onchange = load;
    $('[data-act="copy"]', rec.el).onclick = async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent || '');
      } catch { /* */ }
    };
    await load();
  }

  /* ── Programs (discovered apps) ─────────────────────────────────────── */
  async function openPrograms() {
    const id = 'programs';
    const rec = createWindow({
      id,
      title: 'Programs',
      icon: '📦',
      width: 720,
      height: 520,
      bodyHtml: `
        <div class="app-shell">
          <div class="app-toolbar">
            <button type="button" data-act="refresh">↻ Refresh</button>
            <input class="search" data-act="filter" placeholder="Filter programs…" />
            <span class="muted" data-act="count"></span>
          </div>
          <div class="programs-body"><div class="empty">Loading…</div></div>
        </div>`,
    });
    const body = $('.programs-body', rec.el);
    let data = null;

    const paint = () => {
      if (!data) return;
      const f = ($('[data-act="filter"]', rec.el).value || '').toLowerCase();
      const match = (p) => {
        if (!f) return true;
        return `${p.name} ${p.comment || ''} ${p.binary || ''} ${p.exec || ''}`.toLowerCase().includes(f);
      };
      const sections = [
        { key: 'links', title: 'Bookmarks / links', items: data.links || [] },
        { key: 'docker', title: 'Docker containers', items: data.docker || [] },
        { key: 'desktop', title: 'Installed applications', items: data.desktop || [] },
        { key: 'cli', title: 'CLI tools on PATH', items: data.cli || [] },
      ];
      let total = 0;
      let html = '';
      sections.forEach((sec) => {
        const items = (sec.items || []).filter(match);
        if (!items.length) return;
        total += items.length;
        html += `<section class="prog-sec"><h3>${escapeHtml(sec.title)} <span class="muted">(${items.length})</span></h3>
          <div class="prog-grid">
            ${items.map((p) => `
              <button type="button" class="prog-card ${p.available === false ? 'off' : ''}"
                data-src="${escapeHtml(p.source || '')}"
                data-url="${escapeHtml(p.url || '')}"
                data-name="${escapeHtml(p.name || '')}"
                title="${escapeHtml(p.comment || p.exec || p.status || '')}">
                <span class="ico">${p.icon || '📦'}</span>
                <span class="meta">
                  <span class="name">${escapeHtml(p.name)}</span>
                  <span class="desc">${escapeHtml(p.comment || p.binary || p.status || p.source || '')}</span>
                </span>
                ${p.state ? stateBadge(p.state) : (p.available === false ? '<span class="badge badge-muted">missing</span>' : '')}
              </button>
            `).join('')}
          </div></section>`;
      });
      $('[data-act="count"]', rec.el).textContent = `${total} shown`;
      body.innerHTML = html || '<div class="empty">No programs found. Add links in config.json or install .desktop apps.</div>';
      body.querySelectorAll('.prog-card').forEach((btn) => {
        btn.onclick = () => {
          const url = btn.dataset.url;
          if (url) {
            openWebApp({
              id: `app:${btn.dataset.name}`,
              title: btn.dataset.name,
              icon: '🔗',
              url,
              externalUrl: url,
            });
            return;
          }
          // Desktop/CLI entries are read-only inventory (no arbitrary exec for safety)
          const tip = btn.getAttribute('title') || '';
          alert(`${btn.dataset.name}\n\n${tip}\n\n(For safety Fox OS lists installed tools but does not execute them from the web UI.)`);
        };
      });
    };

    const load = async () => {
      body.innerHTML = '<div class="empty">Loading…</div>';
      try {
        data = await api('api/programs');
        paint();
      } catch (e) {
        body.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
      }
    };
    $('[data-act="refresh"]', rec.el).onclick = load;
    $('[data-act="filter"]', rec.el).oninput = paint;
    await load();
  }

  /* ── Launcher ───────────────────────────────────────────────────────── */
  function openLauncher() {
    const links = CFG.links || [];
    const groups = {};
    links.forEach((l) => {
      const g = l.group || 'Apps';
      (groups[g] = groups[g] || []).push(l);
    });
    const rec = createWindow({
      id: 'launcher',
      title: 'Launcher',
      icon: '🚀',
      width: 640,
      height: 480,
      bodyHtml: `
        <div class="launcher">
          ${Object.keys(groups).map((g) => `
            <section>
              <h3>${escapeHtml(g)}</h3>
              <div class="launch-grid">
                ${groups[g].map((l) => `
                  <button type="button" class="launch-tile" data-url="${escapeHtml(l.url)}" data-label="${escapeHtml(l.label)}" data-icon="${escapeHtml(l.icon || '🔗')}" data-id="${escapeHtml(l.id || l.label)}">
                    <span class="ico">${l.icon || '🔗'}</span>
                    <span class="name">${escapeHtml(l.label)}</span>
                  </button>
                `).join('')}
              </div>
            </section>
          `).join('') || '<div class="empty">No links in config.</div>'}
        </div>`,
    });
    $$('.launch-tile', rec.el).forEach((btn) => {
      btn.addEventListener('click', () => {
        openWebApp({
          id: `app:${btn.dataset.id}`,
          title: btn.dataset.label,
          icon: btn.dataset.icon,
          url: btn.dataset.url,
          externalUrl: btn.dataset.url,
        });
      });
    });
  }

  /* ── Notes ──────────────────────────────────────────────────────────── */
  async function openNotes() {
    const id = 'notes';
    const rec = createWindow({
      id,
      title: 'Notes',
      icon: '📝',
      width: 560,
      height: 440,
      bodyHtml: `
        <div class="notes app-shell">
          <div class="app-toolbar">
            <button type="button" data-act="new">+ Note</button>
            <button type="button" data-act="save">Save</button>
            <select data-act="pick"></select>
            <button type="button" data-act="del">Delete</button>
            <span class="muted" data-act="status"></span>
          </div>
          <input class="note-title" data-act="title" placeholder="Title" />
          <textarea class="note-body" data-act="body" placeholder="Write something…"></textarea>
        </div>`,
    });
    let notes = [];
    let current = null;
    const pick = $('[data-act="pick"]', rec.el);
    const title = $('[data-act="title"]', rec.el);
    const body = $('[data-act="body"]', rec.el);
    const status = $('[data-act="status"]', rec.el);

    const syncPick = () => {
      pick.innerHTML = notes.map((n) =>
        `<option value="${escapeHtml(n.id)}">${escapeHtml(n.title || 'Untitled')}</option>`
      ).join('') || '<option value="">(no notes)</option>';
      if (current) pick.value = current;
    };

    const show = (nid) => {
      const n = notes.find((x) => x.id === nid) || notes[0];
      if (!n) {
        current = null;
        title.value = '';
        body.value = '';
        return;
      }
      current = n.id;
      title.value = n.title || '';
      body.value = n.body || '';
      pick.value = n.id;
    };

    const load = async () => {
      try {
        const data = await api('api/notes');
        notes = data.notes || [];
        if (!notes.length) {
          notes = [{ id: String(Date.now()), title: 'Welcome', body: 'Sticky notes live in Fox OS data/.', updated: Date.now() / 1000 }];
        }
        syncPick();
        show(current || notes[0].id);
        status.textContent = `${notes.length} note(s)`;
      } catch (e) {
        status.textContent = e.message;
      }
    };

    const save = async () => {
      if (current) {
        const n = notes.find((x) => x.id === current);
        if (n) {
          n.title = title.value || 'Untitled';
          n.body = body.value;
          n.updated = Math.floor(Date.now() / 1000);
        }
      }
      try {
        await api('api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes }),
        });
        syncPick();
        status.textContent = 'Saved';
      } catch (e) {
        status.textContent = e.message;
      }
    };

    $('[data-act="new"]', rec.el).onclick = () => {
      const n = { id: String(Date.now()), title: 'New note', body: '', updated: Math.floor(Date.now() / 1000) };
      notes.unshift(n);
      syncPick();
      show(n.id);
    };
    $('[data-act="save"]', rec.el).onclick = save;
    $('[data-act="del"]', rec.el).onclick = async () => {
      if (!current) return;
      if (!confirm('Delete this note?')) return;
      notes = notes.filter((n) => n.id !== current);
      current = notes[0]?.id || null;
      await save();
      show(current);
    };
    pick.onchange = () => {
      // stash current fields first
      const n = notes.find((x) => x.id === current);
      if (n) { n.title = title.value; n.body = body.value; }
      show(pick.value);
    };
    await load();
  }

  /* ── Calculator ─────────────────────────────────────────────────────── */
  function openCalc() {
    const id = 'calc';
    const rec = createWindow({
      id,
      title: 'Calculator',
      icon: '🔢',
      width: 280,
      height: 360,
      bodyHtml: `
        <div class="calc">
          <input class="calc-display" data-act="disp" readonly value="0" />
          <div class="calc-keys">
            ${['C', '⌫', '%', '/', '7', '8', '9', '*', '4', '5', '6', '-', '1', '2', '3', '+', '0', '.', '='].map((k) =>
              `<button type="button" data-k="${k}" class="${'/*+-'.includes(k) || k === '=' || k === '/' || k === '*' ? 'op' : ''}${k === 'C' ? 'danger' : ''}">${k}</button>`
            ).join('')}
          </div>
        </div>`,
    });
    const disp = $('[data-act="disp"]', rec.el);
    let expr = '';
    const set = (v) => { disp.value = v || '0'; };

    const safeEval = (s) => {
      if (!/^[\d.\s+\-*/%()]+$/.test(s)) throw new Error('bad');
      // eslint-disable-next-line no-new-func
      const r = Function(`"use strict"; return (${s})`)();
      if (typeof r !== 'number' || !Number.isFinite(r)) throw new Error('nan');
      return r;
    };

    rec.el.querySelectorAll('.calc-keys button').forEach((btn) => {
      btn.onclick = () => {
        const k = btn.dataset.k;
        try {
          if (k === 'C') { expr = ''; set('0'); return; }
          if (k === '⌫') { expr = expr.slice(0, -1); set(expr); return; }
          if (k === '=') {
            const r = safeEval(expr.replace(/%/g, '/100'));
            expr = String(r);
            set(expr);
            return;
          }
          expr += k;
          set(expr);
        } catch {
          set('Error');
          expr = '';
        }
      };
    });
  }

  /* ── Settings ───────────────────────────────────────────────────────── */
  function openSettings() {
    createWindow({
      id: 'settings',
      title: 'Settings',
      icon: '🔧',
      width: 500,
      height: 440,
      bodyHtml: `
        <div class="settings">
          <h2>Fox OS settings</h2>
          <p>Version <span class="badge badge-ok">v${escapeHtml(CFG.version || '2')}</span>
            · <span class="badge">${CFG.allow_write ? 'Writes enabled' : 'Read-only'}</span></p>
          <h3 style="margin-top:14px;font-size:13px;">Features</h3>
          <ul>
            <li>Docker: ${CFG.features?.docker ? '✓' : '—'}</li>
            <li>Journal: ${CFG.features?.journal ? '✓' : '—'}</li>
            <li>systemctl: ${CFG.features?.systemctl ? '✓' : '—'}</li>
            <li>Service control: ${CFG.features?.service_control ? '✓ enabled' : '— off'}</li>
            <li>Docker control: ${CFG.features?.docker_control ? '✓ enabled' : '— off'}</li>
            <li>Recycle Bin: ${CFG.features?.trash === false ? '— off' : '✓'}</li>
          </ul>
          <h3 style="margin-top:14px;font-size:13px;">Mounted places</h3>
          <ul>
            ${(CFG.roots || []).map((r) => `
              <li><strong>${escapeHtml(r.label)}</strong> — <code>${escapeHtml(r.path)}</code>
                ${r.exists ? '' : ' (missing)'}
                ${r.writable ? ' · writable' : ' · read-only'}
              </li>
            `).join('')}
          </ul>
          <p style="margin-top:14px">Edit <code>config.json</code> (from <code>config.example.json</code>) for roots, apps, links, and services — then restart the Fox OS process.</p>
          <p class="muted" style="font-size:12px">Portable headless desktop · v${escapeHtml(CFG.version || '')}</p>
        </div>`,
    });
  }

  function applyWallpaper() {
    const img = $('#wallpaperImg');
    if (!img) return;
    const name = CFG?.wallpaper;
    if (!name) {
      img.removeAttribute('src');
      img.style.display = 'none';
      return;
    }
    img.style.display = '';
    // cache-bust so updates show after refresh
    img.src = apiUrl(`static/${name}?v=${encodeURIComponent(CFG.version || '3')}`);
    img.onerror = () => { img.style.display = 'none'; };
  }

  /* ── Init ───────────────────────────────────────────────────────────── */
  async function init() {
    tickClock();
    setInterval(tickClock, 15000);
    try {
      CFG = await api('api/config');
      document.title = `${CFG.title || 'Fox OS'} — ${CFG.hostname || ''}`;
      $('#trayHost').textContent = CFG.hostname || '';
      applyWallpaper();
      renderDesktopIcons();
      renderStartMenu();
      refreshTrayAndWidgets();
      trayTimer = setInterval(refreshTrayAndWidgets, 4000);
    } catch (e) {
      console.error(e);
      $('#boot .boot-sub').textContent = 'Failed to load: ' + e.message;
      return;
    }

    $('#startBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStart();
    });
    const startSearch = $('#startSearch');
    if (startSearch) {
      startSearch.addEventListener('input', () => filterStartMenu());
      startSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (startSearch.value) {
            startSearch.value = '';
            filterStartMenu();
          } else {
            closeStart();
            $('#startBtn')?.focus();
          }
        } else if (e.key === 'Enter') {
          const first = $('#startItems .start-item');
          if (first) first.click();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          $('#startItems .start-item')?.focus();
        }
      });
      // Prevent document click handler from treating typing as outside click quirks
      startSearch.addEventListener('click', (e) => e.stopPropagation());
    }
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#startMenu') && !e.target.closest('#startBtn')) closeStart();
      if (!e.target.closest('.ctx-menu')) closeContextMenu();
    });
    document.addEventListener('contextmenu', (e) => {
      // desktop empty area: no browser menu noise for icons only; leave default elsewhere
      if (e.target.closest('.desk-icon, .explorer, .ctx-menu, .trash-app')) return;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const startOpen = !$('#startMenu')?.classList.contains('hidden');
        const search = $('#startSearch');
        if (startOpen && search && search.value) {
          search.value = '';
          filterStartMenu();
          search.focus();
          return;
        }
        closeStart();
        closeContextMenu();
        return;
      }
      // Cycle windows: Ctrl+Tab / Ctrl+Shift+Tab
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycleWindows(e.shiftKey);
      }
      // Window snap: Ctrl+Alt+Arrow (avoid stealing plain browser / OS shortcuts)
      if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey) {
        const rec = activeWindowRec();
        if (!rec) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); snapWindow(rec, 'left'); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); snapWindow(rec, 'right'); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); snapWindow(rec, 'max'); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); restoreWinGeom(rec, rec.el); }
      }
    });

    setTimeout(bootDone, 500);
  }

  init();
})();
