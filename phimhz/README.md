# phimhz

Extension Chrome dùng riêng: hai phụ đề, dịch tiếng Việt bằng AI và thuyết minh cho **Disney+, HBO Max, Prime Video, Apple TV**. Không đưa lên Chrome Web Store.

## Cài

1. Mở `chrome://extensions`, bật **Developer mode**.
2. Bấm **Load unpacked**, chọn thư mục `phimhz`.
3. Mở một phim, bấm phát, rê chuột lên khung phim, bấm nút **phimhz** ở góc trên bên phải.
4. Vào mục **Cài đặt** trong bảng, dán API key Anthropic (lấy ở console.anthropic.com). Key chỉ lưu trong máy này.

## Dùng

- **Phụ đề 1** mặc định là tiếng Anh, **Phụ đề 2** là tiếng Việt chính thức nếu phim có. Không có thì Phụ đề 2 là "Tiếng Việt AI".
- Bấm **Dịch sang tiếng Việt** để dịch:
  - Dịch bắt đầu từ đoạn đang xem, rồi tới các đoạn sau.
  - Mỗi tập chỉ dịch một lần, lần sau mở lại lấy từ bộ nhớ.
  - Bảng hiện số tiền ước tính cho lần dịch.
- Muốn dịch tự động khi phim không có phụ đề Việt thì bật **Tự dịch khi phim không có phụ đề Việt**.
- Trước khi dịch tập đầu, AI lập **Bảng nhân vật và xưng hô** cho cả phim. Nếu AI đoán sai giới tính hay cách xưng hô thì sửa trực tiếp; các tập sau sẽ dịch theo bảng đã sửa. Đặt **Tên phim** giống nhau cho mọi tập để dùng chung bảng.
- **Thuyết minh**:
  - Đọc lời tiếng Việt và hạ tiếng phim xuống khi đang đọc, mức mặc định 25%.
  - Với bản dịch AI, lời đọc là một bản riêng, ngắn hơn phụ đề cho vừa thời gian.
  - Với phụ đề Việt chính thức, đọc chính phụ đề đó.
- **Lệch thời gian**: nếu phụ đề sớm hoặc muộn hơn tiếng, chỉnh ±0,1 giây. Mức lệch lưu riêng cho từng trang.

### Model và chi phí

Mặc định dùng Claude Opus 5.5 ($4 / $20 cho mỗi triệu token vào / ra). Một tập 45 phút ước khoảng $0,7–1, chưa đo trên phim thật. Có thể đổi sang Sonnet 5.5 hoặc Haiku 5.5 (rẻ hơn khoảng 40 lần) trong mục Cài đặt. Đổi model thì tập đó được dịch lại.

### Giọng thuyết minh

- **Giọng của trình duyệt**: dùng giọng tiếng Việt có sẵn trên máy, ví dụ Linh trên macOS hoặc Google Tiếng Việt trên Chrome. Không cần cài gì.
- **Máy chủ đọc trên máy**: chạy `python3 tools/tts-server.py`, rồi chọn nguồn giọng này trong bảng (địa chỉ mặc định `http://127.0.0.1:5252`).
  - Mặc định máy chủ dùng lệnh `say` của macOS.
  - Muốn dùng VieNeu thì đặt biến `PHZ_TTS_CMD`, xem đầu file `tools/tts-server.py`.
  - Giao thức: `POST /tts {text, voice: "nam"|"nữ"|"", rate}` trả về file âm thanh.

## Cách hoạt động

- `src/page/sniffer.js` chạy trong trang. Nó nghe các phản hồi fetch/XHR có thể chứa danh sách phụ đề rồi chuyển sang content script. Phần này không có code riêng cho từng nền tảng.
- `src/content/sources.js` đọc 4 dạng:
  - HLS master playlist có `TYPE=SUBTITLES`, phụ đề là các đoạn WebVTT, có xử lý `X-TIMESTAMP-MAP`.
  - DASH `.mpd`, phụ đề là file rời hoặc `SegmentTemplate`.
  - JSON có link `.vtt`/`.dfxp`/`.ttml`/`.srt`.
  - File phụ đề rời.
- `src/content/translate.js` và `src/background.js` lo phần dịch:
  - Phụ đề gốc của cả tập được gửi kèm làm ngữ cảnh và được cache phía API, nên các đoạn sau chỉ tốn phí đọc cache.
  - Dịch theo đoạn 80 câu, kết quả trả về theo cấu trúc JSON cố định.
  - Mỗi câu có 3 trường: phụ đề (`vi`), lời thuyết minh (`tm`) và giới tính người nói (`g`).
- `src/content/narrator.js` lo thuyết minh:
  - Chọn tốc độ đọc cho vừa khoảng trống tới câu sau.
  - Hạ tiếng phim bằng `video.volume`.
  - Tạm dừng và tua theo phim.
- SDK Anthropic được đóng gói sẵn vào `src/vendor/anthropic-sdk.mjs` (bản 1.6.0, giấy phép MIT), nên không cần bước build.

## Test

```bash
node phimhz/tests/e2e.mjs
```

Test chạy extension thật trong Chromium, gồm:
- trang giả cho HLS, DASH và JSON;
- API Claude giả trả SSE như API thật;
- máy chủ đọc giả.

Test không cần mạng và không cần API key. Cần Playwright (`npm i -g playwright`).

## Giới hạn đã biết

- **Chưa thử trên tài khoản thật của 4 nền tảng.** Nếu bảng báo "Chưa thấy danh sách phụ đề", xem dòng **Chẩn đoán**. Mỗi nền tảng có thể cần chỉnh nhỏ.
- **Chưa đọc được phụ đề đóng gói trong fMP4** (`wvtt`/`stpp`). Mục Chẩn đoán sẽ đếm các track loại này.
- **Bản có quảng cáo** (HBO Max, Prime Video) có thể làm phụ đề lệch giờ sau mỗi đoạn quảng cáo.
- **Trình phát có thể ghi đè âm lượng khi đang thuyết minh.** Một số trình phát tự đặt lại âm lượng, khi đó tiếng phim không nhỏ xuống được.
- **Chưa có Pinyin/Furigana và câu thoại song ngữ của DUO SUBS.**
