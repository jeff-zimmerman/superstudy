#!/usr/bin/env python3
"""
Build the client-side semantic search index.

- Transcript chunks: ~30 s windows with a 15 s stride, built from cues.
- Section vectors: title + first part of each notes section.
- Embedded with BAAI/bge-small-en-v1.5 (CLS pooling, L2-normalised) - the same
  model the browser runs via transformers.js (Xenova/bge-small-en-v1.5), so
  query and document vectors live in the same space.
- Stored as int8 (round(v*127)) in embeddings.bin, row-major [N, 384].

Writes into the DB:
  chunks(id, lecture_id, start_cue, end_cue, start, end)
  vectors(row, kind, ref_id)        kind = 'chunk' | 'section'
  meta(key, value)                  model, dim, query_prefix, scale

Usage:
  pip install sentence-transformers
  python build_index.py --db study.sqlite --out embeddings.bin
  python build_index.py --dummy ...   # random vectors, for testing without the model
"""
import argparse, json, sqlite3
import numpy as np

MODEL = "BAAI/bge-small-en-v1.5"
CLIENT_MODEL = "Xenova/bge-small-en-v1.5"
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
DIM = 384

SCHEMA = """
DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS meta;
CREATE TABLE chunks(id INTEGER PRIMARY KEY, lecture_id INTEGER, start_cue INTEGER,
  end_cue INTEGER, start REAL, end REAL);
CREATE TABLE vectors(row INTEGER PRIMARY KEY, kind TEXT, ref_id INTEGER);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
"""

def make_chunks(con, window, stride):
    out = []
    for (lid,) in con.execute("SELECT id FROM lectures ORDER BY ord"):
        cues = con.execute("SELECT id, start, end, text FROM cues WHERE lecture_id=? ORDER BY start",
                           (lid,)).fetchall()
        if not cues:
            continue
        t, last = 0.0, cues[-1][2]
        while t < last:
            win = [c for c in cues if t <= c[1] < t + window]
            if win:
                out.append((lid, win[0][0], win[-1][0], win[0][1], win[-1][2],
                            " ".join(c[3] for c in win)))
            t += stride
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="study.sqlite")
    ap.add_argument("--out", default="embeddings.bin")
    ap.add_argument("--window", type=float, default=30)
    ap.add_argument("--stride", type=float, default=15)
    ap.add_argument("--section-chars", type=int, default=1500)
    ap.add_argument("--dummy", action="store_true")
    a = ap.parse_args()

    con = sqlite3.connect(a.db)
    con.executescript(SCHEMA)
    chunks = make_chunks(con, a.window, a.stride)
    secs = con.execute("SELECT id, number, title, text FROM sections ORDER BY id").fetchall()

    texts, rows = [], []
    for i, (lid, c0, c1, t0, t1, text) in enumerate(chunks):
        con.execute("INSERT INTO chunks VALUES(?,?,?,?,?,?)", (i, lid, c0, c1, t0, t1))
        texts.append(text); rows.append(("chunk", i))
    for sid, num, title, text in secs:
        texts.append(f"{num or ''} {title}. {text[:a.section_chars]}"); rows.append(("section", sid))

    if a.dummy:
        rng = np.random.default_rng(0)
        vecs = rng.standard_normal((len(texts), DIM)).astype(np.float32)
        vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
    else:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(MODEL)
        vecs = model.encode(texts, batch_size=64, normalize_embeddings=True,
                            show_progress_bar=True, convert_to_numpy=True)
    q = np.clip(np.round(vecs * 127), -127, 127).astype(np.int8)
    q.tofile(a.out)

    con.executemany("INSERT INTO vectors VALUES(?,?,?)", [(i, k, r) for i, (k, r) in enumerate(rows)])
    meta = dict(model=CLIENT_MODEL, dim=DIM, query_prefix=QUERY_PREFIX, scale=127,
                pooling="cls", dummy=a.dummy, rows=len(rows))
    con.executemany("INSERT INTO meta VALUES(?,?)", [(k, json.dumps(v)) for k, v in meta.items()])
    con.commit()
    print(f"{len(chunks)} chunks + {len(secs)} sections -> {a.out} "
          f"({q.nbytes/1e6:.2f} MB){' [DUMMY]' if a.dummy else ''}")

if __name__ == "__main__":
    main()
