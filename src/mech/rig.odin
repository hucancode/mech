package mech

import "core:fmt"
import "core:log"
import "core:math"
import "core:math/linalg"
import "core:slice"
import "../mjolnir/geometry"
import "../mjolnir/render"
import "../mjolnir/world"

// A Rig is a Model in a scene: a bone per moving joint and a node per piece. Bones are flat
// children of the rig's `frame` node (scaled by the model's scale); pieces are children of their
// bone, so posing writes one transform per bone and none per piece.
//
// rig_pose takes one value per model channel (its drivers, then the root's) and solves, in order: each bone's motion from the
// drives, then IK, then each bone from its parent.

// Bone is one per moving joint (and an anchor at the origin per root), at the joint's pivot:
// `offset` and `rest` on its parent, then moved by its drives, then turned about the axes in
// `turns` by IK, its turns held within `lo`..`hi` (its joint's range, turned over where a mirror
// turns the axis over; an axis whose ends are equal is free).
Bone :: struct {
  parent: int,
  offset: [3]f32,
  rest:   quaternion128,
  turns:  bit_set[Axis],
  lo, hi: [3]f32,
  part:   int, // the instance whose joint it is
  joint:  int, // which of the joints the instance exposes (instance_joints); -1: a root's anchor
  node:   world.NodeHandle,
}

// Motion is a bone's move from its rest: turns about x, y, z (R = Rx * Ry * Rz).
Motion :: struct {
  turn: [3]f32,
}

// Piece is one drawn primitive: shape `shape` of instance `part`'s part, or joint hardware (-1).
Piece :: struct {
  bone:      int,
  part:      int,
  shape:     int,
  primitive: Primitive,
  place:     geometry.Transform, // on its bone, scale included
  node:      world.NodeHandle,
}

// RigDrive is a Drive resolved: driver `driver` moves bone `bone`, mirrored instances' `to`
// already turned over.
@(private)
RigDrive :: struct {
  bone, driver: int,
  axis:         Axis,
  from, to:     [2]f32,
  clamp:        bool,
}

// RigIk: the chain's bones are chains[first:][:count], root first, down to the tip's own; IK reaches
// with the first `turning`, and turns the tip's own (an ankle, a wrist) only to `hold` the tip
// facing as its drivers turned it, in the model's space. `tip` is the instance whose frame reaches; `drivers` are the target's x, y, z and the
// weight, `pole` its pole's x, y, z (-1: it has none).
@(private)
RigIk :: struct {
  first, count, turning, tip: int,
  drivers:                    [4]int,
  pole:                       [3]int,
  hold:                       bool,
}

Rig :: struct {
  model:   ^Model,
  frame:   world.NodeHandle,
  bones:   [dynamic]Bone,
  pieces:  [dynamic]Piece,
  frames:  [dynamic]Frame, // per instance: where its part's shapes and slots sit
  bases:   [dynamic]int, // per instance: the bone its joints hang from
  poses:   [dynamic]geometry.Transform, // per bone, in the frame node's space, from the last pose
  motion:  [dynamic]Motion, // per bone, from the last pose, IK included
  values:  [dynamic]f32, // the drivers the last pose showed
  drives:  [dynamic]RigDrive,
  iks:     [dynamic]RigIk,
  chains:  [dynamic]int,
  lift:    f32,
  origin:  geometry.Transform, // the model's origin by the last pose: the root's channels, lifted
}

// Builder carries what joint_build and rig_create share while they add bones and pieces.
@(private)
Builder :: struct {
  rig:       ^Rig,
  w:         ^world.World,
  r:         ^render.Renderer,
  lib:       ^Library,
  hardware:  [Role]render.MaterialHandle,
  part:      int, // the instance being built
  joint:     int, // the joint of it being built, -1 for none
  materials: []render.MaterialHandle,
}

