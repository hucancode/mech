package mech

import "core:math"
import "core:math/linalg"
import "../mjolnir/geometry"

// Joint hardware, after mjolnir's Atlas example (examples/creative/atlas): forked hinges with lugs
// and a pin (PIN), ball and socket joints (BALL), and turntables (SPIN). Every joint adds a bone at its pivot,
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

// Dims measures every piece of a joint's hardware, in model units. joint_dims derives them from
// the joint's few values, so they always fit together: a lug clears the plate it rises from, a pin
// sits inside its lug, a ball's flange clears the socket over the joint's range.
@(private)
Dims :: struct {
  reach:                               f32, // a hinge's pivot, out from the socket
  jaw, lug_t, lug_d, shank:            f32, // a hinge's lugs: the gap between the male's, their thickness, diameter, straight length
  pin_r, clr, pin_out:                 f32, // its pin, the clearance between the lugs, how far the pin sticks out
  flange_t:                            f32, // base plates: a hinge's, a ball's flanges, a turntable's discs
  flange_w:                            f32, // a ball's female flange, a turntable's discs: diameter
  round_top, round_bottom:            bool, // a hinge's base plates are discs: the top (the parent's side), the bottom (the part's)
  ball_r, socket_r, stud_r, stud_len: f32, // a ball, its socket's outer radius, the stud carrying it
  barrel_r, barrel_len, rod_r:        f32, // a linear actuator's barrel and the rod sliding out of it
}

// Hardware proportions at size 1.
@(private = "file")
LUG_D :: 1 // a hinge's lug diameter, when its reach has room
@(private = "file")
LUG_MIN :: 0.3 // the smallest lug worth building: closer in, a hinge is a bare pin
@(private = "file")
GAP :: 0.05 // between a lug's barrel and the plate it rises from
@(private = "file")
BALL_R :: 0.5
@(private = "file")
BALL_TILT :: 70 * math.RAD_PER_DEG // as far as a ball tilts before its stud meets the socket's rim

// joint_dims measures `j`'s hardware at its size. A hinge's base plate takes part of its reach and
// the lugs the rest, shrinking to fit; with too little room for a lug it is a bare pin pivoting on
// the socket. A ball's stud is as long as its tilt needs to keep the flange off the socket.
@(private)
joint_dims :: proc(j: Joint) -> (d: Dims) {
  switch j.kind {
  case .SPIN:
    d.flange_w, d.flange_t = 1, 0.25
  case .PIN:
    plate := min(0.55, 0.4 * j.reach)
    lug := min(LUG_D, 2 * (j.reach - plate - GAP))
    if lug < LUG_MIN {
      d.jaw, d.clr, d.pin_r, d.pin_out = 1, 0.05, 0.35, 0.1 // a bare pin across the joint's width
      break
    }
    d.reach, d.flange_t, d.shank, d.lug_d = j.reach, plate, j.reach - plate, lug
    d.jaw, d.lug_t, d.clr = 0.5, 0.25, 0.05
    d.pin_r, d.pin_out = 0.4 * lug / 2, 0.075
  case .LINEAR:
    // the barrel holds the rod over its whole stroke, its end a rod's width in
    d.barrel_r, d.rod_r = 0.5, 0.25
    d.barrel_len = max(1, (max(j.max[1], 0) - min(j.min[1], 0)) / max(j.size, 1e-6) + 0.5)
  case .BALL:
    d.ball_r, d.flange_w, d.flange_t = BALL_R, 1.35, 0.2
    d.socket_r = BALL_R + 0.24
    d.stud_r = 0.3 * BALL_R
    // the male flange's rim, radius f, `top` out on the stud, tilted by t, stays out of the socket
    // when it is either still above the socket's top or already past its side
    t := ball_tilt(j)
    f := 0.375 * d.flange_w
    top := max(BALL_R + 0.1, min(f * math.tan(t), d.socket_r * math.sin(t)) + 0.02)
    d.stud_len = top - BALL_R
  }
  for p in ([]^f32{&d.reach, &d.jaw, &d.lug_t, &d.lug_d, &d.shank, &d.pin_r, &d.clr, &d.pin_out, &d.flange_t, &d.flange_w, &d.ball_r, &d.socket_r, &d.stud_r, &d.stud_len, &d.barrel_r, &d.barrel_len, &d.rod_r}) do p^ *= j.size
  return
}

// joint_has_plates: whether a pin hinge builds base plates, which are round next to a turntable
joint_has_plates :: proc(j: Joint) -> bool {
  return j.kind == .PIN && joint_dims(j).flange_t > 0
}

// joint_bare: a pin hinge with hardware whose reach is too short for lugs, built as a bare pin
joint_bare :: proc(j: Joint) -> bool {
  return j.kind == .PIN && j.size > 0 && joint_dims(j).lug_d == 0
}

