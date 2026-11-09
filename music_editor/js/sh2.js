/* SH-2 interpreter for running the game's own sound driver inside the music editor.
 * A port of the project's verified C core (the native machine of the research project, 
 * sh2_machine.h) with its FBNeo options on: a not-taken BT/S or BF/S does not run its slot as part
 * of the branch, and a PC-relative load in a delay slot uses the branch target + 2.
 * The research project compared it with that C core on the driver, write for write.
 */
(function sh2Module(g) {
  'use strict';
  const T = 1, S = 2, Q = 0x100, M = 0x200, FLAGS = 0x3F3;
  const s8 = (v) => (v << 24) >> 24, s16 = (v) => (v << 16) >> 16;

  class Sh2 {
    /* mem: { rd(addr, size) -> unsigned, wr(addr, size, value), fetch(addr) -> opcode } */
    constructor(mem) {
      this.mem = mem;
      this.r = new Uint32Array(16);
      this.pc = 0; this.pr = 0; this.sr = 0; this.gbr = 0; this.vbr = 0; this.mach = 0; this.macl = 0;
      this.inSlot = false; this.slotTarget = 0; this.steps = 0;
    }

    fault(what, a) { throw new Error(`SH-2 ${what} at ${(a >>> 0).toString(16)}`); }
    setT(c) { this.sr = c ? (this.sr | T) : (this.sr & ~T); }
    pcbase(a) { return this.inSlot ? (this.slotTarget + 2) >>> 0 : (a + 4) >>> 0; }

    delayed(a, target) {
      if (this.inSlot) this.fault('branch in a delay slot', a);
      this.slotTarget = target >>> 0;
      const slot = (a + 2) >>> 0;
      this.inSlot = true;
      this.exec(this.mem.fetch(slot), slot);
      this.inSlot = false;
      this.pc = target >>> 0;
    }

    div1(m, n) {
      const r = this.r;
      const oldQ = this.sr & Q;
      let tmp0;
      if (r[n] & 0x80000000) this.sr |= Q; else this.sr &= ~Q;
      r[n] = (r[n] << 1) | (this.sr & T);
      if (!oldQ) {
        if (!(this.sr & M)) {
          tmp0 = r[n]; r[n] -= r[m];
          if (!(this.sr & Q)) { if (r[n] > tmp0) this.sr |= Q; else this.sr &= ~Q; }
          else { if (r[n] > tmp0) this.sr &= ~Q; else this.sr |= Q; }
        } else {
          tmp0 = r[n]; r[n] += r[m];
          if (!(this.sr & Q)) { if (r[n] < tmp0) this.sr &= ~Q; else this.sr |= Q; }
          else { if (r[n] < tmp0) this.sr |= Q; else this.sr &= ~Q; }
        }
      } else {
        if (!(this.sr & M)) {
          tmp0 = r[n]; r[n] += r[m];
          if (!(this.sr & Q)) { if (r[n] < tmp0) this.sr |= Q; else this.sr &= ~Q; }
          else { if (r[n] < tmp0) this.sr &= ~Q; else this.sr |= Q; }
        } else {
          tmp0 = r[n]; r[n] -= r[m];
          if (!(this.sr & Q)) { if (r[n] > tmp0) this.sr &= ~Q; else this.sr |= Q; }
          else { if (r[n] > tmp0) this.sr |= Q; else this.sr &= ~Q; }
        }
      }
      tmp0 = this.sr & (Q | M);
      this.setT(!tmp0 || tmp0 === (Q | M));
    }

    macl_(m, n) {
      const r = this.r, mem = this.mem;
      const tn = BigInt(mem.rd(r[n], 4) | 0); r[n] += 4;
      const tm = BigInt(mem.rd(r[m], 4) | 0); r[m] += 4;
      let acc = (BigInt(this.mach) << 32n) | BigInt(this.macl);
      if (this.sr & S) {
        const product = BigInt.asUintN(64, tn * tm);
        let res0 = Number(product & 0xFFFFFFFFn), res2 = Number(product >> 32n);
        const lo = (this.macl + res0) >>> 0;
        if (this.macl > lo) res2 = (res2 + 1) >>> 0;
        res2 = (res2 + (this.mach & 0xFFFF)) >>> 0;
        res0 = lo;
        if ((res2 | 0) < 0 && res2 < 0xFFFF8000) { res2 = 0x00008000; res0 = 0; }
        else if ((res2 | 0) > 0 && res2 > 0x00007FFF) { res2 = 0x00007FFF; res0 = 0xFFFFFFFF; }
        this.mach = res2 >>> 0; this.macl = res0 >>> 0;
      } else {
        acc = BigInt.asUintN(64, acc + BigInt.asUintN(64, tn * tm));
        this.mach = Number(acc >> 32n); this.macl = Number(acc & 0xFFFFFFFFn);
      }
    }

    macw(m, n) {
      const r = this.r, mem = this.mem;
      const tn = s16(mem.rd(r[n], 2)); r[n] += 2;
      const tm = s16(mem.rd(r[m], 2)); r[m] += 2;
      const templ = this.macl;
      const prod = Math.imul(tn, tm), dest = (this.macl | 0) < 0 ? 1 : 0;
      let src, high;
      if (prod >= 0) { src = 0; high = 0; } else { src = 1; high = 0xFFFFFFFF; }
      src += dest;
      this.macl = (this.macl + prod) >>> 0;
      const ans = ((this.macl | 0) < 0 ? 1 : 0) + dest;
      if (this.sr & S) {
        if (ans === 1) { if (src === 0) this.macl = 0x7FFFFFFF; if (src === 2) this.macl = 0x80000000; }
      } else {
        this.mach = (this.mach + high) >>> 0;
        if (templ > this.macl) this.mach = (this.mach + 1) >>> 0;
      }
    }

    exec(op, a) {
      const r = this.r, mem = this.mem;
      const n = (op >> 8) & 15, m = (op >> 4) & 15, d4 = op & 15, i8 = op & 0xFF;
      switch (op >> 12) {
        case 0x0:
          switch (op & 0xF) {
            case 0x2:
              if (m === 0) { r[n] = this.sr; return; }
              if (m === 1) { r[n] = this.gbr; return; }
              if (m === 2) { r[n] = this.vbr; return; }
              break;
            case 0x3:
              if (m === 0) { const target = (a + 4 + r[n]) >>> 0; this.pr = (a + 4) >>> 0; this.delayed(a, target); return; }   // BSRF
              if (m === 2) { this.delayed(a, (a + 4 + r[n]) >>> 0); return; }                                                 // BRAF
              break;
            case 0x4: mem.wr((r[n] + r[0]) >>> 0, 1, r[m] & 0xFF); return;
            case 0x5: mem.wr((r[n] + r[0]) >>> 0, 2, r[m] & 0xFFFF); return;
            case 0x6: mem.wr((r[n] + r[0]) >>> 0, 4, r[m]); return;
            case 0x7: this.macl = Math.imul(r[n], r[m]) >>> 0; return;
            case 0x8:
              if (op === 0x0008) { this.sr &= ~T; return; }
              if (op === 0x0018) { this.sr |= T; return; }
              if (op === 0x0028) { this.mach = 0; this.macl = 0; return; }
              break;
            case 0x9:
              if (op === 0x0009) return;
              if (op === 0x0019) { this.sr &= ~(M | Q | T); return; }
              if (m === 2) { r[n] = this.sr & T; return; }
              break;
            case 0xA:
              if (m === 0) { r[n] = this.mach; return; }
              if (m === 1) { r[n] = this.macl; return; }
              if (m === 2) { r[n] = this.pr; return; }
              break;
            case 0xB:
              if (op === 0x000B) { this.delayed(a, this.pr); return; }                    // RTS
              this.fault('RTE/SLEEP', a);
              break;
            case 0xC: r[n] = s8(mem.rd((r[m] + r[0]) >>> 0, 1)); return;
            case 0xD: r[n] = s16(mem.rd((r[m] + r[0]) >>> 0, 2)); return;
            case 0xE: r[n] = mem.rd((r[m] + r[0]) >>> 0, 4); return;
            case 0xF: this.macl_(m, n); return;
          }
          break;
        case 0x1: mem.wr((r[n] + d4 * 4) >>> 0, 4, r[m]); return;
        case 0x2:
          switch (op & 0xF) {
            case 0x0: mem.wr(r[n], 1, r[m] & 0xFF); return;
            case 0x1: mem.wr(r[n], 2, r[m] & 0xFFFF); return;
            case 0x2: mem.wr(r[n], 4, r[m]); return;
            case 0x4: { const d = r[m] & 0xFF; r[n] -= 1; mem.wr(r[n], 1, d); return; }
            case 0x5: { const d = r[m] & 0xFFFF; r[n] -= 2; mem.wr(r[n], 2, d); return; }
            case 0x6: { const d = r[m]; r[n] -= 4; mem.wr(r[n], 4, d); return; }
            case 0x7:
              if (r[n] & 0x80000000) this.sr |= Q; else this.sr &= ~Q;
              if (r[m] & 0x80000000) this.sr |= M; else this.sr &= ~M;
              this.setT((r[m] ^ r[n]) & 0x80000000);
              return;
            case 0x8: this.setT((r[n] & r[m]) === 0); return;
            case 0x9: r[n] &= r[m]; return;
            case 0xA: r[n] ^= r[m]; return;
            case 0xB: r[n] |= r[m]; return;
            case 0xC: {
              const t = r[n] ^ r[m];
              this.setT(!(((t >>> 24) & 0xFF) && ((t >>> 16) & 0xFF) && ((t >>> 8) & 0xFF) && (t & 0xFF)));
              return;
            }
            case 0xD: r[n] = (r[n] >>> 16) | (r[m] << 16); return;
            case 0xE: this.macl = ((r[n] & 0xFFFF) * (r[m] & 0xFFFF)) >>> 0; return;
            case 0xF: this.macl = Math.imul(s16(r[n]), s16(r[m])) >>> 0; return;
          }
          break;
        case 0x3:
          switch (op & 0xF) {
            case 0x0: this.setT(r[n] === r[m]); return;
            case 0x2: this.setT(r[n] >= r[m]); return;
            case 0x3: this.setT((r[n] | 0) >= (r[m] | 0)); return;
            case 0x4: this.div1(m, n); return;
            case 0x5: { const p = BigInt(r[n]) * BigInt(r[m]); this.mach = Number(p >> 32n); this.macl = Number(p & 0xFFFFFFFFn); return; }
            case 0x6: this.setT(r[n] > r[m]); return;
            case 0x7: this.setT((r[n] | 0) > (r[m] | 0)); return;
            case 0x8: r[n] -= r[m]; return;
            case 0xA: { const t0 = r[n], t1 = (r[n] - r[m]) >>> 0; r[n] = t1 - (this.sr & T); this.setT(t0 < t1 || t1 < r[n]); return; }
            case 0xB: {
              const dest = (r[n] | 0) < 0 ? 1 : 0, src = ((r[m] | 0) < 0 ? 1 : 0) + dest;
              r[n] -= r[m];
              const ans = ((r[n] | 0) < 0 ? 1 : 0) + dest;
              this.setT(src === 1 && ans === 1);
              return;
            }
            case 0xC: r[n] += r[m]; return;
            case 0xD: { const p = BigInt.asUintN(64, BigInt(r[n] | 0) * BigInt(r[m] | 0)); this.mach = Number(p >> 32n); this.macl = Number(p & 0xFFFFFFFFn); return; }
            case 0xE: { const t0 = r[n], t1 = (r[n] + r[m]) >>> 0; r[n] = t1 + (this.sr & T); this.setT(t0 > t1 || t1 > r[n]); return; }
            case 0xF: {
              const dest = (r[n] | 0) < 0 ? 1 : 0, src = ((r[m] | 0) < 0 ? 1 : 0) + dest;
              r[n] += r[m];
              const ans = ((r[n] | 0) < 0 ? 1 : 0) + dest;
              this.setT((src === 0 || src === 2) && ans === 1);
              return;
            }
          }
          break;
        case 0x4:
          if ((op & 0xF) === 0xF) { this.macw(m, n); return; }
          switch (op & 0xFF) {
            case 0x00: case 0x20: this.setT(r[n] >>> 31); r[n] = r[n] << 1; return;
            case 0x01: this.setT(r[n] & 1); r[n] = r[n] >>> 1; return;
            case 0x21: this.setT(r[n] & 1); r[n] = (r[n] | 0) >> 1; return;
            case 0x02: r[n] -= 4; mem.wr(r[n], 4, this.mach); return;
            case 0x12: r[n] -= 4; mem.wr(r[n], 4, this.macl); return;
            case 0x22: r[n] -= 4; mem.wr(r[n], 4, this.pr); return;
            case 0x03: r[n] -= 4; mem.wr(r[n], 4, this.sr); return;
            case 0x13: r[n] -= 4; mem.wr(r[n], 4, this.gbr); return;
            case 0x23: r[n] -= 4; mem.wr(r[n], 4, this.vbr); return;
            case 0x04: this.setT(r[n] >>> 31); r[n] = (r[n] << 1) | (r[n] >>> 31); return;
            case 0x05: this.setT(r[n] & 1); r[n] = (r[n] >>> 1) | (r[n] << 31); return;
            case 0x24: { const t = r[n] >>> 31; r[n] = (r[n] << 1) | (this.sr & T); this.setT(t); return; }
            case 0x25: { const t = (this.sr & T) << 31; this.setT(r[n] & 1); r[n] = (r[n] >>> 1) | t; return; }
            case 0x06: this.mach = mem.rd(r[n], 4); r[n] += 4; return;
            case 0x16: this.macl = mem.rd(r[n], 4); r[n] += 4; return;
            case 0x26: this.pr = mem.rd(r[n], 4); r[n] += 4; return;
            case 0x07: this.sr = mem.rd(r[n], 4) & FLAGS; r[n] += 4; return;
            case 0x17: this.gbr = mem.rd(r[n], 4); r[n] += 4; return;
            case 0x27: this.vbr = mem.rd(r[n], 4); r[n] += 4; return;
            case 0x08: r[n] = r[n] << 2; return;
            case 0x09: r[n] = r[n] >>> 2; return;
            case 0x18: r[n] = r[n] << 8; return;
            case 0x19: r[n] = r[n] >>> 8; return;
            case 0x28: r[n] = r[n] << 16; return;
            case 0x29: r[n] = r[n] >>> 16; return;
            case 0x0A: this.mach = r[n]; return;
            case 0x1A: this.macl = r[n]; return;
            case 0x2A: this.pr = r[n]; return;
            case 0x0B: { const target = r[n]; this.pr = (a + 4) >>> 0; this.delayed(a, target); return; }   // JSR
            case 0x2B: this.delayed(a, r[n]); return;                                                       // JMP
            case 0x0E: this.sr = r[n] & FLAGS; return;
            case 0x1E: this.gbr = r[n]; return;
            case 0x2E: this.vbr = r[n]; return;
            case 0x10: r[n] -= 1; this.setT(r[n] === 0); return;
            case 0x11: this.setT((r[n] | 0) >= 0); return;
            case 0x15: this.setT((r[n] | 0) > 0); return;
            case 0x1B: { const t = mem.rd(r[n], 1); this.setT(t === 0); mem.wr(r[n], 1, t | 0x80); return; }
          }
          break;
        case 0x5: r[n] = mem.rd((r[m] + d4 * 4) >>> 0, 4); return;
        case 0x6:
          switch (op & 0xF) {
            case 0x0: r[n] = s8(mem.rd(r[m], 1)); return;
            case 0x1: r[n] = s16(mem.rd(r[m], 2)); return;
            case 0x2: r[n] = mem.rd(r[m], 4); return;
            case 0x3: r[n] = r[m]; return;
            case 0x4: { const v = s8(mem.rd(r[m], 1)); if (n !== m) r[m] += 1; r[n] = v; return; }
            case 0x5: { const v = s16(mem.rd(r[m], 2)); if (n !== m) r[m] += 2; r[n] = v; return; }
            case 0x6: { const v = mem.rd(r[m], 4); if (n !== m) r[m] += 4; r[n] = v; return; }
            case 0x7: r[n] = ~r[m]; return;
            case 0x8: r[n] = (r[m] & 0xFFFF0000) | ((r[m] & 0xFF) << 8) | ((r[m] >>> 8) & 0xFF); return;
            case 0x9: r[n] = (r[m] << 16) | (r[m] >>> 16); return;
            case 0xA: { const t = r[m], c = this.sr & T; r[n] = 0 - t - c; this.setT(t || c); return; }
            case 0xB: r[n] = 0 - r[m]; return;
            case 0xC: r[n] = r[m] & 0xFF; return;
            case 0xD: r[n] = r[m] & 0xFFFF; return;
            case 0xE: r[n] = s8(r[m]); return;
            case 0xF: r[n] = s16(r[m]); return;
          }
          break;
        case 0x7: r[n] += s8(i8); return;
        case 0x8:
          switch (n) {
            case 0x0: mem.wr((r[m] + d4) >>> 0, 1, r[0] & 0xFF); return;
            case 0x1: mem.wr((r[m] + d4 * 2) >>> 0, 2, r[0] & 0xFFFF); return;
            case 0x4: r[0] = s8(mem.rd((r[m] + d4) >>> 0, 1)); return;
            case 0x5: r[0] = s16(mem.rd((r[m] + d4 * 2) >>> 0, 2)); return;
            case 0x8: this.setT(r[0] === (s8(i8) >>> 0)); return;
            case 0x9: case 0xB: {
              if (this.inSlot) this.fault('branch in a delay slot', a);
              const taken = ((this.sr & T) !== 0) === (n === 0x9);
              if (taken) this.pc = (a + 4 + s8(i8) * 2) >>> 0;
              return;
            }
            case 0xD: case 0xF: {
              if (this.inSlot) this.fault('branch in a delay slot', a);
              const taken = ((this.sr & T) !== 0) === (n === 0xD);
              if (!taken) { this.pc = (a + 2) >>> 0; return; }
              this.delayed(a, (a + 4 + s8(i8) * 2) >>> 0);
              return;
            }
          }
          break;
        case 0x9: r[n] = s16(mem.rd((this.pcbase(a) + i8 * 2) >>> 0, 2)); return;
        case 0xA: case 0xB: {
          const d = ((op & 0xFFF) << 20) >> 20;
          const target = (a + 4 + d * 2) >>> 0;
          if ((op >> 12) === 0xB) this.pr = (a + 4) >>> 0;
          this.delayed(a, target);
          return;
        }
        case 0xC:
          switch (n) {
            case 0x0: mem.wr((this.gbr + i8) >>> 0, 1, r[0] & 0xFF); return;
            case 0x1: mem.wr((this.gbr + i8 * 2) >>> 0, 2, r[0] & 0xFFFF); return;
            case 0x2: mem.wr((this.gbr + i8 * 4) >>> 0, 4, r[0]); return;
            case 0x3: this.fault('TRAPA', a); break;
            case 0x4: r[0] = s8(mem.rd((this.gbr + i8) >>> 0, 1)); return;
            case 0x5: r[0] = s16(mem.rd((this.gbr + i8 * 2) >>> 0, 2)); return;
            case 0x6: r[0] = mem.rd((this.gbr + i8 * 4) >>> 0, 4); return;
            case 0x7: r[0] = ((this.pcbase(a) & ~3) + i8 * 4) >>> 0; return;
            case 0x8: this.setT((r[0] & i8) === 0); return;
            case 0x9: r[0] &= i8; return;
            case 0xA: r[0] ^= i8; return;
            case 0xB: r[0] |= i8; return;
            case 0xC: { const t = mem.rd((this.gbr + r[0]) >>> 0, 1); this.setT((t & i8) === 0); return; }
            case 0xD: { const ea = (this.gbr + r[0]) >>> 0; mem.wr(ea, 1, mem.rd(ea, 1) & i8); return; }
            case 0xE: { const ea = (this.gbr + r[0]) >>> 0; mem.wr(ea, 1, mem.rd(ea, 1) ^ i8); return; }
            case 0xF: { const ea = (this.gbr + r[0]) >>> 0; mem.wr(ea, 1, mem.rd(ea, 1) | i8); return; }
          }
          break;
        case 0xD: r[n] = mem.rd(((this.pcbase(a) & ~3) + i8 * 4) >>> 0, 4); return;
        case 0xE: r[n] = s8(i8); return;
      }
      this.fault(`illegal opcode ${op.toString(16)}`, a);
    }

    /* Run until PC == ret at an instruction boundary. */
    run(ret, limit) {
      let n = 0; const r = this.r, mem = this.mem;
      while (this.pc !== ret) {
        if (n++ >= limit) this.fault('step limit', this.pc);
        const a = this.pc;
        const op = mem.fetch(a);
        this.pc = (a + 2) >>> 0;
        /* Common non-branching instructions can dispatch here without another
         * interpreter call. Delay slots still use exec, including pcbase(). */
        const dst = (op >>> 8) & 15;
        switch (op >>> 12) {
          case 0x1: mem.wr((r[dst] + (op & 15) * 4) >>> 0, 4, r[(op >>> 4) & 15]); continue;
          case 0x6: {
            const src = (op >>> 4) & 15;
            switch (op & 15) {
              case 0: r[dst] = s8(mem.rd(r[src], 1)); continue;
              case 1: r[dst] = s16(mem.rd(r[src], 2)); continue;
              case 2: r[dst] = mem.rd(r[src], 4); continue;
              case 3: r[dst] = r[src]; continue;
            }
            break;
          }
          case 0x7: r[dst] += s8(op & 255); continue;
          case 0x8:
            if (dst === 9 || dst === 11) {
              if (this.inSlot) this.fault('branch in a delay slot', a);
              if (((this.sr & T) !== 0) === (dst === 9)) this.pc = (a + 4 + s8(op & 255) * 2) >>> 0;
              continue;
            }
            break;
          case 0x9: r[dst] = s16(mem.rd((a + 4 + (op & 255) * 2) >>> 0, 2)); continue;
          case 0xD: r[dst] = mem.rd((((a + 4) & ~3) + (op & 255) * 4) >>> 0, 4); continue;
          case 0xE: r[dst] = s8(op & 255); continue;
        }
        this.exec(op, a);
      }
      this.steps += n;
    }
  }

  g.SF3Sh2 = Sh2;
  /* the module's own source, so a page can run the same code in a Worker (studio/transport.js) */
  g.SF3Modules = Object.assign(g.SF3Modules || {}, { sh2: sh2Module });
  if (typeof module !== 'undefined') module.exports = { Sh2 };
})(typeof window !== 'undefined' ? window : globalThis);