// rig_create builds `m` under `parent`, sharing meshes and materials through `lib`. The rig keeps a
// pointer to the model, which must outlive it.
rig_create :: proc(lib: ^Library, w: ^world.World, r: ^render.Renderer, m: ^Model, parent: world.NodeHandle) -> (rig: ^Rig, ok: bool) {
  rig = new(Rig)
  rig.model = m
  rig.frame = world.spawn(w, scale = m.scale, parent = parent)
  b := Builder{rig = rig, w = w, r = r, lib = lib}
  b.materials = make([]render.MaterialHandle, max(1, len(m.materials)), context.temp_allocator)
  if len(m.materials) == 0 {
    b.materials[0] = library_material(lib, r, {color = 0.7, roughness = 0.5}) or_return
  }
  for mat, i in m.materials do b.materials[i] = library_material(lib, r, mat) or_return
  paint :: proc(b: ^Builder, name: string) -> render.MaterialHandle {
    return b.materials[max(model_material(b.rig.model, name), 0)]
  }
  b.hardware = {
    .FEMALE = paint(&b, m.hardware.female),
    .MALE   = paint(&b, m.hardware.male),
    .METAL  = paint(&b, m.hardware.metal),
  }

  // per instance, its last joint's mirror: how its part's shapes and slots show
  mirrors := make([]Mirror, len(m.assembly), context.temp_allocator)
  // every joint of every instance as built, instance i's from firsts[i], each with its own mirror
  Placed :: struct {
    bone:   int,
    joint:  Joint,
    mirror: Mirror,
  }
  placed := make([dynamic]Placed, context.temp_allocator)
  firsts := make([]int, len(m.assembly), context.temp_allocator)
  hangs := make([]int, len(m.assembly), context.temp_allocator) // the slot each hangs from
  for inst, i in m.assembly {
    b.part, b.joint = i, -1
    parent := model_instance(m, inst.parent) if inst.parent != "" else -1
    if parent >= i {
      log.warnf("model %s: %s comes before its parent %s; placed at the root", m.name, inst.name, inst.parent)
      parent = -1
    }
    part := model_part(m, inst.part)
    if part < 0 && inst.part != "" do log.warnf("model %s: %s places unknown part %s", m.name, inst.name, inst.part)
    // the parent's slot, as the parent shows it; a root matches the model origin, on an anchor bone
    frame := rig.frames[parent] if parent >= 0 else Frame{add_bone(&b, -1, {}, linalg.QUATERNIONF32_IDENTITY, {}), geometry.TRANSFORM_IDENTITY}
    append(&rig.bases, frame.bone)
    socket := SLOT_FACE
    if inst.parent_slot != "" {
      pp := model_part(m, m.assembly[parent].part) if parent >= 0 else -1
      if k := part_slot(m, pp, inst.parent_slot); k >= 0 do socket = slot_face(m.parts[pp].slots[k])
      else do log.warnf("model %s: %s matches unknown slot %s of %s", m.name, inst.name, inst.parent_slot, inst.parent)
    }
    if parent >= 0 && m.assembly[parent].mirror do socket = mirror_face(mirrors[parent], socket)
    // its own slot (the default: its origin), and the joints it exposes; none bolts the part on
    // rigid, as a FIXED joint
    own := PART_FACE
    hangs[i] = part_slot(m, part, inst.slot)
    stack := instance_joints(m, i)
    if hangs[i] >= 0 do own = slot_face(m.parts[part].slots[hangs[i]])
    else if inst.slot != "" do log.warnf("model %s: %s hangs from unknown slot %s of %s", m.name, inst.name, inst.slot, inst.part)
    if len(stack) == 0 do stack = {{}}
    firsts[i] = len(placed)
    mi := MIRROR_NONE
    for unscaled, k in stack {
      j := joint_scaled(unscaled)
      b.joint = k
      if k > 0 do socket = mirror_face(mi, SLOT_FACE) if inst.mirror else SLOT_FACE
      // a twist reflected turns the other way
      socket = twist_face(socket, -j.twist if inst.mirror else j.twist)
      frame = joint_build(&b, frame, socket, j)
      if inst.mirror do mi = joint_mirror(j)
      append(&placed, Placed{frame.bone, j, mi})
      // its range, on the bone it moves (a FIXED joint has none of its own)
      if _, count := joint_dofs(j); count > 0 do bone_limit(&rig.bones[frame.bone], j, mi)
    }
    // the part's slot onto the last joint's male half
    hang := geometry.seat(SLOT_FACE, own)
    frame.place = geometry.transform_mul(frame.place, hang)
    mirrors[i] = mirror_moved(mi, hang) if inst.mirror else MIRROR_NONE
    append(&rig.frames, frame)
    if part < 0 do continue
    for s, k in m.parts[part].shapes {
      for name in s.span do if _, known := part_point(m.parts[part], name); !known do log.warnf("model %s: a shape of part %s spans unknown slot %s", m.name, inst.part, name)
      at, turn, size := shape_place(m.parts[part], s)
      place := geometry.Transform{at, turn, primitive_scale(s.primitive, size)}
      if inst.mirror do place = mirror_shape(mirrors[i], place, s.primitive)
      add_piece(&b, frame.bone, geometry.transform_mul(frame.place, place), s.primitive, s.param, paint(&b, s.material), k)
    }
  }

  resize(&rig.values, model_channels(m))
  for d, di in m.drivers {
    for dr in d.drives {
      // the joint, among those the slot its instance hangs from exposes
      inst := model_instance(m, dr.part)
      k := -1
      if inst >= 0 do for j, n in instance_joints(m, inst) do if j.name == dr.joint do k = n
      if k < 0 {
        log.warnf("model %s: driver %s moves joint %s, which %s's slot does not expose", m.name, d.name, dr.joint, dr.part)
        continue
      }
      p := placed[firsts[inst] + k]
      dofs, count := joint_dofs(p.joint)
      has := false
      for x in dofs[:count] do has ||= x.axis == dr.axis
      if !has {
        log.warnf("model %s: driver %s moves joint %s of %s about %v, which it does not have", m.name, d.name, dr.joint, dr.part, dr.axis)
        continue
      }
      append(&rig.drives, RigDrive{p.bone, di, dr.axis, dr.from, -dr.to if p.mirror.turn[dr.axis] else dr.to, dr.clamp})
    }
  }
  for ik in m.iks do ik_add(rig, ik)

  // the lowest point at rest
  rest := make([]f32, model_channels(m), context.temp_allocator)
  rig_solve(rig, rest)
  if m.ground {
    low := f32(math.F32_MAX)
    for p in rig.pieces {
      x := geometry.transform_mul(rig.poses[p.bone], p.place)
      for c in primitive_corners(p.primitive) do low = min(low, geometry.transform_point(x, c).y)
    }
    if len(rig.pieces) > 0 do rig.lift = -low
  }
  rig_pose(w, rig, rest)
  return rig, true
}


