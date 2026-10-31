// Viewer: one character on a stage, shown by the game's own code (src/mech, src/character) and
// renderer (mjolnir). The character editor (tools/character-editor) runs it in the browser and
// drives it through the exports in web.odin: the page sends model and animation text in, picks
// what to show, and reads back reports and file text. Natively (native.odin) it shows a model and
// animation from files. See docs/architecture.md.
package main

import "core:encoding/json"
import "core:fmt"
import "core:log"
import "core:math"
import "core:math/linalg"
import "core:mem"
import "core:strings"
import "../character"
import "../mech"
import "../mjolnir"
import "../mjolnir/input"
import "../mjolnir/platform"
import "../mjolnir/geometry"
import "../mjolnir/render"
import "../mjolnir/world"

App :: struct {
  platform:   platform.Platform,
  scene:      world.World,
  renderer:   render.Renderer,
  input:      input.State,
  orbit:      render.Orbit,
  library:    mech.Library,
  ready:      bool, // setup ran: the renderer takes meshes
  asset:      character.MechAsset,
  has_asset:  bool,
  mech:       character.Character,
  has_mech:   bool,
  // what to show; the page sets these
  show:       character.Show,
  clip:       int,
  pose:       int,
  values:     [dynamic]f32, // for Show.VALUES, one per channel
  time:       f32,
  playing:    bool,
  speed:      f32,
  loops:      bool,
  part:       int, // the selection to outline, -1 for none
  shape:      int,
  isolate:    bool, // show only the selected part's shapes
  explode:    f32, // while isolating: 0 assembled, 1 the shapes pushed out by the part's size
  exploded:   bool, // pieces were moved out last frame
  frame_next: bool, // frame the camera once the mech is built
  messages:   [dynamic]string, // warnings and errors since the last "state" query
  heap:       mem.Allocator, // what messages are cloned with
}

app: ^App

// viewer_logger prints and keeps warnings for the page; set it as context.logger before
// viewer_init, since the loop keeps the context it starts with.
viewer_logger :: proc() -> log.Logger {
  return log.Logger{collect, nil, .Info, {.Level}}
}

viewer_init :: proc(title: string) -> bool {
  app = new(App)
  app.heap = context.allocator
  app.messages = make([dynamic]string, app.heap)
  app.speed, app.loops, app.part, app.shape = 1, true, -1, -1
  if !platform.init(&app.platform, 1280, 720, title) do return false
  if !render.init(&app.renderer, app.platform.window) do return false
  if !world.init(&app.scene) do return false
  return true
}

// collect logs to the console and keeps warnings and errors for the page's next report.
@(private = "file")
collect :: proc(data: rawptr, level: log.Level, text: string, options: log.Options, location := #caller_location) {
  fmt.println(text)
  if app != nil && level >= .Warning && len(app.messages) < 64 do append(&app.messages, strings.clone(text, app.heap))
}

viewer_run :: proc() {
  mjolnir.run(mjolnir.Loop(App){app = app, setup = setup, shutdown = shutdown, update = update, render = draw})
}

@(private = "file")
draw :: proc(app: ^App) -> bool {
  return mjolnir.frame(&app.platform, &app.renderer)
}

@(private = "file")
setup :: proc(app: ^App) -> mjolnir.Setup {
  r := &app.renderer
  if !render.ready(r) do return .WAIT
  sun := render.light_create(r, render.make_directional_light())
  mjolnir.spawn(&app.scene, r, sun, rotation = linalg.quaternion_from_forward_and_up([3]f32{-0.4, -1, -0.3}, [3]f32{0, 1, 0}))
  mjolnir.spawn(&app.scene, r, render.primitive(r, .QUAD_XZ, .GRAY, no_shadow = true), scale = 16)
  app.orbit = render.make_orbit({1.5, 1.6, 4}, {0, 0.9, 0})
  app.ready = true
  rebuild()
  return .READY
}

@(private = "file")
shutdown :: proc(app: ^App) {
  if app.has_mech do character.character_destroy(&app.mech, &app.scene, &app.renderer)
  if app.has_asset do character.asset_destroy(&app.asset)
  mech.library_destroy(&app.library, &app.renderer)
  world.shutdown(&app.scene)
  render.shutdown(&app.renderer)
  platform.shutdown(&app.platform)
}

