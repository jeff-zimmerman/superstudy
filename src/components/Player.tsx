import { useEffect, useRef, useState } from "preact/hooks";
import { data } from "../store";
import { activeScreen, fmtTime } from "../db";
import { LEAD_IN, type Segment } from "../segments";

const SPEEDS = [1, 1.25, 1.5, 2];

function loadSpeed() {
  try { const s = Number(localStorage.getItem("speed")); return SPEEDS.includes(s) ? s : 1; } catch { return 1; }
}
function saveSpeed(s: number) {
  try { localStorage.setItem("speed", String(s)); } catch { /* storage unavailable */ }
}

/** Play a clip using screen 1 as the clock and audio source. */
export function Player({ seg }: { seg: Segment }) {
  const lec = data.value!.lectures.get(seg.lecture)!;
  const [primaryUrl, secondaryUrl] = lec.screenUrls;
  const wrap = useRef<HTMLDivElement>(null);
  const v = useRef<HTMLVideoElement>(null);
  const secondary = useRef<HTMLVideoElement>(null);
  const trackEl = useRef<HTMLTrackElement>(null);
  const wantsPlayback = useRef(false);
  const playRequest = useRef<Promise<void> | null>(null);
  const failedSource = useRef<HTMLVideoElement | null>(null);
  const [secondReady, setSecondReady] = useState(false);
  const [secondFailed, setSecondFailed] = useState(false);
  const [boardOverride, setBoardOverride] = useState<1 | 2 | null>(null);
  const [captionText, setCaptionText] = useState("");
  const [stopAtEnd, setStopAtEnd] = useState(true);
  const [ended, setEnded] = useState(false);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(lec.duration || 0);
  const [buffered, setBuffered] = useState(0);
  const [speed, setSpeed] = useState(loadSpeed);
  const [captions, setCaptions] = useState(true);
  const [fs, setFs] = useState(false);

  const recommended = activeScreen(lec, time);
  const visibleBoard = secondReady && !secondFailed ? boardOverride ?? recommended : 1;
  // Keep both panes in place while a fullscreen seek buffers the second board.
  const showBothBoards = fs && !!secondaryUrl && !secondFailed;

  const failSecondary = () => {
    failedSource.current = secondary.current;
    secondary.current?.pause();
    setSecondReady(false);
    setSecondFailed(true);
    setBoardOverride(null);
  };

  const alignSecondary = (forceSeek = false) => {
    const main = v.current, follower = secondary.current;
    if (!main || !follower || failedSource.current === follower) return;
    if (main.readyState === 0 || follower.readyState === 0) return;

    const target = Math.min(main.currentTime, follower.duration);
    const drift = Math.abs(follower.currentTime - target);
    if (forceSeek || (!follower.seeking && drift > .25)) {
      follower.currentTime = target;
      setSecondReady(false);
      return;
    }
    const moving = wantsPlayback.current && !main.paused && main.readyState >= 3;
    const ready = !main.seeking && !follower.seeking && follower.readyState >= (moving ? 3 : 2) && !follower.ended;
    setSecondReady(ready);
    if (!ready || !moving) {
      follower.pause();
    } else if (follower.paused) {
      follower.play().catch((error) => {
        if (secondary.current === follower && error.name !== "AbortError") failSecondary();
      });
    }
  };

  const setPlayback = (play: boolean) => {
    const el = v.current!;
    wantsPlayback.current = play;
    setPaused(!play);
    if (!play) {
      playRequest.current = null;
      el.pause();
      secondary.current?.pause();
      return;
    }
    const request = el.play();
    playRequest.current = request;
    request.catch(() => {
      if (playRequest.current === request) setPlayback(false);
    });
  };

  useEffect(() => {
    const videos = [v.current!, secondary.current];
    setSecondReady(false);
    setSecondFailed(false);
    failedSource.current = null;
    setDuration(lec.duration);
    setBuffered(0);
    return () => {
      wantsPlayback.current = false;
      playRequest.current = null;
      // Keyed video elements are released on a lecture change or player close.
      for (const video of videos) {
        if (!video) continue;
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [primaryUrl, secondaryUrl]);

  useEffect(() => {
    const el = v.current!;
    const start = Math.max(0, seg.start - LEAD_IN);
    setPlayback(false);
    setEnded(false);
    setStopAtEnd(true);
    setBoardOverride(null);
    setTime(start);
    wantsPlayback.current = true;
    setPaused(false);
    const go = () => {
      el.currentTime = start;
      alignSecondary(true);
      if (wantsPlayback.current) setPlayback(true);
    };
    if (el.readyState > 0) go();
    else el.addEventListener("loadedmetadata", go, { once: true });
    return () => el.removeEventListener("loadedmetadata", go);
  }, [seg, primaryUrl, secondaryUrl]); // Re-clicking a card restarts the clip.

  useEffect(() => {
    v.current!.playbackRate = speed;
    if (secondary.current) secondary.current.playbackRate = speed;
    saveSpeed(speed);
  }, [speed, primaryUrl, secondaryUrl]);

  useEffect(() => {
    const track = trackEl.current?.track;
    setCaptionText("");
    if (!track) return;
    // Read the primary track for both boards in dual-screen mode.
    const update = () => {
      if (!secondaryUrl || !captions || !track.activeCues) return;
      setCaptionText(Array.from(track.activeCues, cue =>
        (cue as VTTCue).getCueAsHTML().textContent ?? ""
      ).join("\n"));
    };
    track.mode = captions ? (secondaryUrl ? "hidden" : "showing") : "disabled";
    track.addEventListener("cuechange", update);
    update();
    return () => track.removeEventListener("cuechange", update);
  }, [captions, lec.vtt_url, primaryUrl, secondaryUrl]);

  useEffect(() => {
    const onFs = () => setFs(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const onTime = () => {
    const el = v.current;
    if (!el) return;
    setTime(el.currentTime);
    // Stop even when a delayed timeupdate crosses the clip boundary.
    if (stopAtEnd && wantsPlayback.current && el.currentTime >= seg.end + 1) {
      setPlayback(false);
      setEnded(true);
    }
    alignSecondary();
  };

  const togglePlay = () => {
    if (wantsPlayback.current) {
      setPlayback(false);
    } else {
      setEnded(false);
      if (v.current!.currentTime >= seg.end) setStopAtEnd(false);
      setPlayback(true);
    }
  };

  const seekTo = (t: number) => {
    const el = v.current!;
    t = Math.max(0, Math.min(duration, t));
    el.currentTime = t;
    setTime(t);
    setEnded(false);
    // Scrubbing outside the clip lets the user watch the rest of the lecture.
    if (t > seg.end || t < seg.start - LEAD_IN - 1) setStopAtEnd(false);
    alignSecondary(true);
  };

  const toggleFs = async () => {
    const el = wrap.current!;
    const nativeVideo = visibleBoard === 2 ? secondary.current : v.current;
    const enterNative = () => (nativeVideo as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)
      ?.webkitEnterFullscreen?.();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (el.requestFullscreen) await el.requestFullscreen();
      else enterNative(); // iOS Safari can offer video-only fullscreen.
    } catch { enterNative(); }
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("button, input, select")) return;
    if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); seekTo(time - 5); }
    else if (e.key === "ArrowRight") { e.preventDefault(); seekTo(time + 5); }
    else if (e.key === "f") toggleFs();
    else if (e.key === "c") setCaptions((c) => !c);
  };

  return (
    <div class={`player ${fs ? "fs" : ""}`} ref={wrap} tabIndex={0} onKeyDown={onKey}>
      <div class={`board-stage ${showBothBoards ? "both-boards" : ""}`}>
        <video
          key={primaryUrl}
          class={visibleBoard === 2 && !fs ? "board-hidden" : ""}
          data-board="1"
          ref={v}
          src={primaryUrl}
          playsInline
          crossOrigin="anonymous"
          onClick={togglePlay}
          onTimeUpdate={onTime}
          onProgress={() => {
            const el = v.current!;
            if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1));
          }}
          onPlaying={() => alignSecondary()}
          onWaiting={() => secondary.current?.pause()}
          onSeeked={() => alignSecondary()}
          onPause={() => secondary.current?.pause()}
          onEnded={() => { setPlayback(false); setEnded(stopAtEnd); }}
          onError={() => setPlayback(false)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        >
          {lec.vtt_url && <track key={lec.vtt_url} ref={trackEl} kind="subtitles" src={lec.vtt_url} srclang="en" label="English" />}
        </video>
        {secondaryUrl && (
          <video
            key={secondaryUrl}
            class={showBothBoards || visibleBoard === 2 ? "" : "board-hidden"}
            data-board="2"
            ref={secondary}
            src={secondaryUrl}
            muted
            playsInline
            crossOrigin="anonymous"
            onClick={togglePlay}
            onLoadedMetadata={() => alignSecondary()}
            onCanPlay={() => alignSecondary()}
            onSeeked={() => alignSecondary()}
            onWaiting={() => setSecondReady(false)}
            onEnded={() => setSecondReady(false)}
            onError={failSecondary}
          />
        )}
        {secondaryUrl && captions && captionText && (
          <div class="board-captions"><span>{captionText}</span></div>
        )}
      </div>

      <div class="controls">
        <SeekBar time={time} duration={duration} buffered={buffered} clip={[seg.start, seg.end]} onSeek={seekTo} />
        <div class="ctl-row">
          <button class="icon" onClick={togglePlay} aria-label={paused ? "Play" : "Pause"}>
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
          <span class="clock">{fmtTime(time)} / {fmtTime(duration)}</span>
          <div class="speeds" role="group" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button key={s} class={s === speed ? "on" : ""} onClick={() => setSpeed(s)}>{s}×</button>
            ))}
          </div>
          {lec.vtt_url && (
            <button class={`icon cc ${captions ? "on" : ""}`} onClick={() => setCaptions(!captions)} aria-label="Captions" aria-pressed={captions}>CC</button>
          )}
          <button class="icon" onClick={toggleFs} aria-label={fs ? "Exit full screen" : "Full screen"}>
            {fs ? <ExitFsIcon /> : <FsIcon />}
          </button>
        </div>
        {secondaryUrl && !fs && (
          <div class="board-control">
            <div class="board-options" role="group" aria-label="Board">
              <button type="button" aria-pressed={boardOverride === null} disabled={secondFailed} onClick={() => setBoardOverride(null)}>Auto</button>
              {([1, 2] as const).map((screen) => (
                <button
                  key={screen}
                  type="button"
                  aria-label={`Screen ${screen}`}
                  aria-pressed={boardOverride === screen}
                  disabled={secondFailed}
                  onClick={() => setBoardOverride(screen)}
                >{screen}</button>
              ))}
            </div>
            <span>{secondFailed ? "Screen 2 unavailable" : `Showing screen ${visibleBoard}`}</span>
          </div>
        )}
      </div>

      <div class="player-bar">
        <span>{lec.title} · clip {fmtTime(seg.start)}–{fmtTime(seg.end)}</span>
        {ended
          ? <button onClick={() => { setStopAtEnd(false); setEnded(false); setPlayback(true); }}>Keep watching</button>
          : <label><input type="checkbox" checked={stopAtEnd} onChange={(e) => setStopAtEnd((e.target as HTMLInputElement).checked)} /> stop at clip end</label>}
      </div>
    </div>
  );
}

