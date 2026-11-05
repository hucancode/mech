// Mech: a test scene for mechs loaded from assets/, with a debug panel to drive their animation.
//   1-8    idle / walk / run / attack / cast / combat idle / attack B / attack C
//   space  pause / resume
//   drag   orbit the camera, scroll to zoom
// The panel plays actions, loops one-shots, changes speed and cross-fade, scrubs or steps the
// clip while paused, and swaps the model (the mech, the reverse-jointed strider, the dragon
// ported from mjolnir's examples, a spider, a tiger or an eagle).
package main

import "core:fmt"
import "core:log"
import "core:math/linalg"
import mu "vendor:microui"
import "mjolnir"
import "mjolnir/debugui"
import "character"
import "mech"
import "mjolnir/input"
import "mjolnir/platform"
import "mjolnir/render"
import "mjolnir/world"

ACTION_KEYS := [character.Action]input.Key {
  .IDLE        = .NUM_1,
  .WALK        = .NUM_2,
  .RUN         = .NUM_3,
  .ATTACK      = .NUM_4,
  .CAST        = .NUM_5,
  .COMBAT_IDLE = .NUM_6,
  .ATTACK_B    = .NUM_7,
  .ATTACK_C    = .NUM_8,
}

ACTION_NAMES := [character.Action]string {
  .IDLE        = "idle",
  .WALK        = "walk",
  .RUN         = "run",
  .ATTACK      = "attack",
  .CAST        = "cast",
  .COMBAT_IDLE = "combat",
  .ATTACK_B    = "atk B",
  .ATTACK_C    = "atk C",
}

STEP :: 1.0 / 60

ASSETS := [?]struct {
  name, path: string,
} {
  {"mech", "assets/characters/mech.json"},
  {"dragon", "assets/characters/dragon.json"},
  {"strider", "assets/characters/strider.json"},
  {"spider", "assets/characters/spider.json"},
  {"tiger", "assets/characters/tiger.json"},
  {"eagle", "assets/characters/eagle.json"},
}

App :: struct {
  platform: platform.Platform,
  scene:    world.World,
  renderer: render.Renderer,
  input:    input.State,
  debug:    debugui.Context,
  orbit:    render.Orbit,
  library:  mech.Library,
  assets:   [len(ASSETS)]character.MechAsset,
  shown:    int, // the asset the character is built from
  mech:     character.Character,
  action:   character.Action, // the last action asked for
  repeat:   bool, // replay the attacks and CAST when they finish
  paused:   bool,
  speed:    f32,
  fade:     f32,
}

main :: proc() {
  context.logger = log.create_console_logger()
  app := new(App)
  app.speed, app.fade = 1, 0.2
  for a, i in ASSETS {
    asset, ok := character.asset_load(a.path)
    if !ok do return
    app.assets[i] = asset
  }
  if !platform.init(&app.platform, 1280, 720, "Mech") do return
  if !render.init(&app.renderer, app.platform.window) do return
  if !world.init(&app.scene) do return
  mjolnir.run(
    mjolnir.Loop(App) {
      app = app,
      setup = setup,
      shutdown = shutdown,
      update = update,
      render = draw,
    },
  )
}

draw :: proc(app: ^App) -> bool {
  return mjolnir.frame(&app.platform, &app.renderer)
}

setup :: proc(app: ^App) -> mjolnir.Setup {
  r := &app.renderer
  if !render.ready(r) do return .WAIT
  if !debugui.init(&app.debug, r) do return .FAIL
  sun := render.light_create(r, render.make_directional_light())
  mjolnir.spawn(&app.scene, r, sun, rotation = linalg.quaternion_from_forward_and_up([3]f32{-0.4, -1, -0.3}, [3]f32{0, 1, 0}))
  mjolnir.spawn(&app.scene, r, render.primitive(r, .QUAD_XZ, .GRAY, no_shadow = true), scale = 6)
  if !rebuild(app) do return .FAIL
  return .READY
}

// rebuild replaces the character with one built from app.shown, playing the same action.
rebuild :: proc(app: ^App) -> bool {
  if app.mech.data != nil do character.character_destroy(&app.mech, &app.scene, &app.renderer)
  c, ok := character.mech_create(&app.scene, &app.renderer, &app.library, &app.assets[app.shown])
  if !ok do return false
  app.mech = c
  character.character_play(&app.mech, app.action, 0)
  // frame the camera on the new model
  lo, hi := character.mech_bounds(&app.mech)
  center := (lo + hi) / 2
  app.orbit = render.make_orbit(center + linalg.normalize([3]f32{0.35, 0.3, 1}) * max(linalg.length(hi - lo), 0.5) * 1.5, center)
  return true
}

