import { useEffect, useRef, useState } from "preact/hooks";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Doc } from "../db";
import { data, highlighted, query, scrollTarget, selectSection } from "../store";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Render a PDF and scroll to requested section overlays. */
export function PdfView({ doc }: { doc: Doc }) {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setPdf(null); setErr(null);
    const task = pdfjs.getDocument({ url: doc.pdf_url });
    task.promise.then((p) => !cancelled && setPdf(p), (e) => !cancelled && setErr(String(e)));
    return () => { cancelled = true; task.destroy(); };
  }, [doc.pdf_url]);

  const target = scrollTarget.value;
  useEffect(() => {
    if (!target || target.docId !== doc.id || scrollTarget.peek() !== target) return;
    // The overlay exists before the PDF page is painted.
    const el = root.current?.querySelector(`[data-section="${target.sectionId}"]`);
    if (!el) return;
    el.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      block: "center",
    });
    scrollTarget.value = null;
  }, [target, doc.id]);

  if (err) return <div class="pdf-error">Couldn't load {doc.title}: {err}</div>;
  return (
    <div class="pdf" ref={root}>
      {doc.pages.map((p, i) => <Page key={i} doc={doc} index={i} pdf={pdf} w={p.w} h={p.h} />)}
    </div>
  );
}

function Page({ doc, index, pdf, w, h }: { doc: Doc; index: number; pdf: pdfjs.PDFDocumentProxy | null; w: number; h: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const renderedWidth = useRef(0);

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "800px 0px" });
    io.observe(box.current!);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !pdf) return;
    const cssWidth = box.current!.clientWidth;
    if (Math.abs(cssWidth - renderedWidth.current) < cssWidth * 0.2) return; // already rendered at ~this size
    let task: any;
    let cancelled = false;
    pdf.getPage(index + 1).then((page) => {
      if (cancelled) return;
      const scale = (cssWidth * Math.min(window.devicePixelRatio || 1, 2)) / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const c = canvas.current!;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      task = page.render({ canvas: c, viewport });
      task.promise.then(() => { renderedWidth.current = cssWidth; }, () => {});
    });
    return () => { cancelled = true; task?.cancel(); };
  }, [visible, pdf]);

  const regions = data.value?.regionsByDocPage.get(`${doc.id}:${index}`) ?? [];
  const hl = highlighted.value;
  const q = query.value;
  const selected = q?.kind === "section" ? q.sectionId : null;

  return (
    <div class="page" ref={box} style={{ aspectRatio: `${w} / ${h}` }}>
      <canvas ref={canvas} />
      {regions.map((r) => {
        const sec = data.value!.sections.get(r.section_id)!;
        const cls = ["overlay",
          sec.title.startsWith("Equation (") && "equation",
          r.section_id === selected && "selected",
          hl.has(r.section_id) && r.section_id !== selected && "hit"].filter(Boolean).join(" ");
        return (
          <button
            key={`${r.section_id}:${r.y0}`}
            class={cls}
            data-section={r.section_id}
            title={`${sec.number} ${sec.title}`}
            style={{
              left: `${(100 * r.x0) / w}%`, top: `${(100 * r.y0) / h}%`,
              width: `${(100 * (r.x1 - r.x0)) / w}%`, height: `${(100 * (r.y1 - r.y0)) / h}%`,
            }}
            onClick={() => selectSection(r.section_id)}
          />
        );
      })}
    </div>
  );
}
