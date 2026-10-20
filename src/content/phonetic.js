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
  const ZHE_ZHAO_PREV = '睡找猜见見'; // 睡着/找着 = zháo
  const DEI_PREV = '还還也就都又'; // 还得等, 就得走 = děi (trừ khi theo sau là 了/到)
  const PRON = '我你他她您咱们們';
  const GAN_NEXT = '得嘛吗嗎活'; // 干得好, 干嘛 = gàn
  const SHU_NEXT = '到一数數'; // 数到三, 数一数 = shǔ
  const ER_NOT_PREV = '女婴嬰孤幼健胎侄姪孙孫小男'; // 女儿, 婴儿 = ér (không phải âm cuốn lưỡi)
  const ER_NOT_NEXT = '子童女孙孫歌科'; // 儿子, 儿童 = ér
  const ZHONG_PREV = '说說猜打射命'; // 说中了, 打中 = zhòng (chỉ khi đứng cuối câu hoặc trước 了)
  const ZHI_MEASURE_PREV = '一二两兩三四五六七八九十几幾这這那哪每半船'; // 一只猫 zhī; còn lại 只 = zhǐ
  const DAO_NEXT = '是杯水茶酒车車退'; // 倒是, 倒水, 倒车 = dào
  const YI_MEASURE = '个個层層张張件本次天年点點些下样樣位只隻杯碗份句遍条條起定切直会會';
  let zhReady = false;
  let zhDictState = 'idle'; // idle | loading | done | failed

  // Từ điển cụm từ bổ sung (~20.000 cụm, lấy từ @pinyin-pro/data, chỉ giữ những cụm mà thư viện gốc
  // đọc khác). Tải lần đầu khi cần Pinyin; trong lúc tải dùng kết quả gốc, xong thì vẽ lại.
  function loadZhDict(lib) {
    if (zhDictState !== 'idle' || !lib.addDict || !NDS.extAlive || !NDS.extAlive()) return;
    zhDictState = 'loading';
    fetch(chrome.runtime.getURL('src/vendor/pinyin-pro-dict.json'))
      .then((r) => r.json())
      .then((dict) => {
        lib.addDict(dict, 'nds-phrases');
        zhDictState = 'done';
        cache.zh.clear();
        readyListeners.forEach((fn) => fn());
      })
      .catch((e) => {
        zhDictState = 'failed';
        console.info('[Dual Subs] Không tải được từ điển Pinyin bổ sung:', e);
      });
  }

  function initZh(lib) {
    if (zhReady) return;
    zhReady = true;
    try {
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
      const prev2 = items[i - 2] && items[i - 2].isZh ? items[i - 2].origin : '';
      if (c === '得') {
        if (!prev || has(DE_NEXT_KEEP, next) || has(DE_PREV_KEEP, prev) || it.pinyin === 'de') continue;
        if (has(DE_PRON, prev) || (has(DEI_PREV, prev) && next && next !== '了')) it.pinyin = 'děi';
        else it.pinyin = 'de';
      } else if (c === '还' || c === '還') {
        const next2 = items[i + 2] && items[i + 2].isZh ? items[i + 2].origin : '';
        if (has(HUAN_NEXT, next) || has(HUAN_PREV, prev)) it.pinyin = 'huán';
        else if (has('我你他她您', next) && next2 !== '妈' && next2 !== '媽' && next2 !== '们' && next2 !== '們') it.pinyin = 'huán';
        else if (has(HAI_NEXT, next)) it.pinyin = 'hái';
      } else if (c === '著' || c === '着') {
        // Trợ từ "đang/đã" sau động từ: 看著 kàn zhe; 睡著 shuì zháo.
        if (next === '装' || next === '裝') { it.pinyin = 'zhuó'; continue; }
        if (!prev || has(ZHE_NEXT_KEEP, next) || has(ZHE_PREV_KEEP, prev)) continue;
        it.pinyin = has(ZHE_ZHAO_PREV, prev) && (!next || next === '了') ? 'zháo' : 'zhe';
      } else if (c === '了') {
        // 了 cuối câu là trợ từ "le" (受不了了 → liǎo le), trừ 受不了 / 得了 (liǎo).
        if (!next && prev && !has('不得', prev)) it.pinyin = 'le';
      } else if (c === '地') {
        // Trạng từ láy + 地: 慢慢地 màn màn de.
        if (prev && prev === prev2) it.pinyin = 'de';
      } else if (c === '干' || c === '幹') {
        // 干得好, 干嘛; 谁干的 / 你干的 = gàn
        if (has(GAN_NEXT, next) || (next === '的' && has('谁誰你我他她们們', prev))) it.pinyin = 'gàn';
      } else if (c === '数' || c === '數') {
        if (has(SHU_NEXT, next) && it.pinyin === 'shù') it.pinyin = 'shǔ';
      } else if (c === '儿' || c === '兒') {
        // Âm cuốn lưỡi: 哪儿 nǎr, 一会儿 yí huìr → ghi "r" và ghép vào âm trước khi hiện thành dòng.
        if (prev && !has(ER_NOT_PREV, prev) && !has(ER_NOT_NEXT, next)) it.pinyin = 'r';
      } else if (c === '只' && (it.pinyin === 'zhī' || it.pinyin === 'zhǐ')) {
        it.pinyin = has(ZHI_MEASURE_PREV, prev) ? 'zhī' : 'zhǐ';
      } else if (c === '倒') {
        if (has(DAO_NEXT, next)) it.pinyin = 'dào';
      } else if (c === '教') {
        if (has(PRON, next)) it.pinyin = 'jiāo';
      } else if (c === '中') {
        if (has(ZHONG_PREV, prev) && (!next || next === '了')) it.pinyin = 'zhòng';
      } else if (c === '一') {
        // Biến điệu của 一 trước lượng từ: 一个 yí gè, 一层 yì céng.
        const nx = items[i + 1];
        if (has(YI_MEASURE, next) && nx && nx.pinyin && !has('第初', prev)) {
          it.pinyin = /[àèìòùǜ]/.test(nx.pinyin) ? 'yí' : 'yì';
        }
      }
    }
    return items;
  }

  function annotateZh(text) {
    const lib = window.pinyinPro;
    if (!lib) return [{ text }];
    initZh(lib);
    if (zhDictState === 'idle') loadZhDict(lib);
    const out = [];
    // Đổi Phồn → Giản từng chữ trước khi tra (1 chữ ↔ 1 chữ nên vị trí giữ nguyên), rồi hiện lại chữ gốc.
    // Cách này đúng hơn tùy chọn traditional của thư viện (vd. 們 bị đọc "mén" thay vì "men").
    const t2s = window.NDS_ZH_T2S;
    const chars = Array.from(text);
    const simp = t2s ? chars.map((c) => t2s[c] || c).join('') : text;
    const items = fixPolyphones(lib.pinyin(simp, { type: 'all' }));
    let pos = 0;
    for (const it of items) {
      const n = Array.from(it.origin).length;
      it.origin = chars.slice(pos, pos + n).join('');
      pos += n;
    }
    for (const item of items) {
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
        if (s.rt === 'r' && /[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]$/.test(out)) out += 'r';
        else if (s.rt) out += (out && !/[\s("'«]$/.test(out) ? ' ' : '') + s.rt;
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
