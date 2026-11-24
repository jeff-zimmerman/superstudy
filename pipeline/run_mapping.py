#!/usr/bin/env python3
"""Run lecture mapping from the course directory, using Codex workers."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import re
from pathlib import Path
import shutil
import sqlite3
import subprocess
from types import SimpleNamespace

import spans


def run_worker(job, output, validate):
    """Run a file-backed job and retry once with the validation errors."""
    prompt = job.read_text()
    log = job.with_suffix(".log")
    response = job.with_suffix(".response")
    errors = []
    for attempt in range(1, 3):
        response.unlink(missing_ok=True)
        retry = "\nRetry after these errors:\n" + "\n".join(errors[:30]) if errors else ""
        with log.open("a") as stream:
            stream.write(f"\nAttempt {attempt}\n")
            stream.flush()
            result = subprocess.run(
                ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
                 "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"',
                 "--output-last-message", str(response.resolve()), "-"],
                input="All reference material is attached below. Do not call tools.\n\n" + prompt + retry, text=True, stdout=stream, stderr=subprocess.STDOUT,
            )
        if result.returncode or not response.is_file():
            errors = [f"Worker failed (exit {result.returncode}); see {log}"]
            continue
        _, error = spans.load_json(response)
        if error:
            errors = [error]
            continue
        # Validate the staged response before keeping it as the job result.
        output.parent.mkdir(parents=True, exist_ok=True)
        response.replace(output)
        errors = validate()
        if not errors:
            return []
        output.replace(response)
    return errors


def ordering_jobs(lectures, directory):
    """Write review prompts for large jumps and gaps between adjacent lectures."""
    with spans.db() as con:
        # Compare numbered sections within the same document. Equation counts
        # vary substantially by section, so exclude equations from this rank.
        rows = con.execute(
            "SELECT s.id, s.doc_id, s.title FROM sections s JOIN docs d ON d.id=s.doc_id "
            "WHERE s.number IS NOT NULL AND s.title NOT LIKE 'Equation (%' ORDER BY d.ord,s.ord"
        ).fetchall()
        cues = {lid: spans.lecture_cues(con, lid) for lid in lectures}
    positions = {sid: (i, doc) for i, (sid, doc, _) in enumerate(rows)}
    issues = {}
    previous = None
    for lid in lectures:
        data, _ = spans.load_json(spans.W / "out/coarse" / f"L{lid}.json")
        cue_rank = {cue: i for i, cue in enumerate(cues[lid])}
        primary = sorted(
            (s for s in data["sections"] if s["role"] == "primary" and s["section_id"] in positions),
            key=lambda s: cue_rank[s["first_cue"]],
        )
        for left, right in zip(primary, primary[1:]):
            a, doc_a = positions[left["section_id"]]
            b, doc_b = positions[right["section_id"]]
            if doc_a == doc_b and abs(b - a) >= 4:
                issues.setdefault(lid, []).append(
                    f"S{left['section_id']} to S{right['section_id']} jumps {b-a:+d} sections "
                    f"at cues c{left['first_cue']} and c{right['first_cue']}."
                )
        if previous and primary and lid == previous[0] + 1:
            prior_lid, last = previous
            first = primary[0]
            a, doc_a = positions[last["section_id"]]
            b, doc_b = positions[first["section_id"]]
            if doc_a == doc_b and (b - a > 1 or a - b >= 4):
                between = ", ".join(f"S{sid}" for sid, _, _ in rows[min(a,b)+1:max(a,b)])
                for target, cue in ((prior_lid, last["last_cue"]), (lid, first["first_cue"])):
                    issues.setdefault(target, []).append(
                        f"L{prior_lid} ends at S{last['section_id']}, L{lid} starts at "
                        f"S{first['section_id']}; intervening sections: {between}. Inspect near c{cue}."
                    )
        previous = (lid, primary[-1]) if primary else None
    jobs = []
    toc = (spans.W / "toc.md").read_text() if issues else ""
    for lid, flags in issues.items():
        prompt = directory / f"review-L{lid}.md"
        transcript = (spans.W / "lectures" / f"L{lid}" / "transcript.md").read_text()
        referenced = set(re.findall(r"\bc(\d+)", " ".join(flags)))
        lines = transcript.splitlines()
        nearby = set()
        for index, line in enumerate(lines):
            match = re.match(r"\[c(\d+) ", line)
            if match and match[1] in referenced:
                nearby.update(range(max(0, index - 40), min(len(lines), index + 41)))
        excerpt = "\n".join(lines[index] for index in sorted(nearby))
        prompt.write_text(
            f"Review only these advisory ordering flags for lecture L{lid}. Read the relevant "
            "attached cue excerpts and table of contents. State when the excerpt is inconclusive. "
            "Legitimate out-of-order teaching is fine. Return a JSON object with a findings "
            "array of brief strings saying which flags are confirmed and which suggest a "
            "mapping correction. Include section and cue IDs for proposed corrections.\n"
            + "\n".join(flags) + f"\n\nTable of contents\n{toc}\nTranscript excerpts\n{excerpt}\n"
        )
        jobs.append((lid, prompt))
    return jobs


def main():
    """Prepare and dispatch jobs, validate all mapping outputs, and ingest."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="study.sqlite")
    parser.add_argument("--jobs", type=int, default=8)
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    if shutil.which("codex") is None:
        parser.error("Codex CLI is required")
    if not Path(args.db).is_file():
        parser.error(f"database does not exist: {args.db}")
    spans.ARGS = SimpleNamespace(db=args.db)
    directory = spans.W / "out/jobs"
    directory.mkdir(parents=True, exist_ok=True)
    lectures = sorted(spans.lid_of(path.name) for path in (spans.W / "lectures").glob("L*"))
    if not lectures:
        parser.error("no lecture packets found; run make_packets.py first")
    report = directory / "report.json"
    templates = Path(__file__).resolve().parent
    toc = (spans.W / "toc.md").read_text()

    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for phase in ("coarse", "fine"):
            template = (templates / f"{phase}_prompt.md").read_text()
            pending = {}
            for lid in lectures:
                packet = spans.W / "lectures" / f"L{lid}"
                windows = [None] if phase == "coarse" else [
                    w["k"] for w in json.loads((packet / "windows.json").read_text())
                ]
                for window in windows:
                    if window is None:
                        key = f"L{lid}"
                        def validate(lid=lid):
                            return spans.check_coarse(lid)
                    else:
                        key = f"L{lid}_w{window}"
                        def validate(lid=lid, window=window):
                            return spans.check_fine(lid, window)
                    output = spans.W / "out" / phase / f"{key}.json"
                    if validate() == []:
                        continue
                    job = directory / f"{phase}-{key}.md"
                    # Attach inputs in Python so the worker can score in one turn
                    # without spending context on shell commands or their output.
                    if window is None:
                        files = [packet / "transcript.md"]
                    else:
                        candidates = packet / f"window_{window}.candidates.md"
                        sections = re.findall(r"^- (work/sections/S[0-9]+\.md) ", candidates.read_text(), re.M)
                        files = [packet / f"window_{window}.md", candidates, *map(Path, sections)]
                    attachments = "\n".join(f"\n=== {path} ===\n{path.read_text()}" for path in files)
                    instructions = template.replace("<id>", str(lid)).replace("<k>", str(window))
                    job.write_text(f"{instructions}\n=== work/toc.md ===\n{toc}{attachments}")
                    pending[key] = pool.submit(run_worker, job, output, validate)

            failures = {key: errors for key, task in pending.items() if (errors := task.result())}
            if failures:
                report.write_text(json.dumps({"phase": phase, "failures": failures}, indent=2))
                parser.exit(1, f"{phase} failed for {', '.join(failures)}. Details in {report}\n")
            if phase == "coarse":
                spans.plan(neighbours=1)

        reviews = {}
        for lid, job in ordering_jobs(lectures, directory):
            output = job.with_suffix(".json")
            def validate_review(output=output):
                value, error = spans.load_json(output)
                if error:
                    return [error]
                if not isinstance(value.get("findings"), list) or not all(
                    isinstance(finding, str) for finding in value["findings"]
                ):
                    return ["expected a JSON object with a findings array"]
                return []
            reviews[lid] = (output, pool.submit(run_worker, job, output, validate_review))
        ordering = {
            lid: {"file": str(output), "errors": task.result()}
            for lid, (output, task) in reviews.items()
        }

    spans.ingest()
    with sqlite3.connect(args.db) as con:
        counts = {lid: con.execute("SELECT count(*) FROM spans WHERE lecture_id=?", (lid,)).fetchone()[0]
                  for lid in lectures}
        unmapped = con.execute(
            "SELECT id, title FROM sections WHERE NOT EXISTS "
            "(SELECT 1 FROM spans WHERE spans.section_id = sections.id) ORDER BY id"
        ).fetchall()
    report.write_text(json.dumps({"spans": counts, "unmapped": unmapped, "ordering": ordering}, indent=2))
    print(f"{sum(counts.values())} spans across {len(counts)} lectures. "
          f"{len(unmapped)} unmapped sections. {len(ordering)} advisory reviews "
          f"({sum(bool(item['errors']) for item in ordering.values())} failed). Details in {report}")


if __name__ == "__main__":
    main()
