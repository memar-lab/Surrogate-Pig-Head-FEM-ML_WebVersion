"""Convert the desktop app's model + mesh assets into browser-friendly binaries.

Input : the `assets_opt/` folder of the desktop build (models_pkl/*.pkl.gz, meshes_npz/*.npz)
Output: data/models/*.bin, data/mesh/*.bin, data/dataset.json, data/manifest.json

Usage:  python tools/export_assets.py <path-to-assets_opt> [--out data]

Binary container ("FEMB"): 4 magic bytes, uint32 header length (little endian),
UTF-8 JSON header padded to a multiple of 8 bytes, then raw little-endian arrays.
The header maps array name -> {dtype, shape, offset(bytes from file start)}; every
array starts on an 8-byte boundary so the browser can wrap it in a typed array
without copying. Scalars and strings go in header["meta"].

The pickles are loaded with a restricted unpickler that only accepts the numpy
array reconstruction helpers, so no arbitrary code can run.
"""
import argparse
import glob
import gzip
import io
import json
import os
import pickle
import struct

import numpy as np

MAGIC = b"FEMB"
DEFAULT_ROTATE_DEG = (115.0, -180.0, -35.0)  # X, Y, Z, same as the desktop 3D view


class _SafeUnpickler(pickle.Unpickler):
    _ALLOWED = {"_frombuffer", "dtype", "ndarray", "_reconstruct", "scalar"}

    def find_class(self, module, name):
        if module.startswith("numpy") and name in self._ALLOWED:
            return getattr(__import__(module, fromlist=[name]), name)
        raise pickle.UnpicklingError(f"blocked global {module}.{name}")


def load_pickle(path):
    with gzip.open(path, "rb") as fh:
        return _SafeUnpickler(io.BytesIO(fh.read())).load()


def write_femb(path, arrays, meta):
    header = {"meta": meta, "arrays": {}}
    # Two passes: offsets depend on the header size, so reserve a generous fixed size.
    order = []
    for name, arr in arrays.items():
        arr = np.ascontiguousarray(arr)
        if arr.dtype.byteorder == ">":
            arr = arr.astype(arr.dtype.newbyteorder("<"))
        order.append((name, arr))
    hdr_size = 1 << 12
    while True:
        offset = 8 + hdr_size
        header["arrays"] = {}
        for name, arr in order:
            offset = (offset + 7) & ~7
            header["arrays"][name] = {"dtype": arr.dtype.str, "shape": list(arr.shape), "offset": offset}
            offset += arr.nbytes
        blob = json.dumps(header, separators=(",", ":")).encode("utf-8")
        if len(blob) <= hdr_size:
            break
        hdr_size *= 2
    blob = blob.ljust(hdr_size, b" ")
    with open(path, "wb") as fh:
        fh.write(MAGIC + struct.pack("<I", hdr_size))
        fh.write(blob)
        pos = 8 + hdr_size
        for name, arr in order:
            off = header["arrays"][name]["offset"]
            fh.write(b"\x00" * (off - pos))
            fh.write(arr.tobytes())
            pos = off + arr.nbytes


