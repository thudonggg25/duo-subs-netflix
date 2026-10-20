# Thư viện bên thứ ba (giữ nguyên, không sửa)

| File | Thư viện | Phiên bản | Giấy phép |
|---|---|---|---|
| `pinyin-pro.js` | [pinyin-pro](https://github.com/zh-lx/pinyin-pro) (bản UMD `dist/index.js`) | 3.29.5 | MIT (`pinyin-pro.LICENSE.txt`) |
| `pinyin-pro-traditional.js` | Bảng Phồn → Giản `traditional.js` của [@pinyin-pro/data](https://github.com/chinese-data/pinyin-pro-data), bọc thành `window.NDS_ZH_T2S` | 1.3.1 | ISC |
| `kuromoji.js` + `kuromoji-dict/` | [kuromoji.js](https://github.com/takuyaa/kuromoji.js) (bản browser + từ điển IPADIC) | 0.1.2 | Apache-2.0 (`kuromoji.LICENSE.txt`, `kuromoji.NOTICE.md`) |

- pinyin-pro: tra phiên âm Pinyin cho chữ Hán (có xử lý chữ đa âm theo ngữ cảnh).
- kuromoji: tách từ tiếng Nhật và lấy cách đọc để hiện Furigana. Từ điển (~17 MB) chỉ được tải khi lần đầu cần phiên âm tiếng Nhật.
