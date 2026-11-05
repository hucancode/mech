package mech

import "core:math"
import "core:math/linalg"
import "../mjolnir/animation"
import "../mjolnir/geometry"

// Ground contact: how an IK tip that stands on the ground at rest (RigIk.holds: a foot) meets it.
// Clips only move the tip's target; three rules then place the tip, all measured from its pieces:
//
//   1. Its facing is exact: the tip is placed first, the chain reaches its pivot (the tip's first
//      own joint), then the tip's own joints turn it to that facing, within their stops.
//   2. It keeps its rest angle to the limb: the facing its channels give it (the rest pose, plus
//      any turns a clip writes on its own joints), swung as the line from the chain's root to the
//      target swings from where it was at rest. A leg reaching ahead tips its toes up, one under
//      the body stands flat, one behind tips them down. Its ball and toes follow its heel on
//      the ground, in every clip (IK_TRAIL, clip_sample): its ball stands as high as its target
//      stood the FOLLOW before, its toes turn as it turned the FOLLOW before that, so rising its
//      heel lifts first and its toes stay flat, landing its heel comes down first and its ball, then
//      its toes, still up, come down after it (contact_solve). A still pose has no trail.
//   3. It rests on the ground: tipped about the corner of its own pieces it then stands on (its
//      lowest), so nothing of it goes through the ground and, ahead, it lands on its heel and the
//      ground lays it flat; behind it stands flat too (tipping toes down, about its toes' tips, only
//      as a target lifting lets it). Its heel lifts as the chain runs out of reach: nearing the
//      furthest the chain reaches its pivot (ik.stretch) it rolls on the edge toward the chain, as
//      little as keeps the pivot within reach, the toes flat; pulled further (out of rolls, or a
//      reach that way shorter) the chain lifts it off the ground, toes and all.
//      Joints below the tip (toes) lie flat on the ground as they near it, and never go through.
//
// The heel, the ball and the toes are not named anywhere: they are the corners the tip turns on.

// RigConform is a joint below a contact tip (a toe on a foot): bone `bone` turning about `axis`,
// with its pieces' corners rig.corners[first:][:count] in the bone's frame. `down` is the
// world's down at rest, in the bone's frame (level: it points down again); `height` is how tall
// its corners stand at rest, the height over the ground at which it starts lying down.
RigConform :: struct {
  bone:         int,
  axis:         int,
  first, count: int,
  down:         [3]f32,
  height:       f32,
}

