#+build !js
package mech

import "core:fmt"
import "core:math"
import "core:math/linalg"
import "core:os"
import "core:testing"

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
    {"idle", "r_elbow", 0.5, 0.2618},
    {"walk", "l_hip", 0.25, 0.384},
    {"walk", "r_hip", 0.75, 0.384},
    {"attack", "r_shoulder", 0.4, 1.1145},
    {"attack", "pelvis_turn", 0.9, 0},
  }
  for s in spots {
    clip_sample(&clips, clips_find(&clips, s.clip), s.time, values)
    ch := model_driver(m, s.driver)
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
  mo := limit(b, Motion{turn = {-3, 1, 0}})
  testing.expect(t, mo.turn.x == -2.5 && mo.turn.y == 1, "x held, y free")
  testing.expect(t, limit(b, Motion{turn = {0.5, 0, 0}}).turn.x == 0.1)
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

// After the drivers come the root's channels: clips key them by name like any driver.
@(test)
test_root_channels :: proc(t: ^testing.T) {
  m := Model{}
  append(&m.drivers, Driver{name = "a"})
  defer delete(m.drivers)
  testing.expect(t, model_channels(&m) == 7)
  testing.expect(t, model_channel(&m, "a") == 0 && model_channel(&m, "root_y") == 2 && model_channel(&m, "b") == -1)
  testing.expect(t, channel_name(&m, 6) == "root_turn_z")
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
