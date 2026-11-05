package mech

import "core:fmt"
import "core:math"
import "core:math/linalg"
import "core:slice"
import "../mjolnir/animation"
import "../mjolnir/geometry"
import "../mjolnir/render"
import "../mjolnir/world"

// A Rig is a Model in a scene: a bone per joint and a node per piece. Bones are flat
// children of the rig's `frame` node (scaled by the model's scale); pieces are children of their
// bone, so posing writes one transform per bone and none per piece.
//
// rig_pose takes a pose's values (model_channel_table) and solves, in order: each bone's turns
// from the drives, then IK (mjolnir's, animation.ik_solve and aim_solve, over the rig's
// skeleton as an animation.Pose), each IK's bones' descendants following.

// Bone is one per joint (and an anchor at the origin per root), at the joint's pivot. Its place in
// the skeleton (its parent, its rest transform on it, its joint's stops) is the Rig's, per bone; a
// linear actuator's `stroke` is how far it slides out, its min and max (equal: free).
Bone :: struct {
  part:   int, // the instance whose joint it is
  joint:  int, // which of its place's joints (place_joints); -1: a root's anchor
  stroke: [2]f32,
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
// with the first `turning`; when it `holds` (its end stands on the ground at rest: a foot), it meets
// the ground by the contact rules (contact.odin): `end` and `pivot` are where it reaches with and
// its first own joint, in its tip bone's frame, `reach` the way from its root to its end at rest,
// `face` its tip bone's facing then and `own` its own joints' turns, `toes` the way from its pivot
// to the joints below it (its frame; 0 for none), `span` how far ahead of its end the first of
// those is (level, at rest), `roll` how far it rolls on an edge at most,
// `stretch` how far from its root its pivot is when its heel starts to lift and the furthest it reaches,
// rig.corners[corners_first:][:corners_count] its own pieces' corners and
// rig.conforms[conform_first:][:conform_count] the joints below it lying on the ground; otherwise
// (a hand, a gun) the tip's own joints keep their channels' turns. `tip` is the instance that reaches, with
// its end (`point`, in its frame: ik_point); `channel` is the first of its values (IK_VALUES),
// its target an offset from `rest`, where that end is at rest (in the frame node's space, lifted). `mid` is the chain's
// middle joint (animation.ik_chain_middle; 0 for none), which bends toward a pole (ik_pole): `bend` is the way
// its stops let it bend at rest, in the model's space, `line` the way from the joint above the
// middle one to the tip at rest, and `length` the chain's, root to tip.
// An aiming one (`aim`) turns its whole chain so the tip's `look` (a direction in its frame: ahead
// at rest) points at the target, `rest` then being a point ahead of the tip.
RigIk :: struct {
  first, count, turning, tip: int,
  channel:                    int,
  aim, holds:                 bool,
  mid:                        u32,
  rest, bend, look, line:     [3]f32,
  point:                      [3]f32,
  length:                     f32,
  end, pivot, reach, toes:    [3]f32,
  face, own:                  quaternion128,
  roll, span:                 f32,
  stretch:                    [2]f32,
  corners_first, corners_count: int,
  conform_first, conform_count: int,
}

// Rig: per bone, its skeleton (parents first, as mjolnir's animation.Pose reads it: `parents`,
// `rest` its offset and rest turn on its parent, `limits` its joint's stops) and its pose as last
// solved (`local` on its parent, the root's on the origin; `positions`, `rotations` in the frame
// node's space).
Rig :: struct {
  model:     ^Model,
  frame:     world.NodeHandle,
  bones:     [dynamic]Bone,
  parents:   [dynamic]i32,
  order:     [dynamic]u32,
  lengths:   [dynamic]f32,
  rest:      [dynamic]geometry.Transform,
  limits:    [dynamic]animation.JointLimit,
  local:     [dynamic]geometry.Transform,
  positions: [dynamic][3]f32,
  rotations: [dynamic]quaternion128,
  scales:    [dynamic][3]f32,
  slide:     [dynamic]f32, // per bone, how far it slid out (a linear actuator's), model units
  pieces:    [dynamic]Piece,
  places:    [dynamic]Place, // what the model places (model_places): bones, pieces and frames are of these
  frames:    [dynamic]Frame, // per place: where its part's shapes and slots sit
  values:    [dynamic]f32, // the values the last pose showed
  drives:    [dynamic]RigDrive,
  iks:       [dynamic]RigIk,
  chains:    [dynamic]u32,
  corners:   [dynamic][3]f32, // contact corners (RigIk, RigConform), in their bones' frames
  conforms:  [dynamic]RigConform,
  lift:      f32,
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
    frame := rig.frames[parent] if parent >= 0 else Frame{add_bone(&b, -1, {}, linalg.QUATERNIONF32_IDENTITY), geometry.TRANSFORM_IDENTITY}
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
      rig.limits[frame.bone] = joint_limit(j, mi)
      if j.kind == .LINEAR do rig.bones[frame.bone].stroke = {j.min[1], j.max[1]}
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
      x := geometry.transform_mul(rig_bone(rig, p.bone), p.place)
      for c in primitive_corners(p.primitive) do low = min(low, geometry.transform_point(x, c).y)
    }
    if len(rig.pieces) > 0 do rig.lift = -low
  }
  for &ik in rig.iks {
    ik.rest.y += rig.lift
    // a foot: its end stands on the ground at rest
    ik.holds = !ik.aim && m.ground && abs(ik.rest.y) < 0.05 * ik.length
    if ik.holds do contact_measure(rig, &ik)
  }
  rig_pose(w, rig, rest)
  return rig, true
}


