// Hybrid search: MiniSearch keyword ranking + bge-small vector ranking, fused with
// reciprocal rank fusion. Produces transcript Hits (fed to mergeSegments) and
// section matches (highlighted in the notes).
import MiniSearch from "minisearch";
import type { Data } from "./db";
import type { Hit } from "./segments";
import { searchStatus } from "./store";

const RRF_K = 60;
const TOP_CHUNKS = 40;
const TOP_SECTIONS = 6;

interface IndexDoc { id: string; kind: "chunk" | "section"; ref: number; text: string; title?: string }

// per-course caches, keyed by the course's Data object
const minis = new WeakMap<Data, MiniSearch<IndexDoc>>();
const vectorCache = new WeakMap<Data, Promise<Int8Array>>();
let worker: Worker | null = null;
let semanticBroken = false;
let reqId = 0;
const pending = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: any) => void }>();

function buildKeywordIndex(d: Data) {
  const docs: IndexDoc[] = [];
  for (const c of d.chunks) {
    const cues = d.cuesByLecture.get(c.lecture_id) ?? [];
    const text = cues.filter((q) => q.start >= c.start && q.start < c.end).map((q) => q.text).join(" ");
    docs.push({ id: `c${c.id}`, kind: "chunk", ref: c.id, text });
  }
  for (const s of d.sections.values())
    docs.push({ id: `s${s.id}`, kind: "section", ref: s.id, title: `${s.number} ${s.title}`, text: s.text });
  const ms = new MiniSearch<IndexDoc>({
    fields: ["title", "text"],
    storeFields: ["kind", "ref"],
    searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.2, combineWith: "OR" },
  });
  ms.addAll(docs);
  return ms;
}

function loadVectors(d: Data) {
  let p = vectorCache.get(d);
  if (!p) {
    p = fetch(d.course.base + "embeddings.bin").then(async (r) => {
      if (!r.ok) throw new Error(`embeddings.bin: HTTP ${r.status}`);
      return new Int8Array(await r.arrayBuffer());
    });
    p.catch(() => vectorCache.delete(d)); // allow a retry
    vectorCache.set(d, p);
  }
  return p;
}

function embed(text: string, model: string): Promise<Float32Array> {
  if (!worker) {
    worker = new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") {
        searchStatus.value = `Downloading search model… ${Math.round((100 * m.loaded) / m.total)}%`;
        return;
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.type === "result" ? p.resolve(m.vec) : p.reject(new Error(m.error));
    };
  }
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, text, model });
  });
}

/** Rank rows of the int8 matrix by dot product with the query. */
function vectorRank(d: Data, q: Float32Array, vecs: Int8Array) {
  const dim = d.meta.dim as number;
  const n = d.vecRows.length;
  const scores = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let s = 0;
    const o = r * dim;
    for (let i = 0; i < dim; i++) s += q[i] * vecs[o + i];
    scores[r] = s;
  }
  const chunk: number[] = [], section: number[] = [];
  const order = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]);
  for (const r of order) {
    const row = d.vecRows[r];
    if (row.kind === "chunk" && chunk.length < TOP_CHUNKS * 2) chunk.push(row.ref_id);
    if (row.kind === "section" && section.length < TOP_SECTIONS * 2) section.push(row.ref_id);
    if (chunk.length >= TOP_CHUNKS * 2 && section.length >= TOP_SECTIONS * 2) break;
  }
  return { chunk, section };
}

function fuse(lists: number[][], top: number) {
  const score = new Map<number, number>();
  for (const list of lists)
    list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  const max = ranked[0]?.[1] ?? 1;
  return ranked.map(([id, s]) => ({ id, score: (3 * s) / max })); // 0-3, same scale as agent scores
}

export async function search(d: Data, text: string) {
  let mini = minis.get(d);
  if (!mini) minis.set(d, (mini = buildKeywordIndex(d)));
  const kw = mini.search(text);
  const kwChunks = kw.filter((r) => r.kind === "chunk").map((r) => r.ref as number);
  const kwSections = kw.filter((r) => r.kind === "section").map((r) => r.ref as number);

  let vec = { chunk: [] as number[], section: [] as number[] };
  if (d.meta.dummy) {
    searchStatus.value = "Index built with --dummy: keyword results only";
  } else if (d.vecRows.length && !semanticBroken) {
    // a model failure disables semantic search everywhere; a missing index only for this course
    const [q, vecs] = await Promise.allSettled([embed(d.meta.query_prefix + text, d.meta.model), loadVectors(d)]);
    if (q.status === "rejected") {
      semanticBroken = true;
      console.warn("search model unavailable", q.reason);
      searchStatus.value = "Semantic search unavailable, keyword results only";
    } else if (vecs.status === "rejected") {
      console.warn("embeddings unavailable", vecs.reason);
      searchStatus.value = "This course's search index is missing, keyword results only";
    } else {
      vec = vectorRank(d, q.value, vecs.value);
      searchStatus.value = "";
    }
  } else if (!d.vecRows.length) {
    searchStatus.value = "No search index for this course, keyword results only";
  }

  const chunks = fuse([kwChunks, vec.chunk], TOP_CHUNKS);
  const byId = new Map(d.chunks.map((c) => [c.id, c]));
  const hits: Hit[] = chunks.flatMap(({ id, score }) => {
    const c = byId.get(id);
    return c ? [{ lecture: c.lecture_id, start: c.start, end: c.end, score, cue: c.start_cue }] : [];
  });
  const sectionHits = fuse([kwSections, vec.section], TOP_SECTIONS);
  return { hits, sectionHits };
}
