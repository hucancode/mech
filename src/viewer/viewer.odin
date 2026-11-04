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
  values:     [dynamic]f32, // for Show.VALUES, a pose's values
  time:       f32,
  playing:    bool,
  speed:      f32,
  loops:      bool,
  part:       int, // the selection to outline: an instance of the assembly (both its sides), -1 for none
  shape:      int,
  isolate:    bool, // show only the selected part (its shapes and joint hardware), without the floor
  explode:    f32, // while isolating: 0 assembled, 1 the shapes pushed out by the part's size
  exploded:   bool, // pieces were moved out last frame
  frame_next: bool, // frame the camera once the mech is built and posed
  view:       View, // the side the camera looks from; turning returns it to FREE
  fov:        f32, // the main camera's perspective field of view, kept while a view is orthographic
  ortho:      f32, // an axis view's height over what the perspective view shows at the orbit's distance
  floor:      world.NodeHandle,
  grid:       bool, // draw the grid through the origin (draw_grid)
  messages:   [dynamic]string, // warnings and errors since the last "state" query
  heap:       mem.Allocator, // what messages are cloned with
}

app: ^App

// View is where the camera looks from: FREE orbits in perspective; the others look at the
// character from one side along an axis (it faces +Z, its left is +X) with a parallel projection.
View :: enum i32 {
  FREE,
  POS_X,
  NEG_X,
  POS_Y,
  NEG_Y,
  POS_Z,
  NEG_Z,
}

// The orbit yaw and pitch of each axis view (render.Orbit).
@(private = "file")
VIEW_ANGLES := [View][2]f32 {
  .FREE  = {},
  .POS_X = {0, 0},
  .NEG_X = {math.PI, 0},
  .POS_Y = {math.PI / 2, math.PI / 2},
  .NEG_Y = {math.PI / 2, -math.PI / 2},
  .POS_Z = {math.PI / 2, 0},
  .NEG_Z = {-math.PI / 2, 0},
}

// How far an axis view's camera stands back past the orbit, so zooming only narrows the view.
@(private = "file")
VIEW_BACK :: 100

// How tall an axis view frames the shown pieces, over their size.
@(private = "file")
VIEW_FRAME :: 1.2

// viewer_logger prints and keeps warnings for the page; set it as context.logger before
// viewer_init, since the loop keeps the context it starts with.
viewer_logger :: proc() -> log.Logger {
  return log.Logger{collect, nil, .Info, {.Level}}
}

