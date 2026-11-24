#!/usr/bin/env python3
"""
Deterministic helpers for the orchestrator: validate agent output, plan the
fine pass from coarse output, and ingest spans into the DB.

  python spans.py status
  python spans.py check-coarse L3
  python spans.py plan [--neighbours 1]
  python spans.py check-fine L3 2
  python spans.py ingest

Exit code is non-zero on validation failure; the error text is written so it
can be pasted straight back to a subagent.
"""
import argparse, json, sqlite3, sys
from pathlib import Path

W = Path("work")
SPANS_SCHEMA = """
CREATE TABLE IF NOT EXISTS spans(section_id INTEGER, lecture_id INTEGER,
  start_cue INTEGER, end_cue INTEGER, score INTEGER, why TEXT);
CREATE INDEX IF NOT EXISTS spans_section ON spans(section_id);
CREATE INDEX IF NOT EXISTS spans_lecture ON spans(lecture_id, start_cue);
"""

def db():
    return sqlite3.connect(ARGS.db)

def lid_of(s):
    return int(str(s).lstrip("Ll"))

def section_ids(con):
    return {r[0] for r in con.execute("SELECT id FROM sections")}

def section_order(con):
    rows = con.execute("SELECT s.id FROM sections s JOIN docs d ON d.id=s.doc_id "
                       "ORDER BY d.ord, s.ord").fetchall()
    return [r[0] for r in rows]

def lecture_cues(con, lid):
    return [r[0] for r in con.execute("SELECT id FROM cues WHERE lecture_id=? ORDER BY start", (lid,))]

def load_json(path):
    """Read a JSON object and return a diagnostic for invalid output."""
    try:
        value = json.loads(Path(path).read_text())
        if not isinstance(value, dict):
            return None, f"{path} must contain a JSON object"
        return value, None
    except FileNotFoundError:
        return None, f"{path} does not exist"
    except json.JSONDecodeError as e:
        return None, f"{path} is not valid JSON: {e}"

def fail(errors):
    print("INVALID:\n" + "\n".join(f"- {e}" for e in errors[:30]))
    if len(errors) > 30:
        print(f"- ... and {len(errors)-30} more")
    sys.exit(1)

# ---------- coarse ----------
def check_coarse(lid, quiet=False):
    con = db()
    data, err = load_json(W / "out/coarse" / f"L{lid}.json")
    if err:
        return [err]
    errs, sids, cues = [], section_ids(con), set(lecture_cues(con, lid))
    if data.get("lecture_id") != lid:
        errs.append(f"lecture_id should be {lid}")
    sections = data.get("sections")
    if not isinstance(sections, list) or not sections:
        return errs + ["sections must be a nonempty list"]
    for i, s in enumerate(sections):
        tag = f"sections[{i}]"
        if not isinstance(s, dict):
            errs.append(f"{tag} must be a JSON object")
            continue
        if type(s.get("section_id")) is not int or s["section_id"] not in sids:
            errs.append(f"{tag}: section_id {s.get('section_id')} is not in toc.md")
        if s.get("role") not in ("primary", "recap", "mention"):
            errs.append(f"{tag}: role must be primary|recap|mention")
        for k in ("first_cue", "last_cue"):
            if type(s.get(k)) is not int or s[k] not in cues:
                errs.append(f"{tag}: {k} {s.get(k)} is not a cue in lecture L{lid}")
        if isinstance(s.get("first_cue"), int) and isinstance(s.get("last_cue"), int) \
                and s["first_cue"] > s["last_cue"]:
            errs.append(f"{tag}: first_cue > last_cue")
    return errs

