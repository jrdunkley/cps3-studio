# Drawing for the game

## Change one frame in five steps

1. Open the Studio's launcher, choose Art, and give the welcome both ROM zips. One import
   serves Music and Art. The browser remembers them when local storage is available.
2. Open Library, choose a character, expand an animation and double-click a frame.
3. Read **Shared sprite** and **Room**, then press `B` for Pencil. Choose a pen and draw
   inside the stored tiles. `Alt` picks a pen, `T` shows tiles and `Ctrl Z` undoes a stroke.
4. Play the animation. Use **Every colour** and **Other side** to check other palettes and
   the mirrored picture. `Y` shows nearby frames aligned by origin.
5. Open Deliver. Save **Work** as a `.cps3art` project, then read **Game Check** before writing
   ROM files. A picture that draws in Edit may still need room or a method not yet offered.

## Motion blur the way the originals do it

Capcom's blur frames are made four ways, and Edit has a tool for each. **Smear** (`S`)
drags the cross-section of the part under the brush, or of the selection, along the
stroke, so a limb's ramp becomes clean bands; **Taper** narrows it to a point, the way a
slashing hand is drawn. **Sweep** (`A`) swings the part round a pivot into a fan, the arc
of a kick; `Alt`-click sets the pivot. **Streak** (`K`) pulls painted rows out along the
drag into speed lines: *Stretch* resamples each run, *Trail* extends its last pen into
empty space, and Rows, Jitter and Feather shape the comb of a dash. The **Pattern**
setting on Pencil and Eraser thins a figure with a checker or sparse dither, the way a
dash frame dissolves. Smear and Sweep read the selection as their source and paint
outside it; *Copies* mode lays whole copies instead, spaced out for echoes; a *Tail* can
go one ramp step darker, take the secondary pen or dissolve. Each stroke is one exact
undo step.

## Motion, finishing and in-between frames

**Tween** (`/`) rebuilds a box or selection from the frames before and after it.
`Tab` or `1`–`4` cycles four candidates; click to keep one, `Esc` to cancel.
Options set timing, tracking reach, colour matching and painting behind existing
pixels. Neighbouring drawings align by origin; Loop allows the other end of a cycle.

With **Move** (`V`), drag one of the selection's eight handles to scale it.
`Shift` preserves its proportions and `Esc` cancels. **CPS3 rows** repeats/drops
rows and columns with nearest sampling; **Clean rows** favours less detailed rows.
**Outside: Pushed** moves surrounding rows/columns to make space. **Frames: All
selected** applies the same mapping to selected sprites as one undo step.
**Stretch…** in selection options adds rows inside a band, keeping the feet fixed.
Incompatible canvases are reported; operations that would discard painted pixels
outside the canvas are refused.

**Form** (`J`) shades a limb or fold; **Edge** (`D`) lights, inks or lifts an edge;
**Tidy** (`C`) removes flecks and pinholes. **Ribbon** (`R`) draws a tapered strip,
and **Fray** (`Q`) shapes a torn edge. These tools use the palette's shade ramps;
**Regroup…** changes their pen order and saves it in the project. The Light control
shows the shading direction. **Stamp** (`N`) grabs the selection as a reusable
part, with a local library of saved parts. **Guide layer…** places another loaded
sprite beneath the drawing at half strength. Guides stay out of saved projects,
PNG exports and ROM delivery.

Drawing changes retain the existing game-storage and delivery checks. Sequence
insertion from private character build tools is not part of the public editor;
Moves continues to edit supported stored records. No character workspace or
pre-extracted parts library is bundled.

## Bring in a sprite sheet

Choose **Import onto…** in Library or the frame strip, and select the sheet. A sheet exported
by this Studio should travel with its JSON manifest. Import uses its rectangles and origins.
Use an unscaled 1× export for importing; larger exports are for sharing pictures.

In **Slice**, set cell size, margins and gaps, or choose **Find sprites** for transparent
gutters. Drop unwanted frames and inspect every outline. In **Match colours**, review the
colour-to-pen rows and heat map. Indexed pictures already using the chosen palette say
**Pens kept exactly**. Dithering is off until you choose it. Partial transparency needs an
explicit choice; the Studio does not guess it away.

In **Place frames**, join each picture to its target and choose origin, feet or centre
alignment. Nudge while looking at the original underneath. Unmatched pictures remain visible.
Nothing is resized. Overflow is shown: trim only if you choose to; keeping extra tiles does
not make those tiles deliverable. Dropping a single picture into Edit adds a paint layer,
or a reference layer. A reference never enters the game.

## Recolour a character

