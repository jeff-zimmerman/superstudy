// Course index (data/courses.csv) and hash routing (#/<course-id>).
//
// courses.csv columns (header row required, extra columns are kept in `extra`):
//   id            folder name under data/, also the URL slug       (required)
//   title         display name                                     (required)
//   code, term    shown in the course list                         (optional)
//   lectures      number of lecture recordings, for display        (optional)
//   docs          number of notes PDFs, for display                (optional)
//   description   one line shown on the welcome screen             (optional)
import { signal } from "@preact/signals";

export const DATA_ROOT = import.meta.env.BASE_URL + "data/";
const publicBucketUrl = import.meta.env.PROD
  ? import.meta.env.VITE_PUBLIC_BUCKET_URL?.trim().replace(/\/+$/, "")
  : undefined;

export interface Course {
  id: string;
  title: string;
  code: string;
  term: string;
  /** Base URL for video, captions, and notes. */
  mediaBase: string;
  lectures: number | null;
  docs: number | null;
  description: string;
  extra: Record<string, string>;
  /** where study.sqlite / embeddings.bin live */
  base: string;
}

export const courses = signal<Course[] | null>(null);
export const coursesError = signal<string | null>(null);
export const courseId = signal<string | null>(readHash());
export const drawerOpen = signal(false);

function readHash() {
  const m = location.hash.match(/^#\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

window.addEventListener("hashchange", () => { courseId.value = readHash(); });

export function openCourse(id: string | null) {
  drawerOpen.value = false;
  location.hash = id ? `#/${encodeURIComponent(id)}` : "";
  if (!id) history.replaceState(null, "", location.pathname + location.search); // drop the bare '#'
  courseId.value = id;
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const KNOWN = ["id", "title", "code", "term", "lectures", "docs", "description"];

/** Load the course catalog and resolve each course’s data and media locations. */
export async function loadCourses() {
  try {
    const r = await fetch(DATA_ROOT + "courses.csv", { cache: "no-cache" });
    if (!r.ok) throw new Error(`courses.csv: HTTP ${r.status}`);
    const [header, ...rows] = parseCsv(await r.text());
    const cols = header.map((h) => h.trim().toLowerCase());
    if (!cols.includes("id") || !cols.includes("title")) throw new Error("courses.csv needs 'id' and 'title' columns");
    courses.value = rows.map((cells) => {
      const rec: Record<string, string> = {};
      cols.forEach((c, i) => (rec[c] = (cells[i] ?? "").trim()));
      const num = (s: string) => (s && !isNaN(Number(s)) ? Number(s) : null);
      const coursePath = `${encodeURIComponent(rec.id)}/`;
      const base = DATA_ROOT + coursePath;
      return {
        id: rec.id, title: rec.title, code: rec.code ?? "", term: rec.term ?? "",
        mediaBase: publicBucketUrl ? `${publicBucketUrl}/${coursePath}` : base,
        lectures: num(rec.lectures ?? ""), docs: num(rec.docs ?? ""),
        description: rec.description ?? "",
        extra: Object.fromEntries(Object.entries(rec).filter(([k]) => !KNOWN.includes(k))),
        base,
      };
    }).filter((c) => c.id && c.title);
  } catch (e) {
    coursesError.value = String(e);
  }
}
