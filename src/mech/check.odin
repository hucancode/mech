package mech

import "core:fmt"
import "core:mem"
import "core:strings"

// character_check lists what is wrong with a character, so nothing else needs to: rig_create,
// clips_build and targets_resolve skip what they can't use, quietly, and this says why. It is the
// one home of the rules a model and its animation must keep (docs/modeling.md, docs/animation.md).
//
// An ERROR is data the engine can't use as written: a name that resolves to nothing, a value
// shaped unlike its channel, a joint left without stops. A BUDGET issue is data the engine can use,
// but which is fighting the machine (docs/animation.md, Style): a shape of more than SHAPE_BUDGET
// points, or a channel in more than MOTION_BUDGET motions of one clip. Change the approach (a pose,
// a spread, an arc, FK), not the amount of data.

Severity :: enum u8 {
  ERROR,
  BUDGET,
}

// Issue is one thing wrong, and where (`at`): the thing to go to, to fix it.
Issue :: struct {
  severity: Severity,
  text:     string,
  at:       Path,
}

SHAPE_BUDGET :: 6
MOTION_BUDGET :: 2

// character_check is every issue of model `m` and animation `a` (nil for none), in the order of the
// file; its texts are allocated with `allocator`.
character_check :: proc(m: ^Model, a: ^Animation, allocator := context.temp_allocator) -> []Issue {
  out := make([dynamic]Issue, allocator)
  cs := channels_make(m)
  model_check(m, &cs, &out, allocator)
  if a != nil do animation_check(m, &cs, a, &out, allocator)
  return out[:]
}

@(private = "file")
issue :: proc(out: ^[dynamic]Issue, allocator: mem.Allocator, severity: Severity, at: Path, format: string, args: ..any) {
  // the path's names are the model's or the animation's: kept with the issue's text
  at := at
  at.name = strings.clone(at.name, allocator)
  at.item = strings.clone(at.item, allocator)
  append(out, Issue{severity, fmt.aprintf(format, ..args, allocator = allocator), at})
}

// unique reports names that appear twice in `names`, as `what`, each at a path of `kind`: named
// (its owner's, the part of a slot or a joint, with it as the item), or CHARACTER with it as the
// item (a placed name, a channel).
@(private = "file")
unique :: proc(out: ^[dynamic]Issue, allocator: mem.Allocator, what: string, names: []string, kind: PathKind, owner := "") {
  for n, i in names do for k in 0 ..< i do if names[k] == n {
    at := Path{kind = kind, name = n}
    if owner != "" || kind == .CHARACTER do at = {kind = kind, name = owner, item = n}
    issue(out, allocator, .ERROR, at, "%s %s is named twice", what, n)
    break
  }
}

