package main

import "core:encoding/json"
import "core:fmt"
import "core:log"
import "core:math"
import "core:strings"
import "../character"
import "../mech"
import "../mjolnir/geometry"
import "../mjolnir/render"

// Queries let the page ask the engine questions: what a clip gives at any time, where parts would
// be, what the model holds. A query is JSON in, JSON out; every answer comes from the same code the
// game runs. Answers never change what the viewer shows (a solve for another time is undone by the
// next frame's pose).
//
//   {"q": "state"}
//     the clock, the channels as shown now (after drivers and leg IK), warnings since last asked
//   {"q": "sample", "clip": "walk", "channels": ["l_hip"], "n": 60 | "times": [..], "solved": true}
//     channel values over a clip (default: the current clip, every channel); `solved` applies
//     drivers and leg IK, as the rig would show them
//   {"q": "pose", "clip": "attack", "time": 0.4}      or {"q": "pose", "pose": "ready"}
//     every channel at one moment: {"raw": {..}, "solved": {..}}
//   {"q": "parts", "clip": .., "time": .., "parts": ["l_palm"]}
//     each part's frame in the world at that moment (default: now, every part)
//   {"q": "trajectory", "clip": "walk", "part": "l_foot", "n": 60}
//     a part's world position over a clip: motion paths, foot slide
//   {"q": "bounds", "clip": .., "time": ..}
//     the box around the posed model
//   {"q": "faces", "part": "torso"}
//     the six faces of each of the part's shapes ({position, normal} in the part's frame, model
//     units; +x, -x, +y, -y, +z, -z of the shape's axes), for snapping sockets
//   {"q": "project", "points": [[x, y, z], ..]}
//     where world points show on the canvas (CSS pixels from its corner), null behind the
//     camera: {points: [[x, y] | null, ..]}, for drawing over the view
//   {"q": "pick", "x": 120, "y": 80}
//     the nearest shown piece under a point of the canvas (CSS pixels from its corner):
//     {part, shape} as indices, shape -1 for joint hardware, both -1 for nothing
//   {"q": "joints"}
//     each joint's geometry, by name ("" is no joint, FIXED): the face it bolts to the socket with
//     (female) and the face the part's mount bolts to (male), in the joint's frame, and its
//     degrees of freedom in bind order: {axis: 0 x | 1 y | 2 z, offset, rest: [x, y, z, w]},
//     each bone placed in the previous one's frame (the joint's for the first)
//   {"q": "info"}
//     counts, clips, and channels nothing moves
// Units: channel values as they are (radians for angles), world positions in metres, rotations as
// quaternions [x, y, z, w]. Unknown names answer {"error": ".."}.

