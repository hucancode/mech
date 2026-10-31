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
| New | a new character with one part and one material |
| Import | open a character file (`<name>.json`); it is saved here |
| Export | download `<name>.json`, written by the engine's own writer |

To put a character in the game, export it and copy the file into `assets/characters/`.

## Everywhere

| | |
| --- | --- |
| Cmd/Ctrl-S | save in this browser (a dot by the save button means unsaved changes) |
| Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z | undo, redo (a drag or a slider move is one step) |
| 1, 2, 3 | Model, Rig, Animation tabs |
| F, frame button (top right of the view) | frame the character (the isolated part while isolating) |
| H, isolate button (top right of the view, model tab) | show only the selected part; an explode slider appears beside it |
| I, inspector button (top right of the view) | hide or show the inspector (the right panel); remembered |
| dock span toggles (right end of the dock bar) | let the timeline or pose test run under the left panel, the right panel, or both; remembered |
| Esc | clear the selection: the inspector shows the character's settings (Model, Rig) |
| drag / scroll in the view | orbit / zoom |
| click in the view (model, rig) | select the part and shape under the pointer |
| W, E, R, T (model tab), or the tool buttons at the top right of the view | the view's handles: move, turn, size the selected shape; bolt the part onto its parent |

- Number fields: type a value, use the arrow keys (shift for 10×), or drag the x/y/z label
  (shift for fine, alt for coarse).
- Angles are shown and typed in **degrees**: shape rotations, and the ranges, driver ends and
  pose values of channels a joint turns by. Files keep radians.
- Exports are written by the engine's own writer, so copying one over an asset only diffs where
  you changed something.
- Warnings from the engine (a key naming a channel the model lacks, and so on) collect under ⚠
  in the header.

## Model

- **Character settings** show in the inspector when nothing is selected (Esc clears the
  selection): name, stand-on-the-ground, and the materials joint hardware is painted in.
- **Parts**: the part tree.
  - **+ child** adds a part under the selection, bolted to the bottom face of its first shape and
    sized from it; **+ root** adds a free-standing one.
  - **⇋ mirror** copies the selected part's limb (from the topmost `l_`/`r_` part, or
    `left`/`right`) to the other side of the body, replacing what is there. The copy gets the
    other side's names and channels (made when missing), its drivers and legs, and keeps its rest
    orientation (a left foot pointing ahead gives a right foot pointing ahead). Wedges, cones and
    part cylinders that are not symmetric across the limb may need turning by hand.
  - **kit** adds any part of any character (this one, those saved here and those in assets/),
    with what hangs from it, under the selection: its joints, materials, channels, drivers and
    legs come along, it can be scaled on the way in, and it bolts onto the face that best matches
    where it hung before.
  - ⧉ duplicates a part without its children; ✕ deletes it and everything under it.
  - Drag a part onto another to hang it there, or onto "make root". The tree stays parents first.
- **The selected part**:
  - name (renaming updates its children), **scale** (grows or shrinks its shapes, its mount and
    where its children bolt on, in one step) and parent
  - its **joint** (a joint from the list, a **new** one from a preset sized to the parent's shape,
    or fixed) and pivot-on-the-socket
  - its **socket** (a face on the parent, where the joint bolts on) and **mount** (its own face on
    the joint), each a position plus normal and forward picked from the six axes. **snap to**
    puts the socket on one of the six faces of a parent shape (the one it sits on is lit);
    **inset** moves the next snap in toward the shape's centre.
  - its **shapes**: primitive, taper or top radius, material, position, rotation (degrees) and
    size (the full extent; for round shapes x and z are the diameter)
- **Joints**: the hardware joining parts. **+** adds a hinge sized to the selected part. A
  **preset** (hinge, elbow, shoulder, wrist, knuckle, ball, spin) sets the kind and proportions;
  **size** scales every dimension at once; the raw fields are under "details". Renaming carries
  through to the parts.
- **Materials**: colour, metallic, roughness, emissive. Renaming carries through to shapes and
  hardware.

**Handles in the view** edit the selected shape and part directly; a drag is one undo step:
- **move** (W): arrows along the part's axes. Shift snaps to 0.01.
- **turn** (E): rings about the part's axes. Shift turns in 15° steps.
- **size** (R): boxes along the shape's own axes size it both ways from its centre; the middle box
  sizes it all (drag right or up). Shift snaps to 0.01.
- **socket** (T): a dot on each face of the parent's shapes that faces you; click one to bolt the
  part there. The socket's face is lit, and a ring marks the socket.

The view shows the character at rest; this tab has no dock. The selected part's shapes are
outlined (the selected shape in white), with its frame drawn as RGB axes.

**Isolate** (H, or the button at the top right of the view) shows only the selected part's shapes,
and F frames them. While isolating, the **explode** slider beside it pushes the shapes apart, each
out from the middle of the part (double-click it to put them back). Both are view aids, never
saved.

## Rig

- **A part**: a **bind** per axis its joint turns about (the joint is set in the Model tab). Pick a
  channel, and ±1 mirrors it on this side.
- **Channels**: name, slider range (degrees for channels a joint turns by), and the parts using it. Renaming carries
  through the model and the open animation.
- **Drivers**: target, source, the source range and what it maps to, clamp, with a preview of the
  mapping.
- **Legs**: hip, knee and ankle channels for leg IK, and the pelvis level channel.

The **pose test** in the dock (this tab only) has a slider per channel to try the joints. It moves the view only
and is never saved.

## Animation

- **Clips** and **poses** in the sidebar. A pose is any set of channels; selecting one previews
  it on the rest pose, and its inspector lists its channels (remove one with ×, add one with
  "+ channel").
- **Timeline** (the dock):
  - **Ruler**: click or drag to scrub.
  - **Bars**: one row per key frame, a bar from `at` across `duration` (a diamond when it snaps),
    coloured by priority, with its ease drawn inside; `+` marks an additive key. Drag a bar to
    move it, drag its right edge to retime it, alt-drag to duplicate it.
  - **Selection**: click selects, shift-click adds, dragging on empty rows box-selects.
    Double-click a key to play from it.
  - **Curves**: the selected key's channels are drawn over the whole clip, sampled by the engine.
    "curves: as keyed" or "as shown" picks before or after drivers and leg IK.
- **Toolbar**:
  - play/pause (space), loop, speed, the clip length
  - **+ Key** adds an empty key at the playhead
  - **◆ Key pose…** keys what the view shows now, choosing the channel groups
  - ⧉ (Cmd-D) duplicates the selected keys, ✕ (Delete) deletes them
  - Cmd-C / Cmd-V copy and paste keys at the playhead
- **Key inspector**: at, duration, ease, blend, priority and pose (optional), then:
  - **Pose (shared)**, when the key plays a pose: the pose's channels, edited in place. A change
    is to the pose itself, so every key playing it, in every clip, changes (the count shows how
    many). **demote** copies the pose into the key's own values and drops the reference: the
    clip plays the same and stops following the pose.
  - **Key values (this clip only)**: the key's own channels, applied after its pose. **capture**
    sets them to what the view shows; "+ channel" adds one at its value now; **promote** makes
    them a named pose (merged over the pose the key played) that the key then plays.

## Not there yet

- Turning joints by dragging in the view (the pose test's sliders do it).
- Onion skin and motion paths in the view (`trajectory` queries already answer them).
- A graph editor for curves (they are read-only).
