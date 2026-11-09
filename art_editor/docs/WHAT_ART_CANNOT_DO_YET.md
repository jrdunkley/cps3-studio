# What Art mode cannot do yet

Generated from the capability registry when this copy was built.

**See and export any sprite** · proven

Sprites are read from your ROM exactly as the game stores them.

**Replace a sprite inside its own tiles** · limited

A changed sprite that keeps its tiles and fits its own bytes goes into the game as drawn.

For a sprite that shares no stored bytes, table writes or tiles with another, keeps its tiles, and fits the bytes it owns.

**Replace every frame of an animation** · limited

A whole animation can be replaced frame by frame.

Each frame under the same conditions as a single sprite.

**Know what else a change touches** · limited

The Studio lists every other sprite that reads the same stored bytes, table or tiles before you change it.

Complete for sprites the game stores in its sprite list. Which frames show a sprite is known for character animations; effects and interface art are not all named yet. Suggested names for the rest are labels, not proof of who uses a sprite.

**Sprites stored the other way (256 pens or uncompressed)** · Not verified

A few sprites are not stored as 64 pens. They can be seen; changing them is not proved.

**Use more bytes than the sprite had** · Not verified

A change that needs more bytes than the sprite owns needs spare room in the ROM. Growing into bytes freed beside it has worked exactly in the game in a test; it is not offered until every reader of those bytes and every possible load of them is accounted for.

**Paint outside the stored tiles** · Not verified

A larger picture needs more tiles in the ROM and in video memory, and a complete prediction of where the game puts and copies the enlarged sprite.

**Move the origin or the tile layout** · Not verified

Changing where the game places a sprite changes its layout record; it needs a complete prediction of its placement and copies throughout the game.

**Give a shared frame its own copy** · Not verified

Separating a frame from the others that share its sprite needs its own record and picture bytes. A slot built from placeholder records and placeholder-only bytes has worked exactly in the game in a test; it is not offered until every reader and possible load of that storage is accounted for.

**Add new sprites or frames** · Not verified

A new frame needs safe storage for its record and picture, with every reader accounted for. Calling a placeholder number from an animation and giving it new pictures has worked exactly in the game in tests; the slot must keep the capacity of the frame it stands in for.

**Know that a change loads in time** · limited

A sprite replaced inside its own tiles asks the game for exactly the same loads as the original, so it appears when the original would.

Replacements that keep the sprite’s tiles. For anything larger the Studio shows how much the game must load, without a verdict: when a load finishes also depends on what else the game is drawing.

**Change a character’s colours** · limited

Each selectable colour of a character is read from the ROM and can be changed; Deliver writes the change into the ROM files.

Body colours of every character, all seven colour slots (Gill's body is recoloured by the game as it runs and stays read-only). Effect rows: only Ryu's projectile rows are proved. A changed row reads back exactly from the written files and every other stored colour row is untouched; each of the other 20 characters' body colour was shown exactly in a fight on the native machine, and Ryu's also in Fightcade's emulator. Which effect rows belong to whom is not complete.

**HUD and Judgement face colours** · limited

The 16 colours of each character’s HUD face (beside the life bar) and Judgement face (the time-out decision screen) can be changed for all seven colours; Deliver writes them into the ROM files.

Stored 16-colour rows that the game copies with its own palette DMA: HUD faces from 03363B00 + 0xE0 per character + 0x20 per colour (loader 060D6CC4, at fight start); Judgement faces from 03389900 + 0x300 per colour + 0x20 per character (loader 060D5258 copies the whole colour block). The HUD face picture is previewed from its 15 SS tiles; the Judgement face picture is previewed from its panel cel 0x9DA8 + character (effect 37, read in the byte-exact source). In Fightcade’s emulator, face rows written by Deliver’s FBNeo patch load bit for bit (HUD rows 1FE0/1FF0 at fight start; both Judgement colour blocks at the time-out decision) and are what the HUD face and the judges’ panels show. Infinite extra colours show the native faces.

**Change a stage’s colours** · limited

Both stored colour banks of every stage can be changed; Deliver writes them into the ROM files. The game applies its own fades to them as it runs.

Both banks of all 23 stages read back exactly from the written files with every other stored row untouched. In forced stage loads on the native machine the edited colours loaded exactly as predicted on 21 stages and changed the picture exactly on 12 banks; the fixtures for stages 13 and 16 never loaded their banks. Ryu's stage and stage 0 also in Fightcade's emulator. Round variants and lighting the game computes are not checked.

**Gill timed body colours** · limited

Edit the two halves of Gill's colour cycle, with 48 colours in each phase.

Known 48-word program sources, preserving flags, phase tables, timing and the remaining 16 words, only where Gill’s colour handler and phase tables match the verified native ones. The original game has three timed full-state and picture comparisons. Infinite 1.07b changes Gill’s colour handler, so its timed colours are not listed there yet (Palettes says so). Sources shared by repeated phases and colour selections change together.

**Infinite extra colours** · limited

Edit Infinite body and auxiliary colours on their installed button chords.

The 33 installed extra choices for 19 characters, preserving handler code, row geometry and flag bits, read only where the installed handlers match the verified ones (earlier Infinite releases). Infinite 1.07b chains these hooks through Evil Ryu’s selection and colour code, which the Studio has not verified, so its extra colours are not listed yet (Palettes says so). Fighter, copy and assist rows share each source. Faded requests retain their native writers. Natural selection and effect lifetime coverage are separate checks.

**Infinite stage variants** · limited

Edit both banks of Infinite's installed Oro and garage variants.

Seven installed variants, read only where the stage colour hook matches the verified one (an earlier Infinite release). Infinite 1.07b installs a different stage colour hook with its new stages, which the Studio has not verified, so its variants are not listed yet. Oro advances through variants 2 to 6 as total losses increase; garage defaults to 7. Copy and round refresh preserve native fallback requests. Initial layer previews use the direct palette conversion. Live mode dispatch and stage schedules have separate gates.

**Colours the game works out as it runs** · Not verified

Fades and time-of-day colours are made by the game, not stored. They are shown, not edited.

**See a stage’s layers** · limited

Each stage’s layers are read from your ROM as the game first loads them, and can be exported.

All 23 initial stage identities: the picture each stage starts with. Moving parts, lighting changes, other rounds and where the camera looks are not shown. One stored stage picture the game was never seen to load is marked unchecked; the two bonus scenes were only seen black.

**Change stage artwork** · Not verified

Stage tiles can be repainted where they are stored. A repainted tile and a moved tile have each appeared exactly as predicted in the game in a test; it is not offered until every reader and possible stage load of those bytes is accounted for.

**See interface art** · limited

The small 8 × 8 interface tiles (text and gauges) are read from your ROM and can be exported.

Single tiles by number, read-only. Which tiles make which word or gauge, and portraits and logos, are not identified yet.

**Change interface art** · Not verified

Interface art can be repainted where it is stored.

**Write patched ROM files** · limited

The Studio writes changed ROM files to a folder you choose and never touches the installed game.

Graphics files: same-shape sprite replacements and stored colour rows, each inside the board envelope (gate AGH).

**Check a change in the running game** · limited

A change is compared, frame by frame, with the picture the Studio predicted.

In the development workspace, with its private emulator copy. The portable Studio cannot start a game; it tells you how to look.
