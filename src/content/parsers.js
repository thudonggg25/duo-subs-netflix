/*
 * parsers.js — chuyển file phụ đề (TTML/DFXP hoặc WebVTT) thành danh sách cue.
 *
 * Định dạng cue chung:
 *   { start: giây, end: giây, lines: [ [ {text, italic}, ... ], ... ] }
 * Mỗi phần tử của `lines` là một dòng, gồm nhiều đoạn (để giữ chữ nghiêng).
 */
window.NDS = window.NDS || {};

(() => {
  'use strict';
  const NDS = window.NDS;

  // ===================== TTML / DFXP =====================

  // Lấy thuộc tính theo localName, bất kể prefix namespace (ttp:, tts:, ...).
  function attrLocal(el, localName) {
    for (const a of el.attributes) {
      if (a.localName === localName) return a.value;
    }
    return null;
  }

  // Đọc tham số thời gian từ thẻ gốc <tt>.
  function readTimingParams(root) {
    const frameRate = parseFloat(attrLocal(root, 'frameRate')) || 30;
    const multAttr = attrLocal(root, 'frameRateMultiplier');
    let frameRateMultiplier = 1;
    if (multAttr) {
      const [num, den] = multAttr.split(/\s+/).map(Number);
      if (num && den) frameRateMultiplier = num / den;
    }
    const subFrameRate = parseFloat(attrLocal(root, 'subFrameRate')) || 1;
    const effectiveFrameRate = frameRate * frameRateMultiplier;
    // Theo chuẩn TTML: nếu không khai báo tickRate thì = frameRate * subFrameRate
    // (khi có frameRate), ngược lại = 1. Netflix thường dùng ttp:tickRate="10000000".
    let tickRate = parseFloat(attrLocal(root, 'tickRate'));
    if (!tickRate) {
      tickRate = attrLocal(root, 'frameRate') ? frameRate * subFrameRate : 1;
    }
    return { tickRate, frameRate: effectiveFrameRate, subFrameRate };
  }

  // Chuyển biểu thức thời gian TTML sang giây.
  function parseTTMLTime(str, p) {
    if (!str) return null;
    str = str.trim();
    // Dạng offset: "123456t", "12.5s", "500ms", "1.5h", "2m", "100f"
    let m = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(str);
    if (m) {
      const v = parseFloat(m[1]);
      switch (m[2]) {
        case 'h': return v * 3600;
        case 'm': return v * 60;
        case 's': return v;
        case 'ms': return v / 1000;
        case 'f': return v / p.frameRate;
        case 't': return v / p.tickRate;
      }
    }
    // Dạng đồng hồ: "HH:MM:SS(.mmm)" hoặc "HH:MM:SS:FF(.sub)"
    m = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+)|:(\d+)(?:\.(\d+))?)?$/.exec(str);
    if (m) {
      let t = +m[1] * 3600 + +m[2] * 60 + +m[3];
      if (m[4]) t += parseFloat('0.' + m[4]);
      if (m[5]) t += +m[5] / p.frameRate;
      if (m[6]) t += +m[6] / p.subFrameRate / p.frameRate;
      return t;
    }
    return null;
  }

  // Một số file có entity HTML không hợp lệ trong XML → đổi sang dạng số trước khi parse.
  const HTML_ENTITY_FIX = { nbsp: 160, lrm: 8206, rlm: 8207, hellip: 8230, mdash: 8212, ndash: 8211 };

  function parseTTML(xmlText) {
    const fixed = xmlText.replace(/&(nbsp|lrm|rlm|hellip|mdash|ndash);/g, (_, n) => `&#${HTML_ENTITY_FIX[n]};`);
    const doc = new DOMParser().parseFromString(fixed, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('File TTML lỗi cú pháp');
    }
    const root = doc.documentElement;
    const params = readTimingParams(root);

    // Gom các style nghiêng trong <styling> (tham chiếu bằng thuộc tính style="s1 s2").
    const italicStyles = new Set();
    for (const st of doc.getElementsByTagNameNS('*', 'style')) {
      const id = attrLocal(st, 'id');
      if (id && attrLocal(st, 'fontStyle') === 'italic') italicStyles.add(id);
    }
    const isItalic = (el) => {
      if (attrLocal(el, 'fontStyle') === 'italic') return true;
      const ref = el.getAttribute('style');
      return !!ref && ref.split(/\s+/).some((s) => italicStyles.has(s));
    };

    // Thời gian của <p> có thể tương đối với <div>/<body> cha có begin.
    const ancestorOffset = (el) => {
      let off = 0;
      for (let n = el.parentElement; n; n = n.parentElement) {
        const b = parseTTMLTime(n.getAttribute('begin'), params);
        if (b) off += b;
      }
      return off;
    };

    const cues = [];
    for (const p of doc.getElementsByTagNameNS('*', 'p')) {
      const offset = ancestorOffset(p);
      const begin = parseTTMLTime(p.getAttribute('begin'), params);
      let end = parseTTMLTime(p.getAttribute('end'), params);
      const dur = parseTTMLTime(p.getAttribute('dur'), params);
      if (begin == null) continue;
      if (end == null && dur != null) end = begin + dur;
      if (end == null) continue;

      // Duyệt cây con: text node, <br/>, <span> lồng nhau (kế thừa chữ nghiêng).
      const parts = [];
      const walk = (node, italic) => {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            parts.push({ text: child.nodeValue.replace(/\s+/g, ' '), italic });
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.localName === 'br') parts.push({ text: '\n', italic: false });
            else walk(child, italic || isItalic(child));
          }
        }
      };
      walk(p, isItalic(p));

      const lines = partsToLines(parts);
      if (lines.length) cues.push({ start: offset + begin, end: offset + end, lines });
    }
    return finalize(cues);
  }

  // ===================== WebVTT =====================

  const VTT_TIME = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;

  function parseVTTTime(s) {
    const m = VTT_TIME.exec(s);
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  }

  function parseVTT(text) {
    const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    const cues = [];
    for (const block of blocks) {
      const rows = block.split('\n');
      const idx = rows.findIndex((r) => r.includes('-->'));
      if (idx === -1) continue; // WEBVTT header, NOTE, STYLE...
      const [a, b] = rows[idx].split('-->');
      const start = parseVTTTime(a);
      const end = parseVTTTime(b);
      if (start == null || end == null) continue;

      const parts = [];
      rows.slice(idx + 1).forEach((row, i) => {
        if (i > 0) parts.push({ text: '\n', italic: false });
        parts.push(...parseVTTLine(row));
      });
      const lines = partsToLines(parts);
      if (lines.length) cues.push({ start, end, lines });
    }
    return finalize(cues);
  }

  // Giữ <i>, bỏ các thẻ khác (<b>, <c.xxx>, <v Name>, timestamp...), giải mã entity.
  function parseVTTLine(row) {
    const out = [];
    let italicDepth = 0;
    const re = /<(\/?)([a-zA-Z0-9.]+)[^>]*>|([^<]+)/g;
    let m;
    while ((m = re.exec(row))) {
      if (m[3] !== undefined) {
        out.push({ text: decodeEntities(m[3]), italic: italicDepth > 0 });
      } else if (m[2].split('.')[0].toLowerCase() === 'i') {
        italicDepth = Math.max(0, italicDepth + (m[1] ? -1 : 1));
      }
    }
    return out;
  }

  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return NAMED_ENTITIES[e.toLowerCase()] ?? all;
    });
  }

  // ===================== Tiện ích chung =====================

  // Gộp danh sách đoạn thành các dòng: tách theo '\n', cắt khoảng trắng đầu/cuối dòng,
  // bỏ đoạn rỗng, gộp các đoạn liền kề có cùng kiểu.
  function partsToLines(parts) {
    const lines = [[]];
    for (const part of parts) {
      if (part.text === '\n') lines.push([]);
      else lines[lines.length - 1].push({ ...part });
    }
    const result = [];
    for (const line of lines) {
      if (line.length) {
        line[0].text = line[0].text.replace(/^\s+/, '');
        line[line.length - 1].text = line[line.length - 1].text.replace(/\s+$/, '');
      }
      const merged = [];
      for (const seg of line) {
        if (!seg.text) continue;
        const last = merged[merged.length - 1];
        if (last && last.italic === seg.italic) last.text += seg.text;
        else merged.push(seg);
      }
      if (merged.some((s) => s.text.trim())) result.push(merged);
    }
    return result;
  }

  // Sắp xếp theo thời gian bắt đầu (bắt buộc cho tìm kiếm nhị phân).
  function finalize(cues) {
    return cues.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start || a.end - b.end);
  }

  // Chọn parser theo định dạng track, có tự nhận diện nội dung để phòng hờ.
  NDS.parseSubtitle = function (text, format) {
    const head = text.slice(0, 200).replace(/^﻿/, '').trimStart();
    if (head.startsWith('WEBVTT') || (format && format.includes('webvtt') && !head.startsWith('<'))) {
      return parseVTT(text);
    }
    return parseTTML(text);
  };

  NDS._parsers = { parseTTML, parseVTT, parseTTMLTime, decodeEntities }; // để test
})();
