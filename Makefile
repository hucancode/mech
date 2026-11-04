ODIN_ROOT := $(shell odin root)
EDITOR := tools/character-editor
# mjolnir's web flags (vendor/mjolnir/Makefile); linking needs wasm-ld (LLVM's lld)
WASM_FLAGS := -target:js_wasm32 -define:RENDER_BACKEND=wgpu -target-features:"atomics,bulk-memory" \
	-no-thread-local -extra-linker-flags:"--export-table"
export PATH := $(HOME)/.local/llvm/bin:$(PATH)

# The test scene: the game's characters, with a debug panel.
run: shader
	@mkdir -p bin
	odin run src -out:bin/mech

build: shader
	@mkdir -p bin
	odin build src -out:bin/mech
	odin build src/viewer -out:bin/viewer

# The viewer on the desktop: make viewer CHARACTER=assets/characters/dragon.json
CHARACTER ?= assets/characters/mech.json
viewer: shader
	@mkdir -p bin
	odin run src/viewer -out:bin/viewer -- $(CHARACTER)

# The viewer in wasm, with Odin's JS runtime, for the character editor.
web: shader
	@command -v wasm-ld >/dev/null || (echo "wasm-ld (LLVM lld) is not on PATH" && exit 1)
	@mkdir -p $(EDITOR)/build
	cp $(ODIN_ROOT)core/sys/wasm/js/odin.js $(ODIN_ROOT)vendor/wgpu/wgpu.js $(EDITOR)/build/
	odin build src/viewer $(WASM_FLAGS) -o:speed -out:$(EDITOR)/build/viewer.wasm

# The character editor: http://localhost:5180/ (Node, no packages).
character-editor: web
	node $(EDITOR)/server.mjs

# The engine's tests, then the character editor's (Node, no packages).
test:
	odin test src/mech -out:bin/mech_test
	node --test $(EDITOR)/web/js/test

# Type-check everything without building.
check:
	odin check src/mech -no-entry-point
	odin check src/character -no-entry-point
	odin check src
	odin check src/viewer
	odin check src/viewer -target:js_wasm32 -define:RENDER_BACKEND=wgpu -no-thread-local

# Compile the engine's Slang shaders (needs slangc).
shader:
	$(MAKE) -C vendor/mjolnir shader

.PHONY: run build viewer web character-editor test check shader
