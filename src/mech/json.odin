package mech

import "base:runtime"
import "core:encoding/json"
import "core:mem"
import "core:reflect"
import "core:slice"
import "core:strconv"
import "core:strings"

// Model and animation files are written for people to read and diff: struct fields in declaration
// order, zero fields left out (loading leaves them zero), arrays of numbers on one line, numbers
// in their shortest form. Map entries are all written, sorted, since a 0 there is a value.

// Schema is the names the formats use, from the engine's own types (schema_format): each enum's
// names, the prefixes of a placed side's names, the names of the root's channels and an IK
// target's after its own, how many values each ChannelKind holds, and the budgets
// character_check holds clips to. Editors read it rather than keep a copy.
Schema :: struct {
  enums:    map[string][]string,
  sides:    map[string]string,
  channels: map[string]string,
  sizes:    map[string]int,
  budgets:  map[string]int,
}

// schema_format is the Schema as JSON text, allocated with `allocator`.
schema_format :: proc(allocator := context.allocator) -> string {
  context.allocator = context.temp_allocator
  s: Schema
  s.enums["Primitive"] = reflect.enum_field_names(Primitive)
  s.enums["JointKind"] = reflect.enum_field_names(JointKind)
  s.enums["Plane"] = reflect.enum_field_names(Plane)
  s.enums["Ease"] = reflect.enum_field_names(Ease)
  s.enums["Twin"] = reflect.enum_field_names(Twin)
  s.enums["ChannelKind"] = reflect.enum_field_names(ChannelKind)
  s.enums["Axis"] = reflect.enum_field_names(Axis)
  prefix := SIDE_PREFIX
  for side in Side do s.sides[reflect.enum_string(side)] = prefix[side]
  s.channels["swivel"] = IK_SWIVEL_NAME
  s.channels["weight"] = IK_WEIGHT_NAME
  s.channels["root"] = ROOT_NAME
  s.channels["root_turn"] = ROOT_TURN_NAME
  sizes := CHANNEL_SIZE
  for kind in ChannelKind do s.sizes[reflect.enum_string(kind)] = sizes[kind]
  s.budgets["shape"] = SHAPE_BUDGET
  s.budgets["motions"] = MOTION_BUDGET
  // not a file: the standard writer, which writes any map (format_json writes the files' own shapes)
  data, _ := json.marshal(s, allocator = allocator)
  return string(data)
}

// format_json writes `v` as file text, allocated with `allocator`.
@(private)
format_json :: proc(v: $T, allocator := context.allocator) -> string {
  b := strings.builder_make(allocator)
  v := v
  write_value(&b, v, 0)
  strings.write_byte(&b, '\n')
  return strings.to_string(b)
}

@(private = "file")
newline :: proc(b: ^strings.Builder, indent: int) {
  strings.write_byte(b, '\n')
  for _ in 0 ..< indent do strings.write_string(b, "  ")
}

@(private = "file")
is_empty :: proc(v: any) -> bool {
  ti := runtime.type_info_base(type_info_of(v.id))
  #partial switch _ in ti.variant {
  case runtime.Type_Info_Float:
    switch ti.size {
    case 4:
      return (^f32)(v.data)^ == 0
    case 8:
      return (^f64)(v.data)^ == 0
    }
  case runtime.Type_Info_String:
    return len((^string)(v.data)^) == 0
  case runtime.Type_Info_Dynamic_Array:
    return (^runtime.Raw_Dynamic_Array)(v.data).len == 0
  case runtime.Type_Info_Slice:
    return (^runtime.Raw_Slice)(v.data).len == 0
  case runtime.Type_Info_Map:
    return (^runtime.Raw_Map)(v.data).len == 0
  case runtime.Type_Info_Struct:
    s := ti.variant.(runtime.Type_Info_Struct)
    for i in 0 ..< s.field_count {
      if !is_empty(any{rawptr(uintptr(v.data) + s.offsets[i]), s.types[i].id}) do return false
    }
    return true
  case runtime.Type_Info_Array:
    a := ti.variant.(runtime.Type_Info_Array)
    for i in 0 ..< a.count {
      if !is_empty(any{rawptr(uintptr(v.data) + uintptr(i * a.elem_size)), a.elem.id}) do return false
    }
    return true
  }
  return mem.check_zero(([^]u8)(v.data)[:ti.size])
}

@(private = "file")
is_number :: proc(id: typeid) -> bool {
  #partial switch _ in runtime.type_info_base(type_info_of(id)).variant {
  case runtime.Type_Info_Float, runtime.Type_Info_Integer:
    return true
  }
  return false
}

// is_plain: a scalar, or an array of numbers, which fit on one line
@(private = "file")
is_plain :: proc(t: ^runtime.Type_Info) -> bool {
  #partial switch info in runtime.type_info_base(t).variant {
  case runtime.Type_Info_Float, runtime.Type_Info_Integer, runtime.Type_Info_Boolean, runtime.Type_Info_String, runtime.Type_Info_Enum:
    return true
  case runtime.Type_Info_Array:
    return is_number(info.elem.id)
  }
  return false
}

