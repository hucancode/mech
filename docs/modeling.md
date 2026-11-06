# The mech modeling engine

`src/mech` builds mechs from data. A **model** (the `"model"` half of a character file) is a
library of rigid **parts**, each a few **primitive shapes**, a **length**, named **slots** (the
faces its branches are matched on) and the **joints** the part moves by; and an **assembly**: a tree of
**instances**, each hanging a part by its joints from a slot of its parent's part. A **rig** is a
model put into a scene: one bone per joint, one scene node per primitive. A mech is
**rigid**: things turn and slide, nothing scales or bends. What moves is a **channel**, one of
four motions: a **hinge** (a 1D turn: a pin, a turntable, an IK target's swivel), a **slide** (a
linear actuator), a **ball** (a 3D turn: a ball joint, the root's turn) or a **position** (an IK
target, the root's place), plus each IK target's **weight**. An animation
(see [animation.md](animation.md)) sets them over time.

```odin
lib: mech.Library                               // shared meshes and materials, one per app
model, anim, _ := mech.character_load("assets/characters/mech.json")  // or character_parse(text), wasm too
rig, _ := mech.rig_create(&lib, &scene, &renderer, model, parent_node)
values := make([]f32, mech.model_channels(model))  // every channel's values (model_channel_table)
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
| `src/mech/model.odin` | the model format, parse/format, name lookups, places (both sides of the body), euler angles |
| `src/mech/check.odin` | `character_check`: everything wrong with a character, in one place |
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
- Angles are in **radians**, in files and at run time alike; nothing converts them. A joint's
  turns and rotations are radians, a linear actuator's slide model units. An IK target's
  position is model units, its swivel radians, its weight 0 to 1. The root's channels (below) are
  model units and radians.
- Characters face **+z**, with **+y** up. The mech's left side is +x.
- Every part has a **frame**: a place on one of the rig's bones. A part's shapes and its slots
  are given in that frame. The part hangs `length` above its origin (`mech.part_face`): there it
  sits on its last joint's male face with **+y toward the joint**, +x along the face's forward
  (`PART_FACE`, raised by the length), so a part hanging down from its joints grows toward -y.
  Its origin is its **default slot**, unnamed, facing -y (`SLOT_FACE`): a link's far end, where
  the next link of a chain hangs, with no slot to name. With no length the part hangs by its
  origin.
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
| `iks` | IK targets: `{name, tip, aim}` |
| `pose` | the rest pose clips start from: `{channel: value}`, symmetric ([below](#the-rest-pose)) |
| `parts` | the library: `{name, length, joints, slots, shapes}` |
| `assembly` | the tree placing parts: `{name, part, parent, parent_slot, joints}`, parents first |

The loader fills omitted fields with zero, and the writer leaves zero fields out. So a shape
without `"primitive"` is a `BOX`, and one without `"rotation"` is unrotated.

### Parts and the assembly

```json
"parts": [
  {
    "name": "shin",
    "length": 0.58051,
    "joints": [{"name": "knee", "size": 0.29, "reach": 0.96551, "min": [-2.61799, 0, 0], "max": [0.05, 0, 0]}],
    "shapes": [{"primitive": "CYLINDER", "material": "shell", "stretch": true, "position": [0, 0.01, 0], "size": [0.31559, 0.06, 0.31559]}]
  }
],
"assembly": [
  {"name": "thigh", "part": "thigh", "parent": "pelvis", "parent_slot": "thigh"},
  {"name": "shin", "part": "shin", "parent": "thigh", "joints": [{"name": "knee", "twist": -1.5707963}]},
  {"name": "foot", "part": "foot", "parent": "shin"}
]
```

A **part** is a rigid piece, placed as often as the assembly likes:
- **length**: how far above its origin it hangs. Model a link with its origin at its far end, so
  the next link hangs on the origin (the shin's foot) and its length lives in one number.
- **slots**: named faces in the part's frame, facing out of it, where its branches are matched
  (the torso's arms, the palm's fingers); a chain needs none. A slot can `mirror` (below).
- **joints**: what the part moves by, from its parent's slot to where it hangs.
- **shapes**: its primitives.

A part's joints are a **stack**, listed from the parent's side: each joint is
`{name, kind, ..}` with its parameters inline (Joints, below), bolted onto the one
before it (the first onto the parent's slot). The names are unique in the part: channels name a
joint by them. No joints bolts the part on rigid. Joints belong to the part, so
every instance of it shares them: there is no separate joint library, the part is what is reused.
A part's joints are **straight**: how they are mounted (turned on their sockets) is each
instance's (`joints`, below), and how they stand at rest is the rest pose's
([below](#the-rest-pose)), so modelling a part never sets a stance. Most parts need one joint:
the mech's shoulder is its `arm` part's stack `shoulder_top` (a turntable turning it on its socket),
`shoulder` (a pin the rest pose turns 80°, the arm hanging down) and `shoulder_bottom` (twisting
the arm after the pin) (Joints, below). Its wrist is a stack: `wrist`, then `cross`, a pin its
instances twist 90° across the first, then `cross_bottom`, a turntable twisting the hand.

An **instance** places a part in the tree, hanging it from a slot of its parent's. Its **name**, which channels and
children refer to it by, is its part's when left empty (name them when a part is placed twice).
- **parent**: the instance it hangs from; instances come after their parent. One with no parent
  is a **root**, matched with the model origin.
- **parent_slot**: the slot of the parent's part it is matched with; empty is the parent's origin,
  the next link of a chain. The first joint's female half bolts onto it, and the part (`length`
  above its origin) onto the last joint's male half. A part hangs one way only: to hang one the
  other way, make it its own part. The origin faces -y with +x forward; a link turned on it (a
  knee's pin across the hip's) twists its first joint (`joints`, below).
- **joints**: how this instance mounts its part's joints, `[{name, twist}]` by joint name
  (radians; one it leaves out sits as the part has it). `twist` turns the joint's socket about
  its normal: a knee's pin across the hip's, a wrist's second hinge across the first, the
  strider's `hip_top` turned 0.55 rad so its leg starts back. That is all an instance says about a
  joint: how it stands at rest is the rest pose's.

```json
{"name": "arm", "part": "arm", "parent": "torso", "parent_slot": "arm"}
```

**Mirroring.** A part is modelled one side only. A shape or a slot can `mirror`: a plane of the
part's frame (`X`, `Y` or `Z`: where that axis is 0; omitted, none).

- A **mirrored shape** is drawn twice: as written, and reflected across the plane
  (`mech.mirror_shape`). Each copy is reflected again across a plane of its own that the
  primitive is symmetric about, so none needs a negative scale: its x, but for a quarter cylinder
  (its arc runs from +x to +z) the plane between x and z. Both copies are the one shape.
- A **mirrored slot** is two slots: as written, and reflected. What hangs from it, and everything
  below that, is **placed on both sides of the body** (`mech.model_places`): a `Place` is an
  instance on a side, `NONE` (placed once), `L` (as written) or `R` (reflected). A sided place is
  named with its side, `l_<name>` and `r_<name>` (`mech.place_name`), and so are its channels. So
  the mech's torso has one `arm` slot (mirrored across its z) and one `arm` instance, placed as
  `l_arm` and `r_arm`; channels and clips name `l_arm.shoulder` and `r_arm.shoulder`. An IK
  target whose tip is sided is placed once per side too: `leg`, reaching with `foot`, is `l_leg`
  and `r_leg`.

The reflected side's joints bolt onto the reflected slot, which reflects each joint across its
female face's forward, carried through its bones; each next joint, and the part's slots, sit on
the reflected one the same way. `mech.joint_mirror` works out the matching reflection: the part's
shapes and slots show through it (so its children follow), and a drive on an axis the reflection
turns over goes the other way (a turn about any axis but the reflection's). So the two sides are
exact mirror images, drives and all, with the same numbers. That is what makes twins
(`mech.channel_twin`): a joint's channel's twin is the same joint's on the instance's other side,
with the same values; a sided IK target's is the other side's, its x mirrored (the model's space
reflects across x = 0), and its swivel (a reflected turn turns the other way). The root's
channels, and what is placed once, have none. `character_check` reports a mirrored slot lying on
its own plane (its two sides would be one) and a mirrored slot below one that already is (a pair of
pairs).

### Shapes

`{primitive, param, material, stretch, position, rotation, size, mirror}`: a primitive centred at
`position` in the part's frame, turned by `rotation`, with `size` its full extent on each axis;
with `mirror`, drawn again reflected across that plane of the part (Mirroring, above).
For round shapes, x and z are the diameter and y is the height (along the shape's own y).

**Links.** A limb part is a link: its `length` is the distance from where it hangs to its
origin, where the next link hangs, and its body follows. A shape that `stretch`es runs that
length (`mech.shape_place`): its position is from halfway up it, and its y extent is the length
plus `size.y`, so `size.y` is how far it runs past the ends. Changing the length lengthens every
stretched shape, so a limb's length lives in one place. Unstretched, a shape sits in the part's
frame as given.

```json
{"primitive": "CYLINDER", "stretch": true, "position": [0, 0.01, 0], "size": [0.31559, 0.06, 0.31559]}
```

The mech's shin body runs from its origin (the ankle) up to the knee, 0.06 longer than the shin.

| primitive | param |
| --- | --- |
| `BOX` | - |
| `WEDGE` | a box whose top slopes down toward +z; `param` is how far the front top edge drops (0 = box, 1 = full wedge) |
| `CYLINDER` | - |
| `HALF_CYLINDER` | how far its top narrows (0 = cylinder, 1 = point); a 180° arc, turn it with `rotation` |
| `QUARTER_CYLINDER` | as the half cylinder's; a 90° arc |
| `CONE` | top radius / bottom radius (0 = point, 1 = cylinder), apex up |
| `SPHERE` | - |

These seven are the whole vocabulary. Nothing in a model is a custom mesh: see
[rendering.md](rendering.md) for why that matters.

### Joints

A joint is one mechanism: the hardware to build, where its bone pivots, how it rests, and what it
moves. Each joint is **one bone and one channel**; a part that needs more motion stacks joints
(`joints`, from the parent's slot to where the part hangs, each on the one before):

| kind | moves | channel | hardware | pivot |
| --- | --- | --- | --- | --- |
| `PIN` (the default, left out of files) | turns about x: a forked hinge | a hinge | two female lugs with a pin, a solid male lug, base plates | a reach from the socket |
| `SPIN` | turns about y (the socket's normal): a turntable, a spin servo | a hinge | two discs | where the discs meet |
| `LINEAR` | slides out along -y (away from the socket): a linear actuator, a piston | a slide | a barrel and a rod | the barrel's mouth |
| `BALL` | turns about x, y, z | a ball | a socket on a flange, a ball on a stud | inside the ball |

A part with no joints is bolted on rigid. Each kind moves on its own axes: there is no axis to
choose. For a pin about another direction, `twist` its socket (the instance's `joints`).

A **turntable** (`SPIN`) is stacked before a pin (turning it on its socket: a shoulder
swinging the arm forward) or after it (turning the part after the pin: a forearm's twist). A pin's
base plate next to a turntable is drawn round, the turntable it turns on; alone, its plates are
square. A turntable with no size builds no discs and pivots right on its socket, so the round
plate is all there is to see: the mech's shoulders and hips are `<joint>_top` turntables, a pin,
and `_bottom` turntables.

`min` and `max` are a joint's **stops**, measured from the part straight, on each axis of its
frame it moves (`mech.joint_axes`): a pin's x, a turntable's y, a ball's x, y, z (radians), a
linear actuator's y (model units out). The rig holds every drive and IK inside them, as a real
joint's stops do, so IK can't bend a knee backwards. **Every joint has them**: `character_check`
reports an axis it moves on without `min < max`, and stops on an axis it doesn't move on. Only a
turntable may spin free (equal ends). A reflected side's range turns over with its drives. The
mech's knee is `"min": [-2.6, 0, 0], "max": [0.05, 0, 0]`; a piston `"max": [0, 0.5, 0]`; the
mech's shoulder pin, which the rest pose holds at 80° so the arm hangs from a slot facing
sideways, `"min": [0.87, 0, 0], "max": [2.27, 0, 0]`.

`size` scales the hardware; 0 (omitted) builds none and has no reach: the joint pivots on its
slot (the mech's pelvis turns on a bare turntable). Every piece of hardware is **measured from the
joint's few values** (`mech.joint_dims`), with rules that keep the pieces fitting together, so
any values build working hardware and nothing else needs tuning:

| kind | values | what is derived |
| --- | --- | --- |
| `PIN` | `reach` | The pivot sits `reach × size` out from the slot. The base plate takes part of that, up to 0.55 × size, and the lugs the rest: they shrink, down to 0.3 × size across, so their barrels always clear the plate, and the pin always sits inside them. With too little reach for that (below about 0.33), the hinge is a **bare pin** pivoting on the slot itself: the mech's knuckles have no reach. The female half is two lugs, the male one solid lug between them. |
| `BALL` | (its range) | The ball is `size` across, in a socket on a flange. Its stud is as long as the joint's range needs for the male flange to clear the socket at its widest tilt (x and z together, up to 70°, the most the socket's rim allows). Widening the range lengthens the neck. |
| `SPIN` | none | Two discs, `size` across, meeting on the pivot. |
| `LINEAR` | (its stroke) | A barrel `size` across, as long as the stroke needs (and half a size more), its mouth the pivot; a rod half as wide slides out of it, the part on its end. |

The editors ask the engine what a joint moves about (the viewer's `dofs` query: `bare`, `plates`,
`axes`), so they show its stops as the game has them.

Joint hardware is built from the same primitives as shapes and painted in the model's `hardware`
materials. It belongs to no shape, so the editor doesn't list it.

### Rigging: channels, IK targets

A pose is every **channel**'s values, and clips' motions name channels
([animation.md](animation.md)). Each channel is shaped as what it moves (`mech.ChannelKind`):

| kind | values | units | what |
| --- | --- | --- | --- |
| `HINGE` | 1 | radians | a pin's or a turntable's turn, an IK target's swivel (its bend turned about the limb) |
| `SLIDE` | 1 | model units | a linear actuator's slide out |
| `BALL` | 3 | euler radians | a ball's turns, the root's turn |
| `POSITION` | 3 | model units | an IK target, the root's place: the only kind an arc moves |
| `WEIGHT` | 1 | 0 to 1 | how much an IK target reaches |

A value is written as its channel is shaped: a number, or `[x, y, z]` (`"l_forearm.elbow": 0.26`,
`"l_arm.shoulder": [0, 0, 0.3]`, `"root": [0, -0.35, 0]`); one shaped otherwise is logged and
skipped (`character_check` says so). Nothing needs declaring to animate a joint: **every placed
instance's joint is a channel**, `<place>.<joint>` (`l_arm.shoulder` on a side). Its value is how
far it turns (slides) from the part straight, held in the joint's range; the reflected side turns
the mirrored way, so twins take the same values. The editor's sliders
run over the joint's `min`/`max`. Renaming an instance or a joint renames its channels wherever
they are named, on both sides: the rest pose and the open animation.

The channels, in order (`mech.model_channel_table`): each placed IK target's, the root's, then the
joints', place by place (an instance's two sides next to each other, left then right). Several joints moving together (a hand closing nine knuckles, the tips after the bases)
are a motion's move, its channels with delays ([animation.md](animation.md#motions)), not a
channel of their own.

**The root.** No joint moves the whole model: `root` (a position) moves the model's origin and
`root.turn` (a rotation) turns it. The mech's walk drops it with `root`, and IK targets, being in
the model's space, keep the feet planted while it does.

An **IK target** (`iks`, `{name, tip, aim}`) reaches instance `tip`'s frame for a point by
turning every joint of its chain, each about the axes it turns. A tip on the sides of the body
places the target once per side (`mech.model_ik_places`): the mech's one `leg`, reaching with
`foot`, is `l_leg` and `r_leg`. The chain is found from the places (`mech.ik_root`): up from the tip to just below the nearest branch, an instance holding
several children (a pelvis, a torso). A leg reaches from its thigh, an arm from its upper arm. The
tip reaches with its **end** (`mech.ik_end`): as far along its last link, at rest, as its
pieces and those hanging from it go, on that line: a foot's sole, not the ankle at its base. The
tip's own joints (an ankle) don't reach. A foot (its end on the ground at rest) meets the ground
by the **contact** rules below; a tip off the ground keeps its own joints' turns. Its channels are
named after it: `<name>` (a position), the point in the model's space as
an **offset from where the end is at rest** (model units: 0 is the foot where it stands, so a
target needs no placing), `<name>.swivel` (a turn, 0 by default: see the pole below), and
`<name>.weight`, from 0 (the chain as its joints' channels put it) to 1 (reaching). The solver
(mjolnir's `animation.ik_solve`) is damped least squares over every joint's turns at once, 16 steps
from the pose the channels give: the end onto the target, the middle joint toward where the pole
puts it and, for a foot, the facing contact gives it, weighed together; then a few steps with the
facing let go settle the end and the middle exactly. Each step moves the joints
the least it can, each held in its range. The result is blended with the channels' motion by the
weight, joint by joint. A target out of reach (past the stops, not only the chain's length) is
reached for as near as the stops let: draw paths inside it. The mech's `l_leg` and `r_leg` reach each foot from its thigh.

**Ground contact** (`src/mech/contact.odin`) places a foot before its leg reaches, by three rules
measured from its pieces; clips only move its target, and nothing names a heel or a ball:

1. **Its facing is exact.** The foot is placed first; its own joints turn it to that facing within
   their stops, and the whole leg reaches with it held there (the hip turns what a hinged ankle
   can't), the contact point exactly on the target. The leg is first swung whole toward the
   target by the joints above its knee, its shape kept, so the solve starts from the way of
   folding the target leads it to and never jumps to another as the target moves; and the foot's
   own joints give last (the solver holds them stiff), so the leg turns the foot before the ankle
   does and a leg reaching far back extends instead of folding its lower segments flat.
2. **It keeps its rest angle to the leg.** It faces as its own joints' channels turn it on the
   rest stance, swung as the line from the leg's root to the target swings from rest: a foot
   reaching ahead tips its toes up, one under the body stands flat, one behind tips them down.
   Its ball and toes follow its heel on the ground, in every clip, as a tail's links follow
   each other: clip_sample writes, per foot, where its target was through the follow-through
   before (`FOLLOW`, a tenth of the clip's cycle) and the one before that, on average (a pose's
   IK_TRAIL, keyed by nothing; read by mjolnir's lead/follow-through `animation.lag_sample`). The ball stands as high as the first, so as the heel rises the
   toes stay flat on the ground (the foot rolling on its ball, as far as its toes can turn back)
   before they follow it up; the toes turn as the foot turned the follow-through before, so as the
   heel lands the foot lays down heel to ball while the toes still point up, settling after. Near
   the ground the foot stands on whichever corner is down, heel or ball; once heel and ball stand
   higher than its heel rolled on its ball (an eighth of a turn at most), the leg's pitch holds
   again. A still pose has no trail: its feet keep the leg's pitch.
3. **It rests on the ground.** It swings about its end only as far as no corner of it goes
   through the ground: coming down ahead it lands on its heel, toes up, and the ground lays it flat
   as the target comes down; planted, it stands flat, behind the body too: the share of the swing
   that tips it toes down the ground stops as well, about the tips of its toes (the joints below it
   as they hang), so a target lifting behind tips it up smoothly, heel first, toes last to leave.
   Its heel lifts on the ground only as the leg runs out of reach: as the ankle nears the furthest
   the leg reaches (measured once, the leg pulled out straight within its stops, a little at a time),
   from a twentieth of the leg short of it but never nearer than it stands at rest, it rolls on the
   edge toward the leg's root (behind the body its ball, ahead its heel), about that edge's line, as
   little as keeps the ankle within reach, as far as the joints below it can turn back: the heel
   peels up and the toes stay flat and firm. A leg pulled further (its rolls used up, or a reach that
   way shorter than the furthest) pulls the foot off the ground, toes and all. A foot the leg can't
   turn level (no joint of a strider's leg rolls its foot as the leg splays) stands on the edge it
   ends on, lifted out of the ground, its toes out of it too as far as their stops let them lie
   down. Joints below the foot (`toes` on a `ball` pin) lie flat on the ground as they near it, and
   never go through it.

A foot of two parts, a `foot` with the heel and a `toes` part on a pin at the front of its sole,
rolls heel to toe; a one-part foot rolls as one, and a point foot (a spider's) hardly at all.
Every piece the foot's bone carries counts as its sole, the toes' hinge lugs ahead of it too, so
a foot rolling onto its ball never sinks its hinge into the ground.

**IK is for contact and aim**: feet that must stay on the ground, heads that look. Arms, hands and
guns are FK, their joints' turns between stops: a mech's arm has too few joints to chase a point
in space (its reach is full of holes), so a target for it ends in poses it can't reach.

Every chain bends toward a **pole**, which the rig works out (`mech.ik_pole`), so there is none to
place. Its middle joint (the pivot nearest halfway along it: a knee, an elbow) bends the way it is
bent in the stance (the rest pose's joints: a strider's zigzag), or, for a chain straight at rest, the side its stops let it
(forward for a human knee, back for a reverse-jointed one). The pole sits off the middle of the
line from the joint above the middle one to the target, that way, by the chain's length, turned
with the model and swung as the limb swings (the shortest turn from the chain's line at rest to
its line to the target). So it goes where the target goes: a foot stepping far ahead or aside
keeps its knee pointing the way the leg is built, never flipping. The middle joint is drawn to
where its two segments put it, off the line from the joint above it to the target, toward the
pole (never quite on the line, so a straight leg or one out of reach still bends the pole's
way). So the chain bends in the plane through the pole.

The pole is worked out, but how the limb bends is still the clip's to say: **`<name>.swivel`**
turns the pole about the line from the joint above the middle one (a hip, a shoulder) to the
target, by that many radians. The middle joint goes round the circle its two segments allow, and
the tip stays on the target: a knee swung out in a wide stance. 0 is the pole as worked out, so nothing needs setting until a clip wants it. It
is a channel like any other: a move adds it by its shape (beside an arc, the elbow rolls as the
foot goes along it), and its twin is the other side's swivel, mirrored (`mech.channel_twin`: a
reflected turn turns the other way, so a WITH move swings both knees out). An aiming target has
no bend, so its swivel does nothing.

With `"aim": true` a target is looked at, not reached: its chain, the tip's own joints included
(a neck), turns so the tip faces it, as it faced ahead (+z) at rest: a head looking, a gun
aiming. Its point is then an offset from a point ahead of the tip at rest (as far ahead as the
tip is high). The mech's `head_aim` turns its head by the neck; the strider's turns its sensor.

An aim's turn is shared along its chain, the tip taking the most; the chain runs up from the tip,
as above (the neck). A tip that is the root has no chain to aim with, which `character_check`
reports.

### The rest pose

The model's `pose` is the pose every clip starts from and adds onto: channel amounts by name,
every channel it leaves out at 0. It is **symmetric**: each amount moves its channel's twin too,
as a WITH move does, so one side is written; writing a channel and its twin both is an error
(`character_check`). Asymmetry is a clip's (the combat idle's guard). It is the character's
**stance**, and the only place a joint's stance lives: the mech's arms hanging from their
sideways slots, a little bent, its knuckles half closed, its legs reaching for the ground (their
IK weights 1); the strider's zigzag. The stance is written once, here. Each clip then holds only
how it differs. The game shows the rest pose when an action has no clip. The character editor's
pose test (Assemble tab) starts from it, and **Set rest pose** saves what it shows (the left side
of each pair; it says so when the sides differed).

```json
"pose": {"l_arm.shoulder": 1.3963, "l_finger_a_1.knuckle": -0.3665, "l_forearm.elbow": 0.2618, "l_leg.weight": 1}
```

What the rig measures "at rest" (an IK target's tip, its pole's bend, a foot standing, the
ground) it measures on the stance: the rest pose with its IK targets let go and the root at the
origin.

## How a rig is built and posed

`rig_create` walks the places in order (`mech.model_places`, `Rig.places`: an instance once, or
on each side of the body):

1. **Root**: an anchor bone at the origin, at rest, stands in for the parent; then as a child.
2. **Child**: the first joint of its part's stack is seated onto the parent's slot (on the
   reflected side, the slot reflected: across its own mirror plane, or with the parent), each next
   joint onto the one before. A joint's female hardware goes on the bone before it; a moving joint
   gets a bone at its pivot, which its male hardware rides. The part hangs on the last joint's
   male face, its origin `length` below: that places its frame.
3. **Shapes**: one scene node each (two for a mirrored shape), under the last bone, carrying the
   shape's place and scale (reflected on the reflected side).

Bones are flat children of the rig's `frame` node, which the model's `scale` scales. Pieces are
children of their bone, so posing writes **one transform per bone and none per piece**. The mech
has 48 bones (one per moving joint, and the root's anchor) and 212 pieces.

After building, the rig finds each IK target's chain and, when `ground` is set, the lowest corner
of any piece in the stance (the rest pose's joints).

`rig_pose(values)` then:
1. sets each bone's motion from its joint's channel: turns about its axes, or a slide
2. solves each bone from its parent (a root's anchor from the root's channels): `parent ∘ offset ∘
   rest ∘ Rx·Ry·Rz`, then a linear actuator's slide along its -y
3. aims or reaches with each IK target whose weight is above 0, solving again after each
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
  (`src/mech_kit.odin`, seed 7). Same proportions and motion. Its torso's `arm` slot mirrors
  across its z and its pelvis's `thigh` slot across its x, so each limb is written once (18
  instances, 33 placed), and the thumb and fingers share their three segment parts
  (`finger_1`..`finger_3`). Each foot is two parts, the `foot` (heel and sole) and its `toes` on
  a `ball` pin at the sole's front. Chains hang on the origin (each link has a length); a slot is named after the branch matched on it.
- `assets/characters/dragon.json`: mjolnir's dragon example (`examples/creative/dragon`), ported. The
  spine is a chain of ball joints (instances `segment_*`, `taper_*`, `tail`, each with
  channels, `segment_3.spine` a rotation and so on) placing a few shared parts (`segment`, `segment_limbs` with the limbs'
  slot, `taper`, each a link the next hangs on the origin of), the limbs hang from `segment_limbs`'s
  `limb` slot, mirrored across its z, the limbs are shoulder and hip pins on turntables plus
  elbow/knee pins, and the jaw is a centred pin. Its rest pose folds the limbs, so it stands on the
  ground; the head is the root, with no aim. Its joint hardware uses this engine's kit, so the lugs and sockets look a little
  different from the example's. Piece colours keep the example's palette hashing, with a fixed
  seed.
- `assets/characters/strider.json`: a heavy reverse-jointed walker, built on the same engine
  with a different body. A wide hull on a ball waist, a visor `sensor` on a neck, a missile
  `rack` hinged on its back (`rack_pitch`), and arms that end in guns: the `cannon` part is the
  forearm, no hand. Each leg is four links, `thigh` (the mech's hip), `shin` (`knee`),
  `hock` (`ankle`) and a broad `foot` (`toe`) with three `toes`, the middle one big, on a `ball`
  hinge with lugs (a `reach`) out of the sole's front face (its slot faces forward), so the two
  halves of the foot are visibly pinned together; the rest pose's pin turns give its stance
  the zigzag (thigh back, shin forward, hock back, foot level), so the knees point backwards and
  their ranges keep them there. The hull's `arm` and the pelvis's `thigh` slots mirror, so each
  limb is written once.
- `assets/characters/spider.json`: eight IK legs from four mirrored `leg_1`..`leg_4` sockets on a low
  box thorax, all sharing the `coxa`, `femur`, `tibia` and `tarsus` box parts. Each leg is hinges only: the
  coxa's `swing` pin turns about the vertical (each socket faces out its own way), the femur's `lift` pin
  is twisted across it, then the `knee` pin and the tarsus's `ankle` pin; a bare `roll` turntable on the
  femur and `twist` on the tarsus give the IK its spare turn. The abdomen is a stack of discs graded to an
  egg's profile on a BALL waist; the head's neck is a BALL, the head aims by IK and the mirrored `fang`s
  are short teeth on bare pins (`bite`). One IK target per leg pair (`leg_1`..`leg_4`).
- `assets/characters/tiger.json`: a boxy quadruped on IK paws (`fore_leg`, `hind_leg`). Two BALL joints
  in the body: the chest (the root) to the pelvis (`waist`) and the neck; everything else is a pin. Legs
  hang from mirrored slots facing down, so each pin turns about x and the leg works in its plane:
  forelegs `shoulder`, `elbow`, `wrist`; hind legs `hip` (between bare `hip_top` and `hip_bottom`
  turntables, so the feet stay planted while the waist sways), `knee`, `ankle` (digitigrade: forward
  knee, backward hock) and `toe`. Each paw is a pad, a toe block and a claw strip on a sole plate. The
  tail is a `lift` and `wag` pin pair, two `wag` pins and a `curl` pin at the tip. The head is a few
  blocks (skull, cheeks, muzzle, ears) with a pinned jaw, and aims by IK.
- `assets/characters/eagle.json`: a perched raptor. A BALL shoulder, elbow, wrist chain folds against
  the body at rest and a `spread` pose opens it; the tail fans on a pin. Short legs hang from slots under
  the body on pins (`hip`, `knee`, `toe`), each foot one solid plate with a talon strip; they hold the
  perch by IK and are swept back (weight 0, a `tuck` pose) in flight. The head is a block with a straight
  beak ending in a downturned hook, the lower beak on a `jaw` pin.

- `assets/characters/gecko.json`: a sprawling lizard on a rigid box torso, four IK feet (`fore_leg`, `hind_leg`) from
  mirrored `fore` and `hind` sockets, each leg the spider's pin stack (`swing`, `lift` twisted across it, `knee`,
  `ankle`) with a round toe-pad foot. The head's neck is a BALL and aims by IK, with a pinned `jaw`; the tail is
  the tiger's `lift` and `wag` pair, two more `wag` pins and a `curl` tip.

## Not supported yet

- **Seeded variation.** The old code-built mech took a seed that varied its proportions and
  colours. A model file is one fixed mech. Variation would need parameters in the file, with
  shapes sized from them.
- Free (unconstrained) bones, which the dragon example used to steer its spine along a spline.
  Its spine is ball joints here, waved by spread moves (its `slither`).
- Renaming an instance, a joint, an IK target or an arc in the character editor updates the rest pose and the open animation, but not other
  character files that use the old name.
