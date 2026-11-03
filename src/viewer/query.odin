package main

import "core:encoding/json"
import "core:fmt"
import "core:log"
import "core:math"
import "core:strings"
import "../character"
import "../mech"
import "../mjolnir/render"

// Queries let the page ask the engine questions: what a clip gives at any time, where parts would
// be, what the model holds. A query is JSON in, JSON out; every answer comes from the same code the
// game runs. Answers never change what the viewer shows (a solve for another time is undone by the
// next frame's pose).
//
//   {"q": "state"}
//     the clock, the drivers as shown now, warnings since last asked
//   {"q": "sample", "clip": "walk", "drivers": ["l_hip"], "n": 60 | "times": [..]}
//     driver values over a clip (default: the current clip, every driver)
//   {"q": "pose", "clip": "attack", "time": 0.4}
//     every driver at one moment: {"drivers": {..}}
//   {"q": "parts", "clip": .., "time": .., "rest": true, "parts": ["l_palm"]}
//     each instance's frame in the world at that moment (default: now; `rest`: every driver 0),
//     by instance name (default: every instance)
//   {"q": "trajectory", "clip": "walk", "part": "l_foot", "n": 60}
//     an instance's world position over a clip: motion paths, foot slide
//   {"q": "motion", "clip": "walk", "motion": 0, "n": 120}
//     a clip's motion as the engine reads it, for drawing its curves: {shape: its shape over one
//     cycle (n values, u 0 to 1), moves: [{channels (names, as resolved), delay, values (n: how
//     much of its amounts the move adds, over the clip)}]}
//   {"q": "bounds", "clip": .., "time": ..}
//     the box around the posed model
//   {"q": "faces", "part": "torso"}
//     the six faces of each of a part's shapes (the library's part, by name: {position, normal}
//     in its frame, model units; +x, -x, +y, -y, +z, -z of the shape's axes, spans resolved; and
//     `extent`, the face's two widths: the shape's size along its other axes), for snapping slots
//     and fitting joints to them
//   {"q": "joints", "part": "l_shin", "time": ..}
//     the joints an instance moves by, as posed (default: now), each where its bone pivots before
//     its own motion: {name, kind, index (in its slot's stack), pivot (metres), rotation (the
//     frame its axes are in), axes, at (its turns now), min, max (its range there,
//     mirrored instances' turned over; equal ends: free)}, for drawing and turning joints
//   {"q": "moves", "part": "l_foot"}
//     the channels that move an instance: {channels} (names), the drivers of its joints and its
//     parents', of the IK targets whose chains pass through them, and the root's
//   {"q": "handles", "time": ..}
//     what can be dragged in the view, as posed (default: now), in metres: the model's root
//     {position, rotation} (its channels placing it) and each IK target {name, position, rest,
//     pole} (where its channels put it, where its tip is at rest, which they are offsets from, and
//     its pole, unless it aims), with the model's `scale` (metres per model unit)
//   {"q": "span", "part": "shin", "span": ["foot", ""]}
//     the frame a shape spanning those slots of a library part would sit in: {position, rotation,
//     length} (mech.span_frame), for changing a shape's span without moving it
//   {"q": "project", "points": [[x, y, z], ..]}
//     where world points show on the canvas (CSS pixels from its corner), null behind the
//     camera: {points: [[x, y] | null, ..]}, for drawing over the view
//   {"q": "camera"}
//     the main camera: {view: the viewer's View (0 free, then +x, -x, +y, -y, +z, -z: the side it
//     looks from), rotation: [x, y, z, w]}, for drawing the view gizmo
//   {"q": "pick", "x": 120, "y": 80}
//     the nearest shown piece under a point of the canvas (CSS pixels from its corner):
//     {part, shape}: the instance's index in the assembly and the shape's in its part, shape -1
//     for joint hardware, both -1 for nothing
//   {"q": "info"}
//     counts, clips, drivers that move nothing, and the root's channels {move, turn}
//     (mech.ROOT_CHANNELS)
//   {"q": "channels"}
//     every channel a pose holds, in order (mech.model_channels): {name, kind ("driver", "ik",
//     "root" or "joint"), angle (radians, else model units or a weight), min, max (a slider's
//     range: a driver's own, a joint's stops on that axis, the posed model's reach for points;
//     equal ends: none given), and for joints and IK targets `part`/`ik`, the instance or target}
// Units: driver values as they are (radians for angles), world positions in metres, rotations as
// quaternions [x, y, z, w]. Unknown names answer {"error": ".."}.

