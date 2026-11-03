package mech

import "core:encoding/json"
import "core:fmt"
import "core:log"
import "core:math"
import "core:mem"
import "core:slice"

// An Animation is a character's clips (the "animation" half of a character file). A clip is a
// list of motions: shapes over time added onto channels. The game mixes clips: each plays on a
// Layer, with its own time scale and offset, replacing or adding to the layers below.
// clips_build compiles an Animation against a Model; clip_sample evaluates a clip at a time and
// mix_sample a stack of layers. See docs/animation.md.
//
// Values are channel values (model_channels): joints' turns, drivers' values, IK targets' points
// and the root's place, by name, added onto the model's rest pose (Model.pose).

// Ease shapes how a motion's shape goes from one point to the next. They are mechanical: LINEAR
// (the default) runs steady, IN accelerates (driving into a hit), OUT decelerates (coasting to a
// stop), SETTLE arrives fast and bounces on its stop, dying out (a hard stop, a servo overshooting),
// STEP holds, then snaps at the end (a ratchet, a lock clunking in). Every ease is 0 at the start
// and 1 at the end.
Ease :: enum u8 {
  LINEAR,
  IN,
  OUT,
  SETTLE,
  STEP,
}

// Value is one channel's amount, or three's at once: `"l_leg": [x, y, z]` sets an IK target
// (l_leg_x, _y, _z), as `"l_leg_pole"` its pole, `"root"` and `"root_turn"` the root,
// `"l_arm.shoulder"` a BALL joint's turns (.x, .y, .z).
Value :: union {
  f32,
  [3]f32,
}

// Clip is a clip's motions over its duration, each adding on in order. A clip can be a walk alone,
// an arm swing alone, to mix on layers (mix_sample).
Clip :: struct {
  name:     string,
  duration: f32,
  motions:  [dynamic]Motion,
}

// Point is a point on a motion's shape: its value `v` at `u` (one cycle, 0 to 1), reached from
// the point before by `ease`.
Point :: struct {
  u, v: f32,
  ease: Ease,
}

// Move is channel amounts that move together, `delay` late: in a Motion, cycles of its shape (a
// foot half a cycle behind the other, a strike firing feet, pelvis, shoulder, arm in turn); in a
// Driver, its own units (a knuckle closing once the curl passes 0.2).
Move :: struct {
  delay: f32,
  by:    map[string]Value,
}

// Motion is a shape over time added onto channels. Its shape is points over one cycle
// (shape_value), repeating `rate` times over the clip (0 is 1); no points is 1 throughout (a held
// pose). At clip progress x (0 at its start, 1 at its end), each move adds its amounts times
//   shape(rate * x - delay)
// A walk, a slither, a swing or a strike is a few motions: data, not code (docs/animation.md).
Motion :: struct {
  shape: [dynamic]Point,
  rate:  int,
  moves: [dynamic]Move,
}

Animation :: struct {
  clips: [dynamic]Clip,
  arena: mem.Dynamic_Arena `json:"-"`,
}

// animation_parse reads an animation from its JSON text (a character file's "animation");
// free it with animation_destroy.
animation_parse :: proc(data: []u8, what := "animation") -> (a: ^Animation, ok: bool) {
  a = new(Animation)
  mem.dynamic_arena_init(&a.arena)
  if err := json.unmarshal(data, a, allocator = animation_allocator(a)); err != nil {
    log.errorf("cannot parse %s: %v", what, err)
    animation_destroy(a)
    return nil, false
  }
  return a, true
}

animation_destroy :: proc(a: ^Animation) {
  mem.dynamic_arena_destroy(&a.arena)
  free(a)
}

animation_allocator :: proc(a: ^Animation) -> mem.Allocator {
  return mem.dynamic_arena_allocator(&a.arena)
}

// animation_format is the animation as JSON text, allocated with `allocator`.
animation_format :: proc(a: ^Animation, allocator := context.allocator) -> string {
  return format_json(a^, allocator)
}

animation_clip :: proc(a: ^Animation, name: string) -> int {
  for c, i in a.clips do if c.name == name do return i
  return -1
}

