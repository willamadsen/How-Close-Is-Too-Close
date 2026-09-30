# How Close Is Too Close?

Satellite shadowing and rendezvous and proximity operations (RPOs): a
reconstruction of the Kosmos 2542 / Kosmos 2543 approaches to USA 245,
built from historical two-line element sets (TLEs).

Research at the Engineering Space Policy Laboratory (ESPL).

## Interactive visualization

- **Orbital storyline:** https://willamadsen.github.io/How-Close-Is-Too-Close/Viz/
- **Case-study view:** https://willamadsen.github.io/How-Close-Is-Too-Close/Viz/case-study.html

To run it locally instead, serve this folder and open `http://localhost:8000/Viz/`:

```bash
python -m http.server 8000
```

See [Viz/README.md](Viz/README.md) for how the visualization is built and how
to interpret it.

## Repository layout

| Folder | Contents |
| --- | --- |
| `Code/` | Python scripts that parse TLEs and convert them to orbital elements and latitude/longitude/altitude |
| `Viz/` | Interactive Three.js visualization, its data, and the static case-study figure |

Raw TLE histories from Space-Track are not included in this repository.
