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
//     the clock, the channels' values as shown now (`values`), warnings since last asked
//   {"q": "sample", "clip": "walk", "channels": ["l_leg"], "n": 60 | "times": [..]}
//     channels' values over a clip (default: the current clip, every channel)
//   {"q": "pose", "clip": "attack", "time": 0.4}
//     every channel at one moment: {"values": {..}}
//   {"q": "parts", "clip": .., "time": .., "rest": true, "parts": ["l_palm"]}
//     each instance's frame in the world at that moment (default: now; `rest`: the rest pose),
//     by instance name (default: every instance)
//   {"q": "trajectory", "clip": "walk", "part": "l_foot", "n": 60}
//     an instance's world position over a clip: motion paths, foot slide
//   {"q": "motion", "clip": "walk", "motion": 0, "n": 120}
//     a clip's motion as the engine reads it, for drawing its curves: {shape: its shape over one
//     cycle (n values, u 0 to 1), moves: [{channels (names, as resolved), delay, values (n: how
//     much of its amounts the move adds, over the clip), arcs (each arc a position follows: {name
//     (the channel), arc (its name), points, curve: the arc through them; in metres, where they
//     put it on the rest pose, for drawing and dragging them}), for a move with a spread `links`
//     (each later channel: {channel, delay (cycles past the move's), values}), and for a twin move
//     `twin`, the same for its twins}], one per move as written}
//   {"q": "arc", "arc": "step", "on": "l_leg"}
//     an arc of the animation as it would put position channel `on` (an IK target, the root) on
//     the rest pose: {name, arc, points, curve} in metres, as a motion's arcs are; for editing an arc
//     no motion shown uses
//   {"q": "bounds", "clip": .., "time": ..}
//     the box around the posed model
//   {"q": "faces", "part": "torso"}
//     the six faces of each of a part's shapes (the library's part, by name: {position, normal}
//     in its frame, model units; +x, -x, +y, -y, +z, -z of the shape's axes, stretch resolved; and
//     `extent`, the face's two widths: the shape's size along its other axes), for snapping slots
//     and fitting joints to them
//   {"q": "dofs", "joint": {..}}
//     a joint's hardware and motion (mech.joint_axes): {bare (a hinge too close for lugs), plates
//     (whether it has base plates, round next to a turntable), axes (those it moves about or along,
//     which its stops are on)}
//   {"q": "joints", "part": "l_shin", "time": ..}
//     the joints an instance moves by, as posed (default: now), each where its bone pivots before
//     its own motion: {name, kind, bare (a hinge too close for lugs: a bare pin), index (in its
//     part's stack), channel (its own), pivot (metres), rotation (the frame its axes are in), axes
//     (those it turns about), at (its turns now), min, max (its range there, mirrored instances'
//     turned over; equal ends: free), slide and stroke (a linear actuator's: how far out now, and
//     its range)}, for drawing and moving joints
//   {"q": "moves", "part": "l_foot"}
//     the channels that move an instance: {channels} (names), its joints' and its parents', the
//     IK targets' whose chains pass through them, and the root's
//   {"q": "handles", "time": ..}
//     what can be dragged in the view, as posed (default: now), in metres: the model's root
//     {position, rotation} (its channels placing it) and each IK target {name, root, position,
//     rest, pole} (the instance its chain starts from, mech.ik_root; where its channels put it,
//     where its tip is at rest, which they are offsets from, and the pole it bends toward,
//     mech.ik_pole, worked out and turned by its swivel, unless it aims; then `swivel` and `ring`,
//     the pole at every swivel from this one on round a whole turn, 48 points), with the model's
//     `scale` (metres per model unit)
//   {"q": "project", "points": [[x, y, z], ..]}
//     where world points show on the canvas (CSS pixels from its corner), null behind the
//     camera: {points: [[x, y] | null, ..]}, for drawing over the view
//   {"q": "camera"}
//     the main camera: {view: the viewer's View (0 free, then +x, -x, +y, -y, +z, -z: the side it
//     looks from), rotation: [x, y, z, w]}, for drawing the view gizmo
//   {"q": "pick", "x": 120, "y": 80}
//     the nearest shown piece under a point of the canvas (CSS pixels from its corner):
//     {part, shape}: the instance's index in the assembly (on either side) and the shape's in its part, shape -1
//     for joint hardware, both -1 for nothing
//   {"q": "places"}
//     what the model places (mech.model_places): [{name, inst, side}], each instance of the
//     assembly once (side NONE), or on each side of the body (L, R) when it hangs from a mirrored
//     slot or from one that does
//   {"q": "info"}
//     counts and clips
//   {"q": "twins"}
//     each channel's on the other side of the body (mech.channel_twin), by name: {name: {twin,
//     flip (what its values are times there, shaped as the channel: [-1, 1, 1] for an IK
//     target, -1 for its swivel)}}, channels without one left out
//   {"q": "channels"}
//     every channel a pose holds, in order (mech.model_channel_table): {name, kind (HINGE, SLIDE,
//     BALL, POSITION, WEIGHT: mech.ChannelKind), size (1 or 3 values), min, max (per value: a
//     joint's stops, a half turn each way for other turns, the posed model's reach for
//     positions, 0 to 1 for a weight; equal ends: free), and for joints' and IK targets' `part`
//     or `ik`, the instance or target}
//   {"q": "check", "character": "<a character file's text>"}
//     everything mech.character_check finds wrong with it: [{severity (ERROR, BUDGET), text, at
//     (a mech.Path: where, to go there)}]; checks the text given, not what is shown
//   {"q": "refs", "character": "<a character file's text>"}
//     every place a name is written in it (mech.references): [{ptr (a JSON pointer into the
//     file's data), key (the name is a map's key there), def (the thing's own name), span (where
//     the name is in what is written: a channel's holds its instance's and its joint's), to (the
//     mech.Path it names), at (the mech.Path it is written in)}], for renaming, deleting, and
//     saying what uses what
//   {"q": "schema"}
//     the names the formats use, from the engine's own types, so the page keeps no copy of them:
//     {enums: {Primitive, JointKind, Plane, Ease, Twin, ChannelKind, Axis: [names]}, sides (the
//     prefixes of a placed side's names, NONE L R), channels: {swivel, weight (an IK target's
//     channels after its name), root, root_turn}, sizes (values per ChannelKind), budgets: {shape,
//     motions} (mech.SHAPE_BUDGET, MOTION_BUDGET)}; needs no model
// Units: channel values as they are (radians for turns, model units for positions), world
// positions in metres, rotations as quaternions [x, y, z, w]. Values go by channel, shaped as the
// channel is: a number, or [x, y, z]. Unknown names answer {"error": ".."}.