@(private = "file")
model_check :: proc(m: ^Model, cs: ^Channels, out: ^[dynamic]Issue, allocator: mem.Allocator) {
  names := make([dynamic]string, context.temp_allocator)
  collect :: proc(names: ^[dynamic]string, list: $T/[]$E) -> []string {
    clear(names)
    for x in list do append(names, x.name)
    return names[:]
  }
  unique(out, allocator, "material", collect(&names, m.materials[:]), .MATERIAL)
  unique(out, allocator, "part", collect(&names, m.parts[:]), .PART)
  unique(out, allocator, "instance", collect(&names, m.assembly[:]), .INSTANCE)
  unique(out, allocator, "ik", collect(&names, m.iks[:]), .IK)

  material :: proc(m: ^Model, out: ^[dynamic]Issue, allocator: mem.Allocator, at: Path, what, name: string) {
    if name != "" && model_material(m, name) < 0 do issue(out, allocator, .ERROR, at, "%s is painted in unknown material %s", what, name)
  }
  material(m, out, allocator, {kind = .CHARACTER, item = "female"}, "hardware (female)", m.hardware.female)
  material(m, out, allocator, {kind = .CHARACTER, item = "male"}, "hardware (male)", m.hardware.male)
  material(m, out, allocator, {kind = .CHARACTER, item = "metal"}, "hardware (metal)", m.hardware.metal)

  for p in m.parts {
    unique(out, allocator, fmt.tprint("part", p.name, "slot"), collect(&names, p.slots[:]), .SLOT, p.name)
    unique(out, allocator, fmt.tprint("part", p.name, "joint"), collect(&names, p.joints[:]), .JOINT, p.name)
    for s, k in p.shapes do material(m, out, allocator, {kind = .SHAPE, name = p.name, index = k}, fmt.tprintf("part %s shape %d", p.name, k), s.material)
    for j in p.joints do joint_check(out, allocator, p, j)
    // a mirrored slot's two sides must be two: off its plane
    for x in p.slots do if x.mirror != .NONE && abs(x.position[int(x.mirror) - 1]) < 1e-4 do issue(out, allocator, .ERROR, {kind = .SLOT, name = p.name, item = x.name}, "part %s slot %s lies on its mirror plane (%v = 0): both sides would be one", p.name, x.name, x.mirror)
  }

  for inst, i in m.assembly {
    at := Path{kind = .INSTANCE, name = inst.name}
    part := model_part(m, inst.part)
    if part < 0 && inst.part != "" do issue(out, allocator, .ERROR, at, "%s places unknown part %s", inst.name, inst.part)
    parent := model_instance(m, inst.parent)
    switch {
    case inst.parent == "":
    case parent < 0:
      issue(out, allocator, .ERROR, at, "%s hangs from unknown instance %s", inst.name, inst.parent)
    case parent >= i:
      issue(out, allocator, .ERROR, at, "%s comes before its parent %s", inst.name, inst.parent)
    case inst.parent_slot != "" && part_slot(m, model_part(m, m.assembly[parent].part), inst.parent_slot) < 0:
      issue(out, allocator, .ERROR, at, "%s hangs from unknown slot %s of %s", inst.name, inst.parent_slot, inst.parent)
    }
    if inst.parent == "" && inst.parent_slot != "" do issue(out, allocator, .ERROR, at, "%s is a root, but names slot %s", inst.name, inst.parent_slot)
    for x in inst.joints {
      known := false
      if part >= 0 do for j in m.parts[part].joints do known ||= j.name == x.name
      if !known do issue(out, allocator, .ERROR, at, "%s turns joint %s, which part %s lacks", inst.name, x.name, inst.part)
    }
    // a pair of pairs would place four: the sides of a side are one side
    if parent >= 0 && parent < i && instance_sided(m, parent) && slot_paired(m, parent, inst.parent_slot) do issue(out, allocator, .ERROR, at, "%s hangs from pair slot %s of %s, which is already on the sides of the body", inst.name, inst.parent_slot, inst.parent)
  }

  // what is placed: its names (a side's prefixed) are what channels and clips name
  places := model_places(m)
  clear(&names)
  for p in places do append(&names, place_name(m, p))
  unique(out, allocator, "placed instance", names[:], .CHARACTER)

  ik_places := model_ik_places(m, places)
  clear(&names)
  for k in ik_places do append(&names, ik_name(m, k))
  unique(out, allocator, "placed ik", names[:], .CHARACTER)
  // every channel by its own name: an IK target `root`, an instance `root` with a joint `turn`,
  // an IK target `x` beside an instance `x` with a joint `weight` would each be two channels in one
  clear(&names)
  for c in cs.table do append(&names, c.name)
  unique(out, allocator, "channel", names[:], .CHARACTER)
  for k in ik_places {
    ik := m.iks[k.ik]
    at := Path{kind = .IK, name = ik.name}
    if k.tip < 0 {
      issue(out, allocator, .ERROR, at, "ik %s reaches with unknown instance %s", ik.name, ik.tip)
      continue
    }
    if k.side == .R do continue // as its left side
    // its chain: from ik_root down to the tip's parent (an aim's, the tip too)
    root := ik_root(places, k.tip)
    joints := 0
    for i := k.tip; i >= 0; i = places[i].parent {
      if i != k.tip || ik.aim do joints += len(place_joints(m, places[i]))
      if i == root do break
    }
    if joints == 0 do issue(out, allocator, .ERROR, at, "ik %s: no joint moves %s from %s", ik.name, ik.tip, place_name(m, places[root]))
  }

  // the rest pose is symmetric: one side written, which moves its twin too
  for name, value in m.pose {
    c, ok, problem := by_resolve(cs, name, value)
    at := Path{kind = .REST, item = name}
    if !ok {
      issue(out, allocator, .ERROR, at, "rest pose: %s", problem)
      continue
    }
    twin := cs.twin[c.first]
    if twin < 0 do continue
    t, _, _ := channels_value(cs, twin)
    if t.name in m.pose && t.name > name do issue(out, allocator, .ERROR, at, "rest pose: %s and its twin %s are both written; the rest pose is symmetric, so write one side (asymmetry is a clip's)", name, t.name)
  }
}