// contact_measure finds, from the rest pose, what ground contact needs of IK `ik` (holds, with own
// joints): where it reaches with (`end`) and its pivot (`pivot`), in its tip bone's frame; the way
// from its chain's root to its end (`reach`) and how the tip faces (`face`), in the model's space,
// and its own joints' turns then (`own`); its own pieces' corners; and the joints below it that lie
// down on the ground.
@(private)
contact_measure :: proc(rig: ^Rig, ik: ^RigIk) {
  if ik.aim || ik.turning >= ik.count do return
  chain := rig.chains[ik.first:][:ik.count]
  tip := int(chain[ik.count - 1])
  into :: proc(rig: ^Rig, bone: int, p: [3]f32) -> [3]f32 {
    return linalg.mul(linalg.quaternion_inverse(rig.rotations[bone]), p - rig.positions[bone])
  }
  ik.face = rig.rotations[tip]
  ik.own = linalg.QUATERNIONF32_IDENTITY
  for b in chain[ik.turning:] do ik.own *= rig.local[b].rotation
  ik.end = into(rig, tip, ik_point(rig, ik^))
  ik.pivot = into(rig, tip, rig.positions[chain[ik.turning]])
  ik.reach = linalg.normalize0(ik_point(rig, ik^) - rig.positions[chain[0]])
  ik.corners_first = len(rig.corners)
  // (every piece its bone carries: a hinge's lugs ahead of it too)
  for p in rig.pieces do if p.bone == tip {
    for c in primitive_corners(p.primitive) do append(&rig.corners, geometry.transform_point(p.place, c))
  }
  ik.corners_count = len(rig.corners) - ik.corners_first
  // the bones below the tip's, parents first
  below := make([]bool, len(rig.bones), context.temp_allocator)
  below[tip] = true
  ik.conform_first = len(rig.conforms)
  for b in rig.order {
    p := rig.parents[b]
    if p < 0 || !below[p] do continue
    below[b] = true
    turns, _, _ := rig_turns(rig, int(b))
    if turns == {} do continue
    cf := RigConform{bone = int(b), first = len(rig.corners)}
    for axis in turns {
      cf.axis = int(axis)
      break
    }
    lo, hi := f32(math.F32_MAX), f32(-math.F32_MAX)
    for p in rig.pieces do if p.bone == int(b) {
      for c in primitive_corners(p.primitive) {
        at := geometry.transform_point(p.place, c)
        append(&rig.corners, at)
        y := (rig.positions[b] + linalg.mul(rig.rotations[b], at)).y
        lo, hi = min(lo, y), max(hi, y)
      }
    }
    cf.count = len(rig.corners) - cf.first
    if cf.count == 0 do continue
    cf.down = linalg.mul(linalg.quaternion_inverse(rig.rotations[b]), [3]f32{0, -1, 0})
    cf.height = max(hi - lo, 1e-3)
    append(&rig.conforms, cf)
  }
  ik.conform_count = len(rig.conforms) - ik.conform_first
  for cf in rig.conforms[ik.conform_first:][:ik.conform_count] do ik.toes += into(rig, tip, rig.positions[cf.bone]) - ik.pivot
  ik.toes = linalg.normalize0(ik.toes)
  // how far ahead of its heel (its corner furthest back, level) its first joint below it (the ball)
  // is: the lever its ball follows its heel on
  if ik.conform_count > 0 {
    ball := rig.positions[rig.conforms[ik.conform_first].bone]
    if way := linalg.mul(rig.rotations[tip], ik.toes); way.xz != 0 {
      way.y = 0
      way = linalg.normalize(way)
      for c in rig.corners[ik.corners_first:][:ik.corners_count] do ik.span = max(ik.span, linalg.dot(ball - (rig.positions[tip] + linalg.mul(rig.rotations[tip], c)), way))
    }
  }
  // the furthest its chain reaches from its root to its pivot, within its stops: pulled out the way
  // it reaches at rest a little at a time, each pull from the last, so it unfolds the way it folds
  // (then put back as it was)
  {
    reaching := chain[:ik.turning + 1]
    kept := make([]geometry.Transform, len(reaching), context.temp_allocator)
    for b, k in reaching do kept[k] = rig.local[b]
    root := rig.positions[chain[0]]
    way := linalg.normalize0(rig.positions[chain[ik.turning]] - root)
    pose := rig_skeleton(rig)
    rest := linalg.length(rig.positions[chain[ik.turning]] - root)
    furthest := rest
    for _ in 0 ..< 40 {
      animation.ik_solve(pose, reaching, {target = root + way * (furthest + 0.02 * ik.length), iterations = 16})
      far := linalg.length(rig.positions[chain[ik.turning]] - root)
      if far < furthest + 1e-4 * ik.length do break
      furthest = far
    }
    // its heel starts up a little before that: no nearer than it stands at rest (flat)
    ik.stretch = {max(rest, furthest - 0.05 * ik.length), furthest}
    for b, k in reaching do rig.local[b] = kept[k]
    moved := make([]bool, len(rig.bones), context.temp_allocator)
    moved[rig.parents[chain[0]]] = true
    animation.pose_propagate(pose, moved)
  }
  // it rolls on an edge as far as the joints below it can turn back to lie on the ground
  ik.roll = 1.2
  for cf in rig.conforms[ik.conform_first:][:ik.conform_count] {
    l := rig.limits[cf.bone]
    if l.lo[cf.axis] > -math.F32_MAX do ik.roll = min(ik.roll, abs(l.lo[cf.axis]), abs(l.hi[cf.axis]))
  }
}

