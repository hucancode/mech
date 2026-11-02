package mech

import "core:encoding/json"
import "core:fmt"
import "core:log"
import "core:math"
import "core:math/linalg"
import "core:mem"
import "../mjolnir/geometry"

// A Model is a mech as data: a library of parts, each a handful of primitive shapes with named
// slots and the joints it bolts on with, and an assembly placing them in a tree; drivers move the
// joints. It is a character file's "model" (character.odin) and what the character
// editor edits; rig_create turns one into scene nodes. See docs/modeling.md.
//
// Lengths are in model units (the model's `scale` brings them to world size), angles in radians. Everything refers to everything else by name.

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
// diameter, y the height). A shape that `span`s two of its part's slots ("" is the origin) is a
// link's body: it is placed in the span's frame instead, between the two, +y from the first to the
// second, and its y extent is the distance between them plus size.y, so moving a slot lengthens
// it (span_frame, shape_place). Unspanned, the span's frame is the part's and the distance 0.
Shape :: struct {
  primitive: Primitive,
  param:     f32,
  material:  string,
  span:      [2]string,
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
  FIXED, // no joint: an empty stack bolts the part straight onto the socket with it
  SPIN, // a turntable, one degree of freedom about the socket's normal (y): turns, twists, discs
  HINGE, // a forked hinge with a pin, one degree of freedom about x
  BALL, // a ball and socket: x, y, z
}

// Joint is one mechanism of a part's stack, inline on the part: a part that needs more degrees of
// freedom stacks several. `name` is unique in its part, so drivers can move it. The first bolts
// onto the parent's slot, each next one onto the one before, facing the way it did
// (SLOT_FACE); `twist` first turns its socket about the socket's normal. `bend` turns the first
// degree of freedom at rest (a shoulder hinge holding the arm down from a sideways socket).
// `min`/`max` are its range on each axis it has, from its rest (after `bend`), in radians. The rig
// holds every drive and IK inside them, as a real joint's stops do; an axis whose min and max are
// equal is free.
// `size` scales the hardware: the parameters below are the joint's proportions at size 1 (a
// hinge's width across its lugs, a ball's diameter; joint_scaled), so one number resizes it and
// size 0 builds none. Only the parameters its kind uses matter:
//   HINGE: jaw (the gap between the female lugs), lug_t/lug_d (lug thickness/diameter), shank
//     (the lug's straight length), flange_t (the base plate), pin_r, clr (clearance), pin_out (how
//     far the pin sticks out), tang (a solid male lug), disc_f/disc_m (round base plates). It
//     pivots shank + flange_t out from the socket; with those and the lugs at 0 it is a bare pin
//     pivoting on the socket (knuckles): hardware without volume is not built.
//   BALL: ball_r, socket_t, stud_len, flange_w, flange_t
//   SPIN: flange_w (the discs' diameter), flange_t (both discs, which meet on the pivot)
Joint :: struct {
  name:               string,
  kind:               JointKind,
  size:               f32,
  twist, bend:        f32,
  min, max:           [3]f32,
  jaw, lug_t, lug_d:  f32,
  shank, flange_t:    f32,
  pin_r, clr:         f32,
  pin_out:            f32,
  tang:               bool,
  disc_f, disc_m:     bool,
  ball_r, socket_t:   f32,
  stud_len, flange_w: f32,
}

// Axis is an axis of a joint's frame. A joint turns about the axes its kind has: SPIN y, HINGE
// x, BALL x, y and z.
Axis :: enum u8 {
  X,
  Y,
  Z,
}

// Slot is a named face on a part, in its frame, facing out of the part: where a child is matched.
// Every part also has a default slot, unnamed: its origin (Part).
Slot :: struct {
  name:                      string,
  position, normal, forward: [3]f32,
}

// Part is a rigid piece: its shapes, the slots children are matched with, and `joints`, what it
// moves by: a stack from its parent's slot to its origin, which faces +y toward them (PART_FACE).
// As a parent's slot the origin faces -y (SLOT_FACE). Parts are the model's library; the assembly
// places them, as often as it likes.
Part :: struct {
  name:   string,
  joints: [dynamic]Joint,
  slots:  [dynamic]Slot,
  shapes: [dynamic]Shape,
}

// Instance places a part in the tree: its part's joints bolt onto slot `parent_slot` of the
// parent's part (empty: the parent's origin, facing -y, SLOT_FACE), and its origin onto the last
// joint. A root (no parent) matches the model origin. A `mirror` instance shows its part, slots
// and joints reflected (joint_mirror), so one part serves both sides of the body; drivers move it
// the mirrored way. Instances are listed parents first.
Instance :: struct {
  name:        string,
  part:        string,
  parent:      string,
  parent_slot: string,
  mirror:      bool,
}

// Drive is how a driver moves one joint of one instance: the driver's value running over `from`
// maps linearly onto 0..`turn` (radians), clamped to the ends when `clamp`, about `axis` of joint
// `joint` of instance `part`. The axis must be one the joint has. Drives on one axis add up, and
// onto the joint's own channel (model_channels).
Drive :: struct {
  part, joint: string,
  axis:        Axis,
  from:        [2]f32,
  turn:        f32,
  clamp:       bool,
}