viewer_init :: proc(title: string) -> bool {
  app = new(App)
  app.heap = context.allocator
  app.messages = make([dynamic]string, app.heap)
  app.speed, app.loops, app.part, app.shape, app.grid = 1, true, -1, -1, true
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
  sun := render.light_create(r, render.make_directional_light(cast_shadow = false))
  mjolnir.spawn(&app.scene, r, sun, rotation = linalg.quaternion_from_forward_and_up([3]f32{-0.4, -1, -0.3}, [3]f32{0, 1, 0}))
  app.floor = mjolnir.spawn(&app.scene, r, render.primitive(r, .QUAD_XZ, .GRAY, no_shadow = true), scale = 16)
  app.orbit = render.make_orbit({1.5, 1.6, 4}, {0, 0.9, 0})
  if p, ok := render.main_camera(r).projection.(render.PerspectiveProjection); ok do app.fov = p.fov
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
  place_camera()
  if app.has_mech {
    switch app.show {
    case .CLIP:
      if app.playing {
        app.time += dt * app.speed
        d := clip_duration()
        app.time = math.mod(app.time, d) if app.loops else min(app.time, d)
      }
      character.mech_seek(&app.mech, app.time)
    case .VALUES:
      character.character_update(&app.mech, 0)
    }
    isolate()
    // framed once posed, so it frames what shows
    if app.frame_next {
      frame_camera()
      app.frame_next = false
    }
    outline()
    draw_grid()
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
  resize(&app.values, mech.model_channels(app.asset.model))
  apply_show()
}

// apply_show hands the mech what the page asked to show.
apply_show :: proc() {
  if !app.has_mech do return
  switch app.show {
  case .CLIP:
    character.mech_play_clip(&app.mech, app.clip, app.loops)
    character.mech_seek(&app.mech, app.time)
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
// leaves out are at the rest pose (Model.pose).
set_values :: proc(text: []u8) -> bool {
  if !app.has_asset do return false
  // by channel, shaped as it is (mech.Value): each replaces the rest pose's
  values: map[string]mech.Value
  if err := json.unmarshal(text, &values, allocator = context.temp_allocator); err != nil {
    log.errorf("bad values: %v", err)
    return false
  }
  m := app.asset.model
  resize(&app.values, mech.model_channels(m))
  copy(app.values[:], app.asset.clips.pose[:])
  targets := make([dynamic]mech.Target, context.temp_allocator)
  mech.targets_resolve(m, .REST, values, &targets)
  for t in targets do app.values[t.index] = t.value
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
  if app.view == .FREE do return
  app.orbit.yaw, app.orbit.pitch = VIEW_ANGLES[app.view][0], VIEW_ANGLES[app.view][1]
  app.ortho = size * VIEW_FRAME / perspective_height()
}

// perspective_height is how tall the perspective view is at the orbit's distance.
@(private = "file")
perspective_height :: proc() -> f32 {
  return 2 * app.orbit.distance * math.tan(app.fov / 2)
}

// set_view looks along view's axis at the character, framed; FREE goes back to the orbit's
// perspective.
set_view :: proc(view: View) {
  app.view = view
  frame_camera()
}

// place_camera steers the orbit from this tick's input and puts the main camera on it. An axis
// view is orthographic, its height following the orbit's distance so scrolling zooms it;
// turning it goes back to FREE.
@(private = "file")
place_camera :: proc() {
  cam := render.main_camera(&app.renderer)
  if cam == nil do return
  if p, ok := cam.projection.(render.PerspectiveProjection); ok do app.fov = p.fov
  turned := !app.input.mouse_captured && input.mouse_down(&app.input, .LEFT) && app.input.mouse_delta != {}
  if turned do app.view = .FREE
  mjolnir.orbit_drag(&app.orbit, cam, &app.input)
  if app.view == .FREE {
    cam.projection = render.PerspectiveProjection{app.fov}
    return
  }
  back := app.orbit
  back.distance += VIEW_BACK
  render.camera_orbit(cam, back)
  cam.projection = render.OrthographicProjection{app.ortho * perspective_height()}
}

isolating :: proc() -> bool {
  return app.isolate && app.part >= 0
}

// selected_place is where the selected instance (app.part, of the assembly) is placed, its left
// side when it is on both (mech.model_places); -1 for none.
selected_place :: proc() -> int {
  if app.part < 0 || !app.has_mech do return -1
  for p, i in character.mech_rig(&app.mech).places do if p.inst == app.part do return i
  return -1
}

// selected reports whether piece `p` is the selected instance's, on either side of the body.
@(private = "file")
selected :: proc(p: mech.Piece) -> bool {
  return character.mech_rig(&app.mech).places[p.part].inst == app.part
}

// isolated reports whether piece `p` shows while isolating: the selected part's shapes and the
// hardware of the joints it hangs by, as written (its left side, when it is on both).
@(private = "file")
isolated :: proc(p: mech.Piece) -> bool {
  return p.part == selected_place()
}

// exploded reports whether piece `p` moves out while exploding: the selected part's shapes; its
// joint hardware stays where the part hangs.
@(private = "file")
exploded :: proc(p: mech.Piece) -> bool {
  return isolated(p) && p.shape >= 0
}

// isolate hides every piece but the selected part's, and the floor, while isolating, and explodes
// its shapes: each moves out from the middle of the part along the line from there to its centre.
@(private = "file")
isolate :: proc() {
  rig := character.mech_rig(&app.mech)
  on := isolating()
  explode := app.explode if on else 0
  middle, reach := part_middle(rig)
  // place pieces while exploded, and once more to put them back
  place := explode > 0 || app.exploded
  app.exploded = explode > 0
  world.set_visible(&app.scene, app.floor, !on)
  for p in rig.pieces {
    world.set_visible(&app.scene, p.node, !on || isolated(p))
    if !place do continue
    at := p.place.position
    if explode > 0 && exploded(p) do at += explode_offset(p, middle, reach, explode)
    world.transform(&app.scene, p.node).position = at
  }
}

// part_middle is the middle of the selected part's shapes on their bone, and how far the farthest
// reaches from it.
@(private = "file")
part_middle :: proc(rig: ^mech.Rig) -> (middle: [3]f32, reach: f32) {
  n: f32
  for p in rig.pieces do if exploded(p) {
    middle += p.place.position
    n += 1
  }
  if n == 0 do return
  middle /= n
  for p in rig.pieces do if exploded(p) {
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
  if isolating() && app.explode > 0 && exploded(p) {
    middle, reach := part_middle(rig)
    p.place.position += explode_offset(p, middle, reach, app.explode)
  }
  return geometry.transform_mul(rig.poses[p.bone], p.place)
}

// outline draws the selected part's shapes (the selected shape in white) and its frame's axes.
// While isolating the part shows alone, so only the selected shape is outlined.
@(private = "file")
outline :: proc() {
  if app.part < 0 do return
  rig := character.mech_rig(&app.mech)
  s := app.asset.model.scale
  for p, i in rig.pieces {
    if !selected(p) || p.shape < 0 do continue
    if app.isolate && (p.shape != app.shape || !isolated(p)) do continue
    x := piece_shown(rig, i)
    half := mech.primitive_corners(p.primitive)[7] * x.scale * s
    selected := p.shape == app.shape
    render.debug_cube(&app.renderer, x.position * s, x.rotation, half, {1, 1, 1, 1} if selected else {1, 0.8, 0.1, 1}, bypass_depth = selected)
  }
  if at := selected_place(); at >= 0 {
    f := mech.rig_frame(rig, at)
    render.debug_axes(&app.renderer, f.position * s, f.rotation, 0.15, bypass_depth = true)
  }
}

// draw_grid draws a flat grid through the origin and its axes from it, x red, y green (up), z
// blue: the isolated part's origin (in model units, as it shows), else the model's on the floor
// (in metres). The model hides the grid where it is in front; the axes show over it.
@(private = "file")
draw_grid :: proc() {
  if !app.grid do return
  rig := character.mech_rig(&app.mech)
  centre: [3]f32
  extent, step: f32 = 4, 0.5
  if at := selected_place(); isolating() && at >= 0 {
    centre = mech.rig_frame(rig, at).position * app.asset.model.scale
    extent, step = 1.5, 0.1
  } else do centre.y = 0.002 // just over the floor
  n := int(math.round(extent / step))
  GREY :: [4]f32{0.42, 0.42, 0.45, 1}
  for i in -n ..= n {
    c := f32(i) * step
    render.debug_segment(&app.renderer, centre + {c, 0, -extent}, centre + {c, 0, extent}, GREY)
    render.debug_segment(&app.renderer, centre + {-extent, 0, c}, centre + {extent, 0, c}, GREY)
  }
  render.debug_segment(&app.renderer, centre, centre + {extent, 0, 0}, {0.9, 0.4, 0.36, 1}, bypass_depth = true)
  render.debug_segment(&app.renderer, centre, centre + {0, extent / 2, 0}, {0.5, 0.76, 0.36, 1}, bypass_depth = true)
  render.debug_segment(&app.renderer, centre, centre + {0, 0, extent}, {0.36, 0.6, 0.9, 1}, bypass_depth = true)
}

// pick is the nearest piece under the cursor (CSS pixels from the canvas corner), of those
// shown: its instance (of the assembly, either side of the body), and its shape (-1 for joint
// hardware); -1, -1 when nothing is there. Pieces are hit as their boxes.
pick :: proc(cursor: [2]f32) -> (part, shape: int) {
  part, shape = -1, -1
  if !app.has_mech do return
  ray, ok := render.cursor_ray(&app.renderer, cursor)
  if !ok do return
  rig := character.mech_rig(&app.mech)
  s := app.asset.model.scale
  best := f32(math.F32_MAX)
  for p, i in rig.pieces {
    if isolating() && !isolated(p) do continue
    x := piece_shown(rig, i)
    half := mech.primitive_corners(p.primitive)[7] * x.scale * s
    // the ray in the box's frame, then the slabs
    inv := linalg.quaternion_inverse(x.rotation)
    o := linalg.quaternion_mul_vector3(inv, ray.origin - x.position * s)
    d := linalg.quaternion_mul_vector3(inv, ray.direction)
    near, far := f32(0), best
    for k in 0 ..< 3 {
      if abs(d[k]) < 1e-8 {
        if abs(o[k]) > half[k] do near = far + 1
        continue
      }
      t0, t1 := (-half[k] - o[k]) / d[k], (half[k] - o[k]) / d[k]
      near, far = max(near, min(t0, t1)), min(far, max(t0, t1))
    }
    if near <= far && near < best {
      best = near
      part, shape = rig.places[p.part].inst, p.shape
    }
  }
  return
}

// format_character is the shown character as file text.
format_character :: proc() -> string {
  return mech.character_format(app.asset.model, app.asset.anim)
}
