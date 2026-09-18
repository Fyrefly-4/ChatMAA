"""离线比对失败截图中的固定图标；不连接窗口、不启动 MAA。需要 Pillow、NumPy。"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def match(image, template):
    # 对应本轮未使用掩码的模板，计算多通道归一化相关；不是完整 MAA 识别器。
    pixels = np.asarray(image, dtype=np.float64)
    target = np.asarray(template, dtype=np.float64)
    height, width = target.shape[:2]
    centered = target - target.mean(axis=(0, 1), keepdims=True)
    windows = np.lib.stride_tricks.sliding_window_view(pixels, (height, width), axis=(0, 1))
    numerator = np.einsum("ijchw,chw->ij", windows, centered.transpose(2, 0, 1), optimize=True)

    def areas(values):
        integral = np.pad(values, ((1, 0), (1, 0), (0, 0))).cumsum(axis=0).cumsum(axis=1)
        return (integral[height:, width:] - integral[:-height, width:]
                - integral[height:, :-width] + integral[:-height, :-width])

    variance = np.maximum(areas(pixels * pixels) - areas(pixels) ** 2 / (height * width), 0).sum(axis=2)
    denominator = np.sqrt(variance * (centered * centered).sum())
    scores = np.divide(numerator, denominator, out=np.zeros_like(numerator), where=denominator > 1e-8)
    y, x = np.unravel_index(np.argmax(scores), scores.shape)
    return {"score": round(float(scores[y, x]), 6), "xy": [int(x + 227), int(y + 327)]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--installation", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    template = Image.open(args.installation / "resource/template/UiTheme/SwitchTheme/SwitchTheme@ToggleSettingsMenu.png").convert("RGB")
    roi = (227, 327, 386, 479)
    results = []
    for path in [args.run / "after.png", *sorted((args.run / "debug/interface").glob("*_raw.png"))]:
        original = Image.open(path).convert("RGB")
        for scale in (1.0, 0.8):
            im = original if scale == 1 else original.resize(
                (round(original.width * scale), round(original.height * scale)), Image.Resampling.BILINEAR)
            results.append({"source": "after" if path.name == "after.png" else "failure",
                            "image_scale": scale, **match(im.crop(roi), template)})
    report = {"method": "offline unmasked multichannel normalized correlation; not full MaaCore recognition",
              "roi": list(roi), "results": results}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
