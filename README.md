# LogixSim

A 3D PLC training game. You play a controls technician in a training plant: walk the floor in first person, program machines at a PLC workstation that works like a Logix-style editor, and watch your logic drive Factory-style 3D machines. Whatever logic you write is exactly what drives the machines.

> LogixSim is an independent training game. It copies how industrial controller software behaves; it is not affiliated with, and does not use the names, logos or artwork of, any PLC or simulation vendor.

## Status

| Stage | Scope | State |
|---|---|---|
| 1 | Tag database and PLC engine, ladder instructions, tests | **done** |
| 2 | Ladder editor + online view | planned |
| 3 | Structured Text | planned |
| 4 | SFC | planned |
| 5 | FBD | planned |
| 6 | I/O configuration and mapping panel | planned |
| 7 | 3D scene engine and parts | planned |
| 8 | Built-in scenes (Bytronic trainer first) | planned |
| 9 | Watch window, forces, trends, faults UI | planned |
| 10 | Walkable plant, first-person controller, laptop and tablet | planned |
| 11 | Career, troubleshooting and sandbox missions | planned |
| 12 | Sound, lighting, HUD, settings, save/load | planned |

## Setup

Requires Node.js 20+.

```bash
npm install
npm test            # all Vitest tests (headless engine)
npm run typecheck   # TypeScript, no emit
npm run dev         # browser shell (Stage 1: engine console with a demo program)
npm run build       # typecheck + production build
npm run bench:scan  # scan-time performance test only
```

## Architecture (Stage 1)

The PLC engine is headless and has no UI dependencies (`src/plc`). The game will only display it.

```
src/plc/
  core/       data types, values and Logix numeric conversion, tag database, operand refs, runtime, faults
  expr/       tokenizer, Pratt parser and typed compiler for expressions (CPT/CMP, subscripts; reused by ST)
  ladder/     rung model, neutral text parser/serializer, routine compiler, instruction groups
  engine/     project model, I/O chassis, project compiler (Verify), controller (modes, scan loop, scheduling)
  __tests__/  Vitest tests
```

