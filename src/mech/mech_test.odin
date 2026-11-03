#+build !js
package mech

import "core:fmt"
import "core:log"
import "core:math"
import "core:math/linalg"
import "core:os"
import "core:testing"
import "../mjolnir/world"

@(private = "file")
ASSETS :: #directory + "/../../assets/characters/"

@(private = "file")
read :: proc(t: ^testing.T, name: string) -> []u8 {
  data, err := os.read_entire_file(fmt.tprint(ASSETS, name, sep = ""), context.allocator)
  testing.expectf(t, err == nil, "read %s: %v", name, err)
  return data
}

// Parsing a character file and formatting it again gives the same bytes, so saves only show
// real changes in a diff.
@(test)
test_files_round_trip :: proc(t: ^testing.T) {
  for name in ([]string{"mech", "dragon", "strider"}) {
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
  for name in ([]string{"mech", "dragon", "strider"}) {
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
      for v, i in start do testing.expectf(t, abs(v - end[i]) < 1e-4, "%s %s loops: %s %v, then %v", name, clip.name, channel_name(m, i), v, end[i])
      if clip.name != "walk" && clip.name != "run" do continue
      // the ground: the feet at rest, the legs reaching
      copy(end, clips.pose[:])
      for &v, i in end do if i >= root_channel(m) do v = 0
      for ch in ([]string{"l_leg_x", "l_leg_y", "l_leg_z", "r_leg_x", "r_leg_y", "r_leg_z"}) do end[model_channel(m, ch)] = 0
      end[model_channel(m, "l_leg_weight")], end[model_channel(m, "r_leg_weight")] = 1, 1
      rig_solve(rig, end)
      feet := [2]int{model_instance(m, "l_foot"), model_instance(m, "r_foot")}
      rest := [2][3]f32{rig_frame(rig, feet[0]).position, rig_frame(rig, feet[1]).position}
      for k in 0 ..= 60 {
        clip_sample(&clips, c, clip.duration * f32(k) / 60, end)
        rig_solve(rig, end)
        for f, n in feet {
          p := rig_frame(rig, f).position
          testing.expectf(t, p.y > rest[n].y - 0.01 && abs(p.x - rest[n].x) < 0.01, "%s %s: %s at %v, rest %v", name, clip.name, m.assembly[f].name, p, rest[n])
        }
      }
    }
  }
}

