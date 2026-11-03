package character

import "../mech"
import "../mjolnir/render"
import "../mjolnir/world"

// A Mech is a character built by the mech engine (src/mech) from a model and animated by the clips
// of an animation, one at a time, cross-fading between them. See docs/modeling.md and
// docs/animation.md. Gameplay drives it through Character with Actions: an action plays its clip.
// Tools (the character editor's viewer) also play any clip or show explicit channel values,
// through the same code.

// ACTION_CLIPS names the clip each action plays. An animation without one shows the rest pose.
ACTION_CLIPS := [Action]string {
  .IDLE        = "idle",
  .WALK        = "walk",
  .RUN         = "run",
  .ATTACK      = "attack",
  .CAST        = "cast",
  .COMBAT_IDLE = "combat_idle",
}

// MechAsset is a character: a model and its animation (one character file), loaded once and
// shared by every mech built from it.
MechAsset :: struct {
  model:   ^mech.Model,
  anim:    ^mech.Animation,
  clips:   mech.Clips,
  actions: [Action]int, // into clips, -1 for none
}

// asset_from_text builds an asset from a character file's text.
asset_from_text :: proc(text: []u8) -> (a: MechAsset, ok: bool) {
  a.model, a.anim = mech.character_parse(text) or_return
  asset_compile(&a)
  return a, true
}

// asset_from_data builds an asset from a model's and an animation's JSON (nil for no animation).
asset_from_data :: proc(model_text, anim_text: []u8) -> (a: MechAsset, ok: bool) {
  a.model = mech.model_parse(model_text) or_return
  anim, anim_ok := mech.animation_parse(anim_text if anim_text != nil else transmute([]u8)string("{}"))
  if !anim_ok {
    mech.model_destroy(a.model)
    return {}, false
  }
  a.anim = anim
  asset_compile(&a)
  return a, true
}

// asset_compile rebuilds the clips after the model or animation changed.
asset_compile :: proc(a: ^MechAsset) {
  mech.clips_destroy(&a.clips)
  a.clips = mech.clips_build(a.anim, a.model)
  for name, act in ACTION_CLIPS do a.actions[act] = mech.clips_find(&a.clips, name)
}

asset_destroy :: proc(a: ^MechAsset) {
  mech.clips_destroy(&a.clips)
  if a.anim != nil do mech.animation_destroy(a.anim)
  if a.model != nil do mech.model_destroy(a.model)
  a^ = {}
}

// Show is what a mech shows: its clip (gameplay), or for tools explicit values.
Show :: enum u8 {
  CLIP,
  VALUES,
}

Mech :: struct {
  scene:    ^world.World,
  asset:    ^MechAsset,
  rig:      ^mech.Rig,
  root:     world.NodeHandle,
  action:   Action,
  clip:     int, // into the asset's clips, -1 for none
  loops:    bool,
  started:  f32, // on `clock`, when the clip started
  show:     Show,
  values:   []f32, // for Show.VALUES, a pose's values
  clock:    f32, // the mech's time
  from:     []f32, // the pose the current fade started from
  target:   []f32,
  shown:    []f32,
  fade:     f32,
  fade_len: f32,
  busy:     bool,
}

// mech_create builds a mech from `asset` at `position` and returns it as a Character. Meshes and
// materials come from `lib`, shared with every other mech.
mech_create :: proc(w: ^world.World, r: ^render.Renderer, lib: ^mech.Library, asset: ^MechAsset, position: [3]f32 = {}) -> (c: Character, ok: bool) {
  m := new(Mech)
  m.scene, m.asset = w, asset
  m.root = world.spawn(w, position)
  rig, rig_ok := mech.rig_create(lib, w, r, asset.model, m.root)
  if !rig_ok {
    world.node_destroy(w, m.root)
    free(m)
    return {}, false
  }
  m.rig = rig
  n := mech.model_channels(asset.model)
  m.from, m.target, m.shown, m.values = make([]f32, n), make([]f32, n), make([]f32, n), make([]f32, n)
  m.action = .IDLE
  m.clip, m.loops = asset.actions[.IDLE], true
  c = Character {
    data    = m,
    root    = m.root,
    play    = mech_play,
    update  = mech_update,
    idle    = mech_idle,
    destroy = mech_destroy,
  }
  m.fade, m.fade_len = 1, 1
  mech_current(m, m.from)
  mech.rig_pose(w, m.rig, m.from)
  return c, true
}