Query :: struct {
  q:        string,
  clip:     string,
  time:     Maybe(f32),
  times:    []f32,
  n:        int,
  drivers:  []string,
  part:     string,
  parts:    []string,
  rest:     bool,
  x, y:     f32,
  points:   [][3]f32,
  span:     [2]string,
  motion:   int,
}

query :: proc(text: []u8, allocator := context.allocator) -> string {
  context.allocator = context.temp_allocator
  q: Query
  b := strings.builder_make(allocator)
  if err := json.unmarshal(text, &q); err != nil {
    fmt.sbprintf(&b, `{{"error":%q}}`, fmt.tprint("bad query:", err))
    return strings.to_string(b)
  }
  if q.q == "state" {
    state(&b)
    return strings.to_string(b)
  }
  if q.q == "project" {
    strings.write_string(&b, `{"points":[`)
    for p, i in q.points {
      if i > 0 do strings.write_byte(&b, ',')
      at, ok := render.world_to_screen(&app.renderer, p)
      if ok do fmt.sbprintf(&b, "[%v,%v]", at.x, at.y)
      else do strings.write_string(&b, "null")
    }
    strings.write_string(&b, "]}")
    return strings.to_string(b)
  }
  if q.q == "camera" {
    r := quaternion128(1)
    if cam := render.main_camera(&app.renderer); cam != nil do r = cam.rotation
    fmt.sbprintf(&b, `{{"view":%d,"rotation":[%v,%v,%v,%v]}}`, i32(app.view), r.x, r.y, r.z, r.w)
    return strings.to_string(b)
  }
  if q.q == "info" {
    info(&b)
    return strings.to_string(b)
  }
  if !app.has_mech {
    strings.write_string(&b, `{"error":"no model"}`)
    return strings.to_string(b)
  }
  m := app.asset.model
  clip := app.clip
  if q.clip != "" {
    clip = mech.clips_find(&app.asset.clips, q.clip)
    if clip < 0 do return fail(&b, "no clip %s", q.clip)
  }
  times := q.times
  if times == nil && (q.q == "sample" || q.q == "trajectory") {
    n := clamp(q.n if q.n > 0 else 60, 2, 4000)
    d := clip_length(clip)
    times = make([]f32, n)
    for &t, i in times do t = d * f32(i) / f32(n - 1)
  }
  values := make([]f32, mech.model_channels(m))
  rig := character.mech_rig(&app.mech)

  switch q.q {
  case "sample":
    picked := pick_drivers(q.drivers)
    rows := make([][]f32, len(picked))
    for &r in rows do r = make([]f32, len(times))
    for t, k in times {
      mech.clip_sample(&app.asset.clips, clip, t, values)
      for d, r in picked do rows[r][k] = values[d]
    }
    strings.write_string(&b, `{"times":`)
    write_floats(&b, times)
    strings.write_string(&b, `,"drivers":{`)
    for d, r in picked {
      if r > 0 do strings.write_byte(&b, ',')
      fmt.sbprintf(&b, "%q:", mech.channel_name(m, d))
      write_floats(&b, rows[r])
    }
    strings.write_string(&b, "}}")
  case "pose":
    mech.clip_sample(&app.asset.clips, clip, q.time.? or_else app.time, values)
    strings.write_string(&b, `{"drivers":`)
    write_drivers(&b, values)
    strings.write_byte(&b, '}')
  case "parts":
    if q.rest do mech.rig_solve(rig, values)
    else do solve_at(clip, q.time, values)
    strings.write_byte(&b, '{')
    first := true
    for p, i in m.assembly {
      if q.parts != nil && !contains(q.parts, p.name) do continue
      if !first do strings.write_byte(&b, ',')
      first = false
      x := mech.rig_frame(rig, i)
      pos := x.position * m.scale
      r := x.rotation
      fmt.sbprintf(&b, `%q:{{"position":[%v,%v,%v],"rotation":[%v,%v,%v,%v]}}`, p.name, pos.x, pos.y, pos.z, r.x, r.y, r.z, r.w)
    }
    strings.write_byte(&b, '}')
  case "trajectory":
    part := mech.model_instance(m, q.part)
    if part < 0 do return fail(&b, "no instance %s", q.part)
    strings.write_string(&b, `{"times":`)
    write_floats(&b, times)
    strings.write_string(&b, `,"positions":[`)
    for t, k in times {
      mech.clip_sample(&app.asset.clips, clip, t, values)
      mech.rig_solve(rig, values)
      pos := mech.rig_frame(rig, part).position * m.scale
      if k > 0 do strings.write_byte(&b, ',')
      fmt.sbprintf(&b, "[%v,%v,%v]", pos.x, pos.y, pos.z)
    }
    strings.write_string(&b, "]}")
  case "motion":
    if clip < 0 || q.motion < 0 || q.motion >= len(app.asset.clips.clips[clip].motions) do return fail(&b, "no motion %d", q.motion)
    mo := &app.asset.clips.clips[clip].motions[q.motion]
    n := clamp(q.n if q.n > 0 else 120, 2, 4000)
    row := make([]f32, n)
    for &v, i in row do v = mech.shape_value(mo.shape[:], f32(i) / f32(n - 1))
    strings.write_string(&b, `{"shape":`)
    write_floats(&b, row)
    strings.write_string(&b, `,"moves":[`)
    for mv, k in mo.moves {
      if k > 0 do strings.write_byte(&b, ',')
      strings.write_string(&b, `{"channels":[`)
      for target, j in mo.targets[mv.first:][:mv.count] {
        if j > 0 do strings.write_byte(&b, ',')
        fmt.sbprintf(&b, "%q", mech.channel_name(m, target.driver))
      }
      for &v, i in row do v = mech.motion_move(mo, k, f32(i) / f32(n - 1))
      fmt.sbprintf(&b, `],"delay":%v,"values":`, mv.delay)
      write_floats(&b, row)
      strings.write_byte(&b, '}')
    }
    strings.write_string(&b, "]}")
  case "pick":
    part, shape := pick({q.x, q.y})
    fmt.sbprintf(&b, `{{"part":%d,"shape":%d}}`, part, shape)
  case "faces":
    part := mech.model_part(m, q.part)
    if part < 0 do return fail(&b, "no part %s", q.part)
    strings.write_string(&b, `{"shapes":[`)
    for s, k in m.parts[part].shapes {
      if k > 0 do strings.write_byte(&b, ',')
      strings.write_byte(&b, '[')
      _, _, size := mech.shape_place(m.parts[part], s)
      for f, i in mech.shape_faces(m.parts[part], s) {
        if i > 0 do strings.write_byte(&b, ',')
        p, n := f.position, f.normal
        // the face's width and height: the shape's size along its other two axes
        a := i / 2
        fmt.sbprintf(&b, `{{"position":[%v,%v,%v],"normal":[%v,%v,%v],"extent":[%v,%v]}}`, p.x, p.y, p.z, n.x, n.y, n.z, size[(a + 1) % 3], size[(a + 2) % 3])
      }
      strings.write_byte(&b, ']')
    }
    strings.write_string(&b, "]}")
  case "joints":
    inst := mech.model_instance(m, q.part)
    if inst < 0 do return fail(&b, "no instance %s", q.part)
    solve_at(clip, q.time, values)
    stack := mech.instance_joints(m, inst)
    strings.write_string(&b, `{"joints":[`)
    first := true
    for bone, i in rig.bones {
      if bone.part != inst || bone.joint < 0 || bone.joint >= len(stack) do continue
      if !first do strings.write_byte(&b, ',')
      first = false
      j := stack[bone.joint]
      x := mech.rig_bone_base(rig, i)
      pos, r := x.position * m.scale, x.rotation
      at, lo, hi := rig.motion[i], bone.lo, bone.hi
      fmt.sbprintf(&b, `{{"name":%q,"kind":%q,"index":%d,"pivot":[%v,%v,%v],"rotation":[%v,%v,%v,%v],"axes":[`, j.name, fmt.tprint(j.kind), bone.joint, pos.x, pos.y, pos.z, r.x, r.y, r.z, r.w)
      n := 0
      for axis in mech.Axis do if axis in bone.turns {
        if n > 0 do strings.write_byte(&b, ',')
        n += 1
        fmt.sbprintf(&b, `%q`, fmt.tprint(axis))
      }
      fmt.sbprintf(&b, `],"at":[%v,%v,%v],"min":[%v,%v,%v],"max":[%v,%v,%v]}}`, at.x, at.y, at.z, lo.x, lo.y, lo.z, hi.x, hi.y, hi.z)
    }
    strings.write_string(&b, "]}")
  case "moves":
    // the channels that move an instance
    inst := mech.model_instance(m, q.part)
    if inst < 0 do return fail(&b, "no instance %s", q.part)
    strings.write_string(&b, `{"channels":[`)
    first := true
    for on, i in mech.rig_moves(rig, inst, context.temp_allocator) do if on {
      if !first do strings.write_byte(&b, ',')
      first = false
      fmt.sbprintf(&b, `%q`, mech.channel_name(m, i))
    }
    strings.write_string(&b, "]}")
  case "channels":
    channels(&b, rig)
  case "handles":
    solve_at(clip, q.time, values)
    s := m.scale
    o := mech.rig_origin(rig)
    fmt.sbprintf(&b, `{{"scale":%v,"root":{{"position":[%v,%v,%v],"rotation":[%v,%v,%v,%v]}},"iks":[`, s, o.position.x * s, o.position.y * s, o.position.z * s, o.rotation.x, o.rotation.y, o.rotation.z, o.rotation.w)
    for rik, n in rig.iks {
      if n > 0 do strings.write_byte(&b, ',')
      name := ""
      for ik, k in m.iks do if mech.ik_channel(m, k) == rik.channel do name = ik.name
      c := rig.values[rik.channel:]
      r := rik.rest
      at, pole := r + {c[0], c[1], c[2]}, rik.pole_rest + {c[4], c[5], c[6]} if !rik.aim else {}
      fmt.sbprintf(&b, `{{"name":%q,"position":[%v,%v,%v],"rest":[%v,%v,%v]`, name, at.x * s, at.y * s, at.z * s, r.x * s, r.y * s, r.z * s)
      if !rik.aim do fmt.sbprintf(&b, `,"pole":[%v,%v,%v]`, pole.x * s, pole.y * s, pole.z * s)
      strings.write_byte(&b, '}')
    }
    strings.write_string(&b, "]}")
  case "span":
    part := mech.model_part(m, q.part)
    if part < 0 do return fail(&b, "no part %s", q.part)
    p, r, length := mech.span_frame(m.parts[part], q.span)
    fmt.sbprintf(&b, `{{"position":[%v,%v,%v],"rotation":[%v,%v,%v,%v],"length":%v}}`, p.x, p.y, p.z, r.x, r.y, r.z, r.w, length)
  case "bounds":
    solve_at(clip, q.time, values)
    lo, hi := mech.rig_bounds(rig)
    fmt.sbprintf(&b, `{{"min":[%v,%v,%v],"max":[%v,%v,%v]}}`, lo.x, lo.y, lo.z, hi.x, hi.y, hi.z)
  case:
    return fail(&b, "unknown query %s", q.q)
  }
  return strings.to_string(b)
}

