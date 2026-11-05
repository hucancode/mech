#+build !js
package mech

import "core:encoding/json"
import "core:fmt"
import "core:log"
import "core:math"
import "core:math/linalg"
import "core:os"
import "core:slice"
import "core:strings"
import "core:testing"
import "../mjolnir/animation"
import "../mjolnir/world"

@(private = "file")
ASSETS :: #directory + "/../../assets/characters/"

@(private = "file")
read :: proc(t: ^testing.T, name: string) -> []u8 {
  data, err := os.read_entire_file(fmt.tprint(ASSETS, name, sep = ""), context.allocator)
  testing.expectf(t, err == nil, "read %s: %v", name, err)
  return data
}

// value_of is value `axis` of channel `name` of a pose of `m`, -1 for none.
@(private = "file")
value_of :: proc(m: ^Model, name: string, axis := 0) -> int {
  c, ok := model_channel(m, name)
  return c.first + axis if ok else -1
}

// Parsing a character file and formatting it again gives the same bytes, so saves only show
// real changes in a diff.
@(test)
test_files_round_trip :: proc(t: ^testing.T) {
  for name in ([]string{"mech", "dragon", "strider", "spider", "tiger", "eagle", "shark"}) {
    text := read(t, fmt.tprint(name, ".json", sep = ""))
    defer delete(text)
    m, a, ok := character_parse(text)
    testing.expect(t, ok)
    defer model_destroy(m)
    defer animation_destroy(a)
    out := character_format(m, a)
    defer delete(out)
    testing.expectf(t, out == string(text), "%s.json does not round-trip", name)
  }
}

// The characters' clips are motions. The ones that loop (idle, combat_idle,
// walk, run, slither) end where they start, so they loop without a jump; in the gaits, planted
// feet never sink through the ground, nor slide sideways.
@(test)
test_shipped_clips :: proc(t: ^testing.T) {
  LOOPS :: []string{"idle", "combat_idle", "walk", "run", "slither"}
  for name in ([]string{"mech", "dragon", "strider", "spider", "tiger", "eagle", "shark"}) {
    text := read(t, fmt.tprint(name, ".json", sep = ""))
    defer delete(text)
    m, a, ok := character_parse(text)
    if !testing.expect(t, ok) do continue
    defer model_destroy(m)
    defer animation_destroy(a)
    w: world.World
    world.init(&w, 4096)
    defer world.shutdown(&w)
    lib: Library
    rig, _ := rig_create(&lib, &w, nil, m, w.root)
    defer rig_destroy(rig, &w)
    clips := clips_build(a, m)
    defer clips_destroy(&clips)
    start, end := make([]f32, model_channels(m)), make([]f32, model_channels(m))
    defer delete(start)
    defer delete(end)
    for clip, c in a.clips {
      testing.expectf(t, len(clip.motions) > 0, "%s %s: motions", name, clip.name)
      loops := false
      for l in LOOPS do loops ||= l == clip.name
      if !loops do continue
      clip_sample(&clips, c, 0, start)
      clip_sample(&clips, c, clip.duration, end)
      for v, i in start do testing.expectf(t, abs(v - end[i]) < 1e-4, "%s %s loops: %s %v, then %v", name, clip.name, value_name(m, i), v, end[i])
      if clip.name != "walk" && clip.name != "run" do continue
      // the ground: the feet at rest, the legs reaching (every IK target that holds a foot)
      feet := make([dynamic]int, context.temp_allocator)
      for ik in rig.iks do if ik.holds do append(&feet, ik.tip)
      if len(feet) == 0 do continue
      copy(end, clips.pose[:])
      for &v, i in end do if i >= root_channel(m) do v = 0
      for ik in rig.iks do if ik.holds {
        for k in 0 ..< 3 do end[ik.channel + k] = 0
        end[ik.channel + IK_WEIGHT] = 1
      }
      rig_solve(rig, end)
      rest := make([][3]f32, len(feet), context.temp_allocator)
      for f, n in feet do rest[n] = rig_frame(rig, f).position
      for k in 0 ..= 60 {
        clip_sample(&clips, c, clip.duration * f32(k) / 60, end)
        rig_solve(rig, end)
        for f, n in feet {
          p := rig_frame(rig, f).position
          testing.expectf(t, p.y > rest[n].y - 0.01 && abs(p.x - rest[n].x) < 0.01, "%s %s: %s at %v, rest %v", name, clip.name, place_name(m, model_places(m)[f]), p, rest[n])
        }
      }
    }
  }
}

@(test)
test_euler_round_trip :: proc(t: ^testing.T) {
  for e in ([][3]f32{{0, 0, 0}, {90, 0, -90}, {0, 180, 0}, {30, -45, 60}, {-120, 10, 5}}) {
    back := animation.joint_euler(euler_from(animation.joint_euler(e)))
    q := animation.joint_euler(e)
    d := abs(back.x * q.x + back.y * q.y + back.z * q.z + back.w * q.w)
    testing.expectf(t, d > 0.99999, "euler %v does not round-trip", e)
  }
}

// A shape's faces sit half its size out along its own (turned) axes.
@(test)
test_shape_faces :: proc(t: ^testing.T) {
  s := Shape{position = {1, 2, 3}, size = {2, 4, 6}, rotation = {0, 0, math.PI / 2}}
  f := shape_faces(Part{}, s)
  near :: proc(a, b: [3]f32) -> bool {return abs(a.x - b.x) + abs(a.y - b.y) + abs(a.z - b.z) < 1e-4}
  // turned 90° about z, the shape's +x points along +y
  testing.expect(t, near(f[0].normal, {0, 1, 0}))
  testing.expect(t, near(f[0].position, {1, 3, 3}))
  testing.expect(t, near(f[3].position, {3, 2, 3})) // -y side: 2 out along +x
  testing.expect(t, near(f[4].position, {1, 2, 6}))
}

// A hinge's hardware fits whatever its reach: its pivot is reach × size out, its lugs clear the
// plate they rise from and hold their pin; too close for lugs it is a bare pin on the socket.
@(test)
test_hinge_dims :: proc(t: ^testing.T) {
  for size in ([]f32{0.1, 0.3, 1}) {
    for k in 0 ..= 60 {
      reach := f32(k) * 0.05
      d := joint_dims(Joint{kind = .PIN, size = size, reach = reach})
      if d.lug_d == 0 {
        testing.expectf(t, d.reach == 0 && d.shank == 0 && d.flange_t == 0 && d.pin_r > 0, "reach %v: a bare pin on the socket", reach)
        continue
      }
      testing.expectf(t, abs(d.reach - reach * size) < 1e-5, "reach %v: pivots %v out", reach, d.reach)
      testing.expectf(t, abs(d.shank + d.flange_t - d.reach) < 1e-5, "reach %v: lug and plate make the reach", reach)
      testing.expectf(t, d.shank - d.lug_d / 2 >= 0.049 * size, "reach %v: the barrel clears the plate", reach)
      testing.expectf(t, d.pin_r < d.lug_d / 2 && d.clr < d.jaw, "reach %v: the pin sits in the lug", reach)
    }
  }
  bare := joint_dims(Joint{kind = .PIN, size = 0.1})
  testing.expect(t, bare.lug_d == 0 && abs(bare.pin_r - 0.035) < 1e-6, "no reach: a bare pin")
  testing.expect(t, joint_dims(Joint{kind = .PIN, reach = 1}) == Dims{}, "size 0 builds nothing")
}

// A ball's stud is long enough that, at the joint's widest tilt, the male flange is above the
// socket or past its side; a wider range lengthens it, and a free one takes the most.
@(test)
test_ball_dims :: proc(t: ^testing.T) {
  last: f32 = 0
  for k in 1 ..= 14 {
    a := f32(k) * 5 * math.RAD_PER_DEG
    d := joint_dims(Joint{kind = .BALL, size = 1, min = {-a, 0, 0}, max = {a, 0, 0}})
    f, top := 0.375 * d.flange_w, d.ball_r + d.stud_len
    // the flange's lowest rim point, tilted by a about x
    below := top * math.cos(a) - f * math.sin(a) < 0
    outside := top / math.sin(a) >= d.socket_r
    testing.expectf(t, !below || outside, "tilt %v: the flange clears the socket", a)
    testing.expectf(t, d.stud_len >= last, "tilt %v: a wider range, a longer stud", a)
    testing.expect(t, d.stud_r < d.ball_r)
    last = d.stud_len
  }
  free := joint_dims(Joint{kind = .BALL, size = 1})
  testing.expect(t, free.stud_len >= last - 1e-6, "a free ball tilts the furthest")
}

// A stretched shape runs its part's length, from the origin up to where it hangs: centred halfway,
// its size.y plus the length; a longer part lengthens it. Unstretched, the part's frame.
@(test)
test_shape_stretch :: proc(t: ^testing.T) {
  near :: proc(a, b: [3]f32) -> bool {return abs(a.x - b.x) + abs(a.y - b.y) + abs(a.z - b.z) < 1e-4}
  p := Part{length = 0.6}
  s := Shape{stretch = true, position = {0, 0.01, 0}, size = {0.3, 0.04, 0.3}}
  at, _, size := shape_place(p, s)
  testing.expect(t, near(at, {0, 0.31, 0}) && near(size, {0.3, 0.64, 0.3}))
  p.length = 1
  _, _, size = shape_place(p, s)
  testing.expect(t, abs(size.y - 1.04) < 1e-4)
  at, _, size = shape_place(p, Shape{position = {1, 2, 3}, size = {1, 1, 1}})
  testing.expect(t, near(at, {1, 2, 3}) && near(size, {1, 1, 1}))
}

