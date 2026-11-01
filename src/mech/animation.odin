package mech

import "core:encoding/json"
import "core:log"
import "core:math"
import "core:mem"
import "core:slice"

// An Animation is a character's clips (the "animation" half of a character file). A clip is a
// list of key frames, which may overlap; each key frame blends its driver values onto what the
// keys before it give. The game mixes clips: each plays on a Layer, with its own time scale and
// offset, replacing or adding to the layers below.
// clips_build compiles an Animation against a Model; clip_sample evaluates a clip at a time and
// mix_sample a stack of layers. See docs/animation.md.
//
// Values are driver values as they are (Driver): what the model's drives turn them into; and the
// root's channels (ROOT_CHANNELS: root.x, root.y, root.z), where the model's origin is moved, in
// model units.

// Ease shapes a key frame's progress: IN accelerates (driving into a hit), OUT decelerates
// (coasting to a stop), SMOOTH does both.
Ease :: enum u8 {
  SMOOTH,
  LINEAR,
  IN,
  OUT,
}

// Key is a key frame. It starts at `at` seconds and, over `duration`, blends its values in. A
// zero duration snaps. Keys apply in time order (keys starting together, in file order), each
// moving its drivers toward its values from what the keys before it give.
Key :: struct {
  at, duration: f32,
  ease:         Ease,
  values:       map[string]f32,
}

Clip :: struct {
  name:     string,
  duration: f32,
  keys:     [dynamic]Key,
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
  case .SMOOTH:
    return x * x * (3 - 2 * x)
  case .LINEAR:
    return x
  case .IN:
    return x * x
  case .OUT:
    return 1 - (1 - x) * (1 - x)
  }
  return x
}

// Clips is an Animation compiled against a Model: names resolved to driver indices, keys sorted
// by time. Rebuild it when either changes.
Clips :: struct {
  drivers: int,
  clips:   [dynamic]ClipData,
}

ClipData :: struct {
  name:     string,
  duration: f32,
  keys:     [dynamic]KeyData,
}

KeyData :: struct {
  at, duration: f32,
  ease:         Ease,
  targets:      [dynamic]Target,
}

Target :: struct {
  driver: int,
  value:  f32,
}

clips_build :: proc(a: ^Animation, m: ^Model) -> (c: Clips) {
  c.drivers = model_channels(m)
  for clip in a.clips {
    data := ClipData{name = clip.name, duration = clip.duration}
    for k in clip.keys {
      key := KeyData{k.at, k.duration, k.ease, {}}
      for name, v in k.values {
        ch := model_channel(m, name)
        if ch < 0 {
          log.warnf("clip %s: no driver %s in model %s", clip.name, name, m.name)
          continue
        }
        append(&key.targets, Target{ch, v})
      }
      slice.sort_by(key.targets[:], proc(a, b: Target) -> bool {return a.driver < b.driver})
      append(&data.keys, key)
    }
    slice.stable_sort_by(data.keys[:], proc(a, b: KeyData) -> bool {return a.at < b.at})
    append(&c.clips, data)
  }
  return
}

clips_destroy :: proc(c: ^Clips) {
  for clip in c.clips {
    for k in clip.keys do delete(k.targets)
    delete(clip.keys)
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

// clip_sample writes clip `clip` at `t` seconds into `out` (one value per channel), on the rest
// pose (every value 0). A clip index out of range gives the rest pose.
clip_sample :: proc(c: ^Clips, clip: int, t: f32, out: []f32) {
  slice.zero(out)
  clip_apply(c, clip, t, out)
}

// clip_apply blends clip `clip` at `t` seconds onto `out`: each key, in time order, moves its
// drivers toward its values by its eased progress at t. Drivers no key sets keep their value.
clip_apply :: proc(c: ^Clips, clip: int, t: f32, out: []f32) {
  if clip < 0 || clip >= len(c.clips) do return
  for k in c.clips[clip].keys {
    w := ease(k.ease, (t - k.at) / k.duration) if k.duration > 0 else f32(1 if t >= k.at else 0)
    if w <= 0 do continue
    for target in k.targets do out[target.driver] += (target.value - out[target.driver]) * w
  }
}

// Blend is how a layer lands on the layers below it.
Blend :: enum u8 {
  REPLACE, // move the drivers its clip sets toward the clip's values
  ADDITIVE, // add its clip's values (on the rest pose) to the drivers it sets
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
// from the first up, samples its clip and blends it by its weight onto what the layers below give.
// `scratch` holds one value per channel, like `out`.
mix_sample :: proc(c: ^Clips, layers: []Layer, t: f32, out, scratch: []f32) {
  slice.zero(out)
  for l in layers {
    if l.weight <= 0 || l.clip < 0 || l.clip >= len(c.clips) do continue
    lt := layer_time(c, l, t)
    switch l.blend {
    case .REPLACE:
      copy(scratch, out)
      clip_apply(c, l.clip, lt, scratch)
      for &v, i in out do v += (scratch[i] - v) * l.weight
    case .ADDITIVE:
      clip_sample(c, l.clip, lt, scratch)
      for &v, i in out do v += scratch[i] * l.weight
    }
  }
}
