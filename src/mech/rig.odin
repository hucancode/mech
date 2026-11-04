package mech

import "core:fmt"
import "core:math"
import "core:math/linalg"
import "core:slice"
import "../mjolnir/geometry"
import "../mjolnir/render"
import "../mjolnir/world"

// A Rig is a Model in a scene: a bone per joint and a node per piece. Bones are flat
// children of the rig's `frame` node (scaled by the model's scale); pieces are children of their
// bone, so posing writes one transform per bone and none per piece.
//
// rig_pose takes a pose's values (model_channel_table) and solves, in order: each bone's motion from the
// drives, then IK, then each bone from its parent.

// Bone is one per joint (and an anchor at the origin per root), at the joint's pivot:
// `offset` and `rest` on its parent, then moved by its drives (turned, or a linear actuator's slid
// out along its -y), then turned about the axes in `turns` by IK, its turns held within `lo`..`hi`
// (its joint's range, turned over where a mirror turns the axis over; an axis whose ends are equal
// is free) and its slide within `stroke`.
Bone :: struct {
  parent: int,
  offset: [3]f32,
  rest:   quaternion128,
  turns:  bit_set[Axis],
  lo, hi: [3]f32,
  stroke: [2]f32, // a linear actuator's: how far it slides out, its min and max (equal: free)
  part:   int, // the instance whose joint it is
  joint:  int, // which of its place's joints (place_joints); -1: a root's anchor
  node:   world.NodeHandle,
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

// RigDrive is a joint's value `channel` (a pose's) turning bone `bone` about `axis`, a radian a
// unit, `turn` -1 where a mirrored instance turns it over; or, `slide`, sliding it out (a model
// unit a unit).
@(private)
RigDrive :: struct {
  bone, channel: int,
  axis:          Axis,
  turn:          f32,
  slide:         bool,
}

// RigIk: the chain's bones are chains[first:][:count], root first, down to the tip's own; IK reaches
// with the first `turning`; when it `holds` (its end stands on the ground at rest: a foot), it turns
// the tip's own joints (an ankle) only to hold the tip facing as its channels turned it, in the
// model's space; otherwise (a hand, a gun) they keep their channels' turns. `tip` is the instance that reaches, with
// its end (`point`, in its frame: ik_point); `channel` is the first of its values (IK_VALUES),
// its target an offset from `rest`, where that end is at rest (in the frame node's space, lifted). `mid` is the chain's
// middle joint (chain_middle; -1 for none), which bends toward a pole (ik_pole): `bend` is the way
// its stops let it bend at rest, in the model's space, `line` the way from the joint above the
// middle one to the tip at rest, and `length` the chain's, root to tip.
// An aiming one (`aim`) turns its whole chain so the tip's `look` (a direction in its frame: ahead
// at rest) points at the target, `rest` then being a point ahead of the tip.
RigIk :: struct {
  first, count, turning, tip: int,
  channel:                    int,
  aim, holds:                 bool,
  mid:                        int,
  rest, bend, look, line:     [3]f32,
  point:                      [3]f32,
  length:                     f32,
}

Rig :: struct {
  model:   ^Model,
  frame:   world.NodeHandle,
  bones:   [dynamic]Bone,
  pieces:  [dynamic]Piece,
  places:  [dynamic]Place, // what the model places (model_places): bones, pieces and frames are of these
  frames:  [dynamic]Frame, // per place: where its part's shapes and slots sit
  poses:   [dynamic]geometry.Transform, // per bone, in the frame node's space, from the last pose
  motion:  [dynamic][3]f32, // per bone, its turns from rest about x, y, z (euler), IK included
  slide:   [dynamic]f32, // per bone, how far it slid out (a linear actuator's), model units
  values:  [dynamic]f32, // the values the last pose showed
  drives:  [dynamic]RigDrive,
  iks:     [dynamic]RigIk,
  chains:  [dynamic]int,
  lift:    f32,
}

// Builder carries what joint_build and rig_create share while they add bones and pieces.
@(private)
Builder :: struct {
  rig:       ^Rig,
  w:         ^world.World,
  r:         ^render.Renderer,
  lib:       ^Library,
  hardware:  [Role]render.MaterialHandle,
  part:      int, // the place being built
  joint:     int, // the joint of it being built, -1 for none
  materials: []render.MaterialHandle,
}

// rig_create builds `m` under `parent`, sharing meshes and materials through `lib`. The rig keeps a
// pointer to the model, which must outlive it. With no renderer (`r` nil) the rig poses but draws
// nothing: for tests and tools that only ask where things are.
rig_create :: proc(lib: ^Library, w: ^world.World, r: ^render.Renderer, m: ^Model, parent: world.NodeHandle) -> (rig: ^Rig, ok: bool) {
  rig = new(Rig)
  rig.model = m
  rig.frame = world.spawn(w, scale = m.scale, parent = parent)
  b := Builder{rig = rig, w = w, r = r, lib = lib}
  b.materials = make([]render.MaterialHandle, max(1, len(m.materials)), context.temp_allocator)
  if r != nil {
    if len(m.materials) == 0 do b.materials[0] = library_material(lib, r, {color = 0.7, roughness = 0.5}) or_return
    for mat, i in m.materials do b.materials[i] = library_material(lib, r, mat) or_return
  }
  paint :: proc(b: ^Builder, name: string) -> render.MaterialHandle {
    return b.materials[max(model_material(b.rig.model, name), 0)]
  }
  b.hardware = {
    .FEMALE = paint(&b, m.hardware.female),
    .MALE   = paint(&b, m.hardware.male),
    .METAL  = paint(&b, m.hardware.metal),
  }

  places := model_places(m)
  append(&rig.places, ..places)
  // per place, its last joint's mirror: how its part's shapes and slots show
  mirrors := make([]Mirror, len(places), context.temp_allocator)
  resize(&rig.values, model_channels(m))
  // each joint's channel, its values moving its bone, in the order of the pose
  ch := root_channel(m) + ROOT_VALUES
  for place, i in places {
    inst := m.assembly[place.inst]
    b.part, b.joint = i, -1
    // what character_check reports is skipped: an unknown parent places it at the root, an unknown
    // part or slot is none
    parent := place.parent
    part := model_part(m, inst.part)
    // the parent's slot, as the parent shows it; a root matches the model origin, on an anchor bone
    frame := rig.frames[parent] if parent >= 0 else Frame{add_bone(&b, -1, {}, linalg.QUATERNIONF32_IDENTITY, {}), geometry.TRANSFORM_IDENTITY}
    socket := SLOT_FACE
    if inst.parent_slot != "" && parent >= 0 {
      pp := model_part(m, m.assembly[places[parent].inst].part)
      if k := part_slot(m, pp, inst.parent_slot); k >= 0 do socket = slot_face(m.parts[pp].slots[k])
    }
    switch {
    case parent >= 0 && places[parent].side == .R:
      // on a reflected side: its parent's slots are reflected with it
      socket = mirror_face(mirrors[parent], socket)
    case place.side == .R:
      // the reflected side of a mirrored slot, across its plane of the parent's frame
      pp := model_part(m, m.assembly[places[parent].inst].part)
      socket = mirror_face(plane_mirror(m.parts[pp].slots[part_slot(m, pp, inst.parent_slot)].mirror), socket)
    }
    // its part's joints; none bolts the part straight onto the socket, rigid
    mirrored := place.side == .R
    stack := place_joints(m, place)
    mi := MIRROR_NONE
    if len(stack) == 0 {
      frame = {frame.bone, geometry.transform_mul(frame.place, geometry.seat(socket, PART_FACE))}
      if mirrored do mi = face_mirror(SLOT_FACE.forward, SLOT_FACE)
    }
    for j, k in stack {
      b.joint = k
      // how the instance mounts it: its twist turns its socket (reflected, the other way)
      twist := instance_twist(inst, j.name)
      if k > 0 do socket = mirror_face(mi, SLOT_FACE) if mirrored else SLOT_FACE
      socket = twist_face(socket, -twist if mirrored else twist)
      // a pin hinge's base plates are round where a turntable next to it in the stack turns them
      round := [2]bool{k > 0 && stack[k - 1].kind == .SPIN, k + 1 < len(stack) && stack[k + 1].kind == .SPIN}
      frame = joint_build(&b, frame, socket, j, round)
      if mirrored do mi = joint_mirror(j)
      // its stops, on the bone it moves, and its channel's values driving it
      bone_limit(&rig.bones[frame.bone], j, mi)
      axes, count := joint_axes(j)
      for axis in axes[:count] {
        append(&rig.drives, RigDrive{frame.bone, ch, axis, -1 if mi.turn[axis] && j.kind != .LINEAR else 1, j.kind == .LINEAR})
        ch += 1
      }
    }
    // the part hangs on the last joint's male half (PART_FACE on SLOT_FACE: as it is), its
    // origin its length below
    if part >= 0 && m.parts[part].length != 0 {
      length := m.parts[part].length
      frame.place = geometry.transform_mul(frame.place, {{0, -length, 0}, linalg.QUATERNIONF32_IDENTITY, 1})
      mi = mirror_shift(mi, length)
    }
    mirrors[i] = mi if mirrored else MIRROR_NONE
    append(&rig.frames, frame)
    if part < 0 do continue
    for s, k in m.parts[part].shapes {
      at, turn, size := shape_place(m.parts[part], s)
      // as written, and a mirrored shape again across its plane
      for copy in 0 ..= (0 if s.mirror == .NONE else 1) {
        place := geometry.Transform{at, turn, primitive_scale(s.primitive, size)}
        if copy == 1 do place = mirror_shape(plane_mirror(s.mirror), place, s.primitive)
        if mirrored do place = mirror_shape(mirrors[i], place, s.primitive)
        add_piece(&b, frame.bone, geometry.transform_mul(frame.place, place), s.primitive, s.param, paint(&b, s.material), k)
      }
    }
  }

  for k, n in model_ik_places(m, places) do ik_add(rig, k, n)

  // the lowest point at rest, and where each IK's tip and pole are then: the stance, the rest
  // pose's joints (Model.pose), its IK targets let go and the root at the origin
  rest := model_pose(m, context.temp_allocator)
  for k in 0 ..< ik_count(m) do rest[ik_channel(m, k) + IK_WEIGHT] = 0
  for &v in rest[root_channel(m):][:ROOT_VALUES] do v = 0
  rig_solve(rig, rest)
  for &ik in rig.iks do ik_rest(rig, &ik)
  if m.ground {
    low := f32(math.F32_MAX)
    for p in rig.pieces {
      x := geometry.transform_mul(rig.poses[p.bone], p.place)
      for c in primitive_corners(p.primitive) do low = min(low, geometry.transform_point(x, c).y)
    }
    if len(rig.pieces) > 0 do rig.lift = -low
  }
  for &ik in rig.iks {
    ik.rest.y += rig.lift
    // a foot: its end stands on the ground at rest
    ik.holds = !ik.aim && m.ground && abs(ik.rest.y) < 0.05 * ik.length
  }
  rig_pose(w, rig, rest)
  return rig, true
}


rig_destroy :: proc(rig: ^Rig, w: ^world.World) {
  world.node_destroy(w, rig.frame)
  delete(rig.bones)
  delete(rig.pieces)
  delete(rig.places)
  delete(rig.frames)
  delete(rig.poses)
  delete(rig.values)
  delete(rig.drives)
  delete(rig.motion)
  delete(rig.slide)
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
  resize(&rig.slide, len(rig.bones))
  for &mo in rig.motion do mo = {}
  for &sl in rig.slide do sl = 0
  for d in rig.drives {
    v := s[d.channel]
    if d.slide do rig.slide[d.bone] += v
    else do rig.motion[d.bone][d.axis] += v * d.turn
  }
  for b, i in rig.bones {
    rig.motion[i] = limit(b, rig.motion[i])
    if b.stroke[0] != b.stroke[1] do rig.slide[i] = clamp(rig.slide[i], b.stroke[0], b.stroke[1])
  }
  origin := rig_origin(rig)
  solve(rig, origin)
  for ik in rig.iks {
    c := s[ik.channel:]
    weight := clamp(c[IK_WEIGHT], 0, 1)
    if weight <= 0 do continue
    if ik.aim do aim(rig, ik, ik.rest + {c[0], c[1], c[2]}, weight, origin)
    else {
      target := ik.rest + {c[0], c[1], c[2]}
      reach(rig, ik, target, ik_pole(rig, ik, target, c[IK_SWIVEL], origin), weight, origin)
    }
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

// rig_moves is which of a pose's values (model_channels) move place `inst` (Rig.places): the drives on the
// bones its frame rides on (its own joints' and every parent's), the
// channels of every IK whose chain has one of them, and the root's channels.
rig_moves :: proc(rig: ^Rig, inst: int, allocator := context.allocator) -> []bool {
  m := rig.model
  out := make([]bool, model_channels(m), allocator)
  above := make([]bool, len(rig.bones), context.temp_allocator)
  for b := rig.frames[inst].bone; b >= 0; b = rig.bones[b].parent do above[b] = true
  for d in rig.drives do if above[d.bone] do out[d.channel] = true
  for ik in rig.iks {
    moves := false
    for c in rig.chains[ik.first:][:ik.count] do moves ||= above[c]
    if moves do for &o in out[ik.channel:][:IK_VALUES] do o = true
  }
  for &o in out[root_channel(m):][:ROOT_VALUES] do o = true
  return out
}

// rig_bone_base is where bone `i` was by the last pose before its own motion: the frame its
// joint's axes are in (on its parent, by its rest), for drawing them.
rig_bone_base :: proc(rig: ^Rig, i: int) -> geometry.Transform {
  x, mo := rig.poses[i], rig.motion[i]
  at := x.position - linalg.mul(x.rotation, [3]f32{0, -rig.slide[i], 0})
  turn := linalg.normalize(x.rotation * linalg.quaternion_inverse(euler(mo)))
  return {at, turn, 1}
}

// rig_frame is where instance `i`'s frame was by the last pose, in the frame node's space.
rig_frame :: proc(rig: ^Rig, i: int) -> geometry.Transform {
  f := rig.frames[i]
  return geometry.transform_mul(rig.poses[f.bone], f.place)
}

// rig_origin is where the last pose put the model's origin: the root's channels, lifted.
rig_origin :: proc(rig: ^Rig) -> geometry.Transform {
  root := rig.values[root_channel(rig.model):][:ROOT_VALUES]
  return {{root[0], root[1] + rig.lift, root[2]}, euler({root[3], root[4], root[5]}), 1}
}

// instance_base is the bone place `i`'s joints hang from: its parent's frame's, or a root's anchor.
@(private = "file")
instance_base :: proc(rig: ^Rig, i: int) -> int {
  if parent := rig.places[i].parent; parent >= 0 do return rig.frames[parent].bone
  for b, k in rig.bones do if b.part == i && b.joint < 0 do return k
  return -1
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
  rotation *= euler(mo)
  // a linear actuator slides out, away from its socket (-y)
  if i < len(rig.slide) && rig.slide[i] != 0 do position += linalg.mul(rotation, [3]f32{0, -rig.slide[i], 0})
  rig.poses[i] = {position, linalg.normalize(rotation), 1}
}

// ik_add finds placed IK target `k`'s chain (the `n`th, model_ik_places): the bones from the tip's
// last joint up to its root's first (ik_root).
@(private = "file")
ik_add :: proc(rig: ^Rig, k: IkPlace, n: int) {
  m := rig.model
  ik := m.iks[k.ik]
  tip := k.tip
  if tip < 0 do return
  root := ik_root(rig.places[:], tip)
  out := RigIk{first = len(rig.chains), tip = tip, channel = ik_channel(m, n), aim = ik.aim}
  base := instance_base(rig, root)
  for bone := rig.frames[tip].bone; bone >= 0; bone = rig.bones[bone].parent {
    if bone == base {
      out.count = len(rig.chains) - out.first
      slice.reverse(rig.chains[out.first:])
      // the tip's own joints (an ankle, a wrist) only turn it where it is: IK turns those above
      out.turning = out.count
      if !ik.aim do for c, n in rig.chains[out.first:][:out.count] do if c == instance_base(rig, tip) do out.turning = n + 1
      append(&rig.iks, out)
      return
    }
    append(&rig.chains, bone)
  }
  resize(&rig.chains, out.first)
}

// ik_rest finds, from the rest pose (rig.poses, unlifted), where IK target ik's tip is, its chain's
// middle joint and length, and the way the middle joint bends: the way it is bent at rest (a
// strider's zigzag), or for a chain straight at rest, the side its stops let it (a knee forward, a
// hock back). So a chain bends the way it is built with no pole given.
@(private = "file")
ik_rest :: proc(rig: ^Rig, ik: ^RigIk) {
  if !ik.aim do ik.point = ik_end(rig, ik^)
  ik.rest = ik_point(rig, ik^)
  if ik.aim {
    // it looks ahead (+z) at rest, at a point as far ahead as it is high
    x := rig_frame(rig, ik.tip)
    ik.look = linalg.mul(linalg.quaternion_inverse(x.rotation), [3]f32{0, 0, 1})
    ik.rest += {0, 0, max(x.position.y, 1)}
    ik.mid = -1
    return
  }
  ik.mid = chain_middle(rig, ik^, rig_origin(rig))
  chain := rig.chains[ik.first:][:ik.count]
  ik.length = 0
  for k in 1 ..< len(chain) do ik.length += linalg.length(rig.poses[chain[k]].position - rig.poses[chain[k - 1]].position)
  ik.length += linalg.length(ik.rest - rig.poses[chain[len(chain) - 1]].position)
  if ik.mid < 0 do return
  bone := chain[ik.mid]
  b := rig.bones[bone]
  at := rig.poses[bone].position
  above := rig.poses[chain[ik.mid - 1]].position
  line := linalg.normalize0(ik.rest - above)
  ik.line = line
  off := (at - above) - linalg.dot(at - above, line) * line
  if linalg.length(off) > 1e-3 * ik.length {
    ik.bend = linalg.normalize(off)
    return
  }
  d := ik.rest - at
  for axis in b.turns {
    e: [3]f32
    e[axis] = 1
    a := linalg.mul(rig.poses[bone].rotation, e)
    if abs(linalg.dot(a, linalg.normalize0(d))) >= 0.7 do continue
    // turning about a by +θ swings the tip along a × d, and the joint itself out the other way
    side := f32(-1) if b.lo[axis] + b.hi[axis] < 0 else 1
    ik.bend = -side * linalg.normalize(linalg.cross(a, d))
    return
  }
}

// ik_end is where IK ik reaches with, in its tip's frame: the end of the tip, as far along its last
// link (from the joint above the tip's own toward the tip, at rest) as the tip's pieces and those of
// what hangs from it reach, on that line, so a chain straight at rest stays straight to its end. A
// foot reaches with its sole, not with the ankle at its base.
@(private = "file")
ik_end :: proc(rig: ^Rig, ik: RigIk) -> [3]f32 {
  m := rig.model
  x := rig_frame(rig, ik.tip)
  dir := linalg.normalize0(x.position - rig.poses[rig.chains[ik.first + max(ik.turning - 1, 0)]].position)
  far: f32 = 0
  for p, i in rig.pieces {
    below := false
    for j := p.part; j >= 0; j = rig.places[j].parent {
      if j == ik.tip do below = true
      if below do break
    }
    if !below do continue
    place := rig_piece(rig, i)
    for c in primitive_corners(p.primitive) do far = max(far, linalg.dot(geometry.transform_point(place, c) - x.position, dir))
  }
  return linalg.mul(linalg.quaternion_inverse(x.rotation), dir * far)
}

// ik_point is where IK ik's tip reaches with, as last posed: its end (ik_end) on its frame.
ik_point :: proc(rig: ^Rig, ik: RigIk) -> [3]f32 {
  x := rig_frame(rig, ik.tip)
  return x.position + linalg.mul(x.rotation, ik.point)
}

// ik_pole is the point IK ik's chain bends toward, reaching for `target` (as last posed): off the
// middle of the line from the joint above its middle one to the target, by the chain's length, the
// way its middle joint bends at rest, turned with the model (`origin`) and swung as the limb swings
// (the shortest turn from its line at rest to the line to the target). It goes where the target
// goes, so the bend never flips as a foot steps far ahead or back, and an arm hanging with its
// elbow back, swung forward to punch, has its elbow down; it needs no placing. Straight back
// against its rest line, the swing has no one way to go: the bend is then only turned with the model.
// `swivel` (the IK's .swivel channel, radians) then turns the bend about that line, from the joint
// above the middle one to the target: an elbow flared or rolled up, a knee swung out. The middle
// joint goes round the circle its two segments allow, the tip staying on the target.
ik_pole :: proc(rig: ^Rig, ik: RigIk, target: [3]f32, swivel: f32, origin: geometry.Transform) -> [3]f32 {
  if ik.mid <= 0 do return target
  above := rig.poses[rig.chains[ik.first + ik.mid - 1]].position
  bend := linalg.mul(origin.rotation, ik.bend)
  from, to := linalg.mul(origin.rotation, ik.line), linalg.normalize0(target - above)
  if linalg.dot(from, to) > -0.99 && to != 0 do bend = linalg.mul(linalg.quaternion_between_two_vector3(from, to), bend)
  if swivel != 0 && to != 0 do bend = linalg.mul(linalg.quaternion_angle_axis(swivel, to), bend)
  return (above + target) / 2 + bend * ik.length
}

// reach turns the chain's bones toward `target` by cyclic coordinate descent, each about the axes
// it turns, then blends the result with the motion the drives gave by `weight`. When it has a
// middle, each pass first swings the chain's middle joint (the knee: the pivot halfway along it),
// with the joints above it, to where it must be for the tip to reach: as for two segments, off the
// line from the joint above it to the target, toward the pole. The chain then bends in the plane
// through the pole, and by as much as the target needs, even from straight.
@(private = "file")
reach :: proc(rig: ^Rig, ik: RigIk, target, pole: [3]f32, weight: f32, origin: geometry.Transform) {
  chain := rig.chains[ik.first:][:ik.count]
  from := make([][3]f32, len(chain), context.temp_allocator)
  for bone, k in chain do from[k] = rig.motion[bone]
  // a foot holds facing as the drives turned it, in the model's space: planted, it stays as the clip
  // angles it however the knee bends
  keep := rig_frame(rig, ik.tip).rotation
  reach_from(rig, ik, chain, target, pole, keep, 0.01 * ik.length, origin)
  for bone, k in chain {
    mo := &rig.motion[bone]
    mo^ = linalg.lerp(from[k], mo^, weight)
  }
}

// reach_from reaches from the chain as it is now: its passes with the middle held where the pole
// puts it; then, if the tip is still more than `near` off (the joints' stops keep the middle from
// just there, and holding it there stalls the joints above it), on with the middle let go.
@(private = "file")
reach_from :: proc(rig: ^Rig, ik: RigIk, chain: []int, target, pole: [3]f32, keep: quaternion128, near: f32, origin: geometry.Transform) {
  reach_passes(rig, ik, chain, target, pole, keep, true, origin)
  if linalg.length(ik_point(rig, ik) - target) > near do reach_passes(rig, ik, chain, target, pole, keep, false, origin)
}

// reach_passes is reach's cyclic coordinate descent, from the chain as it is now; `pin`: the middle
// held where the pole puts it, once it gets there.
@(private = "file")
reach_passes :: proc(rig: ^Rig, ik: RigIk, chain: []int, target, pole: [3]f32, keep: quaternion128, pin: bool, origin: geometry.Transform) {
  ITERATIONS :: 16
  mid := ik.mid
  for _ in 0 ..< ITERATIONS {
    // the tip's own joints turn it back to face as it did (first: reaching has the last word)
    if ik.holds do for k in ik.turning ..< ik.count {
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
    if p := pole; mid > 0 {
      for k := mid - 1; k >= 0; k -= 1 {
        for axis in Axis {
          if axis not_in rig.bones[chain[k]].turns do continue
          for c in chain[k:] do pose_bone(rig, c, origin)
          if want, ok := middle_place(rig, ik, chain, mid, target, p); ok do turn_toward(rig, chain[k], axis, rig.poses[chain[mid]].position, want)
        }
      }
      // pinned only when it got there (its joints' stops may not let it)
      for c in chain[:mid + 1] do pose_bone(rig, c, origin)
      if want, ok := middle_place(rig, ik, chain, mid, target, p); ok do placed = pin && linalg.length(rig.poses[chain[mid]].position - want) < 0.02
    }
    for k := ik.turning - 1; k >= 0; k -= 1 {
      for axis in Axis {
        if axis not_in rig.bones[chain[k]].turns do continue
        for c in chain[k:] do pose_bone(rig, c, origin)
        was, at := rig.motion[chain[k]], rig.poses[chain[mid]].position if mid >= 0 else 0
        turn_toward(rig, chain[k], axis, ik_point(rig, ik), target)
        // above the middle, only a turn that keeps the middle where the pole put it (a thigh's
        // twist, about the line through the knee)
        if placed && k < mid {
          for c in chain[k:mid + 1] do pose_bone(rig, c, origin)
          if linalg.length(rig.poses[chain[mid]].position - at) > 0.01 do rig.motion[chain[k]] = was
        }
      }
    }
  }
}

// aim turns the chain's bones, tip first, so the tip's look points at `target`, each about the
// axes it turns (the tip's own joints, a neck, doing the most), then blends the result with the
// motion the drives gave by `weight`.
@(private = "file")
aim :: proc(rig: ^Rig, ik: RigIk, target: [3]f32, weight: f32, origin: geometry.Transform) {
  ITERATIONS :: 8
  chain := rig.chains[ik.first:][:ik.count]
  from := make([][3]f32, len(chain), context.temp_allocator)
  for bone, k in chain do from[k] = rig.motion[bone]
  for _ in 0 ..< ITERATIONS {
    for k := len(chain) - 1; k >= 0; k -= 1 {
      for axis in Axis {
        if axis not_in rig.bones[chain[k]].turns do continue
        for c in chain[k:] do pose_bone(rig, c, origin)
        x := rig_frame(rig, ik.tip)
        pivot := rig.poses[chain[k]].position
        // turn the way the tip looks toward the way to the target, about this joint
        turn_toward(rig, chain[k], axis, pivot + linalg.mul(x.rotation, ik.look), pivot + linalg.normalize0(target - x.position))
      }
    }
  }
  for bone, k in chain {
    mo := &rig.motion[bone]
    mo^ = linalg.lerp(from[k], mo^, weight)
  }
}

// middle_place is where the middle joint of IK ik's chain must be for its tip to reach `target`, its
// two segments (the joint above it to it, it to the tip) as long as they are: off the line from the
// joint above it to the target, toward `pole`. ok is false when the pole is on that line.
@(private = "file")
middle_place :: proc(rig: ^Rig, ik: RigIk, chain: []int, mid: int, target, pole: [3]f32) -> (want: [3]f32, ok: bool) {
  r := rig.poses[chain[mid - 1]].position
  at := rig.poses[chain[mid]].position
  la, lb := linalg.length(at - r), linalg.length(ik_point(rig, ik) - at)
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
  base := rig.poses[bone].rotation * linalg.quaternion_inverse(euler(mo))
  partial: [3]f32
  if axis >= .Y do partial.x = mo.x
  if axis >= .Z do partial.y = mo.y
  e: [3]f32
  e[axis] = 1
  n := linalg.mul(base * euler(partial), e)
  u, v := at - pivot, want - pivot
  lu, lv := linalg.length2(u), linalg.length2(v)
  u -= linalg.dot(u, n) * n
  v -= linalg.dot(v, n) * n
  // a point (nearly) on the axis isn't turned by it: its turn would be noise (a forearm's twist
  // with the fingertips on its line), flipping it between its stops
  if linalg.length2(u) < max(1e-10, 1e-4 * lu) || linalg.length2(v) < max(1e-10, 1e-4 * lv) do return
  rig.motion[bone][axis] += math.atan2(linalg.dot(n, linalg.cross(u, v)), linalg.dot(u, v))
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
  tip := ik_point(rig, ik)
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
// joint's mirror turns drives on it over; a linear actuator's, its stroke (its y's, as it is).
@(private)
bone_limit :: proc(b: ^Bone, j: Joint, mi: Mirror) {
  if j.kind == .LINEAR {
    b.stroke = {j.min[1], j.max[1]}
    return
  }
  for k in Axis {
    lo, hi := j.min[k], j.max[k]
    if mi.turn[k] do lo, hi = -hi, -lo
    b.lo[k], b.hi[k] = lo, hi
  }
}

// limit is motion `mo` held within bone b's range.
@(private)
limit :: proc(b: Bone, mo: [3]f32) -> [3]f32 {
  out := mo
  for k in 0 ..< 3 {
    if b.lo[k] != b.hi[k] do out[k] = clamp(out[k], b.lo[k], b.hi[k])
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
  if b.r != nil {
    if mesh, ok := library_mesh(b.lib, b.r, p, param); ok do render.attach(b.r, node, render.MeshAttachment{mesh = mesh, material = material})
  }
  append(&b.rig.pieces, Piece{bone, b.part, shape, p, place, node})
}