ease :: proc(e: Ease, t: f32) -> f32 {
  x := clamp(t, 0, 1)
  switch e {
  case .LINEAR:
    return x
  case .IN:
    return x * x
  case .OUT:
    return 1 - (1 - x) * (1 - x)
  case .SETTLE:
    // a damped spring: reaches 1 a sixth in, swings about 0.19 past, 0.04 short, and is still at
    // the end (the last term takes off what is left of the swing there)
    K :: 5
    return 1 - math.exp(-K * x) * math.cos(3 * math.PI * x) - x * math.exp(f32(-K))
  case .STEP:
    return 1 if x >= 1 else 0
  }
  return x
}

// Clips is an Animation compiled against a Model: names resolved to channel indices, on the
// model's rest pose (`pose`, one value per channel). Rebuild it when either changes.
Clips :: struct {
  drivers: int,
  pose:    [dynamic]f32,
  clips:   [dynamic]ClipData,
}

// `channels` are the channels its motions set, in order: what a REPLACE layer replaces.
ClipData :: struct {
  name:     string,
  duration: f32,
  motions:  [dynamic]MotionData,
  channels: [dynamic]int,
}

// MotionData is a Motion with its names resolved: its moves' targets, flat, each move a run of
// them; its shape copied in order of u.
MotionData :: struct {
  shape:   [dynamic]Point,
  rate:    f32,
  targets: [dynamic]Target,
  moves:   [dynamic]MoveData,
}

MoveData :: struct {
  delay:        f32,
  first, count: int,
}

// Target is a channel and its value.
Target :: struct {
  driver: int,
  value:  f32,
}

// targets_resolve appends `values`' channels in model `m` to `out`, logging names it lacks.
targets_resolve :: proc(m: ^Model, what: string, values: map[string]Value, out: ^[dynamic]Target) {
  for name, value in values {
    switch v in value {
    case f32:
      ch := model_channel(m, name)
      if ch < 0 {
        log.warnf("%s: no channel %s in model %s", what, name, m.name)
        continue
      }
      append(out, Target{ch, v})
    case [3]f32:
      chs, ok := model_channel3(m, name)
      if !ok {
        log.warnf("%s: no channels %s x, y, z in model %s", what, name, m.name)
        continue
      }
      for ch, n in chs do append(out, Target{ch, v[n]})
    }
  }
}

// model_pose is `m`'s rest pose, one value per channel: Model.pose, every other channel 0.
model_pose :: proc(m: ^Model, allocator := context.allocator) -> []f32 {
  out := make([]f32, model_channels(m), allocator)
  targets := make([dynamic]Target, context.temp_allocator)
  targets_resolve(m, "pose", m.pose, &targets)
  for t in targets do out[t.driver] += t.value
  return out
}

clips_build :: proc(a: ^Animation, m: ^Model) -> (c: Clips) {
  c.drivers = model_channels(m)
  pose := model_pose(m, context.temp_allocator)
  append(&c.pose, ..pose)
  for clip in a.clips {
    data := ClipData{name = clip.name, duration = clip.duration}
    what := fmt.tprint("clip", clip.name)
    for mo in clip.motions {
      out := MotionData{rate = f32(max(mo.rate, 1))}
      append(&out.shape, ..mo.shape[:])
      slice.stable_sort_by(out.shape[:], proc(a, b: Point) -> bool {return a.u < b.u})
      for mv in mo.moves {
        first := len(out.targets)
        targets_resolve(m, what, mv.by, &out.targets)
        append(&out.moves, MoveData{mv.delay, first, len(out.targets) - first})
      }
      append(&data.motions, out)
    }
    for mo in data.motions do for target in mo.targets do append(&data.channels, target.driver)
    slice.sort(data.channels[:])
    resize(&data.channels, len(slice.unique(data.channels[:])))
    append(&c.clips, data)
  }
  return
}

clips_destroy :: proc(c: ^Clips) {
  delete(c.pose)
  for clip in c.clips {
    for mo in clip.motions {
      delete(mo.shape)
      delete(mo.targets)
      delete(mo.moves)
    }
    delete(clip.motions)
    delete(clip.channels)
  }
  delete(c.clips)
  c^ = {}
}

clips_find :: proc(c: ^Clips, name: string) -> int {
  for clip, i in c.clips do if clip.name == name do return i
  return -1
}

