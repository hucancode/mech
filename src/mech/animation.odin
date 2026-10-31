package mech

import "core:encoding/json"
import "core:log"
import "core:mem"
import "core:slice"

// An Animation is a character's clips and poses (the "animation" half of a character file). A
// clip is a series of key frames, which may overlap; each key frame blends a named pose, its own
// channel values, or both, onto what the keys below it give.
// clips_build compiles an Animation against a Model; clip_sample evaluates a clip at a time. See
// docs/animation.md.
//
// Values are channel values as they are: radians for angles.

// Ease shapes a key frame's progress: IN accelerates (driving into a hit), OUT decelerates
// (coasting to a stop), SMOOTH does both.
Ease :: enum u8 {
  SMOOTH,
  LINEAR,
  IN,
  OUT,
}

// Blend is how a key frame lands on what the keys below it give.
Blend :: enum u8 {
  REPLACE, // move the channels it touches toward its values
  ADDITIVE, // add its values to the channels it touches
}

// Pose is a named set of channel values, any subset of the rig's channels; a key frame that names
// it moves those channels and leaves the others to the keys below.
Pose :: struct {
  name:   string,
  values: map[string]f32,
}

// Key is a key frame. It starts at `at` seconds and, over `duration`, blends in `pose` (if named)
// then `values`. A zero duration snaps. Keys apply from the lowest priority up; keys of equal
// priority apply in file order.
Key :: struct {
  at, duration: f32,
  ease:         Ease,
  blend:        Blend,
  priority:     int,
  pose:         string,
  values:       map[string]f32,
}

Clip :: struct {
  name:     string,
  duration: f32,
  keys:     [dynamic]Key,
}

Animation :: struct {
  poses: [dynamic]Pose,
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

animation_pose :: proc(a: ^Animation, name: string) -> int {
  if name == "" do return -1
  for p, i in a.poses do if p.name == name do return i
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

// Clips is an Animation compiled against a Model: names resolved to channel indices, keys sorted
// by priority. Rebuild it when either changes.
Clips :: struct {
  channels: int,
  poses:    [dynamic][dynamic]Target,
  clips:    [dynamic]ClipData,
}

ClipData :: struct {
  name:     string,
  duration: f32,
  keys:     [dynamic]KeyData,
}

KeyData :: struct {
  at, duration: f32,
  ease:         Ease,
  blend:        Blend,
  priority:     int,
  pose:         int, // into Clips.poses, -1 for none
  targets:      [dynamic]Target,
}

Target :: struct {
  channel: int,
  value:   f32,
}

clips_build :: proc(a: ^Animation, m: ^Model) -> (c: Clips) {
  c.channels = len(m.channels)
  resolve :: proc(m: ^Model, values: map[string]f32, what: string) -> (out: [dynamic]Target) {
    for name, v in values {
      ch := model_channel(m, name)
      if ch < 0 {
        log.warnf("%s: no channel %s in model %s", what, name, m.name)
        continue
      }
      append(&out, Target{ch, v})
    }
    slice.sort_by(out[:], proc(a, b: Target) -> bool {return a.channel < b.channel})
    return
  }
  for p in a.poses do append(&c.poses, resolve(m, p.values, p.name))
  for clip in a.clips {
    data := ClipData{name = clip.name, duration = clip.duration}
    for k in clip.keys {
      pose := animation_pose(a, k.pose)
      if k.pose != "" && pose < 0 do log.warnf("clip %s: no pose %s", clip.name, k.pose)
      append(&data.keys, KeyData{k.at, k.duration, k.ease, k.blend, k.priority, pose, resolve(m, k.values, clip.name)})
    }
    slice.stable_sort_by(data.keys[:], proc(a, b: KeyData) -> bool {return a.priority < b.priority})
    append(&c.clips, data)
  }
  return
}

clips_destroy :: proc(c: ^Clips) {
  for p in c.poses do delete(p)
  for clip in c.clips {
    for k in clip.keys do delete(k.targets)
    delete(clip.keys)
  }
  delete(c.poses)
  delete(c.clips)
  c^ = {}
}

clips_find :: proc(c: ^Clips, name: string) -> int {
  for clip, i in c.clips do if clip.name == name do return i
  return -1
}

// clip_sample writes clip `clip` at `t` seconds into `out` (one value per channel), starting from
// the zero pose: each key blends by its eased progress at t on top of what the lower keys give.
// A clip index out of range gives the zero pose.
clip_sample :: proc(c: ^Clips, clip: int, t: f32, out: []f32) {
  slice.zero(out)
  if clip < 0 || clip >= len(c.clips) do return
  for k in c.clips[clip].keys {
    w := ease(k.ease, (t - k.at) / k.duration) if k.duration > 0 else f32(1 if t >= k.at else 0)
    if w <= 0 do continue
    if k.pose >= 0 do blend(out, c.poses[k.pose][:], k.blend, w)
    blend(out, k.targets[:], k.blend, w)
  }
}

@(private = "file")
blend :: proc(out: []f32, targets: []Target, b: Blend, w: f32) {
  for target in targets {
    switch b {
    case .REPLACE:
      out[target.channel] += (target.value - out[target.channel]) * w
    case .ADDITIVE:
      out[target.channel] += target.value * w
    }
  }
}

// pose_values writes pose `pose` (an index into Clips.poses) into `out`: its channels on the rest
// pose (every other channel 0).
pose_values :: proc(c: ^Clips, pose: int, out: []f32) {
  slice.zero(out)
  if pose >= 0 && pose < len(c.poses) do for t in c.poses[pose] do out[t.channel] = t.value
}
