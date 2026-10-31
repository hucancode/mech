#+build !js
package character

import "../mech"

// asset_load loads a character file (a model and its animation).
asset_load :: proc(path: string) -> (a: MechAsset, ok: bool) {
  a.model, a.anim = mech.character_load(path) or_return
  asset_compile(&a)
  return a, true
}
