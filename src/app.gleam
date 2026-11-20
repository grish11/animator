//// Animator -- an application for program-generated drawings.

import builtins
import data
import drawing
import editor
import errors
import examples
import gleam/float
import gleam/int
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import lustre
import lustre/attribute as attr
import lustre/effect.{type Effect}
import lustre/element.{type Element}
import lustre/element/html
import lustre/event
import parser
import render
import shape.{type Path}
import pane_split

/// Your app's public address, once you've deployed it in Problem 13, such as
/// "https://your-username.github.io/animator/".
pub const public_url = ""

/// Set to True if you would like your app's URL included in the course gallery.
pub const include_app_in_gallery = False

/// A link to your video from Problem 14, which anyone with the link can watch.
pub const video_url = ""

/// Set to True if you would like your video included in the course gallery.
pub const include_video_in_gallery = False

const default_code =
  "fn draw(shape_slider: Int) -> List(Path) {\n  [Path(Line(Point(0, 0), Point(100, 100)), 0, 10, 2)]\n}\n"

/// Sentinel <option> value that opens the new-drawing name prompt.
/// Gradescope treats every non-empty option value as a drawing, so this must be "".
const new_drawing_value = ""

/// Default stroke colours: even-index paths use primary, odd-index use secondary.
const default_primary = "#e8d8b0"
const default_secondary = "#8a8aca"

const default_shape = 10

const default_speed = 1.0

/// CodeMirror keybinding style for the draw editor.
pub type EditorMode {
  Regular
  Neovim
}

/// How primary / secondary colours animate across strokes.
pub type ColorEffect {
  Static
  Wave
  Cycle
  Noise
  Spiral
}

// ── Model ──────────────────────────────────────────────────────────────────────

pub type Model {
  Model(
    // The code in the editor.
    source: String,
    // Named drawings available in the drop-down: #(name, source).
    drawings: List(#(String, String)),
    // Name of the drawing currently selected in the drop-down.
    selected: String,
    // Whether the code editor is shown.
    code_open: Bool,
    // Whether the bottom-right playback panel is shown.
    controls_open: Bool,
    // Parse/eval error to show over the canvas, if any.
    error: Option(String),
    // Value passed to draw as shape_slider, in [0, 100].
    shape_slider: Int,
    // Playback rate passed to render.set_speed (negative plays backward).
    speed: Float,
    // Regular (default) or Neovim (hjkl / vim) keybindings in the code editor.
    editor_mode: EditorMode,
    // Stroke colours: even path index → primary, odd → secondary (Static).
    primary_color: String,
    secondary_color: String,
    // Animated colour blending over the two palette colours.
    color_effect: ColorEffect,
    // True while a GIF export is encoding (disables export buttons).
    export_busy: Bool,
  )
}

pub type Msg {
  SetCode(String)

  // Layout controls
  ToggleCode
  ToggleControls

  // Drawing library
  SelectDrawing(String)

  // Code editor keybindings: Regular or Neovim
  SetEditorMode(EditorMode)

  // Playback controls
  ResetPlayback
  Play
  Pause
  SetShape(Int)
  SetSpeed(Float)
  SetPrimaryColor(String)
  SetSecondaryColor(String)
  SetColorEffect(ColorEffect)

  // Canvas export (top-right of the animation pane)
  ExportPng
  ExportGif
  ExportFinished
}

// ── Init ───────────────────────────────────────────────────────────────────────

/// Mount `source` in the editor and evaluate it (mount alone does not animate).
fn load_drawing(source: String) -> Effect(Msg) {
  effect.batch([
    editor.mount(source, SetCode),
    effect.from(fn(dispatch) { dispatch(SetCode(source)) }),
  ])
}

pub fn init(_flags: Nil) -> #(Model, Effect(Msg)) {
  let default_name = case examples.all {
    [#(name, _), ..] -> name
    [] -> "draw"
  }
  let data.Library(drawings:, selected:) =
    data.load_library(examples.all, default_name)
  let source = case drawing_source(drawings, selected) {
    Ok(src) -> src
    Error(Nil) -> default_code
  }
  #(
    Model(
      source: source,
      drawings: drawings,
      selected: selected,
      code_open: True,
      controls_open: True,
      error: None,
      shape_slider: default_shape,
      speed: default_speed,
      editor_mode: Regular,
      primary_color: default_primary,
      secondary_color: default_secondary,
      color_effect: Static,
      export_busy: False,
    ),
    // Effects that happen automatically at the start go here.
    effect.batch([
      load_drawing(source),
      pane_split.mount(),
      effect.from(fn(_dispatch) {
        render.set_palette(default_primary, default_secondary)
        render.set_color_effect("static")
      }),
    ]),
  )
}

