# Rendering primitive-only models

**Every model this engine builds is made of seven primitives**: box, wedge, cylinder, half and
quarter cylinder, cone, sphere ([modeling.md](modeling.md#shapes)). Joint hardware uses the same
set. No model carries a custom mesh, and a piece never deforms: it's a rigid primitive riding one
bone. The renderer can exploit that.

## What we exploit today

- **One mesh per primitive, shared.** `mech.Library` (`src/mech/primitives.odin`) makes each
  primitive mesh once per kind and parameter (a wedge's taper, a cone's top radius, in
  thousandths) and shares it across every rig. The mech uses 7 meshes for 210 pieces. Before
  this, every mech built its own copies.
- **One material per paint, shared.** Materials are cached by value, so every mech painted the
  same shares them.
- **Batched draws.** mjolnir already groups nodes that draw one mesh with one material: one
  instanced indirect draw per (mesh, material) batch on WebGPU, one multi-draw on Vulkan
  (`render/batches.odin`, `render/pass_cull.odin`). With the meshes and materials shared, a whole
  crowd of mechs is roughly (primitives × paints) draws, not (pieces × mechs).
- **The same renderer everywhere.** The character editor's preview is the game's renderer (mjolnir
  on WebGPU, in wasm), so these points hold there too, and what you see is what the game draws.
- **Posing writes bones, not pieces.** Pieces are child nodes of their bone, so a pose writes one
  transform per bone (51 for the mech), and the scene graph carries the 210 pieces.

## What a primitive-aware renderer could do later

Ordered roughly by payoff:

1. **Analytic primitives in the vertex shader.** Draw every primitive from one tiny vertex
   pattern (or a single unit cylinder and unit box) and generate the shape from per-instance
   parameters: kind, param, scale. Mesh count, vertex memory and batch count all collapse, and a
   wedge or cone parameter no longer forks a new mesh.
2. **Bone-space instance data on the GPU.** Upload one matrix per bone per frame, plus a static
   per-piece record (bone index, local transform, primitive, material) uploaded once. The vertex
   shader composes `bone × local`. That removes the per-piece scene nodes and world-matrix
   updates entirely: the CPU cost of a mech becomes its bone count.
3. **Exact culling and shadow bounds.** Primitive bounds are known in closed form, so a rig's
   bounds come from its bones and pieces cheaply (`rig_bounds` already does this on the CPU).
   Whole rigs can be culled before their pieces are considered.
4. **Level of detail by tessellation.** Round primitives can drop segments with distance (24 →
   8 around a cylinder) because the shape is parametric. Small pieces (pins, knuckles) can be
   dropped entirely at range.
5. **Signed distance fields.** Every primitive has a cheap exact SDF. That opens up raymarched
   ambient occlusion and soft shadows between pieces, exact contact shadows on the ground, or
   selection picking with no mesh raycasts.
6. **Material as palette index.** Paints are a handful of flat PBR values. A per-instance palette
   index into a small buffer would let every mech share one material: one batch per primitive
   for the whole scene, and recolouring without touching the material table.
7. **Static merging per bone.** Pieces on one bone never move relative to each other, so a rig
   could bake each bone's pieces into one mesh at load time. That trades the shared-mesh benefit
   for fewer nodes, and is worth it for many-piece bones viewed close up.

Points 1, 2 and 6 together would make a mech's draw cost independent of its piece count. The
data needed for all of them is already in `Rig.pieces` (bone, primitive, place).
