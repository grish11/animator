//// Draw Studio: freehand ink → Gleam `Path(Line(...))` code.
////
//// Ink pipeline (see draw_studio_ffi.mjs comments for sources):
//// pointer capture, coalesced samples, One-Euro live preview,
//// arc-length resample, RDP + corners, collinear merge.

import lustre/effect.{type Effect}

@external(javascript, "./draw_studio_ffi.mjs", "mountDrawStudio")
fn do_mount(on_code: fn(String) -> Nil) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "unmountDrawStudio")
fn do_unmount() -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "setStudioPalette")
fn do_set_palette(primary: String, secondary: String) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "setStudioEffect")
fn do_set_effect(mode: String) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "setStudioFidelity")
fn do_set_fidelity(level: Int) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "setStudioTool")
fn do_set_tool(mode: String) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "setStudioEraseRadius")
fn do_set_erase_radius(radius: Int) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "setStudioGrid")
fn do_set_grid(size: Int) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "setStudioAutoClose")
fn do_set_auto_close(on: Bool) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "setStudioMirror")
fn do_set_mirror(on: Bool) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "setStudioPressure")
fn do_set_pressure(on: Bool) -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "undoStudioStroke")
fn do_undo() -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "clearStudioStrokes")
fn do_clear() -> Nil

@external(javascript, "./draw_studio_ffi.mjs", "getStudioCode")
pub fn get_code() -> String

@external(javascript, "./draw_studio_ffi.mjs", "exportStudioPng")
fn do_export_png(name: String) -> Nil

pub fn mount(on_code: fn(String) -> msg) -> Effect(msg) {
  effect.from(fn(dispatch) {
    do_mount(fn(code) { dispatch(on_code(code)) })
  })
}

pub fn unmount() -> Effect(msg) {
  effect.from(fn(_dispatch) { do_unmount() })
}

pub fn set_palette(primary: String, secondary: String) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_set_palette(primary, secondary) })
}

pub fn set_effect(mode: String) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_set_effect(mode) })
}

pub fn set_fidelity(level: Int) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_set_fidelity(level) })
}

pub fn set_tool(mode: String) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_set_tool(mode) })
}

pub fn set_erase_radius(radius: Int) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_set_erase_radius(radius) })
}

pub fn set_grid(size: Int) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_set_grid(size) })
}

pub fn set_auto_close(on: Bool) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_set_auto_close(on) })
}

pub fn set_mirror(on: Bool) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_set_mirror(on) })
}

pub fn set_pressure(on: Bool) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_set_pressure(on) })
}

pub fn undo() -> Effect(msg) {
  effect.from(fn(_dispatch) { do_undo() })
}

pub fn clear() -> Effect(msg) {
  effect.from(fn(_dispatch) { do_clear() })
}

pub fn export_png(name: String) -> Effect(msg) {
  effect.from(fn(_dispatch) { do_export_png(name) })
}
