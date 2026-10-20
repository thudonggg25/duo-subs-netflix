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

/*
 * Kiểm tra bản mới.
 *  - Cài từ Chrome Web Store (manifest có update_url): hỏi Chrome qua requestUpdateCheck,
 *    Chrome tự tải bản mới; bấm "Cập nhật ngay" thì chrome.runtime.reload() để áp dụng.
 *  - Cài thủ công từ GitHub: đọc version trong manifest.json trên GitHub để so sánh,
 *    người dùng tự tải zip mới. Bản cài từ cửa hàng không bao giờ gọi tới GitHub.
 * Kết quả lưu trong chrome.storage.local (ndsUpdate), tự kiểm tra lại tối đa 6 giờ một lần.
 */
const GITHUB_REPO = 'thudonggg25/duo-subs-netflix';
const UPDATE_KEY = 'ndsUpdate';
const PENDING_KEY = 'ndsUpdatePending';
const CHECK_EVERY_MS = 6 * 3600 * 1000;
const IS_STORE = 'update_url' in chrome.runtime.getManifest();

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

chrome.runtime.onUpdateAvailable.addListener((details) => {
  // Bản mới đã tải xong, chờ reload để cài. Lưu lại vì service worker có thể bị tắt.
  chrome.storage.local.set({ [PENDING_KEY]: details.version });
});

async function checkUpdate(force) {
  const current = chrome.runtime.getManifest().version;
  const store = await chrome.storage.local.get([UPDATE_KEY, PENDING_KEY]);
  const saved = store[UPDATE_KEY];
  const pending = store[PENDING_KEY];
  if (IS_STORE && pending && cmpVersion(pending, current) > 0) {
    return { mode: 'store', current, latest: pending, status: 'ready' };
  }
  if (!force && saved && saved.current === current && Date.now() - saved.checkedAt < CHECK_EVERY_MS) return saved;

  const res = { mode: IS_STORE ? 'store' : 'github', current, latest: current, checkedAt: Date.now() };
  try {
    if (IS_STORE) {
      const r = await chrome.runtime.requestUpdateCheck();
      if (r.status === 'throttled') return { ...res, status: 'throttled' };
      res.status = r.status === 'update_available' ? 'downloading' : 'latest';
      if (r.version) res.latest = r.version;
    } else {
      const r = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/manifest.json`, {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      res.latest = String((await r.json()).version || current);
      res.status = cmpVersion(res.latest, current) > 0 ? 'available' : 'latest';
      res.page = `https://github.com/${GITHUB_REPO}`;
      res.zip = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
    }
  } catch (e) {
    return { ...res, status: 'error', error: String((e && e.message) || e) };
  }
  await chrome.storage.local.set({ [UPDATE_KEY]: res });
  return res;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== 'NDS_UPDATE_CHECK' && msg.type !== 'NDS_UPDATE_APPLY')) return false;
  if (!sender.url || !sender.url.startsWith('https://www.netflix.com/')) return false;
  if (msg.type === 'NDS_UPDATE_CHECK') {
    checkUpdate(!!msg.force).then(sendResponse, (e) => sendResponse({ status: 'error', error: String(e) }));
    return true;
  }
  // NDS_UPDATE_APPLY: chỉ reload khi Chrome đã tải xong bản mới.
  chrome.storage.local.get(PENDING_KEY).then((s) => {
    const pending = s[PENDING_KEY];
    if (!IS_STORE || !pending || cmpVersion(pending, chrome.runtime.getManifest().version) <= 0) {
      sendResponse({ ok: false });
      return;
    }
    sendResponse({ ok: true });
    chrome.storage.local.remove([PENDING_KEY, UPDATE_KEY]).then(() => chrome.runtime.reload());
  });
  return true;
});
