#!/usr/bin/env python3
"""
Write the plain-text work packets the orchestrator hands to subagents.
Agents read files instead of touching the DB, and write JSON results.

work/
  toc.md                    every section: id, number, title, level, first words
  sections/S<id>.md         full text of one section (own region only)
  lectures/L<id>/transcript.md          whole lecture, one cue per line
  lectures/L<id>/window_<k>.md          ~10 min windows with 1 min overlap
  lectures/L<id>/windows.json           window index (k, first/last cue id, times)
  out/coarse/  out/fine/                agent outputs land here

Cue line format:  [c1234 12:34] text of the cue
Usage: python make_packets.py --db study.sqlite --work work/ [--lectures 1 2 3]
"""
import argparse, json, sqlite3
from pathlib import Path

def mmss(t):
    return f"{int(t//60):02d}:{int(t%60):02d}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="study.sqlite")
    ap.add_argument("--work", type=Path, default=Path("work"))
    ap.add_argument("--lectures", type=int, nargs="*", help="lecture ids (default all)")
    ap.add_argument("--window", type=float, default=600)
    ap.add_argument("--overlap", type=float, default=60)
    a = ap.parse_args()
    db = sqlite3.connect(a.db)
    w = a.work
    for d in ("sections", "lectures", "out/coarse", "out/fine"):
        (w / d).mkdir(parents=True, exist_ok=True)

    secs = db.execute("""SELECT s.id, s.level, s.number, s.title, s.text, d.title
                         FROM sections s JOIN docs d ON d.id = s.doc_id
                         ORDER BY d.ord, s.ord""").fetchall()
    toc, cur_doc = ["# Notes table of contents",
                    "Format: S<id> | number | title | first words of the section", ""], None
    for sid, lvl, num, title, text, doc in secs:
        if doc != cur_doc:
            toc.append(f"\n## {doc}"); cur_doc = doc
        body = " ".join(text.split()[2:30])
        toc.append(f"{'  '*(lvl-1)}- S{sid} | {num or '-'} | {title} | {body}…")
        (w / "sections" / f"S{sid}.md").write_text(f"# S{sid} {num} {title}\n\n{text}\n")
    (w / "toc.md").write_text("\n".join(toc) + "\n")

    q = "SELECT id, ord, title, duration FROM lectures"
    lects = db.execute(q + (f" WHERE id IN ({','.join('?'*len(a.lectures))})" if a.lectures else "")
                       + " ORDER BY ord", a.lectures or []).fetchall()
    for lid, ord_, title, dur in lects:
        d = w / "lectures" / f"L{lid}"; d.mkdir(exist_ok=True)
        cues = db.execute("SELECT id, start, end, text FROM cues WHERE lecture_id=? ORDER BY start",
                          (lid,)).fetchall()
        line = lambda c: f"[c{c[0]} {mmss(c[1])}] {c[3]}"
        head = f"# Lecture L{lid} (#{ord_+1} in course order): {title}, {dur/60:.0f} min\n\n"
        (d / "transcript.md").write_text(head + "\n".join(map(line, cues)) + "\n")
        idx, k, t0 = [], 0, 0.0
        while t0 < dur:
            t1 = t0 + a.window
            win = [c for c in cues if c[2] > t0 - (a.overlap if k else 0) and c[1] < t1]
            if win:
                (d / f"window_{k}.md").write_text(
                    head + f"## Window {k}: {mmss(win[0][1])}–{mmss(win[-1][2])}\n\n"
                    + "\n".join(map(line, win)) + "\n")
                idx.append(dict(k=k, first_cue=win[0][0], last_cue=win[-1][0],
                                start=win[0][1], end=win[-1][2]))
                k += 1
            t0 = t1
        (d / "windows.json").write_text(json.dumps(idx, indent=1))
        print(f"L{lid} {title}: {len(cues)} cues, {len(idx)} windows")
    print(f"{len(secs)} sections -> {w/'toc.md'}")

if __name__ == "__main__":
    main()
