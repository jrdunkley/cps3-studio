# Deliver integration

Load the kit (icons, controls, zip, CPS3 ROM), the H1 codec/cel/census/install
modules, `limits.js`, U3 PNG/slice/formats, then `gamecheck.js`, `delivery.js`,
`studio/deliver_worker_source.js` and `studio/deliver.js`. Include `deliver.css`.
The source capsule is required for browsers opening plain files; served pages
use the normal worker script. It contains source code only. After changing a
dependency, run `python -B checks/gates/worker_source.py`; the browser gate
refuses a stale capsule. No build step is needed by the person using the Studio.

`ArtDeliver.mount(host, options)` returns `update(project, changedSpriteIds)`,
`setSprite(id)`, `settled()`, `write()`, `check`, `report`, and `destroy()`.
Options:

- `project`: U1 keyed sprite documents; `rom`: the shared program and full data
  images. The original images remain unchanged.
- `palette`: 64 RGBA entries; `spriteId`: selected sprite.
- `frameUses`: sprite number to an array of `{character, animation, frame, label}`.
  Labels should read “character · animation · frame”. Missing frame ownership is
  an explicit finding. `paletteUses` similarly maps palette rows to names.
- `frames(scope)`: return the Library's selected animation/character frames as
  `{spriteId,width,height,pens,origin,duration,name}`. Changed documents override
  their original frame pictures before U3 exports the sheet.
- `metrics(result)`: update top-bar Changes, Room and Game Check with
  `ArtDeliver.bindMetrics(nodes,result)`. Pending values show “…” rather than
  stale numbers. `ArtDeliver.spriteFacts(host,facts)` renders the Sprite panel.
- `show(id)`: jump to Edit. `context`: the ROM/census context for mechanical fixes
  and project saving. `onFix(finding)` lets the application wrap a fix in history;
  otherwise `ArtGameCheck.fix` applies it directly. `status(text)` sets the footer.

Call `update(project,[spriteId])` after a stroke or history operation. It enqueues
only the affected document. Buffer copies run in chunks with a 3 ms task target;
the complete census, encoding and install work run in the worker. Other sprites'
checks remain cached. Full updates remove documents no longer in the project.
The component checks versions and refuses delivery if work changes while it is
being prepared. Close with `destroy()` to release the worker.

The supplied context uses `ArtDelivery.context(rom)` (compute its census away
from the canvas thread). Game Check accepts `resources`, `census`, `frameUses`,
`paletteUses`, and `domains`. Limited methods are accepted only inside a checked
domain. For the CLI's supported domain, the lead can set `installMethod` to
`same-shape-fixed-table-in-place` on `sprite.replace` and `rom.write`; the core
checks every structural, sharing, encoding and capacity constraint before write.
An unverified registry state always refuses delivery. Test fixture registries
and the bench's sample states are isolated from the production registry.

`ArtDelivery.build(project,context)` is the same headless path in Node and the
browser worker. It returns copied program/data, edits, file bytes and a report.
The output contains all 32 graphics SIMMs plus `art-edits.json` and
`art-report.json`. Only graphics sources within their existing consumed extents
can change. The per-file preview is calculated from the exact replacement byte
differences. Program, tables, palettes and sound bytes cannot be edited here.

Folder writes refuse a nonempty folder before opening a writable file. Cancelling
the folder picker cancels the operation. Browsers without it download one zip.
Neither delivery path looks up or writes an installed game. The CLI refuses
product, installed-game and input-ROM output directories, linked destinations,
and nonempty folders, and creates each file exclusively.

Command: `node cli/art.js deliver project.cps3art --rom <directory> --out <empty-directory>`.
It opens the project against the original ROM and uses the same registry gates
as the browser. A project's report never claims “Seen in the game”: that requires
a separate P1 judgement of those exact files. U4's saved in-game witnesses prove
the method inside their recorded domain, not every new project.

Gates on `checks/art_gates.py`: AG14 (Game Check), AG10D (Deliver browser and
byte parity), AG15D (CLI file parity and folder refusal), AG7S (Studio output
through P1's AG6/AG7 checker). `g_install_game.py --revalidate` rebuilds the
current project/installer output and compares it to the complete independently
unpacked live-tested ROM images. It reuses a passing game verdict only when
every recorded judge/runtime input is still fingerprint-identical. Full application
integration and the lead's screen acceptance remain AG10 and AG11 respectively.