def export_model(src, dst):
    d = load_pickle(src)
    fam = d["family"]
    f8 = lambda x: np.asarray(x, dtype="<f8")
    arrays = {
        "mu_input": f8(d["mu_input"]).reshape(-1),
        "std_input": f8(d["std_input"]).reshape(-1),
        "mu_pca": f8(d["mu_pca"]).reshape(-1),
    }
    coeff = np.asarray(d["coeff"], dtype="<f8")
    meta = {
        "family": fam,
        "output": d["output"],
        "direction": d["direction"],
        "nComp": int(d["nComp"]),
        "mu_output": float(d["mu_output"]),
        "std_output": float(d["std_output"]),
        "coeffScalar": bool(coeff.ndim == 0 or coeff.size == 1),
    }
    if meta["coeffScalar"]:
        meta["coeffValue"] = float(coeff.reshape(-1)[0])
    else:
        arrays["coeff"] = coeff  # (N, nComp), row-major
    if fam == "Linear":
        arrays["lin_Beta"] = f8(d["lin_Beta"]).reshape(int(d["nComp"]), -1)
        arrays["lin_Bias"] = f8(d["lin_Bias"]).reshape(-1)
    elif fam == "DNN":
        for k in ("IW", "LW21", "LW32"):
            arrays[k] = f8(d[k])
        for k in ("b1", "b2", "b3"):
            arrays[k] = f8(d[k]).reshape(-1)
        meta["tf"] = [str(d["tf1"]).strip().lower(), str(d["tf2"]).strip().lower(), str(d["tf3"]).strip().lower()]
        W = np.asarray(d["W"], dtype=np.float64)
        if W.size == 1:
            meta["WScalar"] = True
            meta["WValue"] = float(W.reshape(-1)[0])
        else:
            # predict_scores solves  W.T @ s = y  ->  s = inv(W.T) @ y
            meta["WScalar"] = False
            arrays["Winv"] = np.linalg.inv(W.T)
    elif fam == "RF":
        meta["nTrees"] = []
        for j, comp in enumerate(d["rf_comp"]):
            arrays[f"c{j}_children"] = np.asarray(comp["children"], dtype="<i4")
            arrays[f"c{j}_cutvar"] = np.asarray(comp["cutvar"], dtype="<i2")
            arrays[f"c{j}_cutpoint"] = f8(comp["cutpoint"])
            arrays[f"c{j}_nodeval"] = f8(comp["nodeval"])
            arrays[f"c{j}_tree_start"] = np.asarray(comp["tree_start"], dtype="<i4")
            meta["nTrees"].append(int(len(comp["tree_start"])))
    else:
        raise ValueError(f"unknown family {fam} in {src}")
    write_femb(dst, arrays, meta)
    return meta


def rotation_matrix(rx, ry, rz):
    rx, ry, rz = np.radians([rx, ry, rz])
    cx, sx, cy, sy, cz, sz = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry), np.cos(rz), np.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def rotate(P, center):
    """Same maths as backend/visualize.py::_rotate_xyz."""
    P = np.asarray(P, dtype=np.float64)
    R = rotation_matrix(*DEFAULT_ROTATE_DEG)
    return (P - center) @ R.T + center


