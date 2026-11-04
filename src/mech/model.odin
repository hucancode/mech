package mech

import "core:encoding/json"
import "core:fmt"
import "core:log"
import "core:math"
import "core:math/linalg"
import "core:mem"
import "core:slice"
import "../mjolnir/geometry"

// A Model is a mech as data: a library of parts, each a handful of primitive shapes with named
// slots and the joints it bolts on with, and an assembly placing them in a tree; channels move the
// joints (model_channel_table). It is a character file's "model" (character.odin) and what the character
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
// diameter, y the height). A shape that `stretch`es is a link's body: it runs the part's length,
// from its origin up to where it hangs, centred between the two, and its y extent is the length
// plus size.y, so the part's length lengthens it (shape_place).
Shape :: struct {
  primitive: Primitive,
  param:     f32,
  material:  string,
  stretch:   bool,
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
  HINGE, // one turn about its `axis`: X a forked hinge with a pin, Y a turntable (a spin servo)
  LINEAR, // a linear actuator, a piston: one slide out along its `axis` (Y: the socket's normal, -y), in model units
  BALL, // a ball and socket: a rotation about x, y, z
}

// Joint is one mechanism of a part's stack, inline on the part: a part that needs more motion
// stacks several (a turntable then a hinge: a shoulder). Each is one bone and one channel
// (joint_axes: a HINGE, a SLIDE or a BALL). `name` is unique in its part, so a channel can name
// it. The first bolts onto the parent's slot, each next one onto the one before, facing the way it
// did (SLOT_FACE). A part with no joints bolts on rigid. A part's joints are all straight: how an
// instance sets them at rest (turned on their sockets, bent) is the assembly's (InstanceJoint).
// `axis` is the one axis of its frame a hinge turns about or a linear actuator slides along (a
// ball turns about all three).
// `min`/`max` are its stops, from rest (after the instance's bend), per axis of its frame (x, y,
// z): a hinge's or a linear actuator's on its axis, a ball's x, y, z (radians; model units out for
// a slide). The rig holds every drive and IK inside them, as a real joint's stops do; equal ends
// are free.
// `size` scales the hardware (about a hinge's lug, a ball's, a disc's or a barrel's diameter); 0
// builds none, the joint pivoting on its socket. Every piece of hardware is measured from these few
// values (joint_dims), so any of them build hardware that fits together:
//   HINGE about X: `reach`, times the size, is how far out from the socket it pivots; the lugs and
//     base plates fit in it. Too close for lugs, it is a bare pin on the socket (knuckles). A base
//     plate next to a turntable in the stack is round (the turntable it turns on); otherwise square.
//   HINGE about Y: a turntable, two discs meeting on the pivot.
//   BALL: its neck is as long as its range needs, so the flange clears the socket.
//   LINEAR: a barrel on the parent's side, as long as the stroke needs, and a rod out of it.
Joint :: struct {
  name:     string,
  kind:     JointKind,
  axis:     Axis,
  size:     f32,
  reach:    f32,
  min, max: [3]f32,
}

// Axis is an axis of a joint's frame. A joint moves on the axes joint_axes gives: a hinge's or a
// linear actuator's `axis`, a ball's x, y and z.
Axis :: enum u8 {
  X,
  Y,
  Z,
}

// Slot is a named face on a part, in its frame, facing out of the part: where a child is matched.
// Every part also has a default slot, unnamed: its origin, facing -y (Part), the next link of a
// chain's seat; named slots are for its branches.
Slot :: struct {
  name:                      string,
  position, normal, forward: [3]f32,
}

// Part is a rigid piece: its shapes, the slots children are matched with, and `joints`, what it
// moves by: a stack from its parent's slot to where it hangs, `length` above its origin, facing +y
// toward them (part_face). Its origin is its default slot, facing -y (SLOT_FACE): a link's far end,
// where the next one of a chain is matched. With no length the part hangs by its origin. Parts are
// the model's library; the assembly places them, as often as it likes.
Part :: struct {
  name:   string,
  length: f32,
  joints: [dynamic]Joint,
  slots:  [dynamic]Slot,
  shapes: [dynamic]Shape,
}

