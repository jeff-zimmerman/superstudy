# Lecture study tool

A static web app that shows the course notes (PDF). Click any section to get the most relevant lecture clips, ranked, with thumbnails, and play them in place. Free-text search covers both the transcripts and the notes.

- **Hosting:** GitHub Pages serves the app, `study.sqlite` and `embeddings.bin`.
- **Storage:** a Cloudflare R2 bucket holds the videos, subtitles and PDFs.
- **No server:** everything runs in the browser (PDF.js, sql.js, MiniSearch, transformers.js).

## Layout

Each course has its own folder, and nothing is fetched until you open that course.

```
public/data/
  courses.csv              course list (the only file loaded at startup)
  plasma/
    study.sqlite           notes sections, cues, spans, search chunks
    embeddings.bin         search vectors
  mhd/
    study.sqlite
    embeddings.bin
```

Media lives on R2 under one prefix per course:

```
<bucket>/plasma/video/lecture1/s1.mp4
<bucket>/plasma/video/lecture2/s1.mp4
<bucket>/plasma/video/lecture2/s2.mp4
<bucket>/plasma/vtt/lecture1.vtt
<bucket>/plasma/notes/notes.pdf
```

`courses.csv` needs a header row; `id` and `title` are required.

| column | meaning |
|---|---|
| `id` | folder name under `data/`, also the URL (`#/plasma`) |
| `title` | display name |
| `code`, `term` | shown in the course list |
| `lectures`, `docs` | counts, shown in the list |
| `description` | one line on the welcome screen |

Extra columns are kept (in `course.extra`) for future use.

## One-time setup

1. **R2 CORS:** in the bucket's settings (Settings → CORS policy), paste `pipeline/r2-cors.json` with your Pages origin filled in. Video seeking, the canvas thumbnails, captions and PDF loading all need it.
2. **GitHub Pages:** in the repo, go to Settings → Pages → Source and choose "GitHub Actions". Add a repository secret named `PUBLIC_BUCKET_URL` under Settings → Secrets and variables → Actions. Set it to the public bucket root URL. Every push to `main` then deploys.
3. **Tools:**
   - `pip install pymupdf numpy sentence-transformers`
   - ffmpeg
   - Authenticated Codex CLI for the mapping workers

## Add a course

Work in a separate folder for each course (e.g. `~/courses/plasma/`), not inside this repo. `$P` is this repo's `pipeline/` folder.

```bash
# 1. web-ready video copies (H.264 + faststart) -> web/
$P/prepare_videos.sh raw/L01.mkv raw/L02.mkv ...

# 2. notes -> sections and overlay regions (stores keys like notes/<file>.pdf)
python $P/extract_sections.py notes/*.pdf --db study.sqlite --preview previews/

# 3. Arrange web-ready recordings as video/lecture1/s1.mp4, video/lecture2/s1.mp4, etc.
# Put a second recording in the same lecture directory as s2.mp4 when present.
# Use embedded subtitles, vtt/lectureN.vtt, or pass one --sidecar file per lecture in numeric order.
python $P/extract_cues.py video/ --db study.sqlite --out vtt/

# Preview and then save the active-board timeline for dual-screen lectures.
python $P/analyze_boards.py video/ --db study.sqlite --dry-run
python $P/analyze_boards.py video/ --db study.sqlite

# 4. relevance mapping with subagents
python $P/make_packets.py --db study.sqlite --work work/ --lectures 1 2 3
python $P/run_mapping.py --db study.sqlite

# 5. search index
python $P/build_index.py --db study.sqlite --out embeddings.bin
```

Upload the media to R2 under `<course-id>/`, keeping the file names the scripts saw:

| Local | R2 path |
|---|---|
| `video/lectureN/s*.mp4` | `<course-id>/video/lectureN/` |
| `vtt/*.vtt` | `<course-id>/vtt/` |
| `notes/*.pdf` | `<course-id>/notes/` |

For the Plasma course in this checkout, upload and verify the full course directory with rclone:

```bash
rclone --config ./rclone.conf copy public/data/plasma r2:lecture-materials/plasma --s3-no-check-bucket --checksum
rclone --config ./rclone.conf check public/data/plasma r2:lecture-materials/plasma --one-way
```

GitHub Pages still serves the database and vector index from the Git repository. The Pages workflow passes the `PUBLIC_BUCKET_URL` repository secret to Vite as `VITE_PUBLIC_BUCKET_URL`. The browser can see the URL in the deployed site. The production app appends the course ID from `courses.csv` and the relative media key from the database. Use the bucket root URL without a course prefix.

Then publish:

```bash
mkdir -p <repo>/public/data/<course-id>
cp study.sqlite embeddings.bin <repo>/public/data/<course-id>/
# add a row to <repo>/public/data/courses.csv
cd <repo> && git add public/data && git commit -m "add <course-id>" && git push
```

## Develop locally

```bash
npm install --ignore-scripts
npm run dev        # http://localhost:5173
```

For local development, put each course's `video/`, `vtt/` and `notes/` folders inside `public/data/<course-id>/`. The dev server uses these gitignored folders automatically. A production build with no bucket URL also uses local course folders.

## How it fits together

- **Courses:** the app starts on a course picker and loads only `courses.csv`. Opening a course (`#/<id>`, which works with bookmarks and the back button) fetches that course's database, caches it for the session, and resets the clip sidebar and player. The ☰ drawer switches courses at any time.

- **Section click:** the agent-scored `spans` for that section become hits. If the section has none of its own (a chapter heading, say), its subsections' spans are used.
- **Search:** keyword hits from MiniSearch and vector hits from bge-small are fused with reciprocal rank fusion. The transcript side yields 30-second chunk hits; the notes side yields section matches, which are highlighted in the PDF.
- **Segments:** both paths feed `mergeSegments()`, which joins hits less than 30 seconds apart. Segments are built per query, so two sections can share overlapping footage.
- **Playback:** one shared `<video>` with custom controls seeks to 2 seconds before the segment and pauses at its end. The browser fetches only the byte ranges it needs.
  - **Seek bar:** spans the whole lecture, with the clip marked in orange. Scrubbing outside the clip turns off stop-at-end; re-clicking a card restarts its clip.
  - **Speed:** 1×, 1.25×, 1.5× or 2×, remembered between visits.
  - **Other controls:** captions toggle and full screen. iOS Safari uses its native video full screen.
  - **Keys:** space or k plays/pauses, ←/→ jump 5 seconds, f toggles full screen, c toggles captions.
- **Thumbnails:** a hidden video seeks to each segment start and the frame is drawn to a canvas. They're generated lazily as cards scroll into view and cached in IndexedDB.
- **Search model:** about 30 MB, downloaded on the first search and then cached by the browser. If it can't load, search falls back to keywords only.
