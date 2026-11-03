package mech

import "core:encoding/json"
import "core:fmt"
import "core:log"
import "core:math"
import "core:mem"
import "core:slice"

// An Animation is a character's clips (the "animation" half of a character file). A clip is a
// list of motions: shapes over time added onto channels. clips_build compiles an Animation against
// a Model; clip_sample evaluates a clip at a time. See docs/animation.md.
//
// Values are channels' values (model_channel_table): joints' turns, IK targets' points
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
// (l_leg_x, _y, _z), `"root"` and `"root_turn"` the root,
// `"l_arm.shoulder"` a BALL joint's turns (.x, .y, .z). In a clip's motion, three channels can
// also follow an Arc, named: `"r_hand": "strike"`.
Value :: union {
  f32,
  [3]f32,
  string,
}

// Arc is a named path in space, the animation's (Animation.arcs), for any clip's moves to put a
// place on (an IK target's x, y, z, the root's: arc_channels; a turn is one value per axis, no path): points `[[x, y, z], ..]`, written as a [3]f32 value would be (an IK target's
// are offsets from where its tip is at rest), and a smooth curve through them (arc_at). It is
// open: it runs from its first point to its last (a loop is one whose last point is its first).
// In a motion, a move naming it puts its channels on it where the motion's shape says: 0 its first
// point, 1 its last, k / (n - 1) its point k, so the shape times the path and holds on its points;
// a shape going 0, 1, 0 runs out along it and back. A fist's whole strike is one arc, wound up,
// cocked, driven out, followed through, drawn where the arm can reach.
Arc :: struct {
  name:   string,
  points: [dynamic][3]f32,
}

// Clip is a clip's motions over its duration, each adding on in order.
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

// Twin is whether a move moves the other side of the body too (channel_twin): WITH, its twins by
// the same amounts at the same time (both hands opening, a stance); OPPOSITE, half a cycle later
// (the other foot, the other arm swinging back).
Twin :: enum u8 {
  NONE,
  WITH,
  OPPOSITE,
}

