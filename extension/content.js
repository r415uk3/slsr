/* SLSR Patcher content script.
   Adds a floating "Patch for upload" button to TikTok Studio pages.
   Uses the verified slsr core (window.__SLSR__.patchBytesSlsr). Does NOT touch
   the page's uploader, network, cookies or account data. The file the user
   picks is processed entirely in-page and downloaded; the user then uploads it
   manually. Nothing is sent anywhere. */
(() => {
  if (window.top !== window) return;              // main frame only
  if (document.getElementById("slsr-fab")) return; // avoid duplicates
  const core = window.__SLSR__;
  if (!core || typeof core.patchBytesSlsr !== "function") return;

  // ---------- styles (scoped, dark/light aware) ----------
  const css = `
  #slsr-fab{position:fixed;right:18px;bottom:18px;z-index:2147483646;
    font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#0a84ff;color:#fff;border:0;border-radius:999px;padding:12px 18px;
    box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;gap:8px}
  #slsr-fab:hover{background:#0a7aef}
  #slsr-fab:disabled{opacity:.6;cursor:default}
  #slsr-panel{position:fixed;right:18px;bottom:70px;z-index:2147483646;width:320px;max-width:calc(100vw - 36px);
    background:#2c2c2e;color:#f5f5f7;border:1px solid #3a3a3c;border-radius:14px;padding:16px;
    box-shadow:0 10px 30px rgba(0,0,0,.4);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:none}
  #slsr-panel.show{display:block}
  @media (prefers-color-scheme:light){
    #slsr-panel{background:#fff;color:#1d1d1f;border-color:#d2d2d7}
  }
  #slsr-panel h3{margin:0 0 4px;font-size:15px}
  #slsr-panel .muted{opacity:.65;font-size:12px;margin:0 0 12px}
  #slsr-drop{border:2px dashed currentColor;opacity:.9;border-radius:10px;padding:18px;text-align:center;cursor:pointer;margin-bottom:10px}
  #slsr-drop.over{background:rgba(10,132,255,.12)}
  #slsr-status{border-radius:8px;padding:9px 11px;font-size:12px;margin-top:10px;white-space:pre-wrap;display:none}
  #slsr-status.show{display:block}
  #slsr-status.ok{background:rgba(48,209,88,.15);color:#30d158}
  #slsr-status.err{background:rgba(255,107,107,.15);color:#ff6b6b}
  #slsr-status.info{background:rgba(10,132,255,.15)}
  #slsr-x{position:absolute;top:10px;right:12px;cursor:pointer;opacity:.5;font-size:16px;background:0;border:0;color:inherit}
  #slsr-x:hover{opacity:1}
  #slsr-file{display:none}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.documentElement.appendChild(style);

  // ---------- DOM ----------
  const fab = document.createElement("button");
  fab.id = "slsr-fab";
  fab.type = "button";
  fab.innerHTML = "✦ Patch for upload";

  const panel = document.createElement("div");
  panel.id = "slsr-panel";
  panel.innerHTML = `
    <button id="slsr-x" title="Закрыть">✕</button>
    <h3>SLSR Patcher</h3>
    <p class="muted">Патчит MP4 локально (slsr), чтобы TikTok не пересжимал видео. Файл никуда не отправляется.</p>
    <div id="slsr-drop">Перетащи MP4 или нажми, чтобы выбрать</div>
    <input type="file" id="slsr-file" accept="video/mp4,.mp4">
    <div id="slsr-status"></div>
  `;
  document.documentElement.appendChild(fab);
  document.documentElement.appendChild(panel);

  const dropEl = panel.querySelector("#slsr-drop");
  const fileEl = panel.querySelector("#slsr-file");
  const statusEl = panel.querySelector("#slsr-status");

  const setStatus = (kind, msg) => { statusEl.className = "show " + kind; statusEl.id = "slsr-status"; statusEl.classList.add("show", kind); statusEl.textContent = msg; };
  const clear = () => { statusEl.className = ""; statusEl.id = "slsr-status"; statusEl.textContent = ""; };
  const fmt = n => n < 1048576 ? (n/1024).toFixed(0)+" КБ" : (n/1048576).toFixed(2)+" МБ";

  fab.addEventListener("click", () => {
    panel.classList.toggle("show");
  });
  panel.querySelector("#slsr-x").addEventListener("click", () => panel.classList.remove("show"));

  function download(bytes, name){
    const blob = new Blob([bytes], {type:"video/mp4"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  async function handle(f){
    clear();
    if(!f) return;
    if(!/\.mp4$/i.test(f.name) && f.type !== "video/mp4"){
      setStatus("err","Это не .mp4. Нужен MP4 (H.264 + AAC-LC стерео).");
      return;
    }
    setStatus("info", "Читаю "+f.name+" ("+fmt(f.size)+")…");
    let bytes;
    try { bytes = new Uint8Array(await f.arrayBuffer()); }
    catch(e){ setStatus("err","Не удалось прочитать файл."); return; }
    setStatus("info","Патчу…");
    setTimeout(() => {
      try{
        const out = core.patchBytesSlsr(bytes);
        const outName = f.name.replace(/\.mp4$/i,"")+"_slsr.mp4";
        download(out, outName);
        setStatus("ok","Готово ✅  Скачан "+outName+" ("+fmt(out.length)+").\nЗагрузи его в TikTok с этой страницы. Оригинал сохрани отдельно.");
      }catch(e){
        const m = e && e.message || String(e);
        const hint = /mp4a|stsd|esds|rateIndex|cfg/.test(m) ? "аудио не AAC-LC стерео"
          : /audio1/.test(m) ? "нужна ровно одна аудиодорожка"
          : /moov|mdat/.test(m) ? "необычная структура контейнера"
          : m;
        setStatus("err","Не подошло: "+hint+".\nПересохрани: ffmpeg -i in.mp4 -c:v copy -c:a aac -b:a 192k -ac 2 -movflags +faststart out.mp4");
      }
    }, 30);
  }

  dropEl.addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", e => handle(e.target.files[0]));
  ["dragenter","dragover"].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.add("over"); }));
  ["dragleave","drop"].forEach(ev => dropEl.addEventListener(ev, e => { e.preventDefault(); dropEl.classList.remove("over"); }));
  dropEl.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if(f){ fileEl.value=""; handle(f); } });
})();
