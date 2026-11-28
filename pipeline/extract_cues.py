#!/usr/bin/env python3
"""
Pull the subtitle track out of each lecture video, clean it, and load it into
the study DB as `lectures` + `cues`. Also writes a cleaned .vtt per lecture for
upload to R2 (used as the <track> in the player).

Usage:
  python extract_cues.py video/ --db study.sqlite --out vtt/
  python extract_cues.py --transcript-only vtt/*.vtt --db study.sqlite
Stores relative keys (video/lecture1, vtt/lecture1.vtt); the app resolves them against
the course's media_prefix from courses.csv.
Lecture directories are ordered by their numeric suffix.
Transcript-only imports preserve source filenames and use the last cue for duration.
"""
import argparse, html, json, re, sqlite3, subprocess
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS lectures(id INTEGER PRIMARY KEY, ord INTEGER, title TEXT,
  video_dir TEXT UNIQUE, screen_count INTEGER NOT NULL CHECK (screen_count IN (0, 1, 2)),
  vtt_url TEXT, duration REAL);
CREATE TABLE IF NOT EXISTS cues(id INTEGER PRIMARY KEY, lecture_id INTEGER,
  start REAL, end REAL, text TEXT);
CREATE INDEX IF NOT EXISTS cues_lecture ON cues(lecture_id, start);
"""

def probe(path):
    """Read media timing and subtitle streams from a recording."""
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json",
                          "-show_streams", "-show_format", str(path)],
                         capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    subs = [s for s in info["streams"] if s["codec_type"] == "subtitle"]
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if video is None:
        raise ValueError(f"{path}: no video stream")
    duration = float(info["format"]["duration"])
    return duration, float(video.get("start_time", 0)), subs

def ts(s):
    """Convert a subtitle timestamp to seconds."""
    h, m, rest = ("0:" + s if s.count(":") == 1 else s).split(":")
    return int(h) * 3600 + int(m) * 60 + float(rest.replace(",", "."))

def fmt(t):
    """Format seconds as a WebVTT timestamp."""
    h, r = divmod(t, 3600); m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"

def parse_vtt(text):
    """Read timestamped text from WebVTT."""
    cues = []
    for block in re.split(r"\n\s*\n", text.replace("\r", "")):
        lines = [l for l in block.strip().split("\n") if l.strip()]
        for i, l in enumerate(lines):
            m = re.match(r"([\d:.,]+)\s*-->\s*([\d:.,]+)", l)
            if m:
                body = " ".join(lines[i + 1:])
                body = html.unescape(re.sub(r"<[^>]+>|\{[^}]+\}", "", body))
                body = re.sub(r"\s+", " ", body).strip()
                if body:
                    cues.append([ts(m.group(1)), ts(m.group(2)), body])
                break
    return cues

def clean(cues):
    """Drop exact repeats and collapse 'rolling' captions where each cue
    repeats the tail of the previous one (common in auto-generated subs)."""
    out = []
    for c in sorted(cues):
        if out:
            prev = out[-1]
            if c[2] == prev[2]:
                prev[1] = max(prev[1], c[1]); continue
            if c[2].startswith(prev[2]):           # cue extends previous
                prev[1], prev[2] = max(prev[1], c[1]), c[2]; continue
            # strip overlap: longest suffix of prev that prefixes c
            pw, cw = prev[2].split(), c[2].split()
            k = next((k for k in range(min(len(pw), len(cw)), 0, -1) if pw[-k:] == cw[:k]), 0)
            if k:
                c = [c[0], c[1], " ".join(cw[k:])]
                if not c[2]:
                    prev[1] = max(prev[1], c[1]); continue
        out.append(list(c))
    return out

def main():
    """Index lecture cues from embedded subtitles or standalone WebVTT files."""
    ap = argparse.ArgumentParser()
    ap.add_argument("video_root", type=Path, nargs="?", help="Directory containing lecture1/, lecture2/, etc.")
    ap.add_argument("--db", default="study.sqlite")
    ap.add_argument("--out", type=Path, default=Path("vtt"))
    ap.add_argument("--stream", type=int, default=0, help="Subtitle stream index if several")
    ap.add_argument("--sidecar", type=Path, nargs="+",
                    help="WebVTT files in numeric lecture order")
    ap.add_argument("--video-dir-prefix", default="video", help="Course-relative video directory prefix")
    ap.add_argument("--vtt-url-prefix", default="vtt/")
    ap.add_argument("--transcript-only", type=Path, nargs="+",
                    help="Lecture-numbered WebVTT files for a course without recordings")
    a = ap.parse_args()
    if a.transcript_only:
        if a.video_root or a.sidecar:
            ap.error("--transcript-only cannot be combined with a video directory or --sidecar")
        transcripts = {}
        for path in a.transcript_only:
            # Accept the existing Lecure8.vtt spelling without changing its media key.
            match = re.fullmatch(r"lect?ure([1-9][0-9]*)\.vtt", path.name, re.IGNORECASE)
            if not match or int(match[1]) in transcripts:
                ap.error(f"{path}: expected a unique lecture number in the filename")
            cues = sorted(parse_vtt(path.read_text(encoding="utf-8-sig")))
            if not cues or any(start < 0 or start >= end for start, end, _ in cues):
                ap.error(f"{path}: missing cues or invalid timestamps")
            transcripts[int(match[1])] = (path, cues)

        with sqlite3.connect(a.db) as db:
            db.executescript(SCHEMA)
            db.execute("BEGIN IMMEDIATE")
            existing = {ord_ + 1 for ord_, in db.execute("SELECT ord FROM lectures")}
            if duplicates := sorted(existing.intersection(transcripts)):
                ap.error(f"lecture numbers already imported: {duplicates}")
            for number, (path, cues) in sorted(transcripts.items()):
                duration = max(end for _, end, _ in cues)
                cur = db.execute(
                    "INSERT INTO lectures(ord,title,video_dir,screen_count,vtt_url,duration) VALUES(?,?,NULL,0,?,?)",
                    (number - 1, f"Lecture {number}", a.vtt_url_prefix + path.name, duration),
                )
                db.executemany("INSERT INTO cues(lecture_id,start,end,text) VALUES(?,?,?,?)",
                               [(cur.lastrowid, start, end, body) for start, end, body in cues])
                print(f"Lecture {number}: transcript only, {len(cues)} cues, {duration/60:.1f} min")
        return
    if a.video_root is None:
        ap.error("provide a video directory or --transcript-only")
    if not a.video_root.is_dir():
        ap.error(f"{a.video_root}: video directory does not exist")
    lectures = sorted(
        (int(m[1]), path)
        for path in a.video_root.iterdir()
        if path.is_dir() and (m := re.fullmatch(r"lecture([1-9][0-9]*)", path.name))
    )
    if not lectures:
        ap.error(f"{a.video_root}: expected lecture directories named lecture1, lecture2, etc.")
    if a.sidecar and len(a.sidecar) != len(lectures):
        ap.error("--sidecar requires one WebVTT file per lecture")

    prepared = []
    for i, (number, directory) in enumerate(lectures):
        primary = directory / "s1.mp4"
        secondary = directory / "s2.mp4"
        if not primary.is_file():
            ap.error(f"{directory}: missing s1.mp4")
        if secondary.exists() and not secondary.is_file():
            ap.error(f"{secondary}: expected a video file")
        count = 2 if secondary.is_file() else 1
        duration, start, subs = probe(primary)
        if count == 2:
            other_duration, other_start, _ = probe(secondary)
            # Container duration can vary slightly with audio encoder padding.
            if abs(duration - other_duration) > 0.25 or abs(start - other_start) > 0.1:
                ap.error(f"{directory}: screen start times or durations differ")
        if a.sidecar:
            raw = a.sidecar[i].read_text(encoding="utf-8-sig")
        elif (a.out / f"{directory.name}.vtt").is_file():
            raw = (a.out / f"{directory.name}.vtt").read_text(encoding="utf-8-sig")
        elif subs:
            raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(primary), "-map", f"0:s:{a.stream}",
                                  "-f", "webvtt", "-"], capture_output=True, text=True, check=True).stdout
        else:
            ap.error(f"{primary}: no subtitle stream or matching WebVTT")
        cues = clean(parse_vtt(raw))
        if not cues or any(s < 0 or s >= e or e > duration + 0.25 for s, e, _ in cues):
            ap.error(f"{directory}: missing cues or cue timestamps outside the lecture timeline")
        video_dir = f"{a.video_dir_prefix.rstrip('/')}/{directory.name}"
        prepared.append((number, video_dir, count, duration, directory.name, cues))

    a.out.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(a.db) as db:
        db.executescript(SCHEMA)
        for number, video_dir, count, duration, name, cues in prepared:
            vtt_name = f"{name}.vtt"
            cur = db.execute(
                "INSERT INTO lectures(ord,title,video_dir,screen_count,vtt_url,duration) VALUES(?,?,?,?,?,?)",
                (number - 1, f"Lecture {number}", video_dir, count, a.vtt_url_prefix + vtt_name, duration),
            )
            lid = cur.lastrowid
            db.executemany("INSERT INTO cues(lecture_id,start,end,text) VALUES(?,?,?,?)",
                           [(lid, s, e, t) for s, e, t in cues])
        # Write captions only after all lecture rows have passed the DB constraints.
        for number, _, count, duration, name, cues in prepared:
            (a.out / f"{name}.vtt").write_text("WEBVTT\n\n" + "\n\n".join(
                f"{fmt(s)} --> {fmt(e)}\n{t}" for s, e, t in cues) + "\n")
            print(f"Lecture {number}: {count} screen(s), {len(cues)} cues, {duration/60:.1f} min")

if __name__ == "__main__":
    main()