// What the rig reports a joint turned by (rig_angles, the viewer's readout) is what its drives
// turned it by, within its stops, with every IK let go.
@(test)
test_rig_angles_are_drives :: proc(t: ^testing.T) {
  for name in ([]string{"mech", "dragon", "strider", "spider", "tiger", "eagle", "shark"}) {
    text, _ := os.read_entire_file(fmt.tprint(#directory + "/../../assets/characters/", name, ".json", sep = ""), context.allocator)
    defer delete(text)
    m, a, ok := character_parse(text)
    testing.expect(t, ok)
    defer model_destroy(m)
    defer animation_destroy(a)
    w: world.World
    world.init(&w, 4096)
    defer world.shutdown(&w)
    lib: Library
    rig, _ := rig_create(&lib, &w, nil, m, w.root)
    defer rig_destroy(rig, &w)
    values := model_pose(m, context.temp_allocator)
    for &v, i in values do v += 0.1 * f32(i % 5) // off rest, every joint
    for k in 0 ..< ik_count(m) do values[ik_channel(m, k) + IK_WEIGHT] = 0
    rig_solve(rig, values)
    want := make([][3]f32, len(rig.bones), context.temp_allocator)
    for d in rig.drives do if !d.slide do want[d.bone][d.axis] += values[d.channel] * d.turn
    for _, i in rig.bones {
      w := animation.joint_clamp(want[i], rig.limits[i])
      got := rig_angles(rig, i)
      testing.expectf(t, linalg.length(got - w) < 1e-4, "%s bone %d: turned %v, drives %v", name, i, got, w)
    }
  }
}

// A joint's range holds its bone's motion; a mirror that turns an axis over turns its range over;
// an axis with equal ends is free.
@(test)
test_joint_limits :: proc(t: ^testing.T) {
  knee := Joint{kind = .PIN, min = {-2.5, 0, 0}, max = {0.1, 0, 0}}
  b := joint_limit(knee, MIRROR_NONE)
  mo := animation.joint_clamp({-3, 1, 0}, b)
  testing.expect(t, mo.x == -2.5 && mo.y == 0, "x held, y locked (a pin turns about x only)")
  testing.expect(t, animation.joint_clamp({0.5, 0, 0}, b).x == 0.1)
  ball := joint_limit(Joint{kind = .BALL, min = {-1, 0, 0}, max = {1, 0, 0}}, MIRROR_NONE)
  testing.expect(t, animation.joint_clamp({0, 5, 0}, ball).y == 5, "a ball's axis with equal ends is free")
  mi := MIRROR_NONE
  mi.turn[.X] = true
  flipped := joint_limit(knee, mi)
  testing.expect(t, flipped.lo.x == -0.1 && flipped.hi.x == 2.5, "mirrored: turned over")
}

// A turntable pivots where its discs meet; with no size it pivots on the socket, as it always did.
@(test)
test_spin_mounts :: proc(t: ^testing.T) {
  a, m := joint_mounts(Joint{kind = .SPIN, size = 0.4})
  testing.expect(t, abs(a.position.y - 0.05) < 1e-6 && abs(m.position.y + 0.05) < 1e-6)
  a, m = joint_mounts(Joint{kind = .SPIN})
  testing.expect(t, a.position == {} && m.position == {})
}

// A pose's channels: each IK target's (its target, swivel and weight, even when it aims), the
// root's, then every instance's joints, each a channel shaped as it moves (ChannelKind). Clips
// key them all by name.
@(test)
test_channels :: proc(t: ^testing.T) {
  m := Model{}
  append(&m.iks, Ik{name = "leg", aim = true}, Ik{name = "arm"})
  append(&m.parts, Part{name = "limb"})
  append(&m.parts[0].joints, Joint{name = "hip", kind = .BALL}, Joint{name = "knee", kind = .PIN})
  append(&m.assembly, Instance{name = "l_leg", part = "limb"}, Instance{name = "r_leg", part = "limb"})
  defer {
    delete(m.iks)
    delete(m.parts[0].joints)
    delete(m.parts)
    delete(m.assembly)
  }
  // 5 + 5 IK, 6 root, then 2 instances of 3 + 1 values
  testing.expect(t, model_channels(&m) == 10 + 6 + 8)
  want := []Channel {
    {"leg", .POSITION, 0},
    {"leg.swivel", .HINGE, 3},
    {"leg.weight", .WEIGHT, 4},
    {"arm", .POSITION, 5},
    {"arm.swivel", .HINGE, 8},
    {"arm.weight", .WEIGHT, 9},
    {"root", .POSITION, 10},
    {"root.turn", .BALL, 13},
    {"l_leg.hip", .BALL, 16},
    {"l_leg.knee", .HINGE, 19},
    {"r_leg.hip", .BALL, 20},
    {"r_leg.knee", .HINGE, 23},
  }
  table := model_channel_table(&m)
  testing.expectf(t, slice.equal(table, want), "the channels: %v", table)
  for w in want {
    c, ok := model_channel(&m, w.name)
    testing.expectf(t, ok && c == w, "%s: %v", w.name, c)
  }
  testing.expect(t, value_name(&m, 15) == "root.turn[2]" && value_name(&m, 19) == "l_leg.knee")
  for name in ([]string{"b", "leg_x", "leg.x", "l_leg.hip.x", "l_leg.knee.x", "l_leg", "l_leg.", "root_turn"}) {
    _, ok := model_channel(&m, name)
    testing.expectf(t, !ok, "%s is no channel", name)
  }
}

// Mechanical eases: each runs 0 to 1. SETTLE reaches its stop fast and bounces on it, dying out;
// STEP holds, then snaps at the end.
@(test)
test_mechanical_eases :: proc(t: ^testing.T) {
  for e in Ease {
    testing.expectf(t, math.abs(ease(e, 0)) < 1e-6 && math.abs(ease(e, 1) - 1) < 1e-6, "%v: %v to %v", e, ease(e, 0), ease(e, 1))
  }
  testing.expectf(t, ease(.SETTLE, 1.0 / 3) > 1.15, "SETTLE overshoots: %v", ease(.SETTLE, 1.0 / 3))
  testing.expectf(t, ease(.SETTLE, 2.0 / 3) < 1, "SETTLE bounces back: %v", ease(.SETTLE, 2.0 / 3))
  testing.expectf(t, ease(.STEP, 0.99) == 0, "STEP holds: %v", ease(.STEP, 0.99))
  // a ratchet: STEP points hold each value until the next, and the shape is whole at its points
  RATCHET :: []Point{{u = 0, v = 0}, {u = 0.5, v = 1, ease = .STEP}, {u = 1, v = 0, ease = .STEP}}
  testing.expect(t, shape_value(RATCHET, 0.25) == 0)
  testing.expect(t, shape_value(RATCHET, 0.5) == 1)
  testing.expect(t, shape_value(RATCHET, 0.75) == 1)
  testing.expect(t, shape_value(RATCHET, 0.999) == 1)
}

// Shapes the editor starts from: a sine, a foot sliding (down for 0.6 of its cycle) and
// lifting, a strike's pulse (rising by IN over its first quarter, settling back).
@(private = "file")
SINE :: []Point{{u = 0.25, v = 1}, {u = 0.75, v = -1}}
@(private = "file")
SLIDE :: []Point{{u = 0, v = 0.5}, {u = 0.6, v = -0.5, ease = .LINEAR}, {u = 1, v = 0.5}}
@(private = "file")
LIFT :: []Point{{u = 0.6, v = 0}, {u = 0.8, v = 1, ease = .OUT}, {u = 1, v = 0, ease = .IN}}
@(private = "file")
PULSE :: []Point{{u = 0, v = 0}, {u = 0.25, v = 1, ease = .IN}, {u = 1, v = 0}}

// shape_value: each point reached by its ease from the one before, wrapping every cycle, a whole
// cycle in being the cycle's end.
@(test)
test_shape :: proc(t: ^testing.T) {
  near :: proc(a, b: f32) -> bool {return abs(a - b) < 1e-4}
  testing.expect(t, shape_value(nil, 0.3) == 1, "no points: 1 throughout")
  testing.expect(t, near(shape_value(SINE, 0.25), 1) && near(shape_value(SINE, 0), 0) && near(shape_value(SINE, -0.25), -1), "a sine, wrapping")
  slide :: proc(u: f32) -> f32 {return shape_value(SLIDE, u)}
  lift :: proc(u: f32) -> f32 {return shape_value(LIFT, u)}
  testing.expect(t, near(slide(0), 0.5) && lift(0) == 0, "touches down ahead")
  testing.expect(t, near(slide(0.3), 0) && lift(0.3) == 0, "halfway through its stance: under the hip, down")
  testing.expect(t, near(slide(0.8), 0) && near(lift(0.8), 1), "mid-swing: at the top, under the hip")
  testing.expect(t, near(slide(1.3), slide(0.3)), "the cycle repeats")
  pulse :: proc(u: f32) -> f32 {return shape_value(PULSE, u)}
  testing.expect(t, near(pulse(0.125), 0.25), "rising by its ease (IN: x²)")
  testing.expect(t, near(pulse(0.25), 1) && near(pulse(0.625), 0.5) && near(pulse(1), 0), "at its peak, then settling")
  // a shape that ends elsewhere than it starts: at a whole cycle it is at its end, just after it,
  // back at its start
  RISE :: []Point{{u = 0, v = 0}, {u = 1, v = 1}}
  testing.expect(t, shape_value(RISE, 0) == 0 && shape_value(RISE, 1) == 1 && near(shape_value(RISE, 1.00001), 0), "a whole cycle is the end")
}

// A strike on the dragon's model: each move `delay` late, the shape's points placing it in the clip.
@(test)
test_motion_moves :: proc(t: ^testing.T) {
  text := read(t, "dragon.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  testing.expect(t, ok)
  defer model_destroy(m)
  defer animation_destroy(a)
  // a strike over the clip's second quarter to its third (rising to its peak, back), the second
  // move a quarter of the clip behind the first
  STRIKE :: `{"clips": [{"name": "strike", "duration": 2, "motions": [{"shape": [{"u": 0.25}, {"u": 0.5, "v": 1}, {"u": 0.75}], "moves": [{"by": {"root": [0, -1, 0]}}, {"delay": 0.25, "by": {"root": [0, 0, 2]}}]}]}]}`
  strike, sok := animation_parse(transmute([]u8)string(STRIKE))
  if !testing.expect(t, sok) do return
  defer animation_destroy(strike)
  clips := clips_build(strike, m)
  defer clips_destroy(&clips)
  values := make([]f32, model_channels(m))
  defer delete(values)
  root := root_channel(m)
  near :: proc(a, b: f32) -> bool {return abs(a - b) < 1e-4}
  for &p in clips.pose do p = 0
  clip_sample(&clips, 0, 0.4, values)
  testing.expect(t, values[root + 1] == 0 && values[root + 2] == 0, "nothing before its time")
  clip_sample(&clips, 0, 1, values)
  testing.expectf(t, near(values[root + 1], -1) && values[root + 2] == 0, "the first move peaks as the last sets out: %v %v", values[root + 1], values[root + 2])
  clip_sample(&clips, 0, 1.5, values)
  testing.expectf(t, near(values[root + 2], 2) && near(values[root + 1], 0), "then the last peaks, the first settled: %v %v", values[root + 1], values[root + 2])
}

// A procedural walk on a real rig: the legs reach (no shape, held, on their weights), the stance foot stays on the ground sliding straight back and lifts swinging ahead
// (a slide and a lift), the root crouches (no shape: held) and dips as feet touch down (a sine
// twice a cycle).
@(test)
test_motion_walks :: proc(t: ^testing.T) {
  text := read(t, "strider.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  testing.expect(t, ok)
  defer model_destroy(m)
  defer animation_destroy(a)
  w: world.World
  world.init(&w, 4096)
  defer world.shutdown(&w)
  lib: Library
  rig, _ := rig_create(&lib, &w, nil, m, w.root)
  defer rig_destroy(rig, &w)
  // stride 1, lift 0.4, duty 0.6, crouch 0.3, bob 0.1; the right foot half a cycle behind the left
  WALK :: `{"clips": [{"name": "walk", "duration": 1, "motions": [
    {"shape": [{"v": 0.5}, {"u": 0.6, "v": -0.5}, {"u": 1, "v": 0.5}], "moves": [{"by": {"l_leg": [0, 0, 1]}}, {"delay": 0.5, "by": {"r_leg": [0, 0, 1]}}]},
    {"shape": [{"u": 0.6}, {"u": 0.8, "v": 1, "ease": "OUT"}, {"u": 1, "ease": "IN"}], "moves": [{"by": {"l_leg": [0, 0.4, 0]}}, {"delay": 0.5, "by": {"r_leg": [0, 0.4, 0]}}]},
    {"moves": [{"by": {"root": [0, -0.35, 0]}}]},
    {"shape": [{"u": 0.25, "v": 1, "ease": "OUT"}, {"u": 0.5, "ease": "IN"}, {"u": 0.75, "v": -1, "ease": "OUT"}, {"u": 1, "ease": "IN"}], "rate": 2, "moves": [{"delay": -0.25, "by": {"root": [0, -0.05, 0]}}]}]}]}`
  walk, wok := animation_parse(transmute([]u8)string(WALK))
  if !testing.expect(t, wok) do return
  defer animation_destroy(walk)
  clips := clips_build(walk, m)
  defer clips_destroy(&clips)
  // on a pose of the legs reaching alone
  for &p in clips.pose do p = 0
  clips.pose[value_of(m, "l_leg.weight")], clips.pose[value_of(m, "r_leg.weight")] = 1, 1
  values := make([]f32, model_channels(m))
  defer delete(values)
  // the sole, which the leg reaches with (ik_point)
  foot := 0
  rest := rig.iks[foot].rest
  at :: proc(c: ^Clips, rig: ^Rig, values: []f32, foot: int, t: f32) -> [3]f32 {
    clip_sample(c, 0, t, values)
    rig_solve(rig, values)
    return ik_point(rig, rig.iks[foot])
  }
  a0, a1, a2 := at(&clips, rig, values, foot, 0.1), at(&clips, rig, values, foot, 0.3), at(&clips, rig, values, foot, 0.5)
  for p in ([][3]f32{a0, a1, a2}) do testing.expectf(t, abs(p.y - rest.y) < 0.02 && abs(p.x - rest.x) < 0.02, "the stance foot stays on the ground: %v, rest %v", p, rest)
  testing.expectf(t, abs((a0.z - a1.z) - (a1.z - a2.z)) < 0.02 && abs(a0.z - a2.z - 1.0 / 0.6 * 0.4) < 0.03, "and slides straight back at a steady speed: %v %v %v", a0.z, a1.z, a2.z)
  swing := at(&clips, rig, values, foot, 0.8)
  testing.expectf(t, swing.y > rest.y + 0.3, "the swinging foot lifts: %v", swing.y)
  root := root_channel(m) + 1
  clip_sample(&clips, 0, 0, values)
  down := values[root]
  clip_sample(&clips, 0, 0.25, values)
  testing.expectf(t, abs(down + 0.4) < 1e-4 && abs(values[root] + 0.3) < 1e-4, "the root crouches, dipping at touch-down: %v, %v", down, values[root])
}

// A wave down the dragon's spine: a sine on every joint of the chain about its axis, head first,
// each move a tenth of a cycle behind the one before, so the wave travels tailward.
@(test)
test_motion_wave :: proc(t: ^testing.T) {
  text := read(t, "dragon.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  testing.expect(t, ok)
  defer model_destroy(m)
  defer animation_destroy(a)
  slither: Animation
  clip := Clip{name = "slither", duration = 2}
  wave := Motion{rate = 1}
  append(&wave.shape, ..SINE)
  // a move per joint turning about z (the dragon's spine runs along its joints' y: z turns it
  // side to side), from segment_1 down to the tail, head first
  up := make([dynamic]int, context.temp_allocator)
  for i := model_instance(m, "tail"); i >= 0; i = model_instance(m, m.assembly[i].parent) {
    append(&up, i)
    if m.assembly[i].name == "segment_1" do break
  }
  #reverse for i in up {
    for j in instance_joints(m, i) {
      if j.kind != .BALL do continue
      by := make(map[string]Value, context.temp_allocator)
      by[fmt.tprint(m.assembly[i].name, ".", j.name, sep = "")] = [3]f32{0, 0, 0.2}
      append(&wave.moves, Move{delay = 0.1 * f32(len(wave.moves)), by = by})
    }
  }
  append(&clip.motions, wave)
  append(&slither.clips, clip)
  defer {
    delete(slither.clips[0].motions[0].shape)
    delete(slither.clips[0].motions[0].moves)
    delete(slither.clips[0].motions)
    delete(slither.clips)
  }
  clips := clips_build(&slither, m)
  defer clips_destroy(&clips)
  data := &clips.clips[0].motions[0]
  if !testing.expectf(t, len(data.moves) == 11, "11 spine joints from segment_1 to the tail: %d", len(data.moves)) {
    for target in data.targets do log.errorf("  %s", value_name(m, target.index))
    return
  }
  // each move's z, the third of its ball's values
  chain := make([]int, len(data.moves))
  defer delete(chain)
  for mv, k in data.moves do chain[k] = data.targets[mv.first + 2].index
  testing.expect(t, value_name(m, chain[0]) == "segment_1.spine[2]" && value_name(m, chain[10]) == "tail.spine2[2]")
  values := make([]f32, model_channels(m))
  defer delete(values)
  // a quarter cycle in, the head is at its crest; five joints down, half a cycle behind, at its
  // trough; the tail, a whole cycle behind, at its crest again
  clip_sample(&clips, 0, 0.5, values)
  turn :: proc(c: ^Clips, values: []f32, ch: int) -> f32 {return values[ch] - c.pose[ch]}
  testing.expectf(t, abs(turn(&clips, values, chain[0]) - 0.2) < 1e-4, "head %v", turn(&clips, values, chain[0]))
  testing.expectf(t, abs(turn(&clips, values, chain[5]) + 0.2) < 1e-4, "halfway %v", turn(&clips, values, chain[5]))
  testing.expectf(t, abs(turn(&clips, values, chain[10]) - 0.2) < 1e-4, "tail %v", turn(&clips, values, chain[10]))
}

// An aiming IK turns the mech's head (its neck, a BALL) to look at its target: at rest it looks
// ahead, its target a point ahead of it; moved off to its left and up, the head faces there.
@(test)
test_ik_aim :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  testing.expect(t, ok)
  defer model_destroy(m)
  defer animation_destroy(a)
  w: world.World
  world.init(&w, 4096)
  defer world.shutdown(&w)
  lib: Library
  rig, _ := rig_create(&lib, &w, nil, m, w.root)
  defer rig_destroy(rig, &w)
  c, found := model_channel(m, "head_aim")
  if !testing.expect(t, found, "the mech has a head_aim IK") do return
  ik: RigIk
  for x in rig.iks do if x.channel == c.first do ik = x
  testing.expect(t, ik.aim && ik.count > 0, "head_aim aims with the neck")
  values := make([]f32, model_channels(m))
  defer delete(values)
  head := place_of(m, "head")
  look :: proc(rig: ^Rig, ik: RigIk, head: int) -> [3]f32 {
    return linalg.mul(rig_frame(rig, head).rotation, ik.look)
  }
  rig_solve(rig, values)
  testing.expectf(t, look(rig, ik, head).z > 0.99, "at rest it looks ahead: %v", look(rig, ik, head))
  ch := c.first
  values[ch], values[ch + 1], values[ch + IK_WEIGHT] = 3, 1, 1
  rig_solve(rig, values)
  want := linalg.normalize(ik.rest + {3, 1, 0} - rig_frame(rig, head).position)
  got := look(rig, ik, head)
  testing.expectf(t, linalg.dot(got, want) > 0.98, "it looks at its target: %v, want %v", got, want)
}

// A walk as motions in a file: it parses (shapes as points, moves' amounts by channel name), writes back
// out and parses again the same, and samples as motions do.
@(test)
test_motion_file :: proc(t: ^testing.T) {
  TEXT :: `{"clips": [{"name": "walk", "duration": 1, "motions": [
    {"shape": [{"v": 0.5}, {"u": 0.6, "v": -0.5}, {"u": 1, "v": 0.5}], "moves": [{"by": {"l_leg": [0, 0, 1]}}, {"delay": 0.5, "by": {"r_leg": [0, 0, 1]}}]},
    {"moves": [{"by": {"l_leg.weight": 1, "r_leg.weight": 1, "root": [0, -0.35, 0]}}]},
    {"shape": [{"v": 1, "ease": "IN"}, {"u": 0.5, "ease": "OUT"}], "rate": 2, "moves": [{"by": {"root": [0, -0.05, 0]}}]},
    {"shape": [{"v": 0}, {"u": 0.25, "v": 1, "ease": "IN"}, {"u": 1, "v": 0}], "moves": [{"by": {"root": [0, 0, 1]}}]}]}]}`
  a, ok := animation_parse(transmute([]u8)string(TEXT))
  if !testing.expect(t, ok) do return
  defer animation_destroy(a)
  out := animation_format(a)
  defer delete(out)
  b, ok2 := animation_parse(transmute([]u8)out)
  if !testing.expectf(t, ok2, "it parses as written: %s", out) do return
  defer animation_destroy(b)
  again := animation_format(b)
  defer delete(again)
  testing.expectf(t, out == again, "it writes the same twice:\n%s\n%s", out, again)
  mo := a.clips[0].motions
  testing.expect(t, len(mo) == 4 && len(mo[0].shape) == 3 && mo[0].shape[1] == {0.6, -0.5, .LINEAR} && len(mo[1].shape) == 0 && mo[2].rate == 2 && mo[3].shape[1].ease == .IN && len(mo[0].moves) == 2 && mo[0].moves[1].delay == 0.5)
  text := read(t, "strider.json")
  defer delete(text)
  m, sa, _ := character_parse(text)
  defer model_destroy(m)
  defer animation_destroy(sa)
  clips := clips_build(a, m)
  defer clips_destroy(&clips)
  values := make([]f32, model_channels(m))
  defer delete(values)
  for &p in clips.pose do p = 0
  clip_sample(&clips, 0, 0, values)
  testing.expectf(t, abs(values[root_channel(m) + 1] + 0.4) < 1e-4 && values[value_of(m, "l_leg.weight")] == 1, "the root crouched and dipped, the legs reaching: %v", values[root_channel(m) + 1])
}

// A turntable is a spin of its own in a part's stack: a joint is one bone and one channel. A
// hinge's base plate next to a spin is round (the turntable it turns on), else square.
@(test)
test_turntable_stack :: proc(t: ^testing.T) {
  m := Model{}
  part := Part{name = "thigh"}
  append(&part.joints, Joint{name = "hip_top", kind = .SPIN, min = {0, -1, 0}, max = {0, 1, 0}}, Joint{name = "hip", kind = .PIN, size = 0.2, reach = 1, min = {-0.3, 0, 0}, max = {0.3, 0, 0}})
  square := Part{name = "shin"}
  append(&square.joints, Joint{name = "knee", kind = .PIN, size = 0.2, reach = 1})
  append(&m.parts, part, square)
  append(&m.assembly, Instance{name = "l_thigh", part = "thigh"}, Instance{name = "l_shin", part = "shin", parent = "l_thigh"})
  defer {delete(part.joints); delete(square.joints); delete(m.parts); delete(m.assembly)}
  first := joint_channel(&m, 0)
  testing.expect(t, model_channels(&m) == first + 3)
  for w, k in ([]string{"l_thigh.hip_top", "l_thigh.hip", "l_shin.knee"}) {
    c, ok := model_channel(&m, w)
    testing.expectf(t, ok && c.kind == .HINGE && c.first == first + k, "%s: %v", w, c)
  }
  w: world.World
  world.init(&w, 256)
  defer world.shutdown(&w)
  lib: Library
  rig, _ := rig_create(&lib, &w, nil, &m, w.root)
  defer rig_destroy(rig, &w)
  // the hinge's top plate, on the spin, is a disc; alone, the same hinge's are square
  hardware :: proc(joints: []Joint) -> (discs, boxes: int) {
    m := Model{}
    p := Part{name = "p"}
    append(&p.joints, ..joints)
    append(&m.parts, p)
    append(&m.assembly, Instance{name = "i", part = "p"})
    defer {delete(p.joints); delete(m.parts); delete(m.assembly)}
    w: world.World
    world.init(&w, 256)
    defer world.shutdown(&w)
    lib: Library
    rig, _ := rig_create(&lib, &w, nil, &m, w.root)
    defer rig_destroy(rig, &w)
    for x in rig.pieces do if x.primitive == .CYLINDER do discs += 1
    else if x.primitive == .BOX do boxes += 1
    return
  }
  hinge := part.joints[1]
  d1, b1 := hardware(part.joints[:])
  d0, b0 := hardware({hinge})
  testing.expectf(t, d1 == d0 + 1 && b1 == b0 - 1, "a round plate on the spin: %d discs %d boxes, alone %d %d", d1, b1, d0, b0)
  // the spin turns the hinge on its socket: the shin swings round y
  values := make([]f32, model_channels(&m))
  defer delete(values)
  values[first + 1] = 0.3
  rig_solve(rig, values)
  bent := rig_frame(rig, 1).position
  values[first] = math.PI / 2
  rig_solve(rig, values)
  turned := rig_frame(rig, 1).position
  testing.expectf(t, abs(turned.y - bent.y) < 1e-4 && linalg.length(turned.xz - bent.xz) > 1e-3, "the turntable swings the bent hinge round: %v %v", bent, turned)
}

// A linear actuator slides its part out along its socket's normal, a model unit a unit, held to its
// stroke; on the reflected side of a mirrored slot it slides the same way out, so twins take the same values.
@(test)
test_linear :: proc(t: ^testing.T) {
  m := Model{}
  body := Part{name = "body"}
  append(&body.slots, Slot{name = "ram", position = {1, 0, 0}, normal = {1, 0, 0}, forward = {0, 0, 1}, mirror = .X})
  ram := Part{name = "ram"}
  append(&ram.joints, Joint{name = "piston", kind = .LINEAR, size = 0.2, max = {0, 0.5, 0}})
  append(&m.parts, body, ram)
  append(&m.assembly, Instance{name = "body", part = "body"}, Instance{name = "ram", part = "ram", parent = "body", parent_slot = "ram"})
  defer {delete(body.slots); delete(ram.joints); delete(m.parts); delete(m.assembly)}
  c, ok := model_channel(&m, "l_ram.piston")
  testing.expectf(t, ok && c.kind == .SLIDE, "a slide: %v", c)
  twin, flip := channel_twin(&m, c.first)
  r, _ := model_channel(&m, "r_ram.piston")
  testing.expect(t, twin == r.first && flip == 1)
  w: world.World
  world.init(&w, 256)
  defer world.shutdown(&w)
  lib: Library
  rig, _ := rig_create(&lib, &w, nil, &m, w.root)
  defer rig_destroy(rig, &w)
  values := make([]f32, model_channels(&m))
  defer delete(values)
  rig_solve(rig, values)
  l0, r0 := rig_frame(rig, 1).position, rig_frame(rig, 2).position
  values[c.first], values[r.first] = 0.3, 0.3
  rig_solve(rig, values)
  l1, r1 := rig_frame(rig, 1).position, rig_frame(rig, 2).position
  testing.expectf(t, linalg.length(l1 - l0 - {0.3, 0, 0}) < 1e-4 && linalg.length(r1 - r0 - {-0.3, 0, 0}) < 1e-4, "both slide 0.3 out: %v %v", l1 - l0, r1 - r0)
  values[c.first] = 2
  rig_solve(rig, values)
  testing.expectf(t, abs(rig_frame(rig, 1).position.x - l0.x - 0.5) < 1e-4, "held to its stroke: %v", rig_frame(rig, 1).position.x - l0.x)
}

// An IK chain starts below the nearest branch above its tip: every shipped IK's root.
@(test)
test_ik_root :: proc(t: ^testing.T) {
  Want :: struct {
    file, tip, root: string,
  }
  for w in ([]Want{
    {"mech.json", "l_foot", "l_thigh"},
    {"mech.json", "r_foot", "r_thigh"},
    {"mech.json", "l_palm", "l_arm"},
    {"mech.json", "r_palm", "r_arm"},
    {"mech.json", "head", "head"},
    {"strider.json", "l_foot", "l_thigh"},
    {"strider.json", "r_foot", "r_thigh"},
    {"strider.json", "l_cannon", "l_arm"},
    {"strider.json", "r_cannon", "r_arm"},
    {"strider.json", "sensor", "sensor"},
  }) {
    text := read(t, w.file)
    defer delete(text)
    m, a, ok := character_parse(text)
    if !testing.expect(t, ok) do continue
    defer model_destroy(m)
    defer animation_destroy(a)
    places := model_places(m)
    root := ik_root(places, model_place(m, places, w.tip))
    testing.expectf(t, root >= 0 && place_name(m, places[root]) == w.root, "%s %s: reaches from %v, want %s", w.file, w.tip, place_name(m, places[root]) if root >= 0 else "?", w.root)
  }
}

// The worked-out pole keeps a leg bending the way it is built wherever its foot goes: sweeping
// each leg's target ahead, behind, aside and up, the middle joint stays on its bend side, and on a
// two-segment leg (the mech's) never jumps from one step to the next. A longer chain (the
// strider's, its hock bending between knee and foot) is only held to its bend side.
@(test)
test_ik_pole_sweep :: proc(t: ^testing.T) {
  for name in ([]string{"mech.json", "strider.json"}) {
    text := read(t, name)
    defer delete(text)
    m, a, ok := character_parse(text)
    if !testing.expect(t, ok) do continue
    defer model_destroy(m)
    defer animation_destroy(a)
    w: world.World
    world.init(&w, 4096)
    defer world.shutdown(&w)
    lib: Library
    rig, _ := rig_create(&lib, &w, nil, m, w.root)
    defer rig_destroy(rig, &w)
    pose := model_pose(m)
    defer delete(pose)
    values := make([]f32, len(pose))
    defer delete(values)
    for ik in rig.iks {
      if ik.aim || ik.mid == 0 do continue
      c, _, _ := value_channel(m, ik.channel)
      leg := c.name
      if pose[ik.channel + IK_WEIGHT] < 1 do continue // only the IKs reaching at rest (the legs)
      SPAN :: 0.45
      for side in ([]f32{-0.25, 0, 0.25}) do for up in ([]f32{0, 0.25}) {
        last: [3]f32
        for k in 0 ..= 24 {
          copy(values, pose)
          values[ik.channel] = side * ik.length
          values[ik.channel + 1] = up * ik.length
          values[ik.channel + 2] = (f32(k) / 12 - 1) * SPAN * ik.length
          rig_solve(rig, values)
          target := ik.rest + {values[ik.channel], values[ik.channel + 1], values[ik.channel + 2]}
          chain := rig.chains[ik.first:][:ik.count]
          mid := rig.positions[chain[ik.mid]]
          above := rig.positions[chain[ik.mid - 1]]
          along := linalg.normalize(target - above)
          off := (mid - above) - linalg.dot(mid - above, along) * along
          testing.expectf(t, linalg.dot(off, ik.bend) > -1e-3 * ik.length, "%s %s at %v: bends the wrong way (%v)", name, leg, target, off)
          if k > 0 && int(ik.mid) == ik.turning - 1 do testing.expectf(t, linalg.length(mid - last) < 0.15 * ik.length, "%s %s at %v: its middle joint jumps %v", name, leg, target, linalg.length(mid - last))
          last = mid
        }
      }
    }
  }
}

// Twins: a joint's channel's twin is the same joint's on its instance's other side, an IK
// target's the other side's target with x mirrored (and its swivel); the root and a joint on the middle of the body have none. An OPPOSITE move runs its twins half a
// cycle later.
@(test)
test_twins :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  defer animation_destroy(a)
  Want :: struct {
    name, twin: string,
    flip:       f32,
  }
  for w in ([]Want{
    {"l_arm.shoulder_top", "r_arm.shoulder_top", 1},
    {"r_forearm.elbow", "l_forearm.elbow", 1},
    {"l_leg[0]", "r_leg[0]", -1},
    {"l_leg[2]", "r_leg[2]", 1},
    {"l_leg.swivel", "r_leg.swivel", -1},
    {"l_leg.weight", "r_leg.weight", 1},
    {"l_thumb_1.knuckle", "r_thumb_1.knuckle", 1},
    {"root[1]", "", 1},
    {"pelvis.spin", "", 1},
    {"torso.waist[1]", "", 1},
  }) {
    // `name[k]`: value k of a 3-value channel
    name, axis := w.name, 0
    if len(name) > 3 && name[len(name) - 1] == ']' do name, axis = name[:len(name) - 3], int(name[len(name) - 2] - '0')
    twin, flip := channel_twin(m, value_of(m, name, axis))
    got := value_name(m, twin) if twin >= 0 else ""
    testing.expectf(t, got == w.twin && (twin < 0 || flip == w.flip), "%s: twin %q times %v, want %q times %v", w.name, got, flip, w.twin, w.flip)
  }
  targets := make([dynamic]Target)
  defer delete(targets)
  moves := make([dynamic]MoveData)
  defer delete(moves)
  by := make(map[string]Value)
  defer delete(by)
  by["l_leg"] = [3]f32{0.1, 0.2, 0.3}
  by["root"] = [3]f32{0, -0.1, 0}
  cs := channels_make(m)
  move_resolve(&cs, Move{delay = 0.25, twin = .OPPOSITE, by = by}, &targets, &moves)
  testing.expect(t, len(moves) == 2 && moves[0].count == 6 && moves[1].count == 3 && moves[1].delay == 0.75)
  testing.expect(t, targets[moves[1].first].index == value_of(m, "r_leg") && targets[moves[1].first].value == -0.1)
}

// An arc: a path of points a move puts three channels on, by its shape. It passes through point k
// at k / (n - 1), runs smooth between, and on along its ends' tangents past them (a shape settling
// past 1 overshoots along the path). A WITH twin follows it mirrored, and it round-trips the file.
@(test)
test_arc :: proc(t: ^testing.T) {
  pts := [][3]f32{{0, 0, 0}, {0, 1, 1}, {1, 2, 1}, {2, 2, 0}}
  for p, k in pts do testing.expectf(t, linalg.length(arc_at(pts, nil, f32(k) / 3) - p) < 1e-5, "point %d at %d/3: %v", k, k, arc_at(pts, nil, f32(k) / 3))
  testing.expectf(t, linalg.length(arc_at(pts, nil, 1.1) - ({2, 2, 0} + 0.3 * ({2, 2, 0} - {1, 2, 1}))) < 1e-4, "past its end, on along it: %v", arc_at(pts, nil, 1.1))
  mid := arc_at(pts, nil, 0.5)
  testing.expectf(t, linalg.length(mid - ({0, 1, 1} + {1, 2, 1}) / 2) > 0.01, "between points it curves, not a straight line: %v", mid)
  // between two corners it runs straight, at a steady speed (a foot on the ground)
  sharp := []bool{false, true, true, false}
  for s in ([]f32{0.4, 0.5, 0.6}) {
    want := linalg.lerp([3]f32{0, 1, 1}, [3]f32{1, 2, 1}, s * 3 - 1)
    testing.expectf(t, linalg.length(arc_at(pts, sharp, s) - want) < 1e-5, "between corners at %v, straight and steady: %v, want %v", s, arc_at(pts, sharp, s), want)
  }
  // a closed arc runs on from its last point back to its first, point k at k / n, smooth through
  // its seam unless it is a corner, and round again past its end
  loop := [][3]f32{{0, 0, 0}, {1, 0, 0}, {1, 1, 0}, {0, 1, 0}}
  for p, k in loop do testing.expectf(t, linalg.length(arc_at(loop, nil, f32(k) / 4, true) - p) < 1e-5, "closed: point %d at %d/4", k, k)
  testing.expectf(t, linalg.length(arc_at(loop, nil, 1, true) - loop[0]) < 1e-5, "closed: back at its first point at 1")
  testing.expectf(t, linalg.length(arc_at(loop, nil, 1.25, true) - loop[1]) < 1e-5, "closed: round again past 1")
  e: f32 = 1e-3
  into, leave := (loop[0] - arc_at(loop, nil, 1 - e, true)) / e, (arc_at(loop, nil, e, true) - loop[0]) / e
  testing.expectf(t, linalg.length(into - leave) < 0.05 * linalg.length(leave), "smooth through the seam: in %v, out %v", into, leave)
  corner := []bool{true, false, false, false}
  into, leave = (loop[0] - arc_at(loop, corner, 1 - e, true)) / e, (arc_at(loop, corner, e, true) - loop[0]) / e
  testing.expectf(t, linalg.dot(linalg.normalize(into), linalg.normalize(leave)) < 0.1, "a corner at the seam turns hard: in %v, out %v", into, leave)

  text := read(t, "mech.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  defer animation_destroy(a)
  // an open arc, named in the animation's list; a move names it under a stem
  ARC :: `{"arcs": [{"name": "reach", "points": [[0, 0, 0], [0.5, 1, 1], [1, 2, 0]]}], "clips": [{"name": "reach", "duration": 1, "motions": [
    {"shape": [{}, {"u": 1, "v": 1}], "moves": [{"twin": "WITH", "by": {"l_leg": "reach"}}]}]},
    {"name": "out_and_back", "duration": 1, "motions": [
    {"shape": [{}, {"u": 0.5, "v": 1}, {"u": 1}], "moves": [{"by": {"l_leg": "reach"}}]}]},
    {"name": "unknown", "duration": 1, "motions": [{"moves": [{"by": {"l_leg": "nowhere"}}]}]},
    {"name": "turn", "duration": 1, "motions": [{"moves": [{"by": {"l_arm.shoulder": "reach", "root.turn": "reach"}}]}]}]}`
  arc, aok := animation_parse(transmute([]u8)string(ARC))
  if !testing.expect(t, aok) do return
  defer animation_destroy(arc)
  clips := clips_build(arc, m)
  defer clips_destroy(&clips)
  values := make([]f32, model_channels(m))
  defer delete(values)
  l := [3]int{value_of(m, "l_leg"), value_of(m, "l_leg", 1), value_of(m, "l_leg", 2)}
  r := [3]int{value_of(m, "r_leg"), value_of(m, "r_leg", 1), value_of(m, "r_leg", 2)}
  for x in ([]f32{0, 0.25, 0.5, 0.75}) {
    clip_sample(&clips, 0, x, values)
    want := arc_at([][3]f32{{0, 0, 0}, {0.5, 1, 1}, {1, 2, 0}}, nil, x)
    got := [3]f32{values[l[0]], values[l[1]], values[l[2]]} - {clips.pose[l[0]], clips.pose[l[1]], clips.pose[l[2]]}
    testing.expectf(t, linalg.length(got - want) < 1e-5, "at %v the foot's target is on its arc: %v, want %v", x, got, want)
    twin := [3]f32{values[r[0]], values[r[1]], values[r[2]]} - {clips.pose[r[0]], clips.pose[r[1]], clips.pose[r[2]]}
    testing.expectf(t, linalg.length(twin - {-want.x, want.y, want.z}) < 1e-5, "its twin on the arc mirrored: %v", twin)
  }
  // open: a shape out and back runs out along it to its last point, and back to its first
  for want, x in ([3][3]f32{{0, 0, 0}, {1, 2, 0}, {0, 0, 0}}) {
    clip_sample(&clips, 1, f32(x) / 2, values)
    got := [3]f32{values[l[0]], values[l[1]], values[l[2]]} - {clips.pose[l[0]], clips.pose[l[1]], clips.pose[l[2]]}
    testing.expectf(t, linalg.length(got - want) < 1e-5, "out and back at %v: %v, want %v", f32(x) / 2, got, want)
  }
  // an arc the animation lacks is skipped: the target stays at rest
  clip_sample(&clips, 2, 0.5, values)
  testing.expect(t, slice.equal(values, clips.pose[:]), "an unknown arc moves nothing")
  // only a position follows an arc: a ball's rotation and the root's turn don't
  clip_sample(&clips, 3, 0.5, values)
  testing.expect(t, slice.equal(values, clips.pose[:]), "no arc on turns")
  out := animation_format(arc)
  defer delete(out)
  back, bok := animation_parse(transmute([]u8)out)
  if !testing.expect(t, bok) do return
  defer animation_destroy(back)
  again := animation_format(back)
  defer delete(again)
  testing.expectf(t, out == again, "an arc round-trips: %s", out)
}

// IK reaches with its tip's end, not the joint at its base: a foot with its sole (on the ground at
// rest), holding facing as the clip angles it. (The mech's arms are FK: no hand reaches.)
@(test)
test_ik_reach_point :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  defer animation_destroy(a)
  w: world.World
  world.init(&w, 4096)
  defer world.shutdown(&w)
  lib: Library
  rig, _ := rig_create(&lib, &w, nil, m, w.root)
  defer rig_destroy(rig, &w)
  values := make([]f32, model_channels(m))
  defer delete(values)
  rig_solve(rig, values)
  for ik in rig.iks {
    c, _, _ := value_channel(m, ik.channel)
    name := c.name
    if ik.aim do continue
    tip := rig_frame(rig, ik.tip).position
    testing.expectf(t, strings.has_suffix(name, "_leg"), "only the legs reach: %s", name)
    testing.expectf(t, ik.holds && abs(ik.rest.y) < 0.01 && ik.rest.y < tip.y - 0.1, "%s reaches with its sole, on the ground, and holds: %v (ankle %v)", name, ik.rest, tip)
  }
}

// The mech's attack is FK: driven out, the right fist is ahead of its shoulder, about as high, and
// held still on the drive's stop; the head aims at the impact all the while.
@(test)
test_attack_strikes :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  defer animation_destroy(a)
  w: world.World
  world.init(&w, 4096)
  defer world.shutdown(&w)
  lib: Library
  rig, _ := rig_create(&lib, &w, nil, m, w.root)
  defer rig_destroy(rig, &w)
  clips := clips_build(a, m)
  defer clips_destroy(&clips)
  values := make([]f32, model_channels(m))
  defer delete(values)
  c := clips_find(&clips, "attack")
  eyes := value_of(m, "head_aim")
  look: RigIk
  for ik in rig.iks do if ik.channel == eyes do look = ik
  head, fist, shoulder := place_of(m, "head"), place_of(m, "r_palm"), place_of(m, "r_arm")
  held: [3]f32
  // the drive held, once its stop has stopped bouncing, until the return
  for k in 0 ..= 10 {
    x := 0.55 + 0.12 * f32(k) / 10
    clip_sample(&clips, c, x * clips.clips[c].duration, values)
    rig_solve(rig, values)
    f, s := rig_frame(rig, fist).position, rig_frame(rig, shoulder).position
    testing.expectf(t, f.z > s.z + 0.5 * linalg.length(f - s) && abs(f.y - s.y) < 0.5 * linalg.length(f - s), "at %v the fist is driven out ahead at shoulder height: fist %v, shoulder %v", x, f, s)
    if k == 0 do held = f
    testing.expectf(t, linalg.length(f - held) < 0.02 * m.scale, "at %v the fist holds on its stop: %v, then %v", x, held, f)
    h := rig_frame(rig, head)
    at := look.rest + {values[eyes], values[eyes + 1], values[eyes + 2]}
    testing.expectf(t, linalg.dot(linalg.mul(h.rotation, look.look), linalg.normalize(at - h.position)) > 0.999, "at %v the head aims at the impact", x)
  }
}

// An IK's swivel turns the way its chain bends about the line from its limb's root to the target:
// the middle joint (a knee, an elbow) goes round that line the way the swivel says, the tip stays on
// its target, and twins take mirrored swivels (channel_twin: -1) to mirrored poses.
@(test)
test_ik_swivel :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  defer animation_destroy(a)
  w: world.World
  world.init(&w, 4096)
  defer world.shutdown(&w)
  lib: Library
  rig, _ := rig_create(&lib, &w, nil, m, w.root)
  defer rig_destroy(rig, &w)
  pose := model_pose(m)
  defer delete(pose)
  values := make([]f32, len(pose))
  defer delete(values)
  // where the middle joint sits off the line from the joint above it to the target, and how far
  // the tip is from the target
  bent :: proc(rig: ^Rig, ik: RigIk, values: []f32) -> (off, along: [3]f32, miss: f32, mid: [3]f32) {
    rig_solve(rig, values)
    c := values[ik.channel:]
    target := ik.rest + {c[0], c[1], c[2]}
    chain := rig.chains[ik.first:][:ik.count]
    mid = rig.positions[chain[ik.mid]]
    above := rig.positions[chain[ik.mid - 1]]
    along = linalg.normalize(target - above)
    off = (mid - above) - linalg.dot(mid - above, along) * along
    return off, along, linalg.length(ik_point(rig, ik) - target), mid
  }
  find :: proc(rig: ^Rig, m: ^Model, name: string) -> (RigIk, bool) {
    ch, _ := model_channel(m, name)
    for ik in rig.iks do if ik.channel == ch.first do return ik, true
    return {}, false
  }
  Case :: struct {
    name:   string,
    target: [3]f32, // an offset, in parts of the chain's length
  }
  for c in ([]Case{{"l_leg", {0, 0.1, 0.15}}, {"r_leg", {-0.05, 0.2, 0.25}}}) {
    ik, found := find(rig, m, c.name)
    if !testing.expectf(t, found && ik.mid > 0, "%s bends", c.name) do continue
    copy(values, pose)
    for k in 0 ..< 3 do values[ik.channel + k] = c.target[k] * ik.length
    values[ik.channel + IK_WEIGHT] = 1
    off0, along, miss0, _ := bent(rig, ik, values)
    for s in ([]f32{-0.4, 0.4}) {
      values[ik.channel + IK_SWIVEL] = s
      off, _, miss, _ := bent(rig, ik, values)
      testing.expectf(t, miss <= max(miss0, 0.01 * ik.length), "%s swivel %v: the tip stays on its target (%v off, %v unswiveled)", c.name, s, miss, miss0)
      turned := math.atan2(linalg.dot(along, linalg.cross(off0, off)), linalg.dot(off0, off))
      testing.expectf(t, turned * s > 0 && abs(turned) > 0.5 * abs(s), "%s swivel %v: the middle joint turns %v about the limb", c.name, s, turned)
    }
    values[ik.channel + IK_SWIVEL] = 0
  }
  // twins: the left leg swiveled one way, the right the other, are each other's mirror
  l, _ := find(rig, m, "l_leg")
  r, _ := find(rig, m, "r_leg")
  copy(values, pose)
  for side in ([]RigIk{l, r}) {
    x := f32(0.1 if side.channel == l.channel else -0.1)
    values[side.channel], values[side.channel + 1], values[side.channel + 2] = x * side.length, 0.1 * side.length, 0.15 * side.length
    values[side.channel + IK_WEIGHT] = 1
  }
  twin, flip := channel_twin(m, l.channel + IK_SWIVEL)
  testing.expectf(t, twin == r.channel + IK_SWIVEL && flip == -1, "l_leg.swivel's twin is r_leg.swivel, mirrored: %v %v", twin, flip)
  values[l.channel + IK_SWIVEL], values[r.channel + IK_SWIVEL] = 0.4, -0.4
  _, _, _, lm := bent(rig, l, values)
  _, _, _, rm := bent(rig, r, values)
  testing.expectf(t, linalg.length(lm - [3]f32{-rm.x, rm.y, rm.z}) < 0.02 * l.length, "twin swivels mirror: %v %v", lm, rm)
}