// contact_solve poses IK `ik`'s chain for `target` (where its end goes, in the frame node's space;
// its ball's and its toes' trailing it by `trail` and `toes_trail`); `toes` is how far up its toes
// stand from lying on the ground, following (contact_conform)
// by the contact rules above: its pose (rig_skeleton) composed by the drives.
@(private)
contact_solve :: proc(rig: ^Rig, ik: RigIk, target, trail, toes_trail: [3]f32, swivel: f32, origin: geometry.Transform) -> (toes: f32) {
  chain := rig.chains[ik.first:][:ik.count]
  tip := int(chain[ik.count - 1])
  pivot := int(chain[ik.turning])
  corners := rig.corners[ik.corners_first:][:ik.corners_count]
  pose := rig_skeleton(rig)
  // the limb first swung whole toward the target by the joints above its middle one (within their
  // stops), its shape kept: the solve then starts from the way of folding it ends near, the one the
  // target leads it to, and never jumps between two as the target moves
  if ik.mid > 1 {
    upper := chain[:ik.mid]
    last := int(upper[len(upper) - 1])
    end := rig.positions[tip] + linalg.mul(rig.rotations[tip], ik.end)
    animation.ik_solve(pose, upper, {
      target     = target,
      end        = linalg.mul(linalg.quaternion_inverse(rig.rotations[last]), end - rig.positions[last]),
      iterations = 8,
    })
    moved := make([]bool, len(rig.bones), context.temp_allocator)
    moved[chain[0]] = true
    animation.pose_propagate(pose, moved)
  }
  // 2. the facing its own joints' channels give it on the rest stance, swung with the limb (what
  // the chain above it is turned by is IK's to undo)
  own := chain[ik.turning:]
  turned := linalg.QUATERNIONF32_IDENTITY
  for b in own do turned *= rig.local[b].rotation
  facing := linalg.normalize(origin.rotation * ik.face * linalg.quaternion_inverse(ik.own) * turned)
  from := linalg.mul(origin.rotation, ik.reach)
  to := linalg.normalize0(target - rig.positions[chain[0]])
  swing := linalg.QUATERNIONF32_IDENTITY
  if to != 0 && linalg.dot(from, to) > -0.99 do swing = linalg.quaternion_between_two_vector3(from, to)
  // its toes follow its heel on the ground (`trail`, how far behind its target theirs is): they
  // stand as high over its end as its target stood the FOLLOW before, so rising its heel lifts first
  // and its toes stay down, and coming down it lands on its heel, toes still up, that roll down
  // after it. Its pitch (the swing's turn about its side) is then that, not the limb's, no further
  // than it rolls (past that its toes let go and follow), and the ground does not lay it flat: it
  // stands on whichever of its corners is down, heel or ball (below). It follows as its heel or its
  // toes near the ground, wholly on it, not at all once both stand as high as its toes can stay
  // down for (rolled as far as it rolls); in the air it keeps the limb's.
  follows := false
  if way := linalg.mul(facing, ik.toes); way.xz != 0 && trail != 0 && ik.span > 0 {
    way.y = 0
    side := linalg.normalize(linalg.cross([3]f32{0, 1, 0}, way))
    if swing.w < 0 do swing = -swing
    limb := 2 * math.atan2(linalg.dot([3]f32{swing.x, swing.y, swing.z}, side), swing.w)
    follow := clamp(math.atan2(-trail.y, ik.span), -ik.roll, ik.roll)
    low := min(target.y, target.y + trail.y) - ik.rest.y
    k := clamp(1 - low / (ik.span * math.sin(min(ik.roll, math.PI / 4))), 0, 1)
    if k > 0 {
      // its toes, a link further on, turn as it turned the FOLLOW before (a tail's next link): up
      // from level by its pitch then, its ball's target over its toes', so landing they still point
      // up once its ball is down, and settle after
      toes = k * k * (3 - 2 * k) * clamp(math.atan2((toes_trail - trail).y, ik.span), -ik.roll, ik.roll)
      // (from what the limb gives it unfollowed: toes down no further than it rolls, below)
      pitch := math.lerp(min(limb, ik.roll), follow, k * k * (3 - 2 * k))
      swing = linalg.quaternion_angle_axis(pitch, side) * swing * linalg.quaternion_inverse(linalg.quaternion_angle_axis(limb, side))
      follows = true
    }
  }
  x := geometry.Transform{target - linalg.mul(facing, ik.end), facing, 1}
  // 3. swung about its end, as far as the ground lets it: coming down ahead it lands on its heel
  // and the ground lays it flat as the target comes down; on the ground it stands flat
  // (out of the ground first: a body pitching may tip it in)
  at := target
  lift := max(-lowest(x, corners), 0)
  x.position.y += lift
  at.y += lift
  rolled: f32 = 0
  // the share of the swing tipping it toward the joints below it (toes down: behind the body), about
  // its end, as far as the ground lets the whole of it (the joints below it as they hang from it, so
  // it tips about the tips of its toes) and no further than it rolls: on the ground behind it stands
  // flat (its heel lifts only as the limb runs out of reach, below), lifted it tips as its height
  // lets it, so it tips smoothly as it leaves the ground
  if way := linalg.mul(x.rotation, ik.toes); ik.toes != 0 && way.xz != 0 && !follows {
    way.y = 0
    axis := linalg.normalize(linalg.cross([3]f32{0, 1, 0}, way))
    if swing.w < 0 do swing = -swing
    if pitch := 2 * math.atan2(linalg.dot([3]f32{swing.x, swing.y, swing.z}, axis), swing.w); pitch > 0 {
      swing *= linalg.quaternion_inverse(linalg.quaternion_angle_axis(pitch, axis))
      whole := make([dynamic][3]f32, 0, len(corners), context.temp_allocator)
      append(&whole, ..corners)
      from_tip := linalg.quaternion_inverse(rig.rotations[tip])
      for cf in rig.conforms[ik.conform_first:][:ik.conform_count] {
        for c in rig.corners[cf.first:][:cf.count] do append(&whole, linalg.mul(from_tip, point_on({rig.positions[cf.bone], rig.rotations[cf.bone], 1}, c) - rig.positions[tip]))
      }
      in_, out := f32(0), min(pitch, ik.roll)
      if lowest(turn_about(x, at, linalg.quaternion_angle_axis(out, axis)), whole[:]) >= 0 do in_ = out
      else do for _ in 0 ..< 20 {
        mid := (in_ + out) / 2
        if lowest(turn_about(x, at, linalg.quaternion_angle_axis(mid, axis)), whole[:]) < 0 do out = mid
        else do in_ = mid
      }
      rolled = in_
      x = turn_about(x, at, linalg.quaternion_angle_axis(rolled, axis))
    }
  }
  if !follows && lowest(turn_about(x, at, swing), corners) < 0 {
    in_, out := f32(0), f32(1)
    for _ in 0 ..< 20 {
      mid := (in_ + out) / 2
      if lowest(turn_about(x, at, linalg.quaternion_slerp(linalg.QUATERNIONF32_IDENTITY, swing, mid)), corners) < 0 do out = mid
      else do in_ = mid
    }
    swing = linalg.quaternion_slerp(linalg.QUATERNIONF32_IDENTITY, swing, in_)
  }
  x = turn_about(x, at, swing)
  // following, it stands on the corner that is down, lifted out of the ground on it
  if follows do x.position.y += max(-lowest(x, corners), 0)
  // and back down as far as the ground lets it
  x.position.y -= clamp(lowest(x, corners), 0, lift)
  // near the furthest its chain reaches (ik.stretch, from its root to its pivot), on the ground: it
  // rolls on its edge toward the chain's root (its heel lifting, its toes staying down) as little as
  // keeps its pivot within reach, the heel starting up a little before the limb is straight (from
  // ik.stretch[0], easing into the furthest) so it lifts smoothly however fast the target goes back
  h := Holding{x = x, hold = ik.end, at = point_on(x, ik.end)}
  root := rig.positions[chain[0]]
  if ik.stretch[1] > 0 && lowest(x, corners) < 0.05 * ik.length {
    soft, band := ik.stretch[0], ik.stretch[1] - ik.stretch[0]
    if far := linalg.length(point_on(x, ik.pivot) - root); far > soft {
      within := soft + (band * math.tanh((far - soft) / band) if band > 1e-6 else 0)
      angle: f32
      h.x, h.at, angle = contact_roll(x, corners, ik.pivot, root, within, 0.05 * ik.length, ik.roll - rolled)
      h.hold = linalg.mul(linalg.quaternion_inverse(h.x.rotation), h.at - h.x.position)
      rolled += angle
    }
  }
  // 1. the tip's own joints turn it to that facing, within their stops, and the whole chain reaches
  // with what holds it, its end on the target, turning toward that facing too
  contact_hold(rig, ik, pose, h, swivel, origin, 16)
  // still stretched on the ground (the end falls short: a reach that way shorter than the furthest):
  // it rolls on further as little as brings its pivot back within the reach the chain got, and a
  // little more (a straight limb has no side to bend to; no more than it fell short), and that edge
  // holds it. Past the furthest it rolls, the limb pulls it off the ground, toes and all (below).
  reached := point_on({rig.positions[tip], rig.rotations[tip], 1}, h.hold)
  if short := linalg.length(reached - h.at); short > 1e-3 * ik.length && lowest(h.x, corners) < 0.05 * ik.length {
    reach := linalg.length(rig.positions[pivot] - root) - min(short, 0.02 * ik.length)
    h.x, h.at, _ = contact_roll(h.x, corners, ik.pivot, root, reach, 0.05 * ik.length, ik.roll - rolled)
    h.hold = linalg.mul(linalg.quaternion_inverse(h.x.rotation), h.at - h.x.position)
    contact_hold(rig, ik, pose, h, swivel, origin, 16)
  }
  // the contact is exact, the facing as near as the stops let it: a round or two more settle the two
  for _ in 0 ..< 2 {
    if off := rig.rotations[tip] * linalg.quaternion_inverse(h.x.rotation); abs(off.w) > 0.99999 do break
    contact_hold(rig, ik, pose, h, swivel, origin, 8)
  }
  // where the chain can't turn it to its facing (no joint of a strider's leg rolls its foot as the
  // leg splays, or a limb pulled past the furthest it rolls), it stands on the edge it ends on,
  // lifted out of the ground, the joints below it too, as far as their stops let them lie down
  if low := min(lowest({rig.positions[tip], rig.rotations[tip], 1}, corners), conform_lowest(rig, ik)); low < -1e-3 * ik.length {
    h.at.y -= low
    contact_hold(rig, ik, pose, h, swivel, origin, 8)
  }
  return
}

