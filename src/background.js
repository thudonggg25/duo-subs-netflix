/*
 * background.js — service worker.
 *
 * Chỉ dùng làm đường DỰ PHÒNG để tải file phụ đề khi fetch từ content script
 * bị chặn (CORS). Chỉ cho phép URL https thuộc CDN của Netflix, để extension
 * không trở thành proxy tải URL tuỳ ý.
 */
const ALLOWED_HOSTS = [/(^|\.)nflxvideo\.net$/i];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'NDS_FETCH') return false;
  if (!sender.url || !sender.url.startsWith('https://www.netflix.com/')) return false;

  let url;
  try {
    url = new URL(msg.url);
  } catch (e) {
    sendResponse({ ok: false, error: 'URL không hợp lệ' });
    return false;
  }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.some((re) => re.test(url.hostname))) {
    sendResponse({ ok: false, error: 'Host không được phép: ' + url.hostname });
    return false;
  }

  fetch(url.href, { credentials: 'omit' })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
    .then((text) => sendResponse({ ok: true, text }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // giữ kênh mở để trả lời bất đồng bộ
});
