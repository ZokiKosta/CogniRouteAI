"""Export a YOLOv8 model to ONNX for the CogniRouteAI mobile app.

The app runs the model in the browser with onnxruntime-web, so the export uses
dynamic height/width: the app picks 320x192 on slower phones and 640x384 when
WebGPU is available (both are multiples of 32 and fit a 16:9 camera frame).

Usage:
    pip install -r ml/requirements.txt
    python ml/export_yolov8.py --weights yolov8n.pt --out public/models
    python ml/export_yolov8.py --weights runs/segment/lanes/weights/best.pt \
        --name lanes --out public/models          # your own lane-line model

Writes <out>/<name>.onnx and <out>/<name>.json (task, class names, input size).
"""

import argparse
import json
import shutil
import time
from pathlib import Path

import numpy as np


def letterbox(image, width, height):
    """Resize keeping aspect ratio and pad with gray (114), like the app does."""
    import cv2

    h, w = image.shape[:2]
    scale = min(width / w, height / h)
    nw, nh = round(w * scale), round(h * scale)
    resized = cv2.resize(image, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((height, width, 3), 114, dtype=np.uint8)
    top, left = (height - nh) // 2, (width - nw) // 2
    canvas[top:top + nh, left:left + nw] = resized
    return canvas


def verify(onnx_path, names, image_path):
    """Run the exported model with onnxruntime at both app input sizes."""
    import cv2
    import onnxruntime as ort

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    image = cv2.cvtColor(cv2.imread(str(image_path)), cv2.COLOR_BGR2RGB)
    for width, height in [(320, 192), (640, 384)]:
        blob = letterbox(image, width, height).astype(np.float32) / 255.0
        blob = blob.transpose(2, 0, 1)[None]
        start = time.perf_counter()
        outputs = session.run(None, {session.get_inputs()[0].name: blob})
        elapsed = (time.perf_counter() - start) * 1000
        preds = outputs[0][0]  # (4 + classes [+ 32 mask coeffs], anchors)
        scores = preds[4:4 + len(names)]
        best = scores.max(axis=0)
        classes = scores.argmax(axis=0)
        found = sorted({names[c] for c, s in zip(classes, best) if s > 0.4})
        print(f"  {width}x{height}: output {tuple(outputs[0].shape)}, {elapsed:.0f} ms, found: {found}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--weights", default="yolov8n.pt", help="YOLOv8 .pt weights (downloaded automatically if missing)")
    parser.add_argument("--name", default=None, help="output file name without extension (default: weights stem)")
    parser.add_argument("--out", default="public/models", help="output directory")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--verify", default=None, help="optional image to run a quick sanity check on")
    args = parser.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.weights)
    exported = Path(model.export(format="onnx", dynamic=True, simplify=True, opset=args.opset, imgsz=640))

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = args.name or Path(args.weights).stem
    onnx_path = out_dir / f"{name}.onnx"
    shutil.move(str(exported), onnx_path)

    names = [model.names[i] for i in sorted(model.names)]
    meta = {
        "name": name,
        "task": model.task,  # "detect" or "segment"
        "classes": names,
        "inputSizes": {"fast": [320, 192], "quality": [640, 384]},
        "source": str(args.weights),
        "license": "AGPL-3.0 (Ultralytics YOLOv8)",
    }
    (out_dir / f"{name}.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Saved {onnx_path} ({onnx_path.stat().st_size / 1e6:.1f} MB) and {name}.json, {len(names)} classes")

    if args.verify:
        verify(onnx_path, names, args.verify)


if __name__ == "__main__":
    main()
