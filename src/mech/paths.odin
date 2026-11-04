package mech

import "core:fmt"
import "core:strings"

// A Path addresses one thing of a character, as a person names it: a part's joint, a clip's
// motion's move, the rest pose's amount on a channel. Issues say where they are by one
// (character_check), references say what they name and where they are written (references), and
// an editor picks and goes to things by them.
//
//   kind        name                 item                          index      move
//   CHARACTER                        a placed name, a hardware role
//   MATERIAL    the material
//   PART        the part
//   SHAPE       its part                                           the shape
//   SLOT        its part             the slot
//   JOINT       its part             the joint
//   INSTANCE    the instance
//   IK          the IK target
//   REST                             the name written in the rest pose
//   ARC         the arc
//   POSE        the pose             the name written in it
//   CLIP        the clip
//   MOTION      its clip                                           the motion
//   MOVE        its clip             the name written in it        its motion  the move
PathKind :: enum u8 {
  CHARACTER,
  MATERIAL,
  PART,
  SHAPE,
  SLOT,
  JOINT,
  INSTANCE,
  IK,
  REST,
  ARC,
  POSE,
  CLIP,
  MOTION,
  MOVE,
}

Path :: struct {
  kind:  PathKind,
  name:  string,
  item:  string,
  index: int,
  move:  int,
}

// A Ref is one place a name is written: where in the file data (`ptr`, a JSON pointer from the
// character file's top, /model/assembly/4/parent), whether it is a map's key there (`key`: a
// rest pose's, a pose's or a move's `by`) rather than a value, the span of the name in what is
// written there (`span`: a channel's name holds its instance's and its joint's, l_arm.elbow), what
// it names (`to`) and the thing it is written in (`at`). A thing's own name is a Ref too (`def`):
// renaming a thing rewrites every Ref to it; deleting it, every Ref to it but its own. Paths, Refs
// and Issues go to editors as JSON by core:encoding/json (enums by name).
Ref :: struct {
  ptr:  string,
  key:  bool,
  def:  bool,
  span: [2]int,
  to:   Path,
  at:   Path,
}

// pointer_key escapes a map key for a JSON pointer (RFC 6901: ~ as ~0, / as ~1).
@(private = "file")
pointer_key :: proc(k: string) -> string {
  if !strings.contains_any(k, "~/") do return k
  s, _ := strings.replace_all(k, "~", "~0", context.temp_allocator)
  s, _ = strings.replace_all(s, "/", "~1", context.temp_allocator)
  return s
}

// ChannelName is what a channel's name names: its instance and its joint (`l_arm.elbow`), or its
// IK target (`l_leg`, `l_leg.swivel`), each with the span of its name in the channel's.
@(private = "file")
ChannelName :: struct {
  to:   [2]Path,
  span: [2][2]int,
  n:    int,
}

// channel_names is what each of `m`'s channels names (ChannelName), by the channel's name.
@(private = "file")
channel_names :: proc(m: ^Model) -> map[string]ChannelName {
  out := make(map[string]ChannelName, allocator = context.temp_allocator)
  places := model_places(m)
  prefix := SIDE_PREFIX
  for k in model_ik_places(m, places) {
    ik := m.iks[k.ik]
    base := ik_name(m, k)
    at := len(prefix[k.side])
    named := ChannelName{to = {0 = {kind = .IK, name = ik.name}}, span = {0 = {at, at + len(ik.name)}}, n = 1}
    out[base] = named
    out[fmt.tprint(base, IK_SWIVEL_NAME, sep = "")] = named
    out[fmt.tprint(base, IK_WEIGHT_NAME, sep = "")] = named
  }
  for p in places {
    inst := m.assembly[p.inst]
    place := place_name(m, p)
    at := len(prefix[p.side])
    for j in place_joints(m, p) {
      name := fmt.tprint(place, ".", j.name, sep = "")
      out[name] = ChannelName {
        to = {{kind = .INSTANCE, name = inst.name}, {kind = .JOINT, name = inst.part, item = j.name}},
        span = {{at, at + len(inst.name)}, {len(place) + 1, len(name)}},
        n = 2,
      }
    }
  }
  return out
}