// A pose is a named set of amounts a move adds by name, times a number; the move's twin applies
// to them. A pose holds amounts only (no arcs, no poses), and a channel's name wins over a pose's.
@(test)
test_poses :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  defer animation_destroy(a)
  POSES :: `{"arcs": [{"name": "reach", "points": [[0, 0, 0], [0, 1, 0]]}],
    "poses": [{"name": "fist", "by": {"r_finger_a_1.knuckle": -0.4, "r_leg": [0, 0.2, 0]}},
      {"name": "odd", "by": {"fist": 1, "l_leg": "reach", "root": [0, 0.1, 0]}},
      {"name": "root", "by": {"pelvis.spin": 1}}],
    "clips": [{"name": "one", "duration": 1, "motions": [{"moves": [{"by": {"fist": 1}}]}]},
    {"name": "both", "duration": 1, "motions": [{"moves": [{"twin": "WITH", "by": {"fist": 0.5}}]}]},
    {"name": "odd", "duration": 1, "motions": [{"moves": [{"by": {"odd": 2, "root": [0, 0.3, 0]}}]}]}]}`
  anim, aok := animation_parse(transmute([]u8)string(POSES))
  if !testing.expect(t, aok) do return
  defer animation_destroy(anim)
  clips := clips_build(anim, m)
  defer clips_destroy(&clips)
  values := make([]f32, model_channels(m))
  defer delete(values)
  near :: proc(a, b: f32) -> bool {return abs(a - b) < 1e-5}
  moved :: proc(clips: ^Clips, values: []f32, i: int) -> f32 {return values[i] - clips.pose[i]}
  rk, lk := value_of(m, "r_finger_a_1.knuckle"), value_of(m, "l_finger_a_1.knuckle")
  ry, ly := value_of(m, "r_leg", 1), value_of(m, "l_leg", 1)
  clip_sample(&clips, 0, 0.5, values)
  testing.expectf(t, near(moved(&clips, values, rk), -0.4) && near(moved(&clips, values, ry), 0.2), "a pose adds its amounts: %v %v", moved(&clips, values, rk), moved(&clips, values, ry))
  testing.expect(t, near(moved(&clips, values, lk), 0), "without a twin, one side")
  clip_sample(&clips, 1, 0.5, values)
  for i in ([]int{rk, lk}) do testing.expectf(t, near(moved(&clips, values, i), -0.2), "times its number, on both sides with WITH: %v", moved(&clips, values, i))
  for i in ([]int{ry, ly}) do testing.expectf(t, near(moved(&clips, values, i), 0.1), "an IK target too: %v", moved(&clips, values, i))
  // in a pose, a pose and an arc are skipped; its amounts are times the move's number. Written in
  // the first format (all in `by`), a move's pose and arc are read into its `poses` and `arcs`;
  // poses and channels are named apart, so a pose `root` and the channel `root` both stand: the
  // move's amount on root (0.3) and pose odd's on it (0.1, twice) add, and pose root is not added
  clip_sample(&clips, 2, 0.5, values)
  testing.expectf(t, near(moved(&clips, values, rk), 0), "no pose in a pose: %v", moved(&clips, values, rk))
  testing.expectf(t, near(moved(&clips, values, ly), 0), "no arc in a pose")
  testing.expectf(t, near(moved(&clips, values, value_of(m, "root", 1)), 0.5), "root's amount and pose odd's: %v", moved(&clips, values, value_of(m, "root", 1)))
  testing.expectf(t, near(moved(&clips, values, value_of(m, "pelvis.spin")), 0), "pose root is not added")
  odd := anim.clips[2].motions[0].moves[0]
  testing.expectf(t, odd.poses["odd"] == 2 && "odd" not_in odd.by && "root" in odd.by, "the first format's pose is read into poses: %v %v", odd.by, odd.poses)
  for x in character_check(m, anim) do testing.expectf(t, !(x.severity == .ERROR && strings.contains(x.text, "both a channel")), "no clash: %s", x.text)
  // poses round-trip
  out := animation_format(anim)
  defer delete(out)
  back, bok := animation_parse(transmute([]u8)out)
  if !testing.expect(t, bok) do return
  defer animation_destroy(back)
  again := animation_format(back)
  defer delete(again)
  testing.expectf(t, out == again, "poses round-trip: %s", out)
}

