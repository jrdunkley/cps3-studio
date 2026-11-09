# Working across CPS3 Studio

## Edit a move and test a hit

1. Open Moves and import your source if necessary.
2. Select the character, move group and stored move. Select a timeline record to see its fields.
3. Change a supported field. Use Undo/Redo to compare it with the original, and play the stored sequence to inspect timing and artwork.
4. Select **Hit preview**, choose an opponent and distance, then use the displayed controls. This setup runs the native game logic; some move names have an input recipe and others need manual input.
5. Use **Try in game** for the Game page or **Build ROM** for a separate ZIP. **Save project** preserves the editable shared project.

Edits target existing records. Shared records may affect multiple moves. The artwork sequence and the game's final combat behaviour are different views: use the game preview to assess interactions.

## Find artwork and its colour context

Open Art's Library and Everything browser. Search or select a sprite ID, inspect its usage links and choose a known palette context. Unknown contexts remain visible rather than being assigned an invented colour. Discovery connects known animations, scene tables and palette sources; it does not exhaust every possible runtime use.

Character colour edits, extended/stage palettes and Gill's timed phases have different storage rules. Use their dedicated controls. For drawing, a selected contextual palette is a preview choice; it does not automatically author a palette edit. Open Deliver to check the actual changes and write eligibility.

## Try changes in Game

A module's **Try in game** stages the supported output and sends the images to Game. The Game page provides playback, frame controls, local save slots, comparisons and inspection. Use its settings for controls and sound. An original/edited comparison must use matching source identity, settings and inputs to be meaningful.

Save slots contain data copied from your ROM. They stay in local browser storage. A slot made with another image can restore already-loaded data from that image; heed the slot warning when comparing edits.

## Combine edits

Save your documents and use the editor's build/delivery action to stage its changes in the shared project. Review the shared change list before building. A combined build checks source identity, write preconditions and overlapping writes across layers. Unsupported operations and conflicting edits are rejected with a reason.

Export the shared `.cps3project` as a backup. Switch source or mode through Studio's selector; do not rename archives to force compatibility. The shared project CLI can inspect, validate, build and run scenarios from exported projects.

## Keep a clean tool repository

Keep personal ROMs, patched builds, project exports, artwork, audio and snapshots outside your source checkout where practical. If you use the ignored output folders, review `git status` before committing. A project or save file may contain ROM-derived bytes even when its extension looks like ordinary JSON.
