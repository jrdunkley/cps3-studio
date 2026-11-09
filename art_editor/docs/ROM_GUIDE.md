# Put artwork in a private game copy

Deliver checks replacements against their existing tiles, stored-byte ownership and exact
encoding. It writes the 32 graphics members, `art-edits.json` and `art-report.json` to an empty
folder, or puts them in one zip. These are replacement members, not a complete game set.
Keep your original `sfiii3nr1.zip` and `sfiii3.zip` read-only.

Save your `.cps3art` work, resolve Game Check, then use **Write patched ROM files…**.
Cancelling the folder chooser cancels writing. The report describes the actual file changes.
Palette changes are refused by the current graphics-only delivery method; export their native
JSON to keep them while a supported delivery route is being completed.

To play, make a separate copy of both original archives. Replace only the named graphics
members in the private parent archive with the files Deliver wrote. Keep the BIOS, program,
other members and your originals. Use a private emulator configuration that points only at
the copied set. A changed member has a new checksum: an emulator may require an explicit
private checksum-aware build. Passing an encoding check does not prove an arbitrary new
picture in the running game.

In the private development workspace, **Play my art.bat** beside the delivered folder accepts
that folder or its zip. It creates a separate checksum-aware emulator and ROM set, then opens
that copy from power-on. It is a local Windows helper, not part of the public Studio.

Open Art and Music from the same launcher and browser to share the remembered ROM. If a
browser will not remember disk pages, an owner can run `python studio_kit/local/prepare_rom.py
<folder-with-both-zips>` from the top of their own copy. It makes the private ROM pickup used
by disk pages. Keep that generated pickup off shared copies; removing it does not erase an
import already remembered in browser storage.

For each new output inspect the replacement in play, its other colours and facing, every
shared frame, and the original animation timing. The exact checks on the supported method
are recorded separately from this project's own file checks. See
[WHAT_ART_CANNOT_DO_YET.md](WHAT_ART_CANNOT_DO_YET.md).
