# The mech modeling engine

`src/mech` builds mechs from data. A **model** (the `"model"` half of a character file) is a
library of rigid **parts**, each a few **primitive shapes** and named **slots**, the faces it is
matched with other parts by, each exposing the **joints** the part moves by when it hangs by that
slot; and an **assembly**: a tree of **instances**, each placing a part by matching one of its
slots with a slot of its parent's part. A **rig** is a model put into a scene: one bone per moving
joint, one scene node per primitive. **Drivers** move the exposed joints, and **IK targets**
reach with them: one number each, which an animation (see [animation.md](animation.md)) sets over
time.

```odin
lib: mech.Library                               // shared meshes and materials, one per app
model, anim, _ := mech.character_load("assets/characters/mech.json")  // or character_parse(text), wasm too
rig, _ := mech.rig_create(&lib, &scene, &renderer, model, parent_node)
values := make([]f32, len(model.drivers))       // one per driver
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
| `src/mech/joints.odin` | joints: the bones and hardware pieces each kind adds, one path for all |
| `src/mech/rig.odin` | building a rig, drives, IK, posing |
| `src/mech/primitives.odin` | the shared mesh and material library |
| `src/mech/json.odin` | the writer that keeps saved files readable |
| `src/mech/mech_test.odin` | round-trips and clip spot checks (`make test`) |
| `src/mech/animation.odin` | animations: see [animation.md](animation.md) |

## Units and frames

- Lengths are in **model units**. `scale` brings the whole model to world size (the mech is
  about 5.5 units tall at scale 0.297).
- Angles are in **radians**, in files and at run time alike; nothing converts them. A driver's
  value is in its own units (a hand's 0 to 1 curl, an angle); each of its drives maps it onto
  radians. IK targets' drivers are model units and a weight. The root's channels (below) are
  model units and radians.
- Characters face **+z**, with **+y** up. The mech's left side is +x.
- Every part has a **frame**: a place on one of the rig's bones. A part's shapes and its slots
  are given in that frame. Its origin is its **default slot**, unnamed: hanging by it, the part's
  origin sits on its last joint's male face with **+y toward the joint**, +x along the face's
  forward (`PART_FACE`), so a part hanging down from its joints grows toward -y. As a parent's
  slot, the origin faces -y (`SLOT_FACE`): a child hangs below it.
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
| `materials` | `{name, color, metallic, roughness, emissive}` |
| `hardware` | the materials joint hardware uses: `{female, male, metal}` |
| `drivers` | the animatable values: `{name, min, max, drives}`; min/max only bound editor sliders (a missing bound is 0; neither is a half turn each way) |
| `iks` | IK targets: `{name, root, tip, hold}` |
| `parts` | the library: `{name, joints, slots, shapes}` |
| `assembly` | the tree placing parts: `{name, part, slot, parent, parent_slot, mirror}`, parents first |

The loader fills omitted fields with zero, and the writer leaves zero fields out. So a shape
without `"primitive"` is a `BOX`, and one without `"rotation"` is unrotated.

### Parts and the assembly

```json
"parts": [
  {
    "name": "shin",
    "joints": [{"name": "knee", "kind": "HINGE", "size": 0.29, "jaw": 0.51724, "lug_t": 0.24138, "lug_d": 1.03448, "shank": 0.41379, "flange_t": 0.55172, "pin_r": 0.2069, "clr": 0.10345, "tang": true}],
    "slots": [{"name": "ankle", "position": [0, -0.56, 0], "normal": [0, -1, 0], "forward": [1, 0, 0]}],
    "shapes": [{"primitive": "CYLINDER", "material": "shell", "position": [0, -0.28026, 0], "size": [0.31559, 0.64051, 0.31559]}]
  }
],
"assembly": [
  {"name": "l_shin", "part": "shin", "parent": "l_thigh", "parent_slot": "knee"},
  {"name": "r_shin", "part": "shin", "parent": "r_thigh", "parent_slot": "knee", "mirror": true}
]
```

A **part** is a rigid piece, placed as often as the assembly likes:
- **slots**: named faces in the part's frame, facing out of it, where it is matched with other
  parts. Each may carry **joints**: what the part moves by when it hangs by that slot.
- **joints**: the joints of its default slot, its origin. A part that always hangs by its origin
  (most do) keeps its joints here and names no slot for it.
- **shapes**: its primitives.

A slot's joints (and the part's own) are a **stack**, listed from the parent's side: each
joint is `{name, kind, twist, bend, ..}` with its parameters inline (Joints, below), bolted onto
the one before it (the first onto the slot it is matched with), its socket first turned `twist`
radians about the socket's normal. The names are unique in the part: drivers move a joint by its
name. No joints bolts the part on rigid. Joints belong to the part, so every instance of it
shares them: there is no separate joint library, the part is what is reused. The mech's
shoulder is one stack on its `arm` part: `disc` (a spin), `shoulder` (a hinge bent 90°),
`twist` (a spin); its wrist is `wrist`, `cross` (a hinge twisted 90°), `twist`.

An **instance** places a part in the tree by matching two slots. Its **name**, which drivers and
children refer to it by, is its part's when left empty (name them when a part is placed twice).
- **parent**: the instance it hangs from; instances come after their parent. One with no parent
  is a **root**, matched with the model origin.
- **slot**: the slot of its own part it hangs by, bringing that slot's joints; empty is the
  part's origin, with the part's own joints.
- **parent_slot**: the slot of the parent's part it is matched with; empty is the parent's origin.
  The first joint's female half bolts onto it, and the instance's slot onto the last joint's male
  half.
- **mirror**: the other side of the body. The part shows reflected, so one part serves both
  sides (below).

**Mirroring.** A mirrored instance's joints bolt onto its parent's slot reflected, which reflects
each joint across its female face's forward, carried through its bones; each next joint, and the
part's slot, sits on the reflected one the same way. `mech.joint_mirror` works out the matching
reflection: the part's shapes and slots show through it (so its children follow), and a drive on
an axis the reflection turns over goes the other way (a turn about any axis but the
reflection's). So an instance mirrored from its twin, under a parent whose slot
is reflected across the body, is the exact mirror image, drives and all, with the same numbers.
Shapes are reflected across a plane of their own that the primitive is symmetric about, so none
needs a negative scale: their x, but for a quarter cylinder (its arc runs from +x to +z) the
plane between x and z. So you model the left side only: the right side is the same parts,
mirrored, and the Model tab can preview a part that way.

### Shapes

`{primitive, param, material, span, position, rotation, size}`: a primitive centred at
`position` in the part's frame, turned by `rotation`, with `size` its full extent on each axis.
For round shapes, x and z are the diameter and y is the height (along the shape's own y).

**Links.** A limb part is a link: its length is the distance between its joints, and its body
follows. A shape that `span`s two of its part's slots (`""` is the origin) sits in the span's
frame instead of the part's (`mech.span_frame`): centred between the two, +y from the first to the
second, +x as near the part's +x as that allows. Its y extent is the distance between them plus
`size.y`, so `size.y` is how far it runs past the ends. Moving a slot lengthens every shape
spanning it, so a limb's length lives in one place. Unspanned (origin to origin), the frame is
the part's and the distance 0, so the same rule covers every shape.

```json
{"primitive": "CYLINDER", "span": ["foot", ""], "position": [0, 0.00999, 0], "size": [0.31559, 0.06, 0.31559]}
```

The mech's shin body runs from its `foot` slot up to its origin, 0.06 longer than the span.

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

A joint is one mechanism: the hardware to build, where its bone pivots, how it rests, and the
axes it has. Drivers and IK move it about (along) those axes only:

| kind | axes | hardware | pivot |
| --- | --- | --- | --- |
| `SPIN` | turns about y (the socket's normal) | a turntable: two discs | where the discs meet |
| `HINGE` | turns about x | forked female lugs with a pin; a male lug (solid if `tang`) | a reach from the socket |
| `BALL` | turns about x, y, z | a socket on a flange, a ball on a stud | inside the ball |

`bend` turns the bone at rest about its first axis (radians): the mech's shoulders and hips are
hinges bent 90°, so the limb hangs down from a slot facing sideways.

`min` and `max` are a joint's **stops**: its range on each axis it has, from its rest (after
`bend`), in radians. The rig holds every drive and IK inside them, as
a real joint's stops do, so IK can't bend a knee backwards. An axis whose ends are equal (both
omitted) is free. A mirrored instance's range turns over with its drives. The mech's knee might
be `"min": [-2.6, 0, 0], "max": [0.05, 0, 0]`.

`size` scales the hardware: every length below is a **proportion** at size 1, multiplied by
`size` when the joint is built (`mech.joint_scaled`), so one number resizes a joint and joints
that look alike share their proportions. At the defaults the size is about a hinge's width
across its lugs, or a ball's diameter. Size 0 (omitted) builds no hardware and has no reach: the
mech's discs and twists are bare SPINs pivoting on their slots.

Hinge fields: `jaw` (the gap between the female lugs), `lug_t`/`lug_d` (lug thickness and
diameter), `shank` (the lug's straight length), `flange_t` (base plate), `pin_r`, `clr`
(clearance), `pin_out` (how far the pin sticks out), `tang` (solid male lug) and
`disc_f`/`disc_m` (round female or male base plates). A hinge's **reach**, the distance from the
slot to the pivot, is `shank + flange_t`. Hardware with no volume is not built, so a hinge with
no `lug_t`, `lug_d`, `shank` or `flange_t` is a bare pin pivoting on the slot itself: the mech's
knuckles. (These are all proportions: the reach in model units is `size · (shank + flange_t)`.)

Ball fields: `ball_r`, `socket_t`, `stud_len`, `flange_w`, `flange_t`.

Spin fields: `flange_w` (the discs' diameter), `flange_t` (both discs; they meet on the pivot,
which sits `flange_t / 2` out from the slot).

Joint hardware is built from the same primitives as shapes and painted in the model's `hardware`
materials. It belongs to no shape, so the editor doesn't list it.

### Rigging: drivers, IK targets

A **driver** is one animatable number, `{name, min, max, drives}`: what clips key
(keys and timing: [animation.md](animation.md)). min and max bound the editor's sliders. Each
**drive** moves one exposed joint:

```json
{"name": "l_curl", "max": 1, "drives": [
  {"part": "l_thumb_1", "joint": "knuckle", "axis": "X", "from": [0, 0.5], "to": [0, -0.5236], "clamp": true},
  {"part": "l_thumb_2", "joint": "knuckle", "axis": "X", "from": [0.2, 0.8], "to": [0, 0.7854], "clamp": true}
]}
```

- **part**, **joint**: an instance and a joint it exposes (of the slot it hangs by). A driver can
  move no other joint.
- **axis**: `X`, `Y` or `Z`, one the joint has (table above), which it turns about.
- **from**, **to**: the driver's value running over `from` maps linearly onto `to` (radians),
  clamped to the ends when `clamp`. `from [0, 1], to [0, s]` is `s` times
  the value.

Drives on one axis add up, and one driver may move any number of joints: the mech's `curl` closes
nine knuckles at staggered rates, and `pelvis_turn` turns the pelvis and twists both legs back
(so the feet keep pointing ahead).

**The root.** No joint moves the whole model: after its drivers, every pose carries six more
values, the root's **channels** (`mech.ROOT_CHANNELS`): `root_x`, `root_y`, `root_z` move the
model's origin (model units) and `root_turn_x`, `_y`, `_z` turn it (euler radians, as shapes
are). Clips key them by name like drivers: the mech's walk drops it with `root_y`, and IK targets,
being in the model's space, keep the feet planted while it does. They're named like an IK
target's drivers so editors show each three as one.

An **IK target** (`iks`) reaches instance `tip`'s frame for a point by turning every joint from
instance `root`'s slot down to the tip, each about the axes it turns. The tip's own joints (an
ankle, a wrist) don't reach: they keep the turn their drivers give. With `"hold": true` they turn
the tip to face the way its drivers turned it in the model's space instead, so a planted foot
stays as the clip angles it to the ground however the knee bends (the mech's legs hold; its hands
don't). It reads four drivers named
after it: `<name>_x`, `_y`, `_z`, the point in the model's space (model units, ground lift
included), and `<name>_weight`, from 0 (the chain as its drivers put it) to 1 (reaching). The
solver is cyclic coordinate descent, 16 passes, tip first, each joint held in its range; the
result is blended with the driven motion by the weight. The mech's `l_leg` and `r_leg` reach each
foot from its thigh.

A target may have a **pole**: three more drivers, `<name>_pole_x`, `_y`, `_z`, a point in the
model's space that the chain bends toward. Each pass first swings the chain's middle joint (the
pivot nearest halfway along it: a knee, an elbow) around the line from the chain's root to the
target, toward the pole, with the joints above it; then the tip reaches as before. So the chain
bends in the plane through the pole, and a knee points at it instead of flipping. A chain about
straight (its middle within 5% of the reach off the line) has no plane to turn, so a pole acts
once the chain bends. Without the three drivers a
target has no pole.

## How a rig is built and posed

`rig_create` walks the assembly in order:

1. **Root**: an anchor bone at the origin, at rest, stands in for the parent; then as a child.
2. **Child**: the first joint of the stack its slot exposes is seated onto the parent's slot
   (reflected when the parent is mirrored), each next joint onto the one before. A joint's female
   hardware goes on the bone before it; a moving joint gets a bone at its pivot, turned by
   `bend`, which its male hardware rides. The instance's slot is seated onto the last joint's male
   face, which places the instance's frame.
3. **Shapes**: one scene node each, under the last bone, carrying the shape's place and scale
   (reflected when the instance is mirrored).

Bones are flat children of the rig's `frame` node, which the model's `scale` scales. Pieces are
children of their bone, so posing writes **one transform per bone and none per piece**. The mech
has 48 bones (one per moving joint, and the root's anchor) and 212 pieces.

After building, the rig finds each IK target's chain and, when `ground` is set, the lowest corner
of any piece at rest.

`rig_pose(values)` then:
1. adds up each bone's motion from the drives
2. solves each bone from its parent (a root's anchor from the root's channels): `parent ∘ offset ∘
   rest ∘ Rx·Ry·Rz`
3. reaches with each IK target whose weight is above 0, and solves again
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
    "parts": [{"name": "body", "shapes": [{"material": "paint", "size": [1, 1, 1]}]}],
    "assembly": [{"name": "body", "part": "body"}]
  },
  "animation": {"clips": []}
}
```

