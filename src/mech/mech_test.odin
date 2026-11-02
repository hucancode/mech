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

// The mech's clips sample as they did when they were code (src/mech_clips.odin, checked against
// it every 10 ms at export); these spot values pin that down.
@(test)
test_mech_clips_sample :: proc(t: ^testing.T) {
  text := read(t, "mech.json")
  defer delete(text)
  m, a, _ := character_parse(text)
  defer model_destroy(m)
  defer animation_destroy(a)
  clips := clips_build(a, m)
  defer clips_destroy(&clips)
  values := make([]f32, model_channels(m))
  defer delete(values)
  Spot :: struct {
    clip, driver: string,
    time, value:   f32
  }
  spots := []Spot {
    {"idle", "l_curl", 1, 0.35},
    {"idle", "r_forearm.elbow", 0.5, 0.2618},
    {"walk", "l_thigh.disc", 0.25, 0.384},
    {"walk", "r_thigh.disc", 0.75, 0.384},
    {"attack", "r_arm.disc", 0.4, 1.1145},
    {"attack", "pelvis_turn", 0.9, 0},
  }
  for s in spots {
    clip_sample(&clips, clips_find(&clips, s.clip), s.time, values)
    ch := model_channel(m, s.driver)
    if !testing.expectf(t, ch >= 0, "no channel %s", s.driver) do continue
    got := values[ch]
    testing.expectf(t, math.abs(got - s.value) < 1e-3, "%s %s at %v: %v, want %v", s.clip, s.driver, s.time, got, s.value)
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

// A pose's channels: the drivers, each IK target's (a pole's three only with one), the root's,
// then every axis of every instance's joints. Clips key them all by name.
@(test)
test_channels :: proc(t: ^testing.T) {
  m := Model{}
  append(&m.drivers, Driver{name = "a"})
  append(&m.iks, Ik{name = "leg"}, Ik{name = "arm", pole = true})
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
// moves only the drivers its clip keys, an ADDITIVE one adds its values, both by weight.
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

  // half an attack over the walk: halfway between them; an additive walk doubles the walk
  mix_sample(&clips, {{clip = walk, weight = 1, speed = 1}, {clip = attack, weight = 0.5, speed = 1}}, 0.4, out, scratch)
  clip_sample(&clips, walk, 0.4, want)
  clip_sample(&clips, attack, 0.4, scratch)
  for v, i in out do testing.expectf(t, math.abs(v - (want[i] + scratch[i]) / 2) < 1e-5, "replace: %s", channel_name(m, i))
  mix_sample(&clips, {{clip = walk, weight = 1, speed = 1}, {clip = walk, blend = .ADDITIVE, weight = 1, speed = 1}}, 0.4, out, scratch)
  for v, i in out do testing.expectf(t, math.abs(v - 2 * want[i]) < 1e-5, "additive: %s", channel_name(m, i))
}

// A gait's foot: down for its duty, sliding back by its stride at a steady speed, then swinging
// forward on an arc as high as its lift.
@(test)
test_gait_foot :: proc(t: ^testing.T) {
  near :: proc(a, b: f32) -> bool {return abs(a - b) < 1e-4}
  testing.expect(t, near(gait_foot(1, 0.4, 0.6, 0).z, 0.5) && gait_foot(1, 0.4, 0.6, 0).y == 0, "touches down ahead")
  testing.expect(t, near(gait_foot(1, 0.4, 0.6, 0.3).z, 0), "halfway through its stance: under the hip")
  testing.expect(t, near(gait_foot(1, 0.4, 0.6, 0.59999).z, -0.5), "lifts off behind")
  swing := gait_foot(1, 0.4, 0.6, 0.8)
  testing.expect(t, near(swing.y, 0.4) && near(swing.z, 0), "mid-swing: as high as the lift, under the hip")
  testing.expect(t, near(gait_foot(1, 0.4, 0.6, 1.3).z, gait_foot(1, 0.4, 0.6, 0.3).z), "the cycle repeats")
}

// A procedural walk on a real rig, with no keys at all: each leg's IK reaches (its weight 1), the
// stance foot stays on the ground sliding straight back, and the root dips as feet touch down.
@(test)
test_gait_walks :: proc(t: ^testing.T) {
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
  walk: Animation
  clip := Clip{name = "walk", duration = 1}
  clip.gait = {stride = 1, lift = 0.4, duty = 0.6, crouch = 0.3, bob = 0.1}
  append(&clip.gait.legs, Step{"l_leg", 0}, Step{"r_leg", 0.5})
  append(&walk.clips, clip)
  defer {
    delete(walk.clips[0].gait.legs)
    delete(walk.clips)
  }
  clips := clips_build(&walk, m)
  defer clips_destroy(&clips)
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

// A wave down the dragon's spine: every joint on the chain turning about its axis, head first,
// the wave travelling tailward and growing by its taper.
@(test)
test_gait_wave :: proc(t: ^testing.T) {
  text := read(t, "dragon.json")
  defer delete(text)
  m, a, ok := character_parse(text)
  testing.expect(t, ok)
  defer model_destroy(m)
  defer animation_destroy(a)
  slither: Animation
  clip := Clip{name = "slither", duration = 2}
  append(&clip.gait.waves, Wave{from = "segment_1", to = "tail", axis = .Y, amount = 0.2, length = 1, taper = 1})
  append(&slither.clips, clip)
  defer {
    delete(slither.clips[0].gait.waves)
    delete(slither.clips)
  }
  clips := clips_build(&slither, m)
  defer clips_destroy(&clips)
  wave := clips.clips[0].gait.waves[0]
  if !testing.expectf(t, len(wave.channels) == 11, "11 spine joints from segment_1 to the tail: %d", len(wave.channels)) {
    for ch in wave.channels do log.errorf("  %s", channel_name(m, ch))
    return
  }
  testing.expect(t, channel_name(m, wave.channels[0]) == "segment_1.spine.y" && channel_name(m, wave.channels[10]) == "tail.spine2.y")
  values := make([]f32, model_channels(m))
  defer delete(values)
  // each segment heads as the wave says: the sum of the turns down to it. A quarter cycle in, the
  // head is at its crest, the tail a wavelength behind too, twice as far; halfway down, half a
  // wave behind, at its trough, half again as far
  clip_sample(&clips, 0, 0.5, values)
  heading :: proc(values: []f32, chain: []int, upto: int) -> (sum: f32) {
    for ch in chain[:upto + 1] do sum += values[ch]
    return
  }
  testing.expectf(t, abs(heading(values, wave.channels[:], 0) - 0.2) < 1e-4, "head %v", heading(values, wave.channels[:], 0))
  testing.expectf(t, abs(heading(values, wave.channels[:], 10) - 0.4) < 1e-4, "tail %v", heading(values, wave.channels[:], 10))
  testing.expectf(t, abs(heading(values, wave.channels[:], 5) + 0.3) < 1e-4, "halfway %v", heading(values, wave.channels[:], 5))
  // and no joint turns by more than the wave's change between neighbours
  for ch in wave.channels do testing.expectf(t, abs(values[ch]) < 0.25, "%s turns %v", channel_name(m, ch), values[ch])
}