@(test)
test_euler_round_trip :: proc(t: ^testing.T) {
  for e in ([][3]f32{{0, 0, 0}, {90, 0, -90}, {0, 180, 0}, {30, -45, 60}, {-120, 10, 5}}) {
    back := euler(euler_from(euler(e)))
    q := euler(e)
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

// A joint's hardware is its proportions times its size; size 0 builds none (no reach either).
@(test)
test_joint_scaled :: proc(t: ^testing.T) {
  j := joint_scaled(Joint{kind = .HINGE, size = 0.3, jaw = 0.5, lug_t = 0.25, shank = 0.4, flange_t = 0.5, twist = 1})
  testing.expect(t, abs(j.jaw - 0.15) < 1e-6 && abs(j.lug_t - 0.075) < 1e-6 && abs(reach(j) - 0.27) < 1e-6)
  testing.expect(t, j.twist == 1, "angles are not scaled")
  none := joint_scaled(Joint{kind = .HINGE, jaw = 0.5, shank = 0.4})
  testing.expect(t, reach(none) == 0 && none.jaw == 0)
}

// A shape spanning two slots sits between them, +y from the first to the second, its length the
// distance plus its size.y; moving a slot lengthens it.
@(test)
test_shape_span :: proc(t: ^testing.T) {
  near :: proc(a, b: [3]f32) -> bool {return abs(a.x - b.x) + abs(a.y - b.y) + abs(a.z - b.z) < 1e-4}
  p := Part{}
  append(&p.slots, Slot{name = "end", position = {0, -0.6, 0}})
  defer delete(p.slots)
  s := Shape{span = {"end", ""}, position = {0, 0.01, 0}, size = {0.3, 0.04, 0.3}}
  at, turn, size := shape_place(p, s)
  testing.expect(t, near(at, {0, -0.29, 0}) && near(size, {0.3, 0.64, 0.3}))
  testing.expect(t, near(linalg.quaternion_mul_vector3(turn, [3]f32{1, 0, 0}), {1, 0, 0}), "a span along +y keeps the part's axes")
  p.slots[0].position = {0, -1, 0}
  _, _, size = shape_place(p, s)
  testing.expect(t, abs(size.y - 1.04) < 1e-4)
  // the other way round, +y points down: turned half a turn about x
  s.span = {"", "end"}
  _, turn, _ = shape_place(p, s)
  testing.expect(t, near(linalg.quaternion_mul_vector3(turn, [3]f32{0, 1, 0}), {0, -1, 0}) && near(linalg.quaternion_mul_vector3(turn, [3]f32{1, 0, 0}), {1, 0, 0}))
  // unspanned: the part's frame
  at, turn, size = shape_place(p, Shape{position = {1, 2, 3}, size = {1, 1, 1}})
  testing.expect(t, near(at, {1, 2, 3}) && near(size, {1, 1, 1}))
}

// A joint's range holds its bone's motion; a mirror that turns an axis over turns its range over;
// an axis with equal ends is free.
@(test)
test_joint_limits :: proc(t: ^testing.T) {
  knee := Joint{kind = .HINGE, min = {-2.5, 0, 0}, max = {0.1, 0, 0}}
  b: Bone
  bone_limit(&b, knee, MIRROR_NONE)
  mo := limit(b, {-3, 1, 0})
  testing.expect(t, mo.x == -2.5 && mo.y == 1, "x held, y free")
  testing.expect(t, limit(b, {0.5, 0, 0}).x == 0.1)
  flipped: Bone
  mi := MIRROR_NONE
  mi.turn[.X] = true
  bone_limit(&flipped, knee, mi)
  testing.expect(t, flipped.lo.x == -0.1 && flipped.hi.x == 2.5, "mirrored: turned over")
}

// A turntable pivots where its discs meet; with no size it pivots on the socket, as it always did.
@(test)
test_spin_mounts :: proc(t: ^testing.T) {
  a, m := joint_mounts(joint_scaled(Joint{kind = .SPIN, size = 0.4, flange_w = 1, flange_t = 0.25}))
  testing.expect(t, abs(a.position.y - 0.05) < 1e-6 && abs(m.position.y + 0.05) < 1e-6)
  a, m = joint_mounts(joint_scaled(Joint{kind = .SPIN, flange_w = 1, flange_t = 0.25}))
  testing.expect(t, a.position == {} && m.position == {})
}

// A pose's channels: the drivers, each IK target's (a pole's three unless it aims), the root's,
// then every axis of every instance's joints. Clips key them all by name.
@(test)
test_channels :: proc(t: ^testing.T) {
  m := Model{}
  append(&m.drivers, Driver{name = "a"})
  append(&m.iks, Ik{name = "leg", aim = true}, Ik{name = "arm"})
  append(&m.parts, Part{name = "limb"})
  append(&m.parts[0].joints, Joint{name = "hip", kind = .BALL}, Joint{name = "bolt"}, Joint{name = "knee", kind = .HINGE})
  append(&m.assembly, Instance{name = "l_leg", part = "limb"}, Instance{name = "r_leg", part = "limb"})
  defer {
    delete(m.drivers)
    delete(m.iks)
    delete(m.parts[0].joints)
    delete(m.parts)
    delete(m.assembly)
  }
  // 1 driver, 4 + 7 IK, 6 root, then 2 instances of 3 + 0 + 1 axes
  testing.expect(t, model_channels(&m) == 1 + 11 + 6 + 8)
  Want :: struct {
    name:  string,
    index: int,
  }
  for w in ([]Want{{"a", 0}, {"leg_weight", 4}, {"arm_x", 5}, {"arm_pole_z", 11}, {"root_x", 12}, {"root_turn_z", 17}, {"l_leg.hip.x", 18}, {"l_leg.hip.z", 20}, {"l_leg.knee", 21}, {"r_leg.hip.y", 23}, {"r_leg.knee", 25}}) {
    testing.expectf(t, model_channel(&m, w.name) == w.index, "%s: %d, want %d", w.name, model_channel(&m, w.name), w.index)
    testing.expectf(t, channel_name(&m, w.index) == w.name, "%d: %s, want %s", w.index, channel_name(&m, w.index), w.name)
  }
  for name in ([]string{"b", "leg_pole_x", "l_leg.hip", "l_leg.knee.x", "l_leg.bolt", "l_leg", "l_leg."}) do testing.expectf(t, model_channel(&m, name) == -1, "%s is no channel", name)
}

// Layers mix clips: each plays on its own clock (offset, speed, looping), and a REPLACE layer
// moves only the channels its clip sets, an ADDITIVE one adds how its clip differs from the rest
// pose, both by weight.
@(test)
test_mix_layers :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  testing.expect(t, ok)
  defer model_destroy(m)
  defer animation_destroy(a)
  clips := clips_build(a, m)
  defer clips_destroy(&clips)
  n := model_channels(m)
  out, want, scratch := make([]f32, n), make([]f32, n), make([]f32, n)
  defer delete(out)
  defer delete(want)
  defer delete(scratch)
  walk, attack := clips_find(&clips, "walk"), clips_find(&clips, "attack")

  // one full layer is its clip, on its own clock
  mix_sample(&clips, {{clip = walk, weight = 1, speed = 2, offset = 1, loops = true}}, 1.6, out, scratch)
  clip_sample(&clips, walk, 0.2, want)
  for v, i in out do testing.expectf(t, math.abs(v - want[i]) < 1e-5, "speed/offset/loop: %s %v, want %v", channel_name(m, i), v, want[i])

  // half an attack over the walk: halfway between them where the attack sets a channel, the walk
  // where it doesn't; an additive walk doubles the walk
  mix_sample(&clips, {{clip = walk, weight = 1, speed = 1}, {clip = attack, weight = 0.5, speed = 1}}, 0.4, out, scratch)
  clip_sample(&clips, walk, 0.4, want)
  clip_sample(&clips, attack, 0.4, scratch)
  sets := make([]bool, n)
  defer delete(sets)
  for i in clips.clips[attack].channels do sets[i] = true
  for v, i in out do testing.expectf(t, math.abs(v - (sets[i] ? (want[i] + scratch[i]) / 2 : want[i])) < 1e-5, "replace: %s", channel_name(m, i))
  mix_sample(&clips, {{clip = walk, weight = 1, speed = 1}, {clip = walk, blend = .ADDITIVE, weight = 1, speed = 1}}, 0.4, out, scratch)
  for v, i in out do testing.expectf(t, math.abs(v - (2 * want[i] - clips.pose[i])) < 1e-5, "additive: %s", channel_name(m, i))

  // a motion-only clip over the walk (a sway, pelvis_turn 0.5 at a quarter cycle) replaces the
  // channel its motion sets, and leaves the rest to the walk
  SWAY :: `{"clips": [{"name": "walk"}, {"name": "attack"}, {"name": "sway", "duration": 1, "motions": [{"shape": [{"u": 0.25, "v": 1}, {"u": 0.75, "v": -1}], "moves": [{"by": {"pelvis_turn": 0.5}}]}]}]}`
  b, bok := animation_parse(transmute([]u8)string(SWAY))
  testing.expect(t, bok)
  defer animation_destroy(b)
  // the walk from the character's clips, the sway from b's: both compiled against m, so one Clips
  // holds them: append b's sway to a's
  append(&a.clips, b.clips[2])
  mixed := clips_build(a, m)
  defer clips_destroy(&mixed)
  sway := clips_find(&mixed, "sway")
  turn := model_channel(m, "pelvis_turn")
  clip_sample(&mixed, walk, 0.25, want)
  mix_sample(&mixed, {{clip = walk, weight = 1, speed = 1}, {clip = sway, weight = 1, speed = 1}}, 0.25, out, scratch)
  testing.expectf(t, math.abs(out[turn] - (clips.pose[turn] + 0.5)) < 1e-5, "motion replaces: %v", out[turn])
  for v, i in out do if i != turn do testing.expectf(t, math.abs(v - want[i]) < 1e-5, "walk under it: %s", channel_name(m, i))
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
  STRIKE :: `{"clips": [{"name": "strike", "duration": 2, "motions": [{"shape": [{"u": 0.25}, {"u": 0.5, "v": 1}, {"u": 0.75}], "moves": [{"by": {"root_y": -1}}, {"delay": 0.25, "by": {"root": [0, 0, 2]}}]}]}]}`
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
    {"moves": [{"by": {"root_y": -0.35}}]},
    {"shape": [{"u": 0.25, "v": 1, "ease": "OUT"}, {"u": 0.5, "ease": "IN"}, {"u": 0.75, "v": -1, "ease": "OUT"}, {"u": 1, "ease": "IN"}], "rate": 2, "moves": [{"delay": -0.25, "by": {"root_y": -0.05}}]}]}]}`
  walk, wok := animation_parse(transmute([]u8)string(WALK))
  if !testing.expect(t, wok) do return
  defer animation_destroy(walk)
  clips := clips_build(walk, m)
  defer clips_destroy(&clips)
  // on a pose of the legs reaching alone
  for &p in clips.pose do p = 0
  clips.pose[model_channel(m, "l_leg_weight")], clips.pose[model_channel(m, "r_leg_weight")] = 1, 1
  values := make([]f32, model_channels(m))
  defer delete(values)
  foot := model_instance(m, "l_foot")
  rest := rig.iks[0].rest
  at :: proc(c: ^Clips, rig: ^Rig, values: []f32, foot: int, t: f32) -> [3]f32 {
    clip_sample(c, 0, t, values)
    rig_solve(rig, values)
    return rig_frame(rig, foot).position
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
    ch := joint_channel(m, i)
    for j in instance_joints(m, i) {
      dofs, count := joint_dofs(j)
      for d, k in dofs[:count] {
        if d.axis != .Z do continue
        by := make(map[string]Value, context.temp_allocator)
        by[channel_name(m, ch + k)] = f32(0.2)
        append(&wave.moves, Move{delay = 0.1 * f32(len(wave.moves)), by = by})
      }
      ch += count
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
    for target in data.targets do log.errorf("  %s", channel_name(m, target.driver))
    return
  }
  chain := make([]int, len(data.targets))
  defer delete(chain)
  for target, i in data.targets do chain[i] = target.driver
  testing.expect(t, channel_name(m, chain[0]) == "segment_1.spine.z" && channel_name(m, chain[10]) == "tail.spine2.z")
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
  k := -1
  for ik, n in m.iks do if ik.name == "head_aim" do k = n
  if !testing.expect(t, k >= 0, "the mech has a head_aim IK") do return
  ik: RigIk
  for x in rig.iks do if x.channel == ik_channel(m, k) do ik = x
  testing.expect(t, ik.aim && ik.count > 0, "head_aim aims with the neck")
  values := make([]f32, model_channels(m))
  defer delete(values)
  head := model_instance(m, "head")
  look :: proc(rig: ^Rig, ik: RigIk, head: int) -> [3]f32 {
    return linalg.mul(rig_frame(rig, head).rotation, ik.look)
  }
  rig_solve(rig, values)
  testing.expectf(t, look(rig, ik, head).z > 0.99, "at rest it looks ahead: %v", look(rig, ik, head))
  c := ik_channel(m, k)
  values[c], values[c + 1], values[c + 3] = 3, 1, 1
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
    {"moves": [{"by": {"l_leg_weight": 1, "r_leg_weight": 1, "root_y": -0.35}}]},
    {"shape": [{"v": 1, "ease": "IN"}, {"u": 0.5, "ease": "OUT"}], "rate": 2, "moves": [{"by": {"root_y": -0.05}}]},
    {"shape": [{"v": 0}, {"u": 0.25, "v": 1, "ease": "IN"}, {"u": 1, "v": 0}], "moves": [{"by": {"root_z": 1}}]}]}]}`
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
  testing.expectf(t, abs(values[root_channel(m) + 1] + 0.4) < 1e-4 && values[model_channel(m, "l_leg_weight")] == 1, "the root crouched and dipped, the legs reaching: %v", values[root_channel(m) + 1])
}