- **Deterministic time.** The controller runs on virtual time. `controller.advance(ms)` runs every task scan due in `[now, now + ms)`; the continuous task scans every `scanPeriodMs` (default 10 ms). Periodic tasks run at their period, higher priority first when due together. Scene physics (Stage 7) steps at 5 ms and calls the same API, so a whole plant can be simulated in tests without a browser.
- **Scan.** Read input image → run the main routine of each program in the task (JSR'd routines run when called) → write output image.
- **Compile, then run.** Download compiles every rung into closures bound directly to tag storage. Verify and Download share the compiler, so Download is blocked whenever Verify reports an error.
- **Prescan.** Entering Run prescans every routine once: OTE outputs are cleared, TON timers reset, TOF accumulators set to preset, one-shot storage bits primed, CTU/CTD `.CU`/`.CD` set, FIFO loads and unloads armed. Then the first scan of each program runs with `S:FS` set.
- **Faults.** Array subscripts out of range (Type 4 Code 20), divide by zero (Type 4 Code 4, major in LogixSim), negative timer preset/accumulator (Type 4 Code 34), JSR/SBR/RET parameter mismatch (Type 4 Code 31) and task watchdog (Type 6 Code 1) stop the controller. The fault record holds the task, program, routine, rung, element and instruction (also for faults raised during prescan). Arithmetic overflow is a minor fault (sets `S:V` and `S:MINOR`). A program's fault routine (instruction faults) and the Controller Fault Handler program run once when a major fault occurs; without GSV/SSV they cannot clear it yet.
- **Online view data.** Each ladder routine exposes `power` (power flow out of every element, in the pre-order ids of `walkRung`), `rungIn` and `scanned` (the scan id that last executed each rung, compared with `Runtime.scanId`, so rungs skipped by JMP/RET show as not scanned) through `controller.ladderState(program, routine)`.

### Using the engine

```ts
import { Controller, ladderProject } from './src/plc';

const plc = new Controller();
const result = plc.download(
  ladderProject({
    modules: [{ slot: 1, catalog: 'LX-IQ16' }, { slot: 2, catalog: 'LX-OB16' }],
    tags: [
      { name: 'Start', dataType: 'BOOL', alias: 'Local:1:I.Data.6' },
      { name: 'Stop', dataType: 'BOOL', alias: 'Local:1:I.Data.7' },
      { name: 'Motor', dataType: 'BOOL', alias: 'Local:2:O.Data.0' },
    ],
    rungs: ['[XIC Start ,XIC Motor ] XIC Stop OTE Motor ;'],
  }),
);
if (!result.ok) console.log(result.errors);   // verify errors with program/routine/rung/operand
plc.setMode('RUN');
plc.io.setInput(1, 7, true);                  // Stop is normally closed
plc.io.setInput(1, 6, true);                  // press Start
plc.advance(10);                              // one 10 ms scan
plc.io.getOutput(2, 0);                       // true: motor running
plc.readNumber('Motor');                      // 1
```

### Ladder neutral text

Each rung has a text form; the text and the graphics (Stage 2) edit the same rung.

```
[XIC Start ,XIC Run ] XIC Stop OTE Run ;          spaced form
[XIC(Start) ,XIC(Run) ]XIC(Stop)OTE(Run);         paren (export) form
```

Both forms parse; `?` marks a missing operand. Whole routines can be pasted: one rung per `;`, with `// comment` lines (attached to the next rung) or `RC: "comment";` / `N: rung;` lines.

### Instruction set

| Tab | Instructions |
|---|---|
| Bit | XIC, XIO, OTE, OTL, OTU, ONS, OSR, OSF |
| Timer/Counter | TON, TOF, RTO, CTU, CTD, RES |
| Compare | EQU, NEQ, LES, LEQ, GRT, GEQ, LIM, CMP |
| Compute/Math | ADD, SUB, MUL, DIV, MOD, NEG, ABS, SQR, CPT |
| Move/Logical | MOV, MVM, CLR, AND, OR, XOR, NOT, COP, FLL |
| File/Shift | BSL, BSR, FFL, FFU, LFL, LFU |
| Program Control | JSR, SBR, RET, JMP, LBL, MCR, AFI, NOP |

Data types: BOOL, SINT, INT, DINT, REAL, TIMER, COUNTER, CONTROL, FBD_TIMER, FBD_COUNTER, MOVING_STD_DEV, arrays up to 3 dimensions, and user-defined types. Operands support members, subscripts (constant, tag or expression), bit access (`Data[0].3`, `MyDint.[Idx]`), aliases (`Local:1:I.Data.8`), controller and program scope, and status flags `S:FS`, `S:N`, `S:Z`, `S:V`, `S:C`, `S:MINOR`. Tag names are case-insensitive.

Numeric rules follow Logix: integer math is 32-bit with wrap-around (overflow sets `S:V`; integer ADD/SUB also set `S:C`), any REAL operand switches the operation to single precision (integer operands are converted to REAL first), REAL→integer conversion rounds half to even, narrowing integer stores keep the low bits, integer division truncates toward zero, and SQR of an integer into an integer truncates. Logical instructions (AND, OR, XOR, NOT, MVM) zero-fill smaller integer operands; all other instructions sign-extend.

#### Behaviour notes

- Timer and counter Preset/Accum, and file/shift Length/Position, are immediate operands written into the tag (`.PRE`/`.ACC`, `.LEN`/`.POS`) at download; at run time the instruction uses the live members.
- Prescan: OTE cleared; TON reset; TOF `.ACC = .PRE`; RTO keeps `.ACC`/`.DN`; ONS/OSR storage set; OSF storage cleared; CTU/CTD `.CU`/`.CD` set; FFL/LFL `.EN` and FFU/LFU `.EU` set; BSL/BSR cleared.
- FFU/LFU on an empty queue return 0 to the destination. `FLL 0 Udt[0] n` clears structure arrays. COP and FLL do not accept BOOL operands (BOOL arrays are bit-packed in Logix).
- JSR/SBR/RET: atomic parameters convert like MOV; structure and array parameters must match exactly (else Type 4 Code 31). A RET with fewer values than the JSR expects faults; extra values are ignored. JMP labels are local to a routine.
- LogixSim deviations: divide by zero is a major fault (Logix logs a minor fault); JSR input count vs SBR parameter count is checked at Verify; COP stops at the end of the source array; COP between different structure types is not supported. A JMP into or out of an MCR zone pairs MCRs by execution order. BOOL arrays are not rounded up to multiples of 32.

#### Limits

Scan period and periodic task period 0.1 ms–2000 s, watchdog 1 ms–2000 s, at most 1,000,000 values per tag, branches nested at most 32 deep, JSR nesting 32 levels. `advance(ms)` requires a finite `ms >= 0`. A 200-rung mixed program scans in about 25 µs (median) on the test machine; `npm run bench:scan` prints the figures.

### I/O modules

The local chassis has the controller in slot 0 and modules from slot 1. Each module creates `Local:<slot>:I` and/or `Local:<slot>:O` tags.

| Catalog | Module | Tags |
|---|---|---|
| LX-IQ16 | 16-pt 24 V DC input | `Local:s:I.Data` (bits 0–15), `.Fault` |
| LX-OB16 | 16-pt 24 V DC output | `Local:s:O.Data` (bits 0–15); `Local:s:I.Data` readback |
| LX-IF4 | 4-ch analog input, 0–10 V / 0–5 V / 1–5 V / 4–20 mA | `Local:s:I.Ch0Data`…`Ch3Data` (REAL, engineering units), `ChNUnderrange`/`ChNOverrange` |
| LX-OF2 | 2-ch analog output | `Local:s:O.Ch0Data`, `Ch1Data` (REAL, engineering units) |

Analog channels scale linearly from the signal range to `lowEng`…`highEng` (configured per channel in the module definition). The scene side uses `controller.io`: `setInput`, `getOutput`, `setAnalogInput` (volts or mA), `setAnalogInputEng`, `getAnalogOutput`. I/O forces (`io.addForce(path, value)`, `io.forcesEnabled`) apply to input and output points, also through alias names.

### Project files

A project (`ProjectDef`, see `src/plc/engine/project.ts`) holds the controller, UDTs, controller tags, I/O modules, tasks, and programs with their tags and routines. Ladder rungs are stored as neutral text. Projects will save to localStorage and export as `.lsim.json` (Stage 12).

## Scene I/O maps

These are the I/O contracts the built-in scenes (Stage 8) and missions use.

**Bytronic Industrial Control Trainer**

| Input `Local:1:I.Data.x` | | Output `Local:2:O.Data.x` | |
|---|---|---|---|
| 0 | Chain Peg Detect (inductive) | 0 | Chain Conveyor |
| 1 | Sort Area Detect (IR) | 1 | Sorting Solenoid |
| 2 | Assembly Hopper Full | 2 | Ring Dispensing Solenoid (45° cam) |
| 3 | Ring Assembled (capacitive, normally ON, OFF for an assembled part) | 3 | Reject Solenoid |
| 4 | Assembly Detect (fibre thru-beam) | 4 | Belt Conveyor |
| 5 | Reject Area Detect | 5 | Gauging Head Solenoid |
| 6 | Start (N/O) | | |
| 7 | Stop (N/C) | | |
| 8 | Belt Peg Detect | | |
| 9 | Sort Solenoid Return | | |
| 10 | Reject Solenoid Return | | |
| 11 | Gauging Head Area Detect | | |

Analog `Local:5:I.Ch0Data`: gauging head, 0–5 V (30.0 mm peg without rings, up to 33.0 mm with 3 rings).

**Traffic light intersection**: NS red/amber/green on outputs 0–2, EW red/amber/green on outputs 5–7.

**Batch tank**: inputs Tank_Full (0), Temp_OK (1), Tank_Empty (2), Start (8); outputs Fill_Valve_1 (0), Fill_Valve_2 (1), Drain_Valve (2), Heater (3), Blend_Motor (4).

**Ink colour run**: outputs PMP_1–PMP_7 (0–6), Blender (7); input START (8); level transmitter LT1 0–2 m on analog channel 0.

**Three-motor panel**: inputs Start_1 (8), Start_2 (9), Shut_Down (12), E_Stop (13); outputs M1–M3 (0–2).

**Flow skid**: turbine meter pulses on input 8; TT on analog channel 0 (−50 to 80 °C); PT on analog channel 1 (0–800 kPa).

## Extending the engine

### Adding a ladder instruction

1. Pick the group file in `src/plc/ladder/instructions/` (or create one and add it to `index.ts`).
2. Add an `InstructionDef`: mnemonic, toolbar category, title, `kind` (`input` for conditions, `output` otherwise), operand list in Logix order, and `compile(c)`.
3. In `compile`, use the `InstrCompiler` helpers (`c.bit`, `c.source`, `c.dest`, `c.struct`, `c.span`, `c.expression`, `c.immediate`…). They report verify errors themselves. Return `{ exec(rungIn) { …; return rungOut }, prescan() { … } }`.
4. Keep `exec` allocation-free and store hidden per-tag state on the tag's structure under a `Symbol` key.
5. Add tests in `src/plc/__tests__/`.

### Adding a scene part

Scene parts arrive in Stage 7; this section will describe the part interface (kinematic update at 5 ms, sensor outputs and actuator inputs exposed to the I/O mapping panel).
