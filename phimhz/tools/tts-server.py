#!/usr/bin/env python3
"""
Máy chủ đọc cho phần thuyết minh của phimhz (chạy trên máy của bạn, không ra mạng).

Giao thức:  POST /tts  {"text": "...", "voice": "nam"|"nữ"|"", "rate": 1.1}
            → trả về file âm thanh (WAV).

Mặc định đọc bằng lệnh `say` của macOS (giọng Linh). Muốn dùng VieNeu hay giọng khác,
đặt biến môi trường PHZ_TTS_CMD là một lệnh nhận JSON {"text","voice","rate","out"}
từ stdin và ghi file WAV ra đường dẫn "out". Ví dụ, với một script cầu nối VieNeu
(chưa có, cần viết riêng) đặt trong môi trường VieNeu sẵn có của 52hz:

    PHZ_TTS_CMD="~/52hz/research/tts/.venv/bin/python ~/52hz/research/tts/doc_phimhz.py" \
        python3 tts-server.py

Chạy:  python3 tts-server.py [cổng, mặc định 5252]
"""
import json
import os
import shlex
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5252
CMD = os.environ.get("PHZ_TTS_CMD", "").strip()
SAY_VOICES = {"nữ": "Linh", "nam": "Linh", "": "Linh"}  # macOS chỉ có sẵn Linh cho tiếng Việt
WORDS_PER_MIN_AT_1X = 180


def render(text: str, voice: str, rate: float, out: str) -> None:
    if CMD:
        payload = json.dumps({"text": text, "voice": voice, "rate": rate, "out": out})
        args = [os.path.expanduser(a) for a in shlex.split(CMD)]
        subprocess.run(args, input=payload.encode(), check=True, timeout=60)
        return
    wpm = str(int(WORDS_PER_MIN_AT_1X * rate))
    subprocess.run(
        ["say", "-v", SAY_VOICES.get(voice, "Linh"), "-r", wpm, "--file-format=WAVE", "--data-format=LEI16@22050", "-o", out, text],
        check=True,
        timeout=60,
    )


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path.rstrip("/") != "/tts":
            self.send_error(404)
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            text = str(body.get("text", "")).strip()
            if not text:
                raise ValueError("thiếu text")
            rate = min(max(float(body.get("rate", 1.0)), 0.5), 2.0)
            with tempfile.TemporaryDirectory() as tmp:
                out = os.path.join(tmp, "out.wav")
                render(text, str(body.get("voice", "")), rate, out)
                with open(out, "rb") as f:
                    data = f.read()
        except Exception as e:  # trả lỗi rõ ràng cho extension hiện lên bảng
            self.send_error(500, "TTS error", str(e))  # dòng trạng thái HTTP chỉ nhận latin-1; lỗi tiếng Việt để ở phần thân
            return
        self.send_response(200)
        self.send_header("content-type", "audio/wav")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"phimhz: máy chủ đọc ở http://127.0.0.1:{PORT}/tts" + (f" (lệnh: {CMD})" if CMD else " (giọng say/Linh)"))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