rig_destroy :: proc(rig: ^Rig, w: ^world.World) {
  world.node_destroy(w, rig.frame)
  delete(rig.bones)
  delete(rig.parents)
  delete(rig.order)
  delete(rig.lengths)
  delete(rig.rest)
  delete(rig.limits)
  delete(rig.local)
  delete(rig.positions)
  delete(rig.rotations)
  delete(rig.scales)
  delete(rig.slide)
  delete(rig.pieces)
  delete(rig.places)
  delete(rig.frames)
  delete(rig.values)
  delete(rig.drives)
  delete(rig.iks)
  delete(rig.chains)
  delete(rig.corners)
  delete(rig.conforms)
  free(rig)
}

// rig_pose shows `values`, one per model channel (model_channels).
rig_pose :: proc(w: ^world.World, rig: ^Rig, values: []f32) {
  rig_solve(rig, values)
  for bone, i in rig.bones do world.transform(w, bone.node)^ = {rig.positions[i], rig.rotations[i], 1}
}

// rig_solve is rig_pose without touching the scene: it solves `values` into rig.values and the
// bones' pose (every bone), for queries that ask where things would be at some other time. The
// next rig_pose shows the rig again.
rig_solve :: proc(rig: ^Rig, values: []f32) {
  s := rig.values[:]
  copy(s, values)
  n := len(rig.bones)
  angles := make([][3]f32, n, context.temp_allocator)
  for &sl in rig.slide do sl = 0
  for d in rig.drives {
    v := s[d.channel]
    if d.slide do rig.slide[d.bone] += v
    else do angles[d.bone][d.axis] += v * d.turn
  }
  // each bone on its parent, turned by its drives within its stops; a linear actuator slides
  // out, away from its socket (-y); a root on the origin
  origin := rig_origin(rig)
  for b, i in rig.bones {
    if b.stroke[0] != b.stroke[1] do rig.slide[i] = clamp(rig.slide[i], b.stroke[0], b.stroke[1])
    turn := animation.joint_rotation(rig.rest[i].rotation, angles[i], rig.limits[i])
    at := rig.rest[i].position + linalg.mul(turn, [3]f32{0, -rig.slide[i], 0})
    rig.local[i] = {at, turn, 1}
    if rig.parents[i] < 0 do rig.local[i] = geometry.transform_mul(origin, rig.local[i])
  }
  pose := rig_skeleton(rig)
  animation.pose_compose(pose)
  moved := make([]bool, n, context.temp_allocator)
  for ik in rig.iks {
    c := s[ik.channel:]
    weight := clamp(c[IK_WEIGHT], 0, 1)
    if weight <= 0 do continue
    chain := rig.chains[ik.first:][:ik.count]
    // the chain before IK, to blend from (not needed at full weight)
    positions: [][3]f32
    rotations: []quaternion128
    if weight < 1 {
      positions = make([][3]f32, len(chain), context.temp_allocator)
      rotations = make([]quaternion128, len(chain), context.temp_allocator)
      for b, k in chain do positions[k], rotations[k] = rig.positions[b], rig.rotations[b]
    }
    target := ik.rest + {c[0], c[1], c[2]}
    toes: f32 // how far up its toes stand, following (contact_solve)
    place := rig.frames[ik.tip].place
    if ik.aim {
      // the tip looks from its frame's origin
      animation.aim_solve(pose, chain, linalg.mul(place.rotation, ik.look), place.position, target)
    } else if ik.holds && ik.turning < ik.count {
      toes = contact_solve(rig, ik, target, {c[IK_TRAIL], c[IK_TRAIL + 1], c[IK_TRAIL + 2]}, {c[IK_TRAIL + 3], c[IK_TRAIL + 4], c[IK_TRAIL + 5]}, c[IK_SWIVEL], origin)
    } else {
      animation.ik_solve(pose, chain, {
        target      = target,
        pole        = ik_pole(rig, ik, target, c[IK_SWIVEL], origin),
        pole_weight = 1,
        iterations  = 16,
        end         = geometry.transform_point(place, ik.point),
        ends        = u32(ik.count - ik.turning),
        middle      = ik.mid,
      })
    }
    animation.pose_blend(pose, chain, positions, rotations, weight)
    slice.fill(moved, false)
    for b in chain do moved[b] = true
    animation.pose_propagate(pose, moved)
    if ik.holds do contact_conform(rig, ik, toes)
  }
}

