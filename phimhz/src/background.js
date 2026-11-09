/*
 * background.js — service worker (module).
 *
 *  - PHZ_FETCH: tải hộ file phụ đề khi content script bị CORS chặn.
 *  - PHZ_FETCH_AUDIO: gọi máy chủ đọc (thuyết minh) trên máy, trả audio dạng base64.
 *  - PHZ_GLOSSARY / PHZ_TRANSLATE: gọi Claude để lập bảng nhân vật và dịch từng đoạn.
 *
 * API key chỉ nằm trong chrome.storage.local của máy này; content script không cầm key.
 */
import { Anthropic } from './vendor/anthropic-sdk.mjs';

const SETTINGS_KEY = 'phz.settings';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  const handlers = {
    PHZ_FETCH: () => fetchText(msg.url),
    PHZ_FETCH_AUDIO: () => fetchAudio(msg.url, msg.body),
    PHZ_GLOSSARY: () => makeGlossary(msg),
    PHZ_TRANSLATE: () => translateChunk(msg),
  };
  const fn = handlers[msg.type];
  if (!fn) return false;
  fn()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((e) => sendResponse({ ok: false, error: describeError(e) }));
  return true; // trả lời bất đồng bộ
});

// ---------- Tải hộ ----------

function checkUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('URL không hợp lệ');
  return u.href;
}