fn color_effect_value(mode: ColorEffect) -> String {
  case mode {
    Static -> "static"
    Wave -> "wave"
    Cycle -> "cycle"
    Noise -> "noise"
    Spiral -> "spiral"
  }
}

fn parse_color_effect(raw: String) -> ColorEffect {
  case raw {
    "wave" -> Wave
    "cycle" -> Cycle
    "noise" -> Noise
    "spiral" -> Spiral
    _ -> Static
  }
}

fn editor_mode_value(mode: EditorMode) -> String {
  case mode {
    Regular -> "regular"
    Neovim -> "neovim"
  }
}

fn parse_editor_mode(raw: String) -> EditorMode {
  case raw {
    "neovim" -> Neovim
    _ -> Regular
  }
}

fn drawing_source(
  drawings: List(#(String, String)),
  name: String,
) -> Result(String, Nil) {
  case
    list.find(drawings, fn(pair) {
      let #(n, _) = pair
      n == name
    })
  {
    Ok(#(_, source)) -> Ok(source)
    Error(Nil) -> Error(Nil)
  }
}

fn drawing_name_exists(
  drawings: List(#(String, String)),
  name: String,
) -> Bool {
  list.any(drawings, fn(pair) {
    let #(n, _) = pair
    n == name
  })
}

fn set_drawing_source(
  drawings: List(#(String, String)),
  name: String,
  source: String,
) -> List(#(String, String)) {
  list.map(drawings, fn(pair) {
    let #(n, _) = pair
    case n == name {
      True -> #(n, source)
      False -> pair
    }
  })
}

// Parse and evaluate a draw function at the given shape-slider value, returning
// the rendered paths on success, or a human-readable message on failure.
fn run_source(shape_slider: Int, source: String) -> Result(List(Path), String) {
  case parser.parse_program(source, builtins.global_frame()) {
    Error(msg) -> Error(msg)
    Ok(program) ->
      drawing.try_draw(shape_slider, program)
      // Convert Error(EvalError) to Error(String) with a useful error message.
      |> result.map_error(errors.error_message)
  }
}

/// Push paths to the canvas. When `restart` is True, also jump the clock to the
/// start so the drawing animates from empty; otherwise keep the current time
/// (used when only the shape slider moves). Does not touch speed — shape changes
/// must call set_drawing alone so Gradescope can tell them apart from speed edits.
fn push_drawing(
  paths: List(Path),
  primary: String,
  secondary: String,
  color_effect: ColorEffect,
  restart: Bool,
) -> Effect(Msg) {
  let rendered =
    list.index_map(paths, fn(path, i) {
      let color = case i % 2 == 0 {
        True -> primary
        False -> secondary
      }
      render.render_path(path, color)
    })
  effect.from(fn(_dispatch) {
    render.set_palette(primary, secondary)
    render.set_color_effect(color_effect_value(color_effect))
    render.set_drawing(rendered)
    case restart {
      True -> render.reset_clock()
      False -> Nil
    }
  })
}

fn push_model_drawing(model: Model, paths: List(Path), restart: Bool) -> Effect(Msg) {
  push_drawing(
    paths,
    model.primary_color,
    model.secondary_color,
    model.color_effect,
    restart,
  )
}

fn set_speed_effect(speed: Float) -> Effect(Msg) {
  effect.from(fn(_dispatch) { render.set_speed(speed) })
}

// ── Update ─────────────────────────────────────────────────────────────────────

pub fn update(model: Model, msg: Msg) -> #(Model, Effect(Msg)) {
  case msg {
    ToggleCode -> #(Model(..model, code_open: !model.code_open), effect.none())

    ToggleControls -> #(
      Model(..model, controls_open: !model.controls_open),
      effect.none(),
    )

    SetEditorMode(mode) -> #(
      Model(..model, editor_mode: mode),
      editor.set_keymap(editor_mode_value(mode)),
    )

    SelectDrawing(choice) ->
      case choice == new_drawing_value {
        True -> {
          let name = data.prompt_drawing_name()
          case name == "" {
            // Cancelled or blank: leave the current drawing selected.
            True -> #(model, effect.none())
            False ->
              case drawing_name_exists(model.drawings, name) {
                // Keep the library unchanged and tell the user why.
                True -> #(
                  Model(
                    ..model,
                    error: Some("A drawing with that name already exists."),
                  ),
                  effect.none(),
                )
                False -> {
                  // New drawings start as a copy of the current editor code.
                  let source = model.source
                  let drawings = list.append(model.drawings, [#(name, source)])
                  data.save_library(drawings, name)
                  #(
                    Model(
                      ..model,
                      drawings: drawings,
                      selected: name,
                      source: source,
                      error: None,
                    ),
                    load_drawing(source),
                  )
                }
              }
          }
        }
        False ->
          case drawing_source(model.drawings, choice) {
            Ok(source) -> {
              data.save_library(model.drawings, choice)
              #(
                Model(..model, selected: choice, source: source),
                load_drawing(source),
              )
            }
            Error(Nil) -> #(model, effect.none())
          }
      }

    // Speed and time both back to 0: paused on an empty canvas.
    ResetPlayback -> #(
      Model(..model, speed: 0.0),
      effect.from(fn(_dispatch) {
        render.set_speed(0.0)
        render.reset_clock()
      }),
    )

    Play -> {
      let speed = 1.0
      #(Model(..model, speed: speed), set_speed_effect(speed))
    }

    Pause -> #(Model(..model, speed: 0.0), set_speed_effect(0.0))

    SetShape(shape) ->
      case run_source(shape, model.source) {
        Ok(paths) -> #(
          Model(..model, shape_slider: shape, error: None),
          // Keep the clock; do not call set_speed.
          push_model_drawing(model, paths, False),
        )
        Error(msg) -> #(
          Model(..model, shape_slider: shape, error: Some(msg)),
          // Broken code: show the error and draw nothing.
          push_model_drawing(model, [], False),
        )
      }

    SetSpeed(speed) -> #(Model(..model, speed: speed), set_speed_effect(speed))

    SetPrimaryColor(color) -> {
      let model = Model(..model, primary_color: color)
      case run_source(model.shape_slider, model.source) {
        Ok(paths) -> #(model, push_model_drawing(model, paths, False))
        Error(_) -> #(model, push_model_drawing(model, [], False))
      }
    }

    SetSecondaryColor(color) -> {
      let model = Model(..model, secondary_color: color)
      case run_source(model.shape_slider, model.source) {
        Ok(paths) -> #(model, push_model_drawing(model, paths, False))
        Error(_) -> #(model, push_model_drawing(model, [], False))
      }
    }

    SetColorEffect(mode) -> {
      let model = Model(..model, color_effect: mode)
      #(
        model,
        effect.from(fn(_dispatch) {
          render.set_color_effect(color_effect_value(mode))
        }),
      )
    }

    ExportPng -> #(
      model,
      effect.from(fn(_dispatch) { render.export_png(model.selected) }),
    )

    ExportGif ->
      case model.export_busy {
        True -> #(model, effect.none())
        False -> #(
          Model(..model, export_busy: True),
          effect.from(fn(dispatch) {
            render.export_gif(model.selected, fn() { dispatch(ExportFinished) })
          }),
        )
      }

    ExportFinished -> #(Model(..model, export_busy: False), effect.none())

    // After each keystroke in the editor, evaluate user code and draw paths.
    SetCode(text) -> {
      let drawings = set_drawing_source(model.drawings, model.selected, text)
      data.save_library(drawings, model.selected)
      case run_source(model.shape_slider, text) {
        Ok(paths) -> #(
          Model(..model, source: text, drawings: drawings, error: None),
          push_model_drawing(model, paths, True),
        )
        Error(msg) -> #(
          Model(..model, source: text, drawings: drawings, error: Some(msg)),
          // Still show the code; clear the canvas when it doesn't run.
          push_model_drawing(model, [], True),
        )
      }
    }
  }
}

