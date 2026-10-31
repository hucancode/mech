# The mech animation engine

An **animation** is a character's named **clips** and the named **poses** they share; it is the
`"animation"` half of a character file ([modeling.md](modeling.md#character-files)). A clip is a
series of **key frames** that may overlap. Each key frame blends a pose, its own channel values,
or both, onto what the keys below it give. Animations only ever set
the model's **channels** ([modeling.md](modeling.md)), so a clip works on any model that has the
channels it names.

```odin
model, anim, _ := mech.character_load("assets/characters/mech.json")  // or character_parse(text)
clips := mech.clips_build(anim, model)         // compile against the model; rebuild on edits
clip := mech.clips_find(&clips, "attack")
values := make([]f32, len(model.channels))
mech.clip_sample(&clips, clip, t, values)      // the pose at t seconds
mech.rig_pose(&scene, rig, values)
```

The `Mech` character (`src/character/mech.odin`) maps each `Action` to a clip by name
(`ACTION_CLIPS`: `idle`, `walk`, `run`, `attack`, `cast`, `combat_idle`). It loops or plays once
following `action_loops`, and cross-fades between clips. An action with no clip shows the rest
pose (every channel 0). Tools can also play any clip, hold a pose, or hold explicit values
(`mech_play_clip`, `mech_show_pose`, `mech_show_values`).

## The animation

A character file's `"animation"`:

```json
{
  "poses": [
    {"name": "ready", "values": {"l_curl": 0.35, "l_elbow": 0.2618, "l_shoulder": 0.0698, "r_curl": 0.35}}
  ],
  "clips": [
    {
      "name": "attack",
      "duration": 0.9,
      "keys": [
        {"pose": "ready"},
        {"at": 0.04, "duration": 0.14, "priority": 1, "values": {"hip_level": -0.6, "pelvis_turn": -0.2094}},
        {"at": 0.27, "duration": 0.08, "ease": "IN", "priority": 2, "values": {"pelvis_turn": 0.4363}},
        {"at": 0.56, "duration": 0.34, "priority": 4, "pose": "ready"}
      ]
    }
  ]
}
```

- **poses**: `{name, values}`. A pose is a named set of channel values: any subset of the rig's
  channels. A key frame that names it moves those channels and leaves the rest to the keys below,
  so a pose for the arms and one for the stance can play together. To reset a channel, a pose
  names it with 0.
- **clips**: `{name, duration, keys}`.
- **values**: maps channel names to values, used as they are (radians for angles). Unlike
  everywhere else in these files, a 0 here is a real value ("move to 0"), so it's written out.

### Key frames

| field | meaning |
| --- | --- |
| `at` | start time, in seconds into the clip |
| `duration` | how long it takes to blend fully in; 0 snaps in at `at` |
| `ease` | `SMOOTH` (default), `LINEAR`, `IN` (accelerates, driving into a hit), `OUT` (decelerates, coasting to a stop) |
| `blend` | `REPLACE` (default) moves the channels toward its values; `ADDITIVE` adds its values on top |
| `priority` | keys apply from the lowest priority up; equal priorities apply in file order |
| `pose` | a pose name: the channels the pose sets |
| `values` | the key's own channels, applied after the pose |

A key frame doesn't have to name a pose: most keys carry just their own values. When a set of
values is worth reusing, the character editor can **promote** a key to a pose (its channels,
merged over the pose it named, become a new pose that the key then plays).

## How a clip is sampled

`clip_sample(clips, clip, t, out)` starts from the zero pose and applies each key in priority
order:

```
w = ease((t - at) / duration)        (clamped to 0..1; a zero duration is 0 before `at`, 1 after)
skip the key if w <= 0
REPLACE:  out[c] += (value[c] - out[c]) * w      for each channel the key touches: its pose's, then its own
ADDITIVE: out[c] += value[c] * w
```

A key keeps holding its target after it finishes (w stays 1), so later, higher keys build on
it. The lowest key is usually a pose at time 0, the stance the clip starts from.

Typical shapes:
- **A held stance**: one key, `{"pose": "ready"}` (the mech's `idle` and `combat_idle`).
- **A loop**: a base pose, then one key per quarter period blending to the next pose, each a
  priority above the one before, ending on the starting pose (the mech's `walk` and `run`, with
  poses `walk_pass_l`, `walk_step_l`, `walk_pass_r`, `walk_step_r`).
- **A strike that chains up the body**: overlapping keys on separate channel groups, each
  starting a little after the one below: feet, then pelvis, chest, arm, fist. Wind-up keys at one
  priority, the drive at the next, then follow-through, then a recovery key blending back to the
  stance (the mech's `attack` and `cast`).

`clips_build` compiles an `Animation` against a `Model`: names become channel indices and keys
are stable-sorted by priority. Names the model lacks are logged and skipped. Rebuild it whenever either side changes; the editors do so on every edit.

Cross-fading (in `src/character/mech.odin`): on `character_play`, the pose currently shown is kept,
and the new clip's pose is blended over it with a smoothstep across the fade time.

## Style for the mech

The mech moves like a machine, not a person: legs stand straight, there's no idle breathing,
and strikes aren't boxing moves. A strike carries force up a chain, feet → pelvis → shoulder →
arm → fist, each link firing in turn.

## The assets

- `assets/characters/mech.json`: the clips that used to be code (`src/mech_clips.odin`), flattened
  to data. Sampled every 10 ms against the old code, they match to within 1.2e-7 radians. When
  poses stopped zeroing the channels they leave out, the poses gained explicit zeros where a clip
  relied on that; every clip samples exactly as before.
- `assets/characters/dragon.json`: just the dragon example's rest pose (jaw 0.21, arms 0.52, elbows 0.79,
  legs -0.44, knees 0.61 radians) as an `idle` clip. The example's motion (riding a spline loop, limbs
  swinging in strokes, the fly-in assembly) is code in that example and still has to be authored
  here. Its spine channels (`segment_*_pitch/yaw/roll` and so on) are in place for that.
