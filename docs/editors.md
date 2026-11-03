# The character editor

One browser app edits a character: its model, its rig and its animation. The 3D view is the
game's own code and renderer running as wasm ([architecture.md](architecture.md)), so what you
see is what the game shows.

```sh
make character-editor    # builds the viewer to wasm, then serves http://localhost:5180/
```

It needs:
- a browser with WebGPU (Chrome or Edge, or Safari 26)
- Node (no packages)
- `wasm-ld` (LLVM lld; the Makefile looks in `~/.local/llvm/bin`)

## Characters and files

A character is one model and its animation, in one file. The header's dropdown lists the
characters **saved in this browser** and those in the repo's **assets/characters/** (each
`<name>.json`). A character saved here takes precedence over the file with the same name.

| | |
| --- | --- |
| Save (Cmd/Ctrl-S) | keeps the character in this browser (localStorage); `assets/` is never written |
| New | a new character with one part, placed once, and one material |
| Import | open a character file (`<name>.json`); it is saved here |
| Export | download `<name>.json`, written by the engine's own writer |

To put a character in the game, export it and copy the file into `assets/characters/`.

## Everywhere

| | |
| --- | --- |
| Cmd/Ctrl-S | save in this browser (a dot by the save button means unsaved changes) |
| Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z | undo, redo (a drag or a slider move is one step) |
| 1, 2, 3, 4 | Model, Assemble, Rig, Animate tabs |
| F, frame button (top right of the view) | frame the character (the part, in the Model tab) |
| I, inspector button (top right of the view) | hide or show the inspector (the right panel); remembered |
| dock span toggles (right end of the dock bar) | let the curve editor or pose test run under the left panel, the right panel, or both; remembered |
| Esc | clear the selection: the inspector shows the character's settings (Assemble, Rig) |
| drag / scroll in the view | orbit / zoom (dragging leaves a side view for the free orbit) |
| view gizmo (top right of the view) | the world axes as the camera sees them: click an axis end to look from that side, front (+z), the character's left (+x), top (+y) or their opposites, orthographic and framed; click the disc for the free perspective orbit |
| click in the view | select the shape (Model) or the instance (Assemble, Rig) under the pointer |
| W, E, R, T, J (Model tab), or the tool buttons at the top right of the view | the view's handles: move, turn, size the selected shape; place the part's slots; try its joints |

- Number fields: type a value or arithmetic (`0.3*2`, `(0.4+0.1)/2`); start with `*`, `/` or `+`
  to work on the value there (`*2`, `/2`, `+0.05`; a leading `-` is a negative number). Use the
  arrow keys (shift for 10×), or drag the x/y/z label (shift for fine, alt for coarse). A size's
  🔗 lock changes all three in proportion.
- Angles are shown and typed in **degrees**: shape rotations, and the ranges, driver ends and
  pose values of joints' channels and drivers that turn a joint, and joint twists. Files keep radians.
- Exports are written by the engine's own writer, so copying one over an asset only diffs where
  you changed something.
- Warnings from the engine (a motion naming a channel the model lacks, an instance matched with a
  slot its parent's part lacks, a driver moving a channel that is not a joint's, and so on) collect under ⚠ in the header.

A model is a **library of parts** and an **assembly** placing them ([modeling.md](modeling.md)).
The Model tab makes parts, their slots and their joints; the Assemble tab only hangs parts on
slots; the Rig tab drives the joints.

## Model

The selected part shows **alone**, at the origin, unposed, hanging by its origin with its own
joints (or by the selected slot, when that has joints, so they show), with its frame drawn as RGB axes and
only the selected shape outlined. The **explode** slider at the top right of the
view pushes its shapes apart, each out from the part's middle (double-click it to put them back);
the handles hide while exploded. The **⇋** button beside it previews the part mirrored, as a
`mirror` instance (the right side) shows it; model the left side, and the handles hide while
previewing. Nothing about the view is saved.

- **Parts**: the library. Each row says how often the assembly places the part (`unused` when
  never). **+** adds a small box, ⧉ duplicates, ✕ deletes a part nothing places.
