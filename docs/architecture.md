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
| `viewer_set_values({name: value})` | hold explicit channel values (the pose test) |
| `viewer_play(clip, time, playing, speed, loops)` | show a clip |
| `viewer_show_pose(pose)` | show a pose |
| `viewer_select(part, shape, isolate)` | outline a part's shapes and draw its frame; `isolate` hides the rest |
| `viewer_explode(amount)` | push the isolated part's shapes apart (0 to 1) |
| `viewer_frame()` | frame the camera on the character |
| `viewer_time()` | the playhead |
| `viewer_format_character()` | the character file's text, as the game's tools write it |
| `viewer_query(json)` | answer a question (below) |

Text answers go into one result buffer: the export returns its address and `viewer_result_len()`
returns its length. The page's wrapper is `tools/character-editor/web/js/viewer.js`.

## Queries

`viewer_query` takes a JSON question and answers in JSON, from the same code the game runs
(`src/viewer/query.odin`). Answers never change what the viewer shows. The editor uses them for
its curves, for keying the pose on screen, and for warnings. Add a query there when a tool needs
to know something the engine computes.

| query | answers |
| --- | --- |
| `{"q":"state"}` | the clock, every channel as shown (after drivers and leg IK), warnings since last asked |
| `{"q":"sample","clip":"walk","channels":[..],"n":60,"solved":true}` | channel values over a clip (or at `"times"`); `solved` applies drivers and leg IK |
| `{"q":"pose","clip":"attack","time":0.4}` or `{"q":"pose","pose":"ready"}` | every channel at one moment, `raw` and `solved` |
| `{"q":"parts","clip":..,"time":..,"parts":[..]}` | parts' frames in the world (metres, quaternions) |
| `{"q":"trajectory","clip":"walk","part":"l_foot","n":60}` | a part's path over a clip (foot slide, motion paths) |
| `{"q":"bounds","clip":..,"time":..}` | the box around the posed character |
| `{"q":"info"}` | parts, bones, pieces, shared meshes and materials, clips, channels nothing moves |

From the browser console: `editor.viewer.query({q: "trajectory", clip: "walk", part: "l_foot", n: 8})`.

## Keeping it that way

- New engine behaviour goes in `src/mech` or `src/character`. The game and the editor get it
  together.
- The browser side holds data and UI only: `web/js/model.js` has tree and name helpers, nothing
  the engine computes. The timeline draws ease shapes inside key bars, but its curves come from
  `sample`.
- JS dependencies: none. The page is plain ES modules with JSDoc types, and the server uses Node's
  built-ins.
