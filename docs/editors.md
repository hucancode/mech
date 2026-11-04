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
| 1, 2, 3 | Model, Assemble, Animate tabs |
| F, frame button (top right of the view) | frame the character (the part, in the Model tab) |
| grid button (top right of the view) | show or hide the grid: flat through the part's origin in the Model tab, on the floor through the model's origin elsewhere, with its x (red), y (green) and z (blue) axes; drawn by the viewer; remembered |
| I, inspector button (top right of the view) | hide or show the inspector (the right panel); remembered |
| dock span toggles (right end of the dock bar) | let the curve editor or pose test run under the left panel, the right panel, or both; remembered |
| Esc | clear the selection: the inspector shows the character's settings (Assemble) |
| drag / scroll in the view | orbit / zoom (dragging leaves a side view for the free orbit) |
| view gizmo (top right of the view) | the world axes as the camera sees them: click an axis end to look from that side, front (+z), the character's left (+x), top (+y) or their opposites, orthographic and framed; click the disc for the free perspective orbit |
| click in the view | select the shape (Model) or the instance (Assemble, Animate) under the pointer |
| W, E, R, T, J (Model tab), or the tool buttons at the top right of the view | the view's handles: move, turn, size the selected shape; place the part's slots; try its joints |

- Number fields: type a value or arithmetic (`0.3*2`, `(0.4+0.1)/2`); start with `*`, `/` or `+`
  to work on the value there (`*2`, `/2`, `+0.05`; a leading `-` is a negative number). Use the
  arrow keys (shift for 10×), or drag the x/y/z label (shift for fine, alt for coarse). A size's
  🔗 lock changes all three in proportion.
