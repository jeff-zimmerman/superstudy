import { useEffect, useState } from "preact/hooks";
import { data, loading, loadError, activeDoc, query, sidebarOpen, searchStatus, segments } from "../store";
import { courses, coursesError, courseId, drawerOpen, loadCourses, openCourse } from "../courses";
import { search } from "../search";
import { theme, toggleTheme } from "../theme";
import { PdfView } from "./PdfView";
import { Sidebar } from "./Sidebar";
import { CourseDrawer, Welcome } from "./Courses";

export function App() {
  useEffect(() => { loadCourses(); }, []);

  if (coursesError.value) return <div class="fatal">Couldn't load the course list: {coursesError.value}</div>;
  if (!courses.value) return <div class="fatal">Loading…</div>;

  const course = courses.value.find((c) => c.id === courseId.value) ?? null;
  const d = data.value;
  const doc = d?.docs.find((x) => x.id === activeDoc.value);

  return (
    <div class={`app ${d ? "" : "no-course"}`}>
      <header class="top">
        <button class="icon-btn" onClick={() => (drawerOpen.value = !drawerOpen.value)} aria-label="Courses" aria-expanded={drawerOpen.value}>
          <MenuIcon />
        </button>
        <button class="brand" onClick={() => openCourse(null)} title="All courses">
          {course ? <>{course.code && <span class="code">{course.code}</span>}{course.title}</> : "Lecture notes"}
        </button>
        {d && d.docs.length > 1 && (
          <nav class="docs">
            {d.docs.map((x) => (
              <button key={x.id} class={x.id === activeDoc.value ? "on" : ""} onClick={() => (activeDoc.value = x.id)}>{x.title}</button>
            ))}
          </nav>
        )}
        {d && <SearchBox key={course?.id} />}
        <button class="icon-btn theme-toggle" onClick={toggleTheme}
                aria-label={theme.value === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                title={theme.value === "dark" ? "Light theme" : "Dark theme"}>
          {theme.value === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        {d && !sidebarOpen.value && query.value && (
          <button class="reopen" onClick={() => (sidebarOpen.value = true)}>{segments.value.length} clips</button>
        )}
      </header>

      <main>
        {!courseId.value && <Welcome />}
        {courseId.value && loading.value && <div class="state">Loading {course?.title ?? "course"}…</div>}
        {courseId.value && loadError.value && (
          <div class="state error">
            <p>{loadError.value}</p>
            <button onClick={() => openCourse(null)}>Back to courses</button>
          </div>
        )}
        {doc && <PdfView key={`${course?.id}:${doc.id}`} doc={doc} />}
      </main>
      {d && <Sidebar />}
      <CourseDrawer />
    </div>
  );
}

function SearchBox() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (e: Event) => {
    e.preventDefault();
    const t = text.trim(), d = data.value;
    if (!t || !d) return;
    setBusy(true);
    searchStatus.value = "";
    try {
      const { hits, sectionHits } = await search(d, t);
      if (data.value !== d) return; // course changed while searching
      query.value = { kind: "search", text: t, hits, sectionHits };
      sidebarOpen.value = true;
    } finally { setBusy(false); }
  };
  return (
    <form class="search" onSubmit={run}>
      <input type="search" placeholder="Search lectures and notes…" value={text}
             onInput={(e) => setText((e.target as HTMLInputElement).value)} />
      <button disabled={busy}>{busy ? "…" : "Search"}</button>
    </form>
  );
}

const MenuIcon = () => <svg viewBox="0 0 24 24"><path d="M3 6h18v2H3zM3 11h18v2H3zM3 16h18v2H3z" /></svg>;
const MoonIcon = () => <svg viewBox="0 0 24 24"><path d="M21 14.5A9 9 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5z" /></svg>;
const SunIcon = () => (
  <svg viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="4.5" />
    <path d="M11 1h2v3h-2zM11 20h2v3h-2zM1 11h3v2H1zM20 11h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zM16.3 17.7l1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z" />
  </svg>
);