# ---------- plan ----------
def plan(neighbours):
    """Build each transcript window's shortlist of notes and equation targets."""
    con = db()
    order = section_order(con)
    pos = {s: i for i, s in enumerate(order)}
    titles = {r[0]: (r[1] or "-", r[2]) for r in con.execute("SELECT id, number, title FROM sections")}
    equations_by_parent = {}
    for sid, parent in con.execute("SELECT id, parent_id FROM sections WHERE title LIKE 'Equation (%'"):
        equations_by_parent.setdefault(parent, []).append(sid)
    for d in sorted((W / "lectures").glob("L*")):
        lid = lid_of(d.name)
        data, err = load_json(W / "out/coarse" / f"L{lid}.json")
        if err or check_coarse(lid):
            print(f"L{lid}: coarse output missing/invalid, skipping"); continue
        cue_rank = {c: i for i, c in enumerate(lecture_cues(con, lid))}
        windows = json.loads((d / "windows.json").read_text())
        for w in windows:
            a, b = cue_rank[w["first_cue"]], cue_rank[w["last_cue"]]
            margin = (b - a) // 4  # include sections that end/start just outside
            hit = [s for s in data["sections"]
                   if cue_rank[s["first_cue"]] <= b + margin and cue_rank[s["last_cue"]] >= a - margin]
            cand = set()
            for s in hit:
                p = pos[s["section_id"]]
                cand.update(order[max(0, p - neighbours): p + neighbours + 1])
            # Equation children can be far from their headings in document order.
            cand.update(sid for heading in list(cand) for sid in equations_by_parent.get(heading, ()))
            lines = [f"# Candidate sections for L{lid} window {w['k']}",
                     "Read each file listed. Other sections are in work/toc.md.", ""]
            for sid in sorted(cand, key=pos.get):
                num, title = titles[sid]
                lines.append(f"- work/sections/S{sid}.md  ({num} {title})")
            if not cand:
                lines.append("(none from the coarse pass: check toc.md; this window may be admin/off-topic)")
            (d / f"window_{w['k']}.candidates.md").write_text("\n".join(lines) + "\n")
        print(f"L{lid}: planned {len(windows)} windows")

# ---------- fine ----------
def check_fine(lid, k):
    con = db()
    data, err = load_json(W / "out/fine" / f"L{lid}_w{k}.json")
    if err:
        return [err]
    windows = {w["k"]: w for w in json.loads((W / "lectures" / f"L{lid}" / "windows.json").read_text())}
    if k not in windows:
        return [f"window {k} does not exist for L{lid}"]
    allc = lecture_cues(con, lid)
    w = windows[k]
    wcues = set(allc[allc.index(w["first_cue"]): allc.index(w["last_cue"]) + 1])
    rank = {c: i for i, c in enumerate(allc)}
    errs, sids = [], section_ids(con)
    if data.get("lecture_id") != lid or data.get("window") != k:
        errs.append(f"lecture_id/window should be {lid}/{k}")
    if not isinstance(data.get("spans"), list):
        return errs + ["'spans' must be a list (it may be empty)"]
    for i, s in enumerate(data["spans"]):
        tag = f"spans[{i}]"
        if not isinstance(s, dict):
            errs.append(f"{tag} must be a JSON object")
            continue
        if type(s.get("section_id")) is not int or s["section_id"] not in sids:
            errs.append(f"{tag}: section_id {s.get('section_id')} not in toc.md")
        if not isinstance(s.get("why", ""), str):
            errs.append(f"{tag}: why must be text")
        if type(s.get("score")) is not int or s["score"] not in (1, 2, 3):
            errs.append(f"{tag}: score must be 1, 2 or 3 (omit irrelevant spans)")
        for key in ("start_cue", "end_cue"):
            if type(s.get(key)) is not int or s[key] not in wcues:
                errs.append(f"{tag}: {key} {s.get(key)} is not a cue in this window "
                            f"(c{w['first_cue']}..c{w['last_cue']})")
        if (type(s.get("start_cue")) is int and type(s.get("end_cue")) is int
                and s["start_cue"] in rank and s["end_cue"] in rank
                and rank[s["start_cue"]] > rank[s["end_cue"]]):
            errs.append(f"{tag}: start_cue after end_cue")
    return errs

