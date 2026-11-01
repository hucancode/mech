#+build js
package main

import "base:runtime"

// The viewer in the browser. The page (tools/character-editor/src/viewer.ts) writes UTF-8 text
// into buffers from viewer_alloc and calls the exports below between frames. Exports that answer
// with text or numbers leave them in one result buffer: they return its address, and
// viewer_result_len its length in bytes. The answer stays valid until the next such call.

@(private = "file")
ctx: runtime.Context

@(private = "file")
result: [dynamic]u8

main :: proc() {
  context.logger = viewer_logger()
  ctx = context
  if !viewer_init("Mech character editor") do return
  viewer_run()
}

@(private = "file")
answer :: proc(bytes: []u8) -> rawptr {
  clear(&result)
  append(&result, ..bytes)
  return raw_data(result) if len(result) > 0 else nil
}

@(export)
viewer_alloc :: proc "contextless" (n: int) -> rawptr {
  context = ctx
  data, _ := make([]u8, n)
  return raw_data(data)
}

@(export)
viewer_free :: proc "contextless" (p: rawptr, n: int) {
  context = ctx
  delete(([^]u8)(p)[:n])
}

@(export)
viewer_result_len :: proc "contextless" () -> int {
  return len(result)
}

// viewer_set_model sends model file text; the mech is rebuilt.
@(export)
viewer_set_model :: proc "contextless" (p: [^]u8, n: int) -> bool {
  context = ctx
  return set_model(p[:n])
}

// viewer_set_animation sends animation file text; the clips are recompiled.
@(export)
viewer_set_animation :: proc "contextless" (p: [^]u8, n: int) -> bool {
  context = ctx
  return set_animation(p[:n])
}

// viewer_set_values shows driver values: a JSON object of driver name to value.
@(export)
viewer_set_values :: proc "contextless" (p: [^]u8, n: int) -> bool {
  context = ctx
  return set_values(p[:n])
}

// viewer_play shows clip `clip` at `time` seconds, playing at `speed` or held.
@(export)
viewer_play :: proc "contextless" (clip: i32, time: f32, playing: bool, speed: f32, loops: bool) {
  context = ctx
  app.show, app.clip, app.time, app.playing, app.speed, app.loops = .CLIP, int(clip), time, playing, speed, loops
  apply_show()
}

// viewer_select outlines part `part`'s shapes, shape `shape` in white; -1 for none. With
// `isolate`, the rest of the character and the floor are hidden (the editor's Model tab).
@(export)
viewer_select :: proc "contextless" (part, shape: i32, isolate: bool) {
  app.part, app.shape, app.isolate = int(part), int(shape), isolate
}

// viewer_explode pushes the isolated part's shapes apart: 0 assembled, 1 by the part's size.
@(export)
viewer_explode :: proc "contextless" (amount: f32) {
  app.explode = max(amount, 0)
}

@(export)
viewer_frame :: proc "contextless" () {
  context = ctx
  frame_camera()
}

// viewer_view looks at the character from a View: 0 free (perspective orbit), then from +x, -x,
// +y, -y, +z, -z (orthographic, framed). Dragging to turn goes back to free.
@(export)
viewer_view :: proc "contextless" (view: i32) {
  context = ctx
  if view >= i32(min(View)) && view <= i32(max(View)) do set_view(View(view))
}

@(export)
viewer_time :: proc "contextless" () -> f32 {
  return app.time
}

// viewer_format_character answers the character (model and animation) as character file text,
// written the way the game's tools write it.
@(export)
viewer_format_character :: proc "contextless" () -> rawptr {
  context = ctx
  if !app.has_asset do return answer(nil)
  text := format_character()
  defer delete(text)
  return answer(transmute([]u8)text)
}

// viewer_query answers a JSON query with JSON (see query.odin): states, samples, solves.
@(export)
viewer_query :: proc "contextless" (p: [^]u8, n: int) -> rawptr {
  context = ctx
  text := query(p[:n])
  defer delete(text)
  return answer(transmute([]u8)text)
}
