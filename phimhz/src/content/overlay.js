/*
 * overlay.js — lớp phụ đề nằm đè đúng khung video, cùng nút mở bảng phimhz.
 * Đặt position: fixed theo getBoundingClientRect() của video, nên không phụ thuộc
 * vào cấu trúc DOM riêng của từng trang. Khi toàn màn hình thì chuyển vào phần tử
 * đang toàn màn hình (phần tử ngoài nó sẽ không hiện).
 */
window.PHZ = window.PHZ || {};

(() => {
  'use strict';
  const PHZ = window.PHZ;
  const IDLE_MS = 2500;

  class Overlay {
    constructor({ onButton }) {
      this.root = document.createElement('div');
      this.root.className = 'phz-root notranslate';
      this.root.setAttribute('translate', 'no');

      this.box = document.createElement('div');
      this.box.className = 'phz-box';
      this.sub1 = document.createElement('div');
      this.sub1.className = 'phz-sub phz-sub1';
      this.sub2 = document.createElement('div');
      this.sub2.className = 'phz-sub phz-sub2';
      this.box.append(this.sub1, this.sub2);

      this.button = document.createElement('button');
      this.button.className = 'phz-button';
      this.button.type = 'button';
      this.button.textContent = 'phimhz';
      this.button.setAttribute('aria-label', 'Mở bảng phimhz');
      this.button.addEventListener('click', (e) => {
        e.stopPropagation();
        onButton();
      });

      this.root.append(this.box, this.button);
      this.last = ['', ''];
      this.lastMove = 0;
      document.addEventListener('mousemove', () => (this.lastMove = Date.now()), true);
    }

    // Gắn root vào đúng chỗ (toàn màn hình hay không) và đặt theo khung video.
    place(video, extraVisible) {
      const fs = document.fullscreenElement;
      const parent = fs && fs.contains(video) ? fs : document.documentElement;
      if (this.root.parentNode !== parent) parent.appendChild(this.root);
      if (!video) {
        this.root.style.display = 'none';
        return;
      }
      const r = video.getBoundingClientRect();
      if (r.width < 200 || r.height < 120) {
        this.root.style.display = 'none';
        return;
      }
      Object.assign(this.root.style, {
        display: 'block',
        left: r.left + 'px',
        top: r.top + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
      });
      this.height = r.height;
      const idle = Date.now() - this.lastMove > IDLE_MS;
      this.button.classList.toggle('phz-hidden', idle && !extraVisible);
    }

    applyStyle(s) {
      const px = Math.max(12, ((this.height || 600) * s.fontSize) / 100);
      this.box.style.fontSize = px + 'px';
      this.box.style.bottom = s.bottom + '%';
    }

    static render(el, cues) {
      el.textContent = '';
      for (const cue of cues) {
        for (const line of cue.lines) {
          const row = document.createElement('div');
          row.className = 'phz-line';
          for (const seg of line) {
            const span = document.createElement('span');
            span.textContent = seg.text;
            if (seg.italic) span.className = 'phz-italic';
            row.appendChild(span);
          }
          el.appendChild(row);
        }
      }
    }

    // Chỉ dựng lại DOM khi nội dung đổi.
    show(cues1, cues2) {
      const k1 = cues1.map(PHZ.cueText).join('\n');
      const k2 = cues2.map(PHZ.cueText).join('\n');
      if (k1 !== this.last[0]) Overlay.render(this.sub1, cues1);
      if (k2 !== this.last[1]) Overlay.render(this.sub2, cues2);
      this.sub1.style.display = k1 ? '' : 'none';
      this.sub2.style.display = k2 ? '' : 'none';
      this.last = [k1, k2];
    }
  }

  PHZ.Overlay = Overlay;
})();
