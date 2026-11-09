/*
 * settings.js — cài đặt lưu trong chrome.storage.local (key "phz.settings").
 * API key cũng nằm ở đây; extension chỉ dùng riêng nên không đồng bộ lên tài khoản.
 */
window.PHZ = window.PHZ || {};

(() => {
  'use strict';
  const PHZ = window.PHZ;
  const KEY = 'phz.settings';

  const DEFAULTS = {
    // Hiển thị
    show1: true,
    show2: true,
    fontSize: 4.2, // % chiều cao video
    bottom: 9, // % chiều cao video, tính từ đáy
    offsets: {}, // hostname -> giây cộng vào thời gian video khi tra phụ đề
    // Dịch AI
    apiKey: '',
    model: 'claude-opus-5-5',
    autoTranslate: false,
    apiBaseUrl: '', // để trống = API của Anthropic (chỉ đổi khi chạy test)
    // Thuyết minh
    narrate: false,
    engine: 'browser', // 'browser' | 'server'
    voiceName: '',
    serverUrl: 'http://127.0.0.1:5252',
    duck: 0.25, // tiếng phim còn lại bao nhiêu khi đang đọc
    rate: 1.0,
    narrVolume: 1.0,
  };

  const Settings = {
    data: { ...DEFAULTS },
    listeners: [],
    async load() {
      try {
        const got = await chrome.storage.local.get(KEY);
        Object.assign(this.data, DEFAULTS, got[KEY] || {});
      } catch (e) {}
      return this.data;
    },
    save() {
      try {
        chrome.storage.local.set({ [KEY]: this.data });
      } catch (e) {}
      for (const fn of this.listeners) fn(this.data);
    },
    set(patch) {
      Object.assign(this.data, patch);
      this.save();
    },
    onChange(fn) {
      this.listeners.push(fn);
    },
    // Lệch thời gian theo từng trang (mỗi nền tảng có thể lệch khác nhau).
    offsetFor(host) {
      return +(this.data.offsets[host] || 0);
    },
    setOffset(host, v) {
      this.data.offsets = { ...this.data.offsets, [host]: Math.round(v * 10) / 10 };
      this.save();
    },
  };

  PHZ.Settings = Settings;
  PHZ.SETTINGS_KEY = KEY;
  PHZ.extAlive = () => {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  };
})();
