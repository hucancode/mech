package mech

import "core:log"
import "core:math"
import "core:math/linalg"
import "../mjolnir/animation"
import "../mjolnir/geometry"
import "../mjolnir/render"
import "../mjolnir/world"

// A Rig is a Model in a scene: a bone per degree of freedom and a node per piece. Bones are flat
// children of the rig's `frame` node (scaled by the model's scale); pieces are children of their
// bone, so posing writes one transform per bone and none per piece.
//
// rig_pose takes one value per model channel and solves, in order: drivers,
// leg IK, then each bone from its parent.

Bone :: struct {
  parent:  int,
  offset:  [3]f32,
  rest:    quaternion128,
  axis:    u8, // 0 x, 1 y, 2 z
  channel: int, // -1: none
  sign:    f32,
  node:    world.NodeHandle,
}

// Piece is one drawn primitive: a part's shape (`shape` >= 0) or joint hardware (-1).
Piece :: struct {
  bone:      int,
  part:      int,
  shape:     int,
  primitive: Primitive,
  place:     geometry.Transform, // on its bone, scale included
  node:      world.NodeHandle,
}

@(private)
RigDriver :: struct {
  target, source: int,
  from, to:       [2]f32,
  clamp:          bool,
}

@(private)
RigLeg :: struct {
  hip, knee, ankle: int,
  thigh, shin:      f32,
  hip_y, ankle_y:   f32,
}

Rig :: struct {
  model:   ^Model,
  frame:   world.NodeHandle,
  bones:   [dynamic]Bone,
  pieces:  [dynamic]Piece,
  frames:  [dynamic]Frame, // per part: where its shapes and sockets sit
  poses:   [dynamic]geometry.Transform, // per bone, in the frame node's space, from the last pose
  solved:  [dynamic]f32, // the channels the last pose showed, drivers and IK applied
  drivers: [dynamic]RigDriver,
  legs:    [dynamic]RigLeg,
  level:   int,
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
  part:      int,
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

  for p, i in m.parts {
    b.part = i
    parent := model_part(m, p.parent) if p.parent != "" else -1
    if parent >= i {
      log.warnf("model %s: part %s comes before its parent %s; placed at the root", m.name, p.name, p.parent)
      parent = -1
    }
    binds: [3]int
    signs: [3]f32
    for bind, k in p.binds {
      binds[k], signs[k] = model_channel(m, bind.channel), bind.sign
      if bind.channel != "" && binds[k] < 0 do log.warnf("model %s: part %s binds unknown channel %s", m.name, p.name, bind.channel)
    }
    j: Joint
    if jid := model_joint(m, p.joint); jid >= 0 do j = m.joints[jid]
    else if p.joint != "" do log.warnf("model %s: part %s uses unknown joint %s", m.name, p.name, p.joint)
    frame: Frame
    if parent < 0 {
      // a root part rides one bone at the origin, which a SPIN joint turns about y
      bone := add_bone(&b, -1, {}, linalg.QUATERNIONF32_IDENTITY, 1, binds[0] if j.kind == .SPIN else -1, signs[0])
      frame = {bone, geometry.TRANSFORM_IDENTITY}
    } else {
      frame = joint_build(&b, rig.frames[parent], p.socket, j, p.centered, binds, signs, p.mount)
    }
    append(&rig.frames, frame)
    for s, k in p.shapes {
      place := geometry.transform_mul(frame.place, {s.position, euler(s.rotation), primitive_scale(s.primitive, s.size)})
      add_piece(&b, frame.bone, place, s.primitive, s.param, paint(&b, s.material), k)
    }
  }

  resize(&rig.solved, len(m.channels))
  for d in m.drivers {
    t, s := model_channel(m, d.target), model_channel(m, d.source)
    if t < 0 || s < 0 {
      log.warnf("model %s: driver %s <- %s names an unknown channel", m.name, d.target, d.source)
      continue
    }
    append(&rig.drivers, RigDriver{t, s, d.from, d.to, d.clamp})
  }
  rig.level = model_channel(m, m.level)

  // measure the legs and the lowest point at rest
  rest := make([]f32, len(m.channels), context.temp_allocator)
  copy(rig.solved[:], rest)
  drive(rig, rig.solved[:])
  solve(rig, rig.solved[:], {})
  for l in m.legs {
    leg := RigLeg{hip = model_channel(m, l.hip), knee = model_channel(m, l.knee), ankle = model_channel(m, l.ankle)}
    hip, knee, ankle := bone_of(rig, leg.hip), bone_of(rig, leg.knee), bone_of(rig, leg.ankle)
    if hip < 0 || knee < 0 || ankle < 0 {
      log.warnf("model %s: leg %s/%s/%s has a channel no bone uses", m.name, l.hip, l.knee, l.ankle)
      continue
    }
    h, k, a := rig.poses[hip].position, rig.poses[knee].position, rig.poses[ankle].position
    leg.thigh, leg.shin = linalg.length(h - k), linalg.length(k - a)
    leg.hip_y, leg.ankle_y = h.y, a.y
    append(&rig.legs, leg)
  }
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
  delete(rig.poses)
  delete(rig.solved)
  delete(rig.drivers)
  delete(rig.legs)
  free(rig)
}