// references lists every place a name of model `m` and animation `a` (nil for none) is written,
// as Refs, in the order of the file, allocated with `allocator`. Names that name nothing are left
// out (character_check reports them).
references :: proc(m: ^Model, a: ^Animation, allocator := context.allocator) -> []Ref {
  out := make([dynamic]Ref, allocator)
  ref :: proc(out: ^[dynamic]Ref, allocator := context.allocator, ptr: string, to, at: Path, written: string, key := false, def := false, span := [2]int{-1, -1}) {
    s := span if span[0] >= 0 else [2]int{0, len(written)}
    append(out, Ref{strings.clone(ptr, allocator), key, def, s, to, at})
  }
  // a channel's name written as a map key: refs to what it names
  channels := channel_names(m)
  by_key :: proc(out: ^[dynamic]Ref, allocator := context.allocator, channels: map[string]ChannelName, ptr: string, name: string, at: Path) {
    c, ok := channels[name]
    if !ok do return
    for k in 0 ..< c.n do ref(out, allocator, ptr, c.to[k], at, name, key = true, span = c.span[k])
  }

  for x, i in m.materials do ref(&out, allocator, fmt.tprintf("/model/materials/%d/name", i), {kind = .MATERIAL, name = x.name}, {kind = .MATERIAL, name = x.name}, x.name, def = true)
  hardware := [3]struct {
    role, name: string,
  }{{"female", m.hardware.female}, {"male", m.hardware.male}, {"metal", m.hardware.metal}}
  for h in hardware do if h.name != "" && model_material(m, h.name) >= 0 {
    ref(&out, allocator, fmt.tprintf("/model/hardware/%s", h.role), {kind = .MATERIAL, name = h.name}, {kind = .CHARACTER, item = h.role}, h.name)
  }
  for name, value in m.pose do by_key(&out, allocator, channels, fmt.tprintf("/model/pose/%s", pointer_key(name)), name, {kind = .REST, item = name})
  for ik, k in m.iks {
    at := Path{kind = .IK, name = ik.name}
    ref(&out, allocator, fmt.tprintf("/model/iks/%d/name", k), at, at, ik.name, def = true)
    if model_instance(m, ik.tip) >= 0 do ref(&out, allocator, fmt.tprintf("/model/iks/%d/tip", k), {kind = .INSTANCE, name = ik.tip}, at, ik.tip)
  }
  for p, i in m.parts {
    part := Path{kind = .PART, name = p.name}
    ref(&out, allocator, fmt.tprintf("/model/parts/%d/name", i), part, part, p.name, def = true)
    for s, k in p.slots {
      slot := Path{kind = .SLOT, name = p.name, item = s.name}
      ref(&out, allocator, fmt.tprintf("/model/parts/%d/slots/%d/name", i, k), slot, slot, s.name, def = true)
    }
    for j, k in p.joints {
      joint := Path{kind = .JOINT, name = p.name, item = j.name}
      ref(&out, allocator, fmt.tprintf("/model/parts/%d/joints/%d/name", i, k), joint, joint, j.name, def = true)
    }
    for s, k in p.shapes do if s.material != "" && model_material(m, s.material) >= 0 {
      ref(&out, allocator, fmt.tprintf("/model/parts/%d/shapes/%d/material", i, k), {kind = .MATERIAL, name = s.material}, {kind = .SHAPE, name = p.name, index = k}, s.material)
    }
  }
  for inst, i in m.assembly {
    at := Path{kind = .INSTANCE, name = inst.name}
    ref(&out, allocator, fmt.tprintf("/model/assembly/%d/name", i), at, at, inst.name, def = true)
    if model_part(m, inst.part) >= 0 do ref(&out, allocator, fmt.tprintf("/model/assembly/%d/part", i), {kind = .PART, name = inst.part}, at, inst.part)
    parent := model_instance(m, inst.parent)
    if parent >= 0 {
      ref(&out, allocator, fmt.tprintf("/model/assembly/%d/parent", i), {kind = .INSTANCE, name = inst.parent}, at, inst.parent)
      on := m.assembly[parent].part
      if part_slot(m, model_part(m, on), inst.parent_slot) >= 0 do ref(&out, allocator, fmt.tprintf("/model/assembly/%d/parent_slot", i), {kind = .SLOT, name = on, item = inst.parent_slot}, at, inst.parent_slot)
    }
    part := model_part(m, inst.part)
    for x, k in inst.joints do if part >= 0 {
      for j in m.parts[part].joints do if j.name == x.name {
        ref(&out, allocator, fmt.tprintf("/model/assembly/%d/joints/%d/name", i, k), {kind = .JOINT, name = inst.part, item = x.name}, at, x.name)
      }
    }
  }
  if a == nil do return out[:]

  for x, i in a.arcs do ref(&out, allocator, fmt.tprintf("/animation/arcs/%d/name", i), {kind = .ARC, name = x.name}, {kind = .ARC, name = x.name}, x.name, def = true)
  for p, i in a.poses {
    pose := Path{kind = .POSE, name = p.name}
    ref(&out, allocator, fmt.tprintf("/animation/poses/%d/name", i), pose, pose, p.name, def = true)
    for name, _ in p.by do by_key(&out, allocator, channels, fmt.tprintf("/animation/poses/%d/by/%s", i, pointer_key(name)), name, {kind = .POSE, name = p.name, item = name})
  }
  for c, i in a.clips {
    clip := Path{kind = .CLIP, name = c.name}
    ref(&out, allocator, fmt.tprintf("/animation/clips/%d/name", i), clip, clip, c.name, def = true)
    for mo, n in c.motions do for mv, k in mo.moves {
      move := fmt.tprintf("/animation/clips/%d/motions/%d/moves/%d", i, n, k)
      at := Path{kind = .MOVE, name = c.name, index = n, move = k}
      // its amounts and the positions it puts on arcs, by channel; the poses it adds; the arcs
      for name, _ in mv.by do by_key(&out, allocator, channels, fmt.tprintf("%s/by/%s", move, pointer_key(name)), name, {kind = .MOVE, name = c.name, item = name, index = n, move = k})
      for name, _ in mv.poses do if pose_find(a.poses[:], name) >= 0 {
        ref(&out, allocator, fmt.tprintf("%s/poses/%s", move, pointer_key(name)), {kind = .POSE, name = name}, {kind = .MOVE, name = c.name, item = name, index = n, move = k}, name, key = true)
      }
      for name, arc in mv.arcs {
        ptr := fmt.tprintf("%s/arcs/%s", move, pointer_key(name))
        on := at
        on.item = name
        by_key(&out, allocator, channels, ptr, name, on)
        if arc_find(a.arcs[:], arc) >= 0 do ref(&out, allocator, ptr, {kind = .ARC, name = arc}, on, arc)
      }
    }
  }
  return out[:]
}
