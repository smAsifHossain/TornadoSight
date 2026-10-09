import type { InjectionSettings } from '../lib/injection';
import { INJECTION_PRESETS } from '../lib/injection';
import { Section } from './ui';

/**
 * The controls for injection mode.
 *
 * Every input the decision layer reads is exposed here, so the whole scoring
 * path can be driven to any corner of its range and watched responding. That
 * is the difference between claiming a system is explainable and letting
 * someone prove it in thirty seconds.
 */

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block py-1.5">
      <span className="flex items-baseline justify-between gap-2 text-[11px]">
        <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
        <span className="tabular-nums font-semibold" style={{ color: 'var(--text-primary)' }}>
          {value}
          {unit ? <span style={{ color: 'var(--text-muted)' }}> {unit}</span> : null}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[var(--band-review)]"
      />
    </label>
  );
}

export default function InjectionPanel({
  settings,
  onChange,
}: {
  settings: InjectionSettings;
  onChange: (s: InjectionSettings) => void;
}) {
  const set = <K extends keyof InjectionSettings>(key: K, value: InjectionSettings[K]) =>
    onChange({ ...settings, [key]: value });
  const setWeather = (key: keyof InjectionSettings['weather'], value: number) =>
    onChange({ ...settings, weather: { ...settings.weather, [key]: value } });

  return (
    <div>
      <Section title="Scenario">
        <p className="mb-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Named situations a responder would recognise. Pick one, then adjust anything below and
          watch the decision move.
        </p>
        <div className="space-y-1.5">
          {INJECTION_PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => onChange(p.settings)}
              className="block w-full rounded-lg px-3 py-2 text-left"
              style={{ background: 'var(--surface-raised)' }}
            >
              <span className="block text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                {p.name}
              </span>
              <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {p.summary}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Official warning">
        <label className="block text-[11px]">
          <span style={{ color: 'var(--text-secondary)' }}>Product in effect</span>
          <select
            value={settings.event}
            onChange={(e) => set('event', e.target.value as InjectionSettings['event'])}
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-xs"
            style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)', color: 'var(--text-primary)' }}
          >
            <option value="Tornado Warning">Tornado Warning</option>
            <option value="Tornado Watch">Tornado Watch</option>
            <option value="Severe Thunderstorm Warning">Severe Thunderstorm Warning</option>
            <option value="None">No warning</option>
          </select>
        </label>

        <label className="mt-2 block text-[11px]">
          <span style={{ color: 'var(--text-secondary)' }}>Detection</span>
          <select
            value={settings.detection ?? ''}
            onChange={(e) => set('detection', (e.target.value || null) as InjectionSettings['detection'])}
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-xs"
            style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)', color: 'var(--text-primary)' }}
          >
            <option value="RADAR INDICATED">Radar indicated</option>
            <option value="OBSERVED">Observed on the ground</option>
            <option value="">Not stated</option>
          </select>
        </label>

        <label className="mt-2 block text-[11px]">
          <span style={{ color: 'var(--text-secondary)' }}>Damage threat</span>
          <select
            value={settings.damageThreat}
            onChange={(e) => set('damageThreat', e.target.value as InjectionSettings['damageThreat'])}
            className="mt-1 w-full rounded-lg border px-2 py-1.5 text-xs"
            style={{ background: 'var(--surface-input)', borderColor: 'var(--border-soft)', color: 'var(--text-primary)' }}
          >
            <option value="">None stated</option>
            <option value="CONSIDERABLE">Considerable</option>
            <option value="CATASTROPHIC">Catastrophic</option>
          </select>
        </label>

        <Slider label="Minutes remaining" value={settings.minutesRemaining} min={5} max={90} unit="min" onChange={(v) => set('minutesRemaining', v)} />
      </Section>

      <Section title="Storm motion">
        <Slider label="Heading" value={settings.heading} min={0} max={359} unit="deg" onChange={(v) => set('heading', v)} />
        <Slider label="Speed" value={settings.speedMph} min={0} max={80} unit="mph" onChange={(v) => set('speedMph', v)} />
        <Slider label="Peak gust" value={settings.maxWindGustMph} min={0} max={120} unit="mph" onChange={(v) => set('maxWindGustMph', v)} />
        <Slider label="Hail" value={settings.maxHailInches} min={0} max={4} step={0.25} unit="in" onChange={(v) => set('maxHailInches', v)} />
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Speed and heading drive the projected corridor and every time to impact on the map.
        </p>
      </Section>

      <Section title="Atmosphere">
        <Slider label="CAPE" value={settings.weather.cape} min={0} max={5000} step={50} unit="J/kg" onChange={(v) => setWeather('cape', v)} />
        <Slider label="Lifted index" value={settings.weather.liftedIndex} min={-12} max={8} unit="C" onChange={(v) => setWeather('liftedIndex', v)} />
        <Slider label="Wind gust" value={settings.weather.windGustMph} min={0} max={110} unit="mph" onChange={(v) => setWeather('windGustMph', v)} />
        <Slider label="Sustained wind" value={settings.weather.windSpeedMph} min={0} max={70} unit="mph" onChange={(v) => setWeather('windSpeedMph', v)} />
        <Slider label="Dew point" value={settings.weather.dewPointF} min={20} max={85} unit="F" onChange={(v) => setWeather('dewPointF', v)} />
        <Slider label="Precipitation" value={settings.weather.precipitationMmH} min={0} max={30} unit="mm/h" onChange={(v) => setWeather('precipitationMmH', v)} />
        <Slider label="Pressure" value={settings.weather.pressureMslHpa} min={960} max={1040} unit="hPa" onChange={(v) => setWeather('pressureMslHpa', v)} />
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Drag pressure upward and severity should fall, not rise. Low pressure is the severe end.
        </p>
      </Section>

      <Section title="What this is">
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Nothing here is an observation. The injected product is labelled as test data everywhere
          it appears, including on any report filed from it, so it can never be mistaken for a
          National Weather Service product. Infrastructure and shelters around the pin stay real,
          because the point is to see how the scoring responds to genuine surroundings.
        </p>
      </Section>
    </div>
  );
}
