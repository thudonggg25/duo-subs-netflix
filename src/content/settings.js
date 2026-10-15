/*
 * settings.js — giá trị mặc định + đọc/ghi cài đặt bằng chrome.storage.local.
 *
 * Tất cả file content script chạy chung một "isolated world", nên chia sẻ
 * namespace window.NDS.
 */
window.NDS = window.NDS || {};

(() => {
  'use strict';
  const NDS = window.NDS;
  const STORAGE_KEY = 'ndsSettings';

  // Kiểu hiển thị mặc định của từng phụ đề.
  // - fontSize: cỡ chữ (px) khi player cao 720px; tự co giãn theo chiều cao player.
  // - position: toạ độ điểm "giữa-đáy" của khối phụ đề, tính theo % kích thước player.
  NDS.DEFAULT_STYLES = [
    {
      fontSize: 28,
      color: '#ffffff',
      effect: 'outline', // 'none' | 'outline' | 'shadow'
      effectColor: '#000000',
      bgEnabled: false,
      bgColor: '#000000',
      bgOpacity: 0.5,
      phonetic: false, // Furigana trên chữ Kanji (khi phụ đề là tiếng Nhật)
      position: { x: 50, y: 78 },
    },
    {
      fontSize: 26,
      color: '#ffe066',
      effect: 'outline',
      effectColor: '#000000',
      bgEnabled: false,
      bgColor: '#000000',
      bgOpacity: 0.5,
      phonetic: false,
      position: { x: 50, y: 92 },
    },
    // Dòng Pinyin riêng (khi chỉ bật phụ đề tiếng Trung, hoặc bật Pinyin cùng ngôn ngữ khác).
    {
      fontSize: 22,
      color: '#bfe3ff',
      effect: 'outline',
      effectColor: '#000000',
      bgEnabled: false,
      bgColor: '#000000',
      bgOpacity: 0.5,
      phonetic: false,
      position: { x: 50, y: 92 },
    },
  ];

  // Bố cục chung của 2 phụ đề (mỗi phụ đề vẫn kéo riêng được).
  // - avoidOverlap: khi 2 phụ đề sắp đè lên nhau (vd. câu dài 2 dòng), tự đẩy phụ đề
  //   KHÔNG vừa được kéo ra xa, giữ khoảng cách `gap`.
  // - gap: khoảng cách tối thiểu (px khi player cao 720px).
  // - liftWithControls: đẩy phụ đề lên khi thanh điều khiển Netflix hiện, để không bị che.
  NDS.DEFAULT_LAYOUT = {
    avoidOverlap: true,
    gap: 8,
    liftWithControls: true,
  };

  // Lựa chọn track lưu theo NGÔN NGỮ + loại (subtitles/closedcaptions) chứ không
  // theo id, để áp dụng lại được cho phim/tập khác. null = "Tắt".
  NDS.DEFAULT_SETTINGS = {
    enabled: true,
    tracks: [
      { language: 'en', kind: 'subtitles' },
      { language: 'vi', kind: 'subtitles' },
    ],
    styles: NDS.DEFAULT_STYLES,
    layout: NDS.DEFAULT_LAYOUT,
    // Ngôn ngữ giao diện: 'vi' | 'en' (mặc định theo ngôn ngữ trình duyệt).
    uiLang: /^vi\b/i.test(navigator.language || '') ? 'vi' : 'en',
    // Khung "Câu thoại" song ngữ đang mở hay không.
    transcriptOpen: false,
    // Vị trí/cỡ khung câu thoại theo % player ({x, y, w, h}); null = mặc định.
    transcriptBox: null,
    // Độ mờ nền khung câu thoại (0–1).
    transcriptBg: 0.75,
    // Ngôn ngữ 2 dòng của khung câu thoại: 'auto' (như phụ đề trên màn hình) | null (tắt) | {language, kind}.
    transcriptTracks: ['auto', 'auto'],
    // Hiện phiên âm (Pinyin / Furigana) trong khung câu thoại.
    transcriptPhonetic: true,
    // Pinyin cho phụ đề trên màn hình:
    // - enabled: bật/tắt.
    // - track: nguồn chữ Hán khi không có phụ đề tiếng Trung nào đang bật: 'auto' | {language, kind}.
    // Cách hiện tự đổi theo phụ đề đang bật (xem main.js → pinyinPlan).
    pinyin: { enabled: false, track: 'auto' },
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Trộn dữ liệu đã lưu với mặc định (để bản cập nhật thêm field mới không bị thiếu).
  function mergeDefaults(def, saved) {
    if (saved === undefined) return clone(def);
    if (def === null || typeof def !== 'object' || Array.isArray(def) !== Array.isArray(saved)) {
      return saved;
    }
    if (Array.isArray(def)) return def.map((d, i) => mergeDefaults(d, saved[i]));
    if (saved === null || typeof saved !== 'object') return clone(def);
    const out = {};
    for (const k of Object.keys(def)) out[k] = mergeDefaults(def[k], saved[k]);
    return out;
  }

  let saveTimer = null;

  // Extension còn "sống" không? Sau khi bấm Reload ở chrome://extensions, script cũ vẫn chạy
  // trong tab Netflix đang mở nhưng mọi lệnh chrome.* đều lỗi "Extension context invalidated".
  NDS.extAlive = function () {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  };

  NDS.Settings = {
    data: clone(NDS.DEFAULT_SETTINGS),

    async load() {
      try {
        const res = await chrome.storage.local.get(STORAGE_KEY);
        const saved = res[STORAGE_KEY];
        this.data = mergeDefaults(NDS.DEFAULT_SETTINGS, saved);
        // tracks[i] được phép là null ("Tắt"); mergeDefaults không ghi đè null đã lưu.
        if (saved && Array.isArray(saved.tracks)) {
          this.data.tracks = [0, 1].map((i) =>
            saved.tracks[i] === undefined ? clone(NDS.DEFAULT_SETTINGS.tracks[i]) : saved.tracks[i]
          );
        }
      } catch (e) {
        console.info('[Dual Subs] Không đọc được cài đặt, dùng mặc định:', e);
        this.data = clone(NDS.DEFAULT_SETTINGS);
      }
      return this.data;
    },

    // Ghi có debounce (kéo thả/thanh trượt gọi rất nhiều lần).
    save() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!NDS.extAlive()) return;
        try {
          chrome.storage.local.set({ [STORAGE_KEY]: this.data }).catch((e) => {
            console.info('[Dual Subs] Không lưu được cài đặt:', e);
          });
        } catch (e) {
          console.info('[Dual Subs] Không lưu được cài đặt:', e);
        }
      }, 300);
    },

    // "Đặt lại mặc định": đưa kiểu chữ, vị trí và bố cục về mặc định
    // (giữ nguyên lựa chọn ngôn ngữ và trạng thái bật/tắt).
    resetStyles() {
      this.data.styles = clone(NDS.DEFAULT_STYLES);
      this.data.layout = clone(NDS.DEFAULT_LAYOUT);
      this.data.transcriptBox = null;
      this.data.transcriptBg = NDS.DEFAULT_SETTINGS.transcriptBg;
      this.save();
    },
  };
})();
