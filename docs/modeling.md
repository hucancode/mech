# The mech modeling engine

`src/mech` builds mechs from data. A **model** (the `"model"` half of a character file) is a tree
of rigid **parts**
bolted together by **joints**. Each part is a few **primitive shapes**. A **rig** is a model put
into a scene: one bone per degree of freedom, one scene node per primitive. **Channels** drive
the bones: one number each, and an animation (see [animation.md](animation.md)) sets them over
time.

```odin
lib: mech.Library                               // shared meshes and materials, one per app
model, anim, _ := mech.character_load("assets/characters/mech.json")  // or character_parse(text), wasm too
rig, _ := mech.rig_create(&lib, &scene, &renderer, model, parent_node)
values := make([]f32, len(model.channels))      // one per channel, used as they are
mech.rig_pose(&scene, rig, values)              // every frame
mech.rig_destroy(rig, &scene)
mech.model_destroy(model)                       // after every rig using it
mech.library_destroy(&lib, &renderer)
```

The `character` package (`src/character/mech.odin`) wraps this: a `MechAsset` holds a model, its
animation and the compiled clips, and `mech_create` returns a `Character`. The game and the
character editor's viewer both use it ([architecture.md](architecture.md)). The character editor
edits models ([editors.md](editors.md)).

## Files

| file | holds |
| --- | --- |
| `src/mech/character.odin` | character files: one model and its animation |
| `src/mech/model.odin` | the model format, parse/format, name lookups, euler angles |
| `src/mech/files.odin` | loading and saving character files (not on wasm) |
| `src/mech/joints.odin` | joint hardware: the pieces and bones each joint kind adds |
| `src/mech/rig.odin` | building a rig, drivers, leg IK, posing |
| `src/mech/primitives.odin` | the shared mesh and material library |
| `src/mech/json.odin` | the writer that keeps saved files readable |
| `src/mech/mech_test.odin` | round-trips and clip spot checks (`make test`) |
| `src/mech/animation.odin` | animations: see [animation.md](animation.md) |

## Units and frames

- Lengths are in **model units**. `scale` brings the whole model to world size (the mech is
  about 5.5 units tall at scale 0.297).
- Angles are in **radians**, in files and at run time alike; nothing converts them. A channel's
  value is used as it is: radians when it turns a joint, any number when it feeds a driver or the
  pelvis level (a hand's 0 to 1 curl, the level's -1 to 0).
- Characters face **+z**, with **+y** up. The mech's left side is +x.
- Every part has a **frame**: a place on one of the rig's bones. A part's shapes, its sockets for
  children, and its own mount face are all given in that frame.
- Rotations in files are **euler angles in radians**, `[x, y, z]`, applied as
  `R = Rx * Ry * Rz` (`mech.euler`, inverted by `mech.euler_from`).
- A **face** (`{position, normal, forward}`) is a point with a direction out of the surface and
  one along it. Two faces are bolted by putting the points together with the normals facing
  each other and the forwards aligned (`geometry.seat`).

## The model file

Top level:

| field | meaning |
| --- | --- |
| `name` | the model's name; animations refer to it |
| `scale` | model units → world units |
| `ground` | lift the model so its lowest point at rest sits at y = 0 |
| `level` | an optional channel that lowers the pelvis (-1 to 0); the legs' IK keeps the feet down |
| `materials` | `{name, color, metallic, roughness, emissive}` |
| `hardware` | the materials joint hardware uses: `{female, male, metal}` |
| `joints` | reusable joint specs, by name |
| `channels` | `{name, min, max}`; min/max only bound editor sliders (a missing bound is 0; neither is a half turn each way) |
| `drivers` | channels set from other channels |
| `legs` | `{hip, knee, ankle}` channel names for two-link leg IK |
| `parts` | the part tree, parents first |

The loader fills omitted fields with zero, and the writer leaves zero fields out. So a shape
without `"primitive"` is a `BOX`, and one without `"rotation"` is unrotated.

### Parts