rig_destroy :: proc(rig: ^Rig, w: ^world.World) {
  world.node_destroy(w, rig.frame)
  delete(rig.bones)
  delete(rig.pieces)
  delete(rig.frames)
  delete(rig.bases)
  delete(rig.poses)
  delete(rig.values)
  delete(rig.drives)
  delete(rig.motion)
  delete(rig.iks)
  delete(rig.chains)
  free(rig)
}

// rig_pose shows `values`, one per model channel (model_channels).
rig_pose :: proc(w: ^world.World, rig: ^Rig, values: []f32) {
  rig_solve(rig, values)
  for bone, i in rig.bones do world.transform(w, bone.node)^ = {rig.poses[i].position, rig.poses[i].rotation, 1}
}

// rig_solve is rig_pose without touching the scene: it solves `values` into rig.values and
// rig.poses (every bone), for queries that ask where things would be at some other time. The next
// rig_pose shows the rig again.
rig_solve :: proc(rig: ^Rig, values: []f32) {
  s := rig.values[:]
  copy(s, values)
  resize(&rig.motion, len(rig.bones))
  for &mo in rig.motion do mo = {}
  for d in rig.drives {
    t := (s[d.driver] - d.from[0]) / (d.from[1] - d.from[0]) if d.from[1] != d.from[0] else 0
    if d.clamp do t = clamp(t, 0, 1)
    x := math.lerp(d.to[0], d.to[1], t)
    rig.motion[d.bone].turn[d.axis] += x
  }
  for b, i in rig.bones do rig.motion[i] = limit(b, rig.motion[i])
  // the root's channels, after the drivers, place the model's origin
  root := s[len(rig.model.drivers):][:len(ROOT_CHANNELS)]
  origin := geometry.Transform{{root[0], root[1] + rig.lift, root[2]}, euler({root[3], root[4], root[5]}), 1}
  rig.origin = origin
  solve(rig, origin)
  for ik in rig.iks {
    weight := clamp(s[ik.drivers[3]], 0, 1)
    if weight <= 0 do continue
    pole: Maybe([3]f32)
    if ik.pole[0] >= 0 do pole = [3]f32{s[ik.pole[0]], s[ik.pole[1]], s[ik.pole[2]]}
    reach(rig, ik, {s[ik.drivers[0]], s[ik.drivers[1]], s[ik.drivers[2]]}, pole, weight, origin)
    solve(rig, origin)
  }
}

