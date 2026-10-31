#+build !js
package main

import "core:fmt"
import "core:os"

// The viewer as a desktop app: bin/viewer <character file>. Drag orbits.
main :: proc() {
  context.logger = viewer_logger()
  args := os.args[1:]
  path := args[0] if len(args) > 0 else "assets/characters/mech.json"
  if !viewer_init(fmt.tprintf("Mech viewer: %s", path)) do return
  text, err := os.read_entire_file(path, context.allocator)
  if err != nil {
    fmt.eprintln("cannot read", path, err)
    return
  }
  if !set_character(text) do return
  app.clip, app.playing = 0, true
  apply_show()
  viewer_run()
}
