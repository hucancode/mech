package mech

import "core:encoding/json"
import "core:fmt"
import "core:log"
import "core:math"
import "core:mem"
import "core:slice"
import "../mjolnir/animation"
import "../mjolnir/geometry"

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
// target; `"root"`, `"root.turn"`; `"l_arm.shoulder"`, a BALL joint). A string is a file of the
// first format's: there a move's `by` also named the arc a position follows (animation_parse moves
// it to Move.arcs); anywhere else it is no amount (by_resolve).
Value :: union {
  f32,
  [3]f32,
  string,
}

// Arc is a named path in space, the animation's (Animation.arcs), for any clip's moves to put a
// position on (an IK target, the root; a turn is one value per axis, no path): points
// `[[x, y, z], ..]`, written as a [3]f32 value would be (an IK target's are offsets from where its
// tip is at rest), and a smooth curve through them (geometry.arc_sample). An open arc runs from its first point
// to its last; a `closed` one on from its last back to its first (a foot's loop), each point
// written once.
// In a motion, a move naming it (Move.arcs) puts a position on it where the motion's shape says:
// 0 its first point, 1 its end (its last point; closed, its first again), each point at its `at`,
// so the shape times the path and holds on its points; a shape going 0, 1, 0 runs out along it and
// back. With no `at`, its points are spread evenly, point k at k / segments (n - 1 open, n closed);
// with one per point, each where it says, rising (0 to 1, a closed arc's last below its first plus
// 1), so adding or taking out a point leaves the others where they were along it, and every move
// on it as timed (arc_knots).
// It runs smooth through its points (geometry.arc_sample), but for its `corners`, sharp points: a segment
// between two corners is a straight line run at a steady speed (a foot on the ground, a piston's
// stroke, a punch driven straight), and a corner turns the path hard.
Arc :: struct {
  name:    string,
  points:  [dynamic][3]f32,
  at:      [dynamic]f32,
  corners: [dynamic]int,
  closed:  bool,
}

// Pose is a named set of channel amounts, the animation's (Animation.poses), for any clip's moves
// to add by name, times a number (Move.poses): `"poses": {"fist": 1}` adds every amount of pose
// `fist`, `"fist": 0.5` half of each. The move's twin and delay apply to them as to its own (a fist
// written on the right hand closes both with a WITH twin). A pose holds amounts only: no arcs, no
// other poses.
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
// What it moves, each by name: `by` its amounts, by channel; `poses` the animation's poses it adds,
// each times a number; `arcs` the positions it puts on the animation's arcs (an IK target, the
// root: `"l_leg": "step"`), along them as its shape says. Three maps, so a pose may share a
// channel's name and nothing is read two ways.
Move :: struct {
  delay:  f32,
  spread: f32,
  twin:   Twin,
  by:     map[string]Value,
  poses:  map[string]f32,
  arcs:   map[string]string,
}

// Motion is a shape over time added onto channels. Its shape is points over one cycle
// (shape_value), repeating `rate` times over the clip (0 is 1); no points is 1 throughout (a held
// pose). At clip progress x (0 at its start, 1 at its end), each move adds its amounts times
//   shape(rate * x - delay)
// A walk, a slither, a swing or a strike is a few motions: data, not code (docs/animation.md).
// Its `name` is for people (the editor lists it); the engine reads nothing from it.
Motion :: struct {
  name:  string,
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
  animation_upgrade(a)
  return a, true
}