// rig_piece is where piece `i` was drawn by the last pose, in the frame node's space.
rig_piece :: proc(rig: ^Rig, i: int) -> geometry.Transform {
  p := rig.pieces[i]
  return geometry.transform_mul(rig.poses[p.bone], p.place)
}

// rig_bounds is the box around every piece as last posed, in the rig's parent's space (the
// model's scale applied): for framing a camera.
rig_bounds :: proc(rig: ^Rig) -> (lo, hi: [3]f32) {
  lo, hi = math.F32_MAX, -math.F32_MAX
  for p, i in rig.pieces {
    x := rig_piece(rig, i)
    for c in primitive_corners(p.primitive) {
      q := geometry.transform_point(x, c)
      lo, hi = linalg.min(lo, q), linalg.max(hi, q)
    }
  }
  if len(rig.pieces) == 0 do return {}, {}
  return lo * rig.model.scale, hi * rig.model.scale
}

// rig_moves is which of a pose's values (model_channels) move instance `inst`: the drives on the
// bones its frame rides on (its own joints' and every parent's), the drivers of every IK whose chain has one of
// them, and the root's channels.
rig_moves :: proc(rig: ^Rig, inst: int, allocator := context.allocator) -> []bool {
  m := rig.model
  out := make([]bool, model_channels(m), allocator)
  above := make([]bool, len(rig.bones), context.temp_allocator)
  for b := rig.frames[inst].bone; b >= 0; b = rig.bones[b].parent do above[b] = true
  for d in rig.drives do if above[d.bone] do out[d.driver] = true
  for ik in rig.iks {
    moves := false
    for c in rig.chains[ik.first:][:ik.count] do moves ||= above[c]
    if !moves do continue
    for d in ik.drivers do if d >= 0 do out[d] = true
    for d in ik.pole do if d >= 0 do out[d] = true
  }
  for k in 0 ..< len(ROOT_CHANNELS) do out[len(m.drivers) + k] = true
  return out
}

// rig_bone_base is where bone `i` was by the last pose before its own motion: the frame its
// joint's axes are in (on its parent, by its rest), for drawing them.
rig_bone_base :: proc(rig: ^Rig, i: int) -> geometry.Transform {
  x, mo := rig.poses[i], rig.motion[i]
  turn := linalg.normalize(x.rotation * linalg.quaternion_inverse(euler(mo.turn)))
  return {x.position, turn, 1}
}

// rig_frame is where instance `i`'s frame was by the last pose, in the frame node's space.
rig_frame :: proc(rig: ^Rig, i: int) -> geometry.Transform {
  f := rig.frames[i]
  return geometry.transform_mul(rig.poses[f.bone], f.place)
}

@(private = "file")
solve :: proc(rig: ^Rig, origin: geometry.Transform) {
  resize(&rig.poses, len(rig.bones))
  for _, i in rig.bones do pose_bone(rig, i, origin)
}