// Channels are named from several things (IK targets, the root, places and their joints), so two
// can come out with one name: an instance `root` with a joint `turn` beside the root's turn, an IK
// target named `root`. character_check reports the channel named twice; a model without that
// clash has none.
@(test)
test_channel_names_unique :: proc(t: ^testing.T) {
  CLASH :: `{"parts": [{"name": "p", "joints": [{"name": "turn", "min": [-1, 0, 0], "max": [1, 0, 0]}],
      "shapes": [{"size": [1, 1, 1]}]}],
    "assembly": [{"name": "base", "part": "p"}, {"name": "root", "part": "p", "parent": "base"}],
    "iks": [{"name": "root", "tip": "root"}]}`
  m, ok := model_parse(transmute([]u8)string(CLASH))
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  twice := map[string]bool{}
  defer delete(twice)
  for x in character_check(m, nil) do if x.severity == .ERROR && strings.has_prefix(x.text, "channel ") do twice[x.text] = true
  testing.expectf(t, twice["channel root.turn is named twice"], "an instance root's joint turn clashes with the root's turn: %v", twice)
  testing.expectf(t, twice["channel root is named twice"], "an IK target root clashes with the root: %v", twice)
  // the shipped mech has no clash
  text := read(t, "mech.json")
  defer delete(text)
  mech, a, mok := character_parse(text)
  if !testing.expect(t, mok) do return
  defer model_destroy(mech)
  defer animation_destroy(a)
  for x in character_check(mech, a) do testing.expectf(t, !strings.has_prefix(x.text, "channel "), "no channel clash in mech: %s", x.text)
}

