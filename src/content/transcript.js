/*
 * transcript.js — khung "Câu thoại": liệt kê toàn bộ câu của tập phim, mỗi câu hiện
 * song song 2 ngôn ngữ (Phụ đề 1 ở trên, Phụ đề 2 ở dưới) để học ngoại ngữ.
 * - Câu đang chiếu được tô sáng và tự cuộn tới (tạm ngừng tự cuộn vài giây khi người dùng tự cuộn).
 * - Bấm vào một câu để tua phim tới câu đó.
 * - Khung kéo đi đâu cũng được (kéo phần tiêu đề), đổi cỡ bằng cách kéo cạnh/góc,
 *   nhấp đúp tiêu đề để về vị trí mặc định. Vị trí/cỡ lưu theo % của player.
 * - Nút chỉnh độ mờ nền và nút tìm kiếm (khớp chính xác + câu tương tự, không phân biệt dấu).
 * - Chọn ngôn ngữ riêng cho 2 dòng của khung (không phụ thuộc phụ đề đang hiện trên màn hình).
 * - Sau 2 giây không thao tác, khung tự thu gọn (ẩn nút, chỉ còn khung + chữ), như thanh điều khiển Netflix.
 * - NDS.buildRows() cũng được main.js dùng cho phím tua theo câu (A / R / D).
 */
window.NDS = window.NDS || {};

