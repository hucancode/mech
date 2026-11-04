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

// Value is a channel's amount, shaped as the channel (ChannelKind): a number for a 1-value one
// (`"l_arm.shoulder_top": 0.4`, `"l_leg.weight": 1`), [x, y, z] for a 3-value one (`"l_leg"`, an IK
// target; `"root"`, `"root.turn"`; `"l_arm.shoulder"`, a BALL joint). In a clip's motion, a
// position can also follow an Arc, named (`"r_hand": "strike"`), and a Pose of the animation is
// a number, how much of its amounts (`"fist": 1`).
Value :: union {
  f32,
  [3]f32,
  string,
}

// Arc is a named path in space, the animation's (Animation.arcs), for any clip's moves to put a
// position on (an IK target, the root; a turn is one value per axis, no path): points
// `[[x, y, z], ..]`, written as a [3]f32 value would be (an IK target's are offsets from where its
// tip is at rest), and a smooth curve through them (arc_at). An open arc runs from its first point
// to its last; a `closed` one on from its last back to its first (a foot's loop), each point
// written once.
// In a motion, a move naming it puts its channels on it where the motion's shape says: 0 its first
// point, 1 its end (its last point; closed, its first again), k / segments its point k, so the
// shape times the path and holds on its points; a shape going 0, 1, 0 runs out along it and back.
// It runs smooth through its points (arc_at), but for its `corners`, sharp points: a segment
// between two corners is a straight line run at a steady speed (a foot on the ground, a piston's
// stroke, a punch driven straight), and a corner turns the path hard.
Arc :: struct {
  name:    string,
  points:  [dynamic][3]f32,
  corners: [dynamic]int,
  closed:  bool,
}