// joint_check: a joint's values fit its kind. Every axis it moves on has stops (min < max), but a
// turntable's, which may spin free; axes it doesn't move on have none.
@(private = "file")
joint_check :: proc(out: ^[dynamic]Issue, allocator: mem.Allocator, p: Part, j: Joint) {
  what := fmt.tprintf("part %s joint %s", p.name, j.name)
  at := Path{kind = .JOINT, name = p.name, item = j.name}
  if j.size < 0 do issue(out, allocator, .ERROR, at, "%s: size %v is negative", what, j.size)
  if j.reach != 0 && j.kind != .PIN do issue(out, allocator, .ERROR, at, "%s: only a pin has a reach", what)
  axes, count := joint_axes(j)
  moves: [Axis]bool
  for a in axes[:count] do moves[a] = true
  for a in Axis {
    lo, hi := j.min[a], j.max[a]
    switch {
    case !moves[a]:
      if lo != 0 || hi != 0 do issue(out, allocator, .ERROR, at, "%s: stops on %v, which it doesn't move on", what, a)
    case lo > hi:
      issue(out, allocator, .ERROR, at, "%s: its %v stops are the wrong way round (%v > %v)", what, a, lo, hi)
    case lo == hi && j.kind != .SPIN:
      issue(out, allocator, .ERROR, at, "%s: no stops on %v (only a turntable spins free)", what, a)
    }
  }
}

