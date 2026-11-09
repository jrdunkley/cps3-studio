# Third-party material

The project includes the Studio tools, their SH-2 interpreter, CPS3 machine and renderer,
sample-chip model, ZIP reader, SHA-256 fallback, MIDI tools, compiler and pages.
There are no npm dependencies and no external scripts or fonts are loaded.

The Game module includes a prebuilt WebAssembly emulator and the C source used to build it.
The Zig WASI toolchain links compiler and C runtime support into that build.
It is separate from the game's SH-2 program and contains no ROM image. Build instructions,
compiler version and source fingerprints accompany it.

**Knowledge used, not copied.** The CPS3 program decryption (`studio_kit/core/cps3rom.js`) implements the
address-mask algorithm and uses the keys of the three Street Fighter III games as documented by the CPS3 drivers
of the MAME and FBNeo emulators. Member names and checksums of the ROM sets follow those projects' ROM lists. The sound driver itself is
not described from any outside source: the Studio runs the game's own driver code, read from your ROM.

**Palette and patch formats.** Art reads and writes the colour formats the community already uses. The PalMod
colour string, its `51` file layout and its ACT and GIMP conventions follow the PalMod project (BSD 3-Clause,
github.com/Preppy/PalMod). The IPS patch list follows FBNeo's IPS manager. No code from either project is included.

**Decompilation.** Routine names, structure field names and the meanings of move-data fields and script commands
in Moves were read from the community C decompilation of 3rd Strike (gibletto's sfIII3-cps3-decomp, AGPL-3.0),
which rebuilds the arcade program byte for byte. Only names and descriptions are used; no decompiled code is included.

**Capcom.** Street Fighter III 3rd Strike, its program, music, instruments and sound samples are Capcom's. None of
them is in this repository. Instrument names, piece names and measurements in the code and documents describe the
game so that you can use your own copy of it; they are not the game's data.

**Emulator behaviour.** The machine, renderer and sound model follow hardware descriptions and observed
MAME/FBNeo behaviour, including interrupt scheduling, DMA, video composition and sample mixing.
References in source comments explain those compatibility choices. Imported game source trees,
game decompilation bodies, emulator installations, recordings and captured states are excluded.

**Metadata.** Source hashes, addresses, field schemas, scene relationships and descriptive labels let
the tools locate and validate content in a user's files. They do not include the sprite pixels,
palette words, music sequences, sample bytes or executable game instructions they describe.

Compiler/runtime notices copied from the pinned Zig 0.16.0 distribution:

- [Zig MIT](licenses/Zig-MIT.txt)
- [WASI licensing summary](licenses/WASI-LICENSE.txt), [MIT](licenses/WASI-MIT.txt), [Apache 2.0](licenses/WASI-Apache-2.0.txt) and [LLVM exceptions](licenses/WASI-Apache-LLVM.txt)
- [musl copyright and licences](licenses/musl-COPYRIGHT.txt)
- [cloudlibc BSD notice](licenses/cloudlibc-BSD.txt)

These notices concern toolchain runtime support. No third-party game assets are included.