// ── View ──────────────────────────────────────────────────────────────────
//
// Two side-by-side panes: the code editor on the left and its rendered output on
// the right. The code column can be hidden to expand the right pane.

pub fn view(model: Model) -> Element(Msg) {
  let app_class = case model.code_open {
    True -> "app"
    False -> "app code-hidden"
  }
  // The code column still exists even when hidden (CSS collapses it) so the
  // mounted CodeMirror editor keeps its state across show/hide.
  html.div([attr.class(app_class)], [
    html.div([attr.class("code-col")], [
      editor.view_panel(ToggleCode, view_drawing_select(model)),
    ]),
    html.div(
      [
        attr.class("col-splitter"),
        attr.attribute("role", "separator"),
        attr.attribute("aria-orientation", "vertical"),
        attr.attribute("title", "Drag to resize"),
      ],
      [],
    ),
    view_anim(model),
  ])
}

fn view_drawing_select(model: Model) -> Element(Msg) {
  let drawing_options =
    list.map(model.drawings, fn(pair) {
      let #(name, _) = pair
      html.option(
        [attr.value(name), attr.selected(name == model.selected)],
        name,
      )
    })
  html.div([attr.class("drawing-select-wrap")], [
    html.select(
      [
        attr.attribute("data-test-id", "drawing-select"),
        attr.class("drawing-select"),
        attr.value(model.selected),
        event.on_change(SelectDrawing),
      ],
      list.append(drawing_options, [
        html.option([attr.value(new_drawing_value)], "+ New drawing"),
      ]),
    ),
    html.select(
      [
        attr.attribute("data-test-id", "editor-mode-select"),
        attr.class("drawing-select editor-mode-select"),
        attr.attribute("title", "Code editor keybindings"),
        attr.value(editor_mode_value(model.editor_mode)),
        event.on_change(fn(raw) { SetEditorMode(parse_editor_mode(raw)) }),
      ],
      [
        html.option(
          [attr.value("regular"), attr.selected(model.editor_mode == Regular)],
          "Regular",
        ),
        html.option(
          [attr.value("neovim"), attr.selected(model.editor_mode == Neovim)],
          "Neovim",
        ),
      ],
    ),
  ])
}