@(private = "file")
write_number :: proc(b: ^strings.Builder, x: f64) {
  if x == 0 {
    strings.write_byte(b, '0')
    return
  }
  buf: [32]u8
  s := strconv.write_float(buf[:], x, 'g', -1, 32)
  strings.write_string(b, strings.trim_prefix(s, "+"))
}

@(private = "file")
write_items :: proc(b: ^strings.Builder, data: rawptr, count, size: int, elem: typeid, indent: int) {
  if count == 0 {
    strings.write_string(b, "[]")
    return
  }
  if is_number(elem) {
    strings.write_byte(b, '[')
    for i in 0 ..< count {
      if i > 0 do strings.write_string(b, ", ")
      write_value(b, any{rawptr(uintptr(data) + uintptr(i * size)), elem}, indent)
    }
    strings.write_byte(b, ']')
    return
  }
  strings.write_byte(b, '[')
  for i in 0 ..< count {
    if i > 0 do strings.write_byte(b, ',')
    newline(b, indent + 1)
    write_value(b, any{rawptr(uintptr(data) + uintptr(i * size)), elem}, indent + 1)
  }
  newline(b, indent)
  strings.write_byte(b, ']')
}

// write_map writes a map by name, its entries sorted by name, each value by `write`.
@(private = "file")
write_map :: proc(b: ^strings.Builder, values: map[string]$T, indent: int, write: proc(b: ^strings.Builder, x: T)) {
  if len(values) == 0 {
    strings.write_string(b, "{}")
    return
  }
  keys, _ := slice.map_keys(values, context.temp_allocator)
  slice.sort(keys)
  strings.write_byte(b, '{')
  for k, i in keys {
    if i > 0 do strings.write_byte(b, ',')
    newline(b, indent + 1)
    strings.write_quoted_string(b, k)
    strings.write_string(b, ": ")
    write(b, values[k])
  }
  newline(b, indent)
  strings.write_byte(b, '}')
}

@(private)
write_value :: proc(b: ^strings.Builder, v: any, indent: int) {
  // the maps the files hold: amounts by channel, how much of each pose, the arc each position follows
  if values, ok := v.(map[string]Value); ok {
    write_map(b, values, indent, proc(b: ^strings.Builder, x: Value) {
      switch x in x {
      case f32:
        write_number(b, f64(x))
      case [3]f32:
        strings.write_byte(b, '[')
        for c, n in x {
          if n > 0 do strings.write_string(b, ", ")
          write_number(b, f64(c))
        }
        strings.write_byte(b, ']')
      case string:
        strings.write_quoted_string(b, x)
      case:
        strings.write_string(b, "null")
      }
    })
    return
  }
  if values, ok := v.(map[string]f32); ok {
    write_map(b, values, indent, proc(b: ^strings.Builder, x: f32) {write_number(b, f64(x))})
    return
  }
  if values, ok := v.(map[string]string); ok {
    write_map(b, values, indent, proc(b: ^strings.Builder, x: string) {strings.write_quoted_string(b, x)})
    return
  }
  ti := runtime.type_info_base(type_info_of(v.id))
  #partial switch info in ti.variant {
  case runtime.Type_Info_Float:
    x: f64
    switch ti.size {
    case 4:
      x = f64((^f32)(v.data)^)
    case 8:
      x = (^f64)(v.data)^
    }
    write_number(b, x)
  case runtime.Type_Info_Integer:
    i, _ := reflect.as_i64(v)
    strings.write_i64(b, i)
  case runtime.Type_Info_Boolean:
    strings.write_string(b, "true" if (^bool)(v.data)^ else "false")
  case runtime.Type_Info_String:
    strings.write_quoted_string(b, (^string)(v.data)^)
  case runtime.Type_Info_Enum:
    strings.write_quoted_string(b, reflect.enum_string(v))
  case runtime.Type_Info_Array:
    write_items(b, v.data, info.count, info.elem_size, info.elem.id, indent)
  case runtime.Type_Info_Dynamic_Array:
    raw := (^runtime.Raw_Dynamic_Array)(v.data)
    write_items(b, raw.data, raw.len, info.elem_size, info.elem.id, indent)
  case runtime.Type_Info_Struct:
    // a few plain fields go on one line
    flat, count := true, 0
    for i in 0 ..< info.field_count {
      if reflect.struct_tag_get(reflect.Struct_Tag(info.tags[i]), "json") == "-" do continue
      field := any{rawptr(uintptr(v.data) + info.offsets[i]), info.types[i].id}
      if is_empty(field) do continue
      count += 1
      if !is_plain(info.types[i]) do flat = false
    }
    flat = flat && count <= 4
    strings.write_byte(b, '{')
    first := true
    for i in 0 ..< info.field_count {
      if reflect.struct_tag_get(reflect.Struct_Tag(info.tags[i]), "json") == "-" do continue
      field := any{rawptr(uintptr(v.data) + info.offsets[i]), info.types[i].id}
      if is_empty(field) do continue
      if !first do strings.write_string(b, ", " if flat else ",")
      first = false
      if !flat do newline(b, indent + 1)
      strings.write_quoted_string(b, info.names[i])
      strings.write_string(b, ": ")
      write_value(b, field, indent + 1)
    }
    if !first && !flat do newline(b, indent)
    strings.write_byte(b, '}')
  case:
    strings.write_string(b, "null")
  }
}
