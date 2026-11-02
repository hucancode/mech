# The mech animation engine

An **animation** is a character's named **clips**; it is the `"animation"` half of a character
file ([modeling.md](modeling.md#character-files)). A clip is a plain list of **key frames**,
which may overlap; each blends its driver values onto what the keys before it give. Animations
only ever set the model's **drivers** ([modeling.md](modeling.md)), so a clip works on any model
that has the drivers it names. The game **mixes** clips: each plays on a **layer**, with its own
time scale and offset, replacing or adding to the layers below.

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
with no clip shows the rest pose (every driver 0). Game code adds its own layers above the
action's (`mech_layers`, with offsets on `mech_now`'s clock). Tools can also play any clip on
the first layer or hold explicit values (`mech_play_clip`, `mech_show_values`).

## The animation

A character file's `"animation"`:

```json
{
  "clips": [
    {
      "name": "attack",
      "duration": 0.9,
      "keys": [
        {"values": {"l_curl": 0.35, "l_elbow": 0.2618, "l_shoulder": 0.0698, "r_curl": 0.35}},
        {"at": 0.04, "duration": 0.14, "values": {"root_y": -0.19908, "pelvis_turn": -0.2094}},
        {"at": 0.27, "duration": 0.08, "ease": "IN", "values": {"pelvis_turn": 0.4363}}
      ]
    }
  ]
}
```

- **clips**: `{name, duration, keys}`.
- **values**: maps driver names to values, in each driver's own units (its drives map them onto
  turns), and the root's channels (`root_x`, `_y`, `_z` in model units, `root_turn_x`, `_y`, `_z`
  in radians: [modeling.md](modeling.md)) to where the whole model is moved and turned. Unlike
  everywhere else in these files, a 0 here is a real value ("move to 0"), so it's written out.

### Key frames

| field | meaning |
| --- | --- |
| `at` | start time, in seconds into the clip |
| `duration` | how long it takes to blend fully in; 0 snaps in at `at` |
| `ease` | `SMOOTH` (default), `LINEAR`, `IN` (accelerates, driving into a hit), `OUT` (decelerates, coasting to a stop) |
| `values` | the drivers it moves, and where to |

Keys apply in time order (by `at`; keys starting together, in file order). A key moves only the
drivers it names and leaves the rest to the keys before it.

## How a clip is sampled

`clip_sample(clips, clip, t, out)` starts from the rest pose (every value 0) and applies each key
in time order:

```
w = ease((t - at) / duration)        (clamped to 0..1; a zero duration is 0 before `at`, 1 after)
skip the key if w <= 0
out[c] += (value[c] - out[c]) * w    for each driver the key names
```

A key keeps holding its values after it finishes (w stays 1), so later keys build on it. The
first key is usually the stance the clip starts from, at time 0.

Typical shapes:
- **A held stance**: one key at 0 (the mech's `idle` and `combat_idle`).
- **A loop**: a starting stance, then one key per quarter period blending to the next stance,
  ending on the starting one (the mech's `walk` and `run`).
- **A strike that chains up the body**: overlapping keys on separate driver groups, each
  starting a little after the one before: feet, then pelvis, chest, arm, fist. Wind-up, drive,
  follow-through, then a recovery key blending back to the stance (the mech's `attack` and
  `cast`).

`clips_build` compiles an `Animation` against a `Model`: names become driver indices and keys
are stable-sorted by time. Names the model lacks are logged and skipped. Rebuild it whenever
either side changes; the editors do so on every edit.

## Mixing clips on layers

A `Layer` is `{clip, blend, weight, speed, offset, loops}`. At mix time `t` its clip is at
`(t - offset) * speed` seconds, wrapped over the clip's duration when it loops, held at its ends
when it doesn't. `mix_sample(clips, layers, t, out, scratch)` starts from the rest pose and lands
each layer, from the first up, by its `weight`:

```
REPLACE:   out = lerp(out, the clip's keys applied on top of out, weight)
ADDITIVE:  out += the clip sampled on the rest pose * weight
```

A REPLACE layer moves only the drivers its clip keys, so a clip of just the arms plays over a
walk and leaves the legs to it. An ADDITIVE layer adds its clip's values, as offsets from the
rest pose, to whatever is below (a recoil, a lean). Mixing is the game's: the character editor
edits one clip at a time.

Cross-fading (in `src/character/mech.odin`): when an action starts, the pose currently shown is
kept, and the new mix is blended over it with a smoothstep across the fade time.

## Style for the mech

The mech moves like a machine, not a person: legs stand straight, there's no idle breathing,
and strikes aren't boxing moves. A strike carries force up a chain, feet → pelvis → shoulder →
arm → fist, each link firing in turn.

## The assets

- `assets/characters/mech.json`: the clips that used to be code (`src/mech_clips.odin`), flattened
  to data, then given IK. Every key that set a stance carries the legs' IK too: both legs reach,
  their poles in front of the knees, and the feet hold the angle the clip gives them (`hold`).
  Their targets are keyed so a standing foot stays put with its sole on the ground, and in the
  walk and run each stance foot moves straight back along the ground at a steady speed while the
  swing foot eases forward and lifts: the feet no longer slide or sink. The attack's left foot
  steps into the lunge and back; its right stays planted. The walk, run, cast and attack also key
  the hands (`l_hand`, `r_hand`, shoulder to palm) where the clip's hands come to rest (the
  swing's ends, the poses they strike), with their poles keyed to bend the elbows as the clip
  does, so each stroke is one eased path; the one-shot clips let go of the hands as they settle
  back to their stance. The keys were generated from the clips' own paths, sampled with the
  engine's rig. (The clips once shared named poses; those were copied into the keys that played
  them, and keys landing together were merged into one, which samples the same.)
- `assets/characters/dragon.json`: just the dragon example's rest pose (jaw 0.21, arms 0.52, elbows 0.79,
  legs -0.44, knees 0.61 radians) as an `idle` clip. The example's motion (riding a spline loop, limbs
  swinging in strokes, the fly-in assembly) is code in that example and still has to be authored
  here. Its spine drivers (`segment_*_pitch/yaw/roll` and so on) are in place for that.
- `assets/characters/strider.json`: every clip a reverse-jointed body needs, authored for it. Both
  legs reach with IK in every key, their poles behind the knees. `walk` and `run` are sampled
  gaits (16 keys a loop, `LINEAR` between them): each foot slides straight back along the ground
  through its stance and swings forward lifting, while the root bobs twice a cycle and the pelvis,
  hull and cannons counter-swing. `attack` is a cannon ram: the left foot steps in, then the
  pelvis, hull, right shoulder and cannon each fire in turn. `cast` is a missile salvo: brace low
  and wide, tip the rack forward, three launches jolt the rack and root, then settle back.
