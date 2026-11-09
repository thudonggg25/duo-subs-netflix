/*
 * sources.js — nhận các phản hồi sniffer.js bắt được, tìm ra danh sách track phụ đề
 * và tải nội dung track thành cue.
 *
 * Hiểu 4 dạng, đủ cho Disney+, HBO Max, Prime Video, Apple TV mà không cần code riêng:
 *  - HLS master playlist (#EXT-X-MEDIA:TYPE=SUBTITLES) → playlist phụ đề → các đoạn WebVTT.
 *  - DASH manifest (.mpd) có AdaptationSet dạng text (file rời hoặc SegmentTemplate).
 *  - JSON có link file phụ đề (.vtt/.dfxp/.ttml/.srt) kèm mã ngôn ngữ.
 *  - File phụ đề rời đủ dài mà trình phát tự tải.
 *
 * Track: { id, group, lang, label, kind: 'file'|'hls'|'dash', url, segments?, sdh, forced, cues? }
 * Group: { key, label, at, tracks } — mỗi manifest là một nhóm (thường là một tập phim).
 */
window.PHZ = window.PHZ || {};

(() => {
  'use strict';
  const PHZ = window.PHZ;

  // ---------- Tiện ích ----------

  const resolve = (url, base) => {
    try {
      return new URL(url, base).href;
    } catch (e) {
      return url;
    }
  };
  const stripQuery = (url) => String(url).split(/[?#]/)[0];

  let displayNames = null;
  PHZ.langName = function (code) {
    if (!code) return 'Không rõ';
    try {
      displayNames = displayNames || new Intl.DisplayNames(['vi'], { type: 'language' });
      const n = displayNames.of(code);
      if (n && n !== code) return n.charAt(0).toUpperCase() + n.slice(1);
    } catch (e) {}
    return code;
  };
  const isLang = (track, prefix) => (track.lang || '').toLowerCase().startsWith(prefix);

  // Tải text: thử trực tiếp trước, lỗi (thường là CORS) thì nhờ service worker.
  async function fetchText(url) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (err) {
      if (!PHZ.extAlive()) throw err;
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: 'PHZ_FETCH', url });
      } catch (e) {
        res = { ok: false, error: 'SW: ' + e.message };
      }
      if (res && res.ok) return res.text;
      throw new Error(`${err.message} | ${res ? res.error : 'SW không phản hồi'}`);
    }
  }
  PHZ.fetchText = fetchText;

  // Chạy fn trên từng phần tử, tối đa `limit` việc cùng lúc, giữ thứ tự kết quả.
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // Bỏ cue trùng (cue nằm vắt qua ranh giới hai đoạn xuất hiện ở cả hai đoạn).
  function mergeCues(lists) {
    const seen = new Set();
    const out = [];
    for (const cues of lists) {
      for (const c of cues) {
        const key = c.start.toFixed(2) + '|' + c.end.toFixed(2) + '|' + PHZ.cueText(c);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
    return out.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  PHZ.cueText = (cue) => cue.lines.map((l) => l.map((s) => s.text).join('')).join('\n');

  const shift = (cues, dt) => (dt ? cues.map((c) => ({ ...c, start: c.start + dt, end: c.end + dt })) : cues);

  // ---------- HLS ----------

  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  function parseHlsMaster(text, url) {
    const tracks = [];
    const seen = new Set();
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue;
      const a = parseAttrs(line.slice(13));
      if (a.TYPE !== 'SUBTITLES' || !a.URI) continue;
      const forced = a.FORCED === 'YES';
      const sdh = /describes-music-and-sound|transcribes-spoken-dialog/.test(a.CHARACTERISTICS || '');
      // Cùng một ngôn ngữ thường lặp lại ở nhiều GROUP-ID → chỉ giữ một.
      const dedupe = [a.LANGUAGE, a.NAME, forced, sdh].join('|');
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      tracks.push({ kind: 'hls', url: resolve(a.URI, url), lang: a.LANGUAGE || '', name: a.NAME || '', forced, sdh });
    }
    return tracks;
  }

  // X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000 → giây (MPEGTS/90000 − LOCAL).
  function timestampMap(text) {
    const m = /X-TIMESTAMP-MAP=([^\r\n]+)/.exec(text.slice(0, 500));
    if (!m) return null;
    const ts = /MPEGTS:(\d+)/.exec(m[1]);
    const local = /LOCAL:([\d:.]+)/.exec(m[1]);
    if (!ts) return null;
    let loc = 0;
    if (local) {
      const p = local[1].split(':').map(Number);
      loc = p.reduce((acc, v) => acc * 60 + v, 0);
    }
    return +ts[1] / 90000 - loc;
  }

  async function loadHls(track) {
    const playlist = await fetchText(track.url);
    if (/#EXT-X-MAP:/.test(playlist)) throw new Error('Phụ đề dạng fMP4 (chưa hỗ trợ)');
    const segs = playlist
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => resolve(l, track.url));
    if (!segs.length) throw new Error('Playlist phụ đề rỗng');
    const texts = await mapLimit(segs, 8, (u) => fetchText(u));
    // Mọi đoạn cùng một mốc → bỏ qua mốc (trình phát cũng trừ mốc này khỏi video).
    // Mốc khác nhau giữa các đoạn → chỉ dời theo phần chênh so với đoạn đầu.
    let base = null;
    const lists = texts.map((t) => {
      const off = timestampMap(t);
      if (off != null && base == null) base = off;
      const cues = PHZ.parseSubtitle(t, 'webvtt');
      return off != null ? shift(cues, off - base) : cues;
    });
    return mergeCues(lists);
  }

  // ---------- DASH ----------

  function isoDuration(s) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s || '');
    if (!m) return null;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);
  const kid = (el, name) => kids(el, name)[0] || null;

  function baseUrlOf(el, base) {
    const b = kid(el, 'BaseURL');
    return b ? resolve(b.textContent.trim(), base) : base;
  }

  // $Number%05d$, $Time$, $RepresentationID$, $Bandwidth$
  function fillTemplate(tpl, vars) {
    return tpl.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (all, name, width) => {
      if (name === '') return '$';
      const v = vars[name];
      if (v == null) return all;
      return width ? String(v).padStart(+width, '0') : String(v);
    });
  }

  function templateSegments(tplEl, rep, base, periodDur) {
    const media = tplEl.getAttribute('media');
    if (!media) return null;
    const timescale = +tplEl.getAttribute('timescale') || 1;
    const startNumber = +(tplEl.getAttribute('startNumber') || 1);
    const pto = +tplEl.getAttribute('presentationTimeOffset') || 0;
    const vars = { RepresentationID: rep.getAttribute('id'), Bandwidth: rep.getAttribute('bandwidth') };
    const out = [];
    const timeline = kid(tplEl, 'SegmentTimeline');
    if (timeline) {
      let t = 0;
      let n = startNumber;
      for (const s of kids(timeline, 'S')) {
        if (s.hasAttribute('t')) t = +s.getAttribute('t');
        const d = +s.getAttribute('d');
        const r = +(s.getAttribute('r') || 0);
        for (let i = 0; i <= r; i++) {
          out.push(resolve(fillTemplate(media, { ...vars, Number: n++, Time: t }), base));
          t += d;
        }
      }
    } else {
      const d = +tplEl.getAttribute('duration');
      if (!d || !periodDur) return null;
      const count = Math.ceil((periodDur * timescale - pto) / d);
      for (let i = 0; i < count && i < 5000; i++) {
        out.push(resolve(fillTemplate(media, { ...vars, Number: startNumber + i, Time: i * d }), base));
      }
    }
    return out;
  }

  function parseDash(text, url) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return { tracks: [], unsupported: 0 };
    const mpd = doc.documentElement;
    const mpdBase = baseUrlOf(mpd, url);
    const total = isoDuration(mpd.getAttribute('mediaPresentationDuration'));
    const byKey = new Map();
    let unsupported = 0;
    let periodStart = 0;
    for (const period of kids(mpd, 'Period')) {
      if (period.hasAttribute('start')) periodStart = isoDuration(period.getAttribute('start')) || 0;
      const periodDur = isoDuration(period.getAttribute('duration')) || (total != null ? total - periodStart : null);
      const pBase = baseUrlOf(period, mpdBase);
      for (const as of kids(period, 'AdaptationSet')) {
        const rep = kid(as, 'Representation');
        if (!rep) continue;
        const mime = (as.getAttribute('mimeType') || rep.getAttribute('mimeType') || '').toLowerCase();
        const codecs = (as.getAttribute('codecs') || rep.getAttribute('codecs') || '').toLowerCase();
        const isText = as.getAttribute('contentType') === 'text' || /^text\/|ttml/.test(mime) || /wvtt|stpp/.test(codecs);
        if (!isText) continue;
        if (/mp4/.test(mime) || /wvtt|stpp/.test(codecs)) {
          unsupported++; // phụ đề đóng gói trong fMP4: chưa đọc được
          continue;
        }
        const lang = as.getAttribute('lang') || rep.getAttribute('lang') || '';
        const labelEl = kid(as, 'Label');
        const roles = kids(as, 'Role').map((r) => r.getAttribute('value') || '');
        const forced = roles.some((r) => /forced/.test(r));
        const sdh = roles.some((r) => /caption/.test(r));
        const base = baseUrlOf(rep, baseUrlOf(as, pBase));
        const tpl = kid(rep, 'SegmentTemplate') || kid(as, 'SegmentTemplate');
        let segments = null;
        if (tpl) segments = templateSegments(tpl, rep, base, periodDur);
        const key = [lang, labelEl ? labelEl.textContent : '', forced, sdh].join('|');
        let t = byKey.get(key);
        if (!t) {
          t = {
            kind: 'dash',
            url: segments ? segments[0] : base,
            lang,
            name: labelEl ? labelEl.textContent.trim() : '',
            forced,
            sdh,
            parts: [],
            format: mime,
          };
          byKey.set(key, t);
        }
        t.parts.push({ start: periodStart, urls: segments || [base] });
      }
      if (periodDur != null) periodStart += periodDur;
    }
    return { tracks: Array.from(byKey.values()), unsupported };
  }

  async function loadDash(track) {
    const lists = [];
    for (const part of track.parts) {
      const texts = await mapLimit(part.urls, 8, (u) => fetchText(u));
      for (const t of texts) lists.push(shift(PHZ.parseSubtitle(t, track.format), part.start));
    }
    return mergeCues(lists);
  }

  // ---------- JSON ----------

  const JSON_SUB_URL_RE = /^https?:\/\/[^\s"]+\.(vtt|webvtt|dfxp|ttml2?|srt|xml)(?:$|[?#])/i;
  const SUB_KEY_RE = /subtitle|caption|timedtext|forced|narrative|text ?track/i;

  function findJsonTracks(root) {
    const tracks = [];
    const seen = new Set();
    let visited = 0;
    const walk = (node, path, depth) => {
      if (!node || typeof node !== 'object' || depth > 14 || ++visited > 50000) return;
      if (Array.isArray(node)) {
        node.forEach((v) => walk(v, path, depth + 1));
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && JSON_SUB_URL_RE.test(v)) {
          const ext = JSON_SUB_URL_RE.exec(v)[1].toLowerCase();
          const ctx = path + ' ' + k + ' ' + (node.type || '') + ' ' + (node.subtype || '');
          if (ext === 'xml' && !SUB_KEY_RE.test(ctx)) continue;
          if (seen.has(v)) continue;
          seen.add(v);
          const lang = node.languageCode || node.language || node.lang || node.locale || node.languageTag || '';
          tracks.push({
            kind: 'file',
            url: v,
            lang: typeof lang === 'string' ? lang : '',
            name: node.displayName || node.label || node.languageName || node.name || '',
            forced: /forced|narrative/i.test(ctx),
            sdh: /sdh|\bcc\b|caption/i.test(ctx),
            format: ext,
          });
        } else if (v && typeof v === 'object') {
          walk(v, path + ' ' + k, depth + 1);
        }
      }
    };
    walk(root, '', 0);
    return tracks;
  }

  // ---------- Quản lý nhóm / track ----------

  class Sources {
    constructor() {
      this.groups = new Map(); // key -> {key, label, at, tracks}
      this.cache = new Map(); // track id -> Promise<cues>
      this.seen = new Set();
      this.listeners = [];
      this.stats = { captures: 0, manifests: 0, unsupported: 0, errors: 0 };
      this.nextId = 1;
    }

    onChange(fn) {
      this.listeners.push(fn);
    }

    emit(group) {
      for (const fn of this.listeners) fn(group);
    }

    // Nhóm mới nhất (thường là tập đang xem).
    latest() {
      let best = null;
      for (const g of this.groups.values()) if (!best || g.at > best.at) best = g;
      return best;
    }

    addGroup(key, label, at, rawTracks) {
      if (!rawTracks.length) return;
      const old = this.groups.get(key);
      const group = { key, label, at, tracks: [] };
      for (const t of rawTracks) {
        const same = old && old.tracks.find((o) => o.url === t.url);
        group.tracks.push(
          same || {
            ...t,
            id: 't' + this.nextId++,
            group: key,
            label: t.name || PHZ.langName(t.lang),
          }
        );
      }
      for (const t of group.tracks) {
        const extra = [t.forced && 'bắt buộc', t.sdh && 'SDH'].filter(Boolean).join(', ');
        t.title = t.label + (t.lang && t.name ? ` (${t.lang})` : '') + (extra ? ` · ${extra}` : '');
      }
      this.groups.set(key, group);
      this.emit(group);
    }

    ingest(item) {
      const sig = item.url + '|' + item.at;
      if (this.seen.has(sig)) return;
      this.seen.add(sig);
      this.stats.captures++;
      const text = item.text;
      const head = text.slice(0, 400).replace(/^﻿/, '').trimStart();
      const key = stripQuery(item.url);
      let host = '';
      try {
        host = new URL(item.url).hostname;
      } catch (e) {}
      const at = item.at || Date.now();
      try {
        if (head.startsWith('#EXTM3U')) {
          if (!text.includes('TYPE=SUBTITLES')) return; // playlist video/audio
          this.stats.manifests++;
          this.addGroup(key, 'HLS · ' + host, at, parseHlsMaster(text, item.url));
        } else if (/<MPD[\s>]/.test(head) || (head.startsWith('<?xml') && text.slice(0, 2000).includes('<MPD'))) {
          this.stats.manifests++;
          const { tracks, unsupported } = parseDash(text, item.url);
          this.stats.unsupported += unsupported;
          this.addGroup(key, 'DASH · ' + host, at, tracks);
        } else if (head.startsWith('{') || head.startsWith('[')) {
          const tracks = findJsonTracks(JSON.parse(text));
          if (tracks.length) {
            this.stats.manifests++;
            this.addGroup(key, 'JSON · ' + host, at, tracks);
          }
        } else if (head.startsWith('WEBVTT') || head.startsWith('<') || head.includes('-->')) {
          this.ingestFile(item, key, at);
        }
      } catch (e) {
        this.stats.errors++;
      }
    }

    // File phụ đề rời: chỉ nhận khi đủ dài (đoạn HLS/DASH nhỏ thì bỏ qua).
    ingestFile(item, key, at) {
      const cues = PHZ.parseSubtitle(item.text, '');
      const span = cues.length ? cues[cues.length - 1].end - cues[0].start : 0;
      if (cues.length < 30 && span < 300) return;
      const raw = { kind: 'file', url: item.url, lang: '', name: 'Phụ đề bắt được', forced: false, sdh: false };
      this.addGroup('captured:' + key, 'Tệp · ' + key.split('/').pop(), at, [raw]);
      const g = this.groups.get('captured:' + key);
      this.cache.set(g.tracks[0].id, Promise.resolve(cues));
    }

    load(track) {
      if (!this.cache.has(track.id)) {
        let p;
        if (track.kind === 'hls') p = loadHls(track);
        else if (track.kind === 'dash') p = loadDash(track);
        else p = fetchText(track.url).then((t) => PHZ.parseSubtitle(t, track.format));
        p.catch(() => this.cache.delete(track.id)); // lỗi thì cho thử lại
        this.cache.set(track.id, p);
      }
      return this.cache.get(track.id);
    }
  }

  // Chọn track mặc định: Phụ đề 1 = tiếng Anh thường (không SDH, không bắt buộc),
  // Phụ đề 2 = tiếng Việt chính thức nếu có.
  PHZ.pickDefaults = function (tracks) {
    const normal = tracks.filter((t) => !t.forced);
    const en = normal.filter((t) => isLang(t, 'en'));
    const t1 = en.find((t) => !t.sdh) || en[0] || normal.find((t) => !isLang(t, 'vi')) || null;
    const vi = normal.find((t) => isLang(t, 'vi')) || null;
    return { t1, vi };
  };

  PHZ.findActiveCues = function (cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        last = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const active = [];
    for (let i = last; i >= 0 && i > last - 10; i--) if (cues[i].end > t) active.unshift(i);
    return active;
  };

  PHZ.Sources = Sources;
  PHZ._sources = { parseHlsMaster, parseDash, findJsonTracks, timestampMap, fillTemplate, isoDuration, mergeCues };
})();
