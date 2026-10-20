// Đo độ chính xác Pinyin trên bộ câu mẫu: node tests/pinyin/kiem-tra.js [-v]
// Mỗi dòng cau-mau.tsv: câu <TAB> pinyin chuẩn từng chữ, "a/b" = chấp nhận cả hai cách đọc.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const lib = require(path.join(root, 'src/vendor/pinyin-pro.js'));
lib.addDict(require(path.join(root, 'src/vendor/pinyin-pro-dict.json')), 'nds-phrases');
global.window = { pinyinPro: lib };
global.chrome = {};
eval(fs.readFileSync(path.join(root, 'src/vendor/pinyin-pro-traditional.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'src/content/phonetic.js'), 'utf8'));
const verbose = process.argv.includes('-v');
let syl = 0, okSyl = 0, sent = 0, okSent = 0;
for (const line of fs.readFileSync(path.join(__dirname, 'cau-mau.tsv'), 'utf8').trim().split('\n')) {
  const [text, gold] = line.split('\t');
  const want = gold.split(' ');
  const got = window.NDS.Phonetic.annotate(text, 'zh').filter((s) => s.rt).map((s) => s.rt);
  sent++;
  const bad = want.map((w, i) => (w.split('/').includes(got[i]) ? null : `${got[i]}≠${w}`)).filter(Boolean);
  syl += want.length; okSyl += want.length - bad.length;
  if (!bad.length && got.length === want.length) okSent++;
  else if (verbose) console.log(text, bad.join(' '));
}
console.log(`Âm tiết đúng: ${okSyl}/${syl} (${((100 * okSyl) / syl).toFixed(1)}%), câu đúng hoàn toàn: ${okSent}/${sent}`);