@(private = "file")
fail :: proc(b: ^strings.Builder, format: string, args: ..any) -> string {
  strings.builder_reset(b)
  fmt.sbprintf(b, `{{"error":%q}}`, fmt.tprintf(format, ..args))
  return strings.to_string(b^)
}

clip_length :: proc(clip: int) -> f32 {
  clips := &app.asset.clips.clips
  return max(clips[clip].duration, 1e-3) if clip >= 0 && clip < len(clips) else 1
}

// solve_at solves the rig at `time` into the clip (or as shown now when no time is given).
@(private = "file")
solve_at :: proc(clip: int, time: Maybe(f32), values: []f32) {
  rig := character.mech_rig(&app.mech)
  t, ok := time.?
  if !ok do return // rig.poses already hold what is shown
  mech.clip_sample(&app.asset.clips, clip, t, values)
  mech.rig_solve(rig, values)
}

@(private = "file")
pick_drivers :: proc(names: []string) -> []int {
  m := app.asset.model
  if names == nil {
    picked := make([]int, mech.model_channels(m))
    for &p, i in picked do p = i
    return picked
  }
  out := make([dynamic]int)
  for n in names {
    d := mech.model_channel(m, n)
    if d < 0 {
      log.warnf("query: no driver %s", n)
      continue
    }
    append(&out, d)
  }
  return out[:]
}

