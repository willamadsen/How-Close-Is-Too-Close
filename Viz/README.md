# Orbital storyline visualization

This interactive visualization presents four reconstructed snapshots: an
initial close configuration, a later separated configuration, and a subsequent
close configuration involving Kosmos 2543, followed by a lower-confidence
snapshot in which both Russian spacecraft are modeled nearby.

## Build the local data file

The builder does not contact Space-Track or SeeSat. Russian records are selected
by nearest epoch at each curated milestone. The first moment uses the December
8 pre-manoeuvre USA 245 solution; later moments use its December 31 recovery
solution, including backward propagation for the unobserved December interval.
Each animation freezes its source triplet to prevent element-switch artifacts.

```bash
/Users/troberts84/miniconda3/envs/grading310/bin/python \
  Code/build_eci_visualization_data.py
```

## View the mockup

From the project root, serve the files locally:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/visualizations/eci/>.

Three.js, OrbitControls, TopoJSON, globe boundaries, and all orbital history
are stored locally, so the visualization does not require a CDN at runtime.

## Build the six-panel case-study figure

The static figure uses Story Moments 1, 2, and 4 as rows. Its left column shows
separation from USA 245; its right column shows Earth-centered still frames of
the reconstructed ECI geometry, with fading recent orbital histories.

```bash
MPLBACKEND=Agg python3 Code/create_shadowing_case_study_figure.py
```

This writes editable SVG and PDF files plus a high-resolution PNG to
`visualizations/eci/figures/`.

## Explore the paired interactive case-study views

The title-free paired layout combines UTC separation charts with three
independently controllable Earth-centered scenes. Each scene supports orbit,
pan, zoom, reset, and a configurable recent-history trail:

<http://localhost:8000/visualizations/eci/case-study.html>

## Interpretation cautions

- Previous/next buttons move through four curated story moments. Play/pause
  loops through a three-hour interval around the selected milestone.
- Every moment opens in Full Earth view. The camera looks along the average of
  the three reconstructed orbital-plane normals so the orbits read as a
  racetrack around the full globe.
- The user-facing modes are “Full Earth” and “Relative motion.” The latter puts
  USA 245 at the origin using radial, along-track, and cross-track coordinates.
- The scenario-relevant Russian spacecraft has a continuously displayed
  separation rounded to 5 km. Values at or below 200 km are black and
  prominent; larger values are subdued gray.
- In the relative-motion view, each Russian spacecraft has a four-hour fading
  history. It is pre-populated before playback begins; future trajectory is not
  displayed.
- `data/scenario_validation.json` records every selected epoch, signed epoch
  offset, and minimum separation for audit.
- In the relative view, Earth is placed on the negative radial axis at USA
  245's instantaneous geocentric distance and drawn at the same 1,000 km scale.
- This is a fixed-element reconstruction of the recurrence concept, not a
  reproduction of Thompson's unpublished calculation or independent evidence
  that each modeled closest approach occurred at the displayed range.
- Kosmos 2542 and 2543 use the locally preserved Space-Track GP history.