Query :: struct {
  q:        string,
  clip:     string,
  pose:     string,
  time:     Maybe(f32),
  times:    []f32,
  n:        int,
  channels: []string,
  part:     string,
  parts:    []string,
  solved:   bool,
  x, y:     f32,
  points:   [][3]f32,
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
  values := make([]f32, len(m.channels))
  rig := character.mech_rig(&app.mech)

  switch q.q {
  case "sample":
    picked, _ := pick_channels(q.channels)
    rows := make([][]f32, len(picked))
    for &r in rows do r = make([]f32, len(times))
    for t, k in times {
      mech.clip_sample(&app.asset.clips, clip, t, values)
      src := values
      if q.solved {
        mech.rig_solve(rig, values)
        src = rig.solved[:]
      }
      for ch, r in picked do rows[r][k] = src[ch]
    }
    strings.write_string(&b, `{"times":`)
    write_floats(&b, times)
    strings.write_string(&b, `,"channels":{`)
    for ch, r in picked {
      if r > 0 do strings.write_byte(&b, ',')
      fmt.sbprintf(&b, "%q:", m.channels[ch].name)
      write_floats(&b, rows[r])
    }
    strings.write_string(&b, "}}")
  case "pose":
    if q.pose != "" {
      p := mech.animation_pose(app.asset.anim, q.pose)
      if p < 0 do return fail(&b, "no pose %s", q.pose)
      mech.pose_values(&app.asset.clips, p, values)
    } else {
      mech.clip_sample(&app.asset.clips, clip, q.time.? or_else app.time, values)
    }
    strings.write_string(&b, `{"raw":`)
    write_channels(&b, values)
    mech.rig_solve(rig, values)
    strings.write_string(&b, `,"solved":`)
    write_channels(&b, rig.solved[:])
    strings.write_byte(&b, '}')
  case "parts":
    solve_at(clip, q.time, values)
    strings.write_byte(&b, '{')
    first := true
    for p, i in m.parts {
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
    part := mech.model_part(m, q.part)
    if part < 0 do return fail(&b, "no part %s", q.part)
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
      for f, i in mech.shape_faces(s) {
        if i > 0 do strings.write_byte(&b, ',')
        p, n := f.position, f.normal
        fmt.sbprintf(&b, `{{"position":[%v,%v,%v],"normal":[%v,%v,%v]}}`, p.x, p.y, p.z, n.x, n.y, n.z)
      }
      strings.write_byte(&b, ']')
    }
    strings.write_string(&b, "]}")
  case "joints":
    strings.write_byte(&b, '{')
    for j, k in m.joints {
      if k > 0 do strings.write_byte(&b, ',')
      write_joint(&b, j.name, j)
    }
    if len(m.joints) > 0 do strings.write_byte(&b, ',')
    write_joint(&b, "", {}) // no joint: FIXED
    strings.write_byte(&b, '}')
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
pick_channels :: proc(names: []string) -> (picked: []int, ok: bool) {
  m := app.asset.model
  if names == nil {
    picked = make([]int, len(m.channels))
    for &p, i in picked do p = i
    return picked, true
  }
  out := make([dynamic]int)
  for n in names {
    ch := mech.model_channel(m, n)
    if ch < 0 {
      log.warnf("query: no channel %s", n)
      continue
    }
    append(&out, ch)
  }
  return out[:], true
}

@(private = "file")
contains :: proc(list: []string, s: string) -> bool {
  for x in list do if x == s do return true
  return false
}

@(private = "file")
write_joint :: proc(b: ^strings.Builder, name: string, j: mech.Joint) {
  female, male := mech.joint_mounts(j)
  fmt.sbprintf(b, `%q:{{"female":`, name)
  write_face(b, female)
  strings.write_string(b, `,"male":`)
  write_face(b, male)
  strings.write_string(b, `,"dofs":[`)
  dofs, count := mech.joint_dofs(j)
  for &d, i in dofs[:count] {
    if i > 0 do strings.write_byte(b, ',')
    r := d.rest
    fmt.sbprintf(b, `{{"axis":%d,"offset":`, d.axis)
    write_floats(b, d.offset[:])
    fmt.sbprintf(b, `,"rest":[%v,%v,%v,%v]}}`, r.x, r.y, r.z, r.w)
  }
  strings.write_string(b, "]}")
}

@(private = "file")
write_face :: proc(b: ^strings.Builder, f: geometry.Face) {
  p, n, w := f.position, f.normal, f.forward
  fmt.sbprintf(b, `{{"position":`)
  write_floats(b, p[:])
  strings.write_string(b, `,"normal":`)
  write_floats(b, n[:])
  strings.write_string(b, `,"forward":`)
  write_floats(b, w[:])
  strings.write_byte(b, '}')
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

// write_channels writes channel values as {name: value}.
@(private = "file")
write_channels :: proc(b: ^strings.Builder, values: []f32) {
  m := app.asset.model
  strings.write_byte(b, '{')
  for c, i in m.channels {
    if i > 0 do strings.write_byte(b, ',')
    v := values[i] if i < len(values) else 0
    fmt.sbprintf(b, "%q:%v", c.name, v if !math.is_nan(v) else 0)
  }
  strings.write_byte(b, '}')
}

@(private = "file")
state :: proc(b: ^strings.Builder) {
  fmt.sbprintf(b, `{{"ready":%v,"time":%v,"duration":%v,"playing":%v,"channels":`, app.has_mech, app.time, clip_length(app.clip), app.playing)
  if app.has_mech do write_channels(b, character.mech_shown(&app.mech))
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
  fmt.sbprintf(b, `{{"parts":%d,"bones":%d,"pieces":%d,"meshes":%d,"materials":%d,"clips":[`, len(m.parts), bones, pieces, len(app.library.meshes), len(app.library.materials))
  for c, i in app.asset.clips.clips {
    if i > 0 do strings.write_byte(b, ',')
    fmt.sbprintf(b, `{{"name":%q,"duration":%v,"keys":%d}}`, c.name, c.duration, len(c.keys))
  }
  // channels nothing moves: no bind, no driver target or source, not a leg or the level
  strings.write_string(b, `],"unused_channels":[`)
  first := true
  for c in m.channels {
    used := m.level == c.name
    for p in m.parts do for bind in p.binds do used ||= bind.channel == c.name
    for d in m.drivers do used ||= d.source == c.name || d.target == c.name
    for l in m.legs do used ||= l.hip == c.name || l.knee == c.name || l.ankle == c.name
    if used do continue
    if !first do strings.write_byte(b, ',')
    first = false
    fmt.sbprintf(b, "%q", c.name)
  }
  strings.write_string(b, "]}")
}
