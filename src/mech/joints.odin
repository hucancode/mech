package mech

import "core:math"
import "core:math/linalg"
import "../mjolnir/geometry"

// Joint hardware, after mjolnir's Atlas example (examples/creative/atlas): forked hinges with lugs
// and a pin, ball and socket joints, and turntables (SPIN). A joint that moves adds a bone at its pivot,
// and its hardware as pieces: the female half on the parent's bone, the male half on its own.
// Hardware is painted in the model's `hardware` materials.

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

// PART_FACE is a part's unnamed slot as the child of a match: its frame's origin, +y toward the
// joint, +x forward. It also sits each joint of a stack on the one before.
PART_FACE :: geometry.Face{{}, Y, X}

// SLOT_FACE is an unnamed slot: the parent's origin, facing -y, which seats PART_FACE unturned on a
// joint pivoting on it (a root on the model origin, each next joint of a part's stack).
SLOT_FACE :: geometry.Face{{}, NEG_Y, X}

// joint_scaled is `j` at its size: its hardware parameters, proportions at size 1, made lengths.
// Everything that builds or seats a joint reads it scaled (rig_create scales each once).
joint_scaled :: proc(j: Joint) -> Joint {
  out := j
  for p in ([]^f32{&out.jaw, &out.lug_t, &out.lug_d, &out.shank, &out.flange_t, &out.pin_r, &out.clr, &out.pin_out, &out.ball_r, &out.socket_t, &out.stud_len, &out.flange_w}) do p^ *= j.size
  out.size = 1
  return out
}

// joint_mounts: the face a joint bolts to its parent's socket with, and the face its part bolts
// to (with PART_FACE), in the joint's frame. A hinge pivots its reach out from the socket (on it
// with no shank and flange: knuckles); joints without hardware pivot on the socket itself.
joint_mounts :: proc(j: Joint) -> (a, b: geometry.Face) {
  switch j.kind {
  case .BALL:
    return {{0, -(j.ball_r * 0.55 + j.flange_t), 0}, NEG_Y, Z}, {{0, j.ball_r + j.stud_len + j.flange_t, 0}, Y, Z}
  case .HINGE:
    return {{0, reach(j), 0}, Y, X}, {{0, -reach(j), 0}, NEG_Y, X}
  case .SPIN:
    // a turntable: two discs meeting on the pivot
    return {{0, j.flange_t / 2, 0}, Y, X}, {{0, -j.flange_t / 2, 0}, NEG_Y, X}
  case .FIXED:
  }
  return {{}, Y, X}, {{}, NEG_Y, X}
}

// Mirror is how a mirrored joint and what sits on it show: a point x of the part shows at
// reflect·x + offset, and drives turning about the axes marked in `turn` go the other way.
Mirror :: struct {
  reflect: matrix[3, 3]f32,
  offset:  [3]f32,
  turn:    [Axis]bool,
}

MIRROR_NONE :: Mirror{reflect = {1, 0, 0, 0, 1, 0, 0, 0, 1}}

// joint_mirror: a joint bolted onto a reflected slot (mirror_face) is the joint reflected across
// its female face's forward d, as its bone holds it; a turn about d keeps its sign, the others
// turn over. The part's frame sits on that reflected joint the same way
// (PART_FACE), so its shapes and slots are reflected across the same plane, seen from the part.
joint_mirror :: proc(j: Joint) -> (out: Mirror) {
  a, m := joint_mounts(j)
  d := a.forward
  dofs, _ := joint_dofs(j)
  d = linalg.normalize(linalg.quaternion_mul_vector3(linalg.quaternion_inverse(dofs[0].rest), d))
  for k in Axis do out.turn[k] = abs(d[int(k)]) < 0.5
  I :: matrix[3, 3]f32{1, 0, 0, 0, 1, 0, 0, 0, 1}
  td := I - 2 * linalg.outer_product(d, d)
  r0 := linalg.matrix3_from_quaternion(geometry.seat(m, PART_FACE).rotation)
  out.reflect = linalg.transpose(r0) * td * r0
  out.offset = linalg.transpose(r0) * (td * m.position - m.position)
  return
}

// mirror_moved is `mi` seen from a frame placed at `x` in mi's frame.
mirror_moved :: proc(mi: Mirror, x: geometry.Transform) -> Mirror {
  r := linalg.matrix3_from_quaternion(x.rotation)
  out := mi
  out.reflect = linalg.transpose(r) * mi.reflect * r
  out.offset = linalg.transpose(r) * (mi.reflect * x.position + mi.offset - x.position)
  return out
}

// twist_face is `f` turned by `angle` about its normal.
twist_face :: proc(f: geometry.Face, angle: f32) -> geometry.Face {
  return {f.position, f.normal, linalg.mul(linalg.quaternion_angle_axis(angle, linalg.normalize(f.normal)), f.forward)}
}

