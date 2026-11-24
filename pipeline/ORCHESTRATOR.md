# Lecture mapping

From the course directory, run `make_packets.py` with the lecture IDs to map and
then run `python /path/to/pipeline/run_mapping.py --db study.sqlite`.
Use a fresh `work/` for a different selection or changed inputs. The runner
resumes valid JSON in the existing workspace and maps every lecture packet in it.

The runner dispatches up to eight low-effort GPT-6-Luna workers through the
authenticated Codex CLI. Change concurrency with `--jobs`. Python renders the
coarse and fine prompts, checks the worker responses, retries failed jobs once
with their diagnostics, plans candidates from coarse output, and merges and
loads the fine spans. Python attaches the relevant packet text to each worker prompt. Workers return JSON. Their logs,
rendered prompts, and summary report are in `work/out/jobs/`.

Ordering checks flag large jumps within a lecture and gaps or reversals between
consecutive lectures within the same notes document. GPT-6-Luna reviews flagged
lectures and writes brief findings to `work/out/jobs/review-L*.json`. Findings are
advisory. Check any proposed correction against the cited cues before editing
the relevant coarse or fine output. If a coarse correction changes fine-pass
candidates, remove the affected fine JSON files before rerunning.

If a coarse or fine job fails twice, the runner leaves the study database's
spans alone and points to the job report. Rerun with the same packets to resume
after addressing the error. Successful runs print counts and save the full
unmapped section list and advisory review status in `work/out/jobs/report.json`.
