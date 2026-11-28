import { useId, useEffect, useRef, useState } from "preact/hooks";
import { data, query, segments, playing, sidebarOpen, revealSection, selectSection, searchStatus } from "../store";
import { activeScreen, fmtTime, type Data } from "../db";
import { snippet, type Segment } from "../segments";
import { thumbnail } from "../thumbs";
import { Player } from "./Player";

/** Show mapped excerpts and optional video playback alongside the notes. */
export function Sidebar() {
  const d = data.value!;
  const q = query.value;
  const segs = segments.value;
  const [expansion, setExpansion] = useState<{ segments: Segment[]; keys: Set<string> }>();
  // Expansion belongs to the current result list.
  const expanded = expansion?.segments === segs ? expansion.keys : undefined;
  const allExpanded = segs.length > 0 && segs.every((seg) => expanded?.has(seg.key));
  const listId = useId();
  const clip = playing.value;
  const [collapsedClip, setCollapsedClip] = useState<Segment | null>(null);
  const videoOpen = clip !== collapsedClip;
  const hasVideo = clip && Boolean(d.lectures.get(clip.lecture)?.screenUrls.length);
  const videoId = useId();
  const sidebar = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const [width, setWidth] = useState(380);
  const [maxWidth, setMaxWidth] = useState(() => Math.max(300, window.innerWidth - 360));
  const visibleWidth = Math.min(width, maxWidth);

  useEffect(() => {
    const updateLimit = () => setMaxWidth(Math.max(300, window.innerWidth - 360));
    window.addEventListener("resize", updateLimit);
    return () => window.removeEventListener("resize", updateLimit);
  }, []);

  function resize(nextWidth: number) {
    setWidth(Math.round(Math.max(300, Math.min(nextWidth, maxWidth))));
  }

  let heading = "Select a section of the notes";
  if (q?.kind === "section") {
    const s = d.sections.get(q.sectionId)!;
    heading = `${s.number} ${s.title}`;
  } else if (q?.kind === "search") heading = `“${q.text}”`;

  return (
    <aside ref={sidebar} class={`sidebar ${sidebarOpen.value ? "open" : ""}`} style={{ "--sidebar-width": `${visibleWidth}px` }}>
      <div class="sidebar-resize" role="separator" tabIndex={0} aria-label="Sidebar width"
        aria-orientation="vertical" aria-valuemin={300} aria-valuemax={maxWidth} aria-valuenow={visibleWidth}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          drag.current = { x: event.clientX, width: sidebar.current!.offsetWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId) && drag.current) {
            resize(drag.current.width + drag.current.x - event.clientX);
          }
        }}
        onLostPointerCapture={() => { drag.current = undefined; }}
        onKeyDown={(event) => {
          const widths: Record<string, number> = {
            ArrowLeft: visibleWidth + 24, ArrowRight: visibleWidth - 24, Home: 300, End: maxWidth,
          };
          if (!Object.hasOwn(widths, event.key)) return;
          event.preventDefault();
          resize(widths[event.key]);
        }} />
      <header>
        <div class="heading">{heading}</div>
        {hasVideo && (
          <button class="excerpt-toggle" type="button" aria-controls={videoId} aria-expanded={videoOpen}
            aria-label={videoOpen ? "Collapse video" : "Expand video"}
            title={videoOpen ? "Collapse video" : "Expand video"}
            onClick={() => setCollapsedClip(videoOpen ? clip : null)}>
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2.75" y="4" width="14.5" height="12" rx="2" />
              <path d={videoOpen ? "M7 10h6" : "M8.5 7l5 3-5 3z"} />
            </svg>
          </button>
        )}
        {segs.length > 0 && (
          <button class="excerpt-toggle" type="button" aria-controls={listId}
            aria-label={allExpanded ? "Collapse all excerpts" : "Expand all excerpts"}
            title={allExpanded ? "Collapse all excerpts" : "Expand all excerpts"}
            onClick={() => setExpansion({ segments: segs, keys: new Set(allExpanded ? [] : segs.map((seg) => seg.key)) })}>
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d={allExpanded ? "m6 4 4 4 4-4M6 16l4-4 4 4" : "m6 7 4-4 4 4M6 13l4 4 4-4"} />
            </svg>
          </button>
        )}
        <button class="close" aria-label="Close" onClick={() => { sidebarOpen.value = false; playing.value = null; }}>×</button>
      </header>
      {clip && hasVideo && (
        <div id={videoId} hidden={!videoOpen}>
          {videoOpen && <Player seg={clip} />}
        </div>
      )}
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
      <div class="segments" id={listId}>
        {q && !segs.length && <div class="empty-msg">No lecture segments for this {q.kind === "section" ? "section" : "search"}.</div>}
        {segs.map((s) => (
          <SegmentCard key={s.key} seg={s} d={d} expanded={expanded?.has(s.key) ?? false} onToggle={() => {
            const keys = new Set(expanded);
            if (keys.has(s.key)) keys.delete(s.key);
            else keys.add(s.key);
            setExpansion({ segments: segs, keys });
          }} />
        ))}
      </div>
    </aside>
  );
}

