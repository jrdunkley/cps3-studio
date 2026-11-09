"""The sequence check in Python, for ROM pipelines that are not written in JavaScript.

    python check_sequence.py song.bin [more.bin ...]

A sequence (byte 0 = 0, then 16 track offsets, then the tracks) is read the way the driver reads it;
anything it would misread raises. The Studio's own check is Seq.check / Cps3Rom.install (JavaScript);
gate G5 checks that both accept the same sequences.
"""
import struct
import sys

PARAMS = {0xC0: 0, 0xC1: 2, 0xC2: 1, 0xC3: 1, 0xC4: 1, 0xC5: 1, 0xC6: 1, 0xC7: 1, 0xC8: 1, 0xC9: 1, 0xDC: 1, 0xDD: 1, 0xDE: 1, 0xDF: 1,
          0xE0: 1, 0xE1: 1, 0xE2: 1, 0xE3: 1, 0xE4: 2, 0xE5: 2, 0xE6: 1, 0xE7: 1, 0xE8: 2, 0xCC: 2, 0xCD: 2, 0xCE: 2, 0xCF: 1,
          0xD4: 1, 0xD5: 1, 0xD6: 1, 0xD7: 1, 0xD8: 2, 0xD9: 2, 0xDA: 2, 0xDB: 2}


def check_sequence(seq):
    """The same linear reading the editor's converter does; raises on anything the driver would misread."""
    assert seq[0] == 0, 'not a music sequence'
    offsets = struct.unpack_from('>16H', seq, 1)
    starts = sorted(o for o in offsets if o)
    assert starts and starts[0] == 0x21 and len(set(starts)) == len(starts), 'track offsets'
    events = 0
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(seq)
        p, marks, jumps = start, set(), []
        while p < end:
            marks.add(p)
            while not seq[p] & 0x80:
                p += 1
            op = seq[p]; p += 1
            if op < 0xC0:
                p += 1
                while seq[p] & 0x80:
                    p += 1
                p += 1
            else:
                n = PARAMS.get(op, 0)
                if 0xD8 <= op <= 0xDB:
                    jumps.append(p + 2 + (seq[p] << 8) + seq[p + 1])
                p += n
            events += 1
        assert p == end, f'track at {start:#x} does not end on an event'
        marks.add(end)
        assert all(j in marks for j in jumps), 'a loop exit lands inside an event'
    return events


if __name__ == '__main__':
    for name in sys.argv[1:]:
        with open(name, 'rb') as f:
            print(f'{name}: {check_sequence(f.read())} events, well formed')
