package mech

import "core:math"
import "../mjolnir/geometry"
import "../mjolnir/render"

// Every piece of every model is a primitive, so the meshes are few: one per primitive kind and
// parameter, shared by every rig the Library builds. Materials are shared the same way, one per
// distinct paint. The renderer groups nodes drawing one mesh with one material into a single
// instanced draw (or one multi-draw on Vulkan), so a crowd of mechs costs about as many draws as
// one. docs/rendering.md lists what a renderer built for primitives could do beyond this.
Library :: struct {
  meshes:    map[MeshKey]render.MeshHandle,
  materials: map[Paint]render.MaterialHandle,
}

@(private)
Paint :: struct {
  color:                         [3]f32,
  metallic, roughness, emissive: f32,
}

@(private)
MeshKey :: struct {
  primitive: Primitive,
  param:     i32, // the shape's param in thousandths
}

library_destroy :: proc(lib: ^Library, r: ^render.Renderer) {
  for _, h in lib.meshes do render.mesh_destroy(r, h)
  for _, h in lib.materials do render.material_destroy(r, h)
  delete(lib.meshes)
  delete(lib.materials)
  lib^ = {}
}

// library_mesh is the shared mesh for a primitive with `param`, made on first use.
library_mesh :: proc(lib: ^Library, r: ^render.Renderer, primitive: Primitive, param: f32) -> (h: render.MeshHandle, ok: bool) {
  key := MeshKey{primitive, 0}
  if primitive != .BOX && primitive != .CYLINDER && primitive != .SPHERE do key.param = i32(math.round(clamp(param, 0, 1) * 1000))
  if cached, found := lib.meshes[key]; found do return cached, true
  p := f32(key.param) / 1000
  g: geometry.Mesh
  switch primitive {
  case .BOX:
    g = geometry.make_cube()
  case .WEDGE:
    g = geometry.make_wedge(p)
  case .CYLINDER:
    g = geometry.make_cylinder(segments = 24, height = 1)
  case .HALF_CYLINDER:
    g = make_arc(16, math.PI, p)
  case .QUARTER_CYLINDER:
    g = make_arc(10, math.PI / 2, p)
  case .CONE:
    g = geometry.make_cone(segments = 24, height = 1, top_radius = p)
  case .SPHERE:
    g = geometry.make_sphere()
  }
  h = render.mesh_create(r, g) or_return
  lib.meshes[key] = h
  return h, true
}

// make_arc is a slice `arc` radians round of a unit cylinder along y (radius 1, height 1), its
// top narrowed by `taper` (0 = a cylinder, 1 = a point, as a wedge's front drops), its cut ends
// closed: a half or quarter cylinder, or a cone's slice.
@(private)
make_arc :: proc(segments: u32, arc, taper: f32) -> geometry.Mesh {
  top_r := 1 - taper
  slope := [2]f32{1, taper} / math.sqrt(1 + taper * taper)
  side := [2]geometry.ProfilePoint{{{top_r, 0.5}, slope, 0}, {{1, -0.5}, slope, 1}}
  top := [2]geometry.ProfilePoint{{{0, 0.5}, {0, 1}, 0}, {{top_r, 0.5}, {0, 1}, 0}}
  bottom := [2]geometry.ProfilePoint{{{1, -0.5}, {0, -1}, 0}, {{0, -0.5}, {0, -1}, 0}}
  strips := [3][]geometry.ProfilePoint{side[:], bottom[:], top[:]}
  return geometry.make_lathe(strips[:3 if top_r > 0 else 2], segments, arc, close = true)
}

// library_material is the shared material for a paint; the name does not matter.
library_material :: proc(lib: ^Library, r: ^render.Renderer, m: Material) -> (h: render.MaterialHandle, ok: bool) {
  key := Paint{m.color, m.metallic, m.roughness, m.emissive}
  if cached, found := lib.materials[key]; found do return cached, true
  c := m.color
  h = render.material_create(r, render.make_material(base_color_factor = {c.r, c.g, c.b, 1}, metallic_factor = m.metallic, roughness_factor = m.roughness, emissive_factor = m.emissive)) or_return
  lib.materials[key] = h
  return h, true
}

// primitive_scale is the node scale that stretches a primitive's unit mesh to `size`. The unit
// meshes: the box and wedge span -1..1, round shapes have radius 1 and height 1 (-0.5..0.5).
primitive_scale :: proc(p: Primitive, size: [3]f32) -> [3]f32 {
  switch p {
  case .BOX, .WEDGE, .SPHERE:
  case .CYLINDER, .HALF_CYLINDER, .QUARTER_CYLINDER, .CONE:
    return {size.x / 2, size.y, size.z / 2}
  }
  return size / 2
}

// primitive_corners are the corners of a primitive's unit mesh: the box, wedge and sphere span
// -1..1, round shapes -1..1 across and -0.5..0.5 along y.
primitive_corners :: proc(p: Primitive) -> (corners: [8][3]f32) {
  h := [3]f32{1, 1, 1}
  #partial switch p {
  case .CYLINDER, .HALF_CYLINDER, .QUARTER_CYLINDER, .CONE:
    h.y = 0.5
  }
  for &c, i in corners do c = {h.x if i & 1 != 0 else -h.x, h.y if i & 2 != 0 else -h.y, h.z if i & 4 != 0 else -h.z}
  return
}
