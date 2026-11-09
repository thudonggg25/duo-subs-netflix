/*
 * Test đầu-cuối cho phimhz: chạy extension thật trong Chromium với một trang giả lập
 * nền tảng xem phim (HLS, DASH, JSON), một API Claude giả (trả SSE như thật) và một
 * máy chủ đọc giả. Không cần mạng, không cần API key.
 *
 * Chạy:  node phimhz/tests/e2e.mjs
 */
import http from 'node:http';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright cài cục bộ hoặc toàn cục (npm i -g playwright) đều dùng được.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (e) {
  const globalRoot = execSync('npm root -g').toString().trim();
  ({ chromium } = createRequire(import.meta.url)(path.join(globalRoot, 'playwright')));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const extSrc = path.resolve(here, '..');
let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failures++;
};

// ---------- Dữ liệu giả ----------

function wav(seconds, rate = 8000, freq = 0) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n && freq; i++) buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  return buf;
}
const MEDIA = wav(60);
const BEEP = wav(1, 8000, 440);

const vttSeg = (cues) =>
  'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n' +
  cues.map(([a, b, t]) => `00:00:${String(a).padStart(2, '0')}.000 --> 00:00:${String(b).padStart(2, '0')}.000\n${t}`).join('\n\n') +
  '\n';

const ROUTES = {
  '/hls/master.m3u8': [
    'application/vnd.apple.mpegurl',
    `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="subs_en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub2",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="subs_en_dup.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",NAME="English [CC]",LANGUAGE="en",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound",URI="subs_en_cc.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",NAME="Español",LANGUAGE="es",URI="subs_es.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,SUBTITLES="sub1"
video_800.m3u8
`,
  ],
  '/hls/subs_en.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nen_0.vtt\n#EXTINF:10,\nen_1.vtt\n#EXT-X-ENDLIST\n'],
  '/hls/en_0.vtt': ['text/vtt', vttSeg([[2, 6, 'Hello from segment one.'], [8, 12, 'This line crosses the boundary.']])],
  '/hls/en_1.vtt': ['text/vtt', vttSeg([[8, 12, 'This line crosses the boundary.'], [13, 16, 'Second segment speaking.']])],
  '/dash/manifest.mpd': [
    'application/dash+xml',
    `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT40S" type="static">
  <Period>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="en">
      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>
      <Representation id="en" bandwidth="100">
        <SegmentTemplate media="text/en_$Number%03d$.vtt" startNumber="1" duration="20" timescale="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="vi">
      <Representation id="vi" bandwidth="100"><BaseURL>text/vi.vtt</BaseURL></Representation>
    </AdaptationSet>
    <AdaptationSet contentType="text" mimeType="application/mp4" codecs="wvtt" lang="fr">
      <Representation id="fr" bandwidth="100"><BaseURL>text/fr.mp4</BaseURL></Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
  ],
  '/dash/text/en_001.vtt': ['text/vtt', 'WEBVTT\n\n00:00:02.000 --> 00:00:06.000\nDash English one.\n'],
  '/dash/text/en_002.vtt': ['text/vtt', 'WEBVTT\n\n00:00:22.000 --> 00:00:26.000\nDash English two.\n'],
  '/dash/text/vi.vtt': ['text/vtt', 'WEBVTT\n\n00:00:02.000 --> 00:00:06.000\n[cười] Xin chào, phụ đề chính thức.\n'],
  '/subs/en.dfxp': [
    'application/ttml+xml',
    `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000"><body><div>
<p begin="20000000t" end="60000000t">JSON English <span>line</span>.</p></div></body></tt>`,
  ],
};

const page = (title, script) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;background:#000"><video id="v" src="/media.wav" style="width:960px;height:540px" controls></video>
<script>${script}</script></body></html>`;

const PAGES = {
  '/hls.html': page('The Test Show: S1 E2 | Disney+', `fetch('/hls/master.m3u8').then(r => r.text());`),
  '/dash.html': page('Dash Show - Prime Video', `const x = new XMLHttpRequest(); x.open('GET', '/dash/manifest.mpd'); x.send();`),
  '/json.html': page('Json Show | HBO Max', `fetch('/api/playback').then(r => r.json());`),
};

// ---------- API Claude giả ----------
const apiLog = [];
const ttsLog = [];

function sse(res, payload, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send('message_start', {
    message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage },
  });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  const text = JSON.stringify(payload);
  for (let i = 0; i < text.length; i += 200) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 200) } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 500 } });
  send('message_stop', {});
  res.end();
}

function handleMessages(req, res, body) {
  const json = JSON.parse(body);
  apiLog.push({ headers: req.headers, body: json });
  const content = json.messages[0].content;
  const task = content[content.length - 1].text;
  const m = /từ #(\d+) đến #(\d+)/.exec(task);
  const usage = { input_tokens: 1200, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!m) {
    return sse(res, { characters: [{ name: 'Narrator', gender: 'nam', who: 'người dẫn', address: 'tôi/các bạn' }], notes: '' }, usage);
  }
  const lines = [];
  for (let i = +m[1]; i <= +m[2]; i++) lines.push({ i, vi: `VI câu ${i}`, tm: `thuyết minh câu số ${i}`, g: 'nam' });
  sse(res, { lines }, usage);
}

