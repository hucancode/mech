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
// Values are channel values (model_channels): joints' turns, drivers' values, IK targets' points
// and the root's place, by name. A clip with a Gait walks or runs: its legs' paths and its swings
// are computed and added to what its keys give.

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
  gait:     Gait,
}

// Gait makes a clip procedural: a walk or a run from a handful of numbers instead of keys. Over each
// cycle (the clip's duration) every leg's IK target runs a foot's path around where the keys put
// it (where the foot stands at rest, when no key moves it), reaching at full weight: down for `duty` of the cycle, sliding straight back by `stride` along the ground (model
// units, along -z: the character walks toward +z), then up, swinging forward `stride` on an arc
// `lift` high. Each leg starts its cycle at its own `phase` (0 to 1: two legs half a cycle apart
// walk; a duty under 0.5 runs, every foot off the ground at once). The root sinks `crouch` (the
// knees bend: the feet stay on the ground) and dips `bob` more as each foot touches down, rising
// between. Swings move any other channel to and fro with the cycle: a sway, arms or a hull
// swinging against the legs.
// Waves run down chains of joints: a snake's slither, a tail's sway.
// Keys still apply first: they can widen the stance, crouch the root, set the poles. With none,
// any legged model walks: a biped, a dog, a hexapod; its legs' IK chains bend however they are
// built. Its legs' default poles bend each as its stops allow (a knee forward, a hock back).
Gait :: struct {
  stride, lift, duty: f32,
  crouch, bob:        f32,
  legs:               [dynamic]Step,
  swings:             [dynamic]Swing,
  waves:              [dynamic]Wave,
}

// Wave bends the chain from instance `from`'s joints down to instance `to`'s, about `axis`, as a
// body following a path: the segment after each joint heads amount * (1 + taper * s) *
// sin(2π (cycle - length * s)) off its rest, s running 0 at the head to 1 at the tail, so a wave
// `length` wavelengths long travels tailward once a cycle, growing by `taper` toward the tail
// (-1 dies out at the tail). Each joint turns only by the difference from the segment before, so
// its turn does not pile up down the chain: a snake slithers about Y, a tail sways.
Wave :: struct {
  from, to:              string,
  axis:                  Axis,
  amount, length, taper: f32,
}

// Step is one leg of a gait: IK target `ik`, its foot touching down at `phase` of the cycle.
Step :: struct {
  ik:    string,
  phase: f32,
}

// Swing moves channel `channel` by `amount` * cos(2π (rate * cycle - phase)): `rate` times a cycle
// (2 for a biped's bob, once per step), at its highest at `phase` (of 1 / rate of a cycle).
Swing :: struct {
  channel:            string,
  amount, rate, phase: f32,
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
  gait:     GaitData,
}

// GaitData is a Gait with its names resolved: each leg's first IK channel (x, y, z, ..), each
// swing's channel.
GaitData :: struct {
  stride, lift, duty: f32,
  crouch, bob:        f32,
  root_y:             int,
  legs:               [dynamic]Target, // driver: the IK's first channel, value: the phase
  swings:             [dynamic]SwingData,
  waves:              [dynamic]WaveData,
}

// WaveData is a Wave with its chain's channels found, head first.
WaveData :: struct {
  channels:              [dynamic]int,
  amount, length, taper: f32,
}

SwingData :: struct {
  channel:             int,
  amount, rate, phase: f32,
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
    g := clip.gait
    data.gait = {stride = g.stride, lift = g.lift, duty = g.duty, crouch = g.crouch, bob = g.bob, root_y = root_channel(m) + 1}
    for leg in g.legs {
      k := -1
      for ik, n in m.iks do if ik.name == leg.ik do k = n
      if k < 0 {
        log.warnf("clip %s: its gait walks with IK target %s, which model %s lacks", clip.name, leg.ik, m.name)
        continue
      }
      append(&data.gait.legs, Target{ik_channel(m, k), leg.phase})
    }
    for sw in g.swings {
      ch := model_channel(m, sw.channel)
      if ch < 0 {
        log.warnf("clip %s: its gait swings %s, which model %s lacks", clip.name, sw.channel, m.name)
        continue
      }
      append(&data.gait.swings, SwingData{ch, sw.amount, sw.rate, sw.phase})
    }
    for wv in g.waves {
      out := WaveData{amount = wv.amount, length = wv.length, taper = wv.taper}
      chain_channels(m, wv.from, wv.to, wv.axis, &out.channels)
      if len(out.channels) == 0 do log.warnf("clip %s: its wave from %s to %s finds no joint turning about %v", clip.name, wv.from, wv.to, wv.axis)
      append(&data.gait.waves, out)
    }
    append(&c.clips, data)
  }
  return
}

