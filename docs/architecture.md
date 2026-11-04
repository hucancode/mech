# Architecture

One implementation of mechs, shared by the game and every tool. Tools never re-implement
parsing, posing, sampling or rendering. They send data in and ask questions.

```
            src/mech            the engine: model and animation formats, rigs, joints,
               │                clip sampling, the shared primitive library (mjolnir render)
            src/character       Character / Action, MechAsset, the Mech character
          ┌────┴──────────┐
       src/ (game)     src/viewer          one character on a stage; native, and wasm
                          │ wasm exports (JSON in, JSON out)
               tools/character-editor      browser UI (plain JS) + a Node server, no packages
```

| package | what it is | builds for |
| --- | --- | --- |
| `src/mech` | the engine. `model_parse`/`format` and `animation_parse`/`format` work anywhere; `files.odin` adds file I/O natively | native, wasm |
| `src/character` | the game's character interface and the mech character; `asset_from_text` everywhere, `asset_load` (a character file) natively | native, wasm |
| `src` | the game's test scene | native |
| `src/viewer` | a stage showing one character, driven by data | native (`make viewer`), wasm (`make web`) |
| `tools/character-editor` | the character editor: model, rig and animation; saves in the browser, imports and exports files | the browser, served by `server.mjs` (read-only over `assets/`) |

## The viewer bridge

The browser runs `src/viewer` as wasm (mjolnir's web target: WebGPU, built with atomics, so the
page is cross-origin isolated). The page writes UTF-8 into buffers from `viewer_alloc` and
calls exports between frames (`src/viewer/web.odin`):

| export | does |
| --- | --- |
| `viewer_set_model(text)` | parse a model and rebuild the mech |
| `viewer_set_animation(text)` | parse an animation and recompile the clips (after every edit) |
| `viewer_set_values({name: value})` | hold explicit channel values (a number or `[x, y, z]`, as the channel is shaped), the rest at the rest pose (the pose test) |
| `viewer_play(clip, time, playing, speed, loops)` | show a clip |
| `viewer_select(part, shape, isolate)` | outline an instance's shapes (by its index in the assembly: both sides of the body) and draw its frame; `isolate` hides the rest, showing the side as written |
| `viewer_explode(amount)` | push the isolated part's shapes apart (0 to 1) |
| `viewer_frame()` | frame the camera on the character |
| `viewer_view(view)` | look from a side, framed and orthographic: 1 +x, 2 -x, 3 +y, 4 -y, 5 +z, 6 -z; 0 the free perspective orbit (turning the view goes back to it) |
| `viewer_time()` | the playhead |
| `viewer_format_character()` | the character file's text, as the game's tools write it |
| `viewer_query(json)` | answer a question (below) |

Text answers go into one result buffer: the export returns its address and `viewer_result_len()`
returns its length. The page's wrapper is `tools/character-editor/web/js/viewer.js`.

## Queries

`viewer_query` takes a JSON question and answers in JSON, from the same code the game runs
(`src/viewer/query.odin`). Answers never change what the viewer shows. The editor uses them for
its curves, for posing on screen, and for warnings. Add a query there when a tool needs
to know something the engine computes.