// ---------- Máy chủ ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (url.pathname === '/v1/messages' && req.method === 'POST') return handleMessages(req, res, body);
    if (url.pathname === '/tts' && req.method === 'POST') {
      ttsLog.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(BEEP);
    }
    if (url.pathname === '/media.wav') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = +range[1];
        const end = range[2] ? +range[2] : MEDIA.length - 1;
        res.writeHead(206, {
          'content-type': 'audio/wav',
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${MEDIA.length}`,
          'content-length': end - start + 1,
        });
        return res.end(MEDIA.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': MEDIA.length });
      return res.end(MEDIA);
    }
    if (url.pathname === '/api/playback') {
      const base = `http://localhost:${server.address().port}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          playbackUrls: { mainUrl: base + '/x.mpd' },
          subtitleUrls: [{ url: base + '/subs/en.dfxp', languageCode: 'en-us', displayName: 'English', type: 'subtitle' }],
          forcedNarratives: [{ url: base + '/subs/forced.dfxp', languageCode: 'en-us', displayName: 'English [Forced]' }],
        })
      );
    }
    if (PAGES[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGES[url.pathname]);
    }
    const r = ROUTES[url.pathname];
    if (r) {
      res.writeHead(200, { 'content-type': r[0], 'access-control-allow-origin': '*' });
      return res.end(r[1]);
    }
    res.writeHead(404);
    res.end();
  });
});

// ---------- Chạy ----------
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;

