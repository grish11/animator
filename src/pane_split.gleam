//// Draggable gutter between the code column and the animation pane.

import lustre/effect.{type Effect}

@external(javascript, "./pane_split_ffi.mjs", "mount")
fn do_mount() -> Nil

/// Attach drag listeners for `.col-splitter` (safe to call more than once).
pub fn mount() -> Effect(msg) {
  effect.from(fn(_dispatch) { do_mount() })
}
