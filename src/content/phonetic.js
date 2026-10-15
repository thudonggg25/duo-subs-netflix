/*
 * phonetic.js — phiên âm cho phụ đề:
 *   - Tiếng Trung (zh, zh-Hans, zh-Hant, yue…): Pinyin có dấu thanh, dùng thư viện pinyin-pro.
 *   - Tiếng Nhật (ja): Furigana (hiragana) trên chữ Kanji, dùng kuromoji để tách từ + lấy cách đọc.
 * Kết quả hiển thị bằng thẻ <ruby>chữ<rt>phiên âm</rt></ruby>.
 * Từ điển tiếng Nhật (~17 MB) chỉ tải khi lần đầu cần; trong lúc tải, chữ hiện bình thường
 * rồi tự vẽ lại khi xong (main.js đăng ký NDS.Phonetic.onReady).
 */
window.NDS = window.NDS || {};

(() => {
  'use strict';
  const NDS = window.NDS;

  const KANJI = /[㐀-鿿豈-﫿々〆ヵヶ]/;
  const CACHE_MAX = 5000;
  const cache = { zh: new Map(), ja: new Map() };

  let jaTokenizer = null;
  let jaLoading = false;
  let jaFailed = false;
  const readyListeners = [];

  const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

  // ---------- Tiếng Trung ----------
  function annotateZh(text) {
    const lib = window.pinyinPro;
    if (!lib) return [{ text }];
    const out = [];
    for (const item of lib.pinyin(text, { type: 'all' })) {
      if (item.isZh && item.pinyin) out.push({ text: item.origin, rt: item.pinyin });
      else if (out.length && !out[out.length - 1].rt) out[out.length - 1].text += item.origin;
      else out.push({ text: item.origin });
    }
    return out;
  }

  // ---------- Tiếng Nhật ----------
  // Tách furigana cho một từ: chỉ đặt phiên âm trên phần Kanji, phần kana (okurigana) giữ nguyên.
  // Ví dụ 食べ過ぎた / タベスギタ → 食[た]べ過[す]ぎた.
  function furiganaToken(surface, reading) {
    if (!KANJI.test(surface) || !reading || reading === '*') return [{ text: surface }];
    const hira = toHira(reading);
    const chunks = [];
    for (const ch of Array.from(surface)) {
      const isK = KANJI.test(ch);
      const last = chunks[chunks.length - 1];
      if (last && last.k === isK) last.t += ch;
      else chunks.push({ k: isK, t: ch });
    }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + chunks.map((c) => (c.k ? '(.+?)' : esc(toHira(c.t)))).join('') + '$');
    const m = re.exec(hira);
    if (!m) return [{ text: surface, rt: hira }];
    let g = 1;
    return chunks.map((c) => (c.k ? { text: c.t, rt: m[g++] } : { text: c.t }));
  }

  function annotateJa(text) {
    if (!jaTokenizer) {
      loadJa();
      return null; // chưa sẵn sàng
    }
    const out = [];
    for (const tk of jaTokenizer.tokenize(text)) {
      for (const seg of furiganaToken(tk.surface_form, tk.reading)) {
        if (!seg.rt && out.length && !out[out.length - 1].rt) out[out.length - 1].text += seg.text;
        else out.push(seg);
      }
    }
    return out;
  }

  function loadJa() {
    if (jaTokenizer || jaLoading || jaFailed || !window.kuromoji) return;
    if (!NDS.extAlive || !NDS.extAlive()) return;
    jaLoading = true;
    // kuromoji ghép đường dẫn bằng path.join nên "chrome-extension://id/..." bị gộp thành
    // "chrome-extension:/id/...". Sửa lại URL ngay trong XMLHttpRequest của content script
    // (chỉ ảnh hưởng thế giới riêng của extension, không đụng tới trang Netflix).
    if (!XMLHttpRequest.prototype.__ndsFixed) {
      const open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (typeof url === 'string') url = url.replace(/^chrome-extension:\/(?!\/)/, 'chrome-extension://');
        return open.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.__ndsFixed = true;
    }
    // ĐIỂM DỄ HỎNG: từ điển phải nằm trong web_accessible_resources của manifest.json.
    const dicPath = chrome.runtime.getURL('src/vendor/kuromoji-dict/');
    window.kuromoji.builder({ dicPath }).build((err, tokenizer) => {
      jaLoading = false;
      if (err) {
        jaFailed = true;
        console.info('[Dual Subs] Không tải được từ điển tiếng Nhật:', err);
        return;
      }
      jaTokenizer = tokenizer;
      readyListeners.forEach((fn) => fn());
    });
  }

  NDS.Phonetic = {
    /** Loại phiên âm theo mã ngôn ngữ của track: 'zh' | 'ja' | null. */
    kind(language) {
      const l = String(language || '').toLowerCase();
      if (/^(zh|cmn|yue)\b/.test(l)) return 'zh';
      if (/^ja\b/.test(l)) return 'ja';
      return null;
    },

    /** Đã sẵn sàng phiên âm cho loại này chưa (tiếng Nhật cần tải từ điển). */
    ready(kind) {
      if (kind === 'ja') {
        if (!jaTokenizer) loadJa();
        return !!jaTokenizer;
      }
      return kind === 'zh' && !!window.pinyinPro;
    },

    onReady(fn) {
      readyListeners.push(fn);
    },

    /** [{text, rt?}] hoặc null nếu chưa sẵn sàng. */
    annotate(text, kind) {
      if (!text || !kind) return null;
      const c = cache[kind];
      if (c.has(text)) return c.get(text);
      let res = null;
      try {
        res = kind === 'zh' ? annotateZh(text) : annotateJa(text);
      } catch (e) {
        console.info('[Dual Subs] Lỗi phiên âm:', e);
        res = [{ text }];
      }
      if (res) {
        if (c.size > CACHE_MAX) c.clear();
        c.set(text, res);
      }
      return res;
    },

    /**
     * Chuyển một dòng chữ Hán thành dòng Pinyin thuần (vd. "你好，世界！" → "nǐ hǎo, shì jiè!"),
     * dùng cho dòng Pinyin riêng trên màn hình. Dấu câu toàn khổ đổi sang dấu Latin.
     */
    pinyinLine(text) {
      const segs = this.annotate(text, 'zh') || [{ text }];
      const PUNCT = { '，': ', ', '。': '. ', '！': '! ', '？': '? ', '：': ': ', '；': '; ', '、': ', ',
        '“': ' "', '”': '" ', '‘': " '", '’': "' ", '（': ' (', '）': ') ', '《': ' «', '》': '» ',
        '「': ' "', '」': '" ', '『': ' "', '』': '" ', '…': '… ', '—': ' — ', '　': ' ' };
      let out = '';
      for (const s of segs) {
        if (s.rt) out += (out && !/[\s("'«]$/.test(out) ? ' ' : '') + s.rt;
        else out += s.text.replace(/[，。！？：；、“”‘’（）《》「」『』…—　]/g, (c) => PUNCT[c]);
      }
      return out.replace(/\s+/g, ' ').replace(/\s+([,.!?:;»)])/g, '$1').trim();
    },

    /** Thêm chữ (có phiên âm nếu được) vào node cha. Trả về true nếu có phiên âm. */
    append(parent, text, kind) {
      const segs = kind ? this.annotate(text, kind) : null;
      if (!segs) {
        parent.appendChild(document.createTextNode(text));
        return false;
      }
      for (const s of segs) {
        if (!s.rt) {
          parent.appendChild(document.createTextNode(s.text));
          continue;
        }
        const ruby = document.createElement('ruby');
        ruby.appendChild(document.createTextNode(s.text));
        const rt = document.createElement('rt');
        rt.textContent = s.rt;
        ruby.appendChild(rt);
        parent.appendChild(ruby);
      }
      return true;
    },
  };
})();
