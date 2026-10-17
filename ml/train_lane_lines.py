"""Train YOLOv8-seg to recognise lane lines (solid / dashed / double solid /
crosswalk) and export it for the app as public/models/lanes.onnx.

When public/models/lanes.onnx exists, the app's road camera uses this model
for the lane lines instead of the built-in line detector.

    python ml/bdd100k_to_yolo_lanes.py ...            # build the dataset first
    python ml/train_lane_lines.py --data ml/datasets/lanes/data.yaml --epochs 60

A GPU is strongly recommended (e.g. Google Colab: !pip install ultralytics).
The nano model at 640 px is a good start for phones; check the validation
mAP of the solid_line and dashed_line classes before trusting it on the road.
"""

import argparse
from pathlib import Path

from export_yolov8 import export


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", default="ml/datasets/lanes/data.yaml")
    parser.add_argument("--model", default="yolov8n-seg.pt", help="starting weights")
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--device", default=None, help="e.g. 0 for the first GPU, cpu")
    parser.add_argument("--project", default="ml/runs")
    parser.add_argument("--out", default="public/models", help="where lanes.onnx and lanes.json go")
    args = parser.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.model)
    results = model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        project=args.project,
        name="lanes",
        exist_ok=True,
        # Lane lines are left/right asymmetric only by traffic side; flips are fine.
        fliplr=0.5,
        mosaic=0.5,
    )
    # Ultralytics decides the final run folder; ask the trainer where it saved.
    best = Path(getattr(model.trainer, "best", "") or Path(results.save_dir) / "weights" / "best.pt")
    print(f"Best weights: {best}")
    export(str(best), name="lanes", out=args.out)


if __name__ == "__main__":
    main()
