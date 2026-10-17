# ml/ – YOLOv8 модели за CogniRouteAI

Апликацијата ги извршува моделите во прелистувачот на телефонот (onnxruntime-web, WebGPU или WebAssembly), па тие мора да бидат во ONNX формат.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r ml/requirements.txt
```

## 1. YOLOv8n за возила и пешаци (веќе вклучен)

`public/models/yolov8n.onnx` е официјалниот YOLOv8n (COCO, 80 класи), извезен со динамичка големина на влезот. Апликацијата користи 320×192 на побавни телефони и 640×384 кога има WebGPU. Повторно се прави со:

```bash
python ml/export_yolov8.py --weights yolov8n.pt --out public/models --verify slika.jpg
```

Апликацијата ги користи класите: пешак, велосипед, автомобил, мотоцикл, автобус, камион, семафор, STOP знак, куче, коњ, овца и крава (`shared/vision/yolo.js`).

## 2. YOLOv8-seg за полни и испрекинати линии (по избор)

Стандардниот YOLOv8 нема класа за линии на патот. Затоа апликацијата стандардно користи вграден детектор (`shared/vision/lanes.js`), кој на тест-видеата точно ги разликува полната и испрекинатата линија. Ако сакаш линиите да ги препознава YOLOv8, тренирај свој модел:

1. Симни го [BDD100K](https://bdd-data.berkeley.edu) (бесплатна регистрација): сликите `100k` и ознаките `lane`.
2. Претвори ги ознаките во YOLO формат. Класите се `solid_line`, `dashed_line`, `double_solid` и `crosswalk`:

   ```bash
   python ml/bdd100k_to_yolo_lanes.py --labels bdd100k/labels/lane/polygons/lane_train.json \
       --images bdd100k/images/100k/train --out ml/datasets/lanes --split train
   python ml/bdd100k_to_yolo_lanes.py --labels bdd100k/labels/lane/polygons/lane_val.json \
       --images bdd100k/images/100k/val --out ml/datasets/lanes --split val
   ```

3. Тренирај. Препорачано е со GPU, на пр. Google Colab. Скриптата на крајот го извезува моделот:

   ```bash
   python ml/train_lane_lines.py --data ml/datasets/lanes/data.yaml --epochs 60 --imgsz 640
   ```

   Резултат: `public/models/lanes.onnx` и `lanes.json`.

4. `npm run build`. Кога `lanes.onnx` постои, камерата кон патот го користи за линиите (на секој втор кадар), а маневрите и проверката за полна линија остануваат исти. Подсказката на ознаката „Пат … fps“ покажува кој детектор е активен.

Пред возење провери ја точноста (mAP за `solid_line` и `dashed_line`) на валидациското множество. Целиот тек е проверен од крај до крај на мало синтетичко множество, но за вистинска точност потребни се вистински податоци.

## Лиценца

YOLOv8 (Ultralytics) е под AGPL-3.0, вклучително и моделите тренирани со него. За затворен комерцијален производ потребна е лиценца од Ultralytics.
