You are scoring how relevant each stretch of a physics lecture is to sections of
the course notes.

Use these attachments:
- `work/lectures/L<id>/window_<k>.md`: about 10 minutes of transcript, as
  `[c<cue_id> mm:ss] text`
- `work/lectures/L<id>/window_<k>.candidates.md`: the candidate sections. Use every attached
  `work/sections/S<id>.md` file it lists.
- `work/toc.md`: in case the lecturer refers to a section outside the candidates.

The subtitles are machine-generated and garble technical terms, so match on meaning.

Output **spans**: contiguous cue ranges that relate to one section, scored:
- **3**: the section's content is being taught: derivation, explanation, a worked
  example, defining its concepts.
- **2**: substantial discussion: applying it, an extended recap, Q&A about it,
  comparing it with something else.
- **1**: a brief mention or reference ("remember the Debye length", "we'll see this
  next week").
- Not relevant: omit it. Course admin and off-topic chat get no spans.

Rules:
- Start a new span when the section or the score changes. Keep spans tight: start at
  the first relevant cue and end at the last.
- Spans for different sections may overlap if the lecturer is genuinely connecting
  two sections at once.
- Map an attached numbered equation when the speaker states, derives, or explains
  that particular relationship. A subsection span can cover the broader discussion.
- Prefer the most specific section. Tag a parent only for its own introductory
  material.
- Use only cue ids that appear in this window.

Return only a JSON object matching this example. Do not write files or wrap the response in Markdown:
```json
{"lecture_id": <id>, "window": <k>, "spans": [
  {"section_id": 12, "start_cue": 1203, "end_cue": 1219, "score": 3,
   "why": "derives lambda_D"}
]}
```
