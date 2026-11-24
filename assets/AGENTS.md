# AGENTS.md — 标识资源（`assets/`）约束

- **单一真源 `assets/capybara.svg`**（贴纸风头像，640×600）。`logo / logo-dark / icon / logo-sign` 四个 SVG 由 `.workbuddy/build-assets.py` 从它派生，`.workbuddy/render.sh` 用 headless Chrome 出 PNG（`.workbuddy/` 已 gitignore，生成脚本不入库）。**改造型只改真源再重跑两个脚本，不要直接改派生文件。**
- 造型铁律：口鼻必须是"上窄下宽"的钝形深色块（水豚最关键辨识特征）；不要大面积奶油色口鼻斑（会读成泰迪熊）；头不要撑满画面（会读成河马）。
- README 抬头 `<picture>` + `prefers-color-scheme` 双主题（dark 版仅字标换暖白 `#F0E4D6`）；tagline 固定：**心如止水，稳定如初 —— AI Agent Harness**。