// rig_skeleton is the rig's skeleton and pose as mjolnir's animation.Pose sees them: in the frame
// node's space, the origin on the roots.
@(private)
rig_skeleton :: proc(rig: ^Rig) -> animation.Pose {
  return {
    local = rig.local[:],
    positions = rig.positions[:],
    rotations = rig.rotations[:],
    scales = rig.scales[:],
    parents = rig.parents[:],
    order = rig.order[:],
    lengths = rig.lengths[:],
    rest = rig.rest[:],
    limits = rig.limits[:],
    root_world = linalg.MATRIX4F32_IDENTITY,
    root_inv = linalg.MATRIX4F32_IDENTITY,
  }
}

// rig_bone is where bone `i` was by the last pose, in the frame node's space.
rig_bone :: proc(rig: ^Rig, i: int) -> geometry.Transform {
  return {rig.positions[i], rig.rotations[i], 1}
}

// rig_turns is the axes bone `i`'s joint turns about, and its stops on them: equal ends where it
// is free.
rig_turns :: proc(rig: ^Rig, i: int) -> (turns: bit_set[Axis], lo, hi: [3]f32) {
  l := rig.limits[i]
  for axis in Axis {
    if l.lo[axis] == l.hi[axis] do continue
    turns += {axis}
    if l.lo[axis] > -math.F32_MAX do lo[axis], hi[axis] = l.lo[axis], l.hi[axis]
  }
  return
}

// rig_angles is how far bone `i`'s joint is turned from rest about x, y, z by the last pose,
// IK included.
rig_angles :: proc(rig: ^Rig, i: int) -> [3]f32 {
  turn := rig.local[i].rotation
  if rig.parents[i] < 0 do turn = linalg.quaternion_inverse(rig_origin(rig).rotation) * turn
  return animation.joint_angles(rig.rest[i].rotation, turn)
}

// rig_piece is where piece `i` was drawn by the last pose, in the frame node's space.
rig_piece :: proc(rig: ^Rig, i: int) -> geometry.Transform {
  p := rig.pieces[i]
  return geometry.transform_mul(rig_bone(rig, p.bone), p.place)
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
  for b := rig.frames[inst].bone; b >= 0; b = int(rig.parents[b]) do above[b] = true
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
  up := rig_origin(rig)
  if p := rig.parents[i]; p >= 0 do up = rig_bone(rig, int(p))
  return geometry.transform_mul(up, {rig.rest[i].position, rig.rest[i].rotation, 1})
}

// rig_frame is where instance `i`'s frame was by the last pose, in the frame node's space.
rig_frame :: proc(rig: ^Rig, i: int) -> geometry.Transform {
  f := rig.frames[i]
  return geometry.transform_mul(rig_bone(rig, f.bone), f.place)
}

// rig_origin is where the last pose put the model's origin: the root's channels, lifted.
rig_origin :: proc(rig: ^Rig) -> geometry.Transform {
  root := rig.values[root_channel(rig.model):][:ROOT_VALUES]
  return {{root[0], root[1] + rig.lift, root[2]}, animation.joint_euler({root[3], root[4], root[5]}), 1}
}