// Driver is one value that moves several joints at once (a curl closing nine knuckles), keyed by
// name like any channel. A single joint needs none: each of its axes is a channel of its own.
// min/max bound editor sliders.
Driver :: struct {
  name:     string,
  min, max: f32,
  drives:   [dynamic]Drive,
}

// Ik reaches instance `tip`'s frame for a target by turning every joint from instance `root`'s
// slot down to the one the tip hangs from (its own joints, an ankle or a wrist, keep the turn their
// channels give; with `hold`, they turn it to face the way those turned it in the model's space
// instead: a planted foot, however the knee bends), each about the axes it has. Its channels are
// named after it (IK_CHANNELS): <name>_x, _y, _z, the target in the model's space (model units)
// as an offset from where the tip is at rest (0: the foot where it stands), <name>_weight, 0
// leaving the chain as its joints' channels put it, 1 reaching; and with `pole`, <name>_pole_x,
// _y, _z, the point the chain bends toward, from the same place.
Ik :: struct {
  name, root, tip: string,
  hold, pole:      bool,
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
  materials: [dynamic]Material,
  hardware:  Hardware,
  drivers:   [dynamic]Driver,
  iks:       [dynamic]Ik,
  parts:     [dynamic]Part,
  assembly:  [dynamic]Instance,
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
  // an instance left unnamed goes by its part's name
  for &inst in m.assembly do if inst.name == "" do inst.name = inst.part
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

model_instance :: proc(m: ^Model, name: string) -> int {
  for p, i in m.assembly do if p.name == name do return i
  return -1
}

// part_slot is slot `name` of part `part`, -1 for none or an unknown one.
part_slot :: proc(m: ^Model, part: int, name: string) -> int {
  if part < 0 || name == "" do return -1
  for s, i in m.parts[part].slots do if s.name == name do return i
  return -1
}

// instance_joints are the joints instance `i` moves by: its part's; none for an unknown part.
instance_joints :: proc(m: ^Model, i: int) -> []Joint {
  part := model_part(m, m.assembly[i].part)
  return m.parts[part].joints[:] if part >= 0 else nil
}

slot_face :: proc(s: Slot) -> geometry.Face {
  return {s.position, s.normal, s.forward}
}

// A pose holds one value per channel (model_channels), in this order:
//   - each driver
//   - each IK target's (IK_CHANNELS): its target, weight, and pole when it has one
//   - the root's six (ROOT_CHANNELS)
//   - every axis of every instance's joints, in assembly order: `<instance>.<joint>` for a joint
//     with one, `<instance>.<joint>.x` (.y, .z) for a ball. A mirrored instance turns the mirrored
//     way, so twins take the same values.
// Clips key them all by name alike.

// IK_CHANNELS: an IK target's channels, after its name; the last three only with a pole.
IK_CHANNELS :: [7]string{"_x", "_y", "_z", "_weight", "_pole_x", "_pole_y", "_pole_z"}

// ROOT_CHANNELS: where the model's origin is moved (x, y, z in model units) and turned (euler
// radians, as shapes are). Clips key them to drop, lift, carry or tip the whole mech, which no
// joint does. Named like an IK target's, `<name>_x`, so editors show each three as one.
ROOT_CHANNELS :: [6]string{"root_x", "root_y", "root_z", "root_turn_x", "root_turn_y", "root_turn_z"}

@(private = "file")
AXIS_NAMES :: [Axis]string{.X = "x", .Y = "y", .Z = "z"}

// ik_channel is the first of IK target `k`'s channels; k = len(m.iks) is the root's first.
ik_channel :: proc(m: ^Model, k: int) -> int {
  n := len(m.drivers)
  for ik in m.iks[:k] do n += 7 if ik.pole else 4
  return n
}

// root_channel is the first of the root's channels.
root_channel :: proc(m: ^Model) -> int {
  return ik_channel(m, len(m.iks))
}

// joint_channel is the first channel of instance `i`'s joints; i = len(m.assembly) is the end.
joint_channel :: proc(m: ^Model, i: int) -> int {
  n := root_channel(m) + len(ROOT_CHANNELS)
  for k in 0 ..< i do for j in instance_joints(m, k) {
    _, count := joint_dofs(j)
    n += count
  }
  return n
}

// model_channels is how many values a pose of `m` holds.
model_channels :: proc(m: ^Model) -> int {
  return joint_channel(m, len(m.assembly))
}

// model_channel is the channel named `name`, -1 for none.
model_channel :: proc(m: ^Model, name: string) -> int {
  if d := model_driver(m, name); d >= 0 do return d
  suffixes := IK_CHANNELS
  for ik, k in m.iks {
    if len(name) <= len(ik.name) || name[:len(ik.name)] != ik.name do continue
    for x, n in suffixes[:7 if ik.pole else 4] do if name[len(ik.name):] == x do return ik_channel(m, k) + n
  }
  roots := ROOT_CHANNELS
  for r, k in roots do if r == name do return root_channel(m) + k
  n := root_channel(m) + len(ROOT_CHANNELS)
  for inst, i in m.assembly {
    for j in instance_joints(m, i) {
      dofs, count := joint_dofs(j)
      for d in dofs[:count] {
        if is_joint_channel(name, inst.name, j.name, d.axis, count) do return n
        n += 1
      }
    }
  }
  return -1
}

// channel_name is channel `i`'s name, allocated with `allocator` when it is made up.
channel_name :: proc(m: ^Model, i: int, allocator := context.temp_allocator) -> string {
  if i < len(m.drivers) do return m.drivers[i].name
  suffixes, roots := IK_CHANNELS, ROOT_CHANNELS
  for ik, k in m.iks {
    first := ik_channel(m, k)
    if i < first + (7 if ik.pole else 4) do return fmt.aprint(ik.name, suffixes[i - first], sep = "", allocator = allocator)
  }
  root := root_channel(m)
  if i < root + len(ROOT_CHANNELS) do return roots[i - root]
  n := root + len(ROOT_CHANNELS)
  for inst, k in m.assembly {
    for j in instance_joints(m, k) {
      dofs, count := joint_dofs(j)
      if i < n + count do return joint_channel_name(inst.name, j.name, dofs[i - n].axis, count, allocator)
      n += count
    }
  }
  return ""
}

// is_joint_channel: whether `name` is the channel of `axis` of joint `joint` of instance `inst`.
@(private = "file")
is_joint_channel :: proc(name, inst, joint: string, axis: Axis, count: int) -> bool {
  axes := AXIS_NAMES
  rest := name
  for word, k in ([3]string{inst, joint, axes[axis]}) {
    if k == 2 && count == 1 do break
    if k > 0 {
      if len(rest) == 0 || rest[0] != '.' do return false
      rest = rest[1:]
    }
    if len(rest) < len(word) || rest[:len(word)] != word do return false
    rest = rest[len(word):]
  }
  return rest == ""
}

@(private = "file")
joint_channel_name :: proc(inst, joint: string, axis: Axis, count: int, allocator: mem.Allocator) -> string {
  axes := AXIS_NAMES
  if count == 1 do return fmt.aprint(inst, ".", joint, sep = "", allocator = allocator)
  return fmt.aprint(inst, ".", joint, ".", axes[axis], sep = "", allocator = allocator)
}

model_driver :: proc(m: ^Model, name: string) -> int {
  if name == "" do return -1
  for d, i in m.drivers do if d.name == name do return i
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

// part_point is where slot `name` of part `p` sits in its frame: "" is the origin. ok is false
// for a slot the part lacks (the origin is used).
part_point :: proc(p: Part, name: string) -> (at: [3]f32, ok: bool) {
  if name == "" do return {}, true
  for s in p.slots do if s.name == name do return s.position, true
  return {}, false
}

// span_frame is the frame a shape spanning slots `span` of part `p` sits in, in the part's frame:
// centred between the two, +y from the first to the second, +x as near the part's +x as that
// allows (its +z when the span runs along x); `length` is the distance between them. Two slots in
// the same place (no span: both the origin) give the part's own frame and length 0.
span_frame :: proc(p: Part, span: [2]string) -> (position: [3]f32, rotation: quaternion128, length: f32) {
  a, _ := part_point(p, span[0])
  b, _ := part_point(p, span[1])
  position, length = (a + b) / 2, linalg.length(b - a)
  if length < 1e-6 do return position, linalg.QUATERNIONF32_IDENTITY, 0
  y := (b - a) / length
  x := [3]f32{1, 0, 0} if abs(y.x) < 0.999 else [3]f32{0, 0, 1}
  x = linalg.normalize(x - linalg.dot(x, y) * y)
  z := linalg.cross(x, y)
  rotation = linalg.normalize(linalg.quaternion_from_matrix3_f32(matrix[3, 3]f32{x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z}))
  return
}

// shape_place is where shape `s` of part `p` sits in the part's frame: its span's frame
// (span_frame), then its own position and rotation; `size` is its extent, the span's length added
// to its y.
shape_place :: proc(p: Part, s: Shape) -> (position: [3]f32, rotation: quaternion128, size: [3]f32) {
  at, turn, length := span_frame(p, s.span)
  return at + linalg.quaternion_mul_vector3(turn, s.position), linalg.normalize(turn * euler(s.rotation)), s.size + {0, length, 0}
}

// shape_faces are the centres of a shape's six faces with their outward normals, in its part's
// frame: +x, -x, +y, -y, +z, -z of the shape's own axes. Round shapes use their bounding box.
// Editors snap slots to them.
shape_faces :: proc(p: Part, s: Shape) -> (faces: [6]geometry.Face) {
  at, q, size := shape_place(p, s)
  for &f, i in faces {
    axis: [3]f32
    axis[i / 2] = 1 if i % 2 == 0 else -1
    n := linalg.quaternion_mul_vector3(q, axis)
    f.position = at + n * size[i / 2] / 2
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
