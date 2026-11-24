import { useEffect } from "preact/hooks";
import { courses, courseId, drawerOpen, openCourse, type Course } from "../courses";

function meta(c: Course) {
  return [c.term,
          c.lectures != null && `${c.lectures} lecture${c.lectures === 1 ? "" : "s"}`,
          c.docs != null && `${c.docs} PDF${c.docs === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
}

/** Slide-out list of all courses. */
export function CourseDrawer() {
  const open = drawerOpen.value;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (drawerOpen.value = false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div class={`backdrop ${open ? "open" : ""}`} onClick={() => (drawerOpen.value = false)} />
      <nav class={`drawer ${open ? "open" : ""}`} aria-label="Courses" aria-hidden={!open}>
        <div class="drawer-head">Courses</div>
        <button class={`drawer-item home ${!courseId.value ? "on" : ""}`} onClick={() => openCourse(null)} tabIndex={open ? 0 : -1}>
          All courses
        </button>
        {courses.value!.map((c) => (
          <button key={c.id} class={`drawer-item ${c.id === courseId.value ? "on" : ""}`}
                  onClick={() => openCourse(c.id)} tabIndex={open ? 0 : -1}>
            <span class="t">{c.code && <span class="code">{c.code}</span>}{c.title}</span>
            {meta(c) && <span class="m">{meta(c)}</span>}
          </button>
        ))}
      </nav>
    </>
  );
}

/** Blank state: pick a course. */
export function Welcome() {
  const list = courses.value!;
  return (
    <div class="welcome">
      <h1>Choose a course</h1>
      {!list.length && <p class="muted">No courses yet. Add rows to <code>data/courses.csv</code>.</p>}
      <div class="course-grid">
        {list.map((c) => (
          <button key={c.id} class="course-card" onClick={() => openCourse(c.id)}>
            {c.code && <span class="code">{c.code}</span>}
            <span class="t">{c.title}</span>
            {c.description && <span class="desc">{c.description}</span>}
            {meta(c) && <span class="m">{meta(c)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
