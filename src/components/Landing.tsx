/**
 * The front door.
 *
 * Two people arrive at this app with opposite needs. Somebody who has just
 * seen a funnel from their porch wants one short form and no map. Somebody
 * coordinating a county response wants the whole console. Sending both to the
 * same screen serves neither, so the door asks once and then gets out of the
 * way.
 */

export default function Landing({ onChoose }: { onChoose: (role: 'responder' | 'reporter') => void }) {
  return (
    <div
      className="relative min-h-[100dvh] overflow-x-hidden"
      style={{ background: 'var(--surface-base)', color: 'var(--text-primary)' }}
    >
      {/* A suggestion of a radar sweep, kept far enough back to stay quiet. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(60rem 40rem at 70% -10%, color-mix(in srgb, var(--band-high) 14%, transparent), transparent 70%),' +
            'radial-gradient(50rem 35rem at 10% 110%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%)',
        }}
      />

      <div className="relative mx-auto flex min-h-[100dvh] max-w-5xl flex-col px-4 py-8 sm:px-6">
        <header className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-lg"
            style={{ background: 'var(--band-high)', color: '#fff' }}
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M3 5h18M5 10h14M8 15h8M11 20h3" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-lg font-bold tracking-tight">TornadoSight</span>
        </header>

        <main className="flex flex-1 flex-col justify-center py-10">
          <p
            className="text-[11px] font-semibold tracking-[0.2em] uppercase"
            style={{ color: 'var(--band-high)' }}
          >
            Near real time tornado situational awareness
          </p>

          <h1 className="mt-3 max-w-3xl text-4xl leading-[1.05] font-bold tracking-tight sm:text-6xl">
            Not <span style={{ color: 'var(--band-high)' }}>there is a warning</span>.
            <br />
            <span style={{ color: 'var(--accent)' }}>This hospital has eleven minutes.</span>
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Every National Weather Service tornado warning quietly carries the storm's bearing and
            speed. TornadoSight projects it forward, sweeps the warning along that line, and tells a
            responder which hospitals, schools and shelters are in the way and how long they have.
            Storm photographs sent in by the public are screened on the device and ranked against
            everything else waiting.
          </p>

          {/* The fork. Everything above exists to make this choice obvious. */}
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => onChoose('responder')}
              className="group panel relative overflow-hidden p-5 text-left transition-transform hover:-translate-y-0.5"
              style={{ borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' }}
            >
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-0.5"
                style={{ background: 'var(--accent)' }}
              />
              <span className="flex items-center gap-2 text-lg font-semibold">Emergency Responder</span>
              <span className="mt-2 block text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                The full console. Live warnings on a map, storm tracks and time to impact, shelters
                and critical infrastructure, the report queue, and a replay of real past storms.
              </span>
              <span
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold"
                style={{ color: 'var(--accent)' }}
              >
                Open the console
                <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                  &rarr;
                </span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => onChoose('reporter')}
              className="group panel relative overflow-hidden p-5 text-left transition-transform hover:-translate-y-0.5"
              style={{ borderColor: 'color-mix(in srgb, var(--band-high) 40%, transparent)' }}
            >
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-0.5"
                style={{ background: 'var(--band-high)' }}
              />
              <span className="flex items-center gap-2 text-lg font-semibold">Tornado Reporter</span>
              <span className="mt-2 block text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                Saw something? One short form. Name where you are, add a photograph if you have one,
                and it goes straight into the responder's queue, ranked against everything else.
              </span>
              <span
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold"
                style={{ color: 'var(--band-high)' }}
              >
                Report what you saw
                <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                  &rarr;
                </span>
              </span>
            </button>
          </div>

          <dl className="mt-12 grid gap-x-8 gap-y-5 sm:grid-cols-3">
            {[
              ['Costs nothing to run', 'No server, no API keys. Static files and free public feeds.'],
              ['Photographs stay put', 'The classifier runs in your browser. Nothing is uploaded.'],
              ['Shows its working', 'Every score opens into the measurements that produced it.'],
            ].map(([title, body]) => (
              <div key={title}>
                <dt className="text-sm font-semibold">{title}</dt>
                <dd className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  {body}
                </dd>
              </div>
            ))}
          </dl>
        </main>

        <footer
          className="border-t pt-5 text-xs leading-relaxed"
          style={{ borderColor: 'var(--border-soft)', color: 'var(--text-muted)' }}
        >
          TornadoSight is a decision support tool. It does not confirm tornadoes and does not
          replace National Weather Service products, a meteorologist, or the judgement of the person
          running the response. Data from the National Weather Service, Open-Meteo, RainViewer and
          OpenStreetMap.
        </footer>
      </div>
    </div>
  );
}
