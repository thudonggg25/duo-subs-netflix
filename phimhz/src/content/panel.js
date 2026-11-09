/*
 * panel.js — bảng điều khiển phimhz: chọn phụ đề, dịch AI, thuyết minh, hiển thị, cài đặt.
 * Dựng DOM một lần; refresh() chỉ cập nhật giá trị và trạng thái.
 */
window.PHZ = window.PHZ || {};

(() => {
  'use strict';
  const PHZ = window.PHZ;

  // Giá (USD / 1 triệu token): vào, ra, đọc cache.
  const PRICES = {
    'claude-opus-5-5': [4, 20, 0.2],
    'claude-sonnet-5-5': [2, 10, 0.2],
    'claude-haiku-5-5': [0.1, 0.5, 0.01],
  };
  const MODELS = [
    ['claude-opus-5-5', 'Claude Opus 5.5 (mặc định, dịch tốt nhất)'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['claude-haiku-5-5', 'Claude Haiku 5.5 (rẻ nhất)'],
  ];

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) e.append(c);
    return e;
  }

  let uid = 0;
  // Một hàng "nhãn — ô nhập" có <label for> đúng chuẩn.
  function row(labelText, input) {
    const id = 'phz-f' + ++uid;
    input.id = id;
    return el('div', { class: 'phz-row' }, [el('label', { for: id, text: labelText }), input]);
  }

  function select(options, onchange) {
    const s = el('select', { onchange: () => onchange(s.value) });
    setOptions(s, options);
    return s;
  }

  function setOptions(s, options) {
    // Dựng lại option làm đóng menu đang mở → chỉ dựng khi danh sách thật sự đổi.
    const sig = JSON.stringify(options);
    if (s.__phzSig === sig) return;
    s.__phzSig = sig;
    const keep = s.value;
    s.textContent = '';
    for (const [value, label] of options) s.append(el('option', { value, text: label }));
    if (options.some(([v]) => v === keep)) s.value = keep;
  }

  function range(min, max, step, onchange) {
    const r = el('input', { type: 'range', min, max, step });
    r.addEventListener('input', () => onchange(+r.value));
    return r;
  }

  function checkbox(labelText, onchange) {
    const id = 'phz-f' + ++uid;
    const c = el('input', { type: 'checkbox', id });
    c.addEventListener('change', () => onchange(c.checked));
    return { input: c, node: el('div', { class: 'phz-row phz-check' }, [c, el('label', { for: id, text: labelText })]) };
  }

  class Panel {
    constructor(app) {
      this.app = app;
      const S = PHZ.Settings;
      const set = (k) => (v) => S.set({ [k]: v });

      this.el = el('div', { class: 'phz-panel phz-hidden', role: 'dialog', 'aria-label': 'phimhz' });
      // Không để phím tắt của player (cách, mũi tên, f…) ăn mất khi đang gõ trong bảng.
      for (const type of ['keydown', 'keyup', 'keypress']) this.el.addEventListener(type, (e) => e.stopPropagation());
      this.el.addEventListener('click', (e) => e.stopPropagation());

      const close = el('button', { type: 'button', class: 'phz-close', 'aria-label': 'Đóng', text: '×', onclick: () => this.toggle(false) });
      this.el.append(el('div', { class: 'phz-head' }, [el('strong', { text: 'phimhz' }), close]));

      // --- Phụ đề ---
      this.groupSel = select([], (v) => app.chooseGroup(v));
      this.groupRow = row('Nguồn', this.groupSel);
      this.t1Sel = select([], (v) => app.chooseTrack(0, v));
      this.t2Sel = select([], (v) => app.chooseTrack(1, v));
      this.trackStatus = el('div', { class: 'phz-note' });
      this.el.append(
        el('h3', { text: 'Phụ đề' }),
        this.groupRow,
        row('Phụ đề 1', this.t1Sel),
        row('Phụ đề 2', this.t2Sel),
        this.trackStatus
      );

      // --- Dịch AI ---
      this.seriesInput = el('input', { type: 'text' });
      this.seriesInput.addEventListener('change', () => app.translator.setSeries(this.seriesInput.value.trim()));
      this.trButton = el('button', { type: 'button', class: 'phz-primary', onclick: () => app.toggleTranslate() });
      this.trStatus = el('div', { class: 'phz-note' });
      this.auto = checkbox('Tự dịch khi phim không có phụ đề Việt', set('autoTranslate'));
      this.glossary = el('textarea', { rows: '7', spellcheck: 'false' });
      const gSave = el('button', { type: 'button', text: 'Lưu bảng', onclick: () => app.translator.saveGlossary(this.glossary.value) });
      const gRedo = el('button', {
        type: 'button',
        text: 'Lập lại',
        onclick: async () => {
          await app.translator.saveGlossary('');
          app.toggleTranslate(true);
        },
      });
      this.el.append(
        el('h3', { text: 'Dịch tiếng Việt bằng AI' }),
        row('Tên phim', this.seriesInput),
        this.trButton,
        this.trStatus,
        this.auto.node,
        el('details', {}, [
          el('summary', { text: 'Bảng nhân vật và xưng hô' }),
          el('p', { class: 'phz-note', text: 'Dùng chung cho mọi tập của phim này. Sửa trực tiếp nếu AI đoán sai giới tính hay cách xưng hô.' }),
          this.glossary,
          el('div', { class: 'phz-buttons' }, [gSave, gRedo]),
        ])
      );

      // --- Thuyết minh ---
      this.narr = checkbox('Bật thuyết minh', set('narrate'));
      this.engineSel = select(
        [
          ['browser', 'Giọng của trình duyệt'],
          ['server', 'Máy chủ đọc trên máy (VieNeu…)'],
        ],
        set('engine')
      );
      this.voiceSel = select([], set('voiceName'));
      this.voiceRow = row('Giọng', this.voiceSel);
      this.serverInput = el('input', { type: 'text' });
      this.serverInput.addEventListener('change', () => S.set({ serverUrl: this.serverInput.value.trim() }));
      this.serverRow = row('Địa chỉ', this.serverInput);
      this.duck = range(0, 100, 5, (v) => S.set({ duck: v / 100 }));
      this.rate = range(0.8, 1.5, 0.05, set('rate'));
      this.nvol = range(0, 100, 5, (v) => S.set({ narrVolume: v / 100 }));
      this.narrStatus = el('div', { class: 'phz-note' });
      this.el.append(
        el('h3', { text: 'Thuyết minh' }),
        this.narr.node,
        row('Nguồn giọng', this.engineSel),
        this.voiceRow,
        this.serverRow,
        row('Tiếng phim khi đọc', this.duck),
        row('Tốc độ đọc', this.rate),
        row('Âm lượng giọng', this.nvol),
        this.narrStatus
      );
      speechSynthesis.addEventListener('voiceschanged', () => this.refresh());

      // --- Hiển thị ---
      this.show1 = checkbox('Hiện phụ đề 1', set('show1'));
      this.show2 = checkbox('Hiện phụ đề 2', set('show2'));
      this.font = range(2, 8, 0.2, set('fontSize'));
      this.bottom = range(2, 40, 1, set('bottom'));
      this.offsetVal = el('output', {});
      const nudge = (d) => el('button', { type: 'button', text: (d > 0 ? '+' : '') + d, onclick: () => app.nudgeOffset(d) });
      this.el.append(
        el('h3', { text: 'Hiển thị' }),
        this.show1.node,
        this.show2.node,
        row('Cỡ chữ', this.font),
        row('Cách đáy', this.bottom),
        el('div', { class: 'phz-row' }, [
          el('span', { text: 'Lệch thời gian' }),
          el('div', { class: 'phz-buttons' }, [nudge(-0.5), nudge(-0.1), this.offsetVal, nudge(0.1), nudge(0.5)]),
        ])
      );

      // --- Cài đặt ---
      this.keyInput = el('input', { type: 'password', autocomplete: 'off', placeholder: 'sk-ant-…' });
      this.keyInput.addEventListener('change', () => S.set({ apiKey: this.keyInput.value.trim() }));
      this.modelSel = select(MODELS, set('model'));
      this.diag = el('div', { class: 'phz-note' });
      this.el.append(
        el('h3', { text: 'Cài đặt' }),
        row('API key Anthropic', this.keyInput),
        row('Model dịch', this.modelSel),
        this.diag
      );

      S.onChange(() => this.refresh());
      app.translator.onChange(() => this.refresh());
    }

    get open() {
      return !this.el.classList.contains('phz-hidden');
    }

    toggle(force) {
      const open = force == null ? !this.open : force;
      this.el.classList.toggle('phz-hidden', !open);
      if (open) this.refresh();
    }

    refresh() {
      if (!this.open) return;
      const app = this.app;
      const s = PHZ.Settings.data;
      const tr = app.translator;
      const groups = app.groupsSorted();

      setOptions(this.groupSel, groups.map((g) => [g.key, `${g.label} · ${new Date(g.at).toLocaleTimeString('vi-VN')}`]));
      this.groupSel.value = app.state.group || '';
      this.groupRow.style.display = groups.length > 1 ? '' : 'none';

      const tracks = app.currentTracks();
      const opts = tracks.map((t) => [t.id, t.title]);
      setOptions(this.t1Sel, [['', 'Tắt'], ...opts]);
      setOptions(this.t2Sel, [['', 'Tắt'], ...opts, ['ai', 'Tiếng Việt AI (dịch từ Phụ đề 1)']]);
      this.t1Sel.value = app.state.sel[0] || '';
      this.t2Sel.value = app.state.sel[1] || '';
      this.trackStatus.textContent = tracks.length
        ? app.state.status.filter(Boolean).join(' · ')
        : 'Chưa thấy danh sách phụ đề. Mở phim và bấm phát; nếu vẫn không thấy, tải lại trang.';

      if (document.activeElement !== this.seriesInput) this.seriesInput.value = tr.series || '';
      if (document.activeElement !== this.glossary) this.glossary.value = tr.glossary || '';
      const { done, total } = tr.progress;
      this.trButton.textContent = tr.running
        ? 'Dừng dịch'
        : tr.status === 'done'
          ? 'Đã dịch xong tập này'
          : done && done < total
            ? 'Dịch tiếp'
            : 'Dịch sang tiếng Việt';
      this.trButton.disabled = !tr.running && (!total || tr.status === 'done');
      const price = PRICES[s.model] || PRICES['claude-opus-5-5'];
      const usd = (tr.cost.input * price[0] + tr.cost.output * price[1] + tr.cost.cacheRead * price[2]) / 1e6;
      const parts = [];
      if (total) parts.push(`Đã dịch ${done}/${total} câu`);
      if (tr.phase) parts.push(tr.phase);
      if (usd > 0) parts.push(`lần này ≈ $${usd.toFixed(2)}`);
      if (tr.status === 'error') parts.push('Lỗi: ' + tr.error);
      if (!s.apiKey) parts.push('Cần nhập API key ở mục Cài đặt');
      this.trStatus.textContent = parts.join(' · ');
      this.auto.input.checked = !!s.autoTranslate;

      this.narr.input.checked = !!s.narrate;
      this.engineSel.value = s.engine;
      const voices = PHZ.BrowserVoice.voices();
      setOptions(this.voiceSel, voices.length ? voices.map((v) => [v.name, v.name]) : [['', 'Máy chưa có giọng tiếng Việt']]);
      if (s.voiceName) this.voiceSel.value = s.voiceName;
      this.voiceRow.style.display = s.engine === 'browser' ? '' : 'none';
      this.serverRow.style.display = s.engine === 'server' ? '' : 'none';
      if (document.activeElement !== this.serverInput) this.serverInput.value = s.serverUrl;
      this.duck.value = Math.round(s.duck * 100);
      this.rate.value = s.rate;
      this.nvol.value = Math.round(s.narrVolume * 100);
      const nErr = s.engine === 'server' && app.narrator.lastError;
      this.narrStatus.textContent = nErr
        ? 'Máy chủ đọc: ' + nErr
        : app.narrationSource() === 'ai'
          ? 'Đọc theo bản dịch AI (lời thuyết minh riêng, ngắn hơn phụ đề).'
          : app.narrationSource() === 'vi'
            ? 'Đọc theo phụ đề tiếng Việt chính thức.'
            : 'Cần Phụ đề 2 là tiếng Việt (chính thức hoặc AI) để thuyết minh.';

      this.show1.input.checked = s.show1;
      this.show2.input.checked = s.show2;
      this.font.value = s.fontSize;
      this.bottom.value = s.bottom;
      const off = PHZ.Settings.offsetFor(location.hostname);
      this.offsetVal.textContent = (off > 0 ? '+' : '') + off.toFixed(1) + ' giây';

      if (document.activeElement !== this.keyInput) this.keyInput.value = s.apiKey;
      this.modelSel.value = s.model;
      const st = app.sources.stats;
      this.diag.textContent = `Chẩn đoán: bắt ${st.captures} phản hồi · ${st.manifests} danh sách phụ đề` + (st.unsupported ? ` · ${st.unsupported} track fMP4 chưa đọc được` : '') + (st.errors ? ` · ${st.errors} lỗi phân tích` : '');
    }
  }

  PHZ.Panel = Panel;
})();