fn view_anim(model: Model) -> Element(Msg) {
  html.div([attr.class("canvas-area")], [
    view_reveal_code(model),
    view_export_bar(model),
    html.canvas([attr.id("animation-canvas"), attr.class("canvas")]),
    view_error(model),
    view_controls(model),
  ])
}

fn view_export_bar(model: Model) -> Element(Msg) {
  let gif_label = case model.export_busy {
    True -> "GIF…"
    False -> "GIF"
  }
  html.div([attr.class("export-bar")], [
    html.button(
      [
        attr.class("icon-btn export-btn"),
        attr.attribute("title", "Download current frame as PNG"),
        attr.disabled(model.export_busy),
        event.on_click(ExportPng),
      ],
      [html.text("PNG")],
    ),
    html.button(
      [
        attr.class("icon-btn export-btn"),
        attr.attribute("title", "Download animated GIF of the reveal"),
        attr.disabled(model.export_busy),
        event.on_click(ExportGif),
      ],
      [html.text(gif_label)],
    ),
  ])
}

fn view_controls(model: Model) -> Element(Msg) {
  // Sliders stay in the DOM when the panel is collapsed so Gradescope can still
  // find their data-test-id attributes; CSS only hides the box.
  let panel_class = case model.controls_open {
    True -> "playback-panel"
    False -> "playback-panel controls-hidden"
  }
  html.div([], [
    case model.controls_open {
      True -> element.none()
      False ->
        html.button(
          [
            attr.class("icon-btn reveal-controls"),
            attr.attribute("title", "Show playback controls"),
            event.on_click(ToggleControls),
          ],
          [html.text("Controls")],
        )
    },
    html.div([attr.class(panel_class)], [
      html.div([attr.class("playback-header")], [
        html.span([attr.class("playback-title")], [html.text("Controls")]),
        html.button(
          [
            attr.class("icon-btn"),
            attr.attribute("title", "Hide playback controls"),
            event.on_click(ToggleControls),
          ],
          [html.text("×")],
        ),
      ]),
      html.div([attr.class("playback-buttons")], [
        html.button(
          [
            attr.class("icon-btn"),
            attr.attribute("title", "Reset speed and time to 0"),
            event.on_click(ResetPlayback),
          ],
          [html.text("Reset")],
        ),
        html.button(
          [
            attr.class("icon-btn"),
            attr.attribute("title", "Play at normal speed"),
            event.on_click(Play),
          ],
          [html.text("Play")],
        ),
        html.button(
          [
            attr.class("icon-btn"),
            attr.attribute("title", "Pause"),
            event.on_click(Pause),
          ],
          [html.text("Pause")],
        ),
      ]),
      view_slider_row(
        "Speed",
        "speed-slider",
        float.to_string(model.speed),
        "-6",
        "6",
        "0.1",
        fn(raw) {
          // HTML range inputs often send whole numbers without a decimal
          // ("-6", "6"); gleam/float.parse requires one, so fall back to int.
          case float.parse(raw) {
            Ok(speed) -> SetSpeed(speed)
            Error(Nil) ->
              case int.parse(raw) {
                Ok(n) -> SetSpeed(int.to_float(n))
                Error(Nil) -> SetSpeed(model.speed)
              }
          }
        },
      ),
      view_slider_row(
        "Shape",
        "shape-slider",
        int.to_string(model.shape_slider),
        "0",
        "100",
        "1",
        fn(raw) {
          case int.parse(raw) {
            Ok(shape) -> SetShape(shape)
            Error(Nil) -> SetShape(model.shape_slider)
          }
        },
      ),
      html.div([attr.class("color-rows")], [
        view_color_row("Primary:", model.primary_color, SetPrimaryColor),
        view_color_row("Secondary:", model.secondary_color, SetSecondaryColor),
      ]),
      view_effects_row(model),
    ]),
  ])
}