// References: every place a name is written, what it names and where. A channel's name names its
// instance and its joint (or its IK target), each over its own span, on either side of the body;
// a move's key names a pose, its value an arc; a thing's own name is its definition. Renaming by
// them is rewriting each span, so a rename on one side reaches the other.
@(test)
test_references :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  defer animation_destroy(a)
  refs := references(m, a, context.temp_allocator)
  find :: proc(refs: []Ref, to: Path, ptr_has: string, def := false) -> (Ref, bool) {
    for r in refs do if r.to == to && r.def == def && strings.contains(r.ptr, ptr_has) do return r, true
    return {}, false
  }
  // the rest pose's l_forearm.elbow: the instance forearm at 2..9, the joint elbow at 10..15
  inst, iok := find(refs, {kind = .INSTANCE, name = "forearm"}, "/model/pose/l_forearm.elbow")
  testing.expectf(t, iok && inst.key && inst.span == {2, 9} && inst.at == Path{kind = .REST, item = "l_forearm.elbow"}, "the instance in a channel's name: %v", inst)
  joint, jok := find(refs, {kind = .JOINT, name = "forearm", item = "elbow"}, "/model/pose/l_forearm.elbow")
  testing.expectf(t, jok && joint.span == {10, 15}, "the joint in a channel's name: %v", joint)
  // an IK target's channels: l_leg.weight names leg at 2..5
  leg, lok := find(refs, {kind = .IK, name = "leg"}, "/model/pose/l_leg.weight")
  testing.expectf(t, lok && leg.span == {2, 5}, "the IK target in its channel's name: %v", leg)
  // walk's arc: the value of a move's l_leg names arc step, the key the IK target
  arcs := 0
  for r in refs do if r.to == (Path{kind = .ARC, name = "step"}) && !r.def {
    arcs += 1
    testing.expectf(t, !r.key && r.span == {0, 4} && r.at.kind == .MOVE && r.at.name == "walk" && r.at.item == "l_leg", "an arc named by a move's value: %v", r)
  }
  testing.expectf(t, arcs == 1, "step is followed once: %d", arcs)
  // a pose added by name
  fist := 0
  for r in refs do if r.to == (Path{kind = .POSE, name = "fist"}) && !r.def do fist += 1
  testing.expectf(t, fist > 0, "fist is added by some moves")
  // definitions, and what names an instance: its children, its IK targets, its channels
  _, dok := find(refs, {kind = .INSTANCE, name = "forearm"}, "/model/assembly/4/name", def = true)
  testing.expect(t, dok, "an instance's own name")
  _, pok := find(refs, {kind = .INSTANCE, name = "forearm"}, "/model/assembly/5/parent")
  testing.expect(t, pok, "its child names it as its parent")
  // a rename by the spans reaches both sides: every channel of forearm, either side, is named
  for c in model_channel_table(m) do if strings.contains(c.name, "forearm.") {
    side := c.name[:2]
    testing.expectf(t, side == "l_" || side == "r_", "forearm is placed on both sides: %s", c.name)
  }
}