- **The selected part**:
  - name (renaming carries to the instances), and its own
    **joints**: what it hangs by, from its parent's slot to its origin. To make a part
    bigger or smaller, select its shapes (Cmd-A selects them all) and drag the size tool's middle
    box: they scale together about their middle. A joint stack is listed from the parent's
    side, each joint on the one before, edited in place: its **name** (unique in the part;
    its channels and drivers name it by it), its **kind** (spin, hinge or ball; a new joint is a hinge
    sized to the first shape, and switching kind drops the old kind's fields and fills in
    default proportions at the current size), ↑ to move it up, ✕, a **twist** about the socket's
    normal first (degrees) with its axes, **bend** (a turn at rest), its **range** on each axis
    (its stops, from rest; equal ends leave it free; drives and IK stay inside, and a driver made
    for it in the Rig tab takes the range as its slider's), **size** (the hardware
    scales with it; 0 builds none; **fit** sizes it to the face of the part's shapes where it
    sits, as a clevis is sized by its link, and a new joint or kind starts fitted) and its proportions (times the size) under "proportions" (a hinge with no lugs, shank or base plate is a
    bare pin on the slot, like the knuckles). Joints live on the part, so every instance of the
    part shares them.
  - its **slots**: the named faces it is matched with other parts by; the origin needs no name.
    Select one to rename it (carried to the instances matched on it), **snap** it to one of the
    six faces of a shape (**inset** moves the next snap in toward the shape's centre), or type
    its position, normal and forward. A slot something is matched on can't be deleted.
  - its **shapes**: primitive, taper or top radius, material, **span**, position, **turn**
    (a quarter turn about the part's X, Y or Z; a box, a sphere or an upright cylinder shows it
    as its size instead of a rotation), rotation (degrees; shown when there is one) and size (the
    full extent; round shapes show a diameter and a height). **tidy** does that for every shape
    of the part and rounds its numbers to 0.001. Shift-click shapes, in the list or the view, to
    select several (Cmd-A: all): primitive, material, turns, moving, sizing it all (the size
    tool's middle box), duplicating and deleting apply to all of them. Cmd-C / Cmd-V copy shapes to another part (they keep their span when it has the slots). A shape
    spanning two slots (the origin is one) is a link's body: it sits between them, its y size is
    how far it runs past them, and moving either slot lengthens it. Changing the span keeps the
    shape where it is. A slot a shape spans can't be deleted.
- **Materials**: colour, metallic, roughness, emissive. Renaming carries through to shapes and
  hardware.

**Handles in the view** edit the selected part; a drag is one undo step:
- **move** (W): arrows along the part's axes move the shape, snapping flush or level with the
  other shapes' faces (shift: 0.01 steps instead). Dots on the other shapes' faces stack it
  there: its facing side centred on that face, touching (shift-click: only close the gap; alt-click:
  a new box covering that face).
- **turn** (E): rings about the part's axes. Shift turns in 15° steps.
- **size** (R): boxes along the shape's own axes size that side, the opposite face staying put
  (alt: both ways from its centre); the middle box sizes it all (drag right or up), and every
  selected shape with it, about their middle. Shift snaps
  to 0.01.
- **slots** (T): a ring on each slot (click to select it) and a dot on each face of the shapes
  that faces you: click one to put the selected slot there, or a new slot when none is selected.
- **joints** (J): at each pivot of the joints the part hangs by, a ring per axis it turns about
  its range as a thick arc and where it is now as a spoke. Click one to
  select the joint; drag it to try the joint (shift: 15° steps), held in its range.

Trying joints with J is never saved; ↺ by "joints" puts them back at rest, and choosing another
part does too. Twist and bend have 0 / 90 / 180 / −90 buttons.

## Assemble

- **Character settings** show in the inspector when nothing is selected (Esc clears the
  selection): name, stand-on-the-ground, and the materials joint hardware is painted in.
- **Assembly**: the tree of instances (the inspector shows the part each places, its slots, and
  whether it is mirrored).
  - **+ child** makes a new part and matches its origin with the selection's first free slot (a new slot on
    the bottom of its first shape when all are taken); **+ root** adds a free-standing one.
  - **⇋ mirror** copies the selected limb (from the topmost `l_`/`r_` instance, or
    `left`/`right`) to the other side of the body, replacing what is there. The copies place the
    **same parts**, mirrored, so editing a left hand edits both. They get the other side's names,
    and their joints' channels are the other side's (`r_forearm.elbow`); driver moves on them are copied
    to the other side's drivers (made when missing; a driver with no side, like `pelvis_turn`,
    moves both) with the same numbers: the engine turns over the ones a reflection needs. IK targets come along. The limb is matched with the other side's slot of the
    parent's part (`l_shoulder` to `r_shoulder`), which is made, reflected, when the part has none.
  - **kit** adds any instance of any character (this one, those saved here and those in
    assets/), with what hangs from it, under the selection: the parts they place, their joints,
    materials, the drivers moving them (with only their moves on the copies) and IK targets come
    along, all can be scaled on the way in, and it is matched with the selection's slot of the
    same name, else its first free one.
  - ⧉ duplicates an instance without its children; ✕ deletes it and everything under it (the
    parts stay in the library).
  - Drag an instance onto another to hang it there (matched with the slot of the same name, else the first
    free one), or onto "make root". The tree stays parents first.