@(private = "file")
animation_check :: proc(m: ^Model, cs: ^Channels, a: ^Animation, out: ^[dynamic]Issue, allocator: mem.Allocator) {
  names := make([dynamic]string, context.temp_allocator)
  for x in a.arcs do append(&names, x.name)
  unique(out, allocator, "arc", names[:], .ARC)
  clear(&names)
  for x in a.poses do append(&names, x.name)
  unique(out, allocator, "pose", names[:], .POSE)
  clear(&names)
  for x in a.clips do append(&names, x.name)
  unique(out, allocator, "clip", names[:], .CLIP)

  for arc in a.arcs {
    at := Path{kind = .ARC, name = arc.name}
    n := len(arc.points)
    if n < 2 do issue(out, allocator, .ERROR, at, "arc %s: a path needs two points or more", arc.name)
    for k in arc.corners do if k < 0 || k >= n do issue(out, allocator, .ERROR, at, "arc %s: corner %d is none of its %d points", arc.name, k, n)
    // where along it each point is (Arc.at): none, or one per point, rising within one pass
    if len(arc.at) > 0 {
      if len(arc.at) != n do issue(out, allocator, .ERROR, at, "arc %s: %d points, but %d places along it (`at`): one per point, or none", arc.name, n, len(arc.at))
      else {
        for k in 1 ..< n do if arc.at[k] <= arc.at[k - 1] {
          issue(out, allocator, .ERROR, at, "arc %s: point %d is at %v, not after point %d's %v", arc.name, k, arc.at[k], k - 1, arc.at[k - 1])
          break
        }
        if arc.at[0] < 0 || arc.at[n - 1] > 1 do issue(out, allocator, .ERROR, at, "arc %s: its points are along it from %v to %v, outside 0 to 1", arc.name, arc.at[0], arc.at[n - 1])
        if arc.closed && arc.at[n - 1] >= arc.at[0] + 1 do issue(out, allocator, .ERROR, at, "arc %s: closed, but its last point is a whole pass after its first: no way back", arc.name)
      }
    }
  }
  for p in a.poses {
    for name, value in p.by {
      if _, ok, problem := by_resolve(cs, name, value); !ok do issue(out, allocator, .ERROR, {kind = .POSE, name = p.name, item = name}, "pose %s: %s", p.name, problem)
    }
  }

  for clip in a.clips {
    if clip.duration <= 0 do issue(out, allocator, .ERROR, {kind = .CLIP, name = clip.name}, "clip %s: its duration %v is not above 0", clip.name, clip.duration)
    // per channel, how many of its motions move it (by name: a pose's amounts are the pose's)
    motions := make(map[string]int, allocator = context.temp_allocator)
    for mo, n in clip.motions {
      what := fmt.tprintf("clip %s motion %d", clip.name, n)
      at := Path{kind = .MOTION, name = clip.name, index = n}
      if mo.rate < 0 do issue(out, allocator, .ERROR, at, "%s: rate %d is below 0", what, mo.rate)
      for p in mo.shape do if p.u < 0 || p.u > 1 do issue(out, allocator, .ERROR, at, "%s: a shape point at u %v, outside one cycle (0 to 1)", what, p.u)
      if len(mo.shape) > SHAPE_BUDGET do issue(out, allocator, .BUDGET, at, "%s: a shape of %d points (over %d): a pose, a spread or an arc instead?", what, len(mo.shape), SHAPE_BUDGET)
      seen := make(map[string]bool, allocator = context.temp_allocator)
      for mv, k in mo.moves {
        if mv.spread < 0 do issue(out, allocator, .ERROR, {kind = .MOVE, name = clip.name, index = n, move = k}, "%s move %d: spread %v is below 0", what, k, mv.spread)
        for name, value in mv.by {
          _, ok, problem := by_resolve(cs, name, value)
          at := Path{kind = .MOVE, name = clip.name, item = name, index = n, move = k}
          if !ok do issue(out, allocator, .ERROR, at, "%s move %d: %s", what, k, problem)
          if ok && strings.has_suffix(name, IK_SWIVEL_NAME) do swivel_check(m, out, allocator, at, what, k, name)
          seen[name] = true
        }
        for name in mv.poses {
          if pose_find(a.poses[:], name) < 0 do issue(out, allocator, .ERROR, {kind = .MOVE, name = clip.name, item = name, index = n, move = k}, "%s move %d: adds pose %s, which the animation lacks", what, k, name)
          seen[name] = true
        }
        for name, arc in mv.arcs {
          if _, _, problem := arc_resolve(cs, a, name, arc); problem != "" do issue(out, allocator, .ERROR, {kind = .MOVE, name = clip.name, item = name, index = n, move = k}, "%s move %d: %s", what, k, problem)
          seen[name] = true
        }
      }
      for name in seen do motions[name] += 1
    }
    for name, count in motions do if count > MOTION_BUDGET do issue(out, allocator, .BUDGET, {kind = .CLIP, name = clip.name, item = name}, "clip %s: %s is in %d motions (over %d): a pose or a spread instead?", clip.name, name, count, MOTION_BUDGET)
  }
}

// swivel_check: an aiming IK has no bend, so no swivel to turn.
@(private = "file")
swivel_check :: proc(m: ^Model, out: ^[dynamic]Issue, allocator: mem.Allocator, at: Path, what: string, move: int, name: string) {
  for ik in m.iks do if ik.aim && name == fmt.tprint(ik.name, IK_SWIVEL_NAME, sep = "") {
    issue(out, allocator, .ERROR, at, "%s move %d: %s swivels an aim, which has no bend", what, move, name)
  }
}