// An arc's points can say where along it each is (Arc.at): a shape's value reaches point k at its
// knot, however unevenly they are placed, so adding a point between two leaves every other where it
// was along the arc (and the moves on it as timed); without them, the points are spread evenly.
// Knots that don't rise, or don't fit the points, are errors.
@(test)
test_arc_knots :: proc(t: ^testing.T) {
  near :: proc(a, b: [3]f32) -> bool {return linalg.length(a - b) < 1e-5}
  pts := [][3]f32{{0, 0, 0}, {1, 0, 0}, {1, 1, 0}}
  // evenly, with no knots: point 1 halfway
  testing.expect(t, near(arc_at(pts, nil, 0.5), pts[1]), "evenly spread without knots")
  // unevenly: point 1 at 0.2
  knots := []f32{0, 0.2, 1}
  for p, k in pts do testing.expectf(t, near(arc_at(pts, nil, knots[k], false, knots), p), "point %d at its knot %v: %v", k, knots[k], arc_at(pts, nil, knots[k], false, knots))
  // a point added between 1 and 2, at 0.6: the others stay where they were along it
  more := [][3]f32{{0, 0, 0}, {1, 0, 0}, {1.2, 0.5, 0}, {1, 1, 0}}
  more_knots := []f32{0, 0.2, 0.6, 1}
  for k in ([]int{0, 1, 3}) do testing.expectf(t, near(arc_at(more, nil, more_knots[k], false, more_knots), more[k]), "point %d where it was", k)
  testing.expect(t, near(arc_at(more, nil, 0.6, false, more_knots), more[2]), "the new point at its own knot")
  // closed: the last segment back to the first, at its knot plus one
  loop := [][3]f32{{0, 0, 0}, {1, 0, 0}, {1, 1, 0}, {0, 1, 0}}
  loop_knots := []f32{0, 0.1, 0.5, 0.6}
  for p, k in loop do testing.expectf(t, near(arc_at(loop, nil, loop_knots[k], true, loop_knots), p), "closed: point %d at its knot", k)
  testing.expect(t, near(arc_at(loop, nil, 1, true, loop_knots), loop[0]), "closed: back to the first a pass on")
  // the rules
  BAD :: `{"arcs": [{"name": "down", "points": [[0, 0, 0], [1, 0, 0], [2, 0, 0]], "at": [0, 0.7, 0.5]},
    {"name": "short", "points": [[0, 0, 0], [1, 0, 0]], "at": [0]},
    {"name": "round", "points": [[0, 0, 0], [1, 0, 0], [1, 1, 0]], "at": [0, 0.5, 1], "closed": true}]}`
  m, mok := model_parse(transmute([]u8)string(`{}`))
  if !testing.expect(t, mok) do return
  defer model_destroy(m)
  a, aok := animation_parse(transmute([]u8)string(BAD))
  if !testing.expect(t, aok) do return
  defer animation_destroy(a)
  bad := map[string]bool{}
  defer delete(bad)
  for x in character_check(m, a) do if x.at.kind == .ARC do bad[x.at.name] = true
  testing.expectf(t, bad["down"] && bad["short"] && bad["round"], "knots falling, too few, a closed arc with no way back: %v", bad)
}

