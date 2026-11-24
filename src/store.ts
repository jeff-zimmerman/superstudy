import { signal, computed, effect } from "@preact/signals";
import { loadData, type Data } from "./db";
import { courses, courseId } from "./courses";
import { mergeSegments, sectionHits, type Hit, type Segment } from "./segments";

/** Data for the open course (null = welcome screen or still loading). */
export const data = signal<Data | null>(null);
export const loading = signal(false);
export const loadError = signal<string | null>(null);

export const activeDoc = signal<number | null>(null);
/** Latest request to bring a section into view in the PDF. */
export const scrollTarget = signal<{ sectionId: number; docId: number } | null>(null);

/** Open the section's document and request a scroll after it mounts. */
export function revealSection(sectionId: number) {
  const section = data.value?.sections.get(sectionId);
  if (!section) return;
  activeDoc.value = section.doc_id;
  scrollTarget.value = { sectionId, docId: section.doc_id };
}

/** What the clip sidebar is showing: a clicked section, or a search. */
export type Query =
  | { kind: "section"; sectionId: number }
  | { kind: "search"; text: string; hits: Hit[]; sectionHits: { id: number; score: number }[] };
export const query = signal<Query | null>(null);

export const segments = computed<Segment[]>(() => {
  const d = data.value, q = query.value;
  if (!d || !q) return [];
  return mergeSegments(q.kind === "section" ? sectionHits(d, q.sectionId) : q.hits);
});

/** Sections to highlight in the notes. */
export const highlighted = computed<Map<number, number>>(() => {
  const q = query.value;
  if (!q) return new Map();
  if (q.kind === "section") return new Map([[q.sectionId, 1]]);
  return new Map(q.sectionHits.map((h) => [h.id, h.score]));
});

export const playing = signal<Segment | null>(null);
export const sidebarOpen = signal(false);
export const searchStatus = signal<string>("");

export function selectSection(id: number) {
  query.value = { kind: "section", sectionId: id };
  sidebarOpen.value = true;
}

// ---- course switching ----
// Each course's DB is fetched on first open and kept for the session, so
// switching back is instant. Per-course view state is reset on switch.
const cache = new Map<string, Promise<Data>>();
let seq = 0;

effect(() => {
  const id = courseId.value, list = courses.value;
  if (!list) return;               // wait for courses.csv
  const mySeq = ++seq;
  query.value = null; playing.value = null; sidebarOpen.value = false;
  scrollTarget.value = null;
  searchStatus.value = ""; loadError.value = null;
  data.value = null; activeDoc.value = null;
  if (!id) { loading.value = false; return; }
  const course = list.find((c) => c.id === id);
  if (!course) { loading.value = false; loadError.value = `No course “${id}” in courses.csv`; return; }

  let p = cache.get(id);
  if (!p) {
    p = loadData(course);
    p.catch(() => cache.delete(id)); // retry on next open
    cache.set(id, p);
  }
  loading.value = true;
  p.then((d) => {
    if (mySeq !== seq) return;     // user switched again meanwhile
    data.value = d;
    activeDoc.value = d.docs[0]?.id ?? null;
    loading.value = false;
  }, (e) => {
    if (mySeq !== seq) return;
    loadError.value = e instanceof Error ? e.message : String(e);
    loading.value = false;
  });
});
