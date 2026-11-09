/*
 * narrator.js — thuyết minh: đọc lời tiếng Việt đúng lúc, nhỏ tiếng phim khi đang đọc.
 *
 * Hai nguồn giọng:
 *  - 'browser': speechSynthesis của trình duyệt (Linh trên Mac, Google Tiếng Việt trên Chrome).
 *  - 'server' : máy chủ đọc chạy trên máy (vd VieNeu trên iMac), giao thức:
 *               POST <serverUrl>/tts {text, voice: 'nam'|'nữ'|'', rate} → file âm thanh.
 *               Âm thanh phát bằng Web Audio để không vướng CSP media-src của trang.
 *
 * Nhỏ tiếng phim bằng video.volume (Web Audio không dùng được với phim có DRM).
 */
window.PHZ = window.PHZ || {};

(() => {
  'use strict';
  const PHZ = window.PHZ;

  const SYL_PER_SEC = 4.2; // tốc độ đọc ước lượng ở rate 1 (âm tiết/giây)
  const MAX_LATE = 1.0; // trễ quá số giây này so với đầu câu thì bỏ câu, không đọc nữa
  const QUEUE_SLACK = 0.7; // câu trước còn ít hơn chừng này giây thì cho đọc nối, không cắt

  // Tốc độ cần để đọc hết câu trong khoảng thời gian cho phép.
  PHZ.fitRate = function (text, available, userRate, playbackRate = 1) {
    const syl = String(text).trim().split(/\s+/).filter(Boolean).length;
    const need = syl / (Math.max(0.6, available) * SYL_PER_SEC);
    const rate = Math.min(Math.max(userRate, need), userRate * 1.45, 2);
    return Math.round(rate * playbackRate * 100) / 100;
  };

  // Thời gian được phép đọc: tới đầu câu sau, nhưng không quá cuối câu + 1 giây.
  PHZ.availableTime = function (lines, i) {
    const cur = lines[i];
    const own = cur.end - cur.start;
    const next = lines[i + 1];
    const limit = next ? next.start - cur.start : own + 1.0;
    return Math.max(own, Math.min(limit, own + 1.0));
  };

  // ---------- Giọng của trình duyệt ----------
  class BrowserVoice {
    constructor() {
      this.current = null;
    }
    static voices() {
      try {
        return speechSynthesis.getVoices().filter((v) => /^vi/i.test(v.lang));
      } catch (e) {
        return [];
      }
    }
    prefetch() {}
    speak(line, rate, s, onEnd) {
      const u = new SpeechSynthesisUtterance(line.text);
      u.lang = 'vi-VN';
      const voices = BrowserVoice.voices();
      u.voice = voices.find((v) => v.name === s.voiceName) || voices[0] || null;
      u.rate = rate;
      u.volume = s.narrVolume;
      u.onend = u.onerror = () => {
        if (this.current === u) this.current = null;
        onEnd();
      };
      this.current = u;
      speechSynthesis.speak(u);
      return true;
    }
    cancel() {
      this.current = null;
      speechSynthesis.cancel();
    }
    pause() {
      speechSynthesis.pause();
    }
    resume() {
      speechSynthesis.resume();
    }
  }

  // ---------- Máy chủ đọc trên máy ----------
  class ServerVoice {
    constructor() {
      this.ctx = null;
      this.cache = new Map(); // key -> Promise<AudioBuffer>
      this.source = null;
      this.lastError = null;
    }
    ensureCtx() {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
      }
      return this.ctx;
    }
    key(line, rate) {
      return line.text + '|' + line.g + '|' + rate;
    }
    load(line, rate, s) {
      const k = this.key(line, rate);
      if (!this.cache.has(k)) {
        const url = s.serverUrl.replace(/\/+$/, '') + '/tts';
        const p = chrome.runtime
          .sendMessage({ type: 'PHZ_FETCH_AUDIO', url, body: { text: line.text, voice: line.g, rate } })
          .then((res) => {
            if (!res || !res.ok) throw new Error((res && res.error) || 'Máy chủ đọc không phản hồi');
            const bin = atob(res.base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return this.ensureCtx().decodeAudioData(bytes.buffer);
          });
        p.catch((e) => {
          this.lastError = e.message;
          this.cache.delete(k);
        });
        this.cache.set(k, p);
        if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
      }
      return this.cache.get(k);
    }
    prefetch(line, rate, s) {
      this.load(line, rate, s).catch(() => {});
    }
    speak(line, rate, s, onEnd, isStillWanted) {
      this.load(line, rate, s)
        .then((buf) => {
          if (!isStillWanted()) return onEnd();
          const ctx = this.ensureCtx();
          if (ctx.state === 'suspended') ctx.resume();
          this.cancel();
          const src = ctx.createBufferSource();
          src.buffer = buf;
          this.gain.gain.value = s.narrVolume;
          src.connect(this.gain);
          src.onended = () => {
            if (this.source === src) this.source = null;
            onEnd();
          };
          this.source = src;
          src.start();
        })
        .catch(() => onEnd());
      return true;
    }
    cancel() {
      if (this.source) {
        const src = this.source;
        this.source = null;
        try {
          src.onended = null;
          src.stop();
        } catch (e) {}
      }
    }
    pause() {
      if (this.ctx) this.ctx.suspend();
    }
    resume() {
      if (this.ctx) this.ctx.resume();
    }
  }

  // ---------- Điều phối ----------
  class Narrator {
    constructor(settings) {
      this.settings = settings;
      this.engines = { browser: new BrowserVoice(), server: new ServerVoice() };
      this.lines = [];
      this.next = 0;
      this.lastT = null;
      this.speaking = null; // {index, startedAt (giây đồng hồ), expected (giây)}
      this.paused = false;
      this.video = null;
      this.ducked = false;
      this.baseVolume = 1;
      this.ourVolumeChange = false;
      this.unduckTimer = null;
      this.onVolumeChange = () => {
        if (this.ourVolumeChange) {
          this.ourVolumeChange = false;
          return;
        }
        // Người dùng tự chỉnh âm lượng trong lúc đang nhỏ tiếng → coi đó là mức mới.
        if (this.ducked) {
          this.ducked = false;
          this.baseVolume = this.video.volume;
        }
      };
    }

    get engine() {
      return this.engines[this.settings.data.engine] || this.engines.browser;
    }

    get lastError() {
      return this.engines.server.lastError;
    }

    setLines(lines) {
      if (lines === this.lines) return;
      const same = lines.length === this.lines.length && lines.every((l, i) => l.text === this.lines[i].text);
      this.lines = lines;
      if (!same) this.resync(this.lastT == null ? 0 : this.lastT);
    }

    setVideo(video) {
      if (video === this.video) return;
      this.stop();
      if (this.video) this.video.removeEventListener('volumechange', this.onVolumeChange);
      this.video = video;
      this.lastT = null; // video mới: lần tick đầu không bị coi là tua
      if (video) video.addEventListener('volumechange', this.onVolumeChange);
    }

    // Sau khi tua (hoặc vừa thấy video): câu vừa bắt đầu chưa lâu vẫn được đọc.
    resync(t) {
      let i = 0;
      while (i < this.lines.length && this.lines[i].start < t - MAX_LATE * 0.8) i++;
      this.next = i;
    }

    setVolume(v) {
      if (!this.video) return;
      this.ourVolumeChange = true;
      this.video.volume = Math.max(0, Math.min(1, v));
      // Không đổi gì thì trình duyệt không bắn sự kiện → xoá cờ.
      setTimeout(() => (this.ourVolumeChange = false), 0);
    }

    duck() {
      clearTimeout(this.unduckTimer);
      if (this.ducked || !this.video || this.video.muted) return;
      this.baseVolume = this.video.volume;
      this.ducked = true;
      this.setVolume(this.baseVolume * this.settings.data.duck);
    }

    unduckSoon() {
      clearTimeout(this.unduckTimer);
      this.unduckTimer = setTimeout(() => {
        if (this.speaking || !this.ducked) return;
        this.ducked = false;
        this.setVolume(this.baseVolume);
      }, 300);
    }

    stop() {
      this.engines.browser.cancel();
      this.engines.server.cancel();
      this.speaking = null;
      this.paused = false;
      clearTimeout(this.unduckTimer);
      if (this.ducked) {
        this.ducked = false;
        this.setVolume(this.baseVolume);
      }
    }

    // Gọi liên tục từ vòng lặp chính; t là thời gian phim (đã cộng lệch).
    tick(t) {
      const s = this.settings.data;
      const video = this.video;
      if (!s.narrate || !video || !this.lines.length) {
        if (this.speaking || this.ducked) this.stop();
        this.lastT = null;
        return;
      }
      // Tua (nhảy xa hơn mức chạy bình thường) hoặc vừa bật → dừng câu đang đọc, tìm lại vị trí.
      if (this.lastT == null || t < this.lastT - 0.25 || t > this.lastT + 1.5 || video.seeking) {
        this.stop();
        this.resync(t);
      }
      this.lastT = t;

      if (video.paused) {
        if (this.speaking && !this.paused) {
          this.engine.pause();
          this.paused = true;
        }
        return;
      }
      if (this.paused) {
        this.engine.resume();
        this.paused = false;
      }

      const rateFor = (i) => PHZ.fitRate(this.lines[i].text, PHZ.availableTime(this.lines, i), s.rate, video.playbackRate || 1);

      // Tải trước vài câu sắp tới (chỉ có tác dụng với máy chủ đọc).
      for (let i = this.next; i < Math.min(this.lines.length, this.next + 5); i++) {
        this.engine.prefetch(this.lines[i], rateFor(i), s);
      }

      while (this.next < this.lines.length && this.lines[this.next].start <= t) {
        const i = this.next++;
        const line = this.lines[i];
        if (t - line.start > MAX_LATE) continue; // đã quá trễ, bỏ câu này
        const rate = rateFor(i);
        if (this.speaking) {
          const elapsed = performance.now() / 1000 - this.speaking.startedAt;
          const left = this.speaking.expected - elapsed;
          if (left > QUEUE_SLACK) this.engine.cancel();
        }
        const syl = line.text.split(/\s+/).length;
        const token = { index: i, startedAt: performance.now() / 1000, expected: syl / (SYL_PER_SEC * rate) };
        this.speaking = token;
        this.duck();
        const engine = this.engine;
        engine.speak(
          line,
          rate,
          s,
          () => {
            if (this.speaking === token) {
              this.speaking = null;
              this.unduckSoon();
            }
          },
          () => this.speaking === token && this.lastT - line.start < MAX_LATE + 0.5
        );
      }
    }
  }

  PHZ.Narrator = Narrator;
  PHZ.BrowserVoice = BrowserVoice;
})();