clips_destroy :: proc(c: ^Clips) {
  for clip in c.clips {
    for k in clip.keys do delete(k.targets)
    delete(clip.keys)
    delete(clip.gait.legs)
    delete(clip.gait.swings)
    for wv in clip.gait.waves do delete(wv.channels)
    delete(clip.gait.waves)
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
// channels toward its values by its eased progress at t, then its gait adds its legs' paths and
// swings. Channels neither sets keep their value.
clip_apply :: proc(c: ^Clips, clip: int, t: f32, out: []f32) {
  if clip < 0 || clip >= len(c.clips) do return
  data := &c.clips[clip]
  for k in data.keys {
    w := ease(k.ease, (t - k.at) / k.duration) if k.duration > 0 else f32(1 if t >= k.at else 0)
    if w <= 0 do continue
    for target in k.targets do out[target.driver] += (target.value - out[target.driver]) * w
  }
  if data.duration > 0 do gait_apply(&data.gait, t / data.duration, out)
}

// gait_apply adds gait `g` at `cycle` (its clip's time over its duration) onto `out`.
gait_apply :: proc(g: ^GaitData, cycle: f32, out: []f32) {
  dip: f32
  for leg in g.legs {
    foot := gait_foot(g.stride, g.lift, g.duty, cycle - leg.value)
    out[leg.driver + 1] += foot.y
    out[leg.driver + 2] += foot.z
    // a walking leg reaches
    out[leg.driver + 3] = 1
    // the root dips as this foot touches down: lowest then, back up a quarter cycle either side
    w := cycle - leg.value
    w -= math.round(w)
    if abs(w) < 0.25 do dip = max(dip, math.cos(2 * math.PI * w) * math.cos(2 * math.PI * w))
  }
  if len(g.legs) > 0 do out[g.root_y] -= g.crouch + g.bob * dip
  for sw in g.swings do out[sw.channel] += sw.amount * math.cos(2 * math.PI * (sw.rate * cycle - sw.phase))
  for wv in g.waves {
    n := len(wv.channels)
    // each joint turns its segment from the heading of the one before to its own
    before: f32
    for ch, k in wv.channels {
      s := f32(k) / f32(max(n - 1, 1))
      heading := wv.amount * (1 + wv.taper * s) * math.sin(2 * math.PI * (cycle - wv.length * s))
      out[ch] += heading - before
      before = heading
    }
  }
}

// gait_foot is where a foot is at `cycle` of its own (0: touching down), around where it stands:
// down for `duty` of the cycle, sliding from `stride` / 2 ahead to as far behind, then swinging
// back ahead on an arc `lift` high, easing in and out.
gait_foot :: proc(stride, lift, duty, cycle: f32) -> (foot: [3]f32) {
  u := cycle - math.floor(cycle)
  d := clamp(duty, 0.01, 0.99)
  if u < d {
    foot.z = stride * (0.5 - u / d)
    return
  }
  s := (u - d) / (1 - d)
  foot.z = -stride * math.cos(math.PI * s) / 2
  foot.y = lift * math.sin(math.PI * s)
  return
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

// chain_channels appends the channels turning about `axis` of every joint on the chain from
// instance `from`'s joints down to instance `to`'s, head first; none when `from` is not above `to`.
@(private = "file")
chain_channels :: proc(m: ^Model, from, to: string, axis: Axis, out: ^[dynamic]int) {
  top := model_instance(m, from)
  chain := make([dynamic]int, context.temp_allocator)
  for i := model_instance(m, to); i >= 0; i = model_instance(m, m.assembly[i].parent) {
    append(&chain, i)
    if i == top do break
  }
  if top < 0 || len(chain) == 0 || chain[len(chain) - 1] != top do return
  #reverse for i in chain {
    ch := joint_channel(m, i)
    for j in instance_joints(m, i) {
      dofs, count := joint_dofs(j)
      for d, k in dofs[:count] do if d.axis == axis do append(out, ch + k)
      ch += count
    }
  }
}