// instance_base is the bone place `i`'s joints hang from: its parent's frame's, or a root's anchor.
@(private = "file")
instance_base :: proc(rig: ^Rig, i: int) -> int {
  if parent := rig.places[i].parent; parent >= 0 do return rig.frames[parent].bone
  for b, k in rig.bones do if b.part == i && b.joint < 0 do return k
  return -1
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
  for bone := rig.frames[tip].bone; bone >= 0; bone = int(rig.parents[bone]) {
    if bone == base {
      out.count = len(rig.chains) - out.first
      slice.reverse(rig.chains[out.first:])
      // the tip's own joints (an ankle, a wrist) only turn it where it is: IK turns those above
      out.turning = out.count
      if !ik.aim do for c, n in rig.chains[out.first:][:out.count] do if int(c) == instance_base(rig, tip) do out.turning = n + 1
      append(&rig.iks, out)
      return
    }
    append(&rig.chains, u32(bone))
  }
  resize(&rig.chains, out.first)
}

// ik_rest finds, from the rest pose (the bones' pose, unlifted), where IK target ik's tip is, its chain's
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
    ik.mid = 0
    return
  }
  chain := rig.chains[ik.first:][:ik.count]
  ik.mid = animation.ik_chain_middle(rig_skeleton(rig), chain, geometry.transform_point(rig.frames[ik.tip].place, ik.point), ik.turning)
  ik.length = 0
  for k in 1 ..< len(chain) do ik.length += linalg.length(rig.positions[chain[k]] - rig.positions[chain[k - 1]])
  ik.length += linalg.length(ik.rest - rig.positions[chain[len(chain) - 1]])
  if ik.mid == 0 do return
  bone := int(chain[ik.mid])
  turns, lo, hi := rig_turns(rig, bone)
  at := rig.positions[bone]
  above := rig.positions[chain[ik.mid - 1]]
  line := linalg.normalize0(ik.rest - above)
  ik.line = line
  off := (at - above) - linalg.dot(at - above, line) * line
  if linalg.length(off) > 1e-3 * ik.length {
    ik.bend = linalg.normalize(off)
    return
  }
  d := ik.rest - at
  for axis in turns {
    e: [3]f32
    e[axis] = 1
    a := linalg.mul(rig.rotations[bone], e)
    if abs(linalg.dot(a, linalg.normalize0(d))) >= 0.7 do continue
    // turning about a by +θ swings the tip along a × d, and the joint itself out the other way
    side := f32(-1) if lo[axis] + hi[axis] < 0 else 1
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
  dir := linalg.normalize0(x.position - rig.positions[rig.chains[ik.first + max(ik.turning - 1, 0)]])
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
  if ik.mid == 0 do return target
  above := rig.positions[rig.chains[ik.first + int(ik.mid) - 1]]
  bend := linalg.mul(origin.rotation, ik.bend)
  from, to := linalg.mul(origin.rotation, ik.line), linalg.normalize0(target - above)
  if linalg.dot(from, to) > -0.99 && to != 0 do bend = linalg.mul(linalg.quaternion_between_two_vector3(from, to), bend)
  if swivel != 0 && to != 0 do bend = linalg.mul(linalg.quaternion_angle_axis(swivel, to), bend)
  return (above + target) / 2 + bend * ik.length
}

// joint_limit is a joint's stops on its bone: on each axis it turns (joint_turns), its range, turned
// over (and its ends swapped) where the joint's mirror turns drives on it over, free where its ends
// are equal; every other axis locked.
@(private)
joint_limit :: proc(j: Joint, mi: Mirror) -> (out: animation.JointLimit) {
  for k in joint_turns(j) {
    lo, hi := j.min[k], j.max[k]
    if mi.turn[k] do lo, hi = -hi, -lo
    if lo == hi do lo, hi = -math.F32_MAX, math.F32_MAX
    out.lo[k], out.hi[k] = lo, hi
  }
  return
}

// add_bone adds a bone on `parent` at `offset`, turned `rest`, its joint locked (joint_limit
// frees it).
@(private)
add_bone :: proc(b: ^Builder, parent: int, offset: [3]f32, rest: quaternion128) -> int {
  rig := b.rig
  i := len(rig.bones)
  append(&rig.bones, Bone{part = b.part, joint = b.joint, node = world.spawn(b.w, parent = rig.frame)})
  append(&rig.parents, i32(parent))
  append(&rig.order, u32(i))
  append(&rig.lengths, linalg.length(offset))
  append(&rig.rest, geometry.Transform{offset, rest, 1})
  append(&rig.limits, animation.JointLimit{})
  append(&rig.local, geometry.Transform{offset, rest, 1})
  append(&rig.positions, [3]f32{})
  append(&rig.rotations, linalg.QUATERNIONF32_IDENTITY)
  append(&rig.scales, [3]f32{1, 1, 1})
  append(&rig.slide, 0)
  return i
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
