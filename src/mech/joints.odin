package mech

import "core:math"
import "core:math/linalg"
import "../mjolnir/geometry"

// Joint hardware, after mjolnir's Atlas example (examples/creative/atlas): forked hinges with lugs
// and a pin, disc hinges, ball and socket joints, a 3-DoF wrist and knuckle pins. A joint adds
// its parts as pieces on the bones it creates, one bone per degree of freedom, each turning about
// one axis by one channel. Hardware is painted in the model's `hardware` materials.

@(private = "file")
X :: [3]f32{1, 0, 0}
@(private = "file")
Y :: [3]f32{0, 1, 0}
@(private = "file")
Z :: [3]f32{0, 0, 1}
@(private = "file")
NEG_Y :: [3]f32{0, -1, 0}

@(private)
Role :: enum u8 {
  FEMALE, // female hinge halves, sockets
  MALE, // male hinge halves, ball flanges
  METAL, // pins, balls, studs
}

// Frame is a place on a bone: shapes and sockets of a part are placed in its frame.
Frame :: struct {
  bone:  int,
  place: geometry.Transform,
}

@(private)
reach :: proc(j: Joint) -> f32 {
  return j.shank + j.flange_t
}

@(private)
wrist_drop :: proc(j: Joint) -> f32 {
  return -(2 * j.shank + j.flange_t)
}

// joint_mounts: the face a joint bolts to its parent's socket with, and the face its child's
// mount bolts to, in the joint's frame.
joint_mounts :: proc(j: Joint) -> (a, b: geometry.Face) {
  switch j.kind {
  case .BALL:
    return {{0, -(j.ball_r * 0.55 + j.flange_t), 0}, NEG_Y, Z}, {{0, j.ball_r + j.stud_len + j.flange_t, 0}, Y, Z}
  case .FIXED, .SPIN, .PIN:
    return {{}, Y, X}, {{}, NEG_Y, X}
  case .HINGE, .HINGE_TWIST, .DISC_HINGE, .WRIST:
  }
  return {{0, reach(j), 0}, Y, X}, {{0, -reach(j), 0}, NEG_Y, X}
}

// joint_build bolts `j` onto `socket` of `parent`, adds a bone per degree of freedom bound to
// `binds`, and returns the frame the child's `mount` face sits in.
@(private)
joint_build :: proc(b: ^Builder, parent: Frame, socket: geometry.Face, j: Joint, centered: bool, binds: [3]int, signs: [3]f32, mount: geometry.Face) -> Frame {
  a, m := joint_mounts(j)
  if centered do a.position, m.position = {}, {}
  frame := Frame{parent.bone, geometry.transform_mul(parent.place, geometry.seat(socket, a))}
  #partial switch j.kind {
  case .HINGE, .HINGE_TWIST, .WRIST:
    hinge_female(b, frame, j, j.disc_f)
  case .PIN:
    hinge_pin(b, frame, j)
  case .BALL:
    ball_female(b, frame, j)
  }
  dofs: [3]struct {
    axis:   u8,
    offset: [3]f32,
    rest:   quaternion128,
  }
  for &d in dofs do d.rest = linalg.QUATERNIONF32_IDENTITY
  count := 1
  switch j.kind {
  case .FIXED:
    count = 0
  case .HINGE, .PIN:
  case .SPIN:
    dofs[0].axis = 1
  case .HINGE_TWIST:
    dofs[1].axis, count = 1, 2
  case .DISC_HINGE:
    dofs[0].axis, dofs[2].axis, count = 1, 1, 3
    dofs[1].rest = linalg.quaternion_angle_axis(math.PI / 2, X)
  case .WRIST:
    dofs[1].offset, dofs[1].rest = {0, wrist_drop(j), 0}, linalg.quaternion_angle_axis(-math.PI / 2, Y)
    dofs[2].axis, count = 1, 3
  case .BALL:
    dofs[1].axis, dofs[2].axis, count = 1, 2, 3
  }
  if count == 0 do return {parent.bone, geometry.transform_mul(frame.place, geometry.seat(m, mount))}
  bones: [3]int
  for d, i in dofs[:count] {
    if i == 0 do bones[i] = add_bone(b, frame.bone, geometry.transform_point(frame.place, d.offset), frame.place.rotation * d.rest, d.axis, binds[i], signs[i])
    else do bones[i] = add_bone(b, bones[i - 1], d.offset, d.rest, d.axis, binds[i], signs[i])
  }
  ride :: proc(bone: int) -> Frame {
    return {bone, geometry.TRANSFORM_IDENTITY}
  }
  #partial switch j.kind {
  case .HINGE, .HINGE_TWIST:
    hinge_male(b, ride(bones[0]), j, true, j.disc_m, j.tang)
  case .DISC_HINGE:
    hinge_female(b, ride(bones[0]), j, true)
    hinge_male(b, ride(bones[1]), j, true, true, true)
  case .WRIST:
    hinge_male(b, ride(bones[0]), j, false, false, true)
    hinge_female(b, {bones[0], {{0, wrist_drop(j), 0}, linalg.quaternion_angle_axis(-math.PI / 2, Y), 1}}, j, true)
    hinge_male(b, ride(bones[1]), j, true, true, true)
  case .BALL:
    ball_male(b, ride(bones[2]), j)
  }
  return {bones[count - 1], geometry.seat(m, mount)}
}