def export_meshes(src_dir, out_dir):
    brain = np.load(os.path.join(src_dir, "BrainMeshCache.npz"))
    fiber = np.load(os.path.join(src_dir, "FiberMeshCache.npz"))
    V = np.asarray(brain["V"], dtype=np.float64)
    Vc = (V.min(0) + V.max(0)) / 2.0
    quads = np.asarray(brain["surfFaces"]).astype(np.int64) - 1
    keep = np.asarray(brain["keep"]).reshape(-1).astype(bool)
    face_elem = (np.nonzero(keep)[0] // 6).astype(np.int32)  # surface face -> element index
    assert face_elem.shape[0] == quads.shape[0], "keep mask / surface face count mismatch"
    tris = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]], axis=0).astype(np.uint32)
    quad_of_tri = np.concatenate([np.arange(len(quads)), np.arange(len(quads))]).astype(np.uint32)

    Vf_all = np.asarray(fiber["Vf"], dtype=np.float64)
    Vfc = (np.asarray(fiber["V"], dtype=np.float64).min(0) + np.asarray(fiber["V"], dtype=np.float64).max(0)) / 2.0
    assert np.allclose(Vc, Vfc)
    # Interior elements. The mesh is 38 layers of height 2 along z; in-plane the cells are irregular, so each element is drawn as a
    # box of height 2 and a width taken from the spacing to its nearest neighbour in the same layer. Boxes are placed at the
    # element centroids in the rotated display frame and oriented by the same rotation (see meta.rot).
    cent = np.asarray(np.load(os.path.join(src_dir, "ElementCentroids.npz"))["centroids"], dtype=np.float64)
    nn = np.empty(len(cent))
    for s0 in range(0, len(cent), 400):
        P = cent[s0:s0 + 400]
        D = np.linalg.norm(P[:, None, :2] - cent[None, :, :2], axis=2)
        D = np.where(np.abs(P[:, None, 2] - cent[None, :, 2]) < 0.9, D, 1e9)
        D[np.arange(len(P)), np.arange(s0, s0 + len(P))] = 1e9
        nn[s0:s0 + 400] = D.min(1)
    width = np.clip(nn * 1.15, 0.8, 2.6)
    elem_size = np.stack([width, width, np.full(len(cent), 2.0)], axis=1)
    write_femb(
        os.path.join(out_dir, "brain.bin"),
        {
            "V": rotate(V, Vc).astype("<f4"),
            "tris": tris,
            "quadOfTri": quad_of_tri,
            "faceElem": face_elem,
            "elemCenter": rotate(cent, Vc).astype("<f4"),
            "elemSize": elem_size.astype("<f4"),
        },
        {
            "nVertices": int(V.shape[0]), "nTris": int(tris.shape[0]), "nElements": int(brain["Ne"]),
            "rot": rotation_matrix(*DEFAULT_ROTATE_DEG).reshape(-1).tolist(),
        },
    )
    idx1 = np.asarray(fiber["idx1"]).reshape(-1).astype(np.int64) - 1
    idx2 = np.asarray(fiber["idx2"]).reshape(-1).astype(np.int64) - 1
    write_femb(
        os.path.join(out_dir, "fibers.bin"),
        {"Vf": rotate(Vf_all, Vfc).astype("<f4"), "idx1": idx1.astype("<u4"), "idx2": idx2.astype("<u4")},
        {"nSegments": int(idx1.shape[0])},
    )
    # Centroids only feed the CSV exports.
    el = np.asarray(np.load(os.path.join(src_dir, "ElementCentroids.npz"))["centroids"], dtype="<f8")
    fc = np.asarray(np.load(os.path.join(src_dir, "FiberCentroids.npz"))["centroids"], dtype="<f8")
    write_femb(os.path.join(out_dir, "centroids.bin"), {"element": el, "fiber": fc}, {})
    return {"elements": int(el.shape[0]), "fibers": int(fc.shape[0])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("assets", help="path to the desktop build's assets_opt folder")
    ap.add_argument("--out", default="data")
    a = ap.parse_args()

    models_out = os.path.join(a.out, "models")
    mesh_out = os.path.join(a.out, "mesh")
    os.makedirs(models_out, exist_ok=True)
    os.makedirs(mesh_out, exist_ok=True)

    manifest = {"models": {}}
    total = 0
    for src in sorted(glob.glob(os.path.join(a.assets, "models_pkl", "*.pkl.gz"))):
        name = os.path.basename(src)[: -len(".pkl.gz")]
        dst = os.path.join(models_out, name + ".bin")
        meta = export_model(src, dst)
        size = os.path.getsize(dst)
        total += size
        manifest["models"][name] = {"family": meta["family"], "nComp": meta["nComp"], "bytes": size}
        print(f"{name:42s} {meta['family']:6s} nComp={meta['nComp']} {size / 1e6:7.2f} MB")

    manifest["mesh"] = export_meshes(os.path.join(a.assets, "meshes_npz"), mesh_out)

    ds = np.load(os.path.join(a.assets, "meshes_npz", "Dataset.npz"))["datasetVelAcc"]
    with open(os.path.join(a.out, "dataset.json"), "w") as fh:
        json.dump({"angVelMax": [round(float(v), 6) for v in ds[:, 0]], "angAccMax": [round(float(v), 4) for v in ds[:, 1]]}, fh)
    with open(os.path.join(a.out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"models total {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
