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
| dock span toggles (right end of the dock bar) | let the timeline or pose test run under the left panel, the right panel, or both; remembered |
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
  pose values of drivers that turn a joint, and joint twists. Files keep radians.
- Exports are written by the engine's own writer, so copying one over an asset only diffs where
  you changed something.
- Warnings from the engine (a key naming a driver the model lacks, an instance matched with a
  slot its parent's part lacks, a drive on a joint its instance does not expose, and so on) collect under ⚠ in the header.

A model is a **library of parts** and an **assembly** placing them ([modeling.md](modeling.md)).
The Model tab makes parts, their slots and the joints those expose; the Assemble tab only
matches slots; the Rig tab drives the exposed joints.

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
    **joints**: those of its default slot, its origin, which most parts hang by. To make a part
    bigger or smaller, select its shapes (Cmd-A selects them all) and drag the size tool's middle
    box: they scale together about their middle. A joint stack is listed from the parent's
    side, each joint on the one before, edited in place: its **name** (unique in the part;
    drivers move it by name), its **kind** (spin, hinge or ball; a new joint is a hinge
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
    its position, normal and forward, and give it **joints** for when the part hangs by it. A
    slot something is matched on can't be deleted.
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
    and their drives are copied to the other side's drivers (made when missing; a driver with no
    side, like `pelvis_turn`, moves both) with the same numbers: the engine turns over the ones a
    reflection needs. IK targets come along. The limb is matched with the other side's slot of the
    parent's part (`l_shoulder` to `r_shoulder`), which is made, reflected, when the part has none.
  - **kit** adds any instance of any character (this one, those saved here and those in
    assets/), with what hangs from it, under the selection: the parts they place, their joints,
    materials, the drivers moving them (with only their drives on the copies) and IK targets come
    along, all can be scaled on the way in, and it is matched with the selection's slot of the
    same name, else its first free one.
  - ⧉ duplicates an instance without its children; ✕ deletes it and everything under it (the
    parts stay in the library).
  - Drag an instance onto another to hang it there (matched with the slot of the same name, else the first
    free one), or onto "make root". The tree stays parents first.
- **The selected instance**: name (renaming carries to its children, drives and IK targets),
  **part** (from the library, or a new one), **slot** (the one of its part it hangs by, or its
  origin), **parent**, **matched with** (a slot of the parent's part, or its origin),
  **mirrored**, and the joints its slot exposes.

The view shows the character at rest, with no dock: the tree has the sidebar's full height.
Bend joints to check clearances in the Rig tab's pose test.

## Rig

Rigging is defining drivers and what they move; keys and timing are the Animate tab's.

- **Drivers**: the values clips key. Each row says what it moves. **+** adds one moving
  the selected instance's first joint. Its inspector sets the name (renaming carries through the
  open animation), the slider range (degrees when it turns a joint) and its **drives**: each an
  instance, a joint that instance exposes and one of its axes, the driver's range **from** and
  the turn it maps **to** (degrees), **clamp**, with a
  preview of the mapping when it is not a plain scale. Drives on one axis add up.
- **An instance**: the joints it exposes, one row per axis, with the drivers moving each (click
  one to edit it) and **+ driver** to drive it with an existing driver or a new one.
- **IK targets**: **+** makes one for the selected instance (the tip), its chain from two
  instances above, with its four drivers (`_x`, `_y`, `_z`, ranged around where the tip is, and
  `_weight`, 0 to 1). Its inspector sets the name, **root**, **tip** and **hold its facing** (for a planted
  foot: its ankle keeps it as the clip angles it to the ground); **Try it at the tip** puts
  the pose test's target on the tip at full weight, to drag from there. **+ pole** gives it a
  pole (`_pole_x`, `_y`, `_z`), a point in front of the chain's middle that the knee or elbow
  bends toward; ✕ by it takes it away. ✕ deletes the target and its drivers.

The **pose test** in the dock has a slider per driver, to try the rig. An IK target's x, y, z and
the root's move and turn (its channels: [modeling.md](modeling.md)) each show as one x/y/z row.
It moves the view only and is never saved.

**Handles in the view** (Rig and Animate): a diamond on the model's root, a dot on each IK
target and a ring on each pole. Click one to select it: arrows move it along the model's axes (shift: 0.01 steps), and
the root's rings turn it (shift: 15° steps). In the Rig tab they set the pose test; in the
Animate tab, the selected key's own values (select one key first). A drag is one undo step.
Three buttons at the top right show the IK targets and poles hidden, as points, or as points
with their names (remembered in this browser); the root's diamond always shows.

## Animate

- **Clips** in the sidebar. The editor edits one clip at a time; mixing clips on layers is the
  game's ([animation.md](animation.md#mixing-clips-on-layers)).
- **Timeline** (the dock):
  - **Ruler**: click or drag to scrub. The ruler and the labels stay put while time scrolls
    sideways; Cmd/Ctrl-wheel or the zoom buttons zoom time (around the pointer, or the
    playhead), and the frame button fits the clip again.
  - **Rows**: one per channel the clip keys, grouped (click a group's label to fold it into one
    row), under an **all keys** row. A key shows on every row it sets: a ramp from `at` across
    `duration`, then a diamond where it lands (only the diamond when
    it snaps). Drag a key to move it, drag the start of its ramp to retime it (where it lands
    stays), alt-drag to duplicate it.
  - **Selection**: click selects a key and moves the playhead to where it lands (so what you
    edit in it shows in the view), shift-click adds, dragging on empty space box-selects
    the keys on the rows it covers. Double-click a key to play from it.
  - **A part's channels**: click a part in the view and the timeline shows only the channels
    that move it. Those are the drivers of its joints and its parents', the IK targets whose
    chains pass through them, and the root (the engine answers them: query `moves`). ✕ by
    "channels moving …" in the toolbar, or a click on empty space, shows every channel again.
- **Toolbar**:
  - play/pause (space), loop, speed, zoom, the clip length
  - **+ Key** adds an empty key at the playhead
  - **◆ Key pose…** keys what the view shows now, choosing the driver groups
  - ⧉ (Cmd-D) duplicates the selected keys, ✕ (Delete) deletes them
  - Cmd-C / Cmd-V copy and paste keys at the playhead
- **Key inspector**: at, duration and ease, then **Key values**: the key's drivers, and the
  root's channels; an IK target's x, y, z and the root's move and turn show as one x/y/z row each
  (only what you change is set). **capture** sets them to what the view shows; "+ driver" adds
  one at its value now.

Characters saved in this browser before clips were plain key lists are brought up to date when
opened: each key's pose is copied into its values and the keys are put in time order, which plays
the same.

## Not there yet

- Turning joints by dragging in the view outside the Model tab (the pose test's sliders do it).
- Onion skin and motion paths in the view (`trajectory` queries already answer them).
- A graph editor for curves.