@(private = "file")
part :: proc(b: ^Builder, f: Frame, p: Primitive, role: Role, scale: [3]f32, position: [3]f32 = {}, rotation := linalg.QUATERNIONF32_IDENTITY, param: f32 = 0) {
  add_piece(b, f.bone, geometry.transform_mul(f.place, {position, rotation, scale}), p, param, b.hardware[role], -1)
}

@(private = "file")
box :: proc(b: ^Builder, f: Frame, role: Role, size, position: [3]f32) {
  part(b, f, .BOX, role, size / 2, position)
}

// cylinder stands a cylinder of `radius` and `height` on `position`, along the rotated y.
@(private = "file")
cylinder :: proc(b: ^Builder, f: Frame, role: Role, radius, height: f32, position: [3]f32 = {}, rotation := linalg.QUATERNIONF32_IDENTITY) {
  center := position + linalg.mul(rotation, [3]f32{0, height / 2, 0})
  part(b, f, .CYLINDER, role, {radius, height, radius}, center, rotation)
}

@(private = "file")
jaw_width :: proc(j: Joint) -> f32 {
  return j.jaw + 2 * j.lug_t + 2 * j.clr
}

@(private = "file")
lug :: proc(b: ^Builder, f: Frame, j: Joint, role: Role, thickness, x, up: f32) {
  part(b, f, .CYLINDER, role, {j.lug_d / 2, thickness - 0.002, j.lug_d / 2}, {x, 0, 0}, linalg.quaternion_angle_axis(-math.PI / 2, Z))
  box(b, f, role, {thickness, j.shank, j.lug_d}, {x, up * j.shank / 2, 0})
}

@(private = "file")
fork :: proc(b: ^Builder, f: Frame, j: Joint, role: Role, jaw, up: f32, tang: bool) {
  if tang {
    lug(b, f, j, role, jaw + 2 * j.lug_t, 0, up)
    return
  }
  x := jaw / 2 + j.lug_t / 2
  lug(b, f, j, role, j.lug_t, -x, up)
  lug(b, f, j, role, j.lug_t, x, up)
}

@(private = "file")
hinge_base :: proc(b: ^Builder, f: Frame, j: Joint, role: Role, up: f32, disc: bool) {
  width := (jaw_width(j) if up > 0 else j.jaw) + 2 * j.lug_t
  y := up * (j.shank + j.flange_t / 2)
  if disc do cylinder(b, f, role, math.hypot(width, j.lug_d) / 2, j.flange_t, {0, y - j.flange_t / 2, 0})
  else do box(b, f, role, {width, j.flange_t, j.lug_d}, {0, y, 0})
}

@(private = "file")
hinge_pin :: proc(b: ^Builder, f: Frame, j: Joint) {
  half := jaw_width(j) / 2 + j.lug_t + max(0.005, j.pin_out)
  part(b, f, .CYLINDER, .METAL, {j.pin_r, 2 * half, j.pin_r}, {}, linalg.quaternion_angle_axis(-math.PI / 2, Z))
}

@(private = "file")
hinge_female :: proc(b: ^Builder, f: Frame, j: Joint, disc: bool) {
  fork(b, f, j, .FEMALE, jaw_width(j), 1, false)
  hinge_base(b, f, j, .FEMALE, 1, disc)
  hinge_pin(b, f, j)
}

@(private = "file")
hinge_male :: proc(b: ^Builder, f: Frame, j: Joint, base, disc, tang: bool) {
  fork(b, f, j, .MALE, j.jaw, -1, tang)
  if base do hinge_base(b, f, j, .MALE, -1, disc)
}

@(private = "file")
ball_female :: proc(b: ^Builder, f: Frame, j: Joint) {
  drop := j.ball_r * 0.55
  cylinder(b, f, .FEMALE, j.flange_w / 2, j.flange_t, {0, -drop - j.flange_t, 0})
  cylinder(b, f, .FEMALE, j.ball_r + 0.02 + j.socket_t, drop, {0, -drop, 0})
}

@(private = "file")
ball_male :: proc(b: ^Builder, f: Frame, j: Joint) {
  STUD_R :: 0.11
  top := j.ball_r + j.stud_len
  part(b, f, .SPHERE, .METAL, {j.ball_r, j.ball_r, j.ball_r})
  cylinder(b, f, .METAL, STUD_R, top)
  cylinder(b, f, .MALE, j.flange_w * 0.375, j.flange_t, {0, top, 0})
}
