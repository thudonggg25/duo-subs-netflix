/*
 * sniffer.js — chạy trong PAGE CONTEXT (world: "MAIN"), trước script của trang.
 *
 * Không hiểu riêng nền tảng nào: chỉ nghe các phản hồi fetch/XHR có thể chứa
 * danh sách phụ đề (playlist HLS .m3u8, manifest DASH .mpd, JSON có link phụ đề,
 * file phụ đề rời) rồi chuyển nguyên văn sang content script để phân tích.
 *
 * Không bao giờ được làm hỏng player: mọi chỗ đọc đều bọc try/catch và đọc bản
 * clone() của response.
 */
(() => {
  'use strict';
  if (window.__phzSnifferInstalled) return;
  window.__phzSnifferInstalled = true;

  const SRC_PAGE = 'PHZ_PAGE';
  const SRC_CS = 'PHZ_CS';
  const MAX_BYTES = 8 * 1024 * 1024;

  const SUB_EXT_RE = /\.(m3u8|mpd|vtt|webvtt|srt|ttml2?|dfxp)(?:$|[?#])/i;
  const XML_EXT_RE = /\.xml(?:$|[?#])/i;
  const TYPE_RE = /mpegurl|dash\+xml|text\/vtt|ttml|x-subrip/i;
  const SKIP_TYPE_RE = /^(video|audio|image|font)\/|octet-stream|mp4/i;
  // JSON đáng chuyển đi khi có dấu hiệu chứa link phụ đề.
  const JSON_HINT_RE = /\.(vtt|webvtt|dfxp|ttml2?|srt)\b|subtitle|timedtext|caption/i;

  // Giữ lại các phản hồi gần nhất để phát lại khi content script khởi động muộn.
  const recent = [];
  let count = 0;

  function post(item) {
    recent.push(item);
    if (recent.length > 40) recent.shift();
    count++;
    window.postMessage({ source: SRC_PAGE, type: 'capture', item }, '*');
  }

  function absUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch (e) {
      return String(url || '');
    }
  }

  // Có nên đọc nội dung phản hồi này không (quyết định trước khi đọc, cho rẻ).
  function wanted(url, contentType) {
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch (e) {}
    if (SUB_EXT_RE.test(path)) return true;
    const ct = contentType || '';
    if (TYPE_RE.test(ct)) return true;
    if (SKIP_TYPE_RE.test(ct)) return false;
    if (/json/i.test(ct)) return true;
    if (XML_EXT_RE.test(path) && /xml/i.test(ct)) return true;
    return false;
  }

  function handleText(url, contentType, text) {
    if (typeof text !== 'string' || !text || text.length > MAX_BYTES) return;
    if (/json/i.test(contentType || '') || /^\s*[[{]/.test(text.slice(0, 20))) {
      if (!JSON_HINT_RE.test(text)) return;
    }
    post({ url, contentType: contentType || '', text, at: Date.now() });
  }

  // ---------- fetch ----------
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = absUrl(typeof input === 'string' ? input : input && input.url);
      p.then((res) => {
        try {
          const ct = res.headers.get('content-type') || '';
          const len = +res.headers.get('content-length') || 0;
          if (!res.ok || len > MAX_BYTES || !wanted(res.url || url, ct)) return;
          res
            .clone()
            .text()
            .then((text) => handleText(res.url || url, ct, text))
            .catch(() => {});
        } catch (e) {}
      }).catch(() => {});
    } catch (e) {}
    return p;
  };

  // ---------- XMLHttpRequest ----------
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  XHR.open = function (method, url) {
    try {
      this.__phzUrl = absUrl(url);
      if (!this.__phzHooked) {
        this.__phzHooked = true;
        this.addEventListener('load', onXhrLoad);
      }
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  function onXhrLoad() {
    try {
      if (this.status < 200 || this.status >= 300) return;
      const url = this.responseURL || this.__phzUrl;
      const ct = this.getResponseHeader('content-type') || '';
      if (!wanted(url, ct)) return;
      let text = null;
      const rt = this.responseType;
      if (rt === '' || rt === 'text') text = this.responseText;
      else if (rt === 'json') text = JSON.stringify(this.response);
      else if (rt === 'arraybuffer' && this.response && this.response.byteLength <= MAX_BYTES) {
        text = new TextDecoder().decode(this.response);
      }
      if (text != null) handleText(url, ct, text);
    } catch (e) {}
  }

  // ---------- Trao đổi với content script ----------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== SRC_CS) return;
    if (ev.data.type === 'replay') {
      for (const item of recent) window.postMessage({ source: SRC_PAGE, type: 'capture', item }, '*');
    } else if (ev.data.type === 'diag') {
      window.postMessage({ source: SRC_PAGE, type: 'diag', count }, '*');
    }
  });
})();