// Pose is a named set of channel amounts, the animation's (Animation.poses), for any clip's moves
// to add by name, times a number: `"by": {"fist": 1}` adds every amount of pose `fist`, `"fist":
// 0.5` half of each. The move's twin and delay apply to them as to its own (a fist written on the
// right hand closes both with a WITH twin). A pose holds amounts only: no arcs, no other poses. A
// channel's name wins over a pose's.
Pose :: struct {
  name: string,
  by:   map[string]Value,
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
// half a cycle behind the other, a strike firing feet, pelvis, shoulder, arm in turn). `spread`
// runs its channels one after another: in the model's order (parents first: down a chain, head to
// tail), the k-th of n runs spread * k / (n - 1) cycles later still, so one move is a wave down a
// spine or an arm firing shoulder, elbow, wrist (a 3-value channel is one link; an arc runs at the
// move's delay). With a `twin`, its channels' twins move too, at the same links' delays. The rest
// pose (Model.pose) moves as a WITH move does.
Move :: struct {
  delay:  f32,
  spread: f32,
  twin:   Twin,
  by:     map[string]Value,
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

// arc_find is arc `name` of `arcs`, -1 for none.
arc_find :: proc(arcs: []Arc, name: string) -> int {
  for a, i in arcs do if a.name == name do return i
  return -1
}

// pose_find is pose `name` of `poses`, -1 for none.
pose_find :: proc(poses: []Pose, name: string) -> int {
  for p, i in poses do if p.name == name do return i
  return -1
}

// arc_sharp is which of arc `a`'s points are corners, one per point, appended to `out`. Corners
// outside its points are ignored.
arc_sharp :: proc(a: Arc, out: ^[dynamic]bool) {
  first := len(out)
  resize(out, first + len(a.points))
  for k in a.corners do if k >= 0 && k < len(a.points) do out[first + k] = true
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
// them; its shape copied in order of u; its arcs' points, and which are corners (`sharp`, one per
// point).
MotionData :: struct {
  shape:   [dynamic]Point,
  rate:    f32,
  targets: [dynamic]Target,
  arcs:    [dynamic]ArcData,
  points:  [dynamic][3]f32,
  sharp:   [dynamic]bool,
  moves:   [dynamic]MoveData,
}

// MoveData is a move resolved: its targets, targets[first:][:count], and its arcs, arcs[arcs_first:][:arcs_count].
MoveData :: struct {
  delay:                   f32,
  first, count:            int,
  arcs_first, arcs_count: int,
}

// ArcData is an arc resolved: the channels it moves, each times `flip` (a twin's, mirrored), along
// points[first:][:count] of its motion (and sharp[first:][:count]), a copy of Animation.arcs[arc].
ArcData :: struct {
  channels:     [3]int,
  flip:         [3]f32,
  first, count: int,
  arc:          int,
  closed:       bool,
}

// Target is one of a pose's values (`index`) and an amount for it, `delay` cycles later than its
// move (its link's, of a move's spread).
Target :: struct {
  index: int,
  value: f32,
  delay: f32,
}

// ByKind is what a name and value of a move's `by` (or a pose's, or the rest pose's) mean: an
// AMOUNT on a channel, a POSE of the animation added times a number, an ARC a position follows; BAD
// for anything else (by_resolve says why).
ByKind :: enum u8 {
  BAD,
  AMOUNT,
  POSE,
  ARC,
}

// ByWhere is where a `by` is written, which limits what it may hold: the model's rest pose
// (amounts only, the animation's poses and arcs unknown to it), a pose of the animation (amounts
// only), or a clip's move (anything).
ByWhere :: enum u8 {
  REST,
  POSE,
  CLIP,
}

// by_resolve says what `name: value` of a `by` written `at` means in model `m` (and animation
// `anim`, nil for the rest pose): its kind, its channel (AMOUNT, ARC), the pose or arc's index
// (POSE, ARC); for BAD, `problem` says why. A value is shaped as its channel (ChannelKind): a
// number for a 1-value one, [x, y, z] for a 3-value one; an arc's name for a POSITION (a turn is no
// path in space); a number for a pose, how much of it. This is the one place these rules live:
// targets_resolve skips what it calls BAD, and character_check reports it.
by_resolve :: proc(m: ^Model, anim: ^Animation, at: ByWhere, name: string, value: Value, allocator := context.temp_allocator) -> (kind: ByKind, c: Channel, index: int, problem: string) {
  sizes := CHANNEL_SIZE
  known: bool
  c, known = model_channel(m, name)
  index = pose_find(anim.poses[:], name) if anim != nil && at != .REST else -1
  if !known {
    switch {
    case index < 0:
      problem = fmt.aprintf("no channel %s", name, allocator = allocator)
    case at == .POSE:
      problem = fmt.aprintf("adds pose %s, but a pose holds amounts only", name, allocator = allocator)
    case:
      if _, ok := value.(f32); ok do return .POSE, c, index, ""
      problem = fmt.aprintf("pose %s takes a number, how much of it", name, allocator = allocator)
    }
    return
  }
  if index >= 0 do return .BAD, c, -1, fmt.aprintf("%s is both a channel and a pose", name, allocator = allocator)
  switch v in value {
  case string:
    index = arc_find(anim.arcs[:], v) if anim != nil else -1
    switch {
    case at != .CLIP:
      problem = fmt.aprintf("%s follows arc %s, which only a clip's move can", name, v, allocator = allocator)
    case c.kind != .POSITION:
      problem = fmt.aprintf("%s follows arc %s, but only a position (an IK target, the root) can", name, v, allocator = allocator)
    case index < 0:
      problem = fmt.aprintf("%s follows arc %s, which the animation lacks", name, v, allocator = allocator)
    case:
      return .ARC, c, index, ""
    }
  case f32:
    if sizes[c.kind] == 1 do return .AMOUNT, c, -1, ""
    problem = fmt.aprintf("%s is a %v, three values [x, y, z], not one", name, c.kind, allocator = allocator)
  case [3]f32:
    if sizes[c.kind] == 3 do return .AMOUNT, c, -1, ""
    problem = fmt.aprintf("%s is a %v, one value, not three", name, c.kind, allocator = allocator)
  }
  return .BAD, c, -1, problem
}

// targets_resolve appends `values`' channels in model `m` to `out`, one target per value, times
// `scale`, as by_resolve reads them written `at`: amounts as they are, the animation `anim`'s
// poses as their amounts times the number, and (in a clip, given motion `mo`) the arcs values name
// appended to its arcs (their points to its points). What by_resolve calls BAD is skipped;
// character_check reports it.
targets_resolve :: proc(m: ^Model, at: ByWhere, values: map[string]Value, out: ^[dynamic]Target, anim: ^Animation = nil, mo: ^MotionData = nil, scale: f32 = 1) {
  for name, value in values {
    kind, c, index, _ := by_resolve(m, anim, at, name, value)
    switch kind {
    case .BAD:
    case .POSE:
      targets_resolve(m, .POSE, anim.poses[index].by, out, anim, nil, scale * value.(f32))
    case .ARC:
      if mo == nil do continue
      arc := anim.arcs[index]
      append(&mo.arcs, ArcData{{c.first, c.first + 1, c.first + 2}, 1, len(mo.points), len(arc.points), index, arc.closed})
      append(&mo.points, ..arc.points[:])
      arc_sharp(arc, &mo.sharp)
    case .AMOUNT:
      switch v in value {
      case f32:
        append(out, Target{c.first, v * scale, 0})
      case [3]f32:
        for x, n in v do append(out, Target{c.first + n, x * scale, 0})
      case string:
      }
    }
  }
}

// move_resolve appends move `mv`'s channels in model `m` to `targets` and a MoveData for them to
// `moves` (the poses it adds, from `anim`, and the arcs it names, to motion `mo`'s; see
// targets_resolve); with a twin (Move.twin), then its channels' twins (channel_twin) by the same
// amounts, at the same delay or half a cycle later. Channels without a twin (the root's) move once.
// An arc's twin follows the same points, each channel times its twin's flip (the other side's x
// mirrored), when all three channels have twins.
move_resolve :: proc(m: ^Model, at: ByWhere, mv: Move, targets: ^[dynamic]Target, moves: ^[dynamic]MoveData, anim: ^Animation = nil, mo: ^MotionData = nil) {
  arcs_count :: proc(mo: ^MotionData) -> int {return len(mo.arcs) if mo != nil else 0}
  first, arcs_first := len(targets), arcs_count(mo)
  targets_resolve(m, at, mv.by, targets, anim, mo)
  count := len(targets) - first
  if mv.spread != 0 do targets_spread(m, targets[first:][:count], mv.spread)
  append(moves, MoveData{mv.delay, first, count, arcs_first, arcs_count(mo) - arcs_first})
  if mv.twin == .NONE do return
  start := len(targets)
  for k in first ..< first + count {
    t := targets[k]
    if twin, flip := channel_twin(m, t.index); twin >= 0 do append(targets, Target{twin, t.value * flip, t.delay})
  }
  arcs_start := arcs_count(mo)
  for k in arcs_first ..< arcs_start {
    a := mo.arcs[k]
    twin := ArcData{first = a.first, count = a.count, arc = a.arc, closed = a.closed}
    whole := true
    for ch, n in a.channels {
      t, flip := channel_twin(m, ch)
      twin.channels[n], twin.flip[n] = t, a.flip[n] * flip
      whole &&= t >= 0
    }
    if whole do append(&mo.arcs, twin)
  }
  append(moves, MoveData{mv.delay + (0.5 if mv.twin == .OPPOSITE else 0), start, len(targets) - start, arcs_start, arcs_count(mo) - arcs_start})
}

// targets_spread delays `targets` (one move's) link by link (Move.spread): their channels in the
// model's order, the k-th of n `spread * k / (n - 1)` cycles late.
targets_spread :: proc(m: ^Model, targets: []Target, spread: f32) {
  heads := make([dynamic]int, context.temp_allocator)
  for t in targets {
    c, _, _ := value_channel(m, t.index)
    if _, found := slice.linear_search(heads[:], c.first); !found do append(&heads, c.first)
  }
  if len(heads) < 2 do return
  slice.sort(heads[:])
  for &t in targets {
    c, _, _ := value_channel(m, t.index)
    k, _ := slice.binary_search(heads[:], c.first)
    t.delay = spread * f32(k) / f32(len(heads) - 1)
  }
}

// model_pose is `m`'s rest pose, one value per channel: Model.pose, both sides of the body (a WITH
// move), every other channel 0.
model_pose :: proc(m: ^Model, allocator := context.allocator) -> []f32 {
  out := make([]f32, model_channels(m), allocator)
  targets := make([dynamic]Target, context.temp_allocator)
  moves := make([dynamic]MoveData, context.temp_allocator)
  move_resolve(m, .REST, Move{twin = .WITH, by = m.pose}, &targets, &moves)
  for t in targets do out[t.index] += t.value
  return out
}

clips_build :: proc(a: ^Animation, m: ^Model) -> (c: Clips) {
  c.values = model_channels(m)
  pose := model_pose(m, context.temp_allocator)
  append(&c.pose, ..pose)
  for clip in a.clips {
    data := ClipData{name = clip.name, duration = clip.duration}
    for mo in clip.motions {
      out := MotionData{rate = f32(max(mo.rate, 1))}
      append(&out.shape, ..mo.shape[:])
      slice.stable_sort_by(out.shape[:], proc(a, b: Point) -> bool {return a.u < b.u})
      for mv in mo.moves do move_resolve(m, .CLIP, mv, &out.targets, &out.moves, a, &out)
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
      delete(mo.sharp)
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
    for target in mo.targets[mv.first:][:mv.count] do out[target.index] += target.value * (f if target.delay == 0 else motion_move(mo, k, x, target.delay))
    for a in mo.arcs[mv.arcs_first:][:mv.arcs_count] {
      p := arc_at(mo.points[a.first:][:a.count], mo.sharp[a.first:][:a.count], f, a.closed)
      for ch, n in a.channels do out[ch] += p[n] * a.flip[n]
    }
  }
}

// arc_at is the arc through `points` at `s`: point k at s = k / segments (n - 1 open, n `closed`,
// the last segment back to the first point), a cubic between each two (Hermite). Each point's
// tangent is Catmull-Rom's, half the way from the point before it to the one after, but where there
// is no point on one side (an open arc's ends) or it is a corner (`sharp`, one per point; nil for
// none), each segment's own chord: so a segment between two corners is straight, run at a steady
// speed. Past either end, an open arc runs on along its end's tangent (a shape settling past 1
// overshoots along the path, not off it); a closed one goes round again.
arc_at :: proc(points: [][3]f32, sharp: []bool, s: f32, closed := false) -> [3]f32 {
  n := len(points)
  if n == 0 do return 0
  if n == 1 do return points[0]
  closed := closed && n > 2
  segments := n if closed else n - 1
  u := s * f32(segments)
  if closed do u -= math.floor(u / f32(segments)) * f32(segments)
  k := clamp(int(math.floor(u)), 0, segments - 1)
  t := u - f32(k)
  at :: proc(points: [][3]f32, i: int) -> [3]f32 {return points[(i + len(points)) % len(points)]}
  // the tangent at point i: Catmull-Rom's, or the chord at an end or a corner
  tangent :: proc(points: [][3]f32, sharp: []bool, i: int, closed: bool, chord: [3]f32) -> [3]f32 {
    n := len(points)
    if len(sharp) >= n && sharp[(i + n) % n] do return chord
    if !closed && (i == 0 || i == n - 1) do return chord
    return (at(points, i + 1) - at(points, i - 1)) / 2
  }
  p1, p2 := at(points, k), at(points, k + 1)
  chord := p2 - p1
  m1, m2 := tangent(points, sharp, k, closed, chord), tangent(points, sharp, k + 1, closed, chord)
  if t < 0 do return p1 + m1 * t
  if t > 1 do return p2 + m2 * (t - 1)
  t2, t3 := t * t, t * t * t
  return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (3 * t2 - 2 * t3) * p2 + (t3 - t2) * m2
}

// motion_move is how much of its amounts move `k` of motion `mo` adds at clip progress `x`; of a
// target `late` cycles later than its move (Target.delay), that target's.
motion_move :: proc(mo: ^MotionData, k: int, x: f32, late: f32 = 0) -> f32 {
  return shape_value(mo.shape[:], mo.rate * x - mo.moves[k].delay - late)
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
