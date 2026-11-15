//// The library of saved drawings. A drawing is a name and the source of its draw
//// function. The whole library is stored in localStorage under one key as JSON.

import gleam/dynamic/decode
import gleam/json
import gleam/list

/// localStorage key for the saved drawing library JSON.
const library_key = "animator-drawings"

/// The drawings list plus which one was open last.
pub type Library {
  Library(drawings: List(#(String, String)), selected: String)
}

// ── localStorage (data_ffi.mjs) ───────────────────────────────────────────────

/// The string stored in localStorage under key, or an Error if there isn't one.
@external(javascript, "./data_ffi.mjs", "storageGet")
pub fn storage_get(key: String) -> Result(String, Nil)

/// Store value in localStorage under key, replacing anything already there. If that
/// isn't possible, this logs the reason to the browser console.
@external(javascript, "./data_ffi.mjs", "storageSet")
pub fn storage_set(key: String, value: String) -> Nil

// ── The new-drawing prompt (data_ffi.mjs) ─────────────────────────────────────

/// Prompt the user to name a new drawing; "" (empty string) means they
/// cancelled or left it blank.
@external(javascript, "./data_ffi.mjs", "promptDrawingName")
pub fn prompt_drawing_name() -> String

// ── Library persistence ───────────────────────────────────────────────────────

/// Write the drawing library to localStorage as JSON:
/// `{"selected":"...","drawings":[{"name":"...","code":"..."}, ...]}`.
/// Each drawing's `code` is the raw editor text so Gradescope can find typed input.
pub fn save_library(drawings: List(#(String, String)), selected: String) -> Nil {
  let encoded =
    json.object([
      #("selected", json.string(selected)),
      #(
        "drawings",
        json.preprocessed_array(
          list.map(drawings, fn(pair) {
            let #(name, code) = pair
            json.object([
              #("name", json.string(name)),
              #("code", json.string(code)),
            ])
          }),
        ),
      ),
    ])
  storage_set(library_key, json.to_string(encoded))
}

/// Restore the library from localStorage. On a missing or corrupt save, returns
/// `fallback` with its first drawing selected (or `default_selected` if empty).
pub fn load_library(
  fallback: List(#(String, String)),
  default_selected: String,
) -> Library {
  case storage_get(library_key) {
    Error(Nil) -> library_or_fallback(fallback, default_selected)
    Ok(raw) ->
      case json.parse(from: raw, using: library_decoder()) {
        Ok(library) -> sanitize_library(library, fallback, default_selected)
        Error(_) -> library_or_fallback(fallback, default_selected)
      }
  }
}

fn library_decoder() -> decode.Decoder(Library) {
  use selected <- decode.field("selected", decode.string)
  use drawings <- decode.field("drawings", decode.list(drawing_decoder()))
  decode.success(Library(drawings:, selected:))
}

fn drawing_decoder() -> decode.Decoder(#(String, String)) {
  use name <- decode.field("name", decode.string)
  use code <- decode.field("code", decode.string)
  decode.success(#(name, code))
}

fn sanitize_library(
  library: Library,
  fallback: List(#(String, String)),
  default_selected: String,
) -> Library {
  case library.drawings {
    [] -> library_or_fallback(fallback, default_selected)
    _ ->
      case find_drawing(library.drawings, library.selected) {
        Ok(_) -> library
        Error(Nil) -> {
          let #(name, _) = first_pair(library.drawings, default_selected)
          Library(drawings: library.drawings, selected: name)
        }
      }
  }
}

fn library_or_fallback(
  fallback: List(#(String, String)),
  default_selected: String,
) -> Library {
  let #(name, _) = first_pair(fallback, default_selected)
  Library(drawings: fallback, selected: name)
}

fn first_pair(
  drawings: List(#(String, String)),
  default_selected: String,
) -> #(String, String) {
  case drawings {
    [first, ..] -> first
    [] -> #(default_selected, "")
  }
}

fn find_drawing(
  drawings: List(#(String, String)),
  name: String,
) -> Result(#(String, String), Nil) {
  list.find(drawings, fn(pair) {
    let #(n, _) = pair
    n == name
  })
}