Query :: struct {
  q:        string,
  clip:     string,
  time:     Maybe(f32),
  times:    []f32,
  n:        int,
  channels: []string,
  part:     string,
  parts:    []string,
  rest:     bool,
  x, y:     f32,
  points:   [][3]f32,
  motion:   int,
  arc, on:  string,
  joint:    mech.Joint,
  // a whole character file's text, for the queries that check one rather than what is shown
  character: string,
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
  if q.q == "schema" {
    return mech.schema_format(allocator)
  }
  if q.q == "check" || q.q == "refs" {
    m, a, ok := mech.character_parse(transmute([]u8)q.character, "the character checked")
    if !ok do return fail(&b, "not a character")
    defer mech.model_destroy(m)
    defer mech.animation_destroy(a)
    // paths, refs and issues as they are, enums by name
    opt := json.Marshal_Options{use_enum_names = true}
    data: []u8
    if q.q == "check" do data, _ = json.marshal(mech.character_check(m, a), opt, allocator)
    else do data, _ = json.marshal(mech.references(m, a, context.temp_allocator), opt, allocator)
    return string(data)
  }
  if q.q == "info" {
    info(&b)
    return strings.to_string(b)
  }
  if q.q == "dofs" {
    dofs(&b, q.joint)
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
  sizes := mech.CHANNEL_SIZE

  switch q.q {
  case "sample":
    picked := pick_channels(q.channels)
    rows := make([][dynamic]f32, len(picked))
    for t in times {
      mech.clip_sample(&app.asset.clips, clip, t, values)
      for c, r in picked do append(&rows[r], ..values[c.first:][:sizes[c.kind]])
    }
    strings.write_string(&b, `{"times":`)
    write_floats(&b, times)
    strings.write_string(&b, `,"channels":{`)
    for c, r in picked {
      if r > 0 do strings.write_byte(&b, ',')
      fmt.sbprintf(&b, "%q:[", c.name)
      n := sizes[c.kind]
      for k in 0 ..< len(times) {
        if k > 0 do strings.write_byte(&b, ',')
        write_value(&b, rows[r][k * n:][:n])
      }
      strings.write_byte(&b, ']')
    }
    strings.write_string(&b, "}}")
  case "pose":
    mech.clip_sample(&app.asset.clips, clip, q.time.? or_else app.time, values)
    strings.write_string(&b, `{"values":`)
    write_values(&b, values)
    strings.write_byte(&b, '}')
  case "parts":
    if q.rest {
      copy(values, app.asset.clips.pose[:])
      mech.rig_solve(rig, values)
    }
    else do solve_at(clip, q.time, values)
    strings.write_byte(&b, '{')
    first := true
    // by name: each placed instance's (`l_arm`), and an instance's of the assembly (`arm`, its
    // left side when it is on both)
    for p, i in rig.places {
      for name in ([2]string{mech.place_name(m, p), m.assembly[p.inst].name if p.side == .L else ""}) {
        if name == "" || (q.parts != nil && !contains(q.parts, name)) do continue
        if !first do strings.write_byte(&b, ',')
        first = false
        x := mech.rig_frame(rig, i)
        pos := x.position * m.scale
        r := x.rotation
        fmt.sbprintf(&b, `%q:{{"position":[%v,%v,%v],"rotation":[%v,%v,%v,%v]}}`, name, pos.x, pos.y, pos.z, r.x, r.y, r.z, r.w)
      }
    }
    strings.write_byte(&b, '}')
  case "trajectory":
    part := find_place(rig, q.part)
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
    // one per move as written; a twin move's twins resolve to a move of their own after it
    // (mech.move_resolve), shown under it
    lane :: proc(b: ^strings.Builder, m: ^mech.Model, rig: ^mech.Rig, pose: []f32, mo: ^mech.MotionData, k: int, row: []f32) {
      mv := mo.moves[k]
      // its channels, each once (a 3-value one has a target per value)
      strings.write_string(b, `{"channels":[`)
      last := ""
      for target, j in mo.targets[mv.first:][:mv.count] {
        c, _, _ := mech.value_channel(m, target.index)
        if c.name == last do continue
        if last != "" do strings.write_byte(b, ',')
        last = c.name
        fmt.sbprintf(b, "%q", c.name)
      }
      // and the positions on its arcs
      for a in mo.arcs[mv.arcs_first:][:mv.arcs_count] {
        c, _, _ := mech.value_channel(m, a.channels[0])
        if last != "" do strings.write_byte(b, ',')
        last = c.name
        fmt.sbprintf(b, "%q", c.name)
      }
      for &v, i in row do v = mech.motion_move(mo, k, f32(i) / f32(len(row) - 1))
      fmt.sbprintf(b, `],"delay":%v,"values":`, mv.delay)
      write_floats(b, row)
      // its arcs, where they put their positions
      strings.write_string(b, `,"arcs":[`)
      first := true
      for a in mo.arcs[mv.arcs_first:][:mv.arcs_count] {
        c, _, _ := mech.value_channel(m, a.channels[0])
        if !first do strings.write_byte(b, ',')
        first = false
        write_arc(b, rig, pose, c, app.asset.anim.arcs[a.arc].name, mo.points[a.first:][:a.count], mo.sharp[a.first:][:a.count], mo.knots[a.first:][:a.count], a.closed, a.flip)
      }
      strings.write_byte(b, ']')
      // a spread move's later links (Move.spread), each its own delay later
      links := 0
      last = ""
      for target in mo.targets[mv.first:][:mv.count] {
        c, _, _ := mech.value_channel(m, target.index)
        if target.delay == 0 || c.name == last do continue
        last = c.name
        strings.write_string(b, `,"links":[` if links == 0 else `,`)
        links += 1
        for &v, i in row do v = mech.motion_move(mo, k, f32(i) / f32(len(row) - 1), target.delay)
        fmt.sbprintf(b, `{{"channel":%q,"delay":%v,"values":`, c.name, target.delay)
        write_floats(b, row)
        strings.write_byte(b, '}')
      }
      if links > 0 do strings.write_byte(b, ']')
    }
    k := 0
    for src, w in app.asset.anim.clips[clip].motions[q.motion].moves {
      if k >= len(mo.moves) do break
      if w > 0 do strings.write_byte(&b, ',')
      lane(&b, m, rig, app.asset.clips.pose[:], mo, k, row)
      k += 1
      if src.twin != .NONE && k < len(mo.moves) {
        strings.write_string(&b, `,"twin":`)
        lane(&b, m, rig, app.asset.clips.pose[:], mo, k, row)
        strings.write_byte(&b, '}')
        k += 1
      }
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
    inst := find_place(rig, q.part)
    if inst < 0 do return fail(&b, "no instance %s", q.part)
    solve_at(clip, q.time, values)
    stack := mech.place_joints(m, rig.places[inst])
    strings.write_string(&b, `{"joints":[`)
    first := true
    // a joint is one bone
    for bone, i in rig.bones {
      if bone.part != inst || bone.joint < 0 || bone.joint >= len(stack) do continue
      if !first do strings.write_byte(&b, ',')
      first = false
      j := stack[bone.joint]
      x := mech.rig_bone_base(rig, i)
      pos, r := x.position * m.scale, x.rotation
      at, lo, hi := rig.motion[i], bone.lo, bone.hi
      fmt.sbprintf(&b, `{{"name":%q,"kind":%q,"bare":%v,"index":%d,"channel":%q,"pivot":[%v,%v,%v],"rotation":[%v,%v,%v,%v],"axes":[`, j.name, fmt.tprint(j.kind), mech.joint_bare(j), bone.joint, fmt.tprint(mech.place_name(m, rig.places[inst]), ".", j.name, sep = ""), pos.x, pos.y, pos.z, r.x, r.y, r.z, r.w)
      n := 0
      for axis in mech.Axis do if axis in bone.turns {
        if n > 0 do strings.write_byte(&b, ',')
        n += 1
        fmt.sbprintf(&b, `%q`, fmt.tprint(axis))
      }
      fmt.sbprintf(&b, `],"at":[%v,%v,%v],"min":[%v,%v,%v],"max":[%v,%v,%v],"slide":%v,"stroke":[%v,%v]}}`, at.x, at.y, at.z, lo.x, lo.y, lo.z, hi.x, hi.y, hi.z, rig.slide[i], bone.stroke[0], bone.stroke[1])
    }
    strings.write_string(&b, "]}")
  case "moves":
    // the channels that move an instance
    inst := find_place(rig, q.part)
    if inst < 0 do return fail(&b, "no instance %s", q.part)
    strings.write_string(&b, `{"channels":[`)
    moves := mech.rig_moves(rig, inst, context.temp_allocator)
    first := true
    for c in mech.model_channel_table(m) do if moves[c.first] {
      if !first do strings.write_byte(&b, ',')
      first = false
      fmt.sbprintf(&b, `%q`, c.name)
    }
    strings.write_string(&b, "]}")
  case "channels":
    channels(&b, rig)
  case "arc":
    // an arc of the animation, as it would put position `on`
    k := mech.arc_find(app.asset.anim.arcs[:], q.arc)
    if k < 0 do return fail(&b, "no arc %s", q.arc)
    c, ok := mech.model_channel(m, q.on)
    if !ok || c.kind != .POSITION do return fail(&b, "no position %s", q.on)
    sharp := make([dynamic]bool, context.temp_allocator)
    mech.arc_sharp(app.asset.anim.arcs[k], &sharp)
    knots := make([dynamic]f32, context.temp_allocator)
    mech.arc_knots(app.asset.anim.arcs[k], &knots)
    write_arc(&b, rig, app.asset.clips.pose[:], c, q.arc, app.asset.anim.arcs[k].points[:], sharp[:], knots[:], app.asset.anim.arcs[k].closed, 1)
  case "places":
    strings.write_byte(&b, '[')
    for p, i in mech.model_places(m) {
      if i > 0 do strings.write_byte(&b, ',')
      fmt.sbprintf(&b, `{{"name":%q,"inst":%d,"side":%q}}`, mech.place_name(m, p), p.inst, fmt.tprint(p.side))
    }
    strings.write_byte(&b, ']')
  case "twins":
    strings.write_byte(&b, '{')
    first := true
    for c in mech.model_channel_table(m) {
      twin, _ := mech.channel_twin(m, c.first)
      if twin < 0 do continue
      other, _, _ := mech.value_channel(m, twin)
      if !first do strings.write_byte(&b, ',')
      first = false
      fmt.sbprintf(&b, `%q:{{"twin":%q,"flip":`, c.name, other.name)
      flip: [3]f32
      for k in 0 ..< sizes[c.kind] do _, flip[k] = mech.channel_twin(m, c.first + k)
      write_value(&b, flip[:sizes[c.kind]])
      strings.write_string(&b, "}")
    }
    strings.write_byte(&b, '}')
  case "handles":
    solve_at(clip, q.time, values)
    s := m.scale
    o := mech.rig_origin(rig)
    fmt.sbprintf(&b, `{{"scale":%v,"root":{{"position":[%v,%v,%v],"rotation":[%v,%v,%v,%v]}},"iks":[`, s, o.position.x * s, o.position.y * s, o.position.z * s, o.rotation.x, o.rotation.y, o.rotation.z, o.rotation.w)
    for rik, n in rig.iks {
      if n > 0 do strings.write_byte(&b, ',')
      name := ""
      for k, j in mech.model_ik_places(m, rig.places[:]) do if mech.ik_channel(m, j) == rik.channel do name = mech.ik_name(m, k)
      root := mech.place_name(m, rig.places[mech.ik_root(rig.places[:], rik.tip)])
      c := rig.values[rik.channel:]
      r := rik.rest
      at := r + {c[0], c[1], c[2]}
      swivel := c[mech.IK_SWIVEL]
      pole := mech.ik_pole(rig, rik, at, swivel, o)
      fmt.sbprintf(&b, `{{"name":%q,"root":%q,"position":[%v,%v,%v],"rest":[%v,%v,%v]`, name, root, at.x * s, at.y * s, at.z * s, r.x * s, r.y * s, r.z * s)
      if !rik.aim && pole != at {
        fmt.sbprintf(&b, `,"pole":[%v,%v,%v],"swivel":%v,"ring":[`, pole.x * s, pole.y * s, pole.z * s, swivel)
        // the pole at every swivel, a turn from where it is, for drawing and turning it
        RING :: 48
        for k in 0 ..< RING {
          if k > 0 do strings.write_byte(&b, ',')
          p := mech.ik_pole(rig, rik, at, swivel + f32(k) / RING * 2 * math.PI, o)
          fmt.sbprintf(&b, `[%v,%v,%v]`, p.x * s, p.y * s, p.z * s)
        }
        strings.write_byte(&b, ']')
      }
      strings.write_byte(&b, '}')
    }
    strings.write_string(&b, "]}")
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

// find_place is the place named `name`: a placed instance's name (`l_arm`), or an instance's of the
// assembly (`arm`: its left side when it is on both); -1 for none.
@(private = "file")
find_place :: proc(rig: ^mech.Rig, name: string) -> int {
  m := rig.model
  if p := mech.model_place(m, rig.places[:], name); p >= 0 do return p
  if i := mech.model_instance(m, name); i >= 0 do for p, k in rig.places do if p.inst == i do return k
  return -1
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

// write_arc writes arc `name`'s points `pts` (`sharp`: its corners; `knots`: where along it each is; `closed`: back to the first) as they put position channel `c` (times `flip`: a
// twin's, mirrored), for drawing and dragging: {name (the channel), arc, points, curve (the arc
// through them, 64 points)}, in metres. They are offsets from where the channel is at rest (an
// IK target's tip, or the origin, lifted), with the rest pose's amounts: where the rest pose has it.
@(private = "file")
write_arc :: proc(b: ^strings.Builder, rig: ^mech.Rig, pose: []f32, c: mech.Channel, name: string, pts: [][3]f32, sharp: []bool, knots: []f32, closed: bool, flip: [3]f32) {
  m := rig.model
  rest := [3]f32{0, rig.lift, 0}
  for ik in rig.iks do if ik.channel == c.first do rest = ik.rest
  for n in 0 ..< 3 do rest[n] += pose[c.first + n]
  point :: proc(b: ^strings.Builder, p: [3]f32) {fmt.sbprintf(b, `[%v,%v,%v]`, p.x, p.y, p.z)}
  s := m.scale
  fmt.sbprintf(b, `{{"name":%q,"arc":%q,"points":[`, c.name, name)
  for p, i in pts {
    if i > 0 do strings.write_byte(b, ',')
    point(b, (rest + p * flip) * s)
  }
  strings.write_string(b, `],"curve":[`)
  N :: 64
  for i in 0 ..< N {
    if i > 0 do strings.write_byte(b, ',')
    point(b, (rest + mech.arc_at(pts, sharp, f32(i) / (N - 1), closed, knots) * flip) * s)
  }
  strings.write_string(b, "]}")
}

// pick_channels is the channels named, every channel for none.
@(private = "file")
pick_channels :: proc(names: []string) -> []mech.Channel {
  m := app.asset.model
  if names == nil do return mech.model_channel_table(m)
  out := make([dynamic]mech.Channel)
  for n in names {
    c, ok := mech.model_channel(m, n)
    if !ok {
      log.warnf("query: no channel %s", n)
      continue
    }
    append(&out, c)
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

// write_value writes one channel's values: a number, or [x, y, z].
@(private = "file")
write_value :: proc(b: ^strings.Builder, xs: []f32) {
  if len(xs) == 1 do fmt.sbprintf(b, "%v", xs[0] if !math.is_nan(xs[0]) && !math.is_inf(xs[0]) else 0)
  else do write_floats(b, xs)
}

// write_values writes a pose's values by channel: {name: value | [x, y, z]}.
@(private = "file")
write_values :: proc(b: ^strings.Builder, values: []f32) {
  m := app.asset.model
  sizes := mech.CHANNEL_SIZE
  strings.write_byte(b, '{')
  for c, i in mech.model_channel_table(m) {
    if i > 0 do strings.write_byte(b, ',')
    fmt.sbprintf(b, "%q:", c.name)
    if c.first + sizes[c.kind] <= len(values) do write_value(b, values[c.first:][:sizes[c.kind]])
    else do strings.write_string(b, "0")
  }
  strings.write_byte(b, '}')
}

@(private = "file")
state :: proc(b: ^strings.Builder) {
  fmt.sbprintf(b, `{{"ready":%v,"time":%v,"duration":%v,"playing":%v,"values":`, app.has_mech, app.time, clip_length(app.clip), app.playing)
  if app.has_mech do write_values(b, character.mech_shown(&app.mech))
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
  fmt.sbprintf(b, `{{"parts":%d,"bones":%d,"pieces":%d,"meshes":%d,"materials":%d,"clips":[`, len(mech.model_places(m)), bones, pieces, len(app.library.meshes), len(app.library.materials))
  for c, i in app.asset.clips.clips {
    if i > 0 do strings.write_byte(b, ',')
    fmt.sbprintf(b, `{{"name":%q,"duration":%v,"motions":%d}}`, c.name, c.duration, len(c.motions))
  }
  strings.write_string(b, "]}")
}

// channels lists every channel of the model (mech.model_channel_table) with what its controls
// need (see the top).
@(private = "file")
channels :: proc(b: ^strings.Builder, rig: ^mech.Rig) {
  m := app.asset.model
  // positions range over the posed model, half its size again each way, in model units
  lo, hi := mech.rig_bounds(rig)
  lo, hi = lo / m.scale, hi / m.scale
  pad := (hi - lo) / 2
  lo, hi = lo - pad, hi + pad
  sizes := mech.CHANNEL_SIZE
  // each joint value's range, by value
  joints := make([][2]f32, mech.model_channels(m))
  n := mech.root_channel(m) + mech.ROOT_VALUES
  places := mech.model_places(m)
  // per joint value, the place it moves
  owners := make([]int, mech.model_channels(m), context.temp_allocator)
  for p, i in places do for j in mech.place_joints(m, p) {
    dofs, count := mech.joint_axes(j)
    for axis, k in dofs[:count] do joints[n + k], owners[n + k] = {j.min[axis], j.max[axis]}, i
    n += count
  }
  iks := mech.model_ik_places(m, places)
  strings.write_byte(b, '[')
  for c, i in mech.model_channel_table(m) {
    if i > 0 do strings.write_byte(b, ',')
    size := sizes[c.kind]
    min, max: [3]f32
    owner, key := "", ""
    switch {
    case c.first < mech.root_channel(m):
      owner, key = mech.ik_name(m, iks[c.first / mech.IK_VALUES]), "ik"
    case c.first >= mech.root_channel(m) + mech.ROOT_VALUES:
      owner, key = mech.place_name(m, places[owners[c.first]]), "part"
    }
    switch c.kind {
    case .POSITION:
      min, max = lo, hi
    case .WEIGHT:
      min, max = 0, 1
    case .HINGE, .SLIDE, .BALL:
      if key == "part" {
        for k in 0 ..< size do min[k], max[k] = joints[c.first + k][0], joints[c.first + k][1]
      } else {
        min, max = -math.PI, math.PI
      }
    }
    fmt.sbprintf(b, `{{"name":%q,"kind":%q,"size":%d,"min":`, c.name, fmt.tprint(c.kind), size)
    write_floats(b, min[:size])
    strings.write_string(b, `,"max":`)
    write_floats(b, max[:size])
    if key != "" do fmt.sbprintf(b, `,%q:%q`, key, owner)
    strings.write_byte(b, '}')
  }
  strings.write_byte(b, ']')
}

// dofs: a joint's degrees of freedom as the engine has them, for the editors to name channels by
// (the "dofs" query); it needs no model.
@(private = "file")
dofs :: proc(b: ^strings.Builder, j: mech.Joint) {
  axes, count := mech.joint_axes(j)
  fmt.sbprintf(b, `{{"bare":%v,"plates":%v,"axes":[`, mech.joint_bare(j), mech.joint_has_plates(j))
  for axis, k in axes[:count] {
    if k > 0 do strings.write_byte(b, ',')
    fmt.sbprintf(b, `%q`, fmt.tprint(axis))
  }
  strings.write_string(b, "]}")
}