shutdown :: proc(app: ^App) {
  character.character_destroy(&app.mech, &app.scene, &app.renderer)
  for &a in app.assets do character.asset_destroy(&a)
  mech.library_destroy(&app.library, &app.renderer)
  world.shutdown(&app.scene)
  debugui.shutdown(&app.debug)
  render.shutdown(&app.renderer)
  platform.shutdown(&app.platform)
  free(app)
}

update :: proc(app: ^App, dt: f32) {
  render.lock(&app.renderer)
  platform.read_input(&app.platform, &app.input)
  panel(app)
  mjolnir.orbit_drag(&app.orbit, render.main_camera(&app.renderer), &app.input)
  if !app.input.keyboard_captured {
    for a in character.Action do if input.key_pressed(&app.input, ACTION_KEYS[a]) do play(app, a)
    if input.key_pressed(&app.input, .SPACE) do app.paused = !app.paused
  }
  if app.repeat && !character.action_loops(app.action) && character.character_idle(&app.mech) do character.character_play(&app.mech, app.action, app.fade)
  character.character_update(&app.mech, 0 if app.paused else dt * app.speed)
  mjolnir.update(&app.scene, &app.renderer, dt)
}

play :: proc(app: ^App, a: character.Action) {
  app.action = a
  character.character_play(&app.mech, a, app.fade)
}

panel :: proc(app: ^App) {
  ctx := debugui.begin(&app.debug, &app.input, &app.renderer)
  defer debugui.end(&app.debug, &app.renderer)
  // the window closes at the end of the scope that opens it, so its widgets go in the if
  if debugui.window(&app.debug, "Animation", {20, 20, 320, 290}) do panel_body(app, ctx)
}

panel_body :: proc(app: ^App, ctx: ^mu.Context) {
  mu.layout_row(ctx, {46, 46, 46, 46, 46, -1}, 0)
  for a in character.Action {
    mu.push_id(ctx, uintptr(a))
    if .SUBMIT in mu.button(ctx, ACTION_NAMES[a]) do play(app, a)
    mu.pop_id(ctx)
  }

  action, time, duration := character.mech_clock(&app.mech)
  mu.layout_row(ctx, {-1}, 0)
  mu.label(ctx, fmt.tprintf("playing %s  %.2f / %.2f s", ACTION_NAMES[action], time, duration))

  mu.layout_row(ctx, {120, -1}, 0)
  mu.checkbox(ctx, "pause", &app.paused)
  mu.checkbox(ctx, "repeat one-shots", &app.repeat)

  mu.layout_row(ctx, {80, -1}, 0)
  mu.label(ctx, "time")
  scrub := time
  if .CHANGE in mu.slider(ctx, &scrub, 0, duration - 0.001, 0, "%.3f") {
    app.paused = true
    character.mech_seek(&app.mech, scrub)
  }
  mu.layout_row(ctx, {80, 110, -1}, 0)
  mu.label(ctx, "step")
  if .SUBMIT in mu.button(ctx, "<  1 frame") {
    app.paused = true
    character.mech_seek(&app.mech, max(time - STEP, 0))
  }
  if .SUBMIT in mu.button(ctx, "1 frame  >") {
    app.paused = true
    character.mech_seek(&app.mech, min(time + STEP, duration - 0.001))
  }

  mu.layout_row(ctx, {80, -1}, 0)
  mu.label(ctx, "speed")
  mu.slider(ctx, &app.speed, 0.05, 2, 0, "%.2fx")
  mu.label(ctx, "cross-fade")
  mu.slider(ctx, &app.fade, 0, 1, 0, "%.2f s")

  mu.layout_row(ctx, {80, 54, 54, 54, 54, 54, 54, -1}, 0)
  mu.label(ctx, "model")
  for a, i in ASSETS {
    mu.push_id(ctx, uintptr(100 + i))
    if .SUBMIT in mu.button(ctx, a.name) && i != app.shown {
      app.shown = i
      if !rebuild(app) do log.errorf("could not build %s", a.name)
    }
    mu.pop_id(ctx)
  }
}
