/* script.js (ES module) — Frontend-only YouTube → MP3/MP4
   - Auto-rotates across multiple public Piped API instances
   - MP4: direct progressive stream download
   - MP3: in-browser conversion with ffmpeg.wasm
   - No server required
*/

// -------------------- Public API rotation --------------------
const PIPED_APIS = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.syncpundit.io",
  "https://pipedapi.nosebs.de",
  "https://pipedapi.tokhmi.xyz",
];

let currentAPIIndex = 0;
let lastHealthyAPI = null;

/** Try HEAD on endpoint across mirrors; cache the first that responds. */
async function chooseAPI(endpoint = "/api/v1/trending") {
  // If we already have a good API cached, use it first.
  if (lastHealthyAPI) return lastHealthyAPI;

  const attempts = [];
  for (let i = 0; i < PIPED_APIS.length; i++) {
    const base = PIPED_APIS[(currentAPIIndex + i) % PIPED_APIS.length];
    attempts.push(
      fetch(base + endpoint, { method: "HEAD" })
        .then((r) => (r.ok || r.status === 404 ? base : null))
        .catch(() => null)
    );
  }
  const results = await Promise.all(attempts);
  const healthy = results.find(Boolean);
  if (!healthy) throw new Error("All public API instances seem offline or blocked.");
  lastHealthyAPI = healthy;
  currentAPIIndex = PIPED_APIS.indexOf(healthy);
  return healthy;
}

/** If a call fails, rotate to next API and retry once. */
async function apiFetchJSON(path) {
  try {
    const base = await chooseAPI(path);
    const r = await fetch(base + path);
    if (!r.ok) throw new Error(`API error ${r.status}`);
    return await r.json();
  } catch (e) {
    // Rotate and try one more time
    lastHealthyAPI = null;
    currentAPIIndex = (currentAPIIndex + 1) % PIPED_APIS.length;
    const base2 = await chooseAPI(path);
    const r2 = await fetch(base2 + path);
    if (!r2.ok) throw new Error(`API error ${r2.status}`);
    return await r2.json();
  }
}

// -------------------- DOM refs --------------------
const $ = (id) => document.getElementById(id);

const input = $("urlInput");
const clearBtn = $("clearBtn");

const preview = $("preview");
const thumb = $("thumb");
const titleEl = $("title");
const byEl = $("by");
const durEl = $("dur");

const mp3Btn = $("mp3Btn");
const mp4Link = $("mp4Link");

const progressRow = $("progressRow");
const progressText = $("progressText");
const progressBar = $("progressBar");

// -------------------- Helpers --------------------
const YT_RE =
  /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_\-]{6,})/i;

function getVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = url.match(YT_RE);
    return m ? m[3] : null;
  } catch {
    return null;
  }
}

const debounce = (fn, ms = 400) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const human = (sec) => {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.floor(sec % 60);
  return (h ? `${h}:` : "") + `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

function setProgress(text, pct) {
  progressRow.hidden = false;
  progressText.textContent = text;
  progressBar.style.width = `${pct}%`;
}
function clearProgress() {
  progressRow.hidden = true;
  progressBar.style.width = "0%";
  progressText.textContent = "";
}

function sanitize(s) {
  return (s || "file").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 120) || "file";
}

function pickBestMp4(muxed) {
  const candidates = (muxed || [])
    .filter((s) => /mp4/i.test(s.container || s.mimeType || ""))
    .sort((a, b) => (parseInt(b.quality ?? 0) - parseInt(a.quality ?? 0)));
  return candidates[0] || (muxed || [])[0] || null;
}
function pickBestAudio(audios) {
  return [...(audios || [])].sort((a, b) => (parseInt(b.bitrate || 0) - parseInt(a.bitrate || 0)))[0] || null;
}

// -------------------- UI events --------------------
const maybeFetch = debounce(async () => {
  const id = getVideoId(input.value.trim());
  if (!id) return;
  await loadInfo(id);
}, 350);

input.addEventListener("input", maybeFetch);
input.addEventListener("paste", () =>
  setTimeout(() => {
    const id = getVideoId(input.value.trim());
    if (id) loadInfo(id);
  }, 200)
);

clearBtn.addEventListener("click", () => {
  input.value = "";
  preview.hidden = true;
  clearProgress();
});

// -------------------- Load info & wire actions --------------------
async function loadInfo(videoId) {
  try {
    clearProgress();
    const data = await apiFetchJSON(`/api/v1/streams/${videoId}`);

    titleEl.textContent = data.title || "—";
    byEl.textContent = data.uploader ? `by ${data.uploader}` : "";
    durEl.textContent = data.duration ? human(data.duration) : "";
    if (data.thumbnailUrl) thumb.src = data.thumbnailUrl;

    // MP4 link (progressive)
    const mp4 = pickBestMp4(data.muxedStreams || []);
    if (mp4 && mp4.url) {
      mp4Link.href = mp4.url;
      mp4Link.download = sanitize(data.title) + ".mp4";
      mp4Link.classList.remove("disabled");
      mp4Link.setAttribute("aria-disabled", "false");
    } else {
      mp4Link.href = "#";
      mp4Link.classList.add("disabled");
      mp4Link.setAttribute("aria-disabled", "true");
    }

    // MP3 conversion (best audio)
    const bestAudio = pickBestAudio(data.audioStreams || []);
    mp3Btn.onclick = async () => {
      if (!bestAudio?.url) return alert("No audio stream found.");
      try {
        await downloadAsMp3(bestAudio.url, data.title || "audio");
      } catch (e) {
        console.error(e);
        alert("MP3 conversion failed or was blocked. Try again or switch API instance.");
      } finally {
        clearProgress();
      }
    };

    preview.hidden = false;
  } catch (err) {
    console.error(err);
    preview.hidden = true;
    alert("Could not load video data. The public API might be rate-limited; try again later or switch instance.");
  }
}

// -------------------- ffmpeg.wasm MP3 conversion --------------------
import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile } from "https://esm.sh/@ffmpeg/util@0.12.2";

let ffmpeg;
let ffmpegReady = false;

async function ensureFFmpeg() {
  if (ffmpegReady) return;
  setProgress("Loading converter (~20–30 MB)…", 5);
  ffmpeg = new FFmpeg();
  await ffmpeg.load(); // loads core+codecs from CDN
  ffmpegReady = true;
  setProgress("Converter ready.", 15);
}

async function downloadAsMp3(sourceUrl, baseName) {
  await ensureFFmpeg();

  // Fetch audio stream into memory (CORS-friendly)
  setProgress("Fetching audio…", 35);
  const audioData = await fetchFile(sourceUrl);

  // Transcode to MP3
  const inName = "in.webm";
  const outName = "out.mp3";
  await ffmpeg.writeFile(inName, audioData);

  setProgress("Converting to MP3…", 60);
  await ffmpeg.exec(["-i", inName, "-vn", "-ar", "44100", "-b:a", "192k", "-f", "mp3", outName]);

  setProgress("Preparing download…", 90);
  const out = await ffmpeg.readFile(outName);
  const blob = new Blob([out], { type: "audio/mpeg" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = sanitize(baseName) + ".mp3";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  setProgress("Done!", 100);
}
