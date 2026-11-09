# Character projects in Studio

A registered local character project opens inside **Art**, with the same Studio
module bar and drawing engine. It reads the project's existing source drawings,
animation plans, palettes, reference frames and quality marks. Opening Studio
again restores the selected character, animation and frame.

Use **Save drawings** or Ctrl S to write indexed PNGs to the project's source
folder. Each changed file keeps a backup. A changed source hash refuses a stale
save, and a failed save leaves the drawing marked unsaved. Switching modules
saves first; if saving fails, Studio keeps the project open. HUD/select artwork
and body animation keep separate selections.

**Edit animation** offers duration edits, insertion, removal, reordering and
separate editable copies of shared drawings. The project provider supplies the
verified game records and storage rules. Fixed timing preserves each game-span
budget; proposal mode explicitly marks timing changes. Removing a frame retains
its drawing. Undo and redo apply to the saved sequence plan.

**Projects** switches between registered character work and ordinary ROM artwork.
**Export project backup** downloads the source drawings, animation plans and
project metadata supplied by the provider. This archive is a local backup, not
a ROM build or a format accepted by the shared `.cps3project` importer. Restoring
it currently requires the project's own file workflow.

Saving source artwork and sequence plans does not install them into a running
game. The project's existing build pipeline still encodes and reviews those
changes. Studio's character preview shows stored frames, not full move logic.

## Local workspace interface

The source-only Studio includes `cps3_studio/local_server.py` and its optional
background launcher. Run with an explicitly supplied project configuration:

```sh
python cps3_studio/local_server.py --projects /path/to/projects.json --open
```

Configuration contains `defaultProject` and a `projects` array. Each entry has
an `id`, `title`, and `provider` Python file path relative to the configuration.
Providers are trusted local code supplied by the character project. No project
provider, artwork, palettes, reference stamps or effect images are bundled.

The provider exports `Provider()`, with a persistent `token`, an `effects` flag,
`get(operation, query)` and `post(operation, body)`. JSON results are returned as
data; downloads return `(bytes, mime_type)`. Core operations are `project`,
`sigs`, `save`, `animation`, `copy`, `own-everywhere`, `timing`, `quality` and
`export`; optional picture operations use `hud/catalog`, `hud/project`,
`hud/sigs` and `hud/save`. Optional effects are served as `effects.js` and expose
`ArtCharacterEffects` with `data` and `render`.

Project packets carry indexed sprite records (`id`, dimensions, origin offsets,
base64 pens, hash and editable flag), animation frame lists, palette rows,
default palette, preview rate, save description, token and file signatures.
Reference animations carry `reference: true`. Shade ramps and stamp parts are
loaded from project data, never embedded in public Studio source.

The helper binds to loopback. Saves require the project token and a matching
origin; the provider retains responsibility for exact dimensions, pens,
preimages, backups and atomic file replacement. General browser ROM editing
continues to work without a local character provider.
