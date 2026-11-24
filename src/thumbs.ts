// Client-side thumbnails: seek a hidden <video> to the segment start (the browser
// fetches only the byte ranges it needs), draw the frame to a canvas, cache the
// JPEG in IndexedDB. Jobs run one at a time on a single reused element.
// Needs the R2 bucket's CORS rule to allow GET from this site, otherwise the
// canvas is "tainted" and toBlob() throws.

const W = 320, H = 180;
const DB_NAME = "thumbs", STORE = "t";

type Job = { url: string; t: number; key: string; resolve: (u: string | null) => void };
const queue: Job[] = [];
const memo = new Map<string, Promise<string | null>>();
let running = false;
let video: HTMLVideoElement | null = null;
let idb: Promise<IDBDatabase | null> | null = null;

function openDb() {
  idb ??= new Promise((res) => {
    try {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
  return idb;
}

async function idbGet(key: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((res) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => res(null);
  });
}

async function idbPut(key: string, blob: Blob) {
  const db = await openDb();
  if (db) db.transaction(STORE, "readwrite").objectStore(STORE).put(blob, key);
}

function once(el: HTMLElement, ev: string, timeoutMs = 15000) {
  return new Promise<void>((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error(`${ev} timeout`)); }, timeoutMs);
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(new Error("video error")); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener("error", bad); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener("error", bad, { once: true });
  });
}

async function grab(url: string, t: number): Promise<Blob> {
  if (!video) {
    video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
  }
  if (video.src !== url) {
    video.src = url;
    await once(video, "loadedmetadata");
  }
  video.currentTime = Math.min(t, Math.max(0, video.duration - 0.5));
  await once(video, "seeked");
  // seeked can fire before the frame is decoded on a detached element
  if (video.readyState < 2) await once(video, "loadeddata", 5000).catch(() => {});
  await new Promise((r) => ("requestVideoFrameCallback" in video!)
    ? Promise.race([new Promise((ok) => (video as any).requestVideoFrameCallback(ok)), new Promise((ok) => setTimeout(ok, 300))]).then(r)
    : setTimeout(r, 50));
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  // letterbox to 16:9
  const vw = video.videoWidth || W, vh = video.videoHeight || H;
  const s = Math.min(W / vw, H / vh);
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(video, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", 0.75));
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      const blob = await grab(job.url, job.t);
      idbPut(job.key, blob);
      job.resolve(URL.createObjectURL(blob));
    } catch (err) {
      console.warn("thumbnail failed", job.key, err);
      job.resolve(null);
    }
  }
  running = false;
}

/** Thumbnail object URL for `url` at time `t` (seconds), or null on failure. */
export function thumbnail(url: string, t: number): Promise<string | null> {
  const key = `${url}#${Math.round(t)}`;
  let p = memo.get(key);
  if (!p) {
    p = idbGet(key).then((blob) => {
      if (blob) return URL.createObjectURL(blob);
      return new Promise<string | null>((resolve) => {
        queue.push({ url, t, key, resolve });
        pump();
      });
    });
    memo.set(key, p);
  }
  return p;
}

/** Drop queued (not yet started) jobs, e.g. when the sidebar content changes. */
export function clearQueue() {
  for (const j of queue.splice(0)) { memo.delete(j.key); j.resolve(null); }
}