@(private = "file")
update :: proc(app: ^App, dt: f32) {
  render.lock(&app.renderer)
  platform.read_input(&app.platform, &app.input)
  mjolnir.orbit_drag(&app.orbit, render.main_camera(&app.renderer), &app.input)
  if app.has_mech {
    if app.frame_next {
      frame_camera()
      app.frame_next = false
    }
    switch app.show {
    case .CLIP:
      if app.playing {
        app.time += dt * app.speed
        d := clip_duration()
        app.time = math.mod(app.time, d) if app.loops else min(app.time, d)
      }
      character.mech_seek(&app.mech, app.time)
    case .POSE, .VALUES:
      character.character_update(&app.mech, 0)
    }
    isolate()
    outline()
  }
  mjolnir.update(&app.scene, &app.renderer, dt)
}

clip_duration :: proc() -> f32 {
  return clip_length(app.clip) if app.has_asset else 1
}

// rebuild replaces the mech with one built from the current asset, showing what it showed.
rebuild :: proc() {
  if !app.ready do return
  if app.has_mech do character.character_destroy(&app.mech, &app.scene, &app.renderer)
  app.has_mech = false
  if !app.has_asset do return
  c, ok := character.mech_create(&app.scene, &app.renderer, &app.library, &app.asset)
  if !ok {
    log.error("could not build the model")
    return
  }
  app.mech, app.has_mech = c, true
  resize(&app.values, len(app.asset.model.channels))
  apply_show()
}

// apply_show hands the mech what the page asked to show.
apply_show :: proc() {
  if !app.has_mech do return
  switch app.show {
  case .CLIP:
    character.mech_play_clip(&app.mech, app.clip, app.loops)
    character.mech_seek(&app.mech, app.time)
  case .POSE:
    character.mech_show_pose(&app.mech, app.pose)
  case .VALUES:
    character.mech_show_values(&app.mech, app.values[:])
  }
}

// set_model replaces the model, keeping the animation, and rebuilds the mech.
set_model :: proc(text: []u8) -> bool {
  model, ok := mech.model_parse(text)
  if !ok do return false
  if !app.has_asset {
    anim, anim_ok := mech.animation_parse(transmute([]u8)string("{}"))
    if !anim_ok {
      mech.model_destroy(model)
      return false
    }
    app.asset.anim = anim
    app.has_asset = true
    app.frame_next = true
  } else {
    // the mech's rig points at the old model: drop the mech before the model goes
    if app.has_mech do character.character_destroy(&app.mech, &app.scene, &app.renderer)
    app.has_mech = false
    mech.model_destroy(app.asset.model)
  }
  app.asset.model = model
  character.asset_compile(&app.asset)
  rebuild()
  return true
}

// set_character shows a character file's text: its model, then its animation.
set_character :: proc(text: []u8) -> bool {
  m, a, ok := mech.character_parse(text)
  if !ok do return false
  if app.has_mech do character.character_destroy(&app.mech, &app.scene, &app.renderer)
  app.has_mech = false
  if app.has_asset do character.asset_destroy(&app.asset)
  app.asset = {model = m, anim = a}
  app.has_asset = true
  app.frame_next = true
  character.asset_compile(&app.asset)
  rebuild()
  return true
}

// set_animation replaces the animation and recompiles the clips; the mech stays.
set_animation :: proc(text: []u8) -> bool {
  anim, ok := mech.animation_parse(text)
  if !ok do return false
  if !app.has_asset {
    log.error("send a model before its animation")
    mech.animation_destroy(anim)
    return false
  }
  old := app.asset.anim
  app.asset.anim = anim
  character.asset_compile(&app.asset)
  mech.animation_destroy(old)
  apply_show()
  return true
}

// set_values shows explicit channel values: a JSON object of channel name to value; channels it
// leaves out are 0.
set_values :: proc(text: []u8) -> bool {
  if !app.has_asset do return false
  values: map[string]f32
  defer delete(values)
  if err := json.unmarshal(text, &values, allocator = context.temp_allocator); err != nil {
    log.errorf("bad values: %v", err)
    return false
  }
  m := app.asset.model
  resize(&app.values, len(m.channels))
  for c, i in m.channels do app.values[i] = values[c.name] or_else 0
  app.show = .VALUES
  apply_show()
  return true
}

frame_camera :: proc() {
  if !app.has_mech do return
  lo, hi := shown_bounds()
  center := (lo + hi) / 2
  size := max(linalg.length(hi - lo), 0.5)
  app.orbit = render.make_orbit(center + linalg.normalize([3]f32{0.6, 0.35, 1}) * size * 1.4, center)
}

