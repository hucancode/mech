package mech

import "core:encoding/json"
import "core:log"
import "core:math"
import "core:math/linalg"
import "core:mem"
import "../mjolnir/geometry"

// A Model is a mech as data: a tree of parts bolted together by joints, every part a handful of
// primitive shapes. It is a character file's "model" (character.odin) and what the character
// editor edits; rig_create turns one into scene nodes. See docs/modeling.md.
//
// Lengths are in model units (the model's `scale` brings them to world size), angles in radians. Parts and shapes refer to each other, to joints, channels and materials by name.

// Primitive is the mesh a shape draws. Every piece of every model is one of these, so a whole
// scene of mechs draws a handful of meshes (see Library and docs/rendering.md).
Primitive :: enum u8 {
  BOX, // a box
  WEDGE, // a box whose top slopes down toward +z; param: how far the front top edge drops (0..1)
  CYLINDER, // along y
  HALF_CYLINDER, // half a cylinder along y (a 180 degree arc)
  QUARTER_CYLINDER, // a 90 degree slice of a cylinder along y
  CONE, // along y, apex up; param: top radius / bottom radius (0 is a point, 1 a cylinder)
  SPHERE,
}

// Shape is one primitive in its part's frame: centred at `position`, turned by `rotation` (euler
// radians, see euler), `size` its full extent on each axis (for round shapes x and z are the
// diameter, y the height).
Shape :: struct {
  primitive: Primitive,
  param:     f32,
  material:  string,
  position:  [3]f32,
  rotation:  [3]f32,
  size:      [3]f32,
}

Material :: struct {
  name:      string,
  color:     [3]f32,
  metallic:  f32,
  roughness: f32,
  emissive:  f32,
}

JointKind :: enum u8 {
  FIXED, // no hardware and no degree of freedom: the part is bolted straight onto the socket
  SPIN, // no hardware, one degree of freedom about the socket's normal
  HINGE, // a forked hinge with a pin: one about x
  HINGE_TWIST, // a forked hinge, then a twist about the child's length: x, y
  PIN, // a bare pin (a knuckle): one about x
  DISC_HINGE, // a disc turning on its face, a hinge, then a twist: y, x, y
  WRIST, // a hinge, a cross hinge below it, then a twist: x, x (turned), y
  BALL, // a ball and socket: x, y, z
}

// Joint is a reusable joint spec; parts name it. Only the fields a kind uses matter:
//   hinges (HINGE, HINGE_TWIST, DISC_HINGE, WRIST, PIN): jaw (the gap between the female lugs),
//     lug_t/lug_d (lug thickness/diameter), shank (the lug's straight length), flange_t (the
//     base plate), pin_r, clr (clearance), pin_out (how far the pin sticks out), tang (a solid
//     male lug), disc_f/disc_m (round base plates)
//   BALL: ball_r, socket_t, stud_len, flange_w, flange_t
Joint :: struct {
  name:               string,
  kind:               JointKind,
  jaw, lug_t, lug_d:  f32,
  shank, flange_t:    f32,
  pin_r, clr:         f32,
  pin_out:            f32,
  tang:               bool,
  disc_f, disc_m:     bool,
  ball_r, socket_t:   f32,
  stud_len, flange_w: f32,
}

// Bind ties one of a joint's degrees of freedom to a channel; `sign` mirrors it (-1) so a channel
// can read the same on both sides of the body. An empty channel leaves the axis still.
Bind :: struct {
  channel: string,
  sign:    f32,
}

// Part is a rigid piece of the model. A root part (no parent) sits at the model origin. Any other
// part is bolted to its parent: the joint's female half goes on `socket` (a face in the parent's
// frame), and the part's own `mount` face goes on the joint's male half. `centered` puts the
// joint's pivot on the socket itself instead of a joint's reach away (a jaw hinged inside a head).
// Parts are listed parents first.
Part :: struct {
  name:     string,
  parent:   string,
  socket:   geometry.Face,
  joint:    string,
  centered: bool,
  binds:    [3]Bind,
  mount:    geometry.Face,
  shapes:   [dynamic]Shape,
}

// Channel is one animatable value, used as it is: radians when it turns a joint, any number when
// it feeds a driver or the pelvis level (a hand's curl, the pelvis height). min/max bound editor
// sliders.
Channel :: struct {
  name:     string,
  min, max: f32,
}

// Driver sets channel `target` from channel `source` every pose: `source` running over `from`
// maps linearly onto `to` (in each channel's units), clamped to the ends when `clamp`. One curl
// channel closing three knuckles is three drivers.
Driver :: struct {
  target, source: string,
  from, to:       [2]f32,
  clamp:          bool,
}

// Leg names a leg's hip, knee and ankle swing channels. Posing keeps each foot from sinking
// below its rest height with two-link IK, and levels it while it is down. The leg must hang
// straight down at rest and swing in the model's y-z plane.
Leg :: struct {
  hip, knee, ankle: string,
}

