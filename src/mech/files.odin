#+build !js
package mech

import "core:log"
import "core:os"

// Loading and saving character files, where there is a file system. A browser build passes file
// text to character_parse and takes character_format back.

character_load :: proc(path: string) -> (m: ^Model, a: ^Animation, ok: bool) {
  data, err := os.read_entire_file(path, context.allocator)
  if err != nil {
    log.errorf("cannot read %s: %v", path, err)
    return nil, nil, false
  }
  defer delete(data)
  return character_parse(data, path)
}

character_save :: proc(m: ^Model, a: ^Animation, path: string) -> bool {
  text := character_format(m, a)
  defer delete(text)
  if err := os.write_entire_file(path, transmute([]u8)text); err != nil {
    log.errorf("cannot write %s: %v", path, err)
    return false
  }
  return true
}
