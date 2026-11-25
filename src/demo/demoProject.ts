import { ladderProject, type ProjectDef } from '../plc';

/**
 * Stage 1 demo: a motor start/stop seal-in plus a flasher, wired to local I/O.
 * Inputs Local:1:I.Data.6 (Start, N/O) and .7 (Stop, N/C); outputs Local:2:O.Data.0 (Motor) and .1 (Lamp).
 */
export function demoProject(): ProjectDef {
  return ladderProject({
    modules: [
      { slot: 1, catalog: 'LX-IQ16', description: 'Panel inputs' },
      { slot: 2, catalog: 'LX-OB16', description: 'Panel outputs' },
    ],
    tags: [
      { name: 'Start', dataType: 'BOOL', alias: 'Local:1:I.Data.6', description: 'Start pushbutton (N/O)' },
      { name: 'Stop', dataType: 'BOOL', alias: 'Local:1:I.Data.7', description: 'Stop pushbutton (N/C)' },
      { name: 'Motor', dataType: 'BOOL', alias: 'Local:2:O.Data.0', description: 'Motor contactor' },
      { name: 'Lamp', dataType: 'BOOL', alias: 'Local:2:O.Data.1', description: 'Run lamp (flashing)' },
      { name: 'FlashOn', dataType: 'TIMER' },
      { name: 'FlashOff', dataType: 'TIMER' },
      { name: 'Starts', dataType: 'COUNTER', description: 'Number of motor starts' },
    ],
    rungs: [
      { comment: 'Motor seal-in: Start latches, Stop (N/C) breaks the circuit', text: '[XIC Start ,XIC Motor ] XIC Stop OTE Motor ;' },
      { comment: 'Count starts', text: 'XIC Motor CTU Starts 1000 0 ;' },
      { comment: 'Flasher: 500 ms on / 500 ms off while running', text: 'XIC Motor XIO FlashOff.DN TON FlashOn 500 0 ;' },
      { text: 'XIC FlashOn.DN TON FlashOff 500 0 ;' },
      { text: 'XIC Motor XIO FlashOn.DN OTE Lamp ;' },
    ],
  });
}