// Move is channel amounts that move together, `delay` cycles of its motion's shape late (a foot
// half a cycle behind the other, a strike firing feet, pelvis, shoulder, arm in turn, a hand's
// knuckles closing one after another). With a `twin`, its channels' twins move too. The rest pose
// (Model.pose) is a move too, its delay unused.
Move :: struct {
  delay: f32,
  twin:  Twin,
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
  arcs:  [dynamic]Arc,
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

// arc_find is arc `name` of `arcs`, -1 for none.
arc_find :: proc(arcs: []Arc, name: string) -> int {
  for a, i in arcs do if a.name == name do return i
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
  values:  int,
  pose:    [dynamic]f32,
  clips:   [dynamic]ClipData,
}

ClipData :: struct {
  name:     string,
  duration: f32,
  motions:  [dynamic]MotionData,
}

// MotionData is a Motion with its names resolved: its moves' targets, flat, each move a run of
// them; its shape copied in order of u.
MotionData :: struct {
  shape:   [dynamic]Point,
  rate:    f32,
  targets: [dynamic]Target,
  arcs:    [dynamic]ArcData,
  points:  [dynamic][3]f32,
  moves:   [dynamic]MoveData,
}

// MoveData is a move resolved: its targets, targets[first:][:count], and its arcs, arcs[arcs_first:][:arcs_count].
MoveData :: struct {
  delay:                   f32,
  first, count:            int,
  arcs_first, arcs_count: int,
}

// ArcData is an arc resolved: the channels it moves, each times `flip` (a twin's, mirrored), along
// points[first:][:count] of its motion, a copy of Animation.arcs[arc].
ArcData :: struct {
  channels:     [3]int,
  flip:         [3]f32,
  first, count: int,
  arc:          int,
}

// Target is one of a pose's values (`index`) and an amount for it.
Target :: struct {
  index: int,
  value: f32,
}

// targets_resolve appends `values`' channels in model `m` to `out`, one target per value, and the
// arcs they follow (named in `library`) to `arcs` (their points to `points`). A value is shaped as
// its channel (ChannelKind): a number for a 1-value one, [x, y, z] for a 3-value one, an arc's name
// for a POSITION (a turn is no path in space). Names it lacks or values shaped otherwise are logged
// as `what`'s (quietly skipped when `what` is empty). Arcs move only in clips' motions: given no
// `arcs`, they are logged and skipped.
targets_resolve :: proc(m: ^Model, what: string, values: map[string]Value, out: ^[dynamic]Target, library: []Arc = nil, arcs: ^[dynamic]ArcData = nil, points: ^[dynamic][3]f32 = nil) {
  sizes := CHANNEL_SIZE
  for name, value in values {
    c, known := model_channel(m, name)
    if !known {
      if what != "" do log.warnf("%s: no channel %s in model %s", what, name, m.name)
      continue
    }
    switch v in value {
    case string:
      k := arc_find(library, v)
      switch {
      case arcs == nil:
        log.warnf("%s: %s follows arc %s, which only a clip's motion can", what, name, v)
      case c.kind != .POSITION:
        log.warnf("%s: %s follows arc %s, but only a position (an IK target, the root) can", what, name, v)
      case k < 0:
        log.warnf("%s: %s follows arc %s, which the animation lacks", what, name, v)
      case:
        append(arcs, ArcData{{c.first, c.first + 1, c.first + 2}, 1, len(points), len(library[k].points), k})
        append(points, ..library[k].points[:])
      }
    case f32:
      if sizes[c.kind] != 1 {
        if what != "" do log.warnf("%s: %s is a %v, three values [x, y, z], not one", what, name, c.kind)
        continue
      }
      append(out, Target{c.first, v})
    case [3]f32:
      if sizes[c.kind] != 3 {
        if what != "" do log.warnf("%s: %s is a %v, one value, not three", what, name, c.kind)
        continue
      }
      for x, n in v do append(out, Target{c.first + n, x})
    }
  }
}

// move_resolve appends move `mv`'s channels in model `m` to `targets` and a MoveData for them to
// `moves` (the arcs it names, from `library`, to `arcs` and `points`); with a twin (Move.twin), then its channels' twins (channel_twin) by the same amounts, at
// the same delay or half a cycle later. Channels without a twin (the root's) move once.
// An arc's twin follows the same points, each channel times its twin's flip (the other side's x
// mirrored), when all three channels have twins.
move_resolve :: proc(m: ^Model, what: string, mv: Move, targets: ^[dynamic]Target, moves: ^[dynamic]MoveData, library: []Arc = nil, arcs: ^[dynamic]ArcData = nil, points: ^[dynamic][3]f32 = nil) {
  first, arcs_first := len(targets), len(arcs) if arcs != nil else 0
  targets_resolve(m, what, mv.by, targets, library, arcs, points)
  count, arcs_count := len(targets) - first, (len(arcs) if arcs != nil else 0) - arcs_first
  append(moves, MoveData{mv.delay, first, count, arcs_first, arcs_count})
  if mv.twin == .NONE do return
  start := len(targets)
  for k in first ..< first + count {
    t := targets[k]
    if twin, flip := channel_twin(m, t.index); twin >= 0 do append(targets, Target{twin, t.value * flip})
  }
  arcs_start := len(arcs) if arcs != nil else 0
  for k in arcs_first ..< arcs_first + arcs_count {
    a := arcs[k]
    twin := ArcData{first = a.first, count = a.count, arc = a.arc}
    whole := true
    for ch, n in a.channels {
      t, flip := channel_twin(m, ch)
      twin.channels[n], twin.flip[n] = t, a.flip[n] * flip
      whole &&= t >= 0
    }
    if whole do append(arcs, twin)
  }
  arcs_end := len(arcs) if arcs != nil else 0
  append(moves, MoveData{mv.delay + (0.5 if mv.twin == .OPPOSITE else 0), start, len(targets) - start, arcs_start, arcs_end - arcs_start})
}

// model_pose is `m`'s rest pose, one value per channel: Model.pose, every other channel 0.
model_pose :: proc(m: ^Model, allocator := context.allocator) -> []f32 {
  out := make([]f32, model_channels(m), allocator)
  targets := make([dynamic]Target, context.temp_allocator)
  moves := make([dynamic]MoveData, context.temp_allocator)
  move_resolve(m, "pose", m.pose, &targets, &moves)
  for t in targets do out[t.index] += t.value
  return out
}

clips_build :: proc(a: ^Animation, m: ^Model) -> (c: Clips) {
  c.values = model_channels(m)
  pose := model_pose(m, context.temp_allocator)
  append(&c.pose, ..pose)
  for clip in a.clips {
    data := ClipData{name = clip.name, duration = clip.duration}
    what := fmt.tprint("clip", clip.name)
    for mo in clip.motions {
      out := MotionData{rate = f32(max(mo.rate, 1))}
      append(&out.shape, ..mo.shape[:])
      slice.stable_sort_by(out.shape[:], proc(a, b: Point) -> bool {return a.u < b.u})
      for mv in mo.moves do move_resolve(m, what, mv, &out.targets, &out.moves, a.arcs[:], &out.arcs, &out.points)
      append(&data.motions, out)
    }
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
      delete(mo.arcs)
      delete(mo.points)
      delete(mo.moves)
    }
    delete(clip.motions)
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

// motion_apply adds motion `mo` at clip progress `x` (0 to 1 over the clip) onto `out`: each move's
// amounts times its shape, and its arcs where its shape is along them.
motion_apply :: proc(mo: ^MotionData, x: f32, out: []f32) {
  for mv, k in mo.moves {
    f := motion_move(mo, k, x)
    for target in mo.targets[mv.first:][:mv.count] do out[target.index] += target.value * f
    for a in mo.arcs[mv.arcs_first:][:mv.arcs_count] {
      p := arc_at(mo.points[a.first:][:a.count], f)
      for ch, n in a.channels do out[ch] += p[n] * a.flip[n]
    }
  }
}

// arc_at is the arc through `points` at `s`: point k at s = k / (n - 1), a Catmull-Rom curve
// between them (its ends' tangents along their first and last segments), and on along those
// tangents past its ends (a shape settling past 1 overshoots along the path, not off it).
arc_at :: proc(points: [][3]f32, s: f32) -> [3]f32 {
  n := len(points)
  if n == 0 do return 0
  if n == 1 do return points[0]
  u := s * f32(n - 1)
  k := clamp(int(math.floor(u)), 0, n - 2)
  t := u - f32(k)
  p1, p2 := points[k], points[k + 1]
  p0 := points[k - 1] if k > 0 else 2 * p1 - p2
  p3 := points[k + 2] if k + 2 < n else 2 * p2 - p1
  if t < 0 do return p1 + (p2 - p0) / 2 * t
  if t > 1 do return p2 + (p3 - p1) / 2 * (t - 1)
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t)
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

// clip_time is where clip `clip` is at `t` seconds from its start: looped over its duration, or
// held at its ends.
clip_time :: proc(c: ^Clips, clip: int, t: f32, loops: bool) -> f32 {
  d := clip_duration(c, clip)
  if d <= 0 do return 0
  return t - math.floor(t / d) * d if loops else clamp(t, 0, d)
}