```json
{
  "name": "l_forearm",
  "parent": "l_arm",
  "socket": {"position": [0, -0.2, 0], "normal": [0, -1, 0], "forward": [1, 0, 0]},
  "joint": "elbow",
  "binds": [{"channel": "l_elbow", "sign": 1}, {"channel": "l_fore_twist", "sign": -1}, {}],
  "mount": {"normal": [0, 1, 0], "forward": [1, 0, 0]},
  "shapes": [{"material": "shell", "position": [0, -0.1, 0], "size": [0.26, 0.2, 0.23]}]
}
```

- **parent**: the part this one hangs from. A part with no parent is a **root** and sits at the
  model origin. A root whose joint is a `SPIN` turns about y by its first bind (the mech's
  pelvis). Parts must come after their parent in the list.
- **socket**: a face in the parent's frame. The joint's female half bolts onto it.
- **joint**: the name of a joint spec. Empty means `FIXED`: the part bolts straight onto the
  socket with no hardware and no motion.
- **mount**: a face in this part's own frame. It bolts onto the joint's male half, which sets
  where the part's frame ends up.
- **centered**: put the joint's pivot on the socket itself, not a joint's reach away. Used for a
  jaw hinged inside a head.
- **binds**: one per degree of freedom, in the joint's order (table below). Each names a channel
  and a `sign`. Use -1 to mirror a channel so it reads the same on both sides of the body. An
  empty bind leaves that axis still.
- **shapes**: the part's primitives.

### Shapes