// conform_lowest is how high IK `ik`'s joints below its tip (toes) would stand at the lowest, laid on
// the ground from the tip as posed (contact_conform), their turns kept; MAX with none.
@(private = "file")
conform_lowest :: proc(rig: ^Rig, ik: RigIk) -> f32 {
  conforms := rig.conforms[ik.conform_first:][:ik.conform_count]
  if len(conforms) == 0 do return math.F32_MAX
  kept := make([]quaternion128, len(conforms), context.temp_allocator)
  for cf, k in conforms do kept[k] = rig.local[cf.bone].rotation
  moved := make([]bool, len(rig.bones), context.temp_allocator)
  moved[rig.chains[ik.first + ik.count - 1]] = true
  pose := rig_skeleton(rig)
  animation.pose_propagate(pose, moved)
  contact_conform(rig, ik)
  low := f32(math.F32_MAX)
  for cf in conforms do for c in rig.corners[cf.first:][:cf.count] do low = min(low, point_on({rig.positions[cf.bone], rig.rotations[cf.bone], 1}, c).y)
  for cf, k in conforms do rig.local[cf.bone].rotation = kept[k]
  animation.pose_propagate(pose, moved)
  return low
}

// Holding is how a contact tip is held: placed `x` (its tip bone's frame), point `hold` of it (in
// that frame) at `at`.
@(private = "file")
Holding :: struct {
  x:        geometry.Transform,
  hold, at: [3]f32,
}

