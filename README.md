# TornadoSight

Near real time tornado situational awareness and storm report triage for
emergency responders.

A responder picks a place and sees one picture: which National Weather Service
warnings cover it, how severe the surrounding environment is, which critical
facilities sit in the storm's projected path and **how many minutes they have**,
and where any submitted storm photographs rank against each other.

Built for the IEEE Response Quest Challenge, Phase 3.

---

## The idea the rest of it hangs on

Every National Weather Service tornado and severe thunderstorm warning carries a
field almost nobody reads:

```
eventMotionDescription:
  2026-09-26T04:11:00-00:00...storm...250DEG...19KT...34.65,-102.78
```

That is a timestamp, a bearing, a speed in knots, and the radar centroid of the
storm. Project it forward and sweep the warning polygon along that vector, and a
warning stops being a shape on a map and becomes a schedule:

> **53 critical facilities are in the projected path, including Plains Regional
> Medical Center in about 30 minutes.**

That sentence is the product. Everything else exists to make it trustworthy.

One detail worth stating plainly, because getting it wrong inverts every
projection: **the bearing is the direction the storm is coming _from_**, in the
same convention as wind direction. It was verified against the narrative text of
real alerts before any code depended on it.

| `eventMotionDescription` | Narrative in the same alert |
| --- | --- |
| `259DEG...19KT` | moving east at 25 mph |
| `241DEG...21KT` | moving northeast at 25 mph |
| `264DEG...25KT` | moving east at 30 mph |

So `heading = (bearing + 180) mod 360`, and `mph = knots × 1.15078`.

---

## How a report is scored

Four signals combine into one responder priority, and every number on screen can
be traced back to the measurement that produced it. A responder who cannot see
the reasoning has no grounds to trust or overrule it.

```
Priority = 0.35 × image evidence
         + 0.25 × official warning status
         + 0.20 × weather severity
         + 0.20 × critical facility exposure
```

When a signal is missing, most often because a report arrived with no
photograph, its weight is **redistributed** across the rest rather than counted
as zero. Treating a missing photo as evidence of safety is exactly backwards for
triage.

### Four corrections to the Phase 2 concept

The accepted concept carried four defects in its arithmetic. Each is fixed here
and each is pinned by a regression test in `src/lib/scoring.test.ts`.

| Problem | Why it mattered | Fix |
| --- | --- | --- |
| Raw variables were summed and weighted directly | Adding a gust in mph to a pressure in hectopascals is not a meaningful quantity | Every input is normalised to 0..1 against an operational threshold before any weight is applied |
| Pressure carried a positive weight | Severe convection goes with **low** pressure, so a fair weather high scored as more dangerous than a deep surface low | The pressure ramp runs backwards, from 1018 hPa down to 985 |
| Exposure was `min(points / 10, 1)` | Ten weighted points is reached almost instantly in any built up area, after which every report scored an identical 1.0 and the term stopped discriminating | A saturating curve, `1 − e^(−points/8)`, which keeps rising as facilities accumulate |
| Distance used four step bands | A facility at 0.99 miles counted ten times one at 1.01 miles | A smooth Gaussian decay, tuned to sit close to the original intent at the old breakpoints |

### Weather severity

The concept used surface variables alone. This adds the two fields that actually
discriminate a severe environment, both free from Open-Meteo:

| Term | Weight | Ramp |
| --- | --- | --- |
| Instability (CAPE) | 0.25 | 300 → 3500 J/kg |
| Lifted index | 0.15 | +2 → −8 |
| Wind gust | 0.25 | 20 → 75 mph |
| Sustained wind | 0.10 | 8 → 45 mph |
| Dew point | 0.10 | 50 → 74 °F |
| Precipitation rate | 0.10 | 0 → 18 mm/h |
| Pressure, inverted | 0.05 | 1018 → 985 hPa |

Weights are renormalised across whichever inputs a station actually reports, so
a missing CAPE reading does not silently cost 25 percent of the score.

### Safety overrides

Arithmetic alone can bury a confirmed tornado heading at a hospital underneath
low scores from the other terms. For this scenario that failure mode is
unacceptable, so an observed tornado warning with critical facilities in the
projected path is raised to High regardless of what the weighted sum says, and
the interface states that the override happened and why.

---

## The image screener

A frozen ConvNeXt-Tiny backbone turns a photograph into a 1000 dimensional
vector and a logistic head decides. The head is about 20 KB, so the browser
downloads the backbone once and the decision layer costs nothing. Features are
extracted with the exact int8 backbone the browser runs, so there is no train
and serve mismatch, which matters because the whole abstention design depends on
the probabilities being honest.

### Measured on held out data

| | |
| --- | --- |
| Accuracy | 0.901 |
| Precision | 0.896 |
| Recall | 0.920 |
| F1 | 0.908 |
| Specificity | 0.881 |
| ROC AUC | 0.958 |
| Brier score | 0.094 |
| Training accuracy | 0.903, so essentially no overfitting |

**It abstains.** Anything between 0.35 and 0.65 is reported as "Uncertain, needs
review" rather than forced into a call. That sends **19 percent** of held out
images to a person, and accuracy on the remainder is **0.957**. An abstention is
more useful to a triage operator than a confident coin flip.

Regularisation was chosen on a validation fold and the test fold was touched
once, at the end. Picking it by looking at the test set would leak it and
inflate every number above.

### Why these numbers are lower than the Phase 2 deck

The concept reported 0.928 on a dataset whose negatives were ordinary
photographs. Separating a tornado from an arbitrary picture is an easy problem
and not the one a responder has. The negatives here are **hard negatives**: shelf
clouds, wall clouds, mammatus, arcus, squall lines, rain shafts and dust. 0.901
against those is worth more than 0.928 against easy ones, and it is the number
that predicts how the screener behaves on a real submitted photograph.