- Angles are shown and typed in **degrees**: shape rotations, joints' ranges, the values of turns
  and rotations (a joint's, an IK target's swivel, the root's turn), and instances' joint twists
  and bends. Files keep radians.
- Values go by channel, shaped as it is ([modeling.md](modeling.md#rigging-channels-ik-targets)):
  a turn, a slide or a weight is a slider, a rotation or a position an x/y/z row.
- Exports are written by the engine's own writer, so copying one over an asset only diffs where
  you changed something.
- Warnings from the engine (a motion naming a channel the model lacks, an instance matched with a
  slot its parent's part lacks, a value shaped otherwise than its channel, an arc the animation lacks, and so on) collect under ⚠ in the header.

A model is a **library of parts** and an **assembly** placing them ([modeling.md](modeling.md)).
The Model tab makes parts, their slots and their joints; the Assemble tab hangs parts on
slots and rigs them (IK targets, the rest pose); the Animate tab moves them.

## Model

The selected part shows **alone**, unposed, hanging by its own joints and standing as its first
instance does in the character (a torso upright on its waist, a shin hanging from its knee), with
its frame drawn as RGB axes and only the selected shape outlined. The viewer draws no shadows. The **explode** slider at the top right of the
view pushes its shapes apart, each out from the part's middle (double-click it to put them back);
the handles hide while exploded. The **⇋** button beside it previews the part mirrored, as a
`mirror` instance (the right side) shows it; model the left side, and the handles hide while
previewing. Nothing about the view is saved.

- **Parts** (the sidebar): the library. Each row says how often the assembly places the part (`unused` when
  never). **+** adds a small box, ⧉ duplicates, ✕ deletes a part nothing places.
- **The selected part** fills the dock (the bottom panel): its name, **length** and **tidy** in the dock bar,
  and its **shapes**, **slots** and **joints**, a list each, side by side, each with its own
  add/delete buttons (joints also ↑ ↓ to reorder the stack, ↺ to put tried joints back at rest).
  Pick one (shapes and slots in the view too) and the inspector edits it; a shape, a slot and a
  joint can be picked at once, each its own section. Esc lets them all go.
  - name (renaming carries to the instances), and its own
    **joints**: what it hangs by, from its parent's slot to where it hangs. The part hangs its
    **length** above its origin: model a link with its origin at its far end, where the next link
    hangs (the origin is the default slot), and set the length to the link's. To make a part
    bigger or smaller, select its shapes (Cmd-A selects them all) and drag the size tool's middle
    box: they scale together about their middle. A joint stack is listed from the parent's
    side, each joint on the one before; the inspector edits the picked one: its **name** (unique in the part;
    its channel, `<instance>.<joint>`, is named by it), its **kind** (hinge, linear or ball) and a
    hinge's **axis** (X a pin, Y a turntable; a new joint is a pin sized to the first shape with
    room for lugs, and switching kind or axis keeps the size and drops a pin's reach), its **range** on each axis it moves
    (its stops, from rest; equal ends leave it free; drives and IK stay inside; a linear's is its
    **stroke**, in model units), **size** (the hardware
    scales with it; 0 builds none; **fit** sizes it to the face of the part's shapes where it
    sits, as a clevis is sized by its link, and a new joint or kind starts fitted), and for a
    hinge its **reach** (how far out from the slot it pivots, times the size; too little for lugs
    and it is a bare pin on the slot, like the knuckles, which the hint says). A **turntable** is a
    hinge about Y stacked before the pin (turning it on its socket) or after it (turning the part
    after the pin); the pin's plate next to it shows round. The engine measures every other piece of hardware from these, so they always fit
    together: a ball's neck, for one, is as long as its range needs ([modeling.md](modeling.md#joints)).
    Joints live on the part, so every instance of the part shares them.
  - its **slots**: the origin first (the default slot, listed with what hangs on it), then the
    named faces its branches are matched on (a chain needs none).
    Select one to rename it (carried to the instances matched on it), **snap** it to one of the
    six faces of a shape (**inset** moves the next snap in toward the shape's centre), or type
    its position, normal and forward. A slot something is matched on can't be deleted.
  - its **shapes**: primitive, taper or top radius, material, **stretch**, position, **turn**
    (a quarter turn about the part's X, Y or Z; a box, a sphere or an upright cylinder shows it
    as its size instead of a rotation), rotation (degrees; shown when there is one) and size (the
    full extent; round shapes show a diameter and a height). **tidy** does that for every shape
    of the part and rounds its numbers to 0.001. Shift-click shapes, in the list or the view, to
    select several (Cmd-A: all): primitive, material, turns, moving, sizing it all (the size
    tool's middle box), duplicating and deleting apply to all of them. Cmd-C / Cmd-V copy shapes to another part. A
    stretched shape is a link's body: it runs the part's length, from the origin up to where the
    part hangs, its y size is how far it runs past the ends, and changing the length lengthens it.
    Turning stretch on or off keeps the shape where it is.
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
- **slots** (T): a ring on each slot (click to select it), a dashed one on the origin and a
  square where the part hangs, its length above, and a dot on each face of the shapes that faces
  you: click one to put the selected slot there, or a new slot when none is selected.
- **joints** (J): at each pivot of the joints the part hangs by, a ring per axis it turns about,
  its range as a thick arc and where it is now as a spoke; a linear's, an arrow out along its
  stroke. Click one to select the joint; drag it to try the joint (shift: 15° steps, 0.01
  slides), held in its range.

Trying joints with J is never saved; ↺ by "joints" puts them back at rest, and choosing another
part does too. A part's joints show straight here: how they sit at rest is each instance's (Assemble).

## Assemble

- **Character settings** show in the inspector when nothing is selected (Esc clears the
  selection): name, stand-on-the-ground, and the materials joint hardware is painted in.
- **Assembly**: the tree of instances (the inspector shows the part each places, its slots, and
  whether it is mirrored).
  - **+ child** makes a new part and hangs it on the selection's origin when that is a link's far
    end (it has a length) with nothing on it, else on its first free slot (a new slot on the
    bottom of its first shape when all are taken); **+ root** adds a free-standing one.
  - **⇋ mirror** copies the selected limb (from the topmost `l_`/`r_` instance, or
    `left`/`right`) to the other side of the body, replacing what is there. The copies place the
    **same parts**, mirrored, so editing a left hand edits both. They get the other side's names,
    and their joints' channels are the other side's (`r_forearm.elbow`), with the same numbers:
    the engine turns over the ones a reflection needs. IK targets come along. The limb is matched with the other side's slot of the
    parent's part (`l_shoulder` to `r_shoulder`), which is made, reflected, when the part has none.
  - **kit** adds any instance of any character (this one, those saved here and those in
    assets/), with what hangs from it, under the selection: the parts they place, their joints,
    materials and IK targets come along, all can be scaled on the way in, and it is matched with the selection's slot of the
    same name, else its first free one.
  - ⧉ duplicates an instance without its children; ✕ deletes it and everything under it (the
    parts stay in the library).
  - Drag an instance onto another to hang it there (matched with the slot of the same name, else the first
    free one), or onto "make root". The tree stays parents first.
- **The selected instance**: name (renaming carries to its children, its channels and IK targets),
  **part** (from the library, or a new one), **parent**, **matched with** (a slot of the parent's part, or its origin),
  **mirror of** (its twin on the other side of the body: it shows the twin's part reflected, and
  twin moves in clips move both; a mirror copy sets it), and how it sets its part's joints at rest: per joint, a **twist** (turning it on
  its socket first, about the socket's normal) and a **bend** (turning its first axis), in degrees,
  each with 0 / 90 / 180 / −90 buttons. The joint's range is from there. A mirror copy keeps them.
  Each joint also shows its **channel** and what kind it is (a turn, a rotation, a slide).

### Rigging

Every joint is already a channel motions name (`l_forearm.elbow`), so rigging is only IK targets
and the rest pose clips start from. Several joints moving together (a hand closing) are a
motion's move. Motions are the Animate tab's.

- **IK targets** (the sidebar, under the tree): **+** makes one for the selected instance (the tip). Its channels are named
  after it: `<name>` (the target, a position), `<name>.swivel`, `<name>.weight`. Its inspector sets the name (carried through the rest
  pose and the open animation), **tip** and **aim** (look at the target instead of reaching it: a
  head), and shows its **root**, which the engine finds (`mech.ik_root`: below the nearest branch
  above the tip, a pelvis or a torso). It reaches with the tip's end (`mech.ik_end`: a hand's
  fingertips, a foot's sole), a foot's own joints hold its facing (planted, it stays as the clip
  angles it), a hand's keep their turns, and the pole the chain bends toward is worked out
  (`mech.ik_pole`), so there is nothing else to set; its swivel turns it round the limb when a
  pose wants (drag the pole in the view). **Try it at the tip** puts the pose test's
  target on the tip at full weight, to drag from there. ✕ deletes the target.

The **pose test** in the dock has a row per channel (the engine's list, its control by kind),
starting from the rest pose, to try the rig and check clearances: a joint's slider runs over its range, a position or
a rotation is one x/y/z row. It moves the view only, until **Set rest
pose** saves what it shows as the model's rest pose: the stance every clip starts from and adds
onto ([modeling.md](modeling.md#the-rest-pose)), one side for both when the two sides match (a
twin pose; the engine's `twins` query says which channel is whose twin). ↺ goes back to the rest
pose.

**Handles in the view** (Assemble and Animate): a diamond on the model's root, a dot on each IK
target, and a ring on each pole. Click a handle to select it: arrows move it along the model's axes (shift: 0.01 steps), and
the root's rings turn it (shift: 15° steps). Drag a pole round the limb to set its target's
**swivel** (`<name>.swivel`; shift: 15° steps): while its target is picked or it is dragged, a
dashed circle shows everywhere it can go (the engine's, query `handles`: `ring`), and it follows
the pointer to the nearest point of it. In the Assemble tab they set the pose test. In the
Animate tab they pose the motion shown: its picked move (else its first) changes its amounts so
the view shows what you dragged to, by the change over how much of them the move adds at the
playhead (a held motion: all of it). Dragging the other side of a twin move changes the amounts
it is the twin of. A drag is one undo step.
Three buttons at the top right show the IK targets and poles hidden, as points, or as points
with their names (remembered in this browser); the root's diamond always shows.

**Arcs in the view** (Animate): the arcs the motion shown puts positions on, each the curve the
engine samples through its points (query `motion`), on the rest pose; a twin's (mirrored) is
dashed. Click one to **edit** it (as picking it in the Arcs list does): the arc edited is drawn
where the motion puts it, else on its **shown on** position (query `arc`), with a numbered dot per
point. Drag a dot to move its point across the view (its depth kept; shift: 0.01 steps); that
picks it too (click a picked one to let it go), and the picked one's arrows move it along the
model's axes. Double-click its curve to add a point there; Delete removes the picked point (an
arc keeps two). Each is one undo step, and every move naming the arc follows. A point added or
removed keeps each move's timing along the arc: the shapes of the motions following it are
carried to the new points (point k is at k / (n − 1)), so the strike still lands on its impact.
A motion whose shape other moves follow too (amounts, poses, another arc) keeps its shape, and the
editor says so. The position follows the curve as the motion's shape says, so draw the path where
the arm can reach. Esc stops editing.

## Animate

A clip is motions ([animation.md](animation.md#motions)): shapes over time added onto channels, on
top of the rest pose. There are no key frames: a pose held is a motion with no shape, and a pose
at a moment is a shape stepping into it there.

- **Clips** in the sidebar. The editor edits one clip at a time. **+** adds an empty clip, ⧉
  duplicates it.
- **Arcs** (the sidebar, under Motions): the animation's arcs ([animation.md](animation.md#arcs)),
  shared by every clip, each with its points and how many moves name it. Click one to edit it
  (again, or Esc, to stop); **+** adds an open arc of two points and edits it; the bin deletes the
  one edited and the moves' values naming it (asking first when some do). Its inspector, while it
  is edited: its **name** (renamed through the moves naming it), **shown on** (the position it is
  drawn on when no move of the motion shown uses it), its **points** (the one picked in the view,
  else the last: typed in, **+** adds one after it, **−** removes it), **corner** (the picked
  point is sharp: the path turns hard there and runs straight to a corner next to it),
  **used by** (each move
  naming it: click to go there) and **+ assign to the picked move** (puts a position of the
  picked move on it).
- **Poses** (the sidebar, under Arcs): the animation's poses ([animation.md](animation.md#poses)),
  named sets of amounts shared by every clip, each with how many amounts it holds and how many
  moves add it. Click one to edit its **name** (renamed through the moves adding it) and its
  amounts (as a move's); the bin deletes it and the moves' values adding it. A pose is made from a
  move: **make pose** on an unfolded move.
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
  (cycles late) and **twin** (none; WITH: the other side of the body too, at the same time;
  OPPOSITE: half a cycle later, the other foot or arm). Click a move's head to pick it (the view's handles pose it), shift- or
  cmd-click to pick several. **Split** moves the picked moves into a new motion right after it,
  with the same shape; ✕ removes them; + adds a move (unfolded). Moves are folded, showing their
  channels' names; the caret unfolds one to edit its amounts (+ channel adds one at rest), the
  **poses** it adds (each how much of it; **+ pose** adds one; **make pose** makes the move's
  amounts a new pose the move adds instead), and the positions it puts on **arcs**: each lists the arc it follows (switch it), ✎ edits it, ✕ takes
  the position off it; **+ arc** puts another position (an IK target, the root) on the arc being
  edited, else on a new one.
- **The curve editor** (the dock) shows the motion picked as curves. Everything drawn comes from
  the engine (query `motion`), so it is what plays.
  - **Shape** (left): one cycle of the motion's shape, repeating. Dotted lines mark the values
    that put the motion's arcs on their points (labelled with them); shift-drag snaps onto them. Drag a point (shift snaps to
    0.05), click empty space to add one, double-click or Delete to remove it (Delete removes the
    arc point picked in the view first, if one is). The toolbar sets
    the selected point's ease (how it is reached from the point before: LINEAR, IN, OUT, SETTLE,
    STEP). **Hold, Sine, Slide, Lift, Pulse, Square, Bounce, Hit, Steps** start the shape over
    (the one it matches is lit). A one-shot (a pulse, a hit) is a shape that ends where it
    starts.
  - **Lanes** (right): what each move adds over the clip, one lane each, the picked moves lit; a
    twin move's twins show faint in its lane.
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
