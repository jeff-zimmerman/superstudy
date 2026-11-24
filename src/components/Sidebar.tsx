import { useEffect, useRef, useState } from "preact/hooks";
import { data, query, segments, playing, sidebarOpen, revealSection, selectSection, searchStatus } from "../store";
import { activeScreen, fmtTime, type Data } from "../db";
import { snippet, type Segment } from "../segments";
import { thumbnail } from "../thumbs";
import { Player } from "./Player";

export function Sidebar() {
  const d = data.value!;
  const q = query.value;
  const segs = segments.value;

  let heading = "Select a section of the notes";
  if (q?.kind === "section") {
    const s = d.sections.get(q.sectionId)!;
    heading = `${s.number} ${s.title}`;
  } else if (q?.kind === "search") heading = `“${q.text}”`;

  return (
    <aside class={`sidebar ${sidebarOpen.value ? "open" : ""}`}>
      <header>
        <div class="heading">{heading}</div>
        <button class="close" aria-label="Close" onClick={() => { sidebarOpen.value = false; playing.value = null; }}>×</button>
      </header>
      {playing.value && <Player seg={playing.value} />}
      {q?.kind === "search" && q.sectionHits.length > 0 && (
        <div class="section-hits">
          <div class="label">In the notes</div>
          {q.sectionHits.map(({ id }) => {
            const s = d.sections.get(id)!;
            return (
              <button key={id} onClick={() => {
                selectSection(id);
                // The mobile sheet covers the PDF, so collapse it to reveal the match.
                if (matchMedia("(max-width: 800px)").matches) sidebarOpen.value = false;
                revealSection(id);
              }}>
                <b>{s.number}</b> {s.title}
              </button>
            );
          })}
        </div>
      )}
      {searchStatus.value && <div class="status">{searchStatus.value}</div>}
      <div class="segments">
        {q && !segs.length && <div class="empty-msg">No lecture segments for this {q.kind === "section" ? "section" : "search"}.</div>}
        {segs.map((s) => <SegmentCard key={s.key} seg={s} d={d} />)}
      </div>
    </aside>
  );
}

function SegmentCard({ seg, d }: { seg: Segment; d: Data }) {
  const lec = d.lectures.get(seg.lecture)!;
  const el = useRef<HTMLButtonElement>(null);
  const [thumb, setThumb] = useState<string | null | undefined>(undefined);

  // request the thumbnail only once the card scrolls into view
  useEffect(() => {
    let alive = true;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const primary = lec.screenUrls[0];
      const url = lec.screenUrls[activeScreen(lec, seg.start) - 1] ?? primary;
      thumbnail(url, seg.start)
        .then((u) => !u && alive && url !== primary ? thumbnail(primary, seg.start) : u)
        .then((u) => alive && setThumb(u));
    }, { rootMargin: "200px" });
    io.observe(el.current!);
    return () => { alive = false; io.disconnect(); };
  }, [seg.key]);

  const active = playing.value?.key === seg.key;
  const dots = Math.max(1, Math.round(seg.score));
  return (
    <button ref={el} class={`card ${active ? "active" : ""}`} onClick={() => (playing.value = { ...seg })}>
      <div class="thumb">
        {thumb ? <img src={thumb} alt="" /> : <div class={`ph ${thumb === null ? "failed" : ""}`}>▶</div>}
        <span class="dur">{fmtTime(seg.end - seg.start)}</span>
      </div>
      <div class="meta">
        <div class="lec">{lec.title}</div>
        <div class="time">
          {fmtTime(seg.start)}–{fmtTime(seg.end)}
          <span class="score" title={`relevance ${seg.score.toFixed(1)}/3`}>{"●".repeat(dots)}{"○".repeat(3 - dots)}</span>
        </div>
        <div class="snip">{snippet(d, seg.lecture, seg.start, seg.end)}</div>
      </div>
    </button>
  );
}
