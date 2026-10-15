/*
 * overlay.js — lớp hiển thị các khối phụ đề phủ lên player:
 *   khối 0 = Phụ đề 1, khối 1 = Phụ đề 2, khối 2 = dòng Pinyin riêng.
 *
 * - Vị trí mỗi khối = điểm GIỮA-ĐÁY của khối, lưu theo % chiều rộng/chiều cao
 *   player, nên giữ đúng chỗ khi đổi cỡ cửa sổ hoặc vào/ra fullscreen.
 * - Kéo thả có đường căn (giữa màn hình, thẳng hàng với phụ đề kia, cách đều)
 *   và "hít" (snap) vào các đường đó. Giữ Alt khi kéo để tắt hít.
 * - Mỗi khối kéo riêng. Chế độ "tự tránh chồng chữ": nếu các khối sắp đè lên
 *   nhau (vd. câu dài 2 dòng), khối KHÔNG vừa được kéo sẽ bị đẩy ra, cách `gap`.
 * - Đổi cỡ chữ ngay trên màn hình: cuộn chuột trên phụ đề.
 */
window.NDS = window.NDS || {};

(() => {
  'use strict';
  const NDS = window.NDS;

  const BASE_HEIGHT = 720; // fontSize/gap trong cài đặt tính cho player cao 720px
  const SNAP_PX = 10; // khoảng cách (px màn hình) để "hít" vào đường căn
  const FONT_MIN = 12;
  const FONT_MAX = 64;
  const BLOCKS = [0, 1, 2];
  const PINYIN_BLOCK = 2;

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const round1 = (v) => Math.round(v * 10) / 10;

  // Chặn sự kiện chuột lan tới player của Netflix (click = pause, dblclick = fullscreen).
  NDS.swallowPointerEvents = function (el) {
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  };

  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  // Viền chữ giả lập bằng nhiều text-shadow (đẹp hơn -webkit-text-stroke, không ăn vào nét chữ).
  function buildTextShadow(effect, color, fontPx) {
    const w = Math.max(1, Math.round(fontPx * 0.06));
    if (effect === 'outline') {
      const shadows = [];
      for (let a = 0; a < 360; a += 45) {
        const rad = (a * Math.PI) / 180;
        shadows.push(`${(Math.cos(rad) * w).toFixed(1)}px ${(Math.sin(rad) * w).toFixed(1)}px 0 ${color}`);
      }
      return shadows.join(', ');
    }
    if (effect === 'shadow') {
      return `${w}px ${w}px ${w * 2}px ${color}, 0 0 ${w * 2}px ${color}`;
    }
    return 'none';
  }

  function div(className, parent) {
    const el = document.createElement('div');
    el.className = className;
    if (parent) parent.appendChild(el);
    return el;
  }

  NDS.Overlay = class {
    /**
     * handlers: {
     *   onPositionChange(idx, {x, y}),  // idx = khối được lưu vị trí
     *   onFontSize(idx, size)
     * }
     */
    constructor(handlers) {
      this.handlers = handlers;
      this.preview = false; // hiện chữ mẫu khi mở panel để dễ kéo đặt vị trí
      this.keys = BLOCKS.map(() => null); // tránh vẽ lại khi cue không đổi
      this.phonetic = BLOCKS.map(() => null);
      this.styles = NDS.DEFAULT_STYLES;
      this.layoutCfg = NDS.DEFAULT_LAYOUT;
      this.playerHeight = BASE_HEIGHT;
      this.drag = null; // trạng thái kéo đang diễn ra
      this.hovering = 0; // số khối đang có chuột rê lên
      this.lastMoved = null; // phụ đề vừa được kéo gần nhất (được giữ nguyên khi tránh chồng)
      this.lift = 0;
      this.readoutTimer = null;

      this.el = div('nds-layer');

      // Đường căn: 2 đường giữa (mờ, chỉ hiện khi kéo) + 2 đường "đang hít" (sáng).
      this.guideCenterV = div('nds-guide nds-guide-v nds-guide-center', this.el);
      this.guideCenterH = div('nds-guide nds-guide-h nds-guide-center', this.el);
      this.guideSnapV = div('nds-guide nds-guide-v nds-guide-snap', this.el);
      this.guideSnapH = div('nds-guide nds-guide-h nds-guide-snap', this.el);
      this.readout = div('nds-readout', this.el); // hiện toạ độ / cỡ chữ khi chỉnh

      this.blocks = BLOCKS.map((idx) => {
        const block = div('nds-block nds-empty' + (idx === PINYIN_BLOCK ? ' nds-block-pinyin' : ''), this.el);
        block.dataset.idx = String(idx);
        const content = div('nds-content', block);
        NDS.swallowPointerEvents(block);
        this._enableDrag(block, idx);
        this._enableWheel(block, idx);
        block.addEventListener('dblclick', () => this._centerHorizontally(idx));
        block.addEventListener('pointerenter', () => this.hovering++);
        block.addEventListener('pointerleave', () => (this.hovering = Math.max(0, this.hovering - 1)));
        return { el: block, content };
      });
      this.applyLanguage();
    }

    /** Cập nhật chữ tooltip theo ngôn ngữ giao diện. */
    applyLanguage() {
      this.blocks.forEach((b) => {
        b.el.title = NDS.t('blockTitle');
      });
      this.keys = BLOCKS.map(() => null); // vẽ lại chữ mẫu (preview) theo ngôn ngữ mới
    }

    /** Người dùng đang thao tác trên phụ đề (kéo hoặc rê chuột) → không được làm phụ đề nhảy. */
    get isBusy() {
      return !!this.drag || this.hovering > 0;
    }

    setPreview(on) {
      this.preview = on;
      this.keys = BLOCKS.map(() => null); // buộc vẽ lại
    }

    /** Nhận cài đặt mới (kiểu chữ, bố cục, chiều cao player) và áp dụng. */
    setModel(styles, layoutCfg, playerHeight) {
      this.styles = styles;
      this.layoutCfg = layoutCfg;
      this.playerHeight = playerHeight || BASE_HEIGHT;
      styles.forEach((style, idx) => this._applyStyle(idx, style));
      this.layout();
    }

    /** Dịch cả lớp phụ đề lên trên (khi thanh điều khiển Netflix hiện), tính theo %. */
    setLift(percent) {
      if (percent === this.lift || this.isBusy) return; // giữ nguyên khi chuột đang ở trên phụ đề
      this.lift = percent;
      this.el.style.transform = percent ? `translateY(-${percent}%)` : '';
    }

    /** Đáy thấp nhất (%) của các khối đang hiển thị, để biết có bị thanh điều khiển che không. */
    lowestBottom() {
      let max = 0;
      this.blocks.forEach((b) => {
        if (!b.el.classList.contains('nds-empty')) max = Math.max(max, parseFloat(b.el.style.top) || 0);
      });
      return max;
    }

    /**
     * Kiểu phiên âm cho khối idx:
     *   'zh' = Pinyin nhỏ trên chữ Hán · 'ja' = Furigana trên Kanji ·
     *   'pinyinLine' = cả dòng đổi thành Pinyin (khối Pinyin riêng) · null = không.
     */
    setPhonetic(idx, kind) {
      this.phonetic[idx] = kind || null;
    }

    /**
     * Vẽ khối idx từ danh sách cue và chỉ số cue đang hoạt động.
     * allowPreview: chỉ hiện chữ mẫu cho phụ đề đang được chọn (không phải "Tắt").
     */
    render(idx, cues, activeIdx, allowPreview = false) {
      const usePreview = this.preview && allowPreview && activeIdx.length === 0;
      const kind = this.phonetic[idx];
      const ready = kind ? NDS.Phonetic.ready(kind === 'pinyinLine' ? 'zh' : kind) : false;
      const key = (usePreview ? 'preview' : activeIdx.join(',')) + '|' + kind + '|' + ready;
      if (key === this.keys[idx]) return;
      this.keys[idx] = key;

      let lines = [];
      if (cues) for (const i of activeIdx) lines.push(...cues[i].lines);
      if (usePreview) {
        const text = idx === PINYIN_BLOCK ? NDS.t('previewPinyin') : NDS.t('preview', { n: idx + 1 });
        lines = [[{ text, italic: false }]];
      }

      const { el, content } = this.blocks[idx];
      content.textContent = '';
      for (const line of lines) {
        const row = div('nds-row', content);
        const span = document.createElement('span');
        span.className = 'nds-line';
        if (kind === 'pinyinLine' && !usePreview) {
          // Dòng Pinyin riêng: ghép cả dòng rồi phiên âm (giữ ngữ cảnh để đọc đúng từ đa âm).
          span.textContent = NDS.Phonetic.pinyinLine(line.map((seg) => seg.text).join(''));
          row.appendChild(span);
          continue;
        }
        for (const seg of line) {
          // Dùng createTextNode / thẻ ruby, không dùng innerHTML (an toàn với ký tự đặc biệt).
          const target = seg.italic ? span.appendChild(document.createElement('i')) : span;
          if (kind && ready && !usePreview) NDS.Phonetic.append(target, seg.text, kind);
          else target.appendChild(document.createTextNode(seg.text));
        }
        row.appendChild(span);
      }
      el.classList.toggle('nds-empty', lines.length === 0);
      // Chiều cao khối đổi → kiểm tra lại việc tránh chồng chữ.
      if (this.layoutCfg.avoidOverlap) this.layout();
    }

    clear() {
      BLOCKS.forEach((idx) => this.render(idx, null, []));
    }

    _applyStyle(idx, style) {
      const block = this.blocks[idx].el;
      const fontPx = (style.fontSize * this.playerHeight) / BASE_HEIGHT;
      block.style.setProperty('--nds-font-size', `${fontPx.toFixed(1)}px`);
      block.style.setProperty('--nds-color', style.color);
      block.style.setProperty('--nds-shadow', buildTextShadow(style.effect, style.effectColor, fontPx));
      block.style.setProperty(
        '--nds-bg',
        style.bgEnabled ? hexToRgba(style.bgColor, style.bgOpacity) : 'transparent'
      );
    }

    // ---------- Bố cục ----------

    _visible(idx) {
      return !this.blocks[idx].el.classList.contains('nds-empty');
    }

    _heightPct(idx) {
      const h = this.el.clientHeight || this.playerHeight;
      return (this.blocks[idx].el.offsetHeight / h) * 100;
    }

    _widthPct(idx) {
      const w = this.el.clientWidth || 1;
      return (this.blocks[idx].el.offsetWidth / w) * 100;
    }

    _gapPct() {
      const h = this.el.clientHeight || this.playerHeight;
      return ((this.layoutCfg.gap * this.playerHeight) / BASE_HEIGHT / h) * 100;
    }

    /** Vị trí hiện hành (kể cả đang kéo) của khối idx. */
    _positionOf(idx) {
      if (this.drag && this.drag.pos && this.drag.idx === idx) return this.drag.pos;
      return this.styles[idx].position;
    }

    /** Các khối đang hiện, trừ idx. */
    _others(idx) {
      return BLOCKS.filter((i) => i !== idx && this._visible(i));
    }

    /**
     * Đặt các khối theo vị trí đã lưu; nếu bật tránh chồng chữ thì đẩy các khối khác ra.
     * Khối đang kéo / vừa kéo được giữ nguyên; nếu chưa kéo lần nào thì giữ khối nằm thấp nhất.
     * Các khối còn lại xếp lần lượt (gần khối cố định trước), mỗi khối né mọi khối đã xếp.
     */
    layout() {
      const pos = BLOCKS.map((i) => ({ ...this._positionOf(i) }));
      const vis = BLOCKS.filter((i) => this._visible(i));
      if (this.layoutCfg.avoidOverlap && vis.length >= 2) {
        let fixed = this.drag ? this.drag.idx : this.lastMoved;
        if (fixed == null || !vis.includes(fixed)) fixed = vis.reduce((a, b) => (pos[b].y > pos[a].y ? b : a));
        const gap = this._gapPct();
        const h = BLOCKS.map((i) => this._heightPct(i));
        const w = BLOCKS.map((i) => this._widthPct(i));
        const placed = [fixed];
        const rest = vis
          .filter((i) => i !== fixed)
          .sort((a, b) => Math.abs(pos[a].y - pos[fixed].y) - Math.abs(pos[b].y - pos[fixed].y));
        for (const i of rest) {
          for (let pass = 0; pass < 3; pass++) {
            let moved = false;
            for (const j of placed) {
              if (Math.abs(pos[i].x - pos[j].x) >= (w[i] + w[j]) / 2) continue; // khác cột
              const topI = pos[i].y - h[i];
              const topJ = pos[j].y - h[j];
              if (pos[i].y <= topJ - gap || topI >= pos[j].y + gap) continue; // đã đủ cách
              // Khối i nằm trên (hoặc ngang) khối j → đẩy lên; nằm dưới → đẩy xuống.
              pos[i].y = pos[i].y <= pos[j].y ? topJ - gap : pos[j].y + gap + h[i];
              moved = true;
            }
            if (!moved) break;
          }
          placed.push(i);
        }
      }
      BLOCKS.forEach((i) => this._place(i, pos[i]));
    }

    /** Vị trí đang hiển thị trên màn hình (sau khi tránh chồng chữ). */
    _displayed(idx) {
      const st = this.blocks[idx].el.style;
      const p = this.styles[idx].position;
      return { x: parseFloat(st.left) || p.x, y: parseFloat(st.top) || p.y };
    }

    _place(idx, pos) {
      this.blocks[idx].el.style.left = `${pos.x}%`;
      this.blocks[idx].el.style.top = `${pos.y}%`;
    }

    _showReadout(text, autoHide) {
      this.readout.textContent = text;
      this.readout.classList.add('nds-show');
      clearTimeout(this.readoutTimer);
      if (autoHide) this.readoutTimer = setTimeout(() => this.readout.classList.remove('nds-show'), 900);
    }

    // ---------- Kéo thả + căn chỉnh ----------

    // Hít vào đường căn gần nhất. Trả về toạ độ đã chỉnh + đường căn cần vẽ.
    _snap(idx, x, y, rect) {
      const tx = (SNAP_PX / rect.width) * 100;
      const ty = (SNAP_PX / rect.height) * 100;
      let gv = null;
      let gh = null;
      let note = '';

      const others = this._others(idx);
      // Ngang: giữa màn hình, hoặc thẳng hàng với khối khác.
      if (Math.abs(x - 50) < tx) {
        x = 50;
        gv = 50;
        note = NDS.t('snapCenter');
      } else {
        for (const o of others) {
          const ox = this._displayed(o).x;
          if (Math.abs(x - ox) < tx) {
            x = ox;
            gv = ox;
            note = NDS.t('snapAlign');
            break;
          }
        }
      }

      // Dọc: cách khối khác đúng khoảng "gap" (đặt trên hoặc dưới), hoặc giữa màn hình.
      const gap = this._gapPct();
      outer: for (const o of others) {
        const other = this._displayed(o);
        const above = other.y - this._heightPct(o) - gap; // khối này nằm trên
        const below = other.y + gap + this._heightPct(idx); // khối này nằm dưới
        for (const c of [above, below]) {
          if (Math.abs(y - c) < ty) {
            y = c;
            gh = c;
            note += (note ? ', ' : '') + NDS.t('snapGap');
            break outer;
          }
        }
      }
      if (gh === null && Math.abs(y - 50) < ty) {
        y = 50;
        gh = 50;
      }
      return { x, y, gv, gh, note };
    }

    _showSnapGuides(gv, gh) {
      this.guideSnapV.style.display = gv === null ? 'none' : 'block';
      this.guideSnapH.style.display = gh === null ? 'none' : 'block';
      if (gv !== null) this.guideSnapV.style.left = `${gv}%`;
      if (gh !== null) this.guideSnapH.style.top = `${gh}%`;
    }

    _enableDrag(block, idx) {
      block.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // Bắt đầu từ vị trí đang HIỂN THỊ (có thể đã bị đẩy để tránh chồng) để chữ không nhảy.
        const orig = this._displayed(idx);
        this.drag = {
          id: e.pointerId,
          idx,
          startX: e.clientX,
          startY: e.clientY,
          origX: orig.x,
          origY: orig.y,
          rect: this.el.getBoundingClientRect(),
          pos: null,
        };
        block.setPointerCapture(e.pointerId);
        block.classList.add('nds-dragging');
        this.el.classList.add('nds-layer-dragging');
      });

      block.addEventListener('pointermove', (e) => {
        const d = this.drag;
        if (!d || e.pointerId !== d.id) return;
        const rawX = d.origX + ((e.clientX - d.startX) / d.rect.width) * 100;
        const rawY = d.origY + ((e.clientY - d.startY) / d.rect.height) * 100;
        let s = { x: rawX, y: rawY, gv: null, gh: null, note: '' };
        if (!e.altKey) s = this._snap(idx, rawX, rawY, d.rect);
        d.pos = { x: round1(clamp(s.x, 0, 100)), y: round1(clamp(s.y, 3, 100)) };
        this._showSnapGuides(s.gv, s.gh);
        this._showReadout(
          NDS.t('readoutPos', d.pos) + (s.note ? ' · ' + s.note : ''),
          false
        );
        this.layout();
      });

      const end = (e) => {
        const d = this.drag;
        if (!d || e.pointerId !== d.id) return;
        block.classList.remove('nds-dragging');
        this.el.classList.remove('nds-layer-dragging');
        this._showSnapGuides(null, null);
        this.readout.classList.remove('nds-show');
        this.drag = null;
        if (d.pos) {
          this.lastMoved = idx;
          this.handlers.onPositionChange(idx, d.pos);
        } else this.layout();
      };
      block.addEventListener('pointerup', end);
      block.addEventListener('pointercancel', end);
    }

    _centerHorizontally(idx) {
      this.lastMoved = idx;
      this.handlers.onPositionChange(idx, { x: 50, y: this._displayed(idx).y });
      this._showReadout(NDS.t('centered'), true);
    }

    // ---------- Đổi cỡ chữ ngay trên màn hình ----------

    _setFont(idx, size) {
      const next = clamp(Math.round(size), FONT_MIN, FONT_MAX);
      if (next !== this.styles[idx].fontSize) this.handlers.onFontSize(idx, next);
      this._showReadout(
        idx === PINYIN_BLOCK ? NDS.t('fontReadoutPinyin', { size: next }) : NDS.t('fontReadout', { n: idx + 1, size: next }),
        true
      );
    }

    _enableWheel(block, idx) {
      block.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._setFont(idx, this.styles[idx].fontSize + (e.deltaY < 0 ? 1 : -1));
        },
        { passive: false }
      );
    }
  };
})();
