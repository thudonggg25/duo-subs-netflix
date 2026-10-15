/*
 * interceptor.js — chạy trong PAGE CONTEXT (world: "MAIN"), trước script của Netflix.
 *
 * Nhiệm vụ:
 *  1. Hook JSON.stringify để chèn thêm các profile phụ đề dạng text vào request
 *     xin manifest (nếu không, Netflix thường chỉ trả về phụ đề dạng ảnh/định dạng
 *     mà player của nó cần).
 *  2. Hook JSON.parse để bắt response manifest (object có `textTracks` (manifest v4)
 *     hoặc `timedtexttracks` (bản cũ) + `movieId`).
 *  3. Chuẩn hoá danh sách track rồi gửi sang content script bằng window.postMessage.
 *  4. Báo cho content script khi URL đổi qua history API (Netflix là SPA).
 *
 * ĐIỂM DỄ HỎNG: tên field `params.profiles`, `textTracks`/`timedtexttracks`,
 * `downloadables`/`ttDownloadables`,
 * `downloadUrls`/`urls` và tên profile phụ đề đều là chi tiết nội bộ của Netflix.
 */
(() => {
  'use strict';
  if (window.__ndsInterceptorInstalled) return;
  window.__ndsInterceptorInstalled = true;

  const SRC_PAGE = 'NDS_PAGE';
  const SRC_CS = 'NDS_CS';

  // Profile text xin thêm trong request manifest.
  const EXTRA_TEXT_PROFILES = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'simplesdh'];
  // Thứ tự ưu tiên định dạng text khi chọn URL tải phụ đề (TTML trước, WebVTT sau).
  const TEXT_FORMATS = ['dfxp-ls-sdh', 'simplesdh', 'imsc1.1', 'webvtt-lssdh-ios8'];
  // Định dạng chắc chắn là ẢNH; định dạng lạ khác vẫn thử như text (parser tự nhận TTML/VTT).
  const IMAGE_FORMAT_RE = /cmisc|img|image|png|bitmap/i;
  // Manifest v4 đổi tên field: textTracks/downloadables; bản cũ: timedtexttracks/ttDownloadables.
  const TRACKS_KEYS = ['textTracks', 'timedtexttracks'];
  const hasTracksText = (text) => text.includes('textTracks') || text.includes('timedtexttracks');
  const getTracks = (obj) => TRACKS_KEYS.map((k) => obj[k]).find(Array.isArray);

  // Cache manifest theo movieId để phát lại khi content script yêu cầu
  // (content script có thể khởi tạo sau khi manifest đã về).
  const manifests = new Map();

  // Số liệu chẩn đoán, hiển thị trong panel (mục "Chẩn đoán") để gỡ lỗi không cần DevTools.
  const diag = {
    requestsPatched: 0, // số request manifest đã chèn profile phụ đề text
    rawHits: 0, // số lần thấy dữ liệu có chữ "textTracks"/"timedtexttracks"
    unrecognized: [], // dữ liệu có danh sách track nhưng không tìm ra manifest (cấu trúc đã đổi)
  };

  const origStringify = JSON.stringify;
  const origParse = JSON.parse;

  // ---------- 1. Hook JSON.stringify: sửa request manifest ----------
  JSON.stringify = function (value, ...rest) {
    try {
      patchManifestRequest(value);
    } catch (e) {
      /* không bao giờ được làm hỏng player */
    }
    return origStringify.call(this, value, ...rest);
  };

  function patchManifestRequest(value) {
    if (!value || typeof value !== 'object') return;
    const params = value.params;
    if (!params || !Array.isArray(params.profiles)) return;
    for (const p of EXTRA_TEXT_PROFILES) {
      if (!params.profiles.includes(p)) params.profiles.push(p);
    }
    // Xin tất cả track phụ đề/lồng tiếng, không chỉ những track Netflix gợi ý.
    params.showAllSubDubTracks = true;
    diag.requestsPatched++;
    console.info('[Dual Subs] Đã thêm profile phụ đề text vào request manifest');
  }

  // ---------- 2. Hook JSON.parse: bắt response manifest ----------
  JSON.parse = function (text, reviver) {
    const result = origParse.call(this, text, reviver);
    try {
      // Kiểm tra chuỗi trước cho rẻ, tránh duyệt mọi object Netflix parse.
      if (typeof text === 'string' && hasTracksText(text)) {
        inspect(result, 'JSON.parse');
      }
    } catch (e) {
      console.warn('[Dual Subs] Lỗi khi đọc manifest:', e);
    }
    return result;
  };

  // ---------- 2b. Hook Response.json() và XHR ----------
  // Netflix bản mới có thể đọc manifest bằng fetch().json() hoặc XHR responseType="json":
  // trình duyệt parse bằng code native, KHÔNG đi qua JSON.parse ở trên.
  const origResponseJson = Response.prototype.json;
  Response.prototype.json = function () {
    return origResponseJson.call(this).then((data) => {
      inspect(data, 'fetch');
      return data;
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.responseType === 'json') inspect(this.response, 'xhr');
        else if (this.responseType === '' || this.responseType === 'text') {
          const text = this.responseText;
          if (text && hasTracksText(text)) inspect(origParse(text), 'xhr');
        }
      } catch (e) {
        /* bỏ qua response không phải JSON */
      }
    });
    return origOpen.apply(this, args);
  };

  function inspect(data, via) {
    try {
      const manifest = findManifest(data, 0);
      if (manifest) handleManifest(manifest, via);
      else if (via === 'JSON.parse' || TRACKS_KEYS.some((k) => hasKeyDeep(data, k, 0))) {
        diag.rawHits++;
        if (diag.unrecognized.length < 3) diag.unrecognized.push(via + ': ' + describeShape(data));
      }
    } catch (e) {
      console.warn('[Dual Subs] Lỗi khi đọc manifest:', e);
    }
  }

  function hasKeyDeep(obj, key, depth) {
    if (!obj || typeof obj !== 'object' || depth > 5) return false;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
    const children = Array.isArray(obj) ? obj.slice(0, 20) : Object.values(obj);
    return children.some((c) => hasKeyDeep(c, key, depth + 1));
  }

  // Mô tả ngắn cấu trúc 2 tầng đầu (chỉ tên key), để biết Netflix đổi chỗ dữ liệu ra sao.
  function describeShape(obj) {
    if (!obj || typeof obj !== 'object') return typeof obj;
    return Object.keys(obj)
      .slice(0, 12)
      .map((k) => {
        const v = obj[k];
        return v && typeof v === 'object' && !Array.isArray(v) ? `${k}{${Object.keys(v).slice(0, 12).join(',')}}` : k;
      })
      .join(', ');
  }

  // Hỏi player của Netflix xem nó biết bao nhiêu track phụ đề (best-effort, API nội bộ).
  function probePlayerApi() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const player = vp.getVideoPlayerBySessionId(ids[ids.length - 1]);
      return player.getTimedTextTrackList().map((t) => t.bcp47 || t.language || t.displayName).join(', ');
    } catch (e) {
      return null;
    }
  }

  // Tìm object chứa timedtexttracks trong cấu trúc response (vị trí có thể đổi
  // giữa các phiên bản API: result, result.result[0], ...), giới hạn độ sâu.
  function findManifest(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    if (getTracks(obj) && obj.movieId != null) return obj;
    const children = Array.isArray(obj) ? obj.slice(0, 20) : Object.values(obj);
    for (const child of children) {
      if (child && typeof child === 'object') {
        const found = findManifest(child, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function handleManifest(manifest, via) {
    const movieId = String(manifest.movieId);
    const tracks = getTracks(manifest).map(normalizeTrack).filter(Boolean);
    // Log để gỡ lỗi: mở DevTools → Console, lọc "[Dual Subs]".
    console.info(
      `[Dual Subs] Bắt được manifest movieId=${movieId} qua ${via}:`,
      tracks.map((t) => `${t.language}/${t.kind}/${t.status}${t.format ? '/' + t.format : ''}`).join(', ')
    );
    const payload = { movieId, tracks, receivedAt: Date.now() };
    manifests.set(movieId, payload);
    post('manifest', payload);
  }

  // Chuyển track của Netflix về dạng gọn, chỉ gồm dữ liệu thuần (clone được qua postMessage).
  function normalizeTrack(t) {
    if (!t || t.isNoneTrack) return null;
    const downloadables = t.downloadables || t.ttDownloadables || {};
    const formats = Object.keys(downloadables);

    // Thứ tự thử: định dạng text đã biết trước, sau đó các định dạng lạ không phải ảnh.
    const candidates = [
      ...TEXT_FORMATS,
      ...(t.isImageBased ? [] : formats.filter((f) => !TEXT_FORMATS.includes(f) && !IMAGE_FORMAT_RE.test(f))),
    ];
    let chosen = null;
    for (const fmt of candidates) {
      if (!downloadables[fmt]) continue;
      const url = pickUrl(downloadables[fmt]);
      if (url) {
        chosen = { format: fmt, url };
        break;
      }
    }

    // status: 'text' = dùng được; 'image' = chỉ có dạng ảnh; 'missing' = không có URL
    // (ví dụ track chưa được "hydrate" trong manifest).
    let status = 'missing';
    if (chosen) status = 'text';
    else if (formats.length > 0) status = 'image';

    const language = t.language || t.bcp47 || 'und';
    const kind =
      t.rawTrackType ||
      (t.trackType === 'ASSISTIVE' ? 'closedcaptions' : 'subtitles');

    return {
      id: String(t.new_track_id || t.id || t.trackId || `${language}-${kind}-${t.isForcedNarrative ? 'f' : ''}`),
      language,
      label: t.languageDescription || t.displayName || language,
      kind,
      forced: !!t.isForcedNarrative,
      status,
      format: chosen ? chosen.format : null,
      url: chosen ? chosen.url : null,
      formats,
    };
  }

  // URL nằm ở `downloadUrls: {cdnId: url}` (API cũ) hoặc `urls: [{url}]` (API mới).
  function pickUrl(d) {
    if (d.downloadUrls && typeof d.downloadUrls === 'object') {
      const u = Object.values(d.downloadUrls).find((x) => typeof x === 'string');
      if (u) return u;
    }
    if (Array.isArray(d.urls)) {
      for (const x of d.urls) {
        if (typeof x === 'string') return x;
        if (x && typeof x.url === 'string') return x.url;
      }
    }
    return null;
  }

  // ---------- 3. Giao tiếp với content script ----------
  function post(type, payload) {
    window.postMessage({ source: SRC_PAGE, type, payload }, window.location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SRC_CS) return;
    if (data.type === 'request-manifests') {
      manifests.forEach((payload) => post('manifest', payload));
    } else if (data.type === 'request-diag') {
      post('diag', {
        ...diag,
        manifests: [...manifests.values()].map((m) => `${m.movieId} (${m.tracks.length} track)`),
        playerApiTracks: probePlayerApi(),
      });
    } else if (data.type === 'seek' && typeof data.time === 'number') {
      seekTo(data.time);
    }
  });

  // Tua phim tới thời điểm (giây). Netflix không cho gán video.currentTime trực tiếp
  // (player báo lỗi), nên dùng API nội bộ của player; nếu không có thì mới gán thẳng.
  function seekTo(seconds) {
    const t = Math.max(0, seconds);
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const player = vp.getVideoPlayerBySessionId(ids[ids.length - 1]);
      player.seek(Math.round(t * 1000));
      return;
    } catch (e) {
      // không có API (trang thử nghiệm hoặc Netflix đổi cấu trúc)
    }
    const video = document.querySelector('video');
    if (video) video.currentTime = t;
  }

  // ---------- 4. Theo dõi điều hướng SPA ----------
  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    history[method] = function (...args) {
      const ret = orig.apply(this, args);
      post('navigation', { path: location.pathname });
      return ret;
    };
  }
})();