// pose_bone places bone i on its parent's pose by its motion.
@(private = "file")
pose_bone :: proc(rig: ^Rig, i: int, origin: geometry.Transform) {
  b := rig.bones[i]
  mo := rig.motion[i]
  position, rotation := origin.position, origin.rotation
  if b.parent >= 0 do position, rotation = rig.poses[b.parent].position, rig.poses[b.parent].rotation
  position += linalg.mul(rotation, b.offset)
  rotation *= b.rest
  rotation *= turn(mo)
  rig.poses[i] = {position, linalg.normalize(rotation), 1}
}

// turn is a motion's turn, about x, then y, then z, each about the already turned axes.
@(private = "file")
turn :: proc(mo: Motion) -> quaternion128 {
  return euler(mo.turn)
}

// ik_add finds an Ik's chain: the bones from the tip's last joint up to the root's first, the root
// above the tip.
@(private = "file")
ik_add :: proc(rig: ^Rig, ik: Ik) {
  m := rig.model
  root, tip := model_instance(m, ik.root), model_instance(m, ik.tip)
  out := RigIk{first = len(rig.chains), tip = tip, pole = -1, hold = ik.hold}
  for name, k in ([4]string{"_x", "_y", "_z", "_weight"}) {
    out.drivers[k] = model_driver(m, fmt.tprint(ik.name, name, sep = ""))
    if out.drivers[k] < 0 {
      log.warnf("model %s: ik %s has no driver %s%s", m.name, ik.name, ik.name, name)
      return
    }
  }
  // its pole, when it has all three of the pole's drivers
  pole: [3]int
  for name, k in ([3]string{"_pole_x", "_pole_y", "_pole_z"}) do pole[k] = model_driver(m, fmt.tprint(ik.name, name, sep = ""))
  if pole[0] >= 0 && pole[1] >= 0 && pole[2] >= 0 do out.pole = pole
  else if pole[0] >= 0 || pole[1] >= 0 || pole[2] >= 0 do log.warnf("model %s: ik %s has some of its pole's drivers but not all three", m.name, ik.name)
  if root < 0 || tip < 0 {
    log.warnf("model %s: ik %s names an unknown instance", m.name, ik.name)
    return
  }
  base := rig.bases[root]
  for bone := rig.frames[tip].bone; bone >= 0; bone = rig.bones[bone].parent {
    if bone == base {
      out.count = len(rig.chains) - out.first
      slice.reverse(rig.chains[out.first:])
      // the tip's own joints (an ankle, a wrist) only turn it where it is: IK turns those above
      out.turning = out.count
      for c, k in rig.chains[out.first:][:out.count] do if c == rig.bases[tip] do out.turning = k + 1
      append(&rig.iks, out)
      return
    }
    append(&rig.chains, bone)
  }
  resize(&rig.chains, out.first)
  log.warnf("model %s: ik %s: %s is not above %s", m.name, ik.name, ik.root, ik.tip)
}

