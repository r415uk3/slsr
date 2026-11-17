# SLSR Patcher

A small, **client-side** tool that patches an MP4 before uploading it to TikTok so
that TikTok's server keeps the original quality instead of re-compressing it down
to ~540p/30fps.

It ships in two forms that share the **same engine**:

- **`slsr-patcher.html`** — a single self-contained web page. Open it in a browser,
  drag in an MP4, get a patched file. Nothing is installed.
- **`extension/`** — a Chrome extension that adds a **"✦ Patch for upload"** button
  on TikTok Studio. Same engine, just one click away while you're on the upload page.

> The file is processed entirely in your browser. Nothing is uploaded anywhere,
> no network requests, no account access.

---

## Credits / how this works

This is a **JavaScript port of the `slsr` method** from
[**buwryme/tiktok-lossless-upload**](https://github.com/buwryme/tiktok-lossless-upload)
(MIT), which is itself a reverse-engineering of the "Editing News" patcher.

The `slsr` method does **not** touch the video stream at all. It only edits the
MP4 container's audio track (adds a duplicate audio track and a short silent tail,
renames the old `moov` to `free`, adds a new `moov`, extends track durations).
The result is a file that plays fine but that TikTok's transcoder refuses to
re-encode — so TikTok serves your original instead. Video frames and timing are
byte-for-byte unchanged.

This port was verified to produce **byte-identical output** to the original Python
implementation on multiple test files.

---

## Usage

**Export your edit normally** as MP4:
- Video: H.264
- Audio: **AAC-LC, stereo** (this is required — the method only works on AAC-LC stereo)

### Web page
1. Open `slsr-patcher.html` in a browser.
2. Drag in your `.mp4`.
3. Download the patched `*_slsr.mp4`.
4. Upload it to TikTok **from a computer**.

### Chrome extension
1. Go to `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Open `https://www.tiktok.com/tiktokstudio/upload` — a **"✦ Patch for upload"**
   button appears bottom-right.
4. Click it, pick your MP4, download the patched file, then upload it.

**Always keep your original file.** The patched file cannot be re-encoded by
normal ffmpeg afterwards.

---

## Important / honest notes

- **This is an exploit of how TikTok ingests files, not an official feature.**
  It may stop working at any time if TikTok closes the gap. Results can also
  vary between uploads.
- **It preserves your source quality — it does not upscale.** 1080p stays 1080p;
  it will not turn 1080p into 2K. The point is to avoid the forced downscale to
  540p/30fps, not to add quality that wasn't there.
- Using it is **against TikTok's Terms of Service**. There is some risk to your
  account. **Test on a secondary account first.**
- Upload the patched file **from desktop**.
- Input must be MP4 with a single **AAC-LC stereo** audio track. If it isn't,
  re-mux first:
  ```
  ffmpeg -i in.mp4 -c:v copy -c:a aac -b:a 192k -ac 2 -movflags +faststart out.mp4
  ```

## Verifying for yourself (optional)

Check whether TikTok kept your quality: open your published video (incognito,
direct link), open DevTools console, and inspect `encodedType` in the page's
video data. `original` = not re-compressed; `normal`/`comet`/`lowest` = a
normal re-encoded rung.

## License

MIT. This is a derivative of `buwryme/tiktok-lossless-upload` (MIT); see `LICENSE`
for the original copyright and attribution. Replace `<your name>` in `LICENSE`
before publishing.