// Hardware: the materials joint hardware is painted in.
Hardware :: struct {
  female, male, metal: string,
}

Model :: struct {
  name:      string,
  scale:     f32,
  // ground lifts the model so its lowest point at rest is at y = 0
  ground:    bool,
  // level names a channel (-1 to 0): -1 lowers the pelvis as far as a 60 degree knee bend, the
  // legs' IK keeping the feet down
  level:     string,
  materials: [dynamic]Material,
  hardware:  Hardware,
  joints:    [dynamic]Joint,
  channels:  [dynamic]Channel,
  drivers:   [dynamic]Driver,
  legs:      [dynamic]Leg,
  parts:     [dynamic]Part,
  arena:     mem.Dynamic_Arena `json:"-"`,
}

// model_parse reads a model from its JSON text. Everything it holds lives in the model's
// arena; free it with model_destroy. files.odin loads and saves files on platforms with them.
model_parse :: proc(data: []u8, what := "model") -> (m: ^Model, ok: bool) {
  m = new(Model)
  mem.dynamic_arena_init(&m.arena)
  if err := json.unmarshal(data, m, allocator = model_allocator(m)); err != nil {
    log.errorf("cannot parse %s: %v", what, err)
    model_destroy(m)
    return nil, false
  }
  if m.scale == 0 do m.scale = 1
  return m, true
}

model_destroy :: proc(m: ^Model) {
  mem.dynamic_arena_destroy(&m.arena)
  free(m)
}

// model_allocator allocates into the model's arena, freed with the model: use it for names and
// lists the editors add.
model_allocator :: proc(m: ^Model) -> mem.Allocator {
  return mem.dynamic_arena_allocator(&m.arena)
}

// model_format is the model as JSON text (see json.odin), allocated with `allocator`.
model_format :: proc(m: ^Model, allocator := context.allocator) -> string {
  return format_json(m^, allocator)
}

model_part :: proc(m: ^Model, name: string) -> int {
  for p, i in m.parts do if p.name == name do return i
  return -1
}

model_joint :: proc(m: ^Model, name: string) -> int {
  for j, i in m.joints do if j.name == name do return i
  return -1
}

model_channel :: proc(m: ^Model, name: string) -> int {
  if name == "" do return -1
  for c, i in m.channels do if c.name == name do return i
  return -1
}

model_material :: proc(m: ^Model, name: string) -> int {
  for mat, i in m.materials do if mat.name == name do return i
  return -1
}

// euler turns euler angles in radians into a rotation: about x, then y, then z, each about the
// already turned axes (R = Rx * Ry * Rz).
euler :: proc(r: [3]f32) -> quaternion128 {
  qx := linalg.quaternion_angle_axis_f32(r.x, {1, 0, 0})
  qy := linalg.quaternion_angle_axis_f32(r.y, {0, 1, 0})
  qz := linalg.quaternion_angle_axis_f32(r.z, {0, 0, 1})
  return linalg.normalize(qx * qy * qz)
}

// shape_faces are the centres of a shape's six faces with their outward normals, in its part's
// frame: +x, -x, +y, -y, +z, -z of the shape's own axes. Round shapes use their bounding box.
// Editors snap sockets to them.
shape_faces :: proc(s: Shape) -> (faces: [6]geometry.Face) {
  q := euler(s.rotation)
  for &f, i in faces {
    axis: [3]f32
    axis[i / 2] = 1 if i % 2 == 0 else -1
    n := linalg.quaternion_mul_vector3(q, axis)
    f.position = s.position + n * s.size[i / 2] / 2
    f.normal = n
  }
  return
}

// euler_from is euler's inverse, in radians.
euler_from :: proc(q: quaternion128) -> [3]f32 {
  m := linalg.matrix3_from_quaternion_f32(q)
  c := math.hypot(m[0, 0], m[0, 1])
  x, y, z: f32
  y = math.atan2(m[0, 2], c)
  if c > 1e-5 {
    x = math.atan2(-m[1, 2], m[2, 2])
    z = math.atan2(-m[0, 1], m[0, 0])
  } else {
    x = math.atan2(m[2, 1], m[1, 1])
  }
  // the same rotation, flipped through y = 90 degrees; keep whichever turns less
  if c > 1e-5 {
    fx, fy, fz := x - math.copy_sign(f32(math.PI), x), math.copy_sign(f32(math.PI), y) - y, z - math.copy_sign(f32(math.PI), z)
    if abs(fx) + abs(fy) + abs(fz) < abs(x) + abs(y) + abs(z) - 1e-4 do x, y, z = fx, fy, fz
  }
  out := [3]f32{x, y, z}
  for &a in out do a = math.round(a * 10000) / 10000 + 0
  return out
}
