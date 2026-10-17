"""Convert BDD100K lane-marking labels into a YOLOv8 segmentation dataset.

BDD100K (https://bdd-data.berkeley.edu, free registration) labels every lane
marking as a polyline with a style (solid / dashed) and a type (single/double
white/yellow, crosswalk, road curb). This script turns each marking into a
thin polygon so YOLOv8-seg can learn to segment it, with the classes the app
understands:

    0 solid_line    single solid marking (полна линија)
    1 dashed_line   dashed marking (испрекината линија)
    2 double_solid  double solid marking (двојна полна линија)
    3 crosswalk     zebra crossing (пешачки премин)

Usage:
    python ml/bdd100k_to_yolo_lanes.py \
        --labels bdd100k/labels/lane/polygons/lane_train.json \
        --images bdd100k/images/100k/train --out ml/datasets/lanes --split train
    (repeat with lane_val.json / images/100k/val and --split val)

Both the Scalabel format (attributes.style / attributes.direction) and the
older format (attributes.laneStyle / attributes.laneDirection) are read.
"""

import argparse
import json
import os
import shutil
from pathlib import Path

import numpy as np

CLASSES = ["solid_line", "dashed_line", "double_solid", "crosswalk"]


def marking_class(label):
    category = label.get("category", "").replace("lane/", "")
    attrs = label.get("attributes") or {}
    style = attrs.get("style") or attrs.get("laneStyle") or ""
    direction = attrs.get("direction") or attrs.get("laneDirection") or ""
    if "crosswalk" in category:
        return CLASSES.index("crosswalk")
    if "curb" in category or direction == "vertical":
        return None  # road edge or stop line: not a lane line
    if style == "dashed":
        return CLASSES.index("dashed_line")
    if style == "solid":
        return CLASSES.index("double_solid" if category.startswith("double") else "solid_line")
    return None


def polyline_points(poly):
    """Vertices of a poly2d; cubic Bezier segments ('C' control points) are sampled."""
    vertices = poly.get("vertices") or []
    types = poly.get("types") or "L" * len(vertices)
    points = []
    i = 0
    while i < len(vertices):
        if i + 3 < len(vertices) and types[i + 1 : i + 3] == "CC":
            p0, p1, p2, p3 = (np.array(vertices[i + k], dtype=float) for k in range(4))
            for t in np.linspace(0, 1, 12, endpoint=False):
                points.append((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t**2 * p2 + t**3 * p3)
            i += 3
        else:
            points.append(np.array(vertices[i], dtype=float))
            i += 1
    return np.array(points)


def thicken(points, width):
    """Polyline -> closed polygon of the given width (left side, then right side backwards)."""
    if len(points) < 2:
        return None
    direction = np.gradient(points, axis=0)
    norms = np.linalg.norm(direction, axis=1, keepdims=True)
    norms[norms == 0] = 1
    normal = np.stack([-direction[:, 1], direction[:, 0]], axis=1) / norms
    left = points + normal * width / 2
    right = points - normal * width / 2
    return np.concatenate([left, right[::-1]])


def convert(labels_file, images_dir, out_dir, split, image_size=(1280, 720), copy=False):
    data = json.loads(Path(labels_file).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("frames") or data.get("labels") or []
    img_out = Path(out_dir) / "images" / split
    lbl_out = Path(out_dir) / "labels" / split
    img_out.mkdir(parents=True, exist_ok=True)
    lbl_out.mkdir(parents=True, exist_ok=True)
    w, h = image_size
    written = 0
    for frame in data:
        rows = []
        for label in frame.get("labels") or []:
            cls = marking_class(label)
            if cls is None:
                continue
            for poly in label.get("poly2d") or []:
                points = polyline_points(poly)
                polygon = thicken(points, 16 if cls == CLASSES.index("double_solid") else 10)
                if polygon is None:
                    continue
                polygon[:, 0] = np.clip(polygon[:, 0] / w, 0, 1)
                polygon[:, 1] = np.clip(polygon[:, 1] / h, 0, 1)
                rows.append(f"{cls} " + " ".join(f"{v:.5f}" for v in polygon.reshape(-1)))
        if not rows:
            continue
        src = Path(images_dir) / frame["name"]
        if not src.exists():
            continue
        dst = img_out / frame["name"]
        if not dst.exists():
            if copy:
                shutil.copy(src, dst)
            else:
                os.symlink(src.resolve(), dst)
        (lbl_out / f"{Path(frame['name']).stem}.txt").write_text("\n".join(rows) + "\n", encoding="utf-8")
        written += 1
    yaml = Path(out_dir) / "data.yaml"
    yaml.write_text(
        f"path: {Path(out_dir).resolve()}\ntrain: images/train\nval: images/val\nnames:\n" + "".join(f"  {i}: {n}\n" for i, n in enumerate(CLASSES)),
        encoding="utf-8",
    )
    print(f"{split}: {written} images with lane labels -> {out_dir}")
    return written


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--labels", required=True, help="BDD100K lane label JSON")
    parser.add_argument("--images", required=True, help="matching image folder")
    parser.add_argument("--out", default="ml/datasets/lanes")
    parser.add_argument("--split", default="train", choices=["train", "val"])
    parser.add_argument("--copy", action="store_true", help="copy images instead of symlinking")
    args = parser.parse_args()
    convert(args.labels, args.images, args.out, args.split, copy=args.copy)


if __name__ == "__main__":
    main()
