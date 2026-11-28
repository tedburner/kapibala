# AGENTS.md — 标识资源（`assets/`）约束

- **单一真源 `assets/capybara.svg`**（极简墨线 Atelier Monoline，512×512）。`logo / logo-dark / icon / logo-sign / mascot` 五个 SVG 由 `.workbuddy/build-assets.py` 从它派生（其中 `mascot.svg` 为内置呼吸/落橘/热气/水波循环关键帧的独立动图 SVG），`.workbuddy/render.sh`（调用 `.workbuddy/render-assets.mjs` + headless Chrome）出 2x 透明底 PNG（`.workbuddy/` 已 gitignore，生成脚本不入库）。**改造型只改真源再重跑两个脚本，不要直接改派生文件。**
- 造型与色彩铁律：保留朝右静卧侧影的等粗连续墨线（平直吻桥、方钝鼻端、后置圆耳环、半阖横眼）与头顶悬置的「水豚琥珀」圆点；浅色使用曜石墨 `#181816` + 水豚琥珀 `#C26B33`，深色（`logo-dark`）经 `--kpbl-ink` / `--kpbl-amber` 同步切换为暖白 `#F4F3EE` + `#E58B52`；中文横竖字标固定为 **`卡皮巴拉`**（正统宋体排印，禁止 `lengthAdjust` 拉伸变形），应用图标底色为宣石暖纸 `#F2EAE0`。
- README 抬头 `<picture>` + `prefers-color-scheme` 双主题；tagline 固定：**心如止水，稳定如初 —— AI Agent Harness**。
