// Drag the vertical gutter between the code column and the animation pane.

let bound = false;

export function mount() {
  if (bound) return;
  bound = true;

  const onDown = (e) => {
    const handle = e.target.closest(".col-splitter");
    if (!handle) return;
    e.preventDefault();
    const col = document.querySelector(".code-col");
    const app = document.querySelector(".app");
    if (!col || !app) return;

    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");

    const onMove = (ev) => {
      const rect = app.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const min = 240;
      const max = Math.max(min + 40, rect.width * 0.8);
      const width = Math.min(max, Math.max(min, x));
      col.style.width = `${width}px`;
      col.style.maxWidth = "none";
      // Keep Ace/CodeMirror layout in sync with the new width.
      window.dispatchEvent(new Event("animator-col-resize"));
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  document.addEventListener("mousedown", onDown);
}