(() => {
  'use strict';
  const NDS = window.NDS;

  const USER_SCROLL_PAUSE_MS = 4000;
  const MIN_W = 240; // px
  const MIN_H = 180; // px
  const MAX_RESULTS = 100;
  const IDLE_MS = 2000;

  const ICONS = {
    search:
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/></svg>',
    opacity:
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>',
    prev:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 5h2v14H6zM19 5v14l-9.5-7z"/></svg>',
    repeat:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/></svg>',
    next:
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 5h2v14h-2zM5 5v14l9.5-7z"/></svg>',
  };

  function iconBtn(cls, svg) {
    const b = el('button', cls);
    b.type = 'button';
    b.innerHTML = svg; // SVG tĩnh do extension định nghĩa
    return b;
  }

  // ---------- Chuẩn hoá chữ cho tìm kiếm (bỏ dấu, chữ thường, bỏ dấu câu) ----------
  function normChar(c) {
    if (c === 'đ' || c === 'Đ') return 'd';
    const n = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!n) return '';
    return /[\p{L}\p{N}]/u.test(n[0]) ? n[0] : ' ';
  }

  // Chuỗi đã chuẩn hoá + bảng ánh xạ vị trí về chữ gốc (để tô sáng đúng chỗ).
  function normalizeWithMap(text) {
    const chars = Array.from(text);
    let out = '';
    const map = []; // map[i] = vị trí (theo code point) trong chữ gốc
    chars.forEach((c, i) => {
      const n = normChar(c);
      if (!n) return;
      if (n === ' ' && (out === '' || out.endsWith(' '))) return;
      out += n;
      map.push(i);
    });
    return { text: out, map, chars };
  }

  const normalize = (text) => normalizeWithMap(text).text.trim();

  function levenshtein1(a, b) {
    // true nếu a, b khác nhau tối đa 1 ký tự (thêm/xoá/thay).
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let diff = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i++;
        j++;
        continue;
      }
      if (++diff > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else {
        i++;
        j++;
      }
    }
    return diff + (a.length - i) + (b.length - j) <= 1;
  }

  function tokenMatches(q, words) {
    for (const w of words) {
      if (w === q) return true;
      if (q.length >= 3 && (w.startsWith(q) || (w.length >= 3 && q.startsWith(w)))) return true;
      if (q.length >= 4 && levenshtein1(q, w)) return true;
    }
    return false;
  }

  // Chữ có đánh dấu đoạn khớp (<mark>), dựng bằng DOM để không chèn HTML lạ.
  function highlighted(cls, text, nq) {
    const div = el('div', cls);
    if (nq) {
      const n = normalizeWithMap(text);
      const at = n.text.indexOf(nq);
      if (at >= 0) {
        const a = n.map[at];
        const b = n.map[at + nq.length - 1] + 1;
        div.append(n.chars.slice(0, a).join(''), el('mark', 'nds-tr-mark', n.chars.slice(a, b).join('')), n.chars.slice(b).join(''));
        return div;
      }
    }
    div.textContent = text;
    return div;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Chữ thuần của một cue (nối các dòng bằng khoảng trắng).
  function cueText(cue) {
    return cue.lines.map((line) => line.map((p) => p.text).join('')).join(' ').replace(/\s+/g, ' ').trim();
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /**
   * Ghép 2 phụ đề thành các "câu" song song. Phụ đề 1 làm chuẩn (nếu không có thì dùng Phụ đề 2);
   * mỗi cue của phụ đề kia được gán vào câu chứa điểm giữa của nó.
   * Trả về [{start, end, texts: [text1, text2]}] sắp theo thời gian.
   */
  NDS.buildRows = function (cues1, cues2) {
    const masterIdx = cues1 && cues1.length ? 0 : cues2 && cues2.length ? 1 : -1;
    if (masterIdx < 0) return [];
    const master = masterIdx === 0 ? cues1 : cues2;
    const other = masterIdx === 0 ? cues2 : cues1;

    // Gộp các cue chính bắt đầu cùng lúc (một số track tách 2 dòng thành 2 cue).
    const rows = [];
    for (const cue of master) {
      const last = rows[rows.length - 1];
      const text = cueText(cue);
      if (last && Math.abs(last.start - cue.start) < 0.05) {
        last.parts[0].push(text);
        last.end = Math.max(last.end, cue.end);
      } else {
        rows.push({ start: cue.start, end: cue.end, parts: [[text], []] });
      }
    }
    if (other && other.length) {
      let r = 0;
      for (const cue of other) {
        const mid = (cue.start + cue.end) / 2;
        while (r + 1 < rows.length && rows[r + 1].start <= mid) r++;
        rows[r].parts[1].push(cueText(cue));
      }
    }
    return rows.map((row) => {
      const texts = row.parts.map((p) => p.filter(Boolean).join(' '));
      return {
        start: row.start,
        end: row.end,
        texts: masterIdx === 0 ? texts : [texts[1], texts[0]],
      };
    });
  };

  // Vị trí câu cuối cùng đã bắt đầu tại thời điểm t (-1 nếu chưa tới câu nào).
  NDS.rowIndexAt = function (rows, t) {
    let lo = 0;
    let hi = rows.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };

  NDS.Transcript = class {
    /**
     * handlers: { onSeek(seconds), onNav(dir: -1|0|1), onClose(),
     *             onBoxChange(box|null), onBgOpacity(value), onTrackChange(idx, 'auto'|''|trackId),
     *             onPhoneticToggle() }
     */
    constructor(handlers) {
      this.handlers = handlers;
      this.rows = [];
      this.rowEls = [];
      this.activeIdx = -1;
      this.userScrollAt = 0;
      this.sources = [null, null];
      this.query = '';
      this.searchTimer = null;

      this.el = el('div', 'nds-transcript nds-glass nds-hidden');

      // ---- Tiêu đề (kéo để di chuyển) + nút tìm kiếm, độ mờ, đóng ----
      const header = el('div', 'nds-tr-header');
      this.titleEl = el('div', 'nds-tr-title');
      this.searchBtn = iconBtn('nds-tr-tool', ICONS.search);
      this.opacityBtn = iconBtn('nds-tr-tool', ICONS.opacity);
      // Nút bật/tắt phiên âm (chữ "拼" của pinyin + "あ" của furigana).
      this.phoneticBtn = el('button', 'nds-tr-tool nds-tr-phon', '拼あ');
      this.phoneticBtn.type = 'button';
      this.phoneticBtn.addEventListener('click', () => this.handlers.onPhoneticToggle());
      this.kinds = [null, null];
      this.closeBtn = el('button', 'nds-close', '✕');
      this.closeBtn.type = 'button';
      header.append(this.titleEl, this.phoneticBtn, this.searchBtn, this.opacityBtn, this.closeBtn);
      this.header = header;

      // ---- Hàng chỉnh độ mờ nền ----
      this.opacityRow = el('div', 'nds-tr-subrow nds-tr-opacity');
      this.opacityRow.hidden = true;
      this.opacityLabel = el('span', 'nds-tr-sublabel');
      this.opacityInput = el('input', 'nds-slider');
      Object.assign(this.opacityInput, { type: 'range', min: '0', max: '100', step: '5' });
      this.opacityValue = el('span', 'nds-tr-subvalue');
      this.opacityRow.append(this.opacityLabel, this.opacityInput, this.opacityValue);

      // ---- Hàng tìm kiếm ----
      this.searchRow = el('div', 'nds-tr-subrow nds-tr-search');
      this.searchRow.hidden = true;
      this.searchInput = el('input', 'nds-tr-input');
      this.searchInput.type = 'text';
      this.searchInput.spellcheck = false;
      this.searchInput.autocomplete = 'off';
      this.searchRow.append(this.searchInput);

      // ---- Chọn ngôn ngữ cho dòng 1 / dòng 2 của khung ----
      this.legend = el('div', 'nds-tr-legend');
      this.langSelects = [0, 1].map((idx) => {
        const sel = el('select', 'nds-tr-lang nds-tr-l' + (idx + 1));
        sel.addEventListener('change', () => this.handlers.onTrackChange(idx, sel.value));
        this.legend.append(sel);
        return sel;
      });
      this.trackSig = null;

      this.list = el('div', 'nds-tr-list');
      this.results = el('div', 'nds-tr-list nds-tr-results');
      this.results.hidden = true;
      this.empty = el('div', 'nds-tr-empty');

      // ---- Thanh tua theo câu ở đáy khung ----
      const nav = el('div', 'nds-tr-nav');
      this.navBtns = [
        [-1, ICONS.prev, 'navPrev'],
        [0, ICONS.repeat, 'navRepeat'],
        [1, ICONS.next, 'navNext'],
      ].map(([dir, icon, key]) => {
        const b = iconBtn('nds-tr-navbtn', icon);
        b.dataset.key = key;
        b.addEventListener('click', () => this.handlers.onNav(dir));
        nav.append(b);
        return b;
      });

      // ---- Tay nắm đổi cỡ ở 4 cạnh + 4 góc ----
      const grips = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) => {
        const g = el('div', 'nds-tr-grip nds-tr-grip-' + dir);
        g.dataset.dir = dir;
        this._enableResize(g, dir);
        return g;
      });

      this.el.append(header, this.opacityRow, this.searchRow, this.legend, this.list, this.results, this.empty, nav, ...grips);

      // ---- Sự kiện ----
      this.closeBtn.addEventListener('click', () => this.handlers.onClose());
      this.searchBtn.addEventListener('click', () => this._toggleSearch());
      this.opacityBtn.addEventListener('click', () => {
        this.opacityRow.hidden = !this.opacityRow.hidden;
        this.opacityBtn.classList.toggle('nds-on', !this.opacityRow.hidden);
      });
      this.opacityInput.addEventListener('input', () => {
        const v = Number(this.opacityInput.value) / 100;
        this.setBgOpacity(v);
        this.handlers.onBgOpacity(v);
      });
      this.searchInput.addEventListener('input', () => {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this._runSearch(), 120);
      });
      // Esc (khi con trỏ đang trong khung): đóng ô tìm kiếm.
      this.el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.searchRow.hidden) {
          e.preventDefault();
          this._toggleSearch(false);
        }
      });
      this._enableDrag(header);

      // Người dùng tự cuộn → tạm ngừng tự cuộn theo câu đang chiếu.
      const markUser = () => (this.userScrollAt = Date.now());
      this.list.addEventListener('wheel', markUser, { passive: true });
      this.list.addEventListener('touchmove', markUser, { passive: true });
      this.list.addEventListener('keydown', markUser);
      const onRowClick = (e) => {
        const rowEl = e.target.closest('.nds-tr-row');
        if (!rowEl) return;
        const row = this.rows[Number(rowEl.dataset.idx)];
        if (row) {
          this.userScrollAt = 0;
          this.handlers.onSeek(row.start);
        }
      };
      this.list.addEventListener('click', onRowClick);
      this.results.addEventListener('click', onRowClick);

      NDS.swallowPointerEvents(this.el);
      for (const type of ['keydown', 'keyup', 'keypress']) {
        this.el.addEventListener(type, (e) => e.stopPropagation());
      }
      this.el.addEventListener('wheel', (e) => e.stopPropagation());

      // Tự thu gọn khi không thao tác.
      this.idleTimer = null;
      const wake = () => this._wake();
      for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'focusin']) {
        this.el.addEventListener(type, wake, { passive: true });
      }
      this.el.addEventListener('pointerleave', () => this._scheduleIdle());
      this.applyLanguage();
    }

    _wake() {
      this._setIdle(false);
      this._scheduleIdle();
    }

    // Bật/tắt chế độ thu gọn; giữ chữ đứng yên trên màn hình khi phần đầu khung ẩn/hiện.
    _setIdle(idle) {
      if (this.el.classList.contains('nds-tr-idle') === idle) return;
      const lists = [this.list, this.results].filter((l) => !l.hidden);
      const before = lists.map((l) => l.getBoundingClientRect().top);
      this.el.classList.toggle('nds-tr-idle', idle);
      lists.forEach((l, i) => {
        l.scrollTop += l.getBoundingClientRect().top - before[i];
      });
    }

    _scheduleIdle() {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        // Không thu gọn khi đang gõ tìm kiếm / mở danh sách chọn ngôn ngữ / đang kéo.
        if (this.el.matches(':focus-within') || this.el.classList.contains('nds-tr-moving')) {
          this._scheduleIdle();
          return;
        }
        this._setIdle(true);
      }, IDLE_MS);
    }

    /**
     * Danh sách ngôn ngữ cho 2 ô chọn. tracks: các track text của phim;
     * values: giá trị đang chọn ('auto' | '' | trackId); autoLabels: tên track mà 'auto' đang theo.
     */
    setTrackOptions(tracks, values, autoLabels) {
      const sig = JSON.stringify([NDS.lang(), tracks.map((t) => t.id), autoLabels]);
      if (sig !== this.trackSig) {
        this.trackSig = sig;
        this.langSelects.forEach((sel, idx) => {
          const opts = [];
          const auto = el('option', null, NDS.t('trAuto', { n: idx + 1 }) + (autoLabels[idx] ? ' · ' + autoLabels[idx] : ''));
          auto.value = 'auto';
          opts.push(auto);
          for (const t of tracks) {
            const o = el('option', null, t.label || t.language);
            o.value = t.id;
            opts.push(o);
          }
          const off = el('option', null, NDS.t('off'));
          off.value = '';
          opts.push(off);
          sel.replaceChildren(...opts);
        });
      }
      this.langSelects.forEach((sel, idx) => {
        sel.value = values[idx];
        if (sel.value !== values[idx]) sel.value = 'auto';
        sel.title = NDS.t('trLine', { n: idx + 1 });
      });
    }

    applyLanguage() {
      this.titleEl.textContent = NDS.t('transcript');
      this.header.title = NDS.t('trMoveHint');
      this.closeBtn.title = NDS.t('close');
      this.searchBtn.title = NDS.t('trSearch');
      this.opacityBtn.title = NDS.t('trBgOpacity');
      this.phoneticBtn.title = NDS.t('trPhonetic');
      this.opacityLabel.textContent = NDS.t('trBgOpacity');
      this.searchInput.placeholder = NDS.t('trSearchPlaceholder');
      for (const b of this.navBtns) b.title = NDS.t(b.dataset.key);
      if (this.query) this._runSearch();
      this._renderEmpty();
    }

    setOpen(open) {
      this.open = open;
      this.el.classList.toggle('nds-hidden', !open);
      if (open) {
        this.userScrollAt = 0;
        this._scrollToActive(true);
        this._wake();
      } else {
        clearTimeout(this.idleTimer);
      }
    }

    // ---------- Vị trí / kích cỡ ----------
    /** box: {x, y, w, h} theo % của player, hoặc null = vị trí mặc định. */
    setBox(box) {
      const st = this.el.style;
      if (!box) {
        for (const k of ['left', 'top', 'width', 'height', 'bottom']) st.removeProperty(k);
        return;
      }
      st.left = box.x + '%';
      st.top = box.y + '%';
      st.width = box.w + '%';
      st.height = box.h + '%';
      st.bottom = 'auto';
    }

    _parentRect() {
      return (this.el.offsetParent || this.el.parentElement).getBoundingClientRect();
    }

    // Lấy khung hiện tại (px, tương đối với player).
    _currentRect() {
      const p = this._parentRect();
      const r = this.el.getBoundingClientRect();
      return { p, x: r.left - p.left, y: r.top - p.top, w: r.width, h: r.height };
    }

    _applyPx(x, y, w, h, p) {
      const st = this.el.style;
      st.left = x + 'px';
      st.top = y + 'px';
      st.width = w + 'px';
      st.height = h + 'px';
      st.bottom = 'auto';
      this._pending = { x, y, w, h, p };
    }

    _commitBox() {
      const q = this._pending;
      this._pending = null;
      if (!q || !q.p.width || !q.p.height) return;
      const r2 = (v) => Math.round(v * 100) / 100;
      const box = {
        x: r2((q.x / q.p.width) * 100),
        y: r2((q.y / q.p.height) * 100),
        w: r2((q.w / q.p.width) * 100),
        h: r2((q.h / q.p.height) * 100),
      };
      this.setBox(box);
      this.handlers.onBoxChange(box);
    }

    _enableDrag(handle) {
      let d = null;
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        e.preventDefault();
        d = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ...this._currentRect() };
        handle.setPointerCapture(e.pointerId);
        this.el.classList.add('nds-tr-moving');
      });
      handle.addEventListener('pointermove', (e) => {
        if (!d || e.pointerId !== d.id) return;
        const x = Math.min(Math.max(0, d.x + e.clientX - d.sx), d.p.width - d.w);
        const y = Math.min(Math.max(0, d.y + e.clientY - d.sy), d.p.height - d.h);
        this._applyPx(x, y, d.w, d.h, d.p);
      });
      const end = (e) => {
        if (!d || e.pointerId !== d.id) return;
        d = null;
        this.el.classList.remove('nds-tr-moving');
        this._commitBox();
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      // Nhấp đúp tiêu đề: về vị trí và cỡ mặc định.
      handle.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        this.setBox(null);
        this.handlers.onBoxChange(null);
      });
    }

    _enableResize(grip, dir) {
      let d = null;
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        d = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ...this._currentRect() };
        grip.setPointerCapture(e.pointerId);
        this.el.classList.add('nds-tr-moving');
      });
      grip.addEventListener('pointermove', (e) => {
        if (!d || e.pointerId !== d.id) return;
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        let { x, y, w, h } = d;
        const right = d.x + d.w;
        const bottom = d.y + d.h;
        if (dir.includes('e')) w = Math.min(Math.max(MIN_W, d.w + dx), d.p.width - d.x);
        if (dir.includes('s')) h = Math.min(Math.max(MIN_H, d.h + dy), d.p.height - d.y);
        if (dir.includes('w')) {
          x = Math.min(Math.max(0, d.x + dx), right - MIN_W);
          w = right - x;
        }
        if (dir.includes('n')) {
          y = Math.min(Math.max(0, d.y + dy), bottom - MIN_H);
          h = bottom - y;
        }
        this._applyPx(x, y, w, h, d.p);
      });
      const end = (e) => {
        if (!d || e.pointerId !== d.id) return;
        d = null;
        this.el.classList.remove('nds-tr-moving');
        this._commitBox();
      };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    }

    // ---------- Độ mờ nền ----------
    setBgOpacity(v) {
      const a = Math.min(1, Math.max(0, Number(v)));
      this.el.style.setProperty('--nds-tr-alpha', String(a));
      this.opacityInput.value = String(Math.round(a * 100));
      this.opacityInput.style.setProperty('--fill', Math.round(a * 100) + '%');
      this.opacityValue.textContent = Math.round(a * 100) + '%';
    }

    // ---------- Tìm kiếm ----------
    _toggleSearch(force) {
      const show = force === undefined ? this.searchRow.hidden : force;
      this.searchRow.hidden = !show;
      this.searchBtn.classList.toggle('nds-on', show);
      if (show) {
        this.searchInput.focus();
      } else {
        this.searchInput.value = '';
        this._runSearch();
      }
    }

    _runSearch() {
      const raw = this.searchInput.value;
      const nq = normalize(raw);
      this.query = nq;
      const searching = !!nq;
      this.list.hidden = searching || !this.rows.length;
      this.results.hidden = !searching;
      if (!searching) {
        this.results.replaceChildren();
        this._scrollToActive(true);
        return;
      }
      const qTokens = nq.split(' ').filter(Boolean);
      const exact = [];
      const similar = [];
      this.rows.forEach((row, i) => {
        const full = normalize(row.texts.join(' '));
        if (full.includes(nq)) {
          exact.push(i);
          return;
        }
        const words = full.split(' ');
        const hit = qTokens.filter((t) => tokenMatches(t, words)).length;
        const score = hit / qTokens.length;
        if (score >= 0.5) similar.push({ i, score });
      });
      similar.sort((a, b) => b.score - a.score || a.i - b.i);

      const frag = document.createDocumentFragment();
      const group = (key, idxs, mark) => {
        if (!idxs.length) return;
        frag.append(el('div', 'nds-tr-group', NDS.t(key, { n: idxs.length })));
        for (const i of idxs.slice(0, MAX_RESULTS)) frag.append(this._rowEl(i, mark ? nq : ''));
      };
      group('trExact', exact, true);
      group('trSimilar', similar.map((s) => s.i), false);
      if (!exact.length && !similar.length) frag.append(el('div', 'nds-tr-empty', NDS.t('trNoResults')));
      this.results.replaceChildren(frag);
      this.results.scrollTop = 0;
    }

    // ---------- Dữ liệu ----------
    _rowEl(i, nq) {
      const row = this.rows[i];
      const r = el('div', 'nds-tr-row');
      r.dataset.idx = i;
      r.append(el('span', 'nds-tr-time', fmtTime(row.start)));
      const body = el('div', 'nds-tr-body');
      row.texts.forEach((text, k) => {
        if (!text) return;
        const cls = 'nds-tr-t' + (k + 1);
        // Phiên âm chỉ dùng khi không tô sáng kết quả tìm kiếm.
        if (!nq && this.kinds[k]) {
          const div = el('div', cls + ' nds-tr-ruby');
          NDS.Phonetic.append(div, text, this.kinds[k]);
          body.append(div);
        } else {
          body.append(highlighted(cls, text, nq));
        }
      });
      r.append(body);
      return r;
    }

    /** Cập nhật dữ liệu; chỉ dựng lại danh sách khi cue hoặc nhãn ngôn ngữ thay đổi. */
    /** kinds: loại phiên âm cho dòng 1 / dòng 2 ('zh' | 'ja' | null), đã tính cả nút bật/tắt. */
    setData(cues1, cues2, kinds = [null, null], phoneticOn = false) {
      this.phoneticBtn.classList.toggle('nds-on', phoneticOn);
      const sameKinds = kinds[0] === this.kinds[0] && kinds[1] === this.kinds[1];
      if (cues1 === this.sources[0] && cues2 === this.sources[1] && sameKinds) return;
      this.sources = [cues1, cues2];
      this.kinds = kinds.slice();
      const keepScroll = this.list.scrollTop;

      this.rows = NDS.buildRows(cues1, cues2);
      this.activeIdx = -1;
      const frag = document.createDocumentFragment();
      this.rowEls = this.rows.map((row, i) => {
        const r = this._rowEl(i, '');
        frag.append(r);
        return r;
      });
      this.list.replaceChildren(frag);
      this.list.scrollTop = keepScroll;
      this._renderEmpty();
      if (this.query) this._runSearch();
      if (this.open) this._scrollToActive(true);
    }

    _renderEmpty() {
      const isEmpty = !this.rows.length;
      this.empty.textContent = isEmpty ? NDS.t('transcriptEmpty') : '';
      this.empty.hidden = !isEmpty;
      this.list.hidden = isEmpty || !!this.query;
    }

    /** Gọi mỗi khung hình với video.currentTime. */
    update(t) {
      if (!this.open || !this.rows.length) return;
      const idx = NDS.rowIndexAt(this.rows, t + 0.05);
      if (idx === this.activeIdx) return;
      if (this.rowEls[this.activeIdx]) this.rowEls[this.activeIdx].classList.remove('nds-tr-active');
      this.activeIdx = idx;
      if (this.rowEls[idx]) this.rowEls[idx].classList.add('nds-tr-active');
      this._scrollToActive(false);
    }

    _scrollToActive(force) {
      const rowEl = this.rowEls[this.activeIdx];
      if (!rowEl || this.list.hidden) return;
      if (!force && Date.now() - this.userScrollAt < USER_SCROLL_PAUSE_MS) return;
      // Đặt câu đang chiếu ở khoảng 1/3 chiều cao khung.
      const target = rowEl.offsetTop - this.list.clientHeight / 3;
      this.list.scrollTo({ top: Math.max(0, target), behavior: force ? 'auto' : 'smooth' });
    }
  };
})();
