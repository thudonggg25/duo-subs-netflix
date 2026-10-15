/*
 * main.js — điều phối: nhận manifest từ page script, theo dõi chuyển phim (SPA),
 * gắn UI vào đúng container của player, chạy vòng lặp đồng bộ phụ đề.
 */
(() => {
  'use strict';
  const NDS = window.NDS;
  const Settings = NDS.Settings;

  const SRC_PAGE = 'NDS_PAGE';
  const SRC_CS = 'NDS_CS';

  // ĐIỂM DỄ HỎNG: selector của Netflix, có thể đổi khi họ cập nhật giao diện.
  const PLAYER_SELECTORS = '.watch-video--player-view, [data-uia="player"], .watch-video, .NFPlayer, .nf-player-container';
  const CONTROLS_SELECTORS = '[data-uia="controls-standard"], .watch-video--bottom-controls-container, .PlayerControlsNeo__layout';
  const MOUSE_IDLE_MS = 3000;

  const state = {
    manifests: new Map(), // movieId -> {movieId, tracks, receivedAt}
    movieId: null, // id trong URL /watch/<id>
    navAt: 0, // thời điểm chuyển sang phim hiện tại
    tracksLoaded: false,
    lastUnmatched: null, // manifest mới nhất không khớp id trong URL (dự phòng)
    tracks: [],
    selected: [null, null], // track id đang chọn cho Phụ đề 1 / 2
    cues: [null, null],
    trackStatus: [null, null], // thông báo dạng {key, params} (xem i18n.js)
    movieStatus: null,
    loadToken: [0, 0], // chống race khi đổi track liên tục
    video: null,
    panelOpen: false,
    lastMouseMove: 0,
    // Pinyin trên màn hình (tính lại ở mỗi refreshUI, xem pinyinPlan).
    pinyin: { mode: null, cues: null, status: null }, // mode: 'ruby' | 'line' | null
  };

  // ---------- Dựng UI ----------
  const root = document.createElement('div');
  root.className = 'nds-root notranslate';
  // Chặn Google Translate của Chrome tự dịch chữ phụ đề (để luôn là phụ đề gốc của Netflix).
  root.setAttribute('translate', 'no');

  const overlay = new NDS.Overlay({
    onPositionChange(idx, pos) {
      Settings.data.styles[idx].position = pos;
      Settings.save();
      applyStyles();
    },
    onFontSize(idx, size) {
      Settings.data.styles[idx].fontSize = size;
      Settings.save();
      refreshUI();
    },
  });

  const menu = new NDS.Menu({
    onToggleEnabled(enabled) {
      Settings.data.enabled = enabled;
      Settings.save();
      refreshUI();
    },
    onSelectTrack(idx, trackId) {
      const track = state.tracks.find((t) => t.id === trackId) || null;
      selectTrack(idx, track, { savePref: true });
    },
    onStyleChange(idx, patch) {
      Object.assign(Settings.data.styles[idx], patch);
      Settings.save();
      refreshUI();
    },
    onLayoutChange(patch) {
      Object.assign(Settings.data.layout, patch);
      Settings.save();
      refreshUI();
    },
    onLanguageChange(lang) {
      Settings.data.uiLang = lang;
      Settings.save();
      overlay.applyLanguage();
      refreshUI();
      if (state.panelOpen) requestDiag();
    },
    onReset() {
      Settings.resetStyles();
      transcript.setBox(null);
      transcript.setBgOpacity(Settings.data.transcriptBg);
      refreshUI();
    },
    onOpenChange(open) {
      state.panelOpen = open;
      if (open) requestDiag();
      overlay.setPreview(open);
      updateButtonVisibility();
    },
    onToggleTranscript() {
      setTranscriptOpen(!Settings.data.transcriptOpen);
    },
    onPinyinToggle(enabled) {
      Settings.data.pinyin.enabled = enabled;
      Settings.save();
      refreshUI();
    },
    onPinyinTrack(value) {
      const track = value && value !== 'auto' ? trackById(value) : null;
      Settings.data.pinyin.track = track ? { language: track.language, kind: track.kind } : 'auto';
      Settings.save();
      refreshUI();
    },
  });

  // Khung "Câu thoại" song ngữ.
  const transcript = new NDS.Transcript({
    onSeek: (time) => seekTo(time),
    onNav: (dir) => navLine(dir),
    onClose: () => setTranscriptOpen(false),
    onBoxChange(box) {
      Settings.data.transcriptBox = box;
      Settings.save();
    },
    onBgOpacity(v) {
      Settings.data.transcriptBg = v;
      Settings.save();
    },
    onTrackChange(idx, value) {
      let pref = 'auto';
      if (value === '') pref = null;
      else if (value !== 'auto') {
        const track = state.tracks.find((t) => t.id === value);
        pref = track ? { language: track.language, kind: track.kind } : 'auto';
      }
      Settings.data.transcriptTracks[idx] = pref;
      Settings.save();
      refreshUI();
    },
    onPhoneticToggle() {
      Settings.data.transcriptPhonetic = !Settings.data.transcriptPhonetic;
      Settings.save();
      refreshUI();
    },
  });

  // Từ điển tiếng Nhật tải xong → vẽ lại khung câu thoại (phụ đề màn hình tự vẽ lại ở khung hình sau).
  NDS.Phonetic.onReady(() => refreshUI());

  function trackById(id) {
    return (id && state.tracks.find((t) => t.id === id)) || null;
  }

  // Loại phiên âm cho một track nếu đang bật và đã sẵn sàng ('zh' | 'ja' | null).
  function phoneticKind(track, enabled) {
    if (!enabled || !track) return null;
    const kind = NDS.Phonetic.kind(track.language);
    return kind && NDS.Phonetic.ready(kind) ? kind : null;
  }

  // ---------- Nguồn phụ đề cho khung câu thoại (chọn riêng, không phụ thuộc phụ đề màn hình) ----------
  const trCues = new Map(); // trackId -> cues (track tải riêng cho khung câu thoại)
  const trLoading = new Set();

  // Cue của một track bất kỳ: lấy lại của Phụ đề 1/2 nếu trùng, không thì tải riêng (1 lần, có cache).
  // Trả về null khi đang tải; tải xong sẽ tự gọi refreshUI.
  function cuesFor(track) {
    const j = state.selected.indexOf(track.id);
    if (j >= 0) return state.cues[j];
    if (!trCues.has(track.id) && !trLoading.has(track.id)) {
      trLoading.add(track.id);
      NDS.loadTrackCues(track)
        .then((cues) => trCues.set(track.id, cues))
        .catch((err) => {
          trCues.set(track.id, []);
          console.info('[Dual Subs] Lỗi tải phụ đề phụ', track, err);
        })
        .finally(() => {
          trLoading.delete(track.id);
          refreshUI();
        });
    }
    return trCues.get(track.id) || null;
  }

  function transcriptSources() {
    return [0, 1].map((idx) => {
      const pref = Settings.data.transcriptTracks[idx];
      if (pref === 'auto') return { value: 'auto', cues: state.cues[idx], track: trackById(state.selected[idx]) };
      const track = resolvePref(pref);
      if (!track) return { value: '', cues: null, track: null };
      return { value: track.id, cues: cuesFor(track), track };
    });
  }

  // ---------- Pinyin trên màn hình ----------
  const isZh = (track) => !!track && NDS.Phonetic.kind(track.language) === 'zh';
  const zhTracks = () => state.tracks.filter((t) => t.status === 'text' && !t.forced && isZh(t));

  /**
   * Quyết định cách hiện Pinyin theo các phụ đề đang bật:
   *   - Bật 2 phụ đề, có 1 phụ đề tiếng Trung → 'ruby': Pinyin nhỏ trên chữ Hán của phụ đề đó.
   *   - Chỉ bật phụ đề tiếng Trung → 'line': Pinyin thành dòng riêng (như phụ đề thứ 2).
   *   - Không bật phụ đề tiếng Trung nào (đang xem Việt/Anh…) → 'line' từ track tiếng Trung của phim
   *     (tự chọn, hoặc theo "Nguồn chữ Hán" trong panel).
   */
  function pinyinPlan() {
    const P = Settings.data.pinyin;
    const plan = { mode: null, cues: null, rubyIdx: [], status: null };
    if (!P.enabled) {
      plan.status = { key: 'pinyinOffHint' };
      return plan;
    }
    const active = [0, 1].filter((i) => state.selected[i]);
    const zhIdx = active.filter((i) => isZh(trackById(state.selected[i])));
    if (zhIdx.length && active.length === 2) {
      plan.mode = 'ruby';
      plan.rubyIdx = zhIdx;
      plan.status = { key: 'pinyinRuby' };
      return plan;
    }
    plan.mode = 'line';
    plan.status = { key: 'pinyinLine' };
    if (zhIdx.length) {
      plan.cues = state.cues[zhIdx[0]];
      return plan;
    }
    const list = zhTracks();
    const track =
      (P.track !== 'auto' && resolvePref(P.track)) ||
      list.find((t) => /^zh-(hans|cn)/i.test(t.language)) ||
      list[0] ||
      null;
    if (!track) {
      plan.mode = null;
      plan.status = state.tracksLoaded ? { key: 'pinyinNoZh' } : null;
      return plan;
    }
    plan.cues = cuesFor(track);
    if (!plan.cues) plan.status = { key: 'pinyinLoading' };
    return plan;
  }

  function updateTranscript() {
    const src = transcriptSources();
    const textTracks = state.tracks.filter((t) => t.status === 'text' && !t.forced);
    transcript.setTrackOptions(textTracks, src.map((s) => s.value), [trackLabel(0), trackLabel(1)]);
    const on = Settings.data.transcriptPhonetic;
    transcript.setData(src[0].cues, src[1].cues, src.map((s) => phoneticKind(s.track, on)), on);
  }

  root.append(overlay.el, transcript.el, menu.buttons, menu.panel);

  function setTranscriptOpen(open) {
    Settings.data.transcriptOpen = open;
    Settings.save();
    transcript.setOpen(open);
    menu.setTranscriptOpen(open);
  }

  // ---------- Tua theo câu ----------
  // Lệnh tua gửi sang page script (world MAIN) vì chỉ ở đó mới gọi được API player của Netflix.
  function seekTo(time) {
    if (!state.video) return;
    window.postMessage({ source: SRC_CS, type: 'seek', time: time + 0.01 }, window.location.origin);
  }

  // dir: -1 = câu trước, 0 = nghe lại câu hiện tại, 1 = câu sau.
  function navLine(dir) {
    const rows = transcript.rows;
    if (!state.video || !rows.length) return;
    const i = NDS.rowIndexAt(rows, state.video.currentTime + 0.05);
    const target = Math.min(rows.length - 1, Math.max(0, dir === 0 ? i : i + dir));
    seekTo(rows[target].start);
  }

  function trackLabel(idx) {
    const track = state.selected[idx] && state.tracks.find((t) => t.id === state.selected[idx]);
    return track ? track.label || track.language || '' : '';
  }

  // Co giãn cỡ chữ theo kích thước player (đổi cỡ cửa sổ, fullscreen).
  new ResizeObserver(() => applyStyles()).observe(root);

  // ---------- Giao tiếp với page script ----------
  function requestManifests() {
    window.postMessage({ source: SRC_CS, type: 'request-manifests' }, window.location.origin);
  }

  function onPageMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== SRC_PAGE) return;
    if (data.type === 'manifest') handleManifest(data.payload);
    else if (data.type === 'navigation') checkNavigation();
    else if (data.type === 'diag') renderDiag(data.payload);
  }

  // ---------- Chẩn đoán (hiển thị trong panel) ----------
  let lastDiag = null;
  let lastDiagAt = 0;
  let diagRequestedAt = 0;

  function requestDiag() {
    diagRequestedAt = Date.now();
    window.postMessage({ source: SRC_CS, type: 'request-diag' }, window.location.origin);
    // Không có phản hồi sau 1 giây → page script không chạy.
    setTimeout(() => {
      if (lastDiagAt < diagRequestedAt) renderDiag(null);
    }, 1000);
  }

  function renderDiag(d) {
    if (d) {
      lastDiag = d;
      lastDiagAt = Date.now();
    }
    const t = NDS.t;
    const yesNo = (v) => (v ? t('yes') : t('no'));
    const lines = [
      `${t('dVersion')}: ${NDS.extAlive() ? chrome.runtime.getManifest().version : '?'}`,
      `URL: ${location.pathname}  (movieId: ${state.movieId || '-'})`,
      `${t('dPageScript')}: ${yesNo(d)}`,
      `${t('dVideo')}: ${yesNo(state.video)}`,
    ];
    if (d) {
      lines.push(
        `${t('dPatched')}: ${d.requestsPatched}`,
        `${t('dManifests')}: ${d.manifests.length ? d.manifests.join('; ') : t('none')}`,
        `${t('dUnrecognized')}: ${d.rawHits}`,
        ...d.unrecognized.map((u) => `  - ${u}`),
        `${t('dPlayerApi')}: ${d.playerApiTracks == null ? t('unreadable') : d.playerApiTracks || '-'}`
      );
    }
    lines.push(`${t('dCurrent')}: ${state.tracks.map((x) => `${x.language}/${x.status}`).join(', ') || t('none')}`);
    // Nguồn của từng phụ đề: tải thẳng file của Netflix theo URL trong manifest, không qua dịch máy.
    [0, 1].forEach((idx) => {
      const tr = state.tracks.find((x) => x.id === state.selected[idx]);
      const name = t('sub', { n: idx + 1 });
      if (!tr) return lines.push(`${name}: ${t('off')}`);
      let host = '?';
      try {
        host = new URL(tr.url).hostname;
      } catch (e) {}
      const n = state.cues[idx] ? t('dLines', { n: state.cues[idx].length }) : t('notLoaded');
      lines.push(`${name}: ${tr.label} [${tr.language}, ${tr.kind}] · track ${tr.id} · ${tr.format} · ${host} · ${n}`);
    });
    menu.setDiag(lines.join('\n'));
  }

  function handleManifest(payload) {
    if (!payload || !Array.isArray(payload.tracks)) return;
    state.manifests.set(payload.movieId, payload);
    if (payload.movieId === state.movieId) {
      setTracks(payload.tracks);
    } else {
      // Có thể là manifest tập kế tiếp Netflix tải trước, hoặc id trong URL khác
      // movieId của manifest. Giữ lại để dùng nếu không có manifest khớp.
      state.lastUnmatched = payload;
    }
  }

  // ---------- Theo dõi chuyển phim/tập (SPA) ----------
  function currentWatchId() {
    const m = /^\/watch\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function checkNavigation() {
    const id = currentWatchId();
    if (id === state.movieId) return;
    state.movieId = id;
    state.navAt = Date.now();
    state.tracksLoaded = false;
    state.tracks = [];
    state.selected = [null, null];
    state.cues = [null, null];
    state.trackStatus = [null, null];
    state.loadToken = state.loadToken.map((n) => n + 1);
    overlay.clear();

    if (id) {
      const cached = state.manifests.get(id);
      if (cached) {
        setTracks(cached.tracks);
        return;
      }
      state.movieStatus = { key: 'waitingTracks' };
      requestManifests();
    } else {
      state.movieStatus = null;
    }
    refreshUI();
  }

  // ---------- Chọn track ----------
  function resolvePref(pref) {
    if (!pref) return null;
    const usable = state.tracks.filter((t) => t.status === 'text' && !t.forced);
    return (
      usable.find((t) => t.language === pref.language && t.kind === pref.kind) ||
      usable.find((t) => t.language === pref.language) ||
      null
    );
  }

  function setTracks(tracks) {
    state.tracks = tracks;
    trCues.clear();
    state.tracksLoaded = true;
    const usable = tracks.filter((t) => t.status === 'text');
    if (tracks.length === 0) state.movieStatus = { key: 'noTracks' };
    else if (usable.length === 0) state.movieStatus = { key: 'imageOnlyMovie' };
    else state.movieStatus = null;

    for (const idx of [0, 1]) {
      const pref = Settings.data.tracks[idx];
      const track = resolvePref(pref);
      selectTrack(idx, track, { savePref: false });
      if (pref && !track) {
        state.trackStatus[idx] = { key: 'langMissing', params: { lang: pref.language } };
      }
    }
    refreshUI();
  }

  function selectTrack(idx, track, { savePref }) {
    const token = ++state.loadToken[idx];
    state.selected[idx] = track ? track.id : null;
    state.cues[idx] = null;
    state.trackStatus[idx] = null;
    overlay.render(idx, null, []);

    if (savePref) {
      Settings.data.tracks[idx] = track ? { language: track.language, kind: track.kind } : null;
      Settings.save();
    }
    if (!track) {
      refreshUI();
      return;
    }

    state.trackStatus[idx] = { key: 'loading' };
    refreshUI();
    NDS.loadTrackCues(track)
      .then((cues) => {
        if (token !== state.loadToken[idx]) return; // đã đổi track/phim khác
        state.cues[idx] = cues;
        state.trackStatus[idx] = cues.length ? null : { key: 'emptyTrack' };
        refreshUI();
      })
      .catch((err) => {
        if (token !== state.loadToken[idx]) return;
        console.info('[Dual Subs] Lỗi tải phụ đề', track, err);
        state.trackStatus[idx] = { key: 'loadError', params: { msg: err.message } };
        refreshUI();
      });
  }

  // ---------- Cập nhật giao diện ----------
  function refreshUI() {
    const enabled = Settings.data.enabled;
    root.classList.toggle('nds-off', !enabled);
    // Ẩn phụ đề gốc của Netflix khi dual sub bật và có ít nhất 1 phụ đề được chọn.
    document.documentElement.classList.toggle(
      'nds-hide-native',
      enabled && !!state.video && (state.selected.some(Boolean) || Settings.data.pinyin.enabled)
    );
    const plan = pinyinPlan();
    state.pinyin = plan;
    menu.update({
      settings: Settings.data,
      tracks: state.tracks,
      selected: state.selected,
      trackStatus: state.trackStatus,
      movieStatus: state.movieStatus,
      zhTracks: zhTracks(),
      pinyinValue: Settings.data.pinyin.track === 'auto' ? 'auto' : (resolvePref(Settings.data.pinyin.track) || {}).id || 'auto',
      pinyinStatus: plan.status,
    });
    transcript.applyLanguage();
    updateTranscript();
    // Phiên âm trên phụ đề màn hình: Pinyin theo pinyinPlan, Furigana bật riêng cho từng phụ đề.
    for (const idx of [0, 1]) {
      const track = trackById(state.selected[idx]);
      let kind = null;
      if (plan.rubyIdx.includes(idx)) kind = 'zh';
      else if (Settings.data.styles[idx].phonetic && track && NDS.Phonetic.kind(track.language) === 'ja') kind = 'ja';
      overlay.setPhonetic(idx, kind);
    }
    overlay.setPhonetic(2, plan.mode === 'line' ? 'pinyinLine' : null);
    applyStyles();
  }

  function applyStyles() {
    const height = root.isConnected ? root.getBoundingClientRect().height : 0;
    overlay.setModel(Settings.data.styles, Settings.data.layout, height);
  }

  // Nút nổi hiện/ẩn theo thanh điều khiển của Netflix; nếu không xác định được
  // trạng thái thanh điều khiển thì dựa vào việc chuột có đang di chuyển không.
  function netflixControlsVisible(container) {
    if (!container) return null;
    if (container.classList.contains('passive')) return false;
    if (container.classList.contains('active')) return true;
    const el = container.querySelector(CONTROLS_SELECTORS);
    if (!el) return null;
    for (let n = el; n && n !== container.parentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) return false;
    }
    return el.getBoundingClientRect().height > 0;
  }

  function updateButtonVisibility() {
    const container = state.video ? findContainer(state.video) : null;
    const nf = netflixControlsVisible(container);
    const mouseActive = Date.now() - state.lastMouseMove < MOUSE_IDLE_MS;
    const controlsShown = nf === null ? mouseActive : nf;
    menu.setButtonVisible(state.panelOpen || controlsShown);

    // Đẩy phụ đề lên khi thanh điều khiển hiện và phụ đề đang nằm sát đáy (bị che).
    // Không đẩy khi đang mở panel; khi chuột đang ở trên phụ đề thì overlay giữ nguyên vị trí.
    const lift =
      Settings.data.layout.liftWithControls &&
      controlsShown &&
      !state.panelOpen &&
      overlay.lowestBottom() > 82;
    overlay.setLift(lift ? 9 : 0);
  }

  function findContainer(video) {
    return video.closest(PLAYER_SELECTORS) || video.parentElement;
  }

  // ---------- Bảo trì định kỳ: điều hướng, video, container, fullscreen ----------
  // Extension vừa được Reload/gỡ: script cũ trong tab này tự dọn dẹp và dừng hẳn
  // (bản mới chỉ chạy sau khi tải lại trang), tránh ghi lỗi vào trang "Lỗi" của Chrome.
  let dead = false;
  const timers = [];
  function teardown() {
    dead = true;
    timers.forEach(clearInterval);
    window.removeEventListener('message', onPageMessage);
    root.remove();
    document.documentElement.classList.remove('nds-hide-native');
  }

  function maintain() {
    if (dead) return;
    if (!NDS.extAlive()) return teardown();
    checkNavigation();

    const video = state.movieId ? document.querySelector('video') : null;
    if (video !== state.video) {
      state.video = video;
      refreshUI();
    }
    if (!video) {
      if (root.isConnected) root.remove();
      menu.setOpen(false);
      return;
    }

    // Ở fullscreen chỉ phần tử fullscreen (và con của nó) được hiển thị,
    // nên UI phải nằm bên trong document.fullscreenElement.
    const container = findContainer(video);
    const fs = document.fullscreenElement;
    const mount = fs && fs !== video && !fs.contains(container) ? fs : container;
    if (root.parentNode !== mount) {
      mount.appendChild(root);
      applyStyles();
    }

    // Dự phòng: sau vài giây vẫn chưa có manifest khớp id trong URL thì dùng manifest
    // mới nhất nhận được quanh thời điểm chuyển phim.
    const fallback = state.lastUnmatched;
    if (
      !state.tracksLoaded &&
      fallback &&
      Date.now() - state.navAt > 3000 &&
      fallback.receivedAt >= state.navAt - 5000 &&
      fallback.receivedAt <= state.navAt + 15000
    ) {
      console.info('[Dual Subs] Dùng manifest movieId', fallback.movieId, 'cho /watch/' + state.movieId);
      setTracks(fallback.tracks);
    }
  }

  // ---------- Vòng lặp đồng bộ theo video.currentTime ----------
  function frame() {
    if (dead) return;
    requestAnimationFrame(frame);
    const video = state.video;
    if (!video || !root.isConnected) return;
    const t = video.currentTime;
    transcript.update(t);
    if (!Settings.data.enabled) return;
    for (const idx of [0, 1]) {
      const cues = state.cues[idx];
      overlay.render(idx, cues, cues ? NDS.findActiveCues(cues, t) : [], !!state.selected[idx]);
    }
    const p = state.pinyin;
    const pc = p.mode === 'line' ? p.cues : null;
    overlay.render(2, pc, pc ? NDS.findActiveCues(pc, t) : [], p.mode === 'line');
  }

  // ---------- Khởi động ----------
  async function init() {
    await Settings.load();
    // Đăng ký nhận message SAU khi đã có cài đặt, rồi xin page script gửi lại
    // các manifest đã bắt được trước đó.
    window.addEventListener('message', onPageMessage);
    requestManifests();

    document.addEventListener('mousemove', () => (state.lastMouseMove = Date.now()), true);
    // Phím tắt (bỏ qua khi đang gõ trong ô nhập liệu):
    //   Shift+D: bật/tắt phụ đề kép · A: câu trước · R: nghe lại câu · D: câu sau · T: khung câu thoại.
    // ĐIỂM DỄ HỎNG: nếu Netflix dùng thêm các phím này thì sẽ bị extension "giành" mất.
    const KEY_ACTIONS = {
      KeyA: () => navLine(-1),
      KeyR: () => navLine(0),
      KeyD: () => navLine(1),
      KeyT: () => setTranscriptOpen(!Settings.data.transcriptOpen),
    };
    document.addEventListener(
      'keydown',
      (e) => {
        if (dead || !state.video || e.ctrlKey || e.altKey || e.metaKey) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        let action = null;
        if (e.shiftKey) {
          if (e.code === 'KeyD') {
            action = () => {
              Settings.data.enabled = !Settings.data.enabled;
              Settings.save();
              refreshUI();
            };
          }
        } else {
          action = KEY_ACTIONS[e.code] || null;
        }
        if (!action) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat || e.code !== 'KeyT') action();
      },
      true
    );
    window.addEventListener('popstate', checkNavigation);
    document.addEventListener('fullscreenchange', maintain);
    timers.push(
      setInterval(maintain, 500),
      setInterval(updateButtonVisibility, 250),
      setInterval(() => state.panelOpen && requestDiag(), 2000)
    );

    maintain();
    refreshUI();
    transcript.setBox(Settings.data.transcriptBox);
    transcript.setBgOpacity(Settings.data.transcriptBg);
    if (Settings.data.transcriptOpen) setTranscriptOpen(true);
    requestAnimationFrame(frame);
  }

  init();
})();