// reach turns the chain's bones toward `target` by cyclic coordinate descent, each about the axes
// it turns, then blends the result with the motion the drives gave by `weight`. With a `pole`, each
// pass first swings the chain's middle joint (the knee, the elbow: the pivot halfway along it),
// with the joints above it, to where it must be for the tip to reach: as for two segments, off the
// line from the joint above it to the target, toward the pole. The chain then bends in the plane
// through the pole, and by as much as the target needs, even from straight.
@(private = "file")
reach :: proc(rig: ^Rig, ik: RigIk, target: [3]f32, pole: Maybe([3]f32), weight: f32, origin: geometry.Transform) {
  ITERATIONS :: 16
  chain := rig.chains[ik.first:][:ik.count]
  from := make([]Motion, len(chain), context.temp_allocator)
  for bone, k in chain do from[k] = rig.motion[bone]
  // held, the tip faces as the drives turned it, in the model's space: a planted foot stays as the
  // clip angles it however the knee bends
  keep := rig_frame(rig, ik.tip).rotation
  mid := -1
  if _, has := pole.?; has do mid = chain_middle(rig, ik, origin)
  for _ in 0 ..< ITERATIONS {
    // the tip's own joints turn it back to face as it did (first: reaching has the last word)
    if ik.hold do for k in ik.turning ..< ik.count {
      for axis in Axis {
        if axis not_in rig.bones[chain[k]].turns do continue
        for e in ([2][3]f32{{0, 1, 0}, {0, 0, 1}}) {
          for c in chain[k:] do pose_bone(rig, c, origin)
          x := rig_frame(rig, ik.tip)
          turn_toward(rig, chain[k], axis, x.position + linalg.mul(x.rotation, e), x.position + linalg.mul(keep, e))
        }
      }
    }
    // with a pole: where the middle goes, and the joints above it put it there
    placed := false
    if p, has := pole.?; has && mid > 0 {
      for k := mid - 1; k >= 0; k -= 1 {
        for axis in Axis {
          if axis not_in rig.bones[chain[k]].turns do continue
          for c in chain[k:] do pose_bone(rig, c, origin)
          if want, ok := middle_place(rig, ik, chain, mid, target, p); ok do turn_toward(rig, chain[k], axis, rig.poses[chain[mid]].position, want)
        }
      }
      // pinned only when it got there (its joints' stops may not let it)
      for c in chain[:mid + 1] do pose_bone(rig, c, origin)
      if want, ok := middle_place(rig, ik, chain, mid, target, p); ok do placed = linalg.length(rig.poses[chain[mid]].position - want) < 0.02
    }
    for k := ik.turning - 1; k >= 0; k -= 1 {
      for axis in Axis {
        if axis not_in rig.bones[chain[k]].turns do continue
        for c in chain[k:] do pose_bone(rig, c, origin)
        was, at := rig.motion[chain[k]], rig.poses[chain[mid]].position if mid >= 0 else 0
        turn_toward(rig, chain[k], axis, rig_frame(rig, ik.tip).position, target)
        // above the middle, only a turn that keeps the middle where the pole put it (a thigh's
        // twist, about the line through the knee)
        if placed && k < mid {
          for c in chain[k:mid + 1] do pose_bone(rig, c, origin)
          if linalg.length(rig.poses[chain[mid]].position - at) > 0.01 do rig.motion[chain[k]] = was
        }
      }
    }
  }
  for bone, k in chain {
    mo := &rig.motion[bone]
    mo.turn = linalg.lerp(from[k].turn, mo.turn, weight)
  }
}

// middle_place is where the middle joint of IK ik's chain must be for its tip to reach `target`, its
// two segments (the joint above it to it, it to the tip) as long as they are: off the line from the
// joint above it to the target, toward `pole`. ok is false when the pole is on that line.
@(private = "file")
middle_place :: proc(rig: ^Rig, ik: RigIk, chain: []int, mid: int, target, pole: [3]f32) -> (want: [3]f32, ok: bool) {
  r := rig.poses[chain[mid - 1]].position
  at := rig.poses[chain[mid]].position
  la, lb := linalg.length(at - r), linalg.length(rig_frame(rig, ik.tip).position - at)
  d := linalg.length(target - r)
  if d < 1e-5 do return
  line := (target - r) / d
  toward := (pole - r) - linalg.dot(pole - r, line) * line
  if linalg.length2(toward) < 1e-10 do return
  x := clamp((la * la - lb * lb + d * d) / (2 * d), -la, la) if d < la + lb else la
  return r + line * x + linalg.normalize(toward) * math.sqrt(max(0, la * la - x * x)), true
}