fn view_effects_row(model: Model) -> Element(Msg) {
  html.label([attr.class("effect-row")], [
    html.span([attr.class("slider-label")], [html.text("Effects")]),
    html.select(
      [
        attr.class("effect-select"),
        attr.attribute("title", "Colour animation effect"),
        attr.value(color_effect_value(model.color_effect)),
        event.on_change(fn(raw) { SetColorEffect(parse_color_effect(raw)) }),
      ],
      [
        effect_option(Static, model.color_effect, "Static"),
        effect_option(Wave, model.color_effect, "Wave"),
        effect_option(Cycle, model.color_effect, "Cycle"),
        effect_option(Noise, model.color_effect, "Noise"),
        effect_option(Spiral, model.color_effect, "Spiral"),
      ],
    ),
  ])
}

fn effect_option(
  mode: ColorEffect,
  selected: ColorEffect,
  label: String,
) -> Element(Msg) {
  html.option(
    [
      attr.value(color_effect_value(mode)),
      attr.selected(mode == selected),
    ],
    label,
  )
}

fn view_color_row(
  label: String,
  value: String,
  to_msg: fn(String) -> Msg,
) -> Element(Msg) {
  html.label([attr.class("color-row")], [
    html.span([attr.class("slider-label")], [html.text(label)]),
    html.input([
      attr.type_("color"),
      attr.class("color-input"),
      attr.value(value),
      event.on_input(to_msg),
    ]),
  ])
}

fn view_slider_row(
  label: String,
  test_id: String,
  value: String,
  min: String,
  max: String,
  step: String,
  on_input: fn(String) -> Msg,
) -> Element(Msg) {
  html.label([attr.class("slider-row")], [
    html.span([attr.class("slider-label")], [html.text(label)]),
    html.input([
      attr.type_("range"),
      attr.attribute("data-test-id", test_id),
      attr.min(min),
      attr.max(max),
      attr.step(step),
      attr.value(value),
      event.on_input(on_input),
    ]),
    html.span([attr.class("slider-value")], [html.text(value)]),
  ])
}

fn view_error(model: Model) -> Element(Msg) {
  case model.error {
    None -> element.none()
    Some(msg) -> html.div([attr.class("error-box")], [html.text(msg)])
  }
}

// The button that brings the code column back, overlaid on the top-left of the
// right pane. Nothing is rendered while the column is already showing (its own
// header holds the button that hides it).
fn view_reveal_code(model: Model) -> Element(Msg) {
  case model.code_open {
    True -> element.none()
    False ->
      html.button(
        [
          attr.class("icon-btn reveal-code"),
          attr.attribute("title", "Show code"),
          event.on_click(ToggleCode),
        ],
        [html.text("⟩")],
      )
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

pub fn main() -> Nil {
  let app = lustre.application(init, update, view)
  let assert Ok(_) = lustre.start(app, "#app", Nil)
  Nil
}