// contact_hold turns IK `ik`'s tip's own joints to its facing (h.x), within their stops, and
// reaches its whole chain to put h.hold on h.at in `iterations`, turning toward that facing too, the
// own joints with it (a hinged ankle can't level a foot on a splayed leg: the hip turns it).
@(private = "file")
contact_hold :: proc(rig: ^Rig, ik: RigIk, pose: animation.Pose, h: Holding, swivel: f32, origin: geometry.Transform, iterations: int) {
  chain := rig.chains[ik.first:][:ik.count]
  own := chain[ik.turning:]
  up := rig.rotations[rig.parents[own[0]]]
  for b, k in own {
    after := linalg.QUATERNIONF32_IDENTITY
    for j in own[k + 1:] do after *= rig.local[j].rotation
    local := linalg.quaternion_inverse(up) * h.x.rotation * linalg.quaternion_inverse(after)
    rest := rig.rest[b].rotation
    rig.local[b].rotation = animation.joint_rotation(rest, animation.joint_angles(rest, local), rig.limits[b])
    up *= rig.local[b].rotation
  }
  moved := make([]bool, len(rig.bones), context.temp_allocator)
  moved[rig.parents[own[0]]] = true
  animation.pose_propagate(pose, moved)
  animation.ik_solve(pose, chain, {
    target      = h.at,
    pole        = ik_pole(rig, ik, h.at, swivel, origin),
    pole_weight = 1,
    iterations  = iterations,
    end         = h.hold,
    ends        = u32(ik.count - ik.turning),
    hold        = true,
    face        = h.x.rotation,
    middle      = ik.mid,
  })
}

