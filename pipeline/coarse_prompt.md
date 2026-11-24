You are mapping a physics lecture to its course notes.

Use the attached `work/toc.md` (the notes' table of contents; every section has an id like
`S12`) and `work/lectures/L<id>/transcript.md` (the whole lecture, one subtitle cue
per line as `[c<cue_id> mm:ss] text`).

The subtitles are machine-generated and garble technical terms, so match on meaning
("Debbie length" is the Debye length). Spoken maths won't look like the notes'
notation.

List every notes section this lecture discusses, with:
- `role`: `primary` if the section's material is taught here; `recap` if it's reviewed
  at length; `mention` if it's only referenced briefly.
- `first_cue` / `last_cue`: the approximate cue range where it's covered. For a
  `mention`, use the cue of the mention.

Prefer the most specific (deepest) section. Tag a parent section only for its own
introductory material. Skip course admin, logistics, and off-topic chat.

Return only a JSON object matching this example. Do not write files or wrap the response in Markdown:
```json
{"lecture_id": <id>, "sections": [
  {"section_id": 12, "role": "primary", "first_cue": 1203, "last_cue": 1450,
   "note": "derives Debye length from Poisson + Boltzmann"}
]}
```
`section_id` is the integer from `S<id>`. Order the entries by `first_cue`.