// rig_pose shows `values`, one per model channel.
rig_pose :: proc(w: ^world.World, rig: ^Rig, values: []f32) {
  rig_solve(rig, values)
  for bone, i in rig.bones do world.transform(w, bone.node)^ = {rig.poses[i].position, rig.poses[i].rotation, 1}
}

// rig_solve is rig_pose without touching the scene: it solves `values` into rig.solved (the
// channels after drivers and leg IK) and rig.poses (every bone), for queries that ask where
// things would be at some other time. The next rig_pose shows the rig again.
rig_solve :: proc(rig: ^Rig, values: []f32) {
  s := rig.solved[:]
  copy(s, values)
  drive(rig, s)
  drop := rig_drop(rig, s[rig.level] if rig.level >= 0 else 0)
  for leg in rig.legs {
    hip, knee, ankle := leg.hip, leg.knee, leg.ankle
    z := leg.thigh * math.sin(s[hip]) + leg.shin * math.sin(s[hip] + s[knee])
    y := leg.thigh * math.cos(s[hip]) + leg.shin * math.cos(s[hip] + s[knee])
    floor := leg.hip_y - drop - leg.ankle_y
    a, b, _ := animation.two_link(leg.thigh, leg.shin, {min(y, floor), z})
    s[hip], s[knee] = a, b
    if y >= floor - 1e-6 do s[ankle] = -(a + b)
  }
  solve(rig, s, {0, rig.lift - drop, 0})
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

// rig_frame is where part `i`'s frame was by the last pose, in the frame node's space.
rig_frame :: proc(rig: ^Rig, i: int) -> geometry.Transform {
  f := rig.frames[i]
  return geometry.transform_mul(rig.poses[f.bone], f.place)
}

// rig_drop: the level channel at -1 lowers the pelvis as far as a 60 degree knee bend would.
@(private = "file")
rig_drop :: proc(rig: ^Rig, level: f32) -> f32 {
  if len(rig.legs) == 0 do return 0
  t, s := rig.legs[0].thigh, rig.legs[0].shin
  per_level := t + s - math.sqrt(t * t + s * s + 2 * t * s * math.cos(f32(-math.PI / 3)))
  return clamp(-min(level, 0) * per_level, 0, t + s - abs(t - s) - 0.02)
}

@(private = "file")
drive :: proc(rig: ^Rig, s: []f32) {
  for d in rig.drivers {
    t := (s[d.source] - d.from[0]) / (d.from[1] - d.from[0]) if d.from[1] != d.from[0] else 0
    if d.clamp do t = clamp(t, 0, 1)
    s[d.target] = math.lerp(d.to[0], d.to[1], t)
  }
}

@(private = "file")
bone_of :: proc(rig: ^Rig, channel: int) -> int {
  if channel < 0 do return -1
  for b, i in rig.bones do if b.channel == channel do return i
  return -1
}

@(private = "file")
solve :: proc(rig: ^Rig, channels: []f32, origin: [3]f32) {
  resize(&rig.poses, len(rig.bones))
  for b, i in rig.bones {
    position, rotation := origin, linalg.QUATERNIONF32_IDENTITY
    if b.parent >= 0 do position, rotation = rig.poses[b.parent].position, rig.poses[b.parent].rotation
    position += linalg.mul(rotation, b.offset)
    axis: [3]f32
    axis[b.axis] = 1
    angle := b.sign * channels[b.channel] if b.channel >= 0 else 0
    rotation *= b.rest * linalg.quaternion_angle_axis_f32(angle, axis)
    rig.poses[i] = {position, linalg.normalize(rotation), 1}
  }
}

@(private)
add_bone :: proc(b: ^Builder, parent: int, offset: [3]f32, rest: quaternion128, axis: u8, channel: int, sign: f32) -> int {
  append(&b.rig.bones, Bone{parent, offset, rest, axis, channel, sign, world.spawn(b.w, parent = b.rig.frame)})
  return len(b.rig.bones) - 1
}

@(private)
add_piece :: proc(b: ^Builder, bone: int, place: geometry.Transform, p: Primitive, param: f32, material: render.MaterialHandle, shape: int) {
  node := world.spawn(b.w, parent = b.rig.bones[bone].node)
  world.transform(b.w, node)^ = place
  if mesh, ok := library_mesh(b.lib, b.r, p, param); ok do render.attach(b.r, node, render.MeshAttachment{mesh = mesh, material = material})
  append(&b.rig.pieces, Piece{bone, b.part, shape, p, place, node})
}
