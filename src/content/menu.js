/*
 * menu.js — nút nổi trên player + panel cài đặt (phong cách iOS "liquid glass").
 * Chỉ dựng giao diện và phát sự kiện; logic xử lý nằm ở main.js.
 * Mọi chữ hiển thị lấy qua NDS.t() để đổi được VIE/ENG ngay lập tức.
 */
window.NDS = window.NDS || {};

(() => {
  'use strict';
  const NDS = window.NDS;

  // Helper tạo phần tử DOM gọn: h('div', {class: 'x', onclick: fn}, [con...])
  // Icon phụ đề: khung màn hình bo góc + 2 dòng chữ (gợi ý "2 phụ đề"), nét trắng như icon của Netflix.
  const SUB_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2.5" y="4.5" width="19" height="15" rx="3"/>' +
    '<path d="M6.5 11.5h4M13.5 11.5h4M6.5 15.5h7M16 15.5h1.5"/></svg>';
  // Icon khung "Câu thoại": danh sách các dòng chữ, cùng kiểu nét trắng.
  const TRANSCRIPT_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 6h16M4 10.5h10M4 15h16M4 19.5h10"/></svg>';

  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c != null) el.append(c);
    }
    return el;
  }

  function trackLabel(t) {
    let s = t.label;
    if (t.kind === 'closedcaptions') s += ' [CC]';
    if (t.forced) s += ' (Forced)';
    if (t.status === 'image') s += ' — ' + NDS.t('imageOnly');
    if (t.status === 'missing') s += ' — ' + NDS.t('noUrl');
    return s;
  }

  // Thanh trượt: tô phần đã chọn bằng biến CSS --fill (như slider iOS).
  function paintSlider(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
  }

  NDS.Menu = class {
    /**
     * handlers: {
     *   onToggleEnabled(bool), onSelectTrack(idx, trackId|null),
     *   onStyleChange(idx, patch), onLayoutChange(patch), onLanguageChange(lang),
     *   onReset(), onOpenChange(bool), onToggleTranscript(),
     *   onPinyinToggle(bool), onPinyinTrack('auto'|trackId)
     * }
     */
    constructor(handlers) {
      this.handlers = handlers;
      this.open = false;
      this.styleTab = 0;
      this.trackSignature = null; // null để lần update đầu tiên luôn dựng option (kể cả "Tắt")
      this.lastState = null;
      this.lang = null;
      this.i18nNodes = []; // [{node, key, params, attr}] để dịch lại khi đổi ngôn ngữ

      // ---- Nút nổi ----
      const btnIcon = h('span', { class: 'nds-button-icon' });
      btnIcon.innerHTML = SUB_ICON_SVG; // SVG tĩnh do extension định nghĩa
      this.button = h('button', {
        class: 'nds-button nds-glass',
        type: 'button',
        onclick: () => this.setOpen(!this.open),
      }, [
        // Bình thường chỉ hiện icon phụ đề trắng (giống icon của Netflix, không gây phân tâm);
        // rê chuột vào hoặc khi panel mở mới hiện khung kính + chữ "DUO SUBS".
        btnIcon,
        h('span', { class: 'nds-button-text' }, 'DUO SUBS'),
      ]);
      this._i18n(this.button, 'title', null, 'title');
      NDS.swallowPointerEvents(this.button);

      // Nút mở khung "Câu thoại" (song ngữ), cùng kiểu với nút DUO SUBS.
      const trIcon = h('span', { class: 'nds-button-icon' });
      trIcon.innerHTML = TRANSCRIPT_ICON_SVG; // SVG tĩnh do extension định nghĩa
      this.trButton = h('button', {
        class: 'nds-button nds-glass',
        type: 'button',
        onclick: () => this.handlers.onToggleTranscript(),
      }, [trIcon, this._i18n(h('span', { class: 'nds-button-text' }), 'transcript')]);
      this._i18n(this.trButton, 'transcriptTitle', null, 'title');
      NDS.swallowPointerEvents(this.trButton);
      this.buttons = h('div', { class: 'nds-buttons' }, [this.trButton, this.button]);

      // ---- Điều khiển ----
      this.enabledInput = this._switch((v) => this.handlers.onToggleEnabled(v));

      this.trackSelects = [0, 1].map((idx) =>
        h('select', {
          class: 'nds-select',
          onchange: (e) => this.handlers.onSelectTrack(idx, e.target.value || null),
        })
      );
      this.trackStatus = [0, 1].map(() => h('div', { class: 'nds-status' }));
      this.movieStatus = h('div', { class: 'nds-status' });

      // Pinyin: công tắc + nguồn chữ Hán (dùng khi không có phụ đề tiếng Trung nào đang bật).
      this.pinyinInput = this._switch((v) => this.handlers.onPinyinToggle(v));
      this.pinyinSelect = h('select', {
        class: 'nds-select nds-select-pinyin',
        onchange: (e) => this.handlers.onPinyinTrack(e.target.value),
      });
      this._i18n(this.pinyinSelect, 'pinyinSource', null, 'title');
      this.pinyinStatus = h('div', { class: 'nds-status nds-status-hint' });
      this.pinyinSignature = null;

      this.langSeg = this._segmented(
        [
          { value: 'en', text: 'EN' },
          { value: 'vi', text: 'VIE' },
        ],
        (v) => this.handlers.onLanguageChange(v),
        'nds-seg-lang'
      );
      this.styleSeg = this._segmented(
        [0, 1, 2].map((i) => (i === 2 ? { value: i, key: 'pinyinTab' } : { value: i, key: 'styleTab', params: { n: i + 1 } })),
        (v) => {
          this.styleTab = v;
          this._renderStyleFields();
        }
      );

      const style = (key, read) => (e) => this.handlers.onStyleChange(this.styleTab, { [key]: read(e.target) });
      const num = (t) => Number(t.value);
      const str = (t) => t.value;

      this.fields = {
        fontSize: this._slider(12, 64, 1, style('fontSize', num)),
        fontSizeValue: h('span', { class: 'nds-value' }),
        color: h('input', { type: 'color', class: 'nds-swatch', oninput: style('color', str) }),
        effect: h('select', { class: 'nds-select nds-select-compact', onchange: style('effect', str) }, [
          this._i18n(h('option', { value: 'none' }), 'effectNone'),
          this._i18n(h('option', { value: 'outline' }), 'effectOutline'),
          this._i18n(h('option', { value: 'shadow' }), 'effectShadow'),
        ]),
        effectColor: h('input', { type: 'color', class: 'nds-swatch', oninput: style('effectColor', str) }),
        bgEnabled: this._switch((v) => this.handlers.onStyleChange(this.styleTab, { bgEnabled: v })),
        bgColor: h('input', { type: 'color', class: 'nds-swatch', oninput: style('bgColor', str) }),
        bgOpacity: this._slider(0, 100, 5, (e) =>
          this.handlers.onStyleChange(this.styleTab, { bgOpacity: Number(e.target.value) / 100 })
        ),
        bgOpacityValue: h('span', { class: 'nds-value' }),
        phonetic: this._switch((v) => this.handlers.onStyleChange(this.styleTab, { phonetic: v })),
      };
      const f = this.fields;

      const layout = (patch) => this.handlers.onLayoutChange(patch);
      this.layoutFields = {
        avoid: this._switch((v) => layout({ avoidOverlap: v })),
        gap: this._slider(0, 40, 1, (e) => layout({ gap: Number(e.target.value) })),
        gapValue: h('span', { class: 'nds-value' }),
        lift: this._switch((v) => layout({ liftWithControls: v })),
      };
      const L = this.layoutFields;

      // Một dòng kiểu iOS: nhãn bên trái, điều khiển bên phải.
      const cell = (key, params, ...controls) =>
        h('div', { class: 'nds-cell' }, [
          this._i18n(h('span', { class: 'nds-cell-label' }), key, params),
          h('div', { class: 'nds-cell-controls' }, controls),
        ]);
      const sep = () => h('div', { class: 'nds-sep' });
      const card = (titleKey, ...children) =>
        h('section', { class: 'nds-card' }, [
          this._i18n(h('div', { class: 'nds-section-title' }), titleKey),
          ...children,
        ]);
      const svg = (markup) => {
        const span = h('span', { class: 'nds-icon' });
        span.innerHTML = markup; // SVG tĩnh do extension định nghĩa
        return span;
      };
      const ICON_RESET =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/></svg>';
      const ICON_TELEGRAM =
        '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#29a9eb"/><path d="M5.4 11.7l11.3-4.4c.5-.2 1 .1.8.9l-1.9 9c-.1.6-.5.8-1 .5l-2.9-2.1-1.4 1.3c-.2.2-.3.3-.6.3l.2-3 5.4-4.9c.2-.2 0-.3-.4-.1l-6.7 4.2-2.9-.9c-.6-.2-.6-.6.1-.8z" fill="#fff"/></svg>';
      const ICON_PULSE =
        '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l2.5-6 4 13 3-9 1.5 2H22"/></svg>';

      this.diagText = h('pre', { class: 'nds-diag-text' });
      this._i18n(this.diagText, 'collecting');

      this.panel = h('div', { class: 'nds-panel nds-glass nds-hidden' }, [
        // ---- Header: logo 52hz + tiêu đề + VIE/ENG + đóng ----
        h('header', { class: 'nds-panel-header' }, [
          h('div', { class: 'nds-logo', 'aria-hidden': 'true' }, '52hz'),
          h('div', { class: 'nds-heading' }, [
            this._i18n(h('div', { class: 'nds-panel-title' }), 'title'),
            this._i18n(h('div', { class: 'nds-panel-subtitle' }), 'tagline'),
          ]),
          this.langSeg.el,
          this._i18n(
            h('button', { type: 'button', class: 'nds-close', onclick: () => this.setOpen(false) }, '✕'),
            'close',
            null,
            'title'
          ),
        ]),
        // ---- 2 cột: ngôn ngữ phụ đề | tuỳ chỉnh hiển thị ----
        h('div', { class: 'nds-columns' }, [
          card(
            'secLanguages',
            cell('enable', null, this.enabledInput.wrap),
            this.movieStatus,
            sep(),
            cell('sub', { n: 1 }, this.trackSelects[0]),
            this.trackStatus[0],
            cell('sub', { n: 2 }, this.trackSelects[1]),
            this.trackStatus[1],
            cell('pinyin', null, this.pinyinSelect, this.pinyinInput.wrap),
            this.pinyinStatus,
            // Đặt lại + chẩn đoán nằm cuối cột trái cho panel gọn.
            h('div', { class: 'nds-card-bottom' }, [
              h('button', { type: 'button', class: 'nds-reset', onclick: () => this.handlers.onReset() }, [
                svg(ICON_RESET),
                this._i18n(h('span'), 'reset'),
              ]),
              // Mục chẩn đoán: chụp màn hình phần này khi báo lỗi.
              h('details', { class: 'nds-diag' }, [
                h('summary', {}, [svg(ICON_PULSE), this._i18n(h('span'), 'diag')]),
                this.diagText,
              ]),
            ])
          ),
          card(
            'secDisplay',
            this.styleSeg.el,
            cell('avoidOverlap', null, L.avoid.wrap),
            cell('gap', null, L.gap, L.gapValue),
            cell('lift', null, L.lift.wrap),
            sep(),
            cell('fontSize', null, f.fontSize, f.fontSizeValue),
            cell('color', null, f.color),
            cell('effect', null, f.effect, f.effectColor),
            cell('background', null, f.bgColor, f.bgEnabled.wrap),
            cell('opacity', null, f.bgOpacity, f.bgOpacityValue),
            (this.phoneticCell = cell('phonetic', null, f.phonetic.wrap))
          ),
        ]),
        // Bản quyền: icon Telegram + @calm52hz ở góc dưới bên phải (mở t.me/calm52hz).
        h('div', { class: 'nds-copyright' }, [
          h('a', { class: 'nds-tg', href: 'https://t.me/calm52hz', target: '_blank', rel: 'noopener noreferrer' }, [
            svg(ICON_TELEGRAM),
            h('span', {}, '@calm52hz'),
          ]),
        ]),
      ]);
      NDS.swallowPointerEvents(this.panel);
      // Không để phím gõ trong panel kích hoạt phím tắt của Netflix (space = pause, f = fullscreen...).
      for (const type of ['keydown', 'keyup', 'keypress']) {
        this.panel.addEventListener(type, (e) => e.stopPropagation());
      }
      // Cuộn trong panel không lan ra player.
      this.panel.addEventListener('wheel', (e) => e.stopPropagation());

      // Bấm ra ngoài panel thì đóng panel.
      document.addEventListener('pointerdown', (e) => {
        // Kéo/chỉnh phụ đề trên màn hình không làm đóng panel.
        const onBlock = e.target.closest && e.target.closest('.nds-block');
        const onTranscript = e.target.closest && e.target.closest('.nds-transcript');
        if (this.open && !onBlock && !onTranscript && !this.panel.contains(e.target) && !this.buttons.contains(e.target)) {
          this.setOpen(false);
        }
      }, true);
    }

    // ---------- Thành phần kiểu iOS ----------

    // Gắn chữ dịch được vào node (textContent hoặc thuộc tính attr).
    _i18n(node, key, params, attr) {
      this.i18nNodes.push({ node, key, params, attr });
      return node;
    }

    _switch(onChange) {
      const input = h('input', { type: 'checkbox', onchange: (e) => onChange(e.target.checked) });
      const wrap = h('label', { class: 'nds-switch' }, [input, h('span', { class: 'nds-switch-track' })]);
      input.wrap = wrap;
      return input;
    }

    _slider(min, max, step, onInput) {
      const input = h('input', {
        type: 'range',
        class: 'nds-slider',
        min: String(min),
        max: String(max),
        step: String(step),
        oninput: (e) => {
          paintSlider(e.target);
          onInput(e);
        },
      });
      return input;
    }

    _segmented(options, onSelect, extraClass = '') {
      const buttons = options.map((o) => {
        const b = h('button', { type: 'button', class: 'nds-seg-btn', onclick: () => onSelect(o.value) }, o.text || '');
        if (o.key) this._i18n(b, o.key, o.params);
        return { value: o.value, b };
      });
      const el = h('div', { class: `nds-seg ${extraClass}` }, buttons.map((x) => x.b));
      return {
        el,
        set(value) {
          buttons.forEach((x) => x.b.classList.toggle('nds-seg-active', x.value === value));
        },
      };
    }

    _applyLanguage() {
      for (const { node, key, params, attr } of this.i18nNodes) {
        const text = NDS.t(key, params);
        if (attr) node.setAttribute(attr, text);
        else node.textContent = text;
      }
      this.trackSignature = null; // dựng lại option phụ đề ("Tắt", "chỉ có dạng ảnh"...)
    }

    // ---------- API cho main.js ----------

    setOpen(open) {
      if (this.open === open) return;
      this.open = open;
      this.panel.classList.toggle('nds-hidden', !open);
      this.button.classList.toggle('nds-open', open);
      this.handlers.onOpenChange(open);
    }

    setDiag(text) {
      this.diagText.textContent = text;
    }

    setButtonVisible(visible) {
      this.buttons.classList.toggle('nds-hidden-soft', !visible);
    }

    // Nút Câu thoại luôn ở dạng icon tối giản (chỉ hiện khung kính khi rê chuột vào),
    // dù khung câu thoại đang mở hay không.
    setTranscriptOpen(open) {
      this.trButton.setAttribute('aria-pressed', String(!!open));
    }

    /**
     * state: { settings, tracks, selected:[id|null,id|null],
     *          trackStatus:[msg,msg], movieStatus:msg }  (msg = null | {key, params})
     */
    update(state) {
      this.lastState = state;
      const { settings, tracks } = state;

      const lang = NDS.lang();
      if (lang !== this.lang) {
        this.lang = lang;
        this._applyLanguage();
      }
      this.langSeg.set(lang);
      this.enabledInput.checked = settings.enabled;

      // Dựng lại option khi danh sách track đổi (đổi phim/tập) hoặc đổi ngôn ngữ.
      const sig = tracks.map((t) => t.id + t.status).join('|');
      if (sig !== this.trackSignature) {
        this.trackSignature = sig;
        for (const select of this.trackSelects) {
          select.textContent = '';
          select.append(h('option', { value: '' }, NDS.t('off')));
          for (const t of tracks) {
            select.append(h('option', { value: t.id, disabled: t.status !== 'text' }, trackLabel(t)));
          }
        }
      }
      this.trackSelects.forEach((select, i) => {
        select.value = state.selected[i] || '';
        this.trackStatus[i].textContent = NDS.tm(state.trackStatus[i]);
      });
      this.movieStatus.textContent = NDS.tm(state.movieStatus);

      const zh = state.zhTracks || [];
      const psig = this.lang + '|' + zh.map((t) => t.id).join('|');
      if (psig !== this.pinyinSignature) {
        this.pinyinSignature = psig;
        this.pinyinSelect.textContent = '';
        this.pinyinSelect.append(h('option', { value: 'auto' }, NDS.t('pinyinAuto')));
        for (const t of zh) this.pinyinSelect.append(h('option', { value: t.id }, trackLabel(t)));
      }
      this.pinyinInput.checked = !!settings.pinyin.enabled;
      this.pinyinSelect.value = state.pinyinValue || 'auto';
      this.pinyinSelect.disabled = !settings.pinyin.enabled;
      this.pinyinStatus.textContent = NDS.tm(state.pinyinStatus);

      const layout = settings.layout;
      const L = this.layoutFields;
      L.avoid.checked = layout.avoidOverlap;
      L.gap.value = String(layout.gap);
      paintSlider(L.gap);
      L.gapValue.textContent = `${layout.gap}px`;
      L.gap.disabled = !layout.avoidOverlap;
      L.lift.checked = layout.liftWithControls;
      this._renderStyleFields();
    }

    _renderStyleFields() {
      if (!this.lastState) return;
      this.styleSeg.set(this.styleTab);
      const s = this.lastState.settings.styles[this.styleTab];
      const f = this.fields;
      f.fontSize.value = String(s.fontSize);
      paintSlider(f.fontSize);
      f.fontSizeValue.textContent = `${s.fontSize}px`;
      f.color.value = s.color;
      f.effect.value = s.effect;
      f.effectColor.value = s.effectColor;
      f.bgEnabled.checked = s.bgEnabled;
      f.bgColor.value = s.bgColor;
      f.bgOpacity.value = String(Math.round(s.bgOpacity * 100));
      paintSlider(f.bgOpacity);
      f.bgOpacityValue.textContent = `${Math.round(s.bgOpacity * 100)}%`;
      f.bgColor.disabled = f.bgOpacity.disabled = !s.bgEnabled;
      f.phonetic.checked = !!s.phonetic;
      // Tab Pinyin: không có mục Furigana.
      this.phoneticCell.style.display = this.styleTab === 2 ? 'none' : '';
    }
  };
})();
