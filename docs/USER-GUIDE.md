# DUO SUBS – User Guide

## What is DUO SUBS

DUO SUBS is a Chrome extension that shows two Netflix subtitles at the same time, for example English and Vietnamese, so you can learn a language while you watch. Subtitles come from Netflix's own subtitle tracks, never machine translation.

- Two subtitles side by side; drag each one and style it separately.
- Pinyin for Chinese, Furigana for Japanese.
- Bilingual transcript: browse the whole episode line by line, click to jump, search the dialogue.
- Line-by-line navigation with the A, R and D keys for listening practice.
- English or Vietnamese interface.

DUO SUBS collects no data, needs no account and only runs on netflix.com.

![Settings panel](images/1-panel.png)

## Installation

The easiest way is to install from the Chrome Web Store, where the extension updates itself.

**From the Chrome Web Store**

1. Open the DUO SUBS page on the Chrome Web Store (link available once Google approves it).
2. Click **Add to Chrome**, then **Add extension**.
3. Open or reload (F5) the Netflix page you are watching.

**Manual install from a zip file** (before it is on the store, or to use the latest version from GitHub)

1. On the [DUO SUBS GitHub page](https://github.com/thudonggg25/duo-subs-netflix), click the green **Code → Download ZIP** button and unzip it into a permanent folder. Do not delete this folder after installing.
2. Open `chrome://extensions` in the address bar.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and choose the folder that contains `manifest.json`.
5. Open or reload (F5) Netflix.

**Updates:** the bottom of the panel shows your version and whether it is up to date; when a new version exists, the DUO SUBS button shows a red dot.

- Chrome Web Store install: Chrome updates it automatically; click **Update now** at the bottom of the panel to update right away.
- Zip install: click **Download**, unzip over the old folder, click the reload button (↻) on DUO SUBS in `chrome://extensions`, then reload Netflix.

## Quick start

Open a title on Netflix, move the mouse to show the player controls, then click the subtitle icon in the top-right corner (hovering shows **DUO SUBS**).

1. In the **Subtitle languages** column, pick a language for **Subtitle 1** and **Subtitle 2**. Choose **Off** if you only want one.
2. Netflix's own subtitles hide automatically and DUO SUBS takes over.
3. Click outside the panel to close it and keep watching.

Your language choices are remembered for the next titles. If a title lacks a chosen language, the panel tells you. The **Enable dual subtitles** switch (or Shift+D) turns everything off to go back to normal Netflix subtitles. The **EN / VIE** button at the top of the panel switches the interface language.

## Display settings

Every change shows live on the video and is saved. While the panel is open, subtitles show sample text so you can position them easily.

**Directly on screen**

- **Drag** a subtitle to move it. It snaps to the screen center or lines up with the other subtitle; hold Alt while dragging to turn snapping off.
- **Scroll** over a subtitle to make the text bigger or smaller.
- **Double-click** to center a subtitle horizontally.

**In the panel, Display settings column**

- Pick the **Subtitle 1**, **Subtitle 2** or **Pinyin** tab to style each line on its own: font size, text color, outline or shadow, background and opacity.
- **Avoid overlapping**: when a long line wraps, the other subtitle moves out of the way; **Spacing** sets the minimum gap.
- **Move above controls**: lifts subtitles when Netflix's player controls appear.
- **Reset to defaults** (bottom of the left column) restores styles and positions, keeping your chosen languages.

## Pinyin and Furigana

Turn on the **Pinyin** switch right below Subtitle 2 in the panel; how it appears depends on which subtitles are on.

| You have on | Pinyin appears |
| --- | --- |
| Only the Chinese subtitle | As its own subtitle line, like a second subtitle |
| Two subtitles including Chinese (e.g. Vietnamese + Chinese) | Small, above each Chinese character |
| No Chinese subtitle (e.g. English only, or English + Vietnamese) | As its own line, taken from the title's Chinese subtitles |

![Pinyin above Chinese characters](images/3-viet-trung-pinyin.png)

- The dropdown next to the switch picks Simplified or Traditional Chinese; the default **Auto** prefers Simplified.
- The separate Pinyin line can be dragged and resized like a normal subtitle; set its color and size in the **Pinyin** tab.
- If a title has no Chinese subtitles, Pinyin cannot be built and the panel says so.

**Furigana** (hiragana above Japanese kanji): pick the Subtitle 1 or 2 tab and turn on **Furigana (Japanese)**. The first time takes a few seconds to load the dictionary.

Readings come from a dictionary lookup, so they are occasionally wrong for characters with several readings or for names.

## Bilingual transcript

Click the list icon next to the DUO SUBS button (or press T) to open the transcript: each line shows both languages, one above the other, and the current line is highlighted and follows the video.

![Transcript](images/4-cau-thoai.png)

- **Click a line** to jump the video there.
- **Three buttons at the bottom**: previous line, replay, next line (same as A, R, D).
- **Drag the header** to move the panel, **drag an edge or corner** to resize it; double-click the header to reset its position.
- **Separate languages for the transcript**: the two dropdowns under the header. For example, the screen shows only Vietnamese while the transcript keeps English + Vietnamese for study.
- **Search** (magnifier icon): type words in either language, accents optional. Results are split into exact matches and similar lines; Esc closes the search.
- **Background opacity**: the half-filled circle button in the header.
- **拼あ button**: turns Pinyin and Furigana on or off in the transcript.

After 2 seconds without interaction the transcript collapses to just the text; hover over it to bring everything back.

## Keyboard shortcuts

Shortcuts work while a video is playing and you are not typing in a text field.

| Key | Action |
| --- | --- |
| A | Jump to the previous line |
| R | Replay the current line |
| D | Jump to the next line |
| T | Open or close the transcript |
| Shift + D | Turn dual subtitles on or off |

## FAQ

| Problem | What to do |
| --- | --- |
| No DUO SUBS button | Move the mouse over the video to show the controls; if it is still missing, reload the page (F5). |
| Panel keeps saying "Waiting for the subtitle list" | Reload the page while on the watch page. |
| The language I want is missing | That title has no subtitles in that language on Netflix in your region. |
| A language says "image only" | Netflix only provides that subtitle as images, which cannot be shown. |
| Subtitles are out of sync | Pause and play again; if still off, reload the page. |
| Chrome shows "Errors" on the extension after an update | Clear the errors and reload Netflix; it was the old version still running in an open tab. |

To report a problem, open the panel, click **Diagnostics** at the bottom of the left column and send a screenshot of that section.

## Privacy and contact

DUO SUBS does not collect, send or sell any of your data. Details: [PRIVACY.md](../PRIVACY.md).

- Settings (chosen languages, styles, positions) are stored only in Chrome on your computer.
- The extension only runs on netflix.com and only downloads subtitle files from Netflix's servers (nflxvideo.net).
- No ads, no account, no servers of its own.

DUO SUBS is an independent project, not affiliated with Netflix. Feedback and bug reports: Telegram [@calm52hz](https://t.me/calm52hz).
