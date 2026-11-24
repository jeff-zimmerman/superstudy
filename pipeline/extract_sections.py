#!/usr/bin/env python3
"""
Extract numbered headings and equation targets from LaTeX-built PDFs.

Each heading owns the text up to the next heading. Numbered equation labels
are separate targets within their containing section.

Coordinates are PDF points, origin top-left, relative to the page's cropbox
(same convention PDF.js uses after viewport scaling). Page sizes are stored so
the client can scale: css_px = pt * (viewport.width / page_width).

Usage:
  python extract_sections.py notes1.pdf notes2.pdf --db study.sqlite --preview previews/
Stores relative keys (notes/<file>.pdf), resolved by the app against the course's media_prefix.
"""
import argparse, difflib, json, re, sqlite3, sys
from collections import Counter
from pathlib import Path

import pymupdf

SCHEMA = """
CREATE TABLE IF NOT EXISTS docs(id INTEGER PRIMARY KEY, title TEXT, pdf_url TEXT, ord INTEGER);
CREATE TABLE IF NOT EXISTS pages(doc_id INTEGER, page INTEGER, width REAL, height REAL,
  PRIMARY KEY(doc_id, page));
CREATE TABLE IF NOT EXISTS sections(id INTEGER PRIMARY KEY, doc_id INTEGER, parent_id INTEGER,
  level INTEGER, ord INTEGER, title TEXT, number TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS regions(section_id INTEGER, page INTEGER,
  x0 REAL, y0 REAL, x1 REAL, y1 REAL);
CREATE INDEX IF NOT EXISTS regions_page ON regions(page, section_id);
"""

def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()

def find_furniture(doc, frac=0.14, min_share=0.3):
    """Running headers/footers and page numbers: lines in the top/bottom margin
    whose (digit-stripped) text repeats on many pages, or which are bare numbers."""
    keyed = Counter()
    per_page = []
    for page in doc:
        h = page.rect.height
        lines = []
        for b in page.get_text("dict")["blocks"]:
            for l in b.get("lines", []):
                y0, y1 = l["bbox"][1], l["bbox"][3]
                if y1 < h * frac or y0 > h * (1 - frac):
                    txt = "".join(s["text"] for s in l["spans"])
                    key = re.sub(r"\d+", "#", norm(txt))
                    lines.append((pymupdf.Rect(l["bbox"]), txt, key))
                    keyed[key] += 1
        per_page.append(lines)
    n = len(doc)
    furniture = []
    for lines in per_page:
        rects = [r for r, txt, key in lines
                 if keyed[key] >= max(2, min_share * n) or re.fullmatch(r"\s*\d+\s*", txt)]
        furniture.append(rects)
    return furniture

def content_box(page, furniture_rects):
    """Union of text/drawing bboxes, excluding headers/footers."""
    box = pymupdf.Rect()
    for b in page.get_text("blocks"):
        r = pymupdf.Rect(b[:4])
        if any(r.intersects(f) for f in furniture_rects):
            # block may merge header with body; trim by keeping only lines outside furniture
            continue
        box |= r
    for d in page.get_drawings():
        r = d["rect"]
        if r.is_valid and not any(r.intersects(f) for f in furniture_rects):
            box |= r
    for img in page.get_image_info():
        box |= pymupdf.Rect(img["bbox"])
    return box if not box.is_empty else page.rect

def visual_lines(page, tol=2.5, *, bold_only=False):
    """Merge PDF text lines that share a baseline (LaTeX emits the section
    number and title as separate spans). Returns [(y_top, text)] sorted by y."""
    raw = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            txt = "".join(s["text"] for s in l["spans"]).strip()
            if bold_only and sum(len(s["text"].strip()) for s in l["spans"]
                                 if s["flags"] & 16) <= len(txt) / 2:
                continue
            if txt:
                raw.append((l["spans"][0]["origin"][1], l["bbox"][1], l["bbox"][0], txt))
    raw.sort()
    out = []
    for base, top, x, txt in raw:
        if out and abs(out[-1][0] - base) < tol:
            out[-1][1] = min(out[-1][1], top)
            out[-1][2].append((x, txt))
        else:
            out.append([base, top, [(x, txt)]])
    return [(top, " ".join(t for _, t in sorted(parts))) for _, top, parts in out]