// animation_upgrade reads a file of the first format: there a move's `by` held its amounts, the
// poses it added (a number by a pose's name) and the arcs its positions followed (an arc's name
// by a channel's), which go to Move.poses and Move.arcs. A pose's name was a pose's only where no
// channel had it; such a clash was an error then too, so the name goes to the pose.
@(private = "file")
animation_upgrade :: proc(a: ^Animation) {
  allocator := animation_allocator(a)
  for &clip in a.clips do for &mo in clip.motions do for &mv in mo.moves {
    moved := make([dynamic]string, context.temp_allocator)
    for name, value in mv.by {
      switch v in value {
      case string:
        if mv.arcs == nil do mv.arcs = make(map[string]string, allocator = allocator)
        mv.arcs[name] = v
        append(&moved, name)
      case f32:
        if pose_find(a.poses[:], name) < 0 do continue
        if mv.poses == nil do mv.poses = make(map[string]f32, allocator = allocator)
        mv.poses[name] = v
        append(&moved, name)
      case [3]f32:
      }
    }
    for name in moved do delete_key(&mv.by, name)
  }
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

// arc_knots is where along arc `a` each of its points is (Arc.at; evenly spread when it says
// none, or not one per point), appended to `out`: 0 the first, 1 the end.
arc_knots :: proc(a: Arc, out: ^[dynamic]f32) {
  n := len(a.points)
  if len(a.at) == n {
    append(out, ..a.at[:])
    return
  }
  segments := n if a.closed && n > 2 else n - 1
  for k in 0 ..< n do append(out, f32(k) / f32(max(segments, 1)))
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
// model's rest pose (`pose`, one value per channel); `iks` the placed IK targets (ik_count), whose
// toes' trails clip_sample writes. Rebuild it when either changes.
Clips :: struct {
  values:  int,
  iks:     int,
  pose:    [dynamic]f32,
  clips:   [dynamic]ClipData,
}

ClipData :: struct {
  name:     string,
  duration: f32,
  motions:  [dynamic]MotionData,
}

// MotionData is a Motion with its names resolved: its moves' targets, flat, each move a run of
// them; its shape copied in order of u; its arcs' points, which are corners (`sharp`) and where
// along the arc each is (`knots`), one per point.
MotionData :: struct {
  shape:   [dynamic]Point,
  rate:    f32,
  targets: [dynamic]Target,
  arcs:    [dynamic]ArcData,
  points:  [dynamic][3]f32,
  sharp:   [dynamic]bool,
  knots:   [dynamic]f32,
  moves:   [dynamic]MoveData,
}

// MoveData is a move resolved: its targets, targets[first:][:count], and its arcs, arcs[arcs_first:][:arcs_count].
MoveData :: struct {
  delay:                   f32,
  first, count:            int,
  arcs_first, arcs_count: int,
}

// ArcData is an arc resolved: the channels it moves, each times `flip` (a twin's, mirrored), along
// points[first:][:count] of its motion (and sharp, knots[first:][:count]), a copy of
// Animation.arcs[arc].
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

// by_resolve says what `name: value` of a `by` (a move's, a pose's, the rest pose's) means for
// channels `cs`: its channel (`ok`), or why it is none (`problem`). A value is shaped as its
// channel (ChannelKind): a number for a 1-value one, [x, y, z] for a 3-value one. This is the one
// place these rules live: targets_resolve skips what it can't use, and character_check reports it.
by_resolve :: proc(cs: ^Channels, name: string, value: Value, allocator := context.temp_allocator) -> (c: Channel, ok: bool, problem: string) {
  sizes := CHANNEL_SIZE
  known: bool
  c, known = channels_find(cs, name)
  if !known do return c, false, fmt.aprintf("no channel %s", name, allocator = allocator)
  switch v in value {
  case string:
    problem = fmt.aprintf("%s: %q is no amount (a move follows an arc in its `arcs`)", name, v, allocator = allocator)
  case f32:
    if sizes[c.kind] == 1 do return c, true, ""
    problem = fmt.aprintf("%s is a %v, three values [x, y, z], not one", name, c.kind, allocator = allocator)
  case [3]f32:
    if sizes[c.kind] == 3 do return c, true, ""
    problem = fmt.aprintf("%s is a %v, one value, not three", name, c.kind, allocator = allocator)
  }
  return c, false, problem
}

// arc_resolve says which arc of `anim` position channel `name` follows (Move.arcs: `arc`), and its
// channel; or why not (`problem`): only a position (an IK target, the root) has a path in space.
arc_resolve :: proc(cs: ^Channels, anim: ^Animation, name, arc: string, allocator := context.temp_allocator) -> (c: Channel, index: int, problem: string) {
  known: bool
  c, known = channels_find(cs, name)
  index = arc_find(anim.arcs[:], arc)
  switch {
  case !known:
    problem = fmt.aprintf("no channel %s", name, allocator = allocator)
  case c.kind != .POSITION:
    problem = fmt.aprintf("%s follows arc %s, but only a position (an IK target, the root) can", name, arc, allocator = allocator)
  case index < 0:
    problem = fmt.aprintf("%s follows arc %s, which the animation lacks", name, arc, allocator = allocator)
  case:
    return
  }
  return c, -1, problem
}

// targets_resolve appends amounts `values`' channels (of `cs`) to `out`, one target per value,
// times `scale`. What by_resolve can't use is skipped; character_check reports it.
targets_resolve :: proc(cs: ^Channels, values: map[string]Value, out: ^[dynamic]Target, scale: f32 = 1) {
  for name, value in values {
    c, ok, _ := by_resolve(cs, name, value)
    if !ok do continue
    switch v in value {
    case f32:
      append(out, Target{c.first, v * scale, 0})
    case [3]f32:
      for x, n in v do append(out, Target{c.first + n, x * scale, 0})
    case string:
    }
  }
}

// move_resolve appends move `mv`'s channels (of `cs`) to `targets` and a MoveData for them to
// `moves` (the poses it adds, from `anim`, and the arcs it names, to motion `mo`'s; see
// targets_resolve); with a twin (Move.twin), then its channels' twins (channel_twin) by the same
// amounts, at the same delay or half a cycle later. Channels without a twin (the root's) move once.
// An arc's twin follows the same points, each channel times its twin's flip (the other side's x
// mirrored), when all three channels have twins.
move_resolve :: proc(cs: ^Channels, mv: Move, targets: ^[dynamic]Target, moves: ^[dynamic]MoveData, anim: ^Animation = nil, mo: ^MotionData = nil) {
  arcs_count :: proc(mo: ^MotionData) -> int {return len(mo.arcs) if mo != nil else 0}
  first, arcs_first := len(targets), arcs_count(mo)
  targets_resolve(cs, mv.by, targets)
  if anim != nil {
    // the poses it adds: their amounts, times how much of each
    for name, much in mv.poses do if k := pose_find(anim.poses[:], name); k >= 0 do targets_resolve(cs, anim.poses[k].by, targets, much)
    // the positions it puts on arcs: their points, copied to the motion's
    if mo != nil do for name, arc in mv.arcs {
      c, k, problem := arc_resolve(cs, anim, name, arc)
      if problem != "" do continue
      a := anim.arcs[k]
      append(&mo.arcs, ArcData{{c.first, c.first + 1, c.first + 2}, 1, len(mo.points), len(a.points), k, a.closed})
      append(&mo.points, ..a.points[:])
      arc_sharp(a, &mo.sharp)
      arc_knots(a, &mo.knots)
    }
  }
  count := len(targets) - first
  if mv.spread != 0 do targets_spread(cs, targets[first:][:count], mv.spread)
  append(moves, MoveData{mv.delay, first, count, arcs_first, arcs_count(mo) - arcs_first})
  if mv.twin == .NONE do return
  start := len(targets)
  for k in first ..< first + count {
    t := targets[k]
    if twin := cs.twin[t.index]; twin >= 0 do append(targets, Target{twin, t.value * cs.flip[t.index], t.delay})
  }
  arcs_start := arcs_count(mo)
  for k in arcs_first ..< arcs_start {
    a := mo.arcs[k]
    twin := ArcData{first = a.first, count = a.count, arc = a.arc, closed = a.closed}
    whole := true
    for ch, n in a.channels {
      t := cs.twin[ch]
      twin.channels[n], twin.flip[n] = t, a.flip[n] * cs.flip[ch]
      whole &&= t >= 0
    }
    if whole do append(&mo.arcs, twin)
  }
  append(moves, MoveData{mv.delay + (0.5 if mv.twin == .OPPOSITE else 0), start, len(targets) - start, arcs_start, arcs_count(mo) - arcs_start})
}

// targets_spread delays `targets` (one move's) link by link (Move.spread): their channels in the
// model's order, the k-th of n `spread * k / (n - 1)` cycles late.
// (mjolnir's animation.Lag with step spread / (n - 1), on the shape's time.)
targets_spread :: proc(cs: ^Channels, targets: []Target, spread: f32) {
  heads := make([dynamic]int, context.temp_allocator)
  for t in targets {
    c, _, _ := channels_value(cs, t.index)
    if _, found := slice.linear_search(heads[:], c.first); !found do append(&heads, c.first)
  }
  if len(heads) < 2 do return
  slice.sort(heads[:])
  for &t in targets {
    c, _, _ := channels_value(cs, t.index)
    k, _ := slice.binary_search(heads[:], c.first)
    t.delay = spread * f32(k) / f32(len(heads) - 1)
  }
}

// model_pose is `m`'s rest pose, one value per channel: Model.pose, both sides of the body (a WITH
// move), every other channel 0.
model_pose :: proc(m: ^Model, allocator := context.allocator) -> []f32 {
  cs := channels_make(m)
  out := make([]f32, model_channels(m), allocator)
  targets := make([dynamic]Target, context.temp_allocator)
  moves := make([dynamic]MoveData, context.temp_allocator)
  move_resolve(&cs, Move{twin = .WITH, by = m.pose}, &targets, &moves)
  for t in targets do out[t.index] += t.value
  return out
}

clips_build :: proc(a: ^Animation, m: ^Model) -> (c: Clips) {
  c.values = model_channels(m)
  c.iks = ik_count(m)
  pose := model_pose(m, context.temp_allocator)
  cs := channels_make(m)
  append(&c.pose, ..pose)
  for clip in a.clips {
    data := ClipData{name = clip.name, duration = clip.duration}
    for mo in clip.motions {
      out := MotionData{rate = f32(max(mo.rate, 1))}
      append(&out.shape, ..mo.shape[:])
      slice.stable_sort_by(out.shape[:], proc(a, b: Point) -> bool {return a.u < b.u})
      for mv in mo.moves do move_resolve(&cs, mv, &out.targets, &out.moves, a, &out)
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
      delete(mo.knots)
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
// pose, then each motion adding its own; then each IK target's trail (IK_TRAIL), how far behind it
// a foot's links follow it (clip_trail). A clip index out of range gives the rest pose.
clip_sample :: proc(c: ^Clips, clip: int, t: f32, out: []f32) {
  copy(out, c.pose[:])
  if clip < 0 || clip >= len(c.clips) do return
  data := &c.clips[clip]
  x := t / data.duration if data.duration > 0 else 0
  for &mo in data.motions do motion_apply(&mo, x, out)
  clip_trail(c, data, x, out)
}

// FOLLOW is how long a foot's links take to follow its heel, cycles of its clip a link (a tail's
// spread, so a slow gait lags as a fast one does): its ball where its target was through the
// FOLLOW before, its toes through the FOLLOW before that.
FOLLOW :: 0.1
// TRAIL_STEPS is how many times a link's FOLLOW is sampled, to average where its target was.
TRAIL_STEPS :: 4
// TRAIL is when a foot's links read its target (mjolnir's animation.Lag): link k through the FOLLOW
// before the k-th FOLLOW back, on average.
TRAIL :: animation.Lag{step = FOLLOW, window = FOLLOW, samples = TRAIL_STEPS}

// clip_trail writes the trail of every IK target of clip `data` at progress `x` into `out` (the
// pose there): for each of a foot's links (IK_LINKS), how far behind the target it is, where the
// target was when the link reads it (TRAIL, animation.lag_sample), so the links lag it and settle
// after it rather than copy each jerk. Every clip alike; a clip's shapes repeat, so before its
// start is its last cycle.
@(private = "file")
clip_trail :: proc(c: ^Clips, data: ^ClipData, x: f32, out: []f32) {
  if c.iks == 0 || data.duration <= 0 do return
  // the clip's IK targets at a time, as a signal to read behind
  Targets :: struct {
    c:    ^Clips,
    data: ^ClipData,
    pose: []f32,
  }
  sample :: proc(data: rawptr, x: f32, out: []f32) {
    s := (^Targets)(data)
    copy(s.pose, s.c.pose[:])
    for &mo in s.data.motions do motion_apply(&mo, x, s.pose)
    for k in 0 ..< s.c.iks do copy(out[3 * k:][:3], s.pose[ik_channel(nil, k):][:3])
  }
  targets := Targets{c, data, make([]f32, len(out), context.temp_allocator)}
  read := make([]f32, 3 * c.iks, context.temp_allocator)
  for link in 0 ..< IK_LINKS {
    animation.lag_sample(TRAIL, link, x, {&targets, sample}, read)
    for k in 0 ..< c.iks {
      ch := ik_channel(nil, k)
      for n in 0 ..< 3 do out[ch + IK_TRAIL + 3 * link + n] = read[3 * k + n] - out[ch + n]
    }
  }
}

// motion_apply adds motion `mo` at clip progress `x` (0 to 1 over the clip) onto `out`: each move's
// amounts times its shape, and its arcs where its shape is along them.
motion_apply :: proc(mo: ^MotionData, x: f32, out: []f32) {
  for mv, k in mo.moves {
    f := motion_move(mo, k, x)
    for target in mo.targets[mv.first:][:mv.count] do out[target.index] += target.value * (f if target.delay == 0 else motion_move(mo, k, x, target.delay))
    for a in mo.arcs[mv.arcs_first:][:mv.arcs_count] {
      p := geometry.arc_sample(motion_arc(mo, a), f)
      for ch, n in a.channels do out[ch] += p[n] * a.flip[n]
    }
  }
}

// motion_arc is arc `a` of motion `mo` as geometry.Arc: a view of the motion's points, corners and
// knots.
motion_arc :: proc(mo: ^MotionData, a: ArcData) -> geometry.Arc([3]f32) {
  return {points = mo.points[a.first:][:a.count], sharp = mo.sharp[a.first:][:a.count], knots = mo.knots[a.first:][:a.count], closed = a.closed}
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
