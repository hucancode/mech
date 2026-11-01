package mech

import "core:encoding/json"
import "core:log"
import "core:strings"

// A character file (assets/characters/<name>.json) holds one character: its model and its animation.
//   {"model": {..}, "animation": {"clips": [..]}}
// In memory they stay a Model and an Animation, parsed and freed on their own.

// character_parse reads a character file's text into its model and animation.
character_parse :: proc(data: []u8, what := "character") -> (m: ^Model, a: ^Animation, ok: bool) {
  value, err := json.parse(data, parse_integers = false, allocator = context.temp_allocator)
  if err != nil {
    log.errorf("cannot parse %s: %v", what, err)
    return nil, nil, false
  }
  root, is_object := value.(json.Object)
  if !is_object {
    log.errorf("%s: not a character (an object with a model and an animation)", what)
    return nil, nil, false
  }
  // each half is parsed on its own, into its own arena
  part :: proc(root: json.Object, key: string) -> []u8 {
    v, found := root[key]
    if !found do return transmute([]u8)string("{}")
    text, _ := json.marshal(v, allocator = context.temp_allocator)
    return text
  }
  m = model_parse(part(root, "model"), what) or_return
  a, ok = animation_parse(part(root, "animation"), what)
  if !ok {
    model_destroy(m)
    return nil, nil, false
  }
  return m, a, true
}

// character_format writes a character file's text, allocated with `allocator`.
character_format :: proc(m: ^Model, a: ^Animation, allocator := context.allocator) -> string {
  b := strings.builder_make(allocator)
  strings.write_string(&b, "{\n  \"model\": ")
  write_value(&b, m^, 1)
  strings.write_string(&b, ",\n  \"animation\": ")
  write_value(&b, a^, 1)
  strings.write_string(&b, "\n}\n")
  return strings.to_string(b)
}