@(private = "file")
contains :: proc(list: []string, s: string) -> bool {
  for x in list do if x == s do return true
  return false
}

@(private = "file")
write_floats :: proc(b: ^strings.Builder, xs: []f32) {
  strings.write_byte(b, '[')
  for x, i in xs {
    if i > 0 do strings.write_byte(b, ',')
    fmt.sbprintf(b, "%v", x if !math.is_nan(x) && !math.is_inf(x) else 0)
  }
  strings.write_byte(b, ']')
}

// write_drivers writes driver values as {name: value}.
@(private = "file")
write_drivers :: proc(b: ^strings.Builder, values: []f32) {
  m := app.asset.model
  strings.write_byte(b, '{')
  for i in 0 ..< mech.model_channels(m) {
    if i > 0 do strings.write_byte(b, ',')
    v := values[i] if i < len(values) else 0
    fmt.sbprintf(b, "%q:%v", mech.channel_name(m, i), v if !math.is_nan(v) else 0)
  }
  strings.write_byte(b, '}')
}

@(private = "file")
state :: proc(b: ^strings.Builder) {
  fmt.sbprintf(b, `{{"ready":%v,"time":%v,"duration":%v,"playing":%v,"drivers":`, app.has_mech, app.time, clip_length(app.clip), app.playing)
  if app.has_mech do write_drivers(b, character.mech_shown(&app.mech))
  else do strings.write_string(b, "{}")
  strings.write_string(b, `,"messages":[`)
  for msg, i in app.messages {
    if i > 0 do strings.write_byte(b, ',')
    fmt.sbprintf(b, "%q", msg)
    delete(msg, app.heap)
  }
  clear(&app.messages)
  strings.write_string(b, "]}")
}