def ingest():
    con = db(); con.executescript(SPANS_SCHEMA)
    total = 0
    for d in sorted((W / "lectures").glob("L*")):
        lid = lid_of(d.name)
        rank = {c: i for i, c in enumerate(lecture_cues(con, lid))}
        byrank = {i: c for c, i in rank.items()}
        raw = []
        for w in json.loads((d / "windows.json").read_text()):
            if check_fine(lid, w["k"]):
                continue
            data, _ = load_json(W / "out/fine" / f"L{lid}_w{w['k']}.json")
            raw += [(s["section_id"], rank[s["start_cue"]], rank[s["end_cue"]], s["score"],
                     s.get("why", "")) for s in data["spans"]]
        # merge duplicates from overlapping windows: same section, same score,
        # overlapping/adjacent cue ranges -> union. Different scores are kept
        # separate; the client's segment merge takes the max anyway.
        merged = []
        for sid, a, b, sc, why in sorted(raw, key=lambda r: (r[0], r[3], r[1])):
            m = merged[-1] if merged else None
            if m and m[0] == sid and m[3] == sc and a <= m[2] + 1:
                m[2] = max(m[2], b)
            else:
                merged.append([sid, a, b, sc, why])
        merged.sort(key=lambda r: (r[1], r[0]))
        con.execute("DELETE FROM spans WHERE lecture_id=?", (lid,))
        con.executemany("INSERT INTO spans VALUES(?,?,?,?,?,?)",
                        [(sid, lid, byrank[a], byrank[b], sc, why) for sid, a, b, sc, why in merged])
        total += len(merged)
        print(f"L{lid}: {len(raw)} raw spans -> {len(merged)} merged")
    con.commit()
    print(f"ingested {total} spans")

def status():
    con = db()
    for d in sorted((W / "lectures").glob("L*")):
        lid = lid_of(d.name)
        windows = json.loads((d / "windows.json").read_text())
        c = "ok" if not check_coarse(lid) else ("invalid" if (W/"out/coarse"/f"L{lid}.json").exists() else "missing")
        f = {"ok": [], "missing": [], "invalid": []}
        for w in windows:
            p = W / "out/fine" / f"L{lid}_w{w['k']}.json"
            f["ok" if not check_fine(lid, w["k"]) else ("invalid" if p.exists() else "missing")].append(w["k"])
        print(f"L{lid}: coarse={c} fine ok={len(f['ok'])}/{len(windows)} "
              f"missing={f['missing']} invalid={f['invalid']}")
    try:
        unmapped = con.execute("""SELECT s.id, s.number, s.title FROM sections s
            WHERE NOT EXISTS (SELECT 1 FROM spans p WHERE p.section_id=s.id)""").fetchall()
        print(f"sections with no spans: {len(unmapped)}")
        for sid, num, t in unmapped:
            print(f"  S{sid} {num or ''} {t}")
    except sqlite3.OperationalError:
        pass  # spans table not created yet

def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="study.sqlite")
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("status")
    c = sp.add_parser("check-coarse"); c.add_argument("lecture")
    p = sp.add_parser("plan"); p.add_argument("--neighbours", type=int, default=1)
    f = sp.add_parser("check-fine"); f.add_argument("lecture"); f.add_argument("window", type=int)
    sp.add_parser("ingest")
    ARGS = ap.parse_args()
    if ARGS.cmd == "status": status()
    elif ARGS.cmd == "check-coarse":
        e = check_coarse(lid_of(ARGS.lecture)); fail(e) if e else print("OK")
    elif ARGS.cmd == "plan": plan(ARGS.neighbours)
    elif ARGS.cmd == "check-fine":
        e = check_fine(lid_of(ARGS.lecture), ARGS.window); fail(e) if e else print("OK")
    elif ARGS.cmd == "ingest": ingest()

if __name__ == "__main__":
    main()