def locate_heading(page, title, dest_y_candidates):
    """Find the text line matching the bookmark title closest to the dest y.
    Returns (y_top, number) where number is e.g. '2.1.1' if present."""
    want = norm(title)
    best = None
    for y, txt in visual_lines(page):
        m = re.match(r"^((?:\d+|[A-Z])(?:\.\d+)*)\.?\s+(.*)$", txt)
        number, body = (m.group(1), m.group(2)) if m else ("", txt)
        ratio = difflib.SequenceMatcher(None, want, norm(body)).ratio()
        if ratio < 0.75:
            continue
        dist = min(abs(y - c) for c in dest_y_candidates) if dest_y_candidates else 0
        score = ratio - dist / page.rect.height
        if best is None or score > best[0]:
            best = (score, y, number)
    return (best[1], best[2]) if best else (None, "")

def extract(pdf_path):
    """Extract clickable regions from bookmarks and printed numbered headings."""
    doc = pymupdf.open(pdf_path)
    toc = doc.get_toc(simple=False)
    furniture = find_furniture(doc)
    boxes = [content_box(p, furniture[i]) for i, p in enumerate(doc)]

    # 1. resolve each bookmark to (page, y_top)
    marks = []
    for lvl, title, pno1, dest in toc:
        pno = dest.get("page", pno1 - 1)
        if pno is None or pno < 0:
            pno = pno1 - 1
        page = doc[pno]
        cands = []
        to = dest.get("to")
        if to is not None:
            # PyMuPDF reports dest points in PDF space (origin bottom-left);
            # include both interpretations and let heading text decide.
            cands = [page.rect.height - to.y, to.y]
        y, number = locate_heading(page, title, cands)
        if y is None:
            y = cands[0] if cands else boxes[pno].y0
            print(f"  warn: heading text not found for '{title}' p{pno+1}; using dest y={y:.0f}",
                  file=sys.stderr)
        y = max(y - 2, 0)  # small pad above heading, even above the first body block
        marks.append(dict(level=lvl, title=title, page=pno, y=y, number=number))

    if not toc:
        # Chapter titles can wrap below a standalone chapter number.
        for pno, page in enumerate(doc):
            lines = visual_lines(page, bold_only=True)
            for i, (y, text) in enumerate(lines):
                chapter = re.fullmatch(r"Chapter\s+(\d+)(?:\s*[:.]?\s+(\S.*))?", text, re.I)
                if not chapter:
                    continue
                number, title = chapter.groups()
                if title is None:
                    parts = []
                    for top, line in lines[i + 1:]:
                        if top > y + 65 or re.match(r"(?:\d+|[A-Z])\.\d+", line):
                            break
                        parts.append(line)
                    title = " ".join(parts) or text
                marks.append(dict(level=1, title=title, page=pno, y=max(y - 2, 0), number=number))

    # Bold numbering distinguishes printed headings from equation labels and prose.
    # Start at the first outline destination to skip entries in the printed TOC.
    marks.sort(key=lambda m: (m["page"], m["y"]))
    outline = iter(marks)
    next_mark = next(outline, None)
    parent = None
    discovered = []
    named = doc.resolve_names()
    heading_names = {name.removeprefix("section."): dest for name, dest in named.items()
                     if name.startswith("section.")}
    for pno in range(next_mark["page"] if toc and next_mark else 0, len(doc)):
        for y, text in visual_lines(doc[pno], bold_only=True):
            y = max(y - 2, 0)
            while next_mark and (next_mark["page"], next_mark["y"]) <= (pno, y + 3):
                parent = next_mark
                next_mark = next(outline, None)
            if (toc and parent is None) or (parent and parent["page"] == pno and abs(parent["y"] - y) <= 3):
                continue
            heading = re.fullmatch(r"((?:[A-Z]|\d+)(?:\.\d+)+)\.?\s+(\S.*)", text)
            if heading:
                number, title = heading.groups()
                dest = heading_names.get(number)
                # A PDF exported without an outline can retain page-only destinations.
                if dest and (dest["page"] != pno or
                             (toc and abs(doc[pno].rect.height - dest["to"][1] - y) > 30)):
                    continue
                discovered.append(dict(level=number.count(".") + 1, title=title,
                                       page=pno, y=y, number=number))
    marks = sorted(marks + discovered, key=lambda m: (m["page"], m["y"]))
    if not marks:
        raise SystemExit(f"{pdf_path}: no bookmarks or numbered headings")

    # 2. parent links (stack by level)
    stack = []
    for i, m in enumerate(marks):
        while stack and marks[stack[-1]]["level"] >= m["level"]:
            stack.pop()
        m["parent"] = stack[-1] if stack else None
        stack.append(i)

    # 3. regions: from this mark to the next mark (any level) / end of doc
    for i, m in enumerate(marks):
        if i + 1 < len(marks):
            end_page, end_y = marks[i + 1]["page"], marks[i + 1]["y"]
        else:
            end_page, end_y = len(doc) - 1, boxes[-1].y1
        regs = []
        for p in range(m["page"], end_page + 1):
            b = boxes[p]
            y0 = m["y"] if p == m["page"] else b.y0
            y1 = end_y if p == end_page else b.y1
            if y1 - y0 > 4:
                regs.append((p, b.x0, y0, b.x1, y1))
        m["regions"] = regs
        # text, excluding header/footer lines
        parts = []
        for p, x0, y0, x1, y1 in regs:
            clip = pymupdf.Rect(x0, y0, x1, y1)
            for blk in doc[p].get_text("blocks", clip=clip, sort=True):
                r = pymupdf.Rect(blk[:4])
                if not any(r.intersects(f) for f in furniture[p]):
                    parts.append(blk[4].strip())
        m["text"] = "\n".join(t for t in parts if t)

    # Locate displayed formulas by their labels, then build targets from the formula glyphs.
    equation_labels = {}
    for name, dest in named.items():
        if re.fullmatch(r"equation\.(?:[A-Z]|\d+)(?:\.\d+)+", name):
            _, chapter, *suffix = name.split(".")
            equation_labels.setdefault(dest["page"], {})[f"({chapter}.{suffix[-1]})"] = dest
    equations = []
    for pno, labels in sorted(equation_labels.items()):
        page = doc[pno]
        printed = {}
        blocks = page.get_text("dict")["blocks"]
        for block in blocks:
            for line in block.get("lines", []):
                text = "".join(s["text"] for s in line["spans"]).strip()
                match = re.search(r"\((?:[A-Z]|\d+)\.\d+\)$", text)
                if not match or match[0] not in labels:
                    continue
                label = match[0]
                line_rect = pymupdf.Rect(line["bbox"])
                matches = page.search_for(label, clip=line_rect + (-1, -1, 1, 1))
                if not matches:
                    continue
                rect = matches[-1]
                if toc:
                    dest_y = page.rect.height - labels[label]["to"][1]
                else:
                    # Use the printed label's baseline when the destination gives only a page.
                    if rect.x1 < boxes[pno].x1 - 12:
                        continue
                    dest_y = rect.y0
                # Prefer the right-aligned display label over in-text references.
                distance = abs(rect.y0 - dest_y)
                score = (round(rect.x1), -distance)
                if distance <= 80 and (label not in printed or score > printed[label][0]):
                    printed[label] = (score, rect, dest_y)
        ordered = sorted(printed.items(), key=lambda item: item[1][1].y0)
        for i, (label, (_, rect, dest_y)) in enumerate(ordered):
            owner = next((i for i in range(len(marks) - 1, -1, -1)
                          if (marks[i]["page"], marks[i]["y"]) <= (pno, rect.y0)), None)
            if owner is None:
                continue
            # Stay between neighbouring labels and inside the indented display area.
            upper = (ordered[i - 1][1][1].y1 + rect.y0) / 2 if i else 0
            lower = (rect.y1 + ordered[i + 1][1][1].y0) / 2 if i + 1 < len(ordered) else page.rect.height
            fragments = [pymupdf.Rect(span["bbox"]) for block in blocks
                         for line in block.get("lines", [])
                         if line["bbox"][0] >= boxes[pno].x0 + 12
                         for span in line["spans"] if span["text"].strip()
                         and span["bbox"][2] <= rect.x0 - 3
                         and upper <= (span["bbox"][1] + span["bbox"][3]) / 2 <= lower]
            formula = pymupdf.Rect()
            top, bottom = rect.y0, rect.y1
            # Follow vertically connected fragments to include tall operators and aligned rows.
            while fragments:
                nearby = [part for part in fragments if part.y1 >= top - 4 and part.y0 <= bottom + 4]
                if not nearby:
                    break
                for part in nearby:
                    formula |= part
                    fragments.remove(part)
                top, bottom = min(top, formula.y0), max(bottom, formula.y1)
            # Capture the displayed formula for search and relevance mapping.
            clip = pymupdf.Rect(page.rect.x0, min(dest_y, rect.y0), rect.x0, rect.y1 + 4)
            equations.append(dict(level=marks[owner]["level"] + 1, parent=owner,
                                  title=f"Equation {label}", number="", page=pno,
                                  y=rect.y0, text=page.get_text(clip=clip, sort=True).strip(),
                                  regions=[] if formula.is_empty else [(pno, *formula)]))
    marks.extend(equations)

    pages = [(i, p.rect.width, p.rect.height) for i, p in enumerate(doc)]
    return doc, marks, pages

