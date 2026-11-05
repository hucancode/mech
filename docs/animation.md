# The mech animation engine

An **animation** is a character's named **clips**; it is the `"animation"` half of a character
file ([modeling.md](modeling.md#character-files)). A clip is a list of **motions**: shapes over
time added onto the model's **channels** ([modeling.md](modeling.md#rigging-channels-ik-targets)),
on top of the model's **rest pose**. A clip works on any model that has the channels it names.
A character plays one clip at a time, cross-fading from one to the next.

```odin
model, anim, _ := mech.character_load("assets/characters/mech.json")  // or character_parse(text)
clips := mech.clips_build(anim, model)         // compile against the model; rebuild on edits
values := make([]f32, mech.model_channels(model))
walk := mech.clips_find(&clips, "walk")
mech.clip_sample(&clips, walk, mech.clip_time(&clips, walk, t, loops = true), values)   // the walk, t seconds in
mech.rig_pose(&scene, rig, values)
```

The `Mech` character (`src/character/mech.odin`) maps each `Action` to a clip by name
(`ACTION_CLIPS`: `idle`, `walk`, `run`, `attack`, `attack_b`, `attack_c`, `cast`, `combat_idle`) and plays it, looping
or once following `action_loops`, cross-fading between clips. An action with no clip shows the
rest pose. Tools can also play any clip or hold explicit values (`mech_play_clip`,
`mech_show_values`).

## What there is to learn

| layer | concepts |
| --- | --- |
| model ([modeling.md](modeling.md)) | **Part** (shapes, slots, joints, length; a shape or slot can mirror) · **Joint** (PIN, SPIN, LINEAR, BALL, its stops) · **Instance** (parent, slot, twist; placed on both sides from a mirrored slot) · **Ik** (`tip`, `aim`) · the **rest pose** (a symmetric map) |
| channels | `<place>.<joint>` (`l_arm.shoulder`) · `root`, `root.turn` · `<ik>`, `<ik>.swivel`, `<ik>.weight` |
| animation | **Clip** → **Motion** `{shape, rate, moves}` → **Move** `{delay, spread, twin, by}` · named **Poses** (amounts) · named **Arcs** (a path for a position) · five **Eases** |

That is all. A chain is not an object: it is a move's own channels, in the model's order. There
are no key frames and no curve per joint.

## Motions

There is one kind of track. A motion is **a shape over time, added onto some channels**. A walk,
a slither and a strike aren't built into the engine. Each is a few motions with particular shapes
and numbers (the table below), and motions compose.

There are no key frames, and there is no need for them. A key frame track keys every channel
apart; a motion's shape is one keyed curve that a whole set of channels shares, each by its own
amount and delay. That is what mechanical motion is: parts moving together between stops. A pose
held is a motion with no shape, and a pose at a moment is a shape stepping into it there.

```json
{"arcs": [{"name": "step", "points": [[0, 0, 0.875], [0, 0, -0.875], [0, 0.3, 0]], "corners": [0, 1], "closed": true}],
 "clips": [{"name": "walk", "duration": 1, "motions": [
  {"moves": [{"by": {"root": [0, -0.06, 0]}}]},
  {"shape": [{}, {"u": 0.55, "v": 0.3333}, {"u": 1, "v": 1}],
   "moves": [{"delay": 0.25, "twin": "OPPOSITE", "arcs": {"l_leg": "step"}}]},
  {"shape": [{"v": 1, "ease": "IN"}, {"u": 0.5, "ease": "OUT"}], "rate": 2,
   "moves": [{"delay": 0.5, "by": {"root": [0, -0.14, 0]}}]}
]}]}
```

A motion is `{name, shape, rate, moves}`:

- **name**: for people (the editor lists motions by it); the engine reads nothing from it. Left
  out, the editor says the motion's shape and what it moves.
- **shape**: points `{u, v, ease}` over one cycle: the value `v` at `u` (0 to 1), reached from
  the point before by `ease`. No points means 1 throughout: a pose held.
- **rate**: how many whole cycles of the shape run over the clip (default 1).
- **moves**: a list of `{delay, spread, twin, by, poses, arcs}`. What a move moves is three maps,
  each by name, so nothing is read two ways:
  - `by`: the channel amounts that move together, each shaped as its channel
    ([modeling.md](modeling.md#rigging-channels-ik-targets)): a number for a turn, a slide or a
    weight, `[x, y, z]` for a rotation or a position.
  - `poses`: the animation's poses it adds, each how much of it ([Poses](#poses)).
  - `arcs`: the positions it puts on the animation's arcs, each the arc's name ([Arcs](#arcs)).

  `delay` says how many cycles late they run. `spread` runs them one after another instead
  ([Spread](#spread)). `twin` moves the other side of the body too ([Twins](#twins)).

  The first format wrote all three in `by` (an arc's name as a position's value, a pose's name as
  a key). Such a file still reads (`animation_parse` moves them to `poses` and `arcs`) and is
  written back in this one.

At clip progress `x` (`t / duration`: 0 at the clip's start, 1 at its end), each move adds

```
out[c] += by[c] * shape(rate * x - delay)      for each channel c in by
```

A move's delay is written on the move itself, so you can read when it fires:

- **Two feet** are one move with an OPPOSITE twin: the other foot half a cycle later.
- **A trot's diagonal pairs** are two moves of two channels each.
- **A strike** fires feet, pelvis, chest, shoulder, arm and fist as moves in that order, each a
  little later.
- **A wave down a chain** is one move over the chain's joints with a spread.
- **An arm firing** shoulder, elbow, wrist is one move with a small spread.

### Spread

A move's `spread` (cycles, default 0) runs its channels one after another. Its channels, in the
model's order (parents first: down a chain, head to tail), are links 0 to n − 1, and link k runs
`spread · k / (n − 1)` cycles later than the move's delay:

```
out[c] += by[c] * shape(rate * x - delay - spread * k / (n - 1))
```

The shape is the curve; the spread is the offset along the chain. A 3-value channel is one link.
The amounts stay each channel's own, so a wave that grows toward the tail is just its numbers.
Twins run at their links' delays (an OPPOSITE twin half a cycle on). An arc in a spread move runs
at the move's delay; the rest pose ignores spread as it ignores delay. The dragon's slither is two
such moves: one turning each spine joint, `spread: 1` (a wavelength along the body), and one
turning the next joint back by as much, so each segment heads as the shape says.

### Arcs

A path in space is drawn, not keyed. An **arc** is the animation's, by name, shared by every
clip: `"arcs": [{"name": "step", "points": [[x, y, z], ..]}]`, a smooth curve through its
points (`mech.arc_at`, Catmull-Rom). A move puts a **position** on it by naming it in its `arcs`,
`"arcs": {"l_leg": "step"}` (an IK target or the root: a turn or a rotation is one value per axis,
no path, so no arc moves it). The points are written as the position's own values are: offsets from
where it is at rest (an IK target's tip, the model's origin), in the model's space. The move puts
the position on the arc where its motion's shape says, instead of adding amounts:

```
out[position] += arc(shape(rate * x - delay))      0 the first point, 1 the end, point k at its `at`
```

An arc is **open** (the default): it runs from its first point to its last, `n - 1` segments. A
one-shot whose shape goes 0, 1, 0 runs out along it and back the same way. A **`closed`** arc runs
on from its last point back to its first, `n` segments, each point written once: a loop.

Where along the arc each point is, the shape value that reaches it, is its **`at`**:
`"at": [0, 0.3, 1]`, one per point, rising (0 to 1; a closed arc's last below its first plus 1,
room for the way back). Left out, the points are spread evenly, point k at `k / segments`. So
adding a point between two (the editor gives it `at` halfway between theirs) or taking one out
leaves every other point where it was along the arc, and every move on it as timed: a strike still
lands on its impact. Closing or opening an arc spreads its points evenly again.

So the shape times the path: it holds on a point at its `at`, eases between points as it eases
between values, and a SETTLE past a point overshoots along the path, not off it (past the ends,
an open arc runs on along their tangents; a closed one goes round again). An arc's twin follows the same points, the other side's x
mirrored. Only a clip's motions use arcs (not the rest pose). A name the animation lacks is
skipped (`character_check` reports it).

Between its points an arc is a cubic (Hermite). Each point's tangent is half the way from the
point before to the one after (Catmull-Rom), so the path runs smooth through it. Two cases use
the segment's own chord as the tangent instead:

- **Ends.** An open arc's ends have no point on one side.
- **Corners.** `"corners": [k, ..]` lists the sharp points. A segment between two corners is a
  straight line at a steady speed: a foot on the ground, a piston's stroke, a punch driven
  straight. Mechanical paths are lines and hard turns. Smooth arcs stay the default, so curved,
  organic paths are still possible.

A closed arc runs smooth through its seam too, since its neighbours wrap round it. It turns hard
there only when its first point is a corner. A gait's foot lists corners 0 and 1, so it turns hard
where it touches down and lifts.

A **gait's foot** is one closed arc (the mech's `step` and `stride`):

- The points are front and back on the ground, both corners, then the top of the swing.
- The shape's one point, `{u: duty, v: 1/3}`, says when the foot leaves the ground. So the duty
  is written once, and the stance is a straight, steady slide on the ground, which doesn't skate.
- The stride is the ground points' distance apart and the lift is the top point's height, both
  dragged in the view.

A move can also hold an IK target's swivel beside its arc (`"l_leg.swivel": 0.4`,
[modeling.md](modeling.md#rigging-channels-ik-targets)): it is an amount like any other, times the
shape, so the knee swings out as the foot goes along the path.

Arcs are for what must stay put in the world: a foot on the ground, the root lunging. A gesture
(a fist's strike, a wave) is not drawn as a path for an IK target to chase: a mech's arm has too
few joints to follow one, so it is its joints' turns, FK, firing into their stops. The character
editor lists the arcs, edits the one picked in the view (a dot per point to drag), and the curve
editor marks the shape values that put a position on each point ([editors.md](editors.md#animate)).

### Poses

A **pose** is a named set of channel amounts. It belongs to the animation and every clip shares
it: `"poses": [{"name": "fist", "by": {"r_finger_a_1.knuckle": -0.68, ..}}]`.

- **Using one.** A move adds a pose by naming it in its `poses`, with how much of it:
  `"poses": {"fist": 1}` adds every amount, `"fist": 0.77` a little less of each.
- **Twins and delays.** The move's twin and delay apply to the pose's amounts as they do to its
  own. A fist written on the right hand closes both hands with a WITH twin, or only the right
  one without a twin.
- **Limits.** A pose holds amounts only: no arcs and no other poses. Poses are named apart from
  channels (a move adds them in its own `poses`), so a pose may share a channel's name. The rest
  pose is the model's, so it can't add the animation's poses.

The mech's `fist` is nine knuckle values written once. Before poses, the same nine numbers were
repeated in combat_idle, walk, run, attack and cast.

### Twins

Most of a mech moves in pairs: two feet, two arms, two hands, each written once and placed on
both sides of the body from a mirrored slot. A move's `twin` moves each of its channels' twins
too, by the same amounts (`mech.channel_twin`: the same joint on the instance's other side, the
other side's IK target with x mirrored (and its swivel turned over);
[modeling.md](modeling.md#parts-and-the-assembly)):

| twin | the other side | for |
| --- | --- | --- |
| (none) | doesn't move | a strike with one arm, a guard |
| `WITH` | at the same time | a stance, both hands opening, both arms thrown up |
| `OPPOSITE` | half a cycle later | the other foot, the other arm swinging back |

Channels with no twin (the root's, a waist's) move once, as written. So a walk writes the left
side only. An arm swing is a `square` with an OPPOSITE twin: half a cycle on, a square is its own
negative, so the right arm swings back as the left swings forward. The rest pose moves as a WITH
move does. `clips_build` resolves a twin move into two (`mech.move_resolve`), so sampling costs
the same as writing both sides out.

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
| a stance (idle) | the rest pose ([modeling.md](modeling.md#the-rest-pose)): nothing to write. Mechanical life on top: a scan in `steps`, a weight shift as a `square` on `root` |
| a different stance (combat idle, a walk's crouch) | no shape: a held motion, its amounts how it differs from the rest pose |
| a walk's feet | one move on the left leg's IK target with an OPPOSITE twin, on a closed foot arc ([Arcs](#arcs)): front and back on the ground (corners), the top of the swing; its shape `{u: duty, v: 1/3}`, the delay its touch-down. A duty over 0.5 walks, under 0.5 runs (every foot off the ground at once). A quadruped's walk is two such moves, a hind foot and the fore foot on its side a quarter cycle later (delays 0, ¼; their twins at ½, ¾); a trot, a fore and hind foot together on one move |
| its bob | a bounce on `root` (its y), rate 2 for a biped (once a step), lowest as each foot lands |
| a sway, a hull against the legs | a sine or a square, one move |
| a wave (a snake's slither, a tail's sway) | one move over the chain's joints with a spread, each turning about the chain's side axis (a snake slithers about Y): the wave travels tailward, a wavelength along the chain for `spread: 1`. To have each segment head as the shape says instead of the turns piling up, a second spread move turns the next joint back by as much (the dragon's slither) |
| arms swinging | a square: the shoulder and forearm one move with an OPPOSITE twin and a small spread (the forearm a little later). The waist and head turning against them are one more move of the same motion with a spread, no twin |
| a strike | two hits: the coil (OUT into its stop, held) and the drive (into a SETTLE stop, held, back), each firing its chain as moves a little later in turn: pelvis, waist, then the arm as one move with a spread (shoulder, elbow, wrist), then the fist. The arm is FK: its joints' turns, not a hand chasing a path. The head aims at the impact. A step into it is a one-shot shape of its own on the foot's IK target (out, held, back), with a lift for each step |

## How a clip is sampled

`clip_sample(clips, clip, t, out)` starts from the rest pose (`Clips.pose`, compiled from the
model's `pose`) and adds each motion in file order. `clips_build` compiles an `Animation`
against a `Model`: names become channel indices, poses expand into their amounts, arcs are copied
with their corners, and a shape's points are sorted by u. What a name and value of a `by` mean is
decided in one place (`mech.by_resolve`: an amount, a pose, an arc, or bad); what is bad is
skipped quietly, and `character_check` reports why. Rebuild it whenever either side changes; the
editors do so on every edit.

## Checking a character

`character_check(model, anim)` (`src/mech/check.odin`) lists everything wrong with a character,
the one place that does: names that resolve to nothing or twice, values shaped unlike their
channel, two channels coming out with one name (an IK target named `root`, an instance `root`
with a joint `turn`), joints without stops, a mirrored slot on its own plane, a rest pose writing
both sides.
Those are **ERROR**s. **BUDGET** issues are data the engine can use but which is fighting the
machine (Style, below). `asset_compile` logs them all, so the game logs them and the character
editor shows them; `test_assets_check` holds the shipped characters to no ERROR.

## Playing clips

`clip_time(clips, clip, t, loops)` is where a clip is `t` seconds after it started: wrapped over
its duration when it loops, held at its ends when it doesn't. Cross-fading (in
`src/character/mech.odin`): when an action starts, the pose currently shown is kept, and the new
clip is blended over it with a smoothstep across the fade time.

## Style for the mech

The mech moves like a machine, not a person: legs stand straight, there's no idle breathing,
and strikes aren't boxing moves. A strike carries force up a chain, feet → pelvis → shoulder →
arm → fist, each link firing in turn.

- **IK for contact and aim, FK for gesture.** Feet stay on the ground by IK, heads aim by IK;
  arms, hands and cannons move by their joints' turns, between stops. A clip moves a foot's
  target only: the rig lands it on its heel, stands it flat and peels its heel up as it slides
  behind the body (ground contact, [modeling](modeling.md)), so no clip turns an ankle or a toe to
  do it. For a run where a foot is always on the ground (one landing as the other peels off), give
  the foot arc a duty a little over 0.5 (the mech's run: 0.55); under 0.5, both feet hang in the
  air with nothing planted.
- **When a clip grows, change the approach, not the amount of data.** A shape of more than about
  six points, a channel in more than two motions, or an IK target needing a hand-drawn path to
  reach means the motion is fighting the machine: use FK, a pose or a spread instead.
  `character_check` reports the first two as BUDGET issues (`SHAPE_BUDGET`, `MOTION_BUDGET`); the
  editor shows them beside the errors.

## The assets

Each character's stance is its rest pose (the model's `pose`, one side written, symmetric). Its clips
hold how they differ from it, then their motions; pairs are twin moves. They were checked on the rig (`test_shipped_clips`: loops end where they
start, planted feet stay on the ground and don't slide sideways). `test_golden_poses` compares
every frame of every clip against the reference in `bin/golden`.

- `assets/characters/mech.json`: `idle` (the head scanning in settling steps), `combat_idle`
  (the guard held, the weight shifting foot to foot between stops), `walk` and `run` (feet
  on their IK targets' closed foot arcs (`step`, `stride`), crouched, the fists a `fist` pose, coming down hard on each step, the arms swinging
  against the legs, each arm back as its foot lands: driven through the middle (IN) and slowing
  into a short hold at each end (OUT), the forearm a little later and bending on the forward
  swing; the run's swing biased back so the fist rises only to the chest; the waist and head
  twisting), `attack` (the head locks on the impact
  point as the left foot steps into a lunge; the coil turns pelvis and waist and swings the right
  arm back, elbow cocked, the fist closing; the drive fires the chain the other way, pelvis,
  waist, then shoulder, elbow and wrist slamming into their stops with the arm locked straight
  ahead at shoulder height, held, then back to rest; the arms are FK, there is no hand IK),
  `attack_b` (a left uppercut: the right fist up as a guard, a crouch and a coil turning the left
  side back with the arm dropped and the elbow cocked, then the drive turns pelvis and waist the
  other way and fires the arm up into a SETTLE stop in front of the face; the coil lets go on the
  drive's own SETTLE, so the two hand over without a bump), `attack_c` (a two-handed overhead
  slam: the left foot steps in as both arms rise overhead, the waist leaning back; then the root
  drops, the waist folds forward and both fists slam down in front, the raise letting go on the
  slam's SETTLE) and `cast` (gather, then waist, head, arms and hands thrown up and open as one
  spread move, the gather letting go as they fire so nothing drifts after the arms lock, a kick
  through waist and head as it fires).
- `assets/characters/strider.json`: the same, for a reverse-jointed body: the sensor scans,
  `walk` and `run` counter-swing pelvis, hull and cannons, `attack` is a cannon ram with a step
  and a root lunge, `cast` braces and tips the rack, then three launches kick the rack and root
  back (three moves of the same amounts, a quarter cycle apart). No clip moves its feet' joints:
  the rig rolls them heel to toe (ground contact, [modeling](modeling.md)), landing on the heel,
  standing flat, peeling the heel up as a leg stretches.
- `assets/characters/dragon.json`: the head is the root. `idle` (the head scanning, the tail
  ticking side to side), `combat_idle` (reared: head up, the neck sloping down to the body on
  the ground, forelimbs raised, the jaw snapping in steps, swaying between stops), `slither`
  (limbs folded back, a square wave down the spine's z turns, a wavelength along it: two spread
  moves) and
  `attack` (coil back and up, then lunge, the jaw snapping shut on the hit).
- `assets/characters/spider.json`: `idle` (head scanning in settling steps, abdomen ticking),
  `combat_idle` (front legs raised, fangs half open), `walk` and `run` (an alternating tetrapod
  gait: four IK pairs on the closed foot arcs `step` and `stride`, with a bounce and the abdomen and head
  counter-swinging), `attack` (rears up on the hind pairs, then the fangs swing out as the root lunges).
- `assets/characters/tiger.json`: `idle`, `combat_idle` (a low stalk), `walk` (a lateral sequence: a hind
  foot, then the fore foot on its side a quarter cycle later, the waist swaying smoothly), `run` (a trot, diagonal pairs landing together),
  `attack` (crouch and coil, then a pounce: the forelegs hand from IK to FK, the jaw snaps shut on `SETTLE`).
- `assets/characters/eagle.json`: `idle` (perched, head scanning), `combat_idle` (wings half open),
  `walk` (a glide: one beat, then wings held, legs tucked), `run` (a fast flap, `SETTLE` beats with a spread down
  the wing's joints), `attack` (a dive, talons thrown forward, beak snap), `cast` (wings thrown wide and held).