// Issues say where they are: the thing to go to, to fix them.
@(test)
test_issue_paths :: proc(t: ^testing.T) {
  BAD :: `{"parts": [{"name": "p", "slots": [{"name": "s"}], "joints": [{"name": "j", "min": [1, 0, 0], "max": [-1, 0, 0]}],
      "shapes": [{"size": [1, 1, 1], "material": "nope"}]}],
    "assembly": [{"name": "a", "part": "p"}, {"name": "b", "part": "p", "parent": "a", "parent_slot": "gone"}]}`
  m, ok := model_parse(transmute([]u8)string(BAD))
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  at := map[PathKind]Path{}
  defer delete(at)
  for x in character_check(m, nil) do at[x.at.kind] = x.at
  testing.expectf(t, at[.INSTANCE] == Path{kind = .INSTANCE, name = "b"}, "an unknown slot: at the instance hanging from it: %v", at)
  testing.expectf(t, at[.JOINT] == Path{kind = .JOINT, name = "p", item = "j"}, "stops the wrong way round: at the joint: %v", at)
  testing.expectf(t, at[.SHAPE] == Path{kind = .SHAPE, name = "p", index = 0}, "an unknown material: at the shape: %v", at)
}

// The schema an editor reads instead of keeping its own copy: valid JSON, every enum's names in
// order, the side prefixes (NONE's empty one too), the channel names and the budgets.
@(test)
test_schema :: proc(t: ^testing.T) {
  text := schema_format()
  defer delete(text)
  s: Schema
  err := json.unmarshal(transmute([]u8)text, &s, allocator = context.temp_allocator)
  if !testing.expectf(t, err == nil, "the schema parses: %v\n%s", err, text) do return
  kinds := s.enums["JointKind"]
  testing.expectf(t, len(kinds) == len(JointKind) && kinds[0] == "PIN" && kinds[3] == "BALL", "JointKind in order: %v", kinds)
  testing.expectf(t, len(s.enums["Primitive"]) == len(Primitive) && s.enums["Ease"][4] == "STEP", "Primitive and Ease: %v", s.enums)
  _, none := s.sides["NONE"]
  testing.expectf(t, none && s.sides["NONE"] == "" && s.sides["L"] == "l_" && s.sides["R"] == "r_", "sides: %v", s.sides)
  testing.expectf(t, s.channels["swivel"] == ".swivel" && s.channels["root_turn"] == "root.turn", "channels: %v", s.channels)
  testing.expectf(t, s.sizes["BALL"] == 3 && s.budgets["shape"] == SHAPE_BUDGET, "sizes and budgets: %v %v", s.sizes, s.budgets)
}