`{primitive, param, material, position, rotation, size}`: a primitive centred at `position` in
the part's frame, turned by `rotation`, with `size` its full extent on each axis. For round
shapes, x and z are the diameter and y is the height (along the shape's own y).

| primitive | param |
| --- | --- |
| `BOX` | - |
| `WEDGE` | a box whose top slopes down toward +z; `param` is how far the front top edge drops (0 = box, 1 = full wedge) |
| `CYLINDER` | - |
| `HALF_CYLINDER` | - (a 180° arc; turn it with `rotation`) |
| `QUARTER_CYLINDER` | - (a 90° arc) |
| `CONE` | top radius / bottom radius (0 = point, 1 = cylinder), apex up |
| `SPHERE` | - |

These seven are the whole vocabulary. Nothing in a model is a custom mesh: see
[rendering.md](rendering.md) for why that matters.

### Joints

A joint spec says what hardware to build and which degrees of freedom it has. Each degree of
freedom is one bone turning about one axis of its own frame:

| kind | degrees of freedom (bind order) | hardware |
| --- | --- | --- |
| `FIXED` | none | none |
| `SPIN` | y | none |
| `HINGE` | x | forked female lugs with a pin; a male lug (solid if `tang`) |
| `HINGE_TWIST` | x, then y (a twist along the child) | a hinge |
| `PIN` | x | a bare pin (knuckles) |
| `DISC_HINGE` | y (the disc turning), x (the hinge), y (a twist) | a disc on a round base, then a hinge |
| `WRIST` | x, x turned 90° below it, then y | two crossed hinges |
| `BALL` | x, y, z | a socket on a flange, a ball on a stud |

Hinge-type fields: `jaw` (the gap between the female lugs), `lug_t`/`lug_d` (lug thickness and
diameter), `shank` (the lug's straight length), `flange_t` (base plate), `pin_r`, `clr`
(clearance), `pin_out` (how far the pin sticks out), `tang` (solid male lug), and
`disc_f`/`disc_m` (round female or male base plates). A hinge's **reach**, the distance from the
socket to the pivot, is `shank + flange_t`.

Ball fields: `ball_r`, `socket_t`, `stud_len`, `flange_w`, `flange_t`.

Joint hardware is built from the same primitives as shapes and painted in the model's `hardware`
materials. It belongs to no shape, so the editor doesn't list it.

### Channels, drivers and legs

A **channel** is one number. Animations set channels, and the rig turns them into bone angles.

A **driver** sets one channel from another on every pose: `source` running over `from` maps
linearly onto `to`, clamped to the ends when `clamp` is set. Values are in each channel's units.
The mech uses drivers to:
- close its three knuckles from one 0 to 1 `curl` channel (three clamped drivers per hand)
- twist each leg back against `pelvis_turn` (an unclamped `{0, 90} → {0, -90}`), so the feet
  keep pointing ahead

Driven channels are hidden from pose sliders: anything an animation writes to them is
overwritten.

A **leg** names the hip, knee and ankle swing channels of a two-link leg. On every pose the rig:
1. lowers the pelvis by the `level` channel (-1 drops it as far as a 60° knee bend would)
2. solves two-link IK so the ankle never sinks below its rest height
3. sets the ankle to `-(hip + knee)` while the foot is down, keeping it level

This assumes the leg hangs straight down at rest, swings in the model's y-z plane, and that a
positive hip angle swings the foot toward +z. The mech binds its sides with mirrored signs to
make that hold.

## How a rig is built and posed

`rig_create` walks the parts in order:

1. **Root**: one bone at the origin, at rest. It turns about y if the root's joint is `SPIN`.
2. **Child**: the joint's female mount face is seated onto the socket (in the parent's frame).
   The female hardware goes on the parent's bone. One bone per degree of freedom is added, each
   a child of the previous, and the male hardware rides them. The part's frame is the last bone,
   with the joint's male face seated onto the part's `mount`.
3. **Shapes**: one scene node each, under the bone, carrying the shape's place and scale.

Bones are flat children of the rig's `frame` node, which the model's `scale` scales. Pieces are
children of their bone, so posing writes **one transform per bone and none per piece**. The mech
has 51 bones and 210 pieces.

After building, the rig measures the legs at rest and, when `ground` is set, the lowest corner
of any piece.

`rig_pose(values)` then:
1. runs the drivers
2. applies the level drop and leg IK
3. solves each bone from its parent: `parent ∘ offset ∘ rest ∘ rotate(sign · value, axis)`
4. writes the bone transforms

`rig_solve` does steps 1 to 3 without touching the scene, so tools can ask where things would
be at another time (the viewer's queries). `rig_piece`, `rig_frame` and `rig_bounds` read back
where things ended up, for gizmos and camera framing.

## Character files

One file is one character: `assets/characters/<name>.json`, holding its model and its animation
([animation.md](animation.md)):

```json
{
  "model": {
    "name": "box",
    "scale": 0.5,
    "ground": true,
    "materials": [{"name": "paint", "color": [0.8, 0.3, 0.2], "roughness": 0.5}],
    "hardware": {"female": "paint", "male": "paint", "metal": "paint"},
    "parts": [{"name": "body", "shapes": [{"material": "paint", "size": [1, 1, 1]}]}]
  },
  "animation": {"poses": [], "clips": []}
}
```

`character_parse` / `character_format` read and write the text (`src/mech/character.odin`);
`character_load` / `character_save` do files natively. In memory the halves stay a `Model` and an
`Animation`. The character editor's **New** makes a file like the one above.

## The assets

- `assets/characters/mech.json`: the humanoid mech, exported once from the code that used to build it
  (`src/mech_kit.odin`, seed 7). Same parts, joints, channels and proportions.
- `assets/characters/dragon.json`: mjolnir's dragon example (`examples/creative/dragon`), ported. The
  spine is a chain of ball joints (`segment_*`, `taper_*`, `tail`, each with
  pitch/yaw/roll channels), the limbs are disc hinges plus elbow/knee hinges, and the jaw is a
  centred hinge. Its joint hardware uses this engine's kit, so the lugs and sockets look a little
  different from the example's. Piece colours keep the example's palette hashing, with a fixed
  seed.

## Not supported yet

- **Seeded variation.** The old code-built mech took a seed that varied its proportions and
  colours. A model file is one fixed mech. Variation would need parameters in the file, with
  shapes sized from them.
- Free (unconstrained) bones, which the dragon example used to steer its spine along a spline.
  Its spine is ball joints here, waiting for the dragon's motion to be authored in this engine.
- Renaming a channel in the character editor updates the model and the open animation, but not
  other animation files that use the old name.