Open Palettes, choose the character, then select pens in a row or click them in the preview.
`Shift` adds to the selection; `Alt` removes. Change RGB in the game's whole five-bit steps,
or preview **Shift ramp**, **Gradient** or **More…** (greyscale, invert, reverse) and apply
it as one undo step. Hold **Original** to compare and use **Flash selection** to find a pen.

Each colour lists its body row, its **HUD face** (the small face beside the life bar) and its
**Judgement face** (the time-out decision screen). Selecting a HUD face row previews the face.
**Faces follow body** carries your body changes onto the faces of all seven colours while
keeping Capcom's own face shading; undo restores them. Gill's timed colours open from the
bar above the rows when Gill is chosen. Pen 0 is see-through and is never changed.

## Share colours with PalMod, FBNeo and other tools

- **Copy for PalMod** puts the selected pens, or the whole row, on the clipboard as a PalMod
  colour string, such as `("a0080…)`. **Paste colours** takes a PalMod string from any CPS3
  game, or a list of `#RRGGBB` colours.
- **Export…** writes one row as ACT (PalMod, Photoshop), MUGEN ACT (upside down, for Fighter
  Factory), GIMP GPL (Aseprite, Krita), JASC or RIFF PAL, or a PNG strip. JSON keeps every
  row, name and group. **Import…** also reads the colour table of an indexed PNG, GIF or BMP.
- **Open a mod…** reads palette mods made with PalMod or other tools: a patched ROM zip, the
  SIMM files, PalMod's `51` file, IPS patches, or an FBNeo patch folder as a zip. Every
  changed colour is listed by character and row before it is applied.
- **Colour sheet…** saves one picture of the character in all seven colours, as PalMod and
  palette-sharing sites show them.
- In Deliver, **FBNeo patch…** saves your changes as IPS patches with FBNeo's `.dat` list.
  Unzip it into the FBNeo folder; the patch then appears for `sfiii3nr1` in FBNeo's IPS
  manager. Patches are a few hundred bytes and hold only your changes.

Files from CPS3 tools store expanded five-bit colours, and these import exactly. Other colours
snap to the nearest game step, and the import window lists every colour that moves.

## Look at a stage

Open Library's stage view, choose a stage, then inspect its initial layer atlas and stored
colour sets. Export the layer you need as a private reference. An atlas is not a simulation
of the game's camera or moving scene. The exact capability text for this build follows.

**Change a stage’s colours** · limited

Both stored colour banks of every stage can be changed; Deliver writes them into the ROM files. The game applies its own fades to them as it runs.

Both banks of all 23 stages read back exactly from the written files with every other stored row untouched. In forced stage loads on the native machine the edited colours loaded exactly as predicted on 21 stages and changed the picture exactly on 12 banks; the fixtures for stages 13 and 16 never loaded their banks. Ryu's stage and stage 0 also in Fightcade's emulator. Round variants and lighting the game computes are not checked.

**See a stage’s layers** · limited

Each stage’s layers are read from your ROM as the game first loads them, and can be exported.

All 23 initial stage identities: the picture each stage starts with. Moving parts, lighting changes, other rounds and where the camera looks are not shown. One stored stage picture the game was never seen to load is marked unchecked; the two bonus scenes were only seen black.

**Change stage artwork** · Not verified

Stage tiles can be repainted where they are stored. A repainted tile and a moved tile have each appeared exactly as predicted in the game in a test; it is not offered until every reader and possible stage load of those bytes is accounted for.

## What loads in time

Read the load figures in Edit and Deliver where available. Decoded bytes and load requests
describe work; they do not alone predict when a larger replacement appears. The exact
capability text for this build follows.

**Know that a change loads in time** · limited

A sprite replaced inside its own tiles asks the game for exactly the same loads as the original, so it appears when the original would.

Replacements that keep the sprite’s tiles. For anything larger the Studio shows how much the game must load, without a verdict: when a load finishes also depends on what else the game is drawing.

## Put it in the game

Save Work first. In Deliver, read each change and Game Check. Fix or reset any refused change.
When writing is offered, choose an empty private folder or save the downloaded zip, or use
**FBNeo patch…** for a small patch instead of whole files.
**Encodes back exactly** and **Reads back from the patched ROM** are checks on those files.
Every changed sprite stream is also checked against the grammar Capcom's own data uses,
because a real CPS3 board draws solid blocks for streams that emulators show correctly.
**Seen in the game** requires an actual game comparison for that particular output.

Follow [ROM_GUIDE.md](ROM_GUIDE.md) to supply the remaining members and test an isolated set.
The Studio never changes your installed game. Larger sprites, new frames and stage edits
remain subject to [the generated limits page](WHAT_ART_CANNOT_DO_YET.md).
