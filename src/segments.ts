// Every query (section click or text search) produces Hits; this turns them into
// contiguous Segments. Segments are per-query, so they may overlap across queries.
import type { Data } from "./db";

export interface Hit { lecture: number; start: number; end: number; score: number; cue?: number }
export interface Segment {
  key: string;
  lecture: number;
  start: number;
  end: number;
  score: number;     // best hit score in the segment
  covered: number;   // seconds of relevant speech inside it
  bestCue?: number;  // cue of the best hit, for the snippet
}

export const GAP_SECONDS = 30;
export const LEAD_IN = 2; // start playback slightly early

export function mergeSegments(hits: Hit[], gap = GAP_SECONDS): Segment[] {
  const sorted = [...hits].sort((a, b) => a.lecture - b.lecture || a.start - b.start);
  const out: Segment[] = [];
  for (const h of sorted) {
    const s = out[out.length - 1];
    if (s && s.lecture === h.lecture && h.start - s.end < gap) {
      s.covered += Math.max(0, h.end - Math.max(h.start, s.end));
      s.end = Math.max(s.end, h.end);
      if (h.score > s.score) { s.score = h.score; s.bestCue = h.cue; }
    } else {
      out.push({ key: "", lecture: h.lecture, start: h.start, end: h.end, score: h.score,
                 covered: h.end - h.start, bestCue: h.cue });
    }
  }
  for (const s of out) s.key = `${s.lecture}:${s.start.toFixed(1)}-${s.end.toFixed(1)}`;
  return out.sort((a, b) => b.score - a.score || b.covered - a.covered);
}

/** Hits for a notes section, from the agent-scored spans. Falls back to the
 *  section's descendants when it has no spans of its own (e.g. a chapter heading). */
export function sectionHits(data: Data, sectionId: number): Hit[] {
  const collect = (id: number): Hit[] =>
    (data.spansBySection.get(id) ?? []).flatMap((sp) => {
      const a = data.cues.get(sp.start_cue), b = data.cues.get(sp.end_cue);
      return a && b ? [{ lecture: sp.lecture_id, start: a.start, end: b.end, score: sp.score, cue: sp.start_cue }] : [];
    });
  let hits = collect(sectionId);
  if (!hits.length) {
    const stack = [...(data.sections.get(sectionId)?.children ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      hits = hits.concat(collect(id));
      stack.push(...(data.sections.get(id)?.children ?? []));
    }
  }
  return hits;
}

/** Text spoken in [start, end] of a lecture, for card snippets. */
export function snippet(data: Data, lecture: number, start: number, end: number, maxChars = 160) {
  const cues = data.cuesByLecture.get(lecture) ?? [];
  let text = "";
  for (const c of cues) {
    if (c.end < start) continue;
    if (c.start > end || text.length > maxChars) break;
    text += (text ? " " : "") + c.text;
  }
  return text.length > maxChars ? text.slice(0, maxChars).replace(/\s\S*$/, "") + "…" : text;
}
