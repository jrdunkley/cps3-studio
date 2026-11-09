# Art commands

Run `node cli/art.js help` from `art_editor`. Commands print JSON; errors go to stderr and
return a nonzero exit code. Use your own stock Japan 990512 NO CD rev 1 zips. Outputs must
be outside the product folder and input archives. Nothing starts a game.

```sh
node cli/art.js characters --rom /private/sfiii3nr1.zip --rom /private/sfiii3.zip
node cli/art.js animations 2 --rom /private/sfiii3nr1.zip --rom /private/sfiii3.zip
node cli/art.js frames 2 0 --section nmca --rom /private/sfiii3nr1.zip --rom /private/sfiii3.zip
node cli/art.js sharing 24033 --rom /private/sfiii3nr1.zip --rom /private/sfiii3.zip
node cli/art.js extract 24033 --grayscale --out /private/sprite.png --rom /private/sfiii3nr1.zip --rom /private/sfiii3.zip
node cli/art.js deliver /private/project.cps3art --rom /private/roms --out /private/empty-output
```

Check the animation slot and section in `animations` before asking for its frames.
`sharing` (also `cost`) reports source/table/tile readers, owned extents and measured
re-encoding savings. Savings do not grant spare room. `extract` needs `--palette row.json`
with exactly 64 RGBA entries (pen 0 transparent, every other pen opaque), or the explicit
`--grayscale` pen visualisation. The latter is not a claim about the game's colours.

`animation CHARACTER SLOT --section SECTION --out FOLDER` extracts physical frames and an
`animation.json` manifest; it needs the same palette choice and repeated ROM arguments.
Command paths, dynamic offsets and hit stop need game context. This command's physical-frame
manifest differs from Deliver's sheet-plus-manifest interchange.

`apply SPRITE --input replacement.png --palette row.json --out FOLDER` rebuilds private zips
using existing tiles and fixed tables. It refuses changed dimensions, origin or palette,
shared/aliased resources, growth and unsupported layouts. It also writes intended pen files
and a static expectations manifest. `rom --out FOLDER` rebuilds identical archives. Both
require the original zips with repeated `--rom` arguments. These lower-level commands are
for pipeline work; use `deliver` for a saved Studio project and the capability policy.

`deliver` takes a folder containing both original zips and an empty output folder. It refuses
unsafe destinations and unsupported methods. Do not assume a limited capability is licensed
for every input: inspect [the registry](WHAT_ART_CANNOT_DO_YET.md), Game Check and the actual
error. The current command-line delivery route also waits for a method permission that the
registry has not supplied. A supported browser delivery can therefore still be refused by
this command. Use the browser's Deliver workspace while that policy gap remains.
No command earns **Seen in the game** from writing files. A static expectations
manifest is not a recorded replay or a live comparison.

Use [CORE_API.md](CORE_API.md) and [DELIVER_API.md](DELIVER_API.md) for data contracts. Keep
ROM-derived pictures, pen files, reports, patched archives and caches private.

## Indexed drawing helpers

`js/tween.js` rebuilds a selected region from its neighbours using block flow.
`js/stretch.js` repeats rows within a selected band; `js/scale.js` resizes a selection
or pushes whole rows/columns. They are ROM-free, loadable in Node, and shared with
the browser tools. `studio/edit.js` supplies origin alignment, layer history and
atomic multi-frame changes. See [ART_GUIDE.md](ART_GUIDE.md) for controls.