// turn_toward turns bone `bone` about its axis `axis` (as posed) as far as it takes point `at`
// toward `want`, within its range.
@(private = "file")
turn_toward :: proc(rig: ^Rig, bone: int, axis: Axis, at, want: [3]f32) {
  pivot := rig.poses[bone].position
  // the axis as it is turned so far: x by nothing, y by x, z by x and y
  mo := rig.motion[bone]
  base := rig.poses[bone].rotation * linalg.quaternion_inverse(turn(mo))
  partial: Motion
  if axis >= .Y do partial.turn.x = mo.turn.x
  if axis >= .Z do partial.turn.y = mo.turn.y
  e: [3]f32
  e[axis] = 1
  n := linalg.mul(base * turn(partial), e)
  u, v := at - pivot, want - pivot
  u -= linalg.dot(u, n) * n
  v -= linalg.dot(v, n) * n
  if linalg.length2(u) < 1e-10 || linalg.length2(v) < 1e-10 do return
  rig.motion[bone].turn[axis] += math.atan2(linalg.dot(n, linalg.cross(u, v)), linalg.dot(u, v))
  rig.motion[bone] = limit(rig.bones[bone], rig.motion[bone])
}

// chain_middle is the index in IK ik's chain of the joint that bends it nearest halfway along it,
// from its root's pivot through each pivot to the tip (not the root itself): the knee of a leg, the
// elbow of an arm. A joint bends the chain when it turns about an axis across the line from it to
// the tip (a twist along the limb doesn't); -1 when none does.
@(private = "file")
chain_middle :: proc(rig: ^Rig, ik: RigIk, origin: geometry.Transform) -> int {
  chain := rig.chains[ik.first:][:ik.turning]
  for c in rig.chains[ik.first:][:ik.count] do pose_bone(rig, c, origin)
  tip := rig_frame(rig, ik.tip).position
  along := make([]f32, len(chain) + 1, context.temp_allocator)
  for k in 1 ..< len(chain) do along[k] = along[k - 1] + linalg.length(rig.poses[chain[k]].position - rig.poses[chain[k - 1]].position)
  along[len(chain)] = along[len(chain) - 1] + linalg.length(tip - rig.poses[chain[len(chain) - 1]].position)
  half := along[len(chain)] / 2
  best := -1
  for k in 1 ..< len(chain) {
    b := rig.bones[chain[k]]
    to := linalg.normalize0(tip - rig.poses[chain[k]].position)
    bends := false
    for axis in b.turns {
      e: [3]f32
      e[axis] = 1
      bends ||= abs(linalg.dot(linalg.mul(rig.poses[chain[k]].rotation, e), to)) < 0.7
    }
    if bends && (best < 0 || abs(along[k] - half) < abs(along[best] - half)) do best = k
  }
  return best
}

// bone_limit gives a joint's bone its range, each axis turned over (and its ends swapped) where the
// joint's mirror turns drives on it over.
@(private)
bone_limit :: proc(b: ^Bone, j: Joint, mi: Mirror) {
  for k in Axis {
    lo, hi := j.min[k], j.max[k]
    if mi.turn[k] do lo, hi = -hi, -lo
    b.lo[k], b.hi[k] = lo, hi
  }
}

// limit is motion `mo` held within bone b's range.
@(private)
limit :: proc(b: Bone, mo: Motion) -> Motion {
  out := mo
  for k in 0 ..< 3 {
    if b.lo[k] != b.hi[k] do out.turn[k] = clamp(out.turn[k], b.lo[k], b.hi[k])
  }
  return out
}

@(private)
add_bone :: proc(b: ^Builder, parent: int, offset: [3]f32, rest: quaternion128, turns: bit_set[Axis]) -> int {
  append(&b.rig.bones, Bone{parent = parent, offset = offset, rest = rest, turns = turns, part = b.part, joint = b.joint, node = world.spawn(b.w, parent = b.rig.frame)})
  return len(b.rig.bones) - 1
}

@(private)
add_piece :: proc(b: ^Builder, bone: int, place: geometry.Transform, p: Primitive, param: f32, material: render.MaterialHandle, shape: int) {
  node := world.spawn(b.w, parent = b.rig.bones[bone].node)
  world.transform(b.w, node)^ = place
  if mesh, ok := library_mesh(b.lib, b.r, p, param); ok do render.attach(b.r, node, render.MeshAttachment{mesh = mesh, material = material})
  append(&b.rig.pieces, Piece{bone, b.part, shape, p, place, node})
}