def write_db(db, doc_ord, pdf_path, marks, pages, pdf_url_prefix):
    cur = db.cursor()
    cur.execute("INSERT INTO docs(title, pdf_url, ord) VALUES(?,?,?)",
                (Path(pdf_path).stem, pdf_url_prefix + Path(pdf_path).name, doc_ord))
    doc_id = cur.lastrowid
    cur.executemany("INSERT INTO pages VALUES(?,?,?,?)", [(doc_id, *p) for p in pages])
    ids = []
    for i, m in enumerate(marks):
        parent = ids[m["parent"]] if m["parent"] is not None else None
        cur.execute("INSERT INTO sections(doc_id,parent_id,level,ord,title,number,text) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (doc_id, parent, m["level"], i, m["title"], m["number"], m["text"]))
        ids.append(cur.lastrowid)
        cur.executemany("INSERT INTO regions VALUES(?,?,?,?,?,?)",
                        [(cur.lastrowid, *r) for r in m["regions"]])
    db.commit()
    return doc_id

def preview(doc, marks, outdir, dpi=60):
    outdir.mkdir(parents=True, exist_ok=True)
    colors = [(1, .3, .3), (.2, .6, 1), (.2, .8, .3), (1, .6, 0), (.7, .3, 1)]
    by_page = {}
    for i, m in enumerate(marks):
        for r in m["regions"]:
            by_page.setdefault(r[0], []).append((i, m, r))
    for p, items in by_page.items():
        page = doc[p]
        for i, m, (_, x0, y0, x1, y1) in items:
            c = colors[i % len(colors)]
            rect = pymupdf.Rect(x0, y0, x1, y1)
            page.draw_rect(rect, color=c, fill=c, fill_opacity=0.12, width=1)
            page.insert_text((x1 + 3, y0 + 9), f"{m['number'] or i}", fontsize=8, color=c)
        page.get_pixmap(dpi=dpi).save(outdir / f"{Path(doc.name).stem}_p{p+1:03d}.png")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdfs", nargs="+")
    ap.add_argument("--db", default="study.sqlite")
    ap.add_argument("--json", help="also dump sections to this JSON file")
    ap.add_argument("--pdf-url-prefix", default="notes/", help="relative key prefix (the app prepends the course media_prefix), or an absolute URL")
    ap.add_argument("--preview", type=Path, help="write PNGs with overlays drawn")
    a = ap.parse_args()

    db = sqlite3.connect(a.db)
    db.executescript(SCHEMA)
    dump = []
    for k, pdf in enumerate(a.pdfs):
        doc, marks, pages = extract(pdf)
        doc_id = write_db(db, k, pdf, marks, pages, a.pdf_url_prefix)
        print(f"{pdf}: {len(marks)} sections, {len(pages)} pages (doc_id={doc_id})")
        for m in marks:
            print(f"  {'  '*(m['level']-1)}{m['number']:>7} {m['title'][:50]:50} "
                  f"p{m['page']+1} regions={len(m['regions'])} chars={len(m['text'])}")
        if a.preview:
            preview(doc, marks, a.preview)
        dump.append({"pdf": pdf, "sections": [{k: v for k, v in m.items()} for m in marks]})
    if a.json:
        Path(a.json).write_text(json.dumps(dump, indent=1))

if __name__ == "__main__":
    main()
