// ---------- Config ----------
const PIPED_API = "https://piped.video"; // change to another Piped instance if needed

// ---------- DOM ----------
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

// ---------- Helpers ----------
const YT_RE = /https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_\-]{6,})/i;

function getVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = url.match(YT_RE);
    return m ? m[3] : null;
  } catch { return null; }
}

const debounce = (fn, ms=400)=>{let t;return (...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};};
const human = (sec)=> {
  sec = Math.max(0, Number(sec)||0);
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
  return (h? `${h}:` : "") + `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};

function setProgress(text, pct){ progressRow.hidden=false; progressText.textContent=text; progressBar.style.width = `${pct}%`; }
function clearProgress(){ progressRow.hidden=true; progressBar.style.width = "0%"; progressText.textContent=""; }

// ---------- UI events ----------
const maybeFetch = debounce(async ()=>{
  const id = getVideoId(input.value.trim());
  if (!id) return;
  await loadInfo(id);
}, 350);

input.addEventListener("input", maybeFetch);
input.addEventListener("paste", () => setTimeout(()=> {
  const id = getVideoId(input.value.trim());
  if (id) loadInfo(id);
}, 200));

clearBtn.addEventListener("click", ()=>{ input.value=""; preview.hidden=true; clearProgress(); });

// ---------- Core: fetch info & set links ----------
async function loadInfo(videoId){
  try{
    clearProgress();
    const r = await fetch(`${PIPED_API}/api/v1/streams/${videoId}`);
    if(!r.ok) throw new Error("Failed to fetch video info");
    const data = await r.json();

    // Basic info
    titleEl.textContent = data.title || "—";
    byEl.textContent = data.uploader ? `by ${data.uploader}` : "";
    durEl.textContent = data.duration ? human(data.duration) : "";
    if (data.thumbnailUrl) thumb.src = data.thumbnailUrl;

    // Choose best progressive MP4 for direct download
    const mp4 = pickBestMp4(data.muxedStreams || []);
    mp4Link.href = mp4?.url || "#";
    mp4Link.download = sanitize((data.title || "video")) + ".mp4";
    mp4Link.classList.toggle("disabled", !mp4);

    // Prepare MP3 handler (convert in-browser from best audio)
    const bestAudio = pickBestAudio(data.audioStreams || []);
    mp3Btn.onclick = async () => {
      if (!bestAudio) return;
      try {
        await downloadAsMp3(bestAudio.url, (data.title || "audio"));
      } catch (e) {
        console.error(e);
        alert("MP3 conversion failed. Try again or another Piped instance.");
      } finally {
        clearProgress();
      }
    };

    preview.hidden = false;
  }catch(err){
    console.error(err);
    preview.hidden = true;
    alert("Could not load video data. The public API might be rate-limited; try again later or switch instance.");
  }
}

function pickBestMp4(muxed){
  // prefer highest quality MP4 (container may be "mp4")
  const candidates = muxed
    .filter(s => /mp4/i.test(s.container || s.mimeType || ""))
    .sort((a,b)=> (b.quality ?? 0) - (a.quality ?? 0));
  return candidates[0] || muxed[0] || null;
}
function pickBestAudio(audios){
  // prefer highest bitrate and m4a/webm
  return [...audios].sort((a,b)=> (parseInt(b.bitrate||0) - parseInt(a.bitrate||0)) )[0] || null;
}
function sanitize(s){ return s.replace(/[\\/:*?"<>|]/g,"").trim().slice(0,120) || "file"; }

// ---------- MP3 conversion with ffmpeg.wasm ----------
import { FFmpeg } from "https://esm.sh/@ffmpeg/ffmpeg@0.12.10";
import { fetchFile } from "https://esm.sh/@ffmpeg/util@0.12.2";

let ffmpeg;
let ffmpegReady = false;

async function ensureFFmpeg(){
  if (ffmpegReady) return;
  setProgress("Loading converter (~20–30 MB)…", 5);
  ffmpeg = new FFmpeg();
  await ffmpeg.load(); // loads core + codecs from CDN
  ffmpegReady = true;
  setProgress("Converter ready.", 20);
}

async function downloadAsMp3(sourceUrl, baseName){
  await ensureFFmpeg();

  // Fetch audio stream to memory
  setProgress("Fetching audio…", 35);
  const audioData = await fetchFile(sourceUrl); // handles CORS-friendly fetch/arrayBuffer

  // Write input, transcode to mp3
  const inName = "in.webm"; // container doesn't matter; ffmpeg detects
  const outName = "out.mp3";
  await ffmpeg.writeFile(inName, audioData);

  setProgress("Converting to MP3…", 55);
  // -vn (no video), -ar 44100, -b:a 192k
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
  setTimeout(()=> URL.revokeObjectURL(a.href), 1500);
  setProgress("Done!", 100);
}