// contact_conform lays IK `ik`'s joints below its tip (toes) on the ground as they near it, and
// keeps them out of it, within their stops; the bones below each follow.
@(private)
contact_conform :: proc(rig: ^Rig, ik: RigIk, up: f32 = 0) {
  pose := rig_skeleton(rig)
  moved := make([]bool, len(rig.bones), context.temp_allocator)
  for cf in rig.conforms[ik.conform_first:][:ik.conform_count] {
    c := Conforming{rig, cf, animation.joint_angles(rig.rest[cf.bone].rotation, rig.local[cf.bone].rotation)}
    lo, hi := rig.limits[cf.bone].lo[cf.axis], rig.limits[cf.bone].hi[cf.axis]
    now := c.angles[cf.axis]
    if lo <= -math.F32_MAX do lo, hi = now - math.PI, now + math.PI
    // level: its rest down pointing down again; it lies down as it nears the ground
    level := minimize(lo, hi, &c, proc(data: rawptr, a: f32) -> f32 {
      c := (^Conforming)(data)
      return linalg.mul(conform_turn(c^, a), c.cf.down).y
    })
    // following, the first of them stands `up` from level (tips up): turned the way that lifts its
    // corner furthest out
    if up != 0 && cf.bone == rig.conforms[ik.conform_first].bone {
      far := cf.first
      for k in cf.first ..< cf.first + cf.count do if linalg.length(rig.corners[k]) > linalg.length(rig.corners[far]) do far = k
      tip :: proc(c: Conforming, a: f32, corner: [3]f32) -> f32 {
        return linalg.mul(conform_turn(c, a), corner).y
      }
      way: f32 = 1 if tip(c, level + 0.01, rig.corners[far]) > tip(c, level - 0.01, rig.corners[far]) else -1
      level = clamp(level + way * up, lo, hi)
    }
    a := math.lerp(now, level, clamp(1 - conform_low(c, level) / cf.height, 0, 1))
    // never through the ground: the least turn that lifts it out, toward either stop
    if conform_low(c, a) < 0 {
      best, gap := a, f32(math.F32_MAX)
      for end in ([2]f32{lo, hi}) {
        if conform_low(c, end) < 0 do continue
        in_, out := a, end
        for _ in 0 ..< 24 {
          mid := (in_ + out) / 2
          if conform_low(c, mid) < 0 do in_ = mid
          else do out = mid
        }
        if abs(out - a) < gap do best, gap = out, abs(out - a)
      }
      a = best
    }
    c.angles[cf.axis] = a
    rig.local[cf.bone].rotation = animation.joint_rotation(rig.rest[cf.bone].rotation, c.angles, rig.limits[cf.bone])
    moved[rig.parents[cf.bone]] = true
    animation.pose_propagate(pose, moved)
    moved[rig.parents[cf.bone]] = false
  }
}

// Conforming is a joint below a tip being laid on the ground: its turns, on its parent as posed.
@(private = "file")
Conforming :: struct {
  rig:    ^Rig,
  cf:     RigConform,
  angles: [3]f32,
}

// conform_turn is how the conforming joint faces, turned `a` about its axis.
@(private = "file")
conform_turn :: proc(c: Conforming, a: f32) -> quaternion128 {
  angles := c.angles
  angles[c.cf.axis] = a
  b := c.cf.bone
  return c.rig.rotations[c.rig.parents[b]] * animation.joint_rotation(c.rig.rest[b].rotation, angles, c.rig.limits[b])
}

// conform_low is how high the conforming joint's lowest corner stands, turned `a`.
@(private = "file")
conform_low :: proc(c: Conforming, a: f32) -> f32 {
  b := c.cf.bone
  p := c.rig.parents[b]
  turn := conform_turn(c, a)
  at := c.rig.positions[p] + linalg.mul(c.rig.rotations[p], c.rig.local[b].position)
  low := f32(math.F32_MAX)
  for k in c.rig.corners[c.cf.first:][:c.cf.count] do low = min(low, (at + linalg.mul(turn, k)).y)
  return low
}

