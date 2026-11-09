# Art headless core

Every `js/*.js` core below exposes its named browser global and the same CommonJS
export in Node. Binary inputs are `Uint8Array`, program words are big-endian,
addresses are numbers. Failures throw `Error`; ROM failures are `Cps3Rom.RomError`.
No API starts the game, writes files, resizes pictures or quantizes colours.

| Module | Functions and returned values |
|---|---|
| `ArtCodec6` | `decode(source, table256, requestedLength, maxOutput=requestedLength+63, collectReads=false)` → `{pixels, sourceConsumed, tableReads, tablePositions?}`. Includes the complete final repeat tail, stops between pair values when the requested length is reached. `encode(pens, requestedLength=pens.length)` → `{source, table, decodedLength, optimal:false, parseOptimal:true}`; deterministic free-table heuristic. `encodeFixed(pens, table256, requestedLength=pens.length)` returns the same shape with `optimal:true`, the shortest parse for that fixed table and exact requested-length stopping/complete tail. Encoders accept only pens 0–63; an impossible tail throws. |
| `ArtCel` | `new Resources(program16MiB, data64MiB)`. `.row(index)` → signed origins and descriptor pointer; `.descriptors()` → `Map(pointer → indices[])` across all 65,536 rows; `.descriptor(index)` → header, cell records, upload addresses/lengths and allocation; `.decode(index)` adds `pens`, `written` and each upload's `consumed`/`written` bytes; `.image(index,{flipX,flipY,paletteNumber})` → indexed assembled canvas. `geometry(decoded)` gives cell positions and dimensions. `assemble(decoded,opts)` → `{width,height,pixels,paletteRows,bits,bounds,origin,index,pointer}`. `rgba(image,{paletteRam, palette})` returns packed RGBA; no palette means declared grayscale pens. A `palette` argument is a flat RGB byte row; `paletteRam` is test-only captured big-endian RAM. |
| `ArtAnim` | `characters(program)` → all 21 native IDs, names, charset and section roots. `animations(program,id,section?)` → slot/address/header/aliases/stride/physicalEnd and a lazy `.records()` reader. `header(program,stream)` and `frame(program,address,stride)` read the exact typed fields, including `unknown_*`. `records(program,start,stride,end)` → physical frame/command/unknown records. `timeline(animation,program)` → `{frames,ticks,rate:59.59949,complete,stop}`. Frames carry `{spriteId,duration,startTick,flip,offset:{x:null,y:null},unknown,fields}`. Timing is in game frames; refresh is the pinned driver's value. The timeline stops at a command: conditional paths, hit stop, object motion and dynamic offsets need game context. Physical tails do not imply executable frames. |
| `ArtPalette` | `rgb(rgb555Word,mode='state')` → `[r,g,b]`; `row(words64,mode)` → flat 192 RGB bytes; `rgbaRow(words,mode)` → 64 RGBA entries with pen zero transparent. `state` expands green through RGB565 as the driver does on state loading; `dma` uses direct multiples of eight. `captured(bytes,rowNumber,mode)` is test-only. `fromRom(program,data,{character,side,colour,row,mode?})` reads an explicit native row. `character(program,data,{character,side,colour,mode?})` → `{address,loads,rows:[{row,source,words,palette,bytes}],limits}`; each row's `palette` is ready for the Colour chooser. `catalogue(program)` → all 294 `configurations` and `aliases:Map(source→uses[])`, retaining holes/overwrites/side differences. `stage(program,data,id,mode)` reads both independent stored banks for stage slots 0–22; dispatch is capture correspondence and stage 8 sky rows remain unknown. `extraRows(program,data,id,mode)` exposes Oro/Akuma/Q sources as `shown-not-proved` with qualified ownership. `descriptor`, `characterLoads`, `loadedRows`, `sourceBytes` are bounded lower-level readers. `fadeWord(word,control)` retains bit15 and follows hardware component arithmetic. `ssTile(program,index,kind='standard')` → `{width:8,height:8,pens,packed,source,limits}`; boot kind is bounded to 140 glyphs, standard to the addressable u16 source-tile domain. `ssPens(packed32)` decodes low nibble first; `ssUpload(packed32,signed)` reproduces ordinary/boot word expansion. No captured-state fallback in the product. |
| `ArtCensus` | `new Census(resources)` scans every unique descriptor and exact consumed upload source plus each full pair table. `.overlaps(start,end)` → source/table readers. `.forCel(index,{tableEdit:false})` → aliases, `sourceSharedWith`, `cachedSharedWith`, combined `sharedWith`, descriptor/allocation bytes, union of consumed and exclusively owned source bytes, source regions, P2-compatible `footprint` and `headroom`, `unallocatedHeadroom:null`, and explicit domain. A table edit also includes the full shared table reader set. Headroom separates optimal fixed-table savings and unused character allocation after the highest write; proven free ROM is zero. `unionBytes(regions)` counts overlap once. |
| `ArtInstall` | `replacement(resources,index,{width,height,pixels})` → `{index,pens}` mapped into existing cells. Refuses resize, overlapping cell ambiguity and conflicting repeated tiles. `install(resources,[{index,pens}],{census?})` → copied `{program,data,edits,report}`. Requires the full allocation-plus-tail buffer, preserving unwritten pens. Supports private six-bit, same-shape fixed-table sources fitting original consumed extents, with complete tails. Refuses cached groups, index aliases, duplicate replacements, sound/table overlap, source sharing with any other upload, overlapping destination writes, growth and failed decode-back. Reports changed bytes and capacities used/left. `await expectations(result,replacements,pensFiles,context={})` emits P1's `cps3.art.p1.expectations.v1` manifest with full intended-pen hashes and the selected changed uploads; `pensFiles` maps index to an already saved file path. Context can carry `episode`, `frames`, `animation` for P1's live judge. Static checking needs no episode. AG6 proves the cel domain; P1's game judge remains separate. |
| `ArtPng` (U3) | `await read(bytes)` → `{width,height,pens,palette,rgba,origin,report,...}`. `await write({width,height,pens,palette,origin})` → PNG bytes. Palette is an array of RGBA entries; origin is `{x,y}` inside the canvas. The CLI preserves pens, palette entries and `cps3:origin`. |
| `ArtStretch` (10-29) | `pickRows(frames,w,h,[[top,bottom,add]],mode='clean')` → sorted canvas rows to repeat: per band, `add` rows with the fewest 1-row marks (a painted pixel unlike the pixels above and below) summed over every frame, never adjacent, pulled toward even spacing (integer scores, dynamic programming, ties to the earlier row); `mode='even'` is the CPS3 hardware spacing. `stretch(pixels,w,h,rows)` → a new buffer of the same size with each row repeated once, the top rising, the bottom fixed; throws when the top rows are not empty. `marks(frames,w,h)`. It matches the project’s reference implementation pixel for pixel. |