/** Whole-lecture seek bar with the current clip marked. Pointer-based so it
 *  works for mouse drag and touch scrubbing. */
function SeekBar({ time, duration, buffered, clip, onSeek }: {
  time: number; duration: number; buffered: number; clip: [number, number]; onSeek: (t: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const pct = (t: number) => `${duration ? (100 * t) / duration : 0}%`;

  const timeAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };

  const shown = drag ?? time;
  return (
    <div
      class="seek"
      ref={bar}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={shown}
      onPointerDown={(e) => { bar.current!.setPointerCapture(e.pointerId); setDrag(timeAt(e.clientX)); }}
      onPointerMove={(e) => {
        const t = timeAt(e.clientX);
        setHover({ x: e.clientX - bar.current!.getBoundingClientRect().left, t });
        if (drag != null) setDrag(t);
      }}
      onPointerUp={(e) => { if (drag != null) onSeek(timeAt(e.clientX)); setDrag(null); }}
      onPointerLeave={() => setHover(null)}
    >
      <div class="track">
        <div class="buf" style={{ width: pct(buffered) }} />
        <div class="played" style={{ width: pct(shown) }} />
      </div>
      <div class="clip" title="Current clip" style={{ left: pct(clip[0]), width: pct(clip[1] - clip[0]) }} />
      <div class="knob" style={{ left: pct(shown) }} />
      {hover && <div class="tip" style={{ left: `${hover.x}px` }}>{fmtTime(hover.t)}</div>}
    </div>
  );
}

const PlayIcon = () => <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>;
const PauseIcon = () => <svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>;
const FsIcon = () => <svg viewBox="0 0 24 24"><path d="M4 9V4h5v2H6v3zm10-5h6v5h-2V6h-4zM4 15h2v3h3v2H4zm14 3v-3h2v5h-6v-2z" /></svg>;
const ExitFsIcon = () => <svg viewBox="0 0 24 24"><path d="M7 4h2v5H4V7h3zm8 0h2v3h3v2h-5zM4 15h5v5H7v-3H4zm11 0h5v2h-3v3h-2z" /></svg>;