`character_parse` / `character_format` read and write the text (`src/mech/character.odin`);
`character_load` / `character_save` do files natively. In memory the halves stay a `Model` and an
`Animation`. The character editor's **New** makes a file like the one above.

## The assets

- `assets/characters/mech.json`: the humanoid mech, exported once from the code that used to build it
  (`src/mech_kit.odin`, seed 7). Same proportions and motion. Its right limbs place the left
  limbs' parts mirrored, and the thumb and fingers share their three segment parts
  (`finger_1`..`finger_3`). A slot is named after what is matched on it, or `next` along a chain.
- `assets/characters/dragon.json`: mjolnir's dragon example (`examples/creative/dragon`), ported. The
  spine is a chain of ball joints (instances `segment_*`, `taper_*`, `tail`, each with
  pitch/yaw/roll drivers) placing a few shared parts (`segment`, `segment_limbs` with the limbs'
  slots, `taper`), the right limbs mirror the left limbs' parts, the limbs are disc-hinge-twist stacks plus elbow/knee hinges, and the jaw is a
  centred hinge. Its joint hardware uses this engine's kit, so the lugs and sockets look a little
  different from the example's. Piece colours keep the example's palette hashing, with a fixed
  seed.

## Not supported yet

- **Seeded variation.** The old code-built mech took a seed that varied its proportions and
  colours. A model file is one fixed mech. Variation would need parameters in the file, with
  shapes sized from them.
- Free (unconstrained) bones, which the dragon example used to steer its spine along a spline.
  Its spine is ball joints here, waiting for the dragon's motion to be authored in this engine.
- Renaming a driver in the character editor updates the open animation, but not other
  character files that use the old name.