// ball_tilt: how far a ball joint's range tilts its stud from upright (about x and z together), up to
// BALL_TILT; a free axis tilts that far.
@(private = "file")
ball_tilt :: proc(j: Joint) -> f32 {
  c: f32 = 1
  for k in ([]int{0, 2}) {
    if j.min[k] == j.max[k] do return BALL_TILT
    c *= math.cos(min(max(abs(j.min[k]), abs(j.max[k])), BALL_TILT))
  }
  return min(math.acos(c), BALL_TILT)
}

// PART_FACE is a part's unnamed slot as the child of a match: its frame's origin, +y toward the
// joint, +x forward. It also sits each joint of a stack on the one before.
PART_FACE :: geometry.Face{{}, Y, X}

// SLOT_FACE is an unnamed slot: the parent's origin, facing -y, which seats PART_FACE unturned on a
// joint pivoting on it (a root on the model origin, each next joint of a part's stack).
SLOT_FACE :: geometry.Face{{}, NEG_Y, X}

// joint_mounts: the face a joint bolts to its parent's socket with, and the face its part bolts
// to (with PART_FACE), in the joint's frame. A hinge pivots its reach out from the socket (on it
// as a bare pin: knuckles); joints without hardware pivot on the socket itself.
joint_mounts :: proc(j: Joint) -> (a, b: geometry.Face) {
  d := joint_dims(j)
  switch j.kind {
  case .BALL:
    return {{0, -(d.ball_r * 0.55 + d.flange_t), 0}, NEG_Y, Z}, {{0, d.ball_r + d.stud_len + d.flange_t, 0}, Y, Z}
  case .SPIN:
    // a turntable: two discs meeting on the pivot
    return {{0, d.flange_t / 2, 0}, Y, X}, {{0, -d.flange_t / 2, 0}, NEG_Y, X}
  case .PIN:
    return {{0, d.reach, 0}, Y, X}, {{0, -d.reach, 0}, NEG_Y, X}
  case .LINEAR:
    // the barrel's mouth is the pivot, the barrel back toward the parent; the part on the rod's end
    return {{0, d.barrel_len, 0}, Y, X}, {{0, -d.rod_r, 0}, NEG_Y, X}
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
// its female face's forward d; a turn about d keeps its sign, the others turn over. The part's
// frame sits on that reflected joint the same way (PART_FACE), so its shapes and slots are
// reflected across the same plane, seen from the part.
joint_mirror :: proc(j: Joint) -> Mirror {
  a, m := joint_mounts(j)
  return face_mirror(a.forward, m)
}

// face_mirror reflects across direction `d` what sits (with PART_FACE) on face `m`: joint_mirror's,
// and with no joint (a part bolted on rigid: d the socket's forward, m SLOT_FACE) the part's own.
face_mirror :: proc(d: [3]f32, m: geometry.Face) -> (out: Mirror) {
  for k in Axis do out.turn[k] = abs(d[int(k)]) < 0.5
  I :: matrix[3, 3]f32{1, 0, 0, 0, 1, 0, 0, 0, 1}
  td := I - 2 * linalg.outer_product(d, d)
  r0 := linalg.matrix3_from_quaternion(geometry.seat(m, PART_FACE).rotation)
  out.reflect = linalg.transpose(r0) * td * r0
  out.offset = linalg.transpose(r0) * (td * m.position - m.position)
  return
}

// mirror_shift is `mi` seen from a frame `length` below: a part's origin, below where it hangs.
mirror_shift :: proc(mi: Mirror, length: f32) -> Mirror {
  out := mi
  up := [3]f32{0, length, 0}
  out.offset = mi.offset + up - mi.reflect * up
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

// joint_axes are the axes of its frame a joint moves on, in channel order: a pin's x, a
// turntable's y (a twisted socket points either any way), a linear actuator's y (out along the
// socket's normal), a ball's x, y, z.
joint_axes :: proc(j: Joint) -> (axes: [3]Axis, count: int) {
  switch j.kind {
  case .PIN:
    return {.X, .X, .X}, 1
  case .SPIN:
    return {.Y, .Y, .Y}, 1
  case .LINEAR:
    return {.Y, .Y, .Y}, 1
  case .BALL:
    return {.X, .Y, .Z}, 3
  }
  return
}

// joint_turns: the axes a joint's bone turns about (IK too): a hinge's or a ball's; a linear
// actuator slides, turning about none.
@(private)
joint_turns :: proc(j: Joint) -> (turns: bit_set[Axis]) {
  if j.kind == .LINEAR do return
  axes, count := joint_axes(j)
  for a in axes[:count] do turns += {a}
  return
}

// joint_build bolts joint `j` onto `socket` of `parent` and returns the frame its male half bolts
// the next joint or the part on (with PART_FACE). It gets a bone at its pivot, which its channel
// and IK turn about its axes (joint_turns). `round`: a pin hinge's top and
// bottom plates turn on a turntable next to it in the stack, so are round.
@(private)
joint_build :: proc(b: ^Builder, parent: Frame, socket: geometry.Face, j: Joint, round: [2]bool) -> Frame {
  a, m := joint_mounts(j)
  female := Frame{parent.bone, geometry.transform_mul(parent.place, geometry.seat(socket, a))}
  male := Frame{add_bone(b, female.bone, female.place.position, female.place.rotation, joint_turns(j)), geometry.TRANSFORM_IDENTITY}
  d := joint_dims(j)
  d.round_top, d.round_bottom = round[0], round[1]
  switch j.kind {
  case .LINEAR:
    // the barrel from the mouth back to the parent; the rod from the part's end back into it
    cylinder(b, female, .FEMALE, d.barrel_r, d.barrel_len)
    cylinder(b, male, .METAL, d.rod_r, d.barrel_len - d.rod_r, {0, -d.rod_r, 0})
  case .SPIN:
    // on the pivot (+y toward the parent): the female disc on the parent's side, the male on the joint's
    cylinder(b, female, .FEMALE, d.flange_w / 2, d.flange_t / 2)
    cylinder(b, male, .MALE, d.flange_w / 2, d.flange_t / 2, {0, -d.flange_t / 2, 0})
  case .PIN:
    hinge_female(b, female, d)
    hinge_male(b, male, d)
  case .BALL:
    ball_female(b, female, d)
    ball_male(b, male, d)
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
jaw_width :: proc(d: Dims) -> f32 {
  return d.jaw + 2 * d.lug_t + 2 * d.clr
}

@(private = "file")
lug :: proc(b: ^Builder, f: Frame, d: Dims, role: Role, thickness, x, up: f32) {
  part(b, f, .CYLINDER, role, {d.lug_d / 2, thickness - 0.002, d.lug_d / 2}, {x, 0, 0}, linalg.quaternion_angle_axis(-math.PI / 2, Z))
  box(b, f, role, {thickness, d.shank, d.lug_d}, {x, up * d.shank / 2, 0})
}

@(private = "file")
hinge_base :: proc(b: ^Builder, f: Frame, d: Dims, role: Role, up: f32) {
  width := (jaw_width(d) if up > 0 else d.jaw) + 2 * d.lug_t
  y := up * (d.shank + d.flange_t / 2)
  if d.round_top if up > 0 else d.round_bottom do cylinder(b, f, role, math.hypot(width, d.lug_d) / 2, d.flange_t, {0, y - d.flange_t / 2, 0})
  else do box(b, f, role, {width, d.flange_t, d.lug_d}, {0, y, 0})
}

@(private = "file")
hinge_pin :: proc(b: ^Builder, f: Frame, d: Dims) {
  half := jaw_width(d) / 2 + d.lug_t + max(0.005, d.pin_out)
  part(b, f, .CYLINDER, .METAL, {d.pin_r, 2 * half, d.pin_r}, {}, linalg.quaternion_angle_axis(-math.PI / 2, Z))
}

// hinge_female: two lugs either side of the male one, rising from its base plate, and the pin
@(private = "file")
hinge_female :: proc(b: ^Builder, f: Frame, d: Dims) {
  x := jaw_width(d) / 2 + d.lug_t / 2
  lug(b, f, d, .FEMALE, d.lug_t, -x, 1)
  lug(b, f, d, .FEMALE, d.lug_t, x, 1)
  hinge_base(b, f, d, .FEMALE, 1)
  hinge_pin(b, f, d)
}

// hinge_male: one solid lug between the female ones, on its base plate
@(private = "file")
hinge_male :: proc(b: ^Builder, f: Frame, d: Dims) {
  lug(b, f, d, .MALE, d.jaw + 2 * d.lug_t, 0, -1)
  hinge_base(b, f, d, .MALE, -1)
}

@(private = "file")
ball_female :: proc(b: ^Builder, f: Frame, d: Dims) {
  drop := d.ball_r * 0.55
  cylinder(b, f, .FEMALE, d.flange_w / 2, d.flange_t, {0, -drop - d.flange_t, 0})
  cylinder(b, f, .FEMALE, d.socket_r, drop, {0, -drop, 0})
}

@(private = "file")
ball_male :: proc(b: ^Builder, f: Frame, d: Dims) {
  top := d.ball_r + d.stud_len
  part(b, f, .SPHERE, .METAL, {d.ball_r, d.ball_r, d.ball_r})
  cylinder(b, f, .METAL, d.stud_r, top)
  cylinder(b, f, .MALE, d.flange_w * 0.375, d.flange_t, {0, top, 0})
}