isolating :: proc() -> bool {
  return app.isolate && app.part >= 0
}

// isolated reports whether piece `p` shows while isolating: the selected part's shapes.
@(private = "file")
isolated :: proc(p: mech.Piece) -> bool {
  return p.part == app.part && p.shape >= 0
}

// isolate hides every piece but the selected part's shapes while isolating, and explodes those:
// each moves out from the middle of the part along the line from there to its centre.
@(private = "file")
isolate :: proc() {
  rig := character.mech_rig(&app.mech)
  on := isolating()
  explode := app.explode if on else 0
  middle, reach := part_middle(rig)
  // place pieces while exploded, and once more to put them back
  place := explode > 0 || app.exploded
  app.exploded = explode > 0
  for p in rig.pieces {
    world.set_visible(&app.scene, p.node, !on || isolated(p))
    if !place do continue
    at := p.place.position
    if explode > 0 && isolated(p) do at += explode_offset(p, middle, reach, explode)
    world.transform(&app.scene, p.node).position = at
  }
}

// part_middle is the middle of the selected part's shapes on their bone, and how far the farthest
// reaches from it.
@(private = "file")
part_middle :: proc(rig: ^mech.Rig) -> (middle: [3]f32, reach: f32) {
  n: f32
  for p in rig.pieces do if isolated(p) {
    middle += p.place.position
    n += 1
  }
  if n == 0 do return
  middle /= n
  for p in rig.pieces do if isolated(p) {
    reach = max(reach, linalg.length(p.place.position - middle) + linalg.length(p.place.scale) / 2)
  }
  return
}

@(private = "file")
explode_offset :: proc(p: mech.Piece, middle: [3]f32, reach, explode: f32) -> [3]f32 {
  dir := p.place.position - middle
  // a shape at the middle moves along its own up
  if linalg.length(dir) < 1e-4 do dir = linalg.quaternion_mul_vector3(p.place.rotation, [3]f32{0, 1, 0})
  return linalg.normalize(dir) * explode * reach
}

// shown_bounds is the box around what shows: the isolated (and exploded) shapes, or the whole
// character; the model's scale applied.
@(private = "file")
shown_bounds :: proc() -> (lo, hi: [3]f32) {
  if !isolating() do return character.mech_bounds(&app.mech)
  rig := character.mech_rig(&app.mech)
  lo, hi = math.F32_MAX, -math.F32_MAX
  for p, i in rig.pieces do if isolated(p) {
    x := piece_shown(rig, i)
    for c in mech.primitive_corners(p.primitive) {
      q := x.position + linalg.quaternion_mul_vector3(x.rotation, c * x.scale)
      lo, hi = linalg.min(lo, q), linalg.max(hi, q)
    }
  }
  if lo.x > hi.x do return character.mech_bounds(&app.mech)
  s := app.asset.model.scale
  return lo * s, hi * s
}

// piece_shown is where piece `i` is drawn: as posed, then exploded while isolating.
@(private = "file")
piece_shown :: proc(rig: ^mech.Rig, i: int) -> geometry.Transform {
  p := rig.pieces[i]
  if isolating() && app.explode > 0 && isolated(p) {
    middle, reach := part_middle(rig)
    p.place.position += explode_offset(p, middle, reach, app.explode)
  }
  return geometry.transform_mul(rig.poses[p.bone], p.place)
}

// outline draws the selected part's shapes (the selected shape in white) and its frame's axes.
@(private = "file")
outline :: proc() {
  if app.part < 0 do return
  rig := character.mech_rig(&app.mech)
  s := app.asset.model.scale
  for p, i in rig.pieces {
    if p.part != app.part || p.shape < 0 do continue
    x := piece_shown(rig, i)
    half := mech.primitive_corners(p.primitive)[7] * x.scale * s
    selected := p.shape == app.shape
    render.debug_cube(&app.renderer, x.position * s, x.rotation, half, {1, 1, 1, 1} if selected else {1, 0.8, 0.1, 1}, bypass_depth = selected)
  }
  if app.part < len(rig.frames) {
    f := mech.rig_frame(rig, app.part)
    render.debug_axes(&app.renderer, f.position * s, f.rotation, 0.15, bypass_depth = true)
  }
}

// format_character is the shown character as file text.
format_character :: proc() -> string {
  return mech.character_format(app.asset.model, app.asset.anim)
}
