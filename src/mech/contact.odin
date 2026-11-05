package mech

import "../mjolnir/animation"
import "../mjolnir/geometry"

// Ground contact: how an IK tip that stands on the ground at rest (RigIk.holds: a foot) meets it.
// Clips only move the tip's target; mjolnir's foot solve (animation.foot_measure, foot_solve,
// foot_conform: its facing exact, its rest angle to the limb kept, its ball and toes following its
// heel by the trail, resting on the ground heel to toe and rolling on its edge as the leg runs out
// of reach) places it, measured from the corners of the pieces each of its bones carries. The ground
// is y = 0 in the frame node's space.

// contact_measure reads, from the rest pose (unlifted: the ground then at -lift), what ground
// contact needs of IK `ik` (holds, with own joints): its foot (RigIk.foot), its pieces' corners
// appended to rig.corners and the joints below it to rig.conforms.
@(private)
contact_measure :: proc(rig: ^Rig, ik: ^RigIk) {
  if ik.aim || ik.turning >= ik.count do return
  corners := make([dynamic]animation.BoneCorner, context.temp_allocator)
  for p in rig.pieces do for c in primitive_corners(p.primitive) do append(&corners, animation.BoneCorner{u32(p.bone), geometry.transform_point(p.place, c)})
  ik.foot = animation.foot_measure(rig_skeleton(rig), rig.chains[ik.first:][:ik.count], ik.leg, corners[:], &rig.corners, &rig.conforms, -rig.lift)
}

// contact_solve poses IK `ik`'s chain for `target` (where its end goes, in the frame node's space;
// its ball's and its toes' trailing it by `trail` and `toes_trail`), its knee swung by `swivel`, the
// model turned as `origin` is; `toes` is how far up its toes stand, for contact_conform.
@(private)
contact_solve :: proc(rig: ^Rig, ik: RigIk, target, trail, toes_trail: [3]f32, swivel: f32, origin: geometry.Transform) -> (toes: f32) {
  return animation.foot_solve(rig_skeleton(rig), rig.chains[ik.first:][:ik.count], ik.leg, ik.foot, rig.corners[:], rig.conforms[:], target, trail, toes_trail, swivel, origin.rotation)
}

// contact_conform lays IK `ik`'s joints below its tip (toes) on the ground, the first `up` from
// level (contact_solve's toes).
@(private)
contact_conform :: proc(rig: ^Rig, ik: RigIk, up: f32 = 0) {
  animation.foot_conform(rig_skeleton(rig), ik.foot, rig.corners[:], rig.conforms[:], up)
}