Cel bounds are `[left,top,right,bottom]` relative to the object's anchor. PNG and
document origins are `{-left,-top}` inside the canvas. Pen zero is transparent;
palette selection, cell palette offsets, blend history and zoom are separate
from a cel's indexed geometry. Indexed six-bit export refuses eight-bit cells
and canvases requiring multiple palette rows.

The shared `Cps3Rom` API adds `loadZips(zips,{graphics:true})` → a complete `data`
image (also `user`), `graphicsMembers(data,game)`, and
`await rebuildZips(originalZips,{program,data,game})` → named zip byte arrays.
Rebuilding preserves ancillary members and the parent's different first bank.
`saveImages`, `restoreImages`, `saveZips`, `restoreZips` accept an asynchronous
binary store `{get,set,del}`. Images and shared source archives use checked 4 MiB
chunks, with the manifest committed last. Music restores only the first 8 MiB of
sound data; Art loads the full graphics image on demand. Archives stay in the
shared disk vault so one import serves both modes. No raw zip or graphics image
remains in Music's active workspace. Browsers refusing storage retain an explicit
visit-only import; quota failures retain the prior image manifest.

The census is a synchronous exhaustive computation; call it in a worker when a
workspace needs it. UI ownership stays separate from these headless interfaces.

CLI: `node cli/art.js help`. Commands: `characters`, `animations`, `frames`,
`sharing`/`cost`, `extract`, `animation` (physical frames + manifest), `apply`,
`rom` (identity zip rebuild). Pass both original zips with repeated `--rom`.
Extraction needs an explicit 64-entry RGBA palette JSON or `--grayscale`; applying
a PNG requires the same palette selection and refuses a changed palette. Applying
also writes full intended `.pens` files and `expectations.json` for P1. Without an
episode, that manifest is explicitly static-only; its schema-required `frames:1`
is an unused placeholder, never a live timing or visibility claim. For live
acceptance supply `--episode path --frames N` for the actual episode. Outputs
are forbidden inside the product tree and on input ROM paths.

The public copy verifies its browser path and ROM-free source scan before delivery.