@(private = "file")
info :: proc(b: ^strings.Builder) {
  if !app.has_asset {
    strings.write_string(b, `{"error":"no model"}`)
    return
  }
  m := app.asset.model
  bones, pieces := 0, 0
  if app.has_mech {
    rig := character.mech_rig(&app.mech)
    bones, pieces = len(rig.bones), len(rig.pieces)
  }
  fmt.sbprintf(b, `{{"parts":%d,"bones":%d,"pieces":%d,"meshes":%d,"materials":%d,"clips":[`, len(m.assembly), bones, pieces, len(app.library.meshes), len(app.library.materials))
  for c, i in app.asset.clips.clips {
    if i > 0 do strings.write_byte(b, ',')
    fmt.sbprintf(b, `{{"name":%q,"duration":%v,"motions":%d}}`, c.name, c.duration, len(c.motions))
  }
  // drivers that move nothing
  strings.write_string(b, `],"unused_drivers":[`)
  first := true
  for c in m.drivers {
    if len(c.moves) > 0 do continue
    if !first do strings.write_byte(b, ',')
    first = false
    fmt.sbprintf(b, "%q", c.name)
  }
  // the root's channels, moving and turning it
  strings.write_string(b, `],"root":{"move":[`)
  names := mech.ROOT_CHANNELS
  for n, k in names {
    if k == 3 do strings.write_string(b, `],"turn":[`)
    else if k > 0 do strings.write_byte(b, ',')
    fmt.sbprintf(b, "%q", n)
  }
  strings.write_string(b, "]}}")
}

// channels lists every channel of the model with what a slider for it needs (see the top).
@(private = "file")
channels :: proc(b: ^strings.Builder, rig: ^mech.Rig) {
  m := app.asset.model
  // points range over the posed model, half its size again each way, in model units
  lo, hi := mech.rig_bounds(rig)
  lo, hi = lo / m.scale, hi / m.scale
  pad := (hi - lo) / 2
  lo, hi = lo - pad, hi + pad
  first := true
  item :: proc(b: ^strings.Builder, first: ^bool, name, kind: string, angle: bool, min, max: f32, owner := "", owner_key := "") {
    if !first^ do strings.write_byte(b, ',')
    first^ = false
    fmt.sbprintf(b, `{{"name":%q,"kind":%q,"angle":%v,"min":%v,"max":%v`, name, kind, angle, min, max)
    if owner_key != "" do fmt.sbprintf(b, `,%q:%q`, owner_key, owner)
    strings.write_byte(b, '}')
  }
  strings.write_byte(b, '[')
  for d in m.drivers do item(b, &first, d.name, "driver", len(d.moves) > 0, d.min, d.max)
  suffixes := mech.IK_CHANNELS
  for ik in m.iks {
    for x, n in suffixes[:mech.ik_channel_count(ik)] {
      // x, y, z, the weight, then the pole's x, y, z
      a := n if n < 3 else n - 4
      if n == 3 do item(b, &first, fmt.tprint(ik.name, x, sep = ""), "ik", false, 0, 1, ik.name, "ik")
      else do item(b, &first, fmt.tprint(ik.name, x, sep = ""), "ik", false, lo[a], hi[a], ik.name, "ik")
    }
  }
  roots := mech.ROOT_CHANNELS
  for r, k in roots do item(b, &first, r, "root", k >= 3, -math.PI if k >= 3 else lo[k], math.PI if k >= 3 else hi[k])
  ch := mech.joint_channel(m, 0)
  for inst, i in m.assembly {
    for j in mech.instance_joints(m, i) {
      dofs, count := mech.joint_dofs(j)
      for d in dofs[:count] {
        item(b, &first, mech.channel_name(m, ch), "joint", true, j.min[d.axis], j.max[d.axis], inst.name, "part")
        ch += 1
      }
    }
  }
  strings.write_byte(b, ']')
}
