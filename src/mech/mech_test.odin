#+build !js
package mech

import "core:fmt"
import "core:math"
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
  for name in ([]string{"mech", "dragon"}) {
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
  values := make([]f32, len(m.channels))
  defer delete(values)
  Spot :: struct {
    clip, channel: string,
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
    ch := model_channel(m, s.channel)
    got := values[ch]
    testing.expectf(t, math.abs(got - s.value) < 1e-3, "%s %s at %v: %v, want %v", s.clip, s.channel, s.time, got, s.value)
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