// Bản sao extension cho phép chạy trên localhost.
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phimhz-ext-'));
fs.cpSync(extSrc, extDir, { recursive: true, filter: (p) => !p.includes(`${path.sep}tests`) && !p.includes(`${path.sep}tools`) });
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
for (const cs of manifest.content_scripts) cs.matches.push('http://localhost/*');
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phimhz-profile-'));
const context = await chromium.launchPersistentContext(userDir, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--autoplay-policy=no-user-gesture-required'],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  // SW nạp SDK (gần 400 KB) nên chrome.* có sau sự kiện 'serviceworker' một chút.
  for (let i = 0; i < 50 && !(await sw.evaluate(() => !!(self.chrome && chrome.storage))); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await sw.evaluate(
    (s) => chrome.storage.local.set({ 'phz.settings': s }),
    { apiKey: 'sk-ant-test', apiBaseUrl: base, engine: 'server', serverUrl: base, narrate: false }
  );

  const tab = await context.newPage();
  tab.on('console', (m) => m.type() === 'error' && console.log('    [console]', m.text()));
  const seek = (t) => tab.evaluate((t) => (document.getElementById('v').currentTime = t), t);
  // Nút phimhz chỉ hiện khi rê chuột (giống thanh điều khiển của player).
  const openPanel = async () => {
    await tab.mouse.move(300, 200);
    await tab.mouse.move(320, 220);
    await tab.waitForSelector('.phz-button:not(.phz-hidden)');
    await tab.click('.phz-button');
  };
  const textOf = (sel) => tab.evaluate((sel) => (document.querySelector(sel) || {}).textContent || '', sel);
  const waitText = (sel, needle, timeout = 8000) =>
    tab.waitForFunction(([sel, needle]) => ((document.querySelector(sel) || {}).textContent || '').includes(needle), [sel, needle], { timeout }).then(
      () => true,
      () => false
    );

  // --- HLS ---
  console.log('HLS (kiểu Disney+/Apple TV)');
  await tab.goto(base + '/hls.html');
  await tab.waitForFunction(() => document.getElementById('v').readyState > 0);
  await seek(3);
  check(await waitText('.phz-sub1', 'Hello from segment one.'), 'Phụ đề 1 hiện câu ở đoạn 1');
  await seek(9);
  check(await waitText('.phz-sub1', 'crosses the boundary'), 'Câu vắt qua hai đoạn hiện ra');
  check((await textOf('.phz-sub1')).split('crosses').length === 2, 'Câu vắt qua hai đoạn chỉ hiện một lần');
  await seek(14);
  check(await waitText('.phz-sub1', 'Second segment speaking.'), 'Phụ đề 1 hiện câu ở đoạn 2');

  await openPanel();
  const opts = await tab.$$eval('.phz-panel select', (ss) => ss.map((s) => Array.from(s.options).map((o) => o.textContent)));
  const t1opts = opts.find((o) => o.some((x) => x.includes('Español')));
  check(t1opts && t1opts.filter((x) => x.startsWith('English')).length === 2, 'Danh sách track bỏ trùng (English, English [CC], Español)');
  check(await tab.$eval('.phz-panel', (p) => p.querySelectorAll('select')[2].value === 'ai'), 'Không có phụ đề Việt → Phụ đề 2 mặc định là AI');

  // Dịch
  await tab.click('.phz-primary');
  check(await waitText('.phz-sub2', 'VI câu 2'), 'Bản dịch AI hiện ở Phụ đề 2');
  check(await waitText('.phz-panel', 'Đã dịch 3/3 câu'), 'Bảng báo dịch đủ 3/3 câu');
  const tr = apiLog.find((r) => /từ #\d+ đến/.test(JSON.stringify(r.body)));
  check(apiLog.length === 2, `Gọi API 2 lần (bảng nhân vật + 1 đoạn), thực tế ${apiLog.length}`);
  check(tr && tr.body.model === 'claude-opus-5-5', 'Model mặc định là claude-opus-5-5');
  check(tr && tr.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(tr.headers['anthropic-beta'] || ''), 'Bật fallbacks "default" kèm beta header');
  check(tr && tr.body.output_config && tr.body.output_config.format.type === 'json_schema' && tr.body.output_config.effort === 'medium', 'Dùng structured output và effort medium');
  check(tr && tr.body.messages[0].content[0].cache_control && tr.body.messages[0].content[0].text.includes('Hello from segment one.'), 'Khối phụ đề gốc đứng đầu và được đánh dấu cache');
  check(tr && (tr.headers['x-api-key'] === 'sk-ant-test' || tr.headers.authorization === 'Bearer sk-ant-test'), 'Gửi đúng API key');
  check(tr && tr.body.messages[0].content[1].text.includes('Narrator'), 'Bảng nhân vật được gửi kèm khi dịch');

  // Nạp lại trang: bản dịch phải lấy từ bộ nhớ, không gọi API nữa.
  const before = apiLog.length;
  await tab.reload();
  await tab.waitForFunction(() => document.getElementById('v').readyState > 0);
  await seek(3);
  check(await waitText('.phz-sub2', 'VI câu 0'), 'Tải lại trang: bản dịch lấy từ bộ nhớ');
  check(apiLog.length === before, 'Không gọi lại API cho tập đã dịch');

  // Thuyết minh qua máy chủ đọc
  console.log('Thuyết minh');
  await sw.evaluate(async () => {
    const got = await chrome.storage.local.get('phz.settings');
    await chrome.storage.local.set({ 'phz.settings': { ...got['phz.settings'], narrate: true } });
  });
  await tab.reload();
  await tab.waitForFunction(() => document.getElementById('v').readyState > 0);
  await waitText('.phz-sub1', '', 2000);
  await seek(1.5);
  await tab.evaluate(() => {
    const v = document.getElementById('v');
    v.volume = 1;
    return v.play();
  });
  const ducked = await tab
    .waitForFunction(() => Math.abs(document.getElementById('v').volume - 0.25) < 0.01, null, { timeout: 6000 })
    .then(() => true, () => false);
  check(ducked, 'Đang đọc thì tiếng phim nhỏ xuống 25%');
  // Tiếng phim nhỏ xuống ngay khi tới câu; yêu cầu đọc tới máy chủ đi ngay sau đó.
  const spoken = () => ttsLog.some((t) => t.text === 'thuyết minh câu số 0' && t.voice === 'nam');
  for (let i = 0; i < 30 && !spoken(); i++) await new Promise((r) => setTimeout(r, 100));
  check(spoken(), 'Gửi đúng lời thuyết minh và giọng cho máy chủ đọc');
  const restored = await tab
    .waitForFunction(() => document.getElementById('v').volume > 0.99, null, { timeout: 6000 })
    .then(() => true, () => false);
  check(restored, 'Đọc xong thì tiếng phim trở lại như cũ');
  await tab.evaluate(() => document.getElementById('v').pause());
  await sw.evaluate(async () => {
    const got = await chrome.storage.local.get('phz.settings');
    await chrome.storage.local.set({ 'phz.settings': { ...got['phz.settings'], narrate: false } });
  });

  // --- DASH ---
  console.log('DASH (kiểu HBO Max)');
  await tab.goto(base + '/dash.html');
  await tab.waitForFunction(() => document.getElementById('v').readyState > 0);
  await seek(3);
  check(await waitText('.phz-sub1', 'Dash English one.'), 'Phụ đề 1 từ SegmentTemplate (đoạn 1)');
  check(await waitText('.phz-sub2', 'Xin chào, phụ đề chính thức.'), 'Có phụ đề Việt chính thức → tự chọn làm Phụ đề 2');
  await seek(23);
  check(await waitText('.phz-sub1', 'Dash English two.'), 'Phụ đề 1 từ SegmentTemplate (đoạn 2)');
  await openPanel();
  check(await waitText('.phz-panel', '1 track fMP4 chưa đọc được'), 'Chẩn đoán báo track fMP4 chưa hỗ trợ');

  // --- JSON ---
  console.log('JSON (kiểu Prime Video)');
  await tab.goto(base + '/json.html');
  await tab.waitForFunction(() => document.getElementById('v').readyState > 0);
  await seek(3);
  check(await waitText('.phz-sub1', 'JSON English line.'), 'Phụ đề 1 từ link DFXP trong JSON');
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} kiểm tra KHÔNG đạt` : '\nTất cả kiểm tra đều đạt');
process.exit(failures ? 1 : 0);
