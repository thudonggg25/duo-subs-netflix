/*
 * main.js — điều phối: nhận phản hồi từ sniffer, chọn track, tìm video chính,
 * chạy vòng lặp hiển thị phụ đề và thuyết minh.
 */
(() => {
  'use strict';
  const PHZ = window.PHZ;
  const Settings = PHZ.Settings;
  const SRC_PAGE = 'PHZ_PAGE';
  const SRC_CS = 'PHZ_CS';

  const sources = new PHZ.Sources();
  const translator = new PHZ.Translator();
  const narrator = new PHZ.Narrator(Settings);

  const state = {
    group: null, // key nhóm đang dùng
    pinned: false, // người dùng tự chọn nhóm → không tự nhảy sang nhóm mới
    sel: ['', ''], // track id cho Phụ đề 1 / 2 ('ai' = bản dịch AI)
    cues: [null, null],
    status: ['', ''],
    token: [0, 0],
    video: null,
  };

  // ---------- Chọn nhóm / track ----------

  function groupsSorted() {
    return Array.from(sources.groups.values()).sort((a, b) => b.at - a.at);
  }

  function currentTracks() {
    const g = sources.groups.get(state.group);
    return g ? g.tracks : [];
  }

  function trackById(id) {
    return currentTracks().find((t) => t.id === id) || null;
  }

  function chooseGroup(key) {
    state.group = key;
    state.pinned = true;
    applyDefaults();
  }

  function applyDefaults() {
    const { t1, vi } = PHZ.pickDefaults(currentTracks());
    state.sel = [t1 ? t1.id : '', vi ? vi.id : t1 ? 'ai' : ''];
    loadSlot(0);
    loadSlot(1);
  }

  function chooseTrack(idx, id) {
    state.sel[idx] = id;
    loadSlot(idx);
    if (idx === 0 && state.sel[1] === 'ai') loadSlot(1);
  }

  async function loadSlot(idx) {
    const token = ++state.token[idx];
    state.cues[idx] = null;
    const id = state.sel[idx];
    if (!id) {
      state.status[idx] = '';
      return refresh();
    }
    if (id === 'ai') return attachTranslator(token);
    const track = trackById(id);
    if (!track) return;
    state.status[idx] = `Phụ đề ${idx + 1}: đang tải…`;
    refresh();
    try {
      const cues = await sources.load(track);
      if (token !== state.token[idx]) return;
      state.cues[idx] = cues;
      state.status[idx] = `Phụ đề ${idx + 1}: ${cues.length} câu`;
      if (idx === 0 && state.sel[1] === 'ai') attachTranslator(state.token[1]);
    } catch (e) {
      if (token !== state.token[idx]) return;
      state.status[idx] = `Phụ đề ${idx + 1}: lỗi ${e.message}`;
    }
    refresh();
  }

  // Phụ đề 2 = bản dịch AI của Phụ đề 1.
  async function attachTranslator(token) {
    const src = trackById(state.sel[0]);
    const srcCues = state.cues[0];
    if (!src || !srcCues) {
      state.status[1] = state.sel[0] ? 'Phụ đề 2: chờ Phụ đề 1 tải xong' : 'Phụ đề 2: chọn Phụ đề 1 làm bản gốc để dịch';
      return refresh();
    }
    const series = translator.series || PHZ.guessSeries(document.title);
    await translator.attach(srcCues, { series, lang: src.lang, model: Settings.data.model });
    if (token !== state.token[1]) return;
    state.status[1] = 'Phụ đề 2: tiếng Việt AI';
    const hasOfficialVi = currentTracks().some((t) => /^vi/i.test(t.lang) && !t.forced);
    if (Settings.data.autoTranslate && !hasOfficialVi && Settings.data.apiKey && translator.status !== 'done') {
      translator.run(videoTime());
    }
    refresh();
  }

  function toggleTranslate(forceStart) {
    if (translator.running && !forceStart) return translator.stop();
    if (state.sel[1] !== 'ai') {
      state.sel[1] = 'ai';
      loadSlot(1).then(() => translator.run(videoTime()));
      return;
    }
    translator.run(videoTime());
  }

  function nudgeOffset(d) {
    const host = location.hostname;
    Settings.setOffset(host, Settings.offsetFor(host) + d);
  }

  // Nguồn lời thuyết minh: 'ai' (trường tm của bản dịch), 'vi' (phụ đề Việt chính thức) hoặc ''.
  function narrationSource() {
    if (state.sel[1] === 'ai') return 'ai';
    const t = trackById(state.sel[1]);
    return t && /^vi/i.test(t.lang) ? 'vi' : '';
  }

  let viNarration = { cues: null, lines: [] };
  function narrationLines() {
    const src = narrationSource();
    if (src === 'ai') return translator.narration();
    if (src === 'vi' && state.cues[1]) {
      if (viNarration.cues !== state.cues[1]) {
        viNarration = {
          cues: state.cues[1],
          lines: state.cues[1]
            .map((c) => ({
              start: c.start,
              end: c.end,
              // bỏ ghi chú âm thanh và gạch đầu dòng, chỉ đọc lời thoại
              text: PHZ.cueText(c).replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ').replace(/^\s*-\s*/gm, '').replace(/\s+/g, ' ').trim(),
              g: '',
            }))
            .filter((l) => l.text),
        };
      }
      return viNarration.lines;
    }
    return [];
  }

  // ---------- Nhận dữ liệu từ sniffer ----------

  sources.onChange((group) => {
    const latest = sources.latest();
    const switchTo = !state.group || (!state.pinned && latest && latest.key === group.key && group.key !== state.group);
    if (switchTo) {
      state.group = group.key;
      translator.series = PHZ.guessSeries(document.title);
      applyDefaults();
    } else {
      refresh();
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== SRC_PAGE) return;
    if (ev.data.type === 'capture' && ev.data.item) sources.ingest(ev.data.item);
  });

  // ---------- Video và vòng lặp ----------

  function findVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (v.readyState > 0 && area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function videoTime() {
    const v = state.video;
    return v ? v.currentTime + Settings.offsetFor(location.hostname) : 0;
  }

  let overlay = null;
  let panel = null;
  const refresh = () => panel && panel.refresh();

  function frame() {
    try {
      const s = Settings.data;
      overlay.place(state.video, panel.open);
      overlay.applyStyle(s);
      const t = videoTime();
      const pick = (cues, show) => (show && cues ? PHZ.findActiveCues(cues, t).map((i) => cues[i]) : []);
      const cues2 = state.sel[1] === 'ai' ? translator.cues() : state.cues[1];
      overlay.show(pick(state.cues[0], s.show1), pick(cues2, s.show2));
      narrator.setLines(narrationLines());
      narrator.tick(t);
    } catch (e) {
      console.warn('[phimhz]', e);
    }
    requestAnimationFrame(frame);
  }

  async function init() {
    await Settings.load();
    const app = {
      state,
      sources,
      translator,
      narrator,
      groupsSorted,
      currentTracks,
      chooseGroup,
      chooseTrack,
      toggleTranslate,
      nudgeOffset,
      narrationSource,
    };
    overlay = new PHZ.Overlay({ onButton: () => panel.toggle() });
    panel = new PHZ.Panel(app);
    overlay.root.appendChild(panel.el);
    PHZ.app = app;
    translator.onChange(refresh);
    // Video đổi (SPA, sang tập mới) → cập nhật.
    setInterval(() => {
      const v = findVideo();
      if (v !== state.video) {
        state.video = v;
        narrator.setVideo(v);
      }
      refresh();
    }, 1000);
    window.postMessage({ source: SRC_CS, type: 'replay' }, '*');
    requestAnimationFrame(frame);
  }

  if (document.documentElement) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
