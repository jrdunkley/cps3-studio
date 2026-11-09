# Building the game engine

The browser loads `engine_wasm.js`, a JavaScript wrapper around a WebAssembly build of the tool's CPS3 machine emulator. It contains no game image. The imported program, BIOS, graphics and sound data are supplied at runtime.

`src/engine.c` wraps the machine and renderer in `src/machine/` and `src/video/`. `inspection_codegen.py` creates an instrumented renderer for pixel attribution; it does not embed captured frames. `src/engine_cli.c` is the native test-runner wrapper.

With Python 3 and Zig 0.16.0 already available:

```sh
python studio_kit/game/build_engine.py --zig /path/to/zig --check
```

The script checks the source hashes and compiler version, writes only to the ignored `out/` directory beside it, and compares the compiled bytes with the bundled payload. It prints a JSON result and exits nonzero if `--check` finds a mismatch. The flags and source fingerprints are recorded in `engine_wasm.js`.

Source hashes normalize line endings to LF so Git checkout settings do not change the result. The build removes WebAssembly custom sections, including debug paths and symbol names. Every runtime section is retained byte for byte; stripping debug information does not replace or regenerate the emulator's instructions or data.

No ROM, network access, dependency download or running game is needed. Browser users can use the prebuilt engine without installing a compiler. If intentionally modifying engine source, update the recorded fingerprints and regenerate the wrapper as part of a reviewed release; the check deliberately refuses unrecorded changes.
