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
  // pinyin-pro chọn âm cho chữ đa âm theo từ điển cụm từ. Với một số chữ hư từ rất hay gặp trong
  // hội thoại, khi chữ đứng riêng (không nằm trong cụm từ có sẵn) thư viện trả âm mặc định sai
  // (vd. 穿得 → "dé", đúng là "de"). Các luật dưới đây sửa những trường hợp phổ biến nhất.
  const HAN = /[\u3400-\u9fff]/;
  const has = (set, c) => !!c && set.includes(c);
  const DE_PREV_KEEP = '获獲取赢贏难難值心所懂晓曉记記觉覺显顯舍捨免不'; // 获得 dé, 觉得 de… để từ điển quyết
  const DE_NEXT_KEEP = '到以分意罪知手出益逞体體力失奖獎病了'; // 得到, 得分… = dé
  const DE_PRON = '我你他她它您咱俺们們'; // 我得走了 = děi
  const HUAN_NEXT = '钱錢书書债債款给給清'; // 还钱 huán
  const HUAN_PREV = '归歸偿償退交奉送'; // 归还 huán
  const HAI_NEXT = '没沒是有要在会會不很能可得好也都在再'; // 还没 hái
  const ZHE_NEXT_KEEP = '名作称稱述书書急火凉涼迷陆陸手重想落'; // 著名, 着急…
  const ZHE_PREV_KEEP = '显顯土卓巨编編原论論名';
  let zhReady = false;

  function initZh(lib) {
    if (zhReady) return;
    zhReady = true;
    try {
      // Bảng Phồn → Giản giúp tra đúng cụm từ trong phụ đề Phồn thể (vd. 銀行 → yín háng).
      if (window.NDS_ZH_T2S && lib.addTraditionalDict) lib.addTraditionalDict(window.NDS_ZH_T2S);
      if (lib.customPinyin) {
        lib.customPinyin({ 长得: 'zhǎng de', 長得: 'zhǎng de', 长大: 'zhǎng dà', 長大: 'zhǎng dà' });
      }
    } catch (e) {
      console.info('[Dual Subs] Không nạp được dữ liệu Pinyin bổ sung:', e);
    }
  }

  function fixPolyphones(items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.isZh) continue;
      const c = it.origin;
      const prev = items[i - 1] && items[i - 1].isZh ? items[i - 1].origin : '';
      const next = items[i + 1] && items[i + 1].isZh ? items[i + 1].origin : '';
      if (c === '得') {
        if (!prev || has(DE_NEXT_KEEP, next) || has(DE_PREV_KEEP, prev) || it.pinyin === 'de') continue;
        it.pinyin = has(DE_PRON, prev) ? 'děi' : 'de';
      } else if (c === '还' || c === '還') {
        if (has(HUAN_NEXT, next) || has(HUAN_PREV, prev)) it.pinyin = 'huán';
        else if (has(HAI_NEXT, next)) it.pinyin = 'hái';
      } else if (c === '著' || c === '着') {
        // Trợ từ "đang/đã" sau động từ: 看著 kàn zhe; 睡著 shuì zháo.
        if (!prev || has(ZHE_NEXT_KEEP, next) || has(ZHE_PREV_KEEP, prev)) continue;
        it.pinyin = prev === '睡' ? 'zháo' : 'zhe';
      }
    }
    return items;
  }

  function annotateZh(text) {
    const lib = window.pinyinPro;
    if (!lib) return [{ text }];
    initZh(lib);
    const out = [];
    for (const item of fixPolyphones(lib.pinyin(text, { type: 'all', traditional: true }))) {
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
