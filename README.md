# Surrogate Pig Head FEM-ML (Web Version)

Browser version of the [Surrogate-Pig-Head-FEM-ML](https://github.com/memar-lab/Surrogate-Pig-Head-FEM-ML) desktop app. It predicts the brain response of the pig-head finite element model (MPS95, MAS95, spatial MPS, spatial MAS) from head-impact kinematics using the trained surrogate models.

Everything runs client-side. No server, no install, and no data leaves the browser.

## Use it

Open the published site (GitHub Pages): `https://memar-lab.github.io/Surrogate-Pig-Head-FEM-ML-Web/` once Pages is enabled (see below).

- **Single run**: Species → Input Parameters → Run / Results. Same inputs as the desktop app (VelocityTrace, AccelerationTrace, PeakValues; Axial / Sagittal / Coronal; DNN, Lasso, Ridge, Random Forest - Linear / Curvature). Results show the dataset scatter, overall bars with injury thresholds (MPS95 ≥ 0.30, MAS95 ≥ 0.13), and rotatable 3D spatial MPS and MAS views. **Download results (.zip)** gives the same CSV files as the desktop app plus PNG previews.
- **Batch**: drop many CSV files, pick type / direction / model, download one ZIP with per-simulation CSVs, `_BatchSummaries/BatchSummary_*.csv` and `batch_log.txt`.
- Input CSV formats and templates are unchanged (`Templates/`, `ExampleBatchFolder/`).

## Run locally

Browsers block loading model files from `file://`, so serve the folder:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Deploy to GitHub Pages

1. Create the repository (GitHub names cannot contain spaces or parentheses, so use `Surrogate-Pig-Head-FEM-ML-Web`) and push this folder to `main`.
2. Repository **Settings → Pages → Source: GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` publishes the site on every push to `main`.

## Verification against the desktop app

`tests/parity.mjs` runs the browser code in Node and compares it with reference numbers produced by the desktop backend itself (`tests/fixtures/reference.json`): features, MPS95 / MAS95 for every direction × model, and spatial outputs, for all three input types.

```bash
node tests/parity.mjs
```

Current result: 1,893 checks, 0 failures, worst relative error 2e-13. During development the complete spatial arrays were also compared (1,933 checks, worst 4e-13).

## How it is built

| Desktop (Python) | Web (this repo) |
|---|---|
| `backend/impact_profile.py` | `js/impactProfile.js` |
| `backend/feature_extraction.py` | `js/features.js` |
| `backend/model_loader.py` | `js/models.js` |
| `backend/prediction_export.py`, `batch_runner.py` | `js/pipeline.js`, `js/app.js` |
| `backend/visualize.py` (matplotlib) | `js/viewer3d.js` (three.js), `js/plots.js` |
| `assets_opt/models_pkl/*.pkl.gz`, `meshes_npz/*.npz` | `data/models/*.bin`, `data/mesh/*.bin` (made by `tools/export_assets.py`) |

Models load on demand (a selection needs at most a few MB). To regenerate `data/` from a desktop build's `assets_opt` folder:

```bash
python tools/export_assets.py <path-to>/assets_opt --out data
```

Third-party code is vendored in `vendor/` (three.js, JSZip; see their licence files).

## Differences from the desktop app

- Downloads are ZIP files instead of writing to a folder; `_PredictionResults.npz` (Python-specific) is replaced by `_InputSettings.json`.
- Spatial plots are interactive WebGL (all 73,425 fibres are drawn; the desktop view draws a subset for speed).
- Added: a caution banner when an input lies outside the training range. Numerical results are unchanged.

## Scientific references and thresholds

See the About page in the app and the [desktop README](https://github.com/memar-lab/Surrogate-Pig-Head-FEM-ML).

## License

Add the same license as the desktop repository before publishing.