clip_duration :: proc(c: ^Clips, clip: int) -> f32 {
  return c.clips[clip].duration if clip >= 0 && clip < len(c.clips) else 0
}

// clip_sample writes clip `clip` at `t` seconds into `out` (one value per channel): the rest
// pose, then each motion adding its own. A clip index out of range gives the rest pose.
clip_sample :: proc(c: ^Clips, clip: int, t: f32, out: []f32) {
  copy(out, c.pose[:])
  if clip < 0 || clip >= len(c.clips) do return
  data := &c.clips[clip]
  x := t / data.duration if data.duration > 0 else 0
  for &mo in data.motions do motion_apply(&mo, x, out)
}

// motion_apply adds motion `mo` at clip progress `x` (0 to 1 over the clip) onto `out`.
motion_apply :: proc(mo: ^MotionData, x: f32, out: []f32) {
  for mv, k in mo.moves {
    f := motion_move(mo, k, x)
    for target in mo.targets[mv.first:][:mv.count] do out[target.driver] += target.value * f
  }
}

// motion_move is how much of its amounts move `k` of motion `mo` adds at clip progress `x`.
motion_move :: proc(mo: ^MotionData, k: int, x: f32) -> f32 {
  return shape_value(mo.shape[:], mo.rate * x - mo.moves[k].delay)
}

// shape_value is shape `points` (in order of u) at `u` cycles: each point's value at its u,
// eased into from the point before, the last point easing into the first a cycle on. It repeats
// every cycle; a whole cycle past the start (u = 1, 2, ..) is the cycle's end, so a one-shot
// clip, held at its end, holds where its shape ends. No points is 1.
shape_value :: proc(points: []Point, u: f32) -> f32 {
  n := len(points)
  if n == 0 do return 1
  v := u - math.floor(u)
  if v == 0 && u > 0 {
    if points[n - 1].u >= 1 do return points[n - 1].v
    v = 1
  }
  next := n
  for p, i in points do if p.u > v {
    next = i
    break
  }
  a, b: Point
  switch {
  case next == 0:
    a, b = points[n - 1], points[0]
    a.u -= 1
  case next == n:
    a, b = points[n - 1], points[0]
    b.u += 1
  case:
    a, b = points[next - 1], points[next]
  }
  if b.u - a.u <= 1e-6 do return b.v
  return a.v + (b.v - a.v) * ease(b.ease, (v - a.u) / (b.u - a.u))
}

// Blend is how a layer lands on the layers below it.
Blend :: enum u8 {
  REPLACE, // move the channels its clip sets toward the clip's values
  ADDITIVE, // add how its clip differs from the rest pose
}

// Layer plays one clip in a mix. Its clip time is (t - offset) * speed, looped over the clip or
// held at its ends; `weight` scales how much it lands (0 none, 1 fully).
Layer :: struct {
  clip:   int, // into Clips.clips, -1 for none
  blend:  Blend,
  weight: f32,
  speed:  f32,
  offset: f32,
  loops:  bool,
}

// layer_time is where layer `l` is in its clip at mix time `t`.
layer_time :: proc(c: ^Clips, l: Layer, t: f32) -> f32 {
  d := clip_duration(c, l.clip)
  lt := (t - l.offset) * l.speed
  if d <= 0 do return 0
  return lt - math.floor(lt / d) * d if l.loops else clamp(lt, 0, d)
}

// mix_sample writes the mix of `layers` at `t` seconds into `out`, on the rest pose: each layer,
// from the first up, samples its clip and lands it by its weight onto what the layers below give,
// moving the channels its clip sets toward it (REPLACE) or adding how it differs from the rest pose
// (ADDITIVE).
// `scratch` holds one value per channel, like `out`.
mix_sample :: proc(c: ^Clips, layers: []Layer, t: f32, out, scratch: []f32) {
  copy(out, c.pose[:])
  for l in layers {
    if l.weight <= 0 || l.clip < 0 || l.clip >= len(c.clips) do continue
    clip_sample(c, l.clip, layer_time(c, l, t), scratch)
    switch l.blend {
    case .REPLACE:
      for i in c.clips[l.clip].channels do out[i] += (scratch[i] - out[i]) * l.weight
    case .ADDITIVE:
      for &v, i in out do v += (scratch[i] - c.pose[i]) * l.weight
    }
  }
}