// Instance places a part in the tree: its part's joints bolt onto slot `parent_slot` of the
// parent's part (empty: the parent's origin, facing -y, SLOT_FACE), and its origin onto the last
// joint. A root (no parent) matches the model origin. An instance that names another as its
// `mirror` is that one's other side, its twin (model_twin): it shows its part, slots and joints
// reflected (joint_mirror), so one part serves both sides of the body, and its channels move it the
// mirrored way, so twins take the same values for a mirror image. A clip's move can move twins
// together (Move.twin). `joints` sets its part's joints at rest (InstanceJoint); those it leaves
// out are straight. Instances are listed parents first.
Instance :: struct {
  name:        string,
  part:        string,
  parent:      string,
  parent_slot: string,
  mirror:      string,
  joints:      [dynamic]InstanceJoint,
}

// InstanceJoint is how an instance sets joint `name` of its part at rest: `twist` first turns the
// joint's socket about its normal (a wrist's second hinge across the first), `bend` turns its
// first axis (a shoulder hinge holding the arm down from a sideways socket), in radians. The joint's
// range is from there. The part stays straight, so one part can sit in several stances.
InstanceJoint :: struct {
  name:        string,
  twist, bend: f32,
}

// Ik reaches instance `tip`'s frame for a target by turning every joint from its chain's root
// (ik_root: below the nearest branch above the tip) down to the one the tip hangs from, each about
// the axes it has. The tip's own joints (an ankle, a wrist) turn it to face the way their channels
// turned it in the model's space: a planted foot stays as the clip angles it, however the knee
// bends. The chain bends toward a pole the rig works out (ik_pole). Its channels are named after it
// (model_channel_table): <name>, a POSITION, the target in the model's space (model units) as an
// offset from where the tip is at rest (0: the foot where it stands); <name>.swivel, radians turning the way
// the chain bends about the line from its limb's root (the joint above its middle one: a hip, a
// shoulder) to the target (0: the pole worked out; an elbow flared, a knee swung out); and
// <name>.weight, 0 leaving the chain as its joints' channels put it, 1 reaching. An aiming one
// has no bend, so no swivel.
// With `aim`, the chain (the tip's own joints too: a neck) turns the tip to face the target
// instead of reaching it: a head looking, a gun aiming. The target is then an offset from a
// point ahead of the tip at rest (+z, as far ahead as the tip is high).
Ik :: struct {
  name, tip: string,
  aim:       bool,
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
  iks:       [dynamic]Ik,
  // pose is the rest pose clips start from and add onto: a move's channel amounts (its delay
  // unused), every other channel 0; with a twin (WITH), both sides of the body at once. A
  // character's stance: its arms hanging, its legs reaching for the ground (their IK weights 1).
  pose:      Move,
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

// instance_rest is how instance `inst` sets its part's joint `joint` at rest (InstanceJoint): 0, 0
// (straight) when it doesn't say.
instance_rest :: proc(inst: Instance, joint: string) -> (twist, bend: f32) {
  for x in inst.joints do if x.name == joint do return x.twist, x.bend
  return
}

// instance_joints are the joints instance `i` moves by: its part's; none for an unknown part.
instance_joints :: proc(m: ^Model, i: int) -> []Joint {
  part := model_part(m, m.assembly[i].part)
  return m.parts[part].joints[:] if part >= 0 else nil
}

slot_face :: proc(s: Slot) -> geometry.Face {
  return {s.position, s.normal, s.forward}
}

// ChannelKind is what a channel moves, and so how many values it holds (CHANNEL_SIZE). A mech is
// rigid: things turn and slide, nothing scales or bends.
//   HINGE     1, radians: a hinge's turn about its axis, an IK's swivel
//   SLIDE     1, model units: a linear actuator's slide along its axis
//   BALL      3, euler radians: a ball's rotation, the root's turn
//   POSITION  3, model units: an IK target, the root's place; the only kind an Arc moves
//   WEIGHT    1, 0 to 1: an IK's, how much it reaches
ChannelKind :: enum u8 {
  HINGE,
  SLIDE,
  BALL,
  POSITION,
  WEIGHT,
}

CHANNEL_SIZE :: [ChannelKind]int {
  .HINGE    = 1,
  .SLIDE    = 1,
  .BALL     = 3,
  .POSITION = 3,
  .WEIGHT   = 1,
}

// JOINT_CHANNEL is the kind of channel a joint of each kind has.
JOINT_CHANNEL :: [JointKind]ChannelKind {
  .HINGE  = .HINGE,
  .LINEAR = .SLIDE,
  .BALL   = .BALL,
}

// Channel is one thing a pose moves, by name: its values are a pose's [first:][:CHANNEL_SIZE[kind]].
Channel :: struct {
  name:  string,
  kind:  ChannelKind,
  first: int,
}

// A pose holds every channel's values (model_channel_table), one channel after another:
//   - each IK target's: `<ik>` its target (POSITION), `<ik>.swivel` (HINGE), `<ik>.weight` (WEIGHT),
//     IK_VALUES in all
//   - the root's: `root` (POSITION), `root.turn` (BALL), ROOT_VALUES in all
//   - each joint's, in assembly order: `<instance>.<joint>`, shaped as its kind (JOINT_CHANNEL). A
//     mirrored instance turns the mirrored way, so twins take the same values.
// Clips key them all by name alike, a value shaped as the channel is (Value).
IK_VALUES :: 5
IK_SWIVEL :: 3 // after its target's x, y, z
IK_WEIGHT :: 4
ROOT_VALUES :: 6

// model_channel_table lists `m`'s channels, in the order a pose holds them; names are allocated
// with `allocator`.
model_channel_table :: proc(m: ^Model, allocator := context.temp_allocator) -> []Channel {
  out := make([dynamic]Channel, allocator)
  for ik, k in m.iks {
    first := ik_channel(m, k)
    append(&out, Channel{ik.name, .POSITION, first})
    append(&out, Channel{fmt.aprint(ik.name, ".swivel", sep = "", allocator = allocator), .HINGE, first + IK_SWIVEL})
    append(&out, Channel{fmt.aprint(ik.name, ".weight", sep = "", allocator = allocator), .WEIGHT, first + IK_WEIGHT})
  }
  root := root_channel(m)
  append(&out, Channel{"root", .POSITION, root}, Channel{"root.turn", .BALL, root + 3})
  n := joint_channel(m, 0)
  for inst, i in m.assembly {
    for j in instance_joints(m, i) {
      _, count := joint_axes(j)
      kinds := JOINT_CHANNEL
      append(&out, Channel{fmt.aprint(inst.name, ".", j.name, sep = "", allocator = allocator), kinds[j.kind], n})
      n += count
    }
  }
  return out[:]
}

// model_channel is the channel named `name`; ok is false for none.
model_channel :: proc(m: ^Model, name: string) -> (c: Channel, ok: bool) {
  for x in model_channel_table(m) do if x.name == name do return x, true
  return {first = -1}, false
}

// value_channel is the channel holding value `i` of a pose, and which of its values it is.
value_channel :: proc(m: ^Model, i: int) -> (c: Channel, axis: int, ok: bool) {
  sizes := CHANNEL_SIZE
  for x in model_channel_table(m) do if i >= x.first && i < x.first + sizes[x.kind] do return x, i - x.first, true
  return {first = -1}, 0, false
}

// model_twin is instance `i`'s other side: the instance it mirrors, or the one mirroring it; -1
// for none.
model_twin :: proc(m: ^Model, i: int) -> int {
  if i < 0 do return -1
  if m.assembly[i].mirror != "" do return model_instance(m, m.assembly[i].mirror)
  for inst, k in m.assembly do if inst.mirror == m.assembly[i].name do return k
  return -1
}

// channel_twin is value `ch` of a pose on the other side of the body, and what its amounts are
// times there (`flip`), -1 for none:
//   - a joint's: the same joint's on its instance's twin (model_twin) of the same part; twins take
//     the same values
//   - an IK target's: the same one of the target whose tip is its tip's twin; its x is mirrored
//     (the model's space is reflected across x = 0), and so is its swivel (a reflected turn turns
//     the other way)
//   - the root's: none
channel_twin :: proc(m: ^Model, ch: int) -> (twin: int, flip: f32) {
  twin, flip = -1, 1
  if ch < 0 do return
  root := root_channel(m)
  if ch < root {
    k, n := ch / IK_VALUES, ch % IK_VALUES
    tip := model_twin(m, model_instance(m, m.iks[k].tip))
    if tip < 0 do return
    for ik, j in m.iks do if ik.tip == m.assembly[tip].name do return ik_channel(m, j) + n, -1 if n == 0 || n == IK_SWIVEL else 1
    return
  }
  if ch < root + ROOT_VALUES do return
  for i in 0 ..< len(m.assembly) {
    if ch >= joint_channel(m, i + 1) do continue
    t := model_twin(m, i)
    if t < 0 || m.assembly[t].part != m.assembly[i].part do return
    return joint_channel(m, t) + ch - joint_channel(m, i), 1
  }
  return
}

// ik_root is the instance an IK chain reaching with instance `tip` starts from: up from the tip to
// the last instance before a branch (a parent holding several children: a pelvis, a torso) or a
// root. A leg reaches from its thigh, an arm from its upper arm, a head aims by its own neck.
ik_root :: proc(m: ^Model, tip: int) -> int {
  i := tip
  for i >= 0 {
    p := model_instance(m, m.assembly[i].parent)
    if p < 0 || p >= i do return i
    children := 0
    for inst in m.assembly do if inst.parent == m.assembly[p].name do children += 1
    if children > 1 do return i
    i = p
  }
  return i
}

// ik_body is the body an aiming IK's tip that is a root (the dragon's head) turns along with it:
// down from it, at each instance the child with the most below it (the spine, not a jaw or a limb),
// to the end (the tail); the instances in order, tip first not included. Empty for a tip with a
// parent, whose chain runs up (ik_root).
ik_body :: proc(m: ^Model, tip: int, allocator := context.allocator) -> []int {
  out := make([dynamic]int, allocator)
  if tip < 0 || model_instance(m, m.assembly[tip].parent) >= 0 do return out[:]
  // each instance's height: the most links below it (instances are listed parents first)
  height := make([]int, len(m.assembly), context.temp_allocator)
  parents := make([]int, len(m.assembly), context.temp_allocator)
  for inst, i in m.assembly do parents[i] = model_instance(m, inst.parent)
  #reverse for p, i in parents do if p >= 0 && p < i do height[p] = max(height[p], height[i] + 1)
  at := tip
  for {
    next := -1
    for p, i in parents do if p == at && i > at && (next < 0 || height[i] > height[next]) do next = i
    if next < 0 do break
    append(&out, next)
    at = next
  }
  return out[:]
}

// ik_channel is the first of IK target `k`'s values; k = len(m.iks) is the root's first.
ik_channel :: proc(m: ^Model, k: int) -> int {
  return k * IK_VALUES
}

// root_channel is the first of the root's values.
root_channel :: proc(m: ^Model) -> int {
  return ik_channel(m, len(m.iks))
}

// joint_channel is the first value of instance `i`'s joints; i = len(m.assembly) is the end.
joint_channel :: proc(m: ^Model, i: int) -> int {
  n := root_channel(m) + ROOT_VALUES
  for k in 0 ..< i do for j in instance_joints(m, k) {
    _, count := joint_axes(j)
    n += count
  }
  return n
}

// model_channels is how many values a pose of `m` holds.
model_channels :: proc(m: ^Model) -> int {
  return joint_channel(m, len(m.assembly))
}

// value_name names value `i` of a pose, for messages and labels: its channel's name, and for a
// 3-value channel which of them (`root[1]`).
value_name :: proc(m: ^Model, i: int, allocator := context.temp_allocator) -> string {
  c, axis, ok := value_channel(m, i)
  if !ok do return "?"
  sizes := CHANNEL_SIZE
  if sizes[c.kind] == 1 do return fmt.aprint(c.name, allocator = allocator)
  return fmt.aprintf("%s[%d]", c.name, axis, allocator = allocator)
}

// channel_joint is the joint whose value `ch` of a pose is, and the axis of its frame it moves
// about or along (its stops are min[axis], max[axis]); ok is false for a value that is not a
// joint's.
channel_joint :: proc(m: ^Model, ch: int) -> (j: Joint, axis: Axis, ok: bool) {
  n := joint_channel(m, 0)
  if ch < n do return
  for _, i in m.assembly do for jj in instance_joints(m, i) {
    axes, count := joint_axes(jj)
    if ch < n + count do return jj, axes[ch - n], true
    n += count
  }
  return
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

// part_face is where part `p` hangs, in its frame: `length` above its origin, +y toward its
// joints, +x forward (PART_FACE raised by the length).
part_face :: proc(p: Part) -> geometry.Face {
  return {{0, p.length, 0}, {0, 1, 0}, {1, 0, 0}}
}

// shape_place is where shape `s` of part `p` sits in the part's frame: its position and rotation,
// a stretched one's from halfway up the part's length; `size` is its extent, a stretched one's
// length added to its y.
shape_place :: proc(p: Part, s: Shape) -> (position: [3]f32, rotation: quaternion128, size: [3]f32) {
  if !s.stretch do return s.position, euler(s.rotation), s.size
  return s.position + {0, p.length / 2, 0}, euler(s.rotation), s.size + {0, p.length, 0}
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