@(private = "file")
mech_play :: proc(data: rawptr, a: Action, fade: f32) {
  m := cast(^Mech)data
  if a == m.action && action_loops(a) && m.show == .CLIP do return
  m.action = a
  start(m, m.asset.actions[a], action_loops(a), fade)
}

// start plays `clip` from now, fading from the pose shown.
@(private = "file")
start :: proc(m: ^Mech, clip: int, loops: bool, fade: f32) {
  mech_current(m, m.from)
  m.clip, m.loops, m.started = clip, loops, m.clock
  m.show = .CLIP
  m.fade, m.fade_len = 0, max(fade, 1e-4)
  m.busy = !loops
}

// mech_current writes the pose being shown now: the clip (or the values a tool asked for),
// blended from the previous pose while a fade runs.
@(private = "file")
mech_current :: proc(m: ^Mech, out: []f32) {
  switch m.show {
  case .CLIP:
    mech.clip_sample(&m.asset.clips, m.clip, mech.clip_time(&m.asset.clips, m.clip, m.clock - m.started, m.loops), m.target)
  case .VALUES:
    copy(m.target, m.values)
  }
  k := m.fade / m.fade_len
  k = k * k * (3 - 2 * k)
  for &v, i in out do v = m.from[i] + (m.target[i] - m.from[i]) * k
}

@(private = "file")
mech_update :: proc(data: rawptr, dt: f32) {
  m := cast(^Mech)data
  m.clock += dt
  m.fade = min(m.fade + dt, m.fade_len)
  if m.busy && m.clock - m.started >= mech.clip_duration(&m.asset.clips, m.clip) {
    m.action = .IDLE
    start(m, m.asset.actions[.IDLE], true, 0.2)
  }
  mech_current(m, m.shown)
  mech.rig_pose(m.scene, m.rig, m.shown)
}

@(private = "file")
mech_idle :: proc(data: rawptr) -> bool {
  return !(cast(^Mech)data).busy
}

@(private = "file")
mech_destroy :: proc(data: rawptr, w: ^world.World, r: ^render.Renderer) {
  m := cast(^Mech)data
  mech.rig_destroy(m.rig, w)
  world.node_destroy(w, m.root)
  delete(m.from)
  delete(m.target)
  delete(m.shown)
  delete(m.values)
  free(m)
}

// ---- tools -----------------------------------------------------------------------------------
// The procs below take a Character that mech_create made.

// mech_clock reads a mech's action clock: the action playing, how far into its clip, its length.
mech_clock :: proc(c: ^Character) -> (action: Action, time, duration: f32) {
  m := cast(^Mech)c.data
  return m.action, mech.clip_time(&m.asset.clips, m.clip, m.clock - m.started, m.loops), mech.clip_duration(&m.asset.clips, m.clip)
}

// mech_seek jumps the action's clip to `t` seconds, ending any fade, and shows that pose.
mech_seek :: proc(c: ^Character, t: f32) {
  m := cast(^Mech)c.data
  m.clock = m.started + t
  m.fade = m.fade_len
  mech_current(m, m.shown)
  mech.rig_pose(m.scene, m.rig, m.shown)
}

// mech_play_clip plays clip `clip` of the asset (any clip, not only the actions'), looping or once.
mech_play_clip :: proc(c: ^Character, clip: int, loops := true, fade: f32 = 0) {
  start(cast(^Mech)c.data, clip, loops, fade)
}

// mech_show_values shows a pose's values (mech.model_channel_table), held.
mech_show_values :: proc(c: ^Character, values: []f32) {
  m := cast(^Mech)c.data
  copy(m.values, values)
  m.show, m.busy = .VALUES, false
  m.fade = m.fade_len
}

// mech_shown is the pose's values the mech showed last.
mech_shown :: proc(c: ^Character) -> []f32 {
  return (cast(^Mech)c.data).rig.values[:]
}

mech_rig :: proc(c: ^Character) -> ^mech.Rig {
  return (cast(^Mech)c.data).rig
}

mech_asset :: proc(c: ^Character) -> ^MechAsset {
  return (cast(^Mech)c.data).asset
}

// mech_bounds is the box around the mech as last posed, relative to its root: for framing a camera.
mech_bounds :: proc(c: ^Character) -> (lo, hi: [3]f32) {
  return mech.rig_bounds((cast(^Mech)c.data).rig)
}
