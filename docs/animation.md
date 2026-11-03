# The mech animation engine

An **animation** is a character's named **clips**; it is the `"animation"` half of a character
file ([modeling.md](modeling.md#character-files)). A clip is a list of **motions**: shapes over
time added onto the model's **channels** ([modeling.md](modeling.md#rigging-channels-drivers-ik-targets)),
on top of the model's **rest pose**. A clip works on any model that has the channels it names.
The game **mixes** clips: each plays on a **layer**, with its own time scale and offset, replacing
or adding to the layers below.

```odin
model, anim, _ := mech.character_load("assets/characters/mech.json")  // or character_parse(text)
clips := mech.clips_build(anim, model)         // compile against the model; rebuild on edits
values, scratch := make([]f32, mech.model_channels(model)), make([]f32, mech.model_channels(model))
mech.clip_sample(&clips, mech.clips_find(&clips, "attack"), t, values)   // one clip at t seconds
layers := []mech.Layer{
  {clip = mech.clips_find(&clips, "walk"), weight = 1, speed = 1, loops = true},
  {clip = mech.clips_find(&clips, "wave"), weight = 1, speed = 1.5, offset = started},
}
mech.mix_sample(&clips, layers, t, values, scratch)                      // a mix at t seconds
mech.rig_pose(&scene, rig, values)
```

The `Mech` character (`src/character/mech.odin`) maps each `Action` to a clip by name
(`ACTION_CLIPS`: `idle`, `walk`, `run`, `attack`, `cast`, `combat_idle`) and plays it on its
first layer, looping or once following `action_loops`, cross-fading between clips. An action
with no clip shows the rest pose. Game code adds its own layers above the action's
(`mech_layers`, with offsets on `mech_now`'s clock). Tools can also play any clip on the first
layer or hold explicit values (`mech_play_clip`, `mech_show_values`).

## Motions

There is one kind of track. A motion is **a shape over time, added onto some channels**. A walk,
a slither and a strike aren't built into the engine. Each is a few motions with particular shapes
and numbers (the table below), and motions compose.

```json
{"name": "walk", "duration": 1, "motions": [
  {"moves": [{"by": {"root_y": -0.06}}]},
  {"shape": [{"v": 0.5}, {"u": 0.55, "v": -0.5}, {"u": 1, "v": 0.5}],
   "moves": [{"delay": 0.25, "by": {"l_leg": [0, 0, 1.75]}}, {"delay": 0.75, "by": {"r_leg": [0, 0, 1.75]}}]},
  {"shape": [{"v": 1, "ease": "IN"}, {"u": 0.5, "ease": "OUT"}], "rate": 2,
   "moves": [{"delay": 0.5, "by": {"root_y": -0.14}}]}
]}
```

A motion is `{shape, rate, moves}`:

- **shape**: points `{u, v, ease}` over one cycle: the value `v` at `u` (0 to 1), reached from
  the point before by `ease`. No points means 1 throughout: a pose held.
- **rate**: how many whole cycles of the shape run over the clip (default 1).
- **moves**: a list of `{delay, by}`. `by` holds the channel amounts that move together, and
  `delay` says how many cycles late they run. The amounts are written as anywhere else in these
  files: an `[x, y, z]` under a stem, or one channel.

At clip progress `x` (`t / duration`: 0 at the clip's start, 1 at its end), each move adds

```
out[c] += by[c] * shape(rate * x - delay)      for each channel c in by
```

A move's delay is written on the move itself, so you can read when it fires:

- **Two feet** are two moves, the second half a cycle later than the first.
- **A trot's diagonal pairs** are two moves of two channels each.
- **A strike** fires feet, pelvis, chest, shoulder, arm and fist as moves in that order, each a
  little later.
- **A wave down a chain** is a move per joint, the delays growing toward the tail.

**The shape** repeats every cycle: the last point eases into the first a cycle on. A one-shot (a
strike) is a shape that ends where it starts (it returns to 0), so repeating changes nothing. Its
moves must all finish within the clip: the last point plus the largest delay must be at most 1,
or the end of the shape wraps round to the clip's start. A whole cycle in (u = 1, 2, …) is the
cycle's end, so a one-shot clip held at its end holds the shape's last point.

**Loops are seamless**: the rate is a whole number, so every motion ends a clip where it started.

### Eases

An ease shapes how a shape goes from one point to the next. Each runs from 0 at the start to
exactly 1 at the end, so shapes join where they say. They are all mechanical: things move, hit a
stop and hold, rather than ease to and fro.

| ease | how it gets there | for |
| --- | --- | --- |
| `LINEAR` | steady (the default, left out of files) | a foot sliding back, a piston, a ramp, a return |
| `IN` | slow, then faster and faster | driving into a hit, a foot landing |
| `OUT` | fast, then slowing | a wind-up, coasting to a stop |
| `SETTLE` | there a sixth in, then a damped bounce (about 0.19 past, 0.04 short), still at the end | a hard stop: an arm slamming into its limit, a servo overshooting, a jaw snapping shut |
| `STEP` | holds, then snaps at the end | a ratchet, a lock clunking in |

### Shapes to start from

The character editor's curve editor starts shapes from these (`shapes.js`); after that, a shape
is whatever the artist drags it into:

| shape | points |
| --- | --- |
| hold | none: 1 throughout. A pose held: a stance, a crouch, a guard |
| sine | 1 at ¼, −1 at ¾: a sway, a swing, a wave |
| slide | ½ at 0, −½ at the duty, ½ at 1: a foot down for `duty` of the cycle sliding back, then swinging ahead |
| lift | 0 at the duty, 1 halfway after (OUT), 0 at 1 (IN): the foot lifted as it swings |
| pulse | 0, 1 at the rise (IN drives into a hit), 0 at 1: a strike |
| square | 1 around ¼, −1 around ¾, each move SETTLE into its stop and held: a servo swinging (an arm, a hull, a weight shift) |
| bounce | 1 at 0 reached IN, 0 at ½ left OUT: the body coming down hard on each step, lowest as the foot lands |
| hit | still, into 1 by SETTLE, held, back to 0 by the end: a strike slamming into its stop |
| steps | from −1 up to 1 and back in `n` steps, each SETTLE (or STEP: snapping): a scan, a ratchet |

### Familiar motions, as data

| motion | as motions |
| --- | --- |
| a stance (idle) | the rest pose ([modeling.md](modeling.md#the-rest-pose)): nothing to write. Mechanical life on top: a scan in `steps`, a weight shift as a `square` on `root_x` |
| a different stance (combat idle, a walk's crouch) | no shape: a held motion, its amounts how it differs from the rest pose |
| a walk's feet | a slide and a lift, each with a move per leg's IK target: `[0, 0, stride]` slides it, `[0, lift, 0]` lifts it, the first foot's delay its touch-down. A duty over 0.5 walks, under 0.5 runs (every foot off the ground at once). A biped's second foot is half a cycle later. A quadruped's walk sets each hind foot down, then the fore foot on its side (delays 0, ¼, ½, ¾); a trot moves diagonal pairs together (two moves of two) |
| its bob | a bounce on `root_y`, rate 2 for a biped (once a step), lowest as each foot lands |
| a sway, a hull against the legs | a sine or a square, one move |
| a wave (a snake's slither, a tail's sway) | a move per joint down a chain, each turning about the chain's side axis (a snake slithers about Y), each a fraction of a cycle later than the one before: the wave travels tailward. To have each segment head as the shape says instead of the turns piling up, each move also turns the next joint back by as much (the dragon's slither) |
| arms swinging | a square: the shoulders one move (the other arm at minus its amounts: half a cycle apart), the forearms a move a little later |
| a strike | a hit, its moves the hit's channels in firing order (feet, pelvis, chest, shoulder, arm, fist), each a little later, each slamming into its stop. The wind-up is a hit before it with the coil's amounts, OUT, over the clip's first part, letting go as the strike rises. A step into it is a one-shot shape of its own on the foot's IK target (out, held, back), with a lift for each step |
| a head that is the root (the dragon) | turn the root and the first spine joint back by as much: the head turns alone |

## How a clip is sampled

`clip_sample(clips, clip, t, out)` starts from the rest pose (`Clips.pose`, compiled from the
model's `pose`) and adds each motion in file order. `clips_build` compiles an `Animation`
against a `Model`: names become channel indices, a shape's points are sorted by u. Names the
model lacks are logged and skipped. Rebuild it whenever either side changes; the editors do so
on every edit.

## Mixing clips on layers

A `Layer` is `{clip, blend, weight, speed, offset, loops}`. At mix time `t` its clip is at
`(t - offset) * speed` seconds, wrapped over the clip's duration when it loops, held at its ends
when it doesn't. `mix_sample(clips, layers, t, out, scratch)` starts from the rest pose and lands
each layer, from the first up, by its `weight`:

```
sample = the clip sampled (on the rest pose)
REPLACE:   out[c] = lerp(out[c], sample[c], weight)   for each channel c the clip's moves name
ADDITIVE:  out += (sample - rest pose) * weight
```

The channels a clip sets are those its moves name (`ClipData.channels`, found when it is built).
A REPLACE layer moves only those, so a strike of just the upper body plays over a walk, replacing
its arms and leaving the legs to it. An ADDITIVE layer adds how its clip differs from the rest
pose to whatever is below (a recoil, a lean). Mixing is the game's: the character editor edits
one clip at a time.

Cross-fading (in `src/character/mech.odin`): when an action starts, the pose currently shown is
kept, and the new mix is blended over it with a smoothstep across the fade time.

## Style for the mech

The mech moves like a machine, not a person: legs stand straight, there's no idle breathing,
and strikes aren't boxing moves. A strike carries force up a chain, feet → pelvis → shoulder →
arm → fist, each link firing in turn.

## The assets

Each character's stance is its rest pose (the model's `pose`). Its clips hold how they differ from
it, then their motions. They were checked on the rig (`test_shipped_clips`: loops end where they
start, planted feet stay on the ground and don't slide sideways). `test_golden_poses` compares
every frame of every clip against the reference in `bin/golden`.

- `assets/characters/mech.json`: `idle` (the head scanning in settling steps), `combat_idle`
  (the guard held, the weight shifting foot to foot between stops), `walk` and `run` (feet
  sliding and lifting on IK, crouched, coming down hard on each step, the arms swinging between
  stops against the legs, the waist and head twisting), `attack` (the left foot steps into a
  lunge; a wind-up coils pelvis, waist and arm; the hit fires pelvis, waist, arm and head in
  turn, slamming into its stops) and `cast` (gather, then the arms thrown up and the hands
  opening, a kick back as it fires).
- `assets/characters/strider.json`: the same, for a reverse-jointed body: the sensor scans,
  `walk` and `run` counter-swing pelvis, hull and cannons, `attack` is a cannon ram with a step
  and a root lunge, `cast` braces and tips the rack, then three launches kick the rack and root
  back (three moves of the same amounts, a quarter cycle apart).
- `assets/characters/dragon.json`: the head is the root. `idle` (the head scanning, the tail
  ticking side to side), `combat_idle` (reared: head up, the neck sloping down to the body on
  the ground, forelimbs raised, the jaw snapping in steps, swaying between stops), `slither`
  (limbs folded back, a square wave down the spine's z turns, a wavelength along it) and
  `attack` (coil back and up, then lunge, the jaw snapping shut on the hit).
