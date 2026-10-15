/*
 * subtitles.js — tải, cache và tra cứu cue theo thời gian.
 */
window.NDS = window.NDS || {};

(() => {
  'use strict';
  const NDS = window.NDS;

  // Tải nội dung file phụ đề. Thử fetch trực tiếp trước (content script dùng
  // origin của trang netflix.com, CDN của Netflix cho phép CORS); nếu lỗi thì nhờ
  // service worker tải hộ (có host_permissions cho *.nflxvideo.net).
  async function fetchText(url) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (err) {
      if (!NDS.extAlive()) throw err;
      // Ghi rõ lỗi của cả 2 cách tải (trực tiếp / qua service worker) để chẩn đoán.
      let host = '?';
      try {
        host = new URL(url).hostname;
      } catch (e) {}
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: 'NDS_FETCH', url });
      } catch (e) {
        res = { ok: false, error: 'SW: ' + e.message };
      }
      if (res && res.ok) return res.text;
      const sw = res ? res.error : 'SW không phản hồi';
      throw new Error(`${err.message} | ${sw} | ${host}`);
    }
  }

  // Cache theo track id (URL có chữ ký nên có thể đổi; id ổn định hơn trong một phiên).
  const cache = new Map(); // trackId -> Promise<cues>

  NDS.loadTrackCues = function (track) {
    if (!cache.has(track.id)) {
      const p = fetchText(track.url).then((text) => NDS.parseSubtitle(text, track.format));
      p.catch(() => cache.delete(track.id)); // lỗi thì cho phép thử lại lần sau
      cache.set(track.id, p);
    }
    return cache.get(track.id);
  };

  // Tìm các cue đang hiển thị tại thời điểm t (giây) bằng tìm kiếm nhị phân.
  // cues đã được sắp xếp theo start. Trả về mảng chỉ số cue.
  NDS.findActiveCues = function (cues, t) {
    // Tìm vị trí cuối cùng có start <= t
    let lo = 0;
    let hi = cues.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        last = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // Các cue có thể chồng thời gian nhau → quét lùi một ít để lấy hết cue còn hiệu lực.
    const active = [];
    for (let i = last; i >= 0 && i > last - 10; i--) {
      if (cues[i].end > t) active.unshift(i);
    }
    return active;
  };
})();