function SegmentCard({ seg, d, expanded, onToggle }: {
  seg: Segment; d: Data; expanded: boolean; onToggle: () => void;
}) {
  const lec = d.lectures.get(seg.lecture)!;
  const excerptId = useId();
  const [primary] = lec.screenUrls;
  const url = lec.screenUrls[activeScreen(lec, seg.start) - 1] ?? primary;
  const el = useRef<HTMLButtonElement>(null);
  const [thumb, setThumb] = useState<string | null | undefined>(undefined);

  // request the thumbnail only once the card scrolls into view
  useEffect(() => {
    if (!primary || !url || !el.current) return;
    let alive = true;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      thumbnail(url, seg.start)
        .then((u) => !u && alive && url !== primary ? thumbnail(primary, seg.start) : u)
        .then((u) => alive && setThumb(u));
    }, { rootMargin: "200px" });
    io.observe(el.current);
    return () => { alive = false; io.disconnect(); };
  }, [primary, url, seg.start]);

  const active = playing.value?.key === seg.key;
  const dots = Math.max(1, Math.round(seg.score));
  return (
    <article class={`card ${primary ? "has-video" : ""} ${active ? "active" : ""}`}>
      {primary && (
        <button ref={el} type="button" class="thumb"
          aria-label={`Play ${lec.title} at ${fmtTime(seg.start)}`}
          onClick={() => (playing.value = { ...seg })}>
          {thumb ? <img src={thumb} alt="" /> : <span class={`ph ${thumb === null ? "failed" : ""}`} aria-hidden="true">▶</span>}
          <span class="dur">{fmtTime(seg.end - seg.start)}</span>
        </button>
      )}
      <button type="button" class="meta excerpt-preview" aria-expanded={expanded}
        aria-controls={excerptId} onClick={onToggle}>
        <span class="lec">{lec.title}</span>
        <span class="time">
          {fmtTime(seg.start)}–{fmtTime(seg.end)}
          <span class="score" title={`relevance ${seg.score.toFixed(1)}/3`}>{"●".repeat(dots)}{"○".repeat(3 - dots)}</span>
        </span>
        {!expanded && <span class="snip">{snippet(d, seg.lecture, seg.start, seg.end)}</span>}
        <svg class="excerpt-chevron" viewBox="0 0 20 20" width="16" height="16" fill="none"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d={expanded ? "m5 12 5-5 5 5" : "m5 8 5 5 5-5"} />
        </svg>
      </button>
      <div id={excerptId} class="excerpt-text" hidden={!expanded}>
        {expanded && snippet(d, seg.lecture, seg.start, seg.end, Infinity)}
      </div>
    </article>
  );
}