- **The selected instance**: name (renaming carries to its children, its channels and IK targets),
  **part** (from the library, or a new one), **parent**, **matched with** (a slot of the parent's part, or its origin),
  **mirrored**, and its part's joints.

The view shows the character at rest, with no dock: the tree has the sidebar's full height.
Bend joints to check clearances in the Rig tab's pose test.

## Rig

Every joint axis is already a channel motions name (`l_forearm.elbow`), so rigging is only what
moves several joints at once (drivers and IK targets) and the rest pose clips start from.
Motions are the Animate tab's.

- **Drivers**: values that move several joints at once (a curl). Each row says what it moves.
  **+** adds one moving the selected instance's first joint. Its inspector sets the name
  (renaming carries through the rest pose and the open animation), the slider range and its
  **moves**. Each move has a **delay** (the driver's value it starts at: a finger's tip closing
  after its base) and its joints' channels, each with the turn per unit of the driver (degrees);
  **+ joint** adds one. Moves add onto the joints' own channels, and the joints' ranges stop
  them.
- **An instance**: its part's joints, one row per axis, with the axis's own channel, the drivers
  also moving it (click one to edit it) and **+ driver** to drive it with an existing driver or a
  new one.
- **IK targets**: **+** makes one for the selected instance (the tip), its chain from two
  instances above. Its channels are named after it (`_x`, `_y`, `_z`, `_weight`, and a reaching
  one's pole `_pole_x`, `_y`, `_z`: moving the point in front of the chain's middle that the knee
  or elbow bends toward). Its inspector sets the name (carried through the rest pose and the open
  animation), **root**, **tip**, **aim** (look at the target instead of reaching it: a head, with
  root and tip both the head) and **hold its facing** (for a planted foot: its ankle keeps it as
  the clip angles it to the ground). **Try it at the tip** puts the pose test's target on the tip
  at full weight, to drag from there. ✕ deletes the target.

The **pose test** in the dock has a slider per channel (the engine's list), starting from the
rest pose, to try the rig: a joint's runs over its range. An IK target's x, y, z, a ball's x, y, z
and the root's move and turn each show as one x/y/z row. It moves the view only, until **Set rest
pose** saves what it shows as the model's rest pose: the stance every clip starts from and adds
onto ([modeling.md](modeling.md#the-rest-pose)). ↺ goes back to the rest pose.

**Handles in the view** (Rig and Animate): a diamond on the model's root, a dot on each IK
target and a ring on each pole. Click one to select it: arrows move it along the model's axes (shift: 0.01 steps), and
the root's rings turn it (shift: 15° steps). In the Rig tab they set the pose test. In the
Animate tab they pose the motion shown: its picked move (else its first) changes its amounts so
the view shows what you dragged to, by the change over how much of them the move adds at the
playhead (a held motion: all of it). A drag is one undo step.
Three buttons at the top right show the IK targets and poles hidden, as points, or as points
with their names (remembered in this browser); the root's diamond always shows.

## Animate

A clip is motions ([animation.md](animation.md#motions)): shapes over time added onto channels, on
top of the rest pose. There are no key frames: a pose held is a motion with no shape, and a pose
at a moment is a shape stepping into it there.

- **Clips** in the sidebar. The editor edits one clip at a time. **+** adds an empty clip, ⧉
  duplicates it.
- **Motions** (the sidebar, under Clips): the clip's motions. Click picks one (the dock and the
  inspector show it); shift- or cmd-click picks several, the last picked the one shown.
  - **+** adds a motion holding a pose (no shape, one empty move): pose it with the view's
    handles, then give it a shape in the dock.
  - **Isolate** (the eye) plays only the picked motions (the viewer gets a copy of the animation
    with the others left out; the clip itself is untouched). It stays on while you pick, and goes
    off with another clip.
  - **Merge** appends the moves of the other picked motions to the last one picked (tagged
    "into"), in clip order, and removes them: they take its shape.
  - The trash removes the picked ones.
- **The inspector** shows the clip's duration, then the motion shown: its **rate** (whole cycles
  of its shape over the clip, so a loop never jumps) and its **moves**, each with its **delay**
  (cycles late). Click a move's head to pick it (the view's handles pose it), shift- or
  cmd-click to pick several. **Split** moves the picked moves into a new motion right after it,
  with the same shape; ✕ removes them; + adds a move (unfolded). Moves are folded, showing their
  channels' names; the caret unfolds one to edit its amounts (+ channel adds one at 0).
- **The curve editor** (the dock) shows the motion picked as curves. Everything drawn comes from
  the engine (query `motion`), so it is what plays.
  - **Shape** (left): one cycle of the motion's shape, repeating. Drag a point (shift snaps to
    0.05), click empty space to add one, double-click or Delete to remove it. The toolbar sets
    the selected point's ease (how it is reached from the point before: LINEAR, IN, OUT, SETTLE,
    STEP). **Hold, Sine, Slide, Lift, Pulse, Square, Bounce, Hit, Steps** start the shape over
    (the one it matches is lit). A one-shot (a pulse, a hit) is a shape that ends where it
    starts.
  - **Lanes** (right): what each move adds over the clip, one lane each, the picked moves lit.
    Drag a lane sideways to make its move run later or sooner (its
    delay); click a lane to pick its move. Too many moves for a lane each (a chain's joints)
    share one: a drag there moves them all, a click scrubs.
  - **Window** (the bar under the ruler): the first move's first cycle. Drag it to make every
    move run later or sooner, its right end to fit more or fewer whole cycles in the clip (its
    rate).
- **Player** (floating at the bottom of the view): to the start, play/pause (space), loop, the
  time, speed.

## Not there yet

- Turning joints by dragging in the view outside the Model tab (the pose test's sliders do it).
- Onion skin and motion paths in the view (`trajectory` queries already answer them).
