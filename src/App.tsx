import { useEffect, useMemo, useReducer } from 'react';
import { Controller } from './plc';
import { demoProject } from './demo/demoProject';

/**
 * Stage 1 shell: runs the headless PLC engine in the browser so the scan loop,
 * I/O image and modes can be exercised before the 3D game exists.
 */
export function App() {
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const plc = useMemo(() => {
    const c = new Controller();
    const res = c.download(demoProject());
    if (!res.ok) console.error(res.errors);
    c.io.setInput(1, 7, true); // Stop is normally closed
    return c;
  }, []);

  useEffect(() => {
    let last = performance.now();
    let raf = 0;
    const tick = () => {
      const t = performance.now();
      plc.advance(Math.min(100, t - last));
      last = t;
      redraw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [plc]);

  const press = (pt: number, on: boolean) => plc.io.setInput(1, pt, on);
  const fault = plc.majorFault;
  const tags = ['Start', 'Stop', 'Motor', 'Lamp', 'FlashOn.ACC', 'Starts.ACC'];

  return (
    <main className="shell">
      <header>
        <h1>LogixSim</h1>
        <span className={`badge badge-${plc.mode.toLowerCase()}`}>{plc.mode === 'PROGRAM' ? 'PROG' : plc.mode === 'FAULTED' ? 'FAULT' : 'RUN'}</span>
      </header>
      <p className="lede">Stage 1: headless controller engine. The 3D plant and the Logix-style editor come in later stages.</p>
      <section className="row">
        <button onClick={() => plc.setMode('RUN')}>Run</button>
        <button onClick={() => plc.setMode('PROGRAM')}>Program</button>
        <button onClick={() => plc.clearFault()} disabled={!fault}>Clear fault</button>
      </section>
      <section className="row">
        <button onPointerDown={() => press(6, true)} onPointerUp={() => press(6, false)} onPointerLeave={() => press(6, false)}>
          Start (N/O)
        </button>
        <button onPointerDown={() => press(7, false)} onPointerUp={() => press(7, true)} onPointerLeave={() => press(7, true)}>
          Stop (N/C)
        </button>
        <span className={`lamp ${plc.io.getOutput(2, 0) ? 'on' : ''}`}>Motor</span>
        <span className={`lamp ${plc.io.getOutput(2, 1) ? 'on' : ''}`}>Lamp</span>
      </section>
      <table>
        <tbody>
          {tags.map((t) => (
            <tr key={t}>
              <td>{t}</td>
              <td>{String(plc.readNumber(t))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer>
        Scan {plc.stats.lastScanUs.toFixed(1)} µs (max {plc.stats.maxScanUs.toFixed(1)} µs) · {plc.stats.scans} scans
        {fault && <div className="fault">Major fault Type {fault.type} Code {fault.code}: {fault.message}</div>}
      </footer>
    </main>
  );
}
