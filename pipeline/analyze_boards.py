#!/usr/bin/env python3
"""Build the active-board timeline for imported dual-screen lectures."""

import argparse
import math
import sqlite3
import subprocess
import sys
from pathlib import Path
from statistics import median

import numpy as np

SAMPLE_MS = 500
WIDTH, HEIGHT = 160, 90
PIXEL_THRESHOLD = 12
MIN_ACTIVITY = 0.004
MIN_LEAD = 0.002
SMOOTHING_SAMPLES = 6
CONFIRMATION_SAMPLES = 3

SCHEMA = """
CREATE TABLE IF NOT EXISTS board_activity (
    lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
    time_start_ms INTEGER NOT NULL CHECK (time_start_ms >= 0),
    time_end_ms INTEGER NOT NULL CHECK (time_end_ms > time_start_ms),
    active_screen INTEGER NOT NULL CHECK (active_screen IN (1, 2)),
    PRIMARY KEY (lecture_id, time_start_ms)
)
"""


def frame_activity(path: Path) -> list[float]:
    """Return the changed-pixel fraction at each half-second sample."""
    if not path.is_file():
        raise ValueError(f"{path}: video file not found")
    command = [
        "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-i", str(path),
        "-map", "0:v:0", "-vf",
        f"fps={1000 // SAMPLE_MS}:start_time=0,scale={WIDTH}:{HEIGHT}:flags=area,format=gray",
        "-threads:v", "1", "-f", "rawvideo", "pipe:1",
    ]
    frame_size = WIDTH * HEIGHT
    scores = []
    previous = None
    with subprocess.Popen(command, stdout=subprocess.PIPE) as decoder:
        try:
            while raw := decoder.stdout.read(frame_size):
                if len(raw) != frame_size:
                    raise ValueError(f"{path}: incomplete decoded frame")
                # Signed values prevent subtraction from wrapping around at 0.
                frame = np.frombuffer(raw, dtype=np.uint8).astype(np.int16)
                score = 0.0 if previous is None else float(
                    np.count_nonzero(np.abs(frame - previous) > PIXEL_THRESHOLD) / frame_size
                )
                scores.append(score)
                previous = frame
            if decoder.wait():
                raise ValueError(f"{path}: FFmpeg decoding failed")
        finally:
            if decoder.poll() is None:
                decoder.kill()
    return scores


def board_intervals(
    primary: list[float], secondary: list[float], duration_ms: int
) -> list[tuple[int, int, int]]:
    """Cover the lecture with adjacent intervals, switching on sustained activity."""
    intervals = []
    active = 1
    start = 0
    lead_count = 0
    for index in range(SMOOTHING_SAMPLES, min(len(primary), len(secondary))):
        time_ms = index * SAMPLE_MS
        if time_ms >= duration_ms:
            break
        first = index - SMOOTHING_SAMPLES + 1
        one = median(primary[first:index + 1])
        two = median(secondary[first:index + 1])
        current, other = (one, two) if active == 1 else (two, one)
        lead_count = lead_count + 1 if other >= MIN_ACTIVITY and other - current >= MIN_LEAD else 0
        if lead_count == CONFIRMATION_SAMPLES:
            intervals.append((start, time_ms, active))
            start = time_ms
            active = 3 - active
            lead_count = 0
    intervals.append((start, duration_ms, active))
    return intervals


def main() -> None:
    """Analyze the imported recordings and atomically replace each completed timeline."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video_root", type=Path, help="Directory containing lecture1/, lecture2/, etc.")
    parser.add_argument("--db", type=Path, default=Path("study.sqlite"))
    parser.add_argument("--dry-run", action="store_true", help="Print intervals without updating SQLite")
    args = parser.parse_args()
    if not args.video_root.is_dir():
        parser.error(f"{args.video_root}: video directory does not exist")

    mode = "ro" if args.dry_run else "rw"
    failed = False
    try:
        with sqlite3.connect(f"{args.db.resolve().as_uri()}?mode={mode}", uri=True) as db:
            db.execute("PRAGMA foreign_keys = ON")
            lectures = db.execute(
                "SELECT id, video_dir, duration FROM lectures WHERE screen_count = 2 ORDER BY ord, id"
            ).fetchall()
            if not lectures:
                print("No dual-screen lectures to analyze.")
            for lecture_id, video_dir, duration in lectures:
                print(f"Analyzing {video_dir}", flush=True)
                try:
                    if duration is None or not math.isfinite(duration) or round(duration * 1000) <= 0:
                        raise ValueError("invalid imported duration")
                    duration_ms = round(duration * 1000)
                    # The database directory is course-relative. The CLI supplies its local video root.
                    directory = args.video_root / Path(video_dir).name
                    scores = []
                    for name in ("s1.mp4", "s2.mp4"):
                        path = directory / name
                        samples = frame_activity(path)
                        if not samples or abs(len(samples) * SAMPLE_MS - duration_ms) > SAMPLE_MS:
                            raise ValueError(f"{path}: decoded samples do not cover the imported duration")
                        scores.append(samples)
                    intervals = board_intervals(*scores, duration_ms)

                    if not args.dry_run:
                        with db:
                            db.execute("BEGIN")
                            db.execute(SCHEMA)
                            db.execute("DELETE FROM board_activity WHERE lecture_id = ?", (lecture_id,))
                            db.executemany(
                                "INSERT INTO board_activity VALUES (?, ?, ?, ?)",
                                ((lecture_id, *interval) for interval in intervals),
                            )
                    print(f"{video_dir}: {len(intervals) - 1} switches", flush=True)
                    for start, end, screen in intervals:
                        print(f"  {start / 1000:9.3f}–{end / 1000:9.3f} s  screen {screen}")
                except (OSError, ValueError, sqlite3.Error) as exc:
                    failed = True
                    print(f"{video_dir}: {exc}", file=sys.stderr)
    except sqlite3.Error as exc:
        parser.exit(1, f"{args.db}: {exc}\n")
    if failed:
        parser.exit(1)


if __name__ == "__main__":
    main()