// A move's spread runs its channels one after another in the model's order (down a chain): the
// k-th of n `spread * k / (n - 1)` cycles late, its twins at the same delays; a move without one
// moves all its channels at once; and a spread writes back out as it was read.
@(test)
test_motion_spread :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, shipped, ok := character_parse(text)
  if !testing.expect(t, ok) do return
  defer model_destroy(m)
  defer animation_destroy(shipped)
  ANIM :: `{"clips": [{"name": "arm", "duration": 1, "motions": [{"shape": [{"u": 0.25}, {"u": 0.5, "v": 1}, {"u": 0.75}], "moves": [{"spread": 0.2, "twin": "WITH", "by": {"l_palm.wrist": 3, "l_arm.shoulder_top": 1, "l_forearm.elbow": 2}}, {"by": {"torso.waist": [0, 1, 0]}}]}]}]}`
  a, aok := animation_parse(transmute([]u8)string(ANIM))
  if !testing.expect(t, aok) do return
  defer animation_destroy(a)
  clips := clips_build(a, m)
  defer clips_destroy(&clips)
  values := make([]f32, model_channels(m))
  defer delete(values)
  shape := clips.clips[0].motions[0].shape[:]
  Link :: struct {
    name:   string,
    amount: f32,
    late:   f32,
  }
  links := []Link{{"l_arm.shoulder_top", 1, 0}, {"l_forearm.elbow", 2, 0.1}, {"l_palm.wrist", 3, 0.2}}
  for x in ([]f32{0.3, 0.45, 0.55, 0.62, 0.7}) {
    clip_sample(&clips, 0, x, values)
    for l in links {
      c := value_of(m, l.name)
      want := l.amount * shape_value(shape, x - l.late)
      testing.expectf(t, abs(values[c] - clips.pose[c] - want) < 1e-5, "at %v %s %v, want %v", x, l.name, values[c] - clips.pose[c], want)
      twin, flip := channel_twin(m, c)
      testing.expectf(t, twin >= 0 && abs(values[twin] - clips.pose[twin] - want * flip) < 1e-5, "at %v %s's twin %v, want %v", x, l.name, values[twin] - clips.pose[twin], want * flip)
    }
    waist := value_of(m, "torso.waist", 1)
    testing.expectf(t, abs(values[waist] - clips.pose[waist] - shape_value(shape, x)) < 1e-5, "at %v the waist moves without a spread", x)
  }
  out := animation_format(a, context.temp_allocator)
  again, rok := animation_parse(transmute([]u8)out)
  if !testing.expect(t, rok) do return
  defer animation_destroy(again)
  testing.expectf(t, again.clips[0].motions[0].moves[0].spread == 0.2 && again.clips[0].motions[0].moves[1].spread == 0, "spread round-trips: %s", out)
}

// The shipped characters keep every rule character_check knows: no ERROR. BUDGET issues (data
// fighting the machine) are listed in the log, so their count stays visible.
@(test)
test_assets_check :: proc(t: ^testing.T) {
  for name in ([]string{"mech", "dragon", "strider", "spider", "tiger", "eagle", "shark"}) {
    text := read(t, fmt.tprint(name, ".json", sep = ""))
    defer delete(text)
    m, a, ok := character_parse(text)
    if !testing.expect(t, ok) do continue
    defer model_destroy(m)
    defer animation_destroy(a)
    budget := 0
    for x in character_check(m, a) {
      if x.severity == .ERROR do testing.expectf(t, false, "%s: %s", name, x.text)
      else {
        budget += 1
        log.infof("%s: %s", name, x.text)
      }
    }
    log.infof("%s: %d budget issues", name, budget)
  }
}

// place_of is the place named `name` (model_place over model_places), -1 for none.
@(private = "file")
place_of :: proc(m: ^Model, name: string) -> int {
  return model_place(m, model_places(m), name)
}
