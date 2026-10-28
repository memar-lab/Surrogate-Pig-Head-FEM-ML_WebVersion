# Surrogate Pig Head FEM-ML (Web Version)

**Use it online: https://memar-lab.github.io/Surrogate-Pig-Head-FEM-ML_WebVersion/**

A browser-based tool for predicting finite element model (FEM) brain response from head-impact kinematics, using trained machine-learning surrogate models of the pig head. Nothing to install. Everything runs in your browser and your files are never uploaded.

The desktop (Windows) version is available at [Surrogate-Pig-Head-FEM-ML](https://github.com/memar-lab/Surrogate-Pig-Head-FEM-ML).

## What it predicts

| Output | Description | Injury threshold |
|---|---|---|
| `MPS95` | 95th percentile maximum principal strain | 0.30 |
| `MAS95` | 95th percentile maximum axonal strain | 0.13 |
| Spatial MPS | Strain for each of the 13,196 brain elements | |
| Spatial MAS | Strain for each of the 73,425 axonal fibre beams | |

An output is flagged when `value >= threshold`. The result is reported as an injury-level response if either MPS95 or MAS95 is flagged.

## How to use it

### Single simulation

1. Open the website and choose **Pig**, then **Continue to Input Parameters**.
2. Enter a **Simulation ID**.
3. Choose one input type:
   - **Angular Velocity Trace**: upload a CSV with `time_(s)` and `Angular_velocity_(rad/s)`.
   - **Angular Acceleration Trace**: upload a CSV with `time_(s)` and `Angular_Acceleration_(rad/s2)`.
   - **Peak Values**: type the peak angular acceleration (rad/s²) and peak angular velocity (rad/s), or upload a one-row CSV with `Peak_Acceleration_(rad/s2)` and `Peak_Velocity_(rad/s)`.
4. Choose the **Impact Direction** (Axial, Sagittal or Coronal) and the **Pre-trained Model** (DNN, Lasso, Ridge, Random Forest - Linear, Random Forest - Curvature).
5. Set **Visual** to ON to see the 3D spatial views, or OFF to skip them.
6. Click **Generate Trace** to preview the angular velocity trace.
7. Click **Run Prediction**.

The Run / Results page shows where your input sits within the training dataset, the overall MPS95 and MAS95 against their thresholds, and rotatable 3D maps of spatial MPS and MAS (drag to rotate, scroll to zoom, **Reset View** to restore). Click **Download results (.zip)** to save the output files.

### Batch mode

1. Open the **Batch** tab.
2. Choose the input type, impact direction and model. All files in one batch must share these settings.
3. Drop your CSV files onto the page, or select them. To try it first, click **use the 3 example files**.
4. Optionally untick **Include spatial MPS / MAS CSVs** for a faster, summary-only run.
5. Click **Run batch**, then **Download batch results (.zip)**.

Rules: each file name (without `.csv`) becomes the Simulation ID, and files with `template` in the name are skipped. If one file fails, the batch continues and the reason is listed in the summary.

## Input files

Blank templates and example files are in this repository:

```text
Templates/
├── AngularVelocityTrace_Template.csv
├── AngularAccelerationTrace_Template.csv
└── PeakValues_Template.csv
ExampleBatchFolder/
```

Keep the column names exactly as in the templates.

For peak-value input, an idealized sinusoidal acceleration pulse is generated with duration `T = pi * peakVelocity / peakAcceleration` at a 10 µs time step, followed by 20 ms of rest.

## Output files

Each simulation is saved as:

```text
<SimulationID>_OverallPredictions.csv   MPS95, MAS95, thresholds and injury flags
<SimulationID>_SpatialMPS.csv           MPS for every brain element, with element centroids
<SimulationID>_SpatialMAS.csv           MAS for every fibre, with fibre centroids
<SimulationID>_VelocityTrace.csv        the angular velocity trace used
<SimulationID>_InputSettings.json       input settings and the 15 extracted features
<SimulationID>_SpatialMPSPreview.png    3D views (when Visual is ON)
<SimulationID>_SpatialMASPreview.png
<SimulationID>_RunResultsPage.png       summary page
```

Batch mode also writes `_BatchSummaries/BatchSummary_<date>_<time>.csv` (one row per input file, with status and any error message) and `batch_log.txt`.

## Tips

- Predictions are only reliable inside the range of the training data. The app shows a caution banner when your peak velocity or acceleration is outside it.
- Peak acceleration must be entered in rad/s², not krad/s².

## Scientific references

1. Hajiaghamemar, M., Wu, T., Panzer, M.B. and Margulies, S.S., 2020. *Embedded axonal fiber tracts improve finite element model predictions of traumatic brain injury*. **Biomechanics and Modeling in Mechanobiology**, 19(3), pp. 1109–1130.
2. Wu, T., Hajiaghamemar, M., Giudice, J.S., Alshareef, A., Margulies, S.S. and Panzer, M.B., 2021. *Evaluation of tissue-level brain injury metrics using species-specific simulations*. **Journal of Neurotrauma**, 38(13), pp. 1879–1888.
3. Hajiaghamemar, M. and Margulies, S.S., 2021. *Multi-scale white matter tract embedded brain finite element model predicts the location of traumatic diffuse axonal injury*. **Journal of Neurotrauma**, 38(1), pp. 144–157.

## License

See the desktop repository for license terms.
