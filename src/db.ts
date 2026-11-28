// Loads study.sqlite with sql.js and pulls everything into plain JS structures.
// The DB is small (a few MB), so we read it once and never query it again.
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Course } from "./courses";

export interface Doc { id: number; title: string; pdf_url: string; pages: { w: number; h: number }[] }
export interface Section { id: number; doc_id: number; parent_id: number | null; level: number; ord: number; title: string; number: string; text: string; children: number[] }
export interface Region { section_id: number; page: number; x0: number; y0: number; x1: number; y1: number }
interface LectureRow { id: number; ord: number; title: string; video_dir: string | null; screen_count: 0 | 1 | 2; vtt_url: string; duration: number }
interface BoardInterval { lecture_id: number; time_start_ms: number; time_end_ms: number; active_screen: 1 | 2 }
export interface Lecture extends LectureRow {
  screenUrls: [] | [string] | [string, string];
  boardActivity: BoardInterval[];
}
export interface Cue { id: number; lecture_id: number; start: number; end: number; text: string }
export interface Span { section_id: number; lecture_id: number; start_cue: number; end_cue: number; score: number; why: string }
export interface Chunk { id: number; lecture_id: number; start_cue: number; end_cue: number; start: number; end: number }
export interface VecRow { kind: "chunk" | "section"; ref_id: number }

export interface Data {
  course: Course;
  docs: Doc[];
  sections: Map<number, Section>;
  regionsByDocPage: Map<string, Region[]>; // key `${doc}:${page}`
  lectures: Map<number, Lecture>;
  cues: Map<number, Cue>;
  cuesByLecture: Map<number, Cue[]>;
  spansBySection: Map<number, Span[]>;
  chunks: Chunk[];
  vecRows: VecRow[];
  meta: Record<string, any>;
}

function rows<T>(db: any, sql: string): T[] {
  const res = db.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v: any[]) => Object.fromEntries(columns.map((c: string, i: number) => [c, v[i]])) as T);
}

function tableExists(db: any, name: string) {
  return rows(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`).length > 0;
}

let sqlJs: Promise<any> | null = null;

/** Load a course database and resolve its media keys for playback. */
export async function loadData(course: Course): Promise<Data> {
  const resolveUrl = (u: string) => (!u || /^https?:\/\//.test(u) ? u : course.mediaBase + u);
  sqlJs ??= initSqlJs({ locateFile: () => wasmUrl } as any);
  const [SQL, buf] = await Promise.all([
    sqlJs,
    fetch(course.base + "study.sqlite").then(async (r) => {
      const missing = `No data for this course yet (expected data/${course.id}/study.sqlite)`;
      if (r.status === 404) throw new Error(missing);
      if (!r.ok) throw new Error(`study.sqlite: HTTP ${r.status}`);
      const b = await r.arrayBuffer();
      // dev servers answer missing files with index.html; check the SQLite signature
      if (new TextDecoder().decode(new Uint8Array(b, 0, Math.min(15, b.byteLength))) !== "SQLite format 3") throw new Error(missing);
      return b;
    }),
  ]);
  const db = new SQL.Database(new Uint8Array(buf));

  const docs = rows<any>(db, "SELECT id, title, pdf_url FROM docs ORDER BY ord").map((d) => ({
    ...d,
    pdf_url: resolveUrl(d.pdf_url),
    pages: rows<any>(db, `SELECT width w, height h FROM pages WHERE doc_id=${d.id} ORDER BY page`),
  })) as Doc[];

  const sections = new Map<number, Section>();
  for (const s of rows<Section>(db, "SELECT id, doc_id, parent_id, level, ord, title, number, text FROM sections ORDER BY doc_id, ord"))
    sections.set(s.id, { ...s, children: [] });
  for (const s of sections.values()) if (s.parent_id != null) sections.get(s.parent_id)?.children.push(s.id);

  const regionsByDocPage = new Map<string, Region[]>();
  for (const r of rows<Region & { doc_id: number }>(db,
    "SELECT r.*, s.doc_id FROM regions r JOIN sections s ON s.id = r.section_id ORDER BY s.doc_id, s.ord")) {
    const k = `${r.doc_id}:${r.page}`;
    (regionsByDocPage.get(k) ?? regionsByDocPage.set(k, []).get(k)!).push(r);
  }

  const lectures = new Map<number, Lecture>();
  for (const l of rows<LectureRow>(db, "SELECT * FROM lectures ORDER BY ord")) {
    const primary = l.video_dir && l.screen_count > 0 ? resolveUrl(`${l.video_dir}/s1.mp4`) : null;
    const screenUrls: Lecture["screenUrls"] = !primary ? [] : l.screen_count === 2
      ? [primary, resolveUrl(`${l.video_dir}/s2.mp4`)]
      : [primary];
    lectures.set(l.id, { ...l, screenUrls, boardActivity: [], vtt_url: resolveUrl(l.vtt_url) });
  }
  if (tableExists(db, "board_activity")) {
    for (const interval of rows<BoardInterval>(db, "SELECT * FROM board_activity ORDER BY lecture_id, time_start_ms")) {
      const lecture = lectures.get(interval.lecture_id);
      if (lecture?.screen_count === 2) lecture.boardActivity.push(interval);
    }
  }

  const cues = new Map<number, Cue>();
  const cuesByLecture = new Map<number, Cue[]>();
  for (const c of rows<Cue>(db, "SELECT id, lecture_id, start, end, text FROM cues ORDER BY lecture_id, start")) {
    cues.set(c.id, c);
    (cuesByLecture.get(c.lecture_id) ?? cuesByLecture.set(c.lecture_id, []).get(c.lecture_id)!).push(c);
  }

  const spansBySection = new Map<number, Span[]>();
  if (tableExists(db, "spans"))
    for (const s of rows<Span>(db, "SELECT * FROM spans"))
      (spansBySection.get(s.section_id) ?? spansBySection.set(s.section_id, []).get(s.section_id)!).push(s);

  const hasIndex = tableExists(db, "chunks");
  const chunks = hasIndex ? rows<Chunk>(db, "SELECT * FROM chunks ORDER BY id") : [];
  const vecRows = hasIndex ? rows<VecRow>(db, "SELECT kind, ref_id FROM vectors ORDER BY row") : [];
  const meta: Record<string, any> = {};
  if (hasIndex) for (const m of rows<{ key: string; value: string }>(db, "SELECT * FROM meta")) meta[m.key] = JSON.parse(m.value);

  db.close();
  return { course, docs, sections, regionsByDocPage, lectures, cues, cuesByLecture, spansBySection, chunks, vecRows, meta };
}

/** Resolve the recommended screen at a playback time in seconds. */
export function activeScreen(lecture: Lecture, time: number): 1 | 2 {
  const ms = time * 1000;
  const intervals = lecture.boardActivity;
  let low = 0, high = intervals.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (intervals[mid].time_end_ms <= ms) low = mid + 1;
    else high = mid;
  }
  const interval = intervals[low];
  return interval && ms >= interval.time_start_ms ? interval.active_screen : 1;
}

export function fmtTime(t: number) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}