async function fetchText(url) {
  const res = await fetch(checkUrl(url), { credentials: 'omit' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return { text: await res.text() };
}

async function fetchAudio(url, body) {
  const res = await fetch(checkUrl(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Máy chủ đọc trả lỗi HTTP ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { base64: btoa(bin), contentType: res.headers.get('content-type') || '' };
}

// ---------- Claude ----------

const SYSTEM_PROMPT = `Bạn là biên dịch viên phụ đề phim và truyền hình chuyên nghiệp, dịch sang tiếng Việt cho khán giả Việt Nam. Bản dịch của bạn được dùng cho hai việc: hiện làm phụ đề, và đọc lên làm thuyết minh lồng trên tiếng phim.

Cách dịch:
- Dịch ý, không dịch từng chữ. Câu phải tự nhiên như phụ đề Việt do người làm, giữ giọng điệu từng nhân vật: lịch sự, suồng sã, mỉa mai hay chửi thề ở mức tương đương bản gốc.
- Xưng hô là phần quan trọng nhất. Chọn cặp xưng hô (anh/em, cậu/tớ, mày/tao, con/bố, tôi/ông, cháu/bác...) theo tuổi, quan hệ và tình huống, giữ đúng bảng nhân vật được cung cấp, và chỉ đổi khi quan hệ giữa hai người thật sự đổi.
- Giữ nguyên tên riêng. Chức danh và cách gọi (Mr., Dr., Sir, Captain...) chuyển sang cách gọi tiếng Việt tự nhiên.
- Thành ngữ, chơi chữ, câu đùa: dùng cách nói Việt có hiệu quả tương đương thay vì dịch sát.
- Mỗi câu phải hiểu được trong mạch cảnh: dùng toàn bộ phụ đề gốc để biết ai đang nói với ai và chuyện gì đang xảy ra.

Trường "vi" (phụ đề):
- Tối đa 2 dòng, mỗi dòng khoảng 42 ký tự, ngắt dòng bằng ký tự xuống dòng.
- Người xem phải đọc kịp: khoảng 15–17 ký tự mỗi giây theo thời lượng của câu. Câu gốc dài mà thời lượng ngắn thì rút gọn ý phụ, giữ ý chính.
- Hai người nói trong cùng một câu thì giữ gạch đầu dòng "-" như bản gốc.
- Ghi chú âm thanh như [laughs], (door slams) thì dịch ngắn trong ngoặc: [cười], (tiếng sập cửa). Lời bài hát có ♪ thì dịch lời và giữ ♪.

Trường "tm" (thuyết minh, sẽ được máy đọc lên):
- Một dòng, văn nói, không ngoặc, không ký hiệu, không tên người nói, không ghi chú âm thanh.
- Ngắn hơn phụ đề nếu cần, để đọc vừa thời lượng của câu (khoảng 4 âm tiết mỗi giây).
- Để rỗng nếu câu chỉ là tiếng động, tiếng hát nền hoặc tiếng kêu không cần đọc.

Trường "g": giới tính người nói ("nam", "nữ"), để rỗng nếu không đoán được.

Chỉ trả về dữ liệu theo đúng cấu trúc yêu cầu, không giải thích.`;

const GLOSSARY_SCHEMA = {
  type: 'object',
  properties: {
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          gender: { type: 'string', enum: ['nam', 'nữ', 'không rõ'] },
          who: { type: 'string', description: 'Vai trò, tuổi tương đối, quan hệ với nhân vật khác' },
          address: { type: 'string', description: 'Cách xưng hô với từng người hay gặp, ví dụ: với Carmy: em/anh' },
        },
        required: ['name', 'gender', 'who', 'address'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string', description: 'Thuật ngữ, biệt danh, cách dịch cố định cần giữ' },
  },
  required: ['characters', 'notes'],
  additionalProperties: false,
};

const CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          vi: { type: 'string' },
          tm: { type: 'string' },
          g: { type: 'string', enum: ['nam', 'nữ', ''] },
        },
        required: ['i', 'vi', 'tm', 'g'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

async function getSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return got[SETTINGS_KEY] || {};
}

function makeClient(s) {
  if (!s.apiKey) throw new Error('Chưa nhập API key Anthropic (mục Cài đặt trong bảng phimhz)');
  return new Anthropic({
    apiKey: s.apiKey,
    dangerouslyAllowBrowser: true, // key do chính người dùng nhập, chỉ ở máy này
    ...(s.apiBaseUrl ? { baseURL: s.apiBaseUrl } : {}),
  });
}

// Khối phụ đề gốc đứng đầu, đánh dấu cache: các yêu cầu sau của cùng tập chỉ trả
// phí đọc cache cho phần này.
function transcriptBlock(msg) {
  return {
    type: 'text',
    text: `Phim: ${msg.series || '(không rõ)'}\nNgôn ngữ phụ đề gốc: ${msg.lang || 'không rõ'}\n\nPHỤ ĐỀ GỐC, mỗi dòng: #số [bắt đầu–kết thúc] lời thoại (" / " là xuống dòng):\n${msg.transcript}`,
    cache_control: { type: 'ephemeral' },
  };
}

async function ask(s, content, schema) {
  const client = makeClient(s);
  const model = s.model || 'claude-opus-5-5';
  const params = {
    model,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
  // Haiku không có fallback phía máy chủ; Opus/Sonnet 5.5 thì bật để một lần
  // bộ lọc an toàn từ chối nhầm (phim có cảnh bạo lực...) không làm hỏng cả đoạn.
  if (!/haiku/.test(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const message = await client.beta.messages.stream(params).finalMessage();
  if (message.stop_reason === 'refusal') {
    const cat = message.stop_details && message.stop_details.category;
    throw new Error('Model từ chối dịch đoạn này' + (cat ? ` (${cat})` : ''));
  }
  if (message.stop_reason === 'max_tokens') throw new Error('Kết quả bị cắt vì quá dài');
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { data: JSON.parse(text), usage: message.usage };
}

async function makeGlossary(msg) {
  const s = await getSettings();
  const content = [
    transcriptBlock(msg),
    {
      type: 'text',
      text: 'Lập bảng nhân vật cho phim này: tên, giới tính, vai trò và quan hệ, và cách xưng hô tiếng Việt phù hợp giữa các cặp nhân vật hay nói chuyện với nhau. Thêm ghi chú về thuật ngữ, biệt danh cần dịch cố định. Bảng này sẽ dùng để dịch nhất quán mọi tập.',
    },
  ];
  const { data, usage } = await ask(s, content, GLOSSARY_SCHEMA);
  const lines = data.characters.map((c) => `${c.name} — ${c.gender} — ${c.who} — Xưng hô: ${c.address}`);
  if (data.notes) lines.push('', 'Ghi chú: ' + data.notes);
  return { glossary: lines.join('\n'), usage };
}

async function translateChunk(msg) {
  const s = await getSettings();
  const prev = (msg.previous || []).map((p) => `#${p.i}: ${p.vi.replace(/\n/g, ' / ')}`).join('\n');
  const content = [
    transcriptBlock(msg),
    {
      type: 'text',
      text:
        `BẢNG NHÂN VẬT VÀ XƯNG HÔ (giữ nhất quán):\n${msg.glossary || '(chưa có)'}\n\n` +
        (prev ? `CÁC CÂU ĐÃ DỊCH NGAY TRƯỚC ĐOẠN NÀY (để nối mạch xưng hô):\n${prev}\n\n` : '') +
        `NHIỆM VỤ: dịch các câu từ #${msg.from} đến #${msg.to}, mỗi câu đúng một mục, giữ số "i" như bản gốc.`,
    },
  ];
  const { data, usage } = await ask(s, content, CHUNK_SCHEMA);
  return { lines: data.lines, usage };
}

function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'API key không đúng hoặc đã bị thu hồi';
  if (e instanceof Anthropic.PermissionDeniedError) return 'API key không có quyền dùng model này';
  if (e instanceof Anthropic.RateLimitError) return 'Đang bị giới hạn tốc độ, thử lại sau ít phút';
  if (e instanceof Anthropic.BadRequestError) return 'Yêu cầu không hợp lệ: ' + e.message;
  if (e instanceof Anthropic.APIError) return `Lỗi API ${e.status || ''}: ${e.message}`;
  return String((e && e.message) || e);
}