// mirror_face reflects a face through `mi`, its forward turned over to stay right-handed.
mirror_face :: proc(mi: Mirror, f: geometry.Face) -> geometry.Face {
  return {mi.reflect * f.position + mi.offset, mi.reflect * f.normal, -(mi.reflect * f.forward)}
}

// mirror_shape is a shape's place reflected through `mi`, then across a plane its primitive is
// symmetric about, so it needs no negative scale: its own x (x = 0), but for a quarter cylinder,
// whose arc runs from +x to +z, the plane between them (x = z).
mirror_shape :: proc(mi: Mirror, place: geometry.Transform, p: Primitive) -> geometry.Transform {
  own := matrix[3, 3]f32{0, 0, 1, 0, 1, 0, 1, 0, 0} if p == .QUARTER_CYLINDER else matrix[3, 3]f32{-1, 0, 0, 0, 1, 0, 0, 0, 1}
  q := mi.reflect * linalg.matrix3_from_quaternion(place.rotation) * own
  scale := place.scale.zyx if p == .QUARTER_CYLINDER else place.scale
  return {mi.reflect * place.position + mi.offset, linalg.normalize(linalg.quaternion_from_matrix3(q)), scale}
}

// Dof is one of a joint's degrees of freedom: an axis its bone turns about. The first carries the
// joint's rest bend, `rest`.
Dof :: struct {
  axis: Axis,
  rest: quaternion128,
}

// joint_dofs are a joint's degrees of freedom. The first is turned by `bend` at rest, which turns
// the joint's bone.
joint_dofs :: proc(j: Joint) -> (dofs: [3]Dof, count: int) {
  for &d in dofs do d.rest = linalg.QUATERNIONF32_IDENTITY
  switch j.kind {
  case .FIXED:
  case .SPIN:
    dofs[0].axis, count = .Y, 1
  case .HINGE:
    count = 1
  case .BALL:
    dofs[1].axis, dofs[2].axis, count = .Y, .Z, 3
  }
  if count > 0 {
    axis: [3]f32
    axis[int(dofs[0].axis)] = 1
    dofs[0].rest = linalg.quaternion_angle_axis(j.bend, axis)
  }
  return
}

// joint_build bolts `j` onto `socket` of `parent` and returns the frame its male half bolts the next
// joint or the part on (with PART_FACE). A joint that moves gets a bone at its pivot, turned by the
// rest bend; IK turns it about the joint's axes (joint_dofs). A FIXED joint stays on the parent's
// bone.
@(private)
joint_build :: proc(b: ^Builder, parent: Frame, socket: geometry.Face, j: Joint) -> Frame {
  a, m := joint_mounts(j)
  female := Frame{parent.bone, geometry.transform_mul(parent.place, geometry.seat(socket, a))}
  dofs, count := joint_dofs(j)
  if count == 0 do return {female.bone, geometry.transform_mul(female.place, geometry.seat(m, PART_FACE))}
  turns: bit_set[Axis]
  for d in dofs[:count] do turns += {d.axis}
  male := Frame{add_bone(b, female.bone, female.place.position, female.place.rotation * dofs[0].rest, turns), geometry.TRANSFORM_IDENTITY}
  switch j.kind {
  case .FIXED:
  case .SPIN:
    // on the pivot (+y toward the parent): the female disc on the parent's side, the male on the joint's
    cylinder(b, female, .FEMALE, j.flange_w / 2, j.flange_t / 2)
    cylinder(b, male, .MALE, j.flange_w / 2, j.flange_t / 2, {0, -j.flange_t / 2, 0})
  case .HINGE:
    hinge_female(b, female, j)
    hinge_male(b, male, j)
  case .BALL:
    ball_female(b, female, j)
    ball_male(b, male, j)
  }
  return {male.bone, geometry.seat(m, PART_FACE)}
}

// part adds a piece of hardware; one without volume (a size set to 0: a hinge without lugs or
// base plates, the knuckles' bare pin) is not built.
@(private = "file")
part :: proc(b: ^Builder, f: Frame, p: Primitive, role: Role, scale: [3]f32, position: [3]f32 = {}, rotation := linalg.QUATERNIONF32_IDENTITY, param: f32 = 0) {
  if scale.x <= 0 || scale.y <= 0 || scale.z <= 0 do return
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
hinge_female :: proc(b: ^Builder, f: Frame, j: Joint) {
  fork(b, f, j, .FEMALE, jaw_width(j), 1, false)
  hinge_base(b, f, j, .FEMALE, 1, j.disc_f)
  hinge_pin(b, f, j)
}

@(private = "file")
hinge_male :: proc(b: ^Builder, f: Frame, j: Joint) {
  fork(b, f, j, .MALE, j.jaw, -1, j.tang)
  hinge_base(b, f, j, .MALE, -1, j.disc_m)
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