### What it gets wrong

- It is **under confident at the top of its range**: in the 0.8 to 1.0 bin it
  says 0.88 and is right 0.97 of the time. For triage that is the safer
  direction to err, but it is not calibrated perfectly.
- **Residual label noise remains.** Selection is filtered by category and by
  title, and some path maps and radar grabs survive in the positives while a few
  non meteorological images survive in the negatives. The filters are in
  `scripts/build-dataset.mjs` and the surviving set is listed in the manifest, so
  the noise is inspectable rather than hidden.
- It sees **one photograph with no context**. It cannot tell a tornado from a
  well lit scud cloud in a bad frame, and it has never seen the specific failure
  case of a phone camera pointed at a dark sky at dusk.
- Training images are Wikimedia Commons, which skews toward **photogenic, well
  composed** storm photography. Real submissions will be worse.

---

## Data sources

Every runtime dependency is free, needs no API key, and sends permissive CORS
headers. That is what lets the whole thing be a static site.

| Source | Used for |
| --- | --- |
| [api.weather.gov](https://api.weather.gov) | Active and archived alerts, polygons, storm motion, tornado and wind and hail threat fields |
| [Open-Meteo](https://open-meteo.com) | CAPE, lifted index, convective inhibition, wind, gust, dew point, precipitation, mean sea level pressure |
| [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu) | NEXRAD base reflectivity tiles |
| [OpenStreetMap](https://www.openstreetmap.org) via Overpass | Critical infrastructure, baked at build time |
| Esri Canvas | Basemap, dark and light |

`notes/data-sources.md` records what was probed, what was rejected and why,
including the fields that do not behave as documented.

### Infrastructure is baked, not fetched

Overpass is a fine source and a poor runtime dependency: it returned a 406 and a
504 within minutes of each other during design. A live demonstration cannot
pause while a community tile server recovers. So `scripts/bake-facilities.mjs`
calls it once, with retries and endpoint rotation, and commits the result as
static shards on a one degree grid. The app fetches only the cells its viewport
touches, from its own origin. That is faster, free, rate limit proof and works
with no network at all.

For a region with no baked coverage the app falls back to a live Overpass query,
and **says so in the interface**. Reporting no infrastructure when we simply have
no data would be the most dangerous failure this tool could have.

---

## Cost

The challenge brief asks for "the most current data at the minimum cost". The
answer here is concrete:

**Zero. Permanently.** No server, no database, no API keys, no paid tiers.

- The app is static files on GitHub Pages.
- Every data source above is free and key-less.
- The image classifier runs in the responder's browser, so inference costs
  nothing at any volume.

---

## Responsible data handling

- **Photographs never leave the device.** There is no upload endpoint because
  there is no server. The classifier runs locally through ONNX Runtime Web, so a
  citizen's picture of their own street stays on the machine it was dropped onto.
- **Exports exclude imagery** deliberately, so a shareable record carries no
  pictures of people or property.
- **Every training image is openly licensed**, and its licence and author are
  recorded in `data/dataset/manifest.json`. The Phase 2 concept listed CNN,
  AccuWeather, Fox News and a storm chasing video site among its sources; none of
  those are used here, because they are not free to redistribute.
- **The tool never claims to confirm a tornado.** The image result is a triage
  signal, stated as such everywhere it appears, and it does not replace National
  Weather Service products or a meteorologist's judgment.

---

## Storage

Storage is one of the four required elements of the challenge, and the concept
had no answer for it. Reports, their scores and an append only audit trail are
held in IndexedDB on the responder's device. The audit trail is what makes the
tool defensible after an event, when someone asks why a particular report was or
was not acted on. Everything exports to JSON for handover.

---

## Live mode and replay

**Live mode** polls the National Weather Service every 60 seconds.

**Replay mode** plays back a real archived event, minute by minute: a supercell
that tracked north east from Curry County, New Mexico into Parmer County, Texas,
drawing twelve consecutive tornado warnings. Every polygon, motion vector and
detection flag in that fixture is exactly what the National Weather Service
issued at the time. Nothing is simulated, generated or edited.

Replay exists because severe weather does not schedule itself around
demonstrations, and because inventing an event would be both dishonest and
against the challenge rules. The interface restyles itself loudly in replay so
archived data can never be mistaken for a live situation, and the clock driving
every relative time on screen is the replay clock, not the wall clock.

---

## Running it

```bash
npm install
npm run dev
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm test` | Test suite |
| `npm run data:facilities -- --bbox=W,S,E,N --name=region` | Bake infrastructure shards |
| `npm run model:build` | Extract features and fit the screening head |
| `node scripts/capture-replay.mjs --start ... --end ... --bbox=...` | Capture a replay fixture from the alert archive |

---

## Limitations

Stated plainly, because a responder needs to know where this tool stops being
reliable.

- **The projected path assumes the storm holds its track and speed.** Storms
  turn, slow, occlude and dissipate. The corridor is the current best estimate
  from the last radar fix, not a forecast, and the interface says so.
- **The image screener is a triage signal, not a detector.** It sees one
  photograph with no context, and it cannot tell a tornado from a well lit
  scud cloud in a bad frame. It abstains rather than guess when it is unsure.
- **Infrastructure data is OpenStreetMap**, which is uneven. A missing hospital
  is a missing hospital. Verified local emergency management layers would be
  better and the loader is written to accept them.
- **Weather is a point sample** at the report location from a forecast model, not
  a mesonet observation.
- **Alert archive depth is about a month**, which is why replay fixtures are
  captured and committed rather than fetched on demand.
- **Coverage is the United States**, because the National Weather Service alert
  feed is.
