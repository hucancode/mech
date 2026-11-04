package character

import "../mjolnir/render"
import "../mjolnir/world"

// Action is everything gameplay can ask a character to do. Every character type implements all of
// them, so gameplay code never needs to know what kind of character it drives.
Action :: enum u8 {
  IDLE,
  WALK,
  RUN,
  ATTACK,
  CAST,
  COMBAT_IDLE, // a fight-ready stance, held
  ATTACK_B, // the second attack: a left uppercut on the mech
  ATTACK_C, // the third: a two-handed overhead slam on the mech
}

// action_loops: IDLE, WALK, RUN and COMBAT_IDLE repeat. The attacks and CAST play once, then return to IDLE.
action_loops :: proc(a: Action) -> bool {
  return a in bit_set[Action]{.IDLE, .WALK, .RUN, .COMBAT_IDLE}
}

// Character is the one interface gameplay talks to. Characters face +Z with their feet at the root
// node's origin, and animate in place: gameplay moves and turns `root` through world.transform.
// Build one with mech_create, then use the character_* wrappers.
Character :: struct {
  data:    rawptr,
  root:    world.NodeHandle,
  play:    proc(data: rawptr, a: Action, fade: f32),
  // update runs before mjolnir.update each tick.
  update:  proc(data: rawptr, dt: f32),
  // idle reports whether no one-shot (an attack, CAST) is in progress, i.e. the character accepts a
  // new order without cutting an action short.
  idle:    proc(data: rawptr) -> bool,
  destroy: proc(data: rawptr, w: ^world.World, r: ^render.Renderer),
}

// character_play starts `a`, cross-fading from the current action over `fade` seconds. Asking for
// the action already playing is a no-op for looping actions and restarts a one-shot.
character_play :: proc(c: ^Character, a: Action, fade: f32 = 0.2) {
  c.play(c.data, a, fade)
}

character_update :: proc(c: ^Character, dt: f32) {
  c.update(c.data, dt)
}

character_idle :: proc(c: ^Character) -> bool {
  return c.idle(c.data)
}

character_destroy :: proc(c: ^Character, w: ^world.World, r: ^render.Renderer) {
  c.destroy(c.data, w, r)
  c^ = {}
}