// contact_roll rolls tip `x` when its pivot (`pivot`, in its frame) is out of reach, `reach` from
// the chain's root (`root`) at most: on the edge it stands on (its corners of `corners` within
// `tolerance` of its lowest) toward the root, the way the limb pulls it, about that edge (its line;
// a lone corner, square to the pull), as little as brings the pivot within reach (rolling lifts it
// toward the root), `most` at most. `on`, the edge's middle, is what holds it; `angle` how far it rolled.
@(private = "file")
contact_roll :: proc(x: geometry.Transform, corners: [][3]f32, pivot, root: [3]f32, reach, tolerance, most: f32) -> (rolled: geometry.Transform, on: [3]f32, angle: f32) {
  at := point_on(x, pivot)
  way := root - at
  way.y = 0
  if linalg.length(way) < 1e-6 do return x, at, 0
  way = linalg.normalize(way)
  low := lowest(x, corners)
  // the edge: the corners it stands on furthest that way, within a quarter of how far they spread
  near, far := f32(math.F32_MAX), f32(-math.F32_MAX)
  for c in corners {
    p := point_on(x, c)
    if p.y > low + tolerance do continue
    d := linalg.dot(p, way)
    near, far = min(near, d), max(far, d)
  }
  edge := make([dynamic][3]f32, context.temp_allocator)
  for c in corners {
    p := point_on(x, c)
    if p.y <= low + tolerance && linalg.dot(p, way) >= far - max(tolerance, 0.25 * (far - near)) {
      append(&edge, p)
      on += p
    }
  }
  on /= f32(len(edge))
  // its line: its two corners furthest apart, turned to lift the pivot
  axis := linalg.cross([3]f32{0, 1, 0}, way)
  span: f32 = 0
  for p in edge do for q in edge {
    d := q - p
    d.y = 0
    if l := linalg.length(d); l > span && l > tolerance do span, axis = l, d
  }
  axis = linalg.normalize(axis)
  if linalg.cross(axis, at - on).y < 0 do axis = -axis
  from_root :: proc(on, at, root, axis: [3]f32, a: f32) -> f32 {
    return linalg.length(on + linalg.mul(linalg.quaternion_angle_axis(a, axis), at - on) - root)
  }
  lo, hi := f32(0), max(most, 0)
  if from_root(on, at, root, axis, hi) > reach do lo = hi
  else do for _ in 0 ..< 24 {
    mid := (lo + hi) / 2
    if from_root(on, at, root, axis, mid) > reach do lo = mid
    else do hi = mid
  }
  return turn_about(x, on, linalg.quaternion_angle_axis(hi, axis)), on, hi
}

// turn_about is `x` turned by `q` about point `p`.
@(private = "file")
turn_about :: proc(x: geometry.Transform, p: [3]f32, q: quaternion128) -> geometry.Transform {
  return {p + linalg.mul(q, x.position - p), linalg.normalize(q * x.rotation), x.scale}
}

// lowest is how high the lowest of `corners` (in frame `x`) stands.
@(private = "file")
lowest :: proc(x: geometry.Transform, corners: [][3]f32) -> f32 {
  low := f32(math.F32_MAX)
  for c in corners do low = min(low, point_on(x, c).y)
  return low
}

// point_on is point `p` of frame `x` (unscaled), in the space `x` is in.
@(private = "file")
point_on :: proc(x: geometry.Transform, p: [3]f32) -> [3]f32 {
  return x.position + linalg.mul(x.rotation, p)
}

// minimize is where `f` is least on [lo, hi]: the best of a coarse sweep, refined by golden section.
@(private = "file")
minimize :: proc(lo, hi: f32, data: rawptr, f: proc(data: rawptr, a: f32) -> f32) -> f32 {
  STEPS :: 16
  best, at := f32(math.F32_MAX), lo
  for k in 0 ..= STEPS {
    a := lo + (hi - lo) * f32(k) / STEPS
    if v := f(data, a); v < best do best, at = v, a
  }
  step := (hi - lo) / STEPS
  a, b := max(lo, at - step), min(hi, at + step)
  G :: 0.618034
  for _ in 0 ..< 20 {
    c, d := b - G * (b - a), a + G * (b - a)
    if f(data, c) < f(data, d) do b = d
    else do a = c
  }
  return (a + b) / 2
}