| query | answers |
| --- | --- |
| `{"q":"state"}` | the clock, every channel's values as shown (`values`), warnings since last asked |
| `{"q":"sample","clip":"walk","channels":[..],"n":60}` | channels' values over a clip (or at `"times"`) |
| `{"q":"pose","clip":"attack","time":0.4}` | every channel at one moment, `values` |
| `{"q":"parts","clip":..,"time":..,"rest":true,"parts":[..]}` | instances' frames in the world (metres, quaternions), by placed name (`l_arm`) and by an instance's own name (`arm`: its left side); `rest`: the rest pose |
| `{"q":"places"}` | what the model places (`mech.model_places`): `[{name, inst, side}]`, an instance once (NONE) or on each side of the body (L, R) |
| `{"q":"trajectory","clip":"walk","part":"l_foot","n":60}` | an instance's path over a clip (foot slide, motion paths) |
| `{"q":"motion","clip":"walk","motion":1,"n":120}` | a motion as the engine reads it: its shape over one cycle, and each move's channels, delay, what it adds over the clip, the arcs it puts positions on, and a spread move's later links |
| `{"q":"arc","arc":"step","on":"l_leg"}` | an arc as it would put a position, in metres (editing an arc no shown motion uses) |
| `{"q":"channels"}` | every channel: name, kind (HINGE, SLIDE, BALL, POSITION, WEIGHT), size, range |
| `{"q":"pick","x":..,"y":..}` | the piece under a point: its instance (index in the assembly, either side) and shape |
| `{"q":"bounds","clip":..,"time":..}` | the box around the posed character |
| `{"q":"camera"}` | the main camera's rotation and the view it is in (the view gizmo) |
| `{"q":"info"}` | parts, bones, pieces, shared meshes and materials, clips |
| `{"q":"check","character":"<text>"}` | what `mech.character_check` finds wrong with a character's data (not what is shown): `[{severity, text, at}]`, `at` a `mech.Path`, where to go to fix it |
| `{"q":"refs","character":"<text>"}` | every place a name is written (`mech.references`): `[{ptr, key, def, span, to, at}]`: a JSON pointer into the file's data, whether the name is a map key there, the thing's own name or not, where the name sits in what is written (a channel's name holds its instance's and its joint's), the `mech.Path` it names and the one it is written in. The editor renames, deletes and says what uses what by them, one way for every kind of thing |
| `{"q":"schema"}` | the names the formats use, from the engine's types (`mech.schema_format`): each enum's names, the side prefixes, the root's and IK targets' channel names, values per channel kind, the budgets; the page reads it rather than keep a copy |

From the browser console: `editor.viewer.query({q: "trajectory", clip: "walk", part: "l_foot", n: 8})`.

## Keeping it that way

- New engine behaviour goes in `src/mech` or `src/character`. The game and the editor get it
  together.
- Things are addressed one way everywhere: a `mech.Path` (`src/mech/paths.odin`; a kind, and the
  names and indices that pick the thing out: a part's joint, a clip's motion's move). Issues say
  where they are by one, references say what they name and where they are written, and the editor
  goes to things by them (`editor.goto`).
- What is wrong with a character is said in one place, `mech.character_check`
  (`src/mech/check.odin`): ERRORs (data the engine can't use) and BUDGET issues (a clip fighting
  the machine). The rest of the engine skips what it can't use quietly. `asset_compile` logs the
  issues, so the editor shows them under ⚠; `test_assets_check` keeps the shipped characters free
  of ERRORs.
- The browser side holds data and UI only: `web/js/model.js` has tree and name helpers, nothing
  the engine computes, and no copy of the engine's names (enums, side prefixes): it reads them
  from the `schema` query. The curve editor draws what the `motion` query samples.
- JS dependencies: none. The page is plain ES modules with JSDoc types, and the server uses Node's
  built-ins.
- The page's UI core is its own (`web/js/ui/`):
  - `vdom.js`: panels describe what they show with `h()`; `render()` makes a container show it, reusing the elements already there (by `key`, else by position). Panels just draw again from the data whenever anything changes: a field being typed in keeps its text and focus, a list its scroll. Widgets that hold state between draws (a number being scrubbed, a slider, a section's fold) are components with `useState`/`useRef`. What is made once and kept (the curve editor's canvas, a dialog) is a real element from `el()`.
  - `signal.js`: `signal`, `computed`, `effect`, `batch`. The editor's `rev` (data, selection, status) redraws the panels once a frame; `clock` (the playhead) the player and the curves; `sent` (data given to the viewer) refreshes the engine's lists it caches (`channels`, `places`, `twins`), asked once per version rather than per row.
- `make test` runs the editor's tests too (`node --test tools/character-editor/web/js/test`): the UI core, and a smoke test drawing every tab of the shipped mech over a small fake DOM (`test/fakedom.js`), no browser needed.
