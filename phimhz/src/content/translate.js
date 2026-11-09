/*
 * translate.js — dịch một track phụ đề sang tiếng Việt bằng Claude (qua background.js).
 *
 * - Mỗi tập dịch một lần: kết quả lưu ở chrome.storage.local theo mã băm của phụ đề gốc.
 * - Bảng nhân vật (tên, giới tính, xưng hô) lưu theo tên phim, dùng chung cho mọi tập.
 * - Dịch theo đoạn 80 câu, bắt đầu từ đoạn đang xem, rồi tới các đoạn sau, cuối cùng
 *   các đoạn trước; mỗi đoạn có toàn bộ phụ đề gốc làm ngữ cảnh (được cache phía API).
 */
window.PHZ = window.PHZ || {};

(() => {
  'use strict';
  const PHZ = window.PHZ;

  const CHUNK = 80;
  const PROMPT_VERSION = 1; // tăng khi đổi prompt để không dùng lại bản dịch cũ
  const TR_PREFIX = 'phz.tr.';
  const GL_PREFIX = 'phz.gl.';

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const fmt = (t) => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(1).padStart(4, '0');
    return `${h}:${String(m).padStart(2, '0')}:${s}`;
  };

  PHZ.slug = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  // Đoán tên phim (không kèm tên tập) từ tiêu đề trang.
  PHZ.guessSeries = function (title) {
    let t = String(title || '');
    t = t.replace(/\s*[|–-]\s*(Disney\+|HBO Max|Max|Prime Video|Amazon.*|Apple TV\+?)\s*$/i, '');
    t = t.replace(/^(Watch|Xem)\s+/i, '');
    t = t.split(/\s*:\s*S\d|\s+S\d+\s*[:·.]?\s*E\d|\s*[:|]\s*(Season|Mùa|Episode|Tập)\b/i)[0];
    return t.trim();
  };

  function send(msg) {
    return chrome.runtime.sendMessage(msg).then((res) => {
      if (!res || !res.ok) throw new Error((res && res.error) || 'Không có phản hồi từ extension');
      return res;
    });
  }

  class Translator {
    constructor() {
      this.reset();
      this.listeners = [];
    }

    reset() {
      this.key = null;
      this.source = null; // cues gốc
      this.results = new Map(); // i -> {vi, tm, g}
      this.status = 'idle'; // idle | running | done | error | stopped
      this.error = null;
      this.glossary = '';
      this.series = '';
      this.lang = '';
      this.running = false;
      this.stopFlag = false;
      this.cost = { input: 0, output: 0, cacheRead: 0 };
      this._cues = null;
    }

    onChange(fn) {
      this.listeners.push(fn);
    }

    emit() {
      this._cues = null;
      this._narration = null;
      for (const fn of this.listeners) fn();
    }

    get progress() {
      return { done: this.results.size, total: this.source ? this.source.length : 0 };
    }

    // Cue tiếng Việt để hiển thị (chỉ những câu đã dịch).
    cues() {
      if (!this._cues && this.source) {
        this._cues = [];
        this.source.forEach((c, i) => {
          const r = this.results.get(i);
          if (r && r.vi) {
            this._cues.push({
              start: c.start,
              end: c.end,
              lines: r.vi.split('\n').map((text) => [{ text, italic: false }]),
            });
          }
        });
      }
      return this._cues || [];
    }

    // Lời thuyết minh: {start, end, text, g} theo thứ tự thời gian.
    narration() {
      if (!this.source) return [];
      if (!this._narration) {
        this._narration = [];
        this.source.forEach((c, i) => {
          const r = this.results.get(i);
          if (r && r.tm && r.tm.trim()) this._narration.push({ start: c.start, end: c.end, text: r.tm.trim(), g: r.g || '' });
        });
      }
      return this._narration;
    }

    // Gắn với một track gốc; nạp bản dịch đã lưu nếu có.
    async attach(cues, { series, lang, model }) {
      const key = await sha256(
        [PROMPT_VERSION, model, cues.map((c) => c.start.toFixed(2) + PHZ.cueText(c)).join('\n')].join('|')
      );
      if (key === this.key) return;
      this.stopFlag = true;
      this.reset();
      this.key = key;
      this.source = cues;
      this.series = series;
      this.lang = lang;
      const got = await chrome.storage.local.get([TR_PREFIX + key, GL_PREFIX + PHZ.slug(series)]);
      const saved = got[TR_PREFIX + key];
      if (saved && saved.lines) {
        for (const [i, r] of Object.entries(saved.lines)) this.results.set(+i, r);
        if (this.results.size >= cues.length) this.status = 'done';
      }
      this.glossary = got[GL_PREFIX + PHZ.slug(series)] || '';
      this.emit();
    }

    async setSeries(name) {
      this.series = name;
      const k = GL_PREFIX + PHZ.slug(name);
      const got = await chrome.storage.local.get(k);
      this.glossary = got[k] || '';
      this.emit();
    }

    async saveGlossary(text) {
      this.glossary = text;
      await chrome.storage.local.set({ [GL_PREFIX + PHZ.slug(this.series)]: text });
      this.emit();
    }

    async save() {
      const lines = {};
      for (const [i, r] of this.results) lines[i] = r;
      await chrome.storage.local.set({
        [TR_PREFIX + this.key]: { lines, series: this.series, savedAt: Date.now() },
      });
    }

    transcript() {
      return this.source.map((c, i) => `#${i} [${fmt(c.start)}–${fmt(c.end)}] ${PHZ.cueText(c).replace(/\n/g, ' / ')}`).join('\n');
    }

    addUsage(u) {
      if (!u) return;
      this.cost.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      this.cost.cacheRead += u.cache_read_input_tokens || 0;
      this.cost.output += u.output_tokens || 0;
    }

    stop() {
      this.stopFlag = true;
      if (this.running) {
        this.status = 'stopped';
        this.emit();
      }
    }

    // Thứ tự đoạn: đoạn chứa thời điểm đang xem, các đoạn sau, rồi các đoạn trước.
    plan(now) {
      const n = this.source.length;
      const chunks = [];
      for (let a = 0; a < n; a += CHUNK) chunks.push([a, Math.min(n, a + CHUNK) - 1]);
      let first = chunks.findIndex(([, b]) => this.source[b].end > now);
      if (first < 0) first = 0;
      const order = chunks.slice(first).concat(chunks.slice(0, first).reverse());
      return order.filter(([a, b]) => {
        for (let i = a; i <= b; i++) if (!this.results.has(i)) return true;
        return false;
      });
    }

    async run(now) {
      if (this.running || !this.source || this.status === 'done') return;
      const key = this.key;
      this.running = true;
      this.stopFlag = false;
      this.status = 'running';
      this.error = null;
      this.emit();
      const transcript = this.transcript();
      const base = { series: this.series, lang: this.lang, transcript };
      try {
        if (!this.glossary.trim()) {
          this.phase = 'Đang lập bảng nhân vật';
          this.emit();
          const res = await send({ type: 'PHZ_GLOSSARY', ...base });
          this.addUsage(res.usage);
          if (this.key !== key) return;
          await this.saveGlossary(res.glossary);
        }
        for (const [a, b] of this.plan(now)) {
          if (this.stopFlag || this.key !== key) return;
          this.phase = `Đang dịch câu ${a + 1}–${b + 1}`;
          this.emit();
          await this.translateRange(a, b, base, key);
        }
        if (this.key === key && this.results.size >= this.source.length) this.status = 'done';
      } catch (e) {
        if (this.key === key) {
          this.status = 'error';
          this.error = e.message;
        }
      } finally {
        if (this.key === key) {
          this.running = false;
          this.phase = '';
          if (this.status === 'running') this.status = 'stopped';
          this.emit();
        }
      }
    }

    async translateRange(a, b, base, key) {
      // Tối đa 2 lần: lần sau chỉ dịch lại các câu bị thiếu.
      for (let attempt = 0; attempt < 2; attempt++) {
        const missing = [];
        for (let i = a; i <= b; i++) if (!this.results.has(i)) missing.push(i);
        if (!missing.length) return;
        const from = missing[0];
        const to = missing[missing.length - 1];
        const previous = [];
        for (let i = from - 1; i >= 0 && previous.length < 8; i--) {
          const r = this.results.get(i);
          if (r) previous.unshift({ i, vi: r.vi });
        }
        const res = await send({ type: 'PHZ_TRANSLATE', ...base, glossary: this.glossary, from, to, previous });
        if (this.key !== key) return;
        this.addUsage(res.usage);
        for (const line of res.lines || []) {
          if (Number.isInteger(line.i) && line.i >= from && line.i <= to && typeof line.vi === 'string') {
            this.results.set(line.i, { vi: line.vi.trim(), tm: (line.tm || '').trim(), g: line.g || '' });
          }
        }
        await this.save();
        this.emit();
      }
    }
  }

  PHZ.Translator = Translator;
})();
