# Release soak 冻结基线

`release-baseline.json` 必须由固定环境的三次实测结果经人工审核后生成并提交。当前基线已由维护者审核：RSS 18432、heap 1024 字节/轮，三份完整报告、测量环境及计算依据随 JSON 保存；该基线不代表最终候选已通过正式 release soak。

文件包含两个以「字节 / 轮」计量的数值字段：`rssGrowthBytesPerRound`（宿主 RSS 增长上限）与 `heapGrowthBytesPerRound`（客户端 heap 增长上限）。阈值应覆盖实测波动，并记录环境和审核依据；不能凭经验填写或用无穷大绕过门禁。

采集趋势时可运行 `pnpm verify:soak:release`。缺少 `--baseline` 的运行仍保存采样证据，但结果为 `pending`、退出码为 1，不能用于发布。

也可手动运行 **Soak** 工作流，选择 `tier=collect-baseline`：在与正式 release 相同的 Ubuntu 24.04 / Node 24 通道，在同一个 runner 上连续采集三次 1000 轮、至少 30 分钟的完整报告。`soak-baseline-candidates` 资产中的 `1/2/3` 目录分别保存每轮原始报告；三次构建与运行共用同一 VM、Node 安装和 runner 镜像，避免独立矩阵 job 被分配到不同镜像。采集只允许「缺少冻结阈值」这一项 pending；探针失败、轮数/时长不足、调试覆盖、脏工作区和缺少有效斜率都会阻断。采集 job 通过只表示候选数据可供审核，不表示 release soak 通过。每轮还检查报告生成时间不早于本轮启动时间，拒绝在进程失败后复用上一轮报告；环境快照逐轮与首轮比对。

首次使用前，用户需手动审核、提交并推送相关源码和 `.github/workflows/soak.yml`。GitHub 的手动工作流需要先出现在仓库默认分支（见[官方说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)）；随后可在 Actions → Soak → Run workflow 选择包含目标源码的分支及 `collect-baseline`。三次采集使用该次触发的同一 SHA；不要在采集中途改换候选，也不要推送版本标签来触发采集。

首次尚未注册手动工作流，或不使用 GitHub CLI/浏览器时，也可在 `codex/**` 准备分支的提交说明中显式加入 `[collect-baseline]` 后推送。Soak 会直接使用这次 push 的完整 SHA 采集三份候选，不要求先合入默认分支；普通分支推送不会启动长跑，main 和 tag 推送也不走这个入口。提交和推送遵循仓库约定，代理执行前必须取得用户对本次 Git 操作的明确授权。

审核时确认三份报告属于同一提交，Node 完整版本、架构及 runner image 版本一致；不一致则重新采集。根据原始样本和波动确定两个有限非负阈值，并在基线 JSON 中附上环境、三份报告链接和审核依据后提交。工作流不会自动填写阈值或生成已审核基线。审核并提交基线后运行：

```sh
pnpm verify:soak:release --baseline scripts/fixtures/soak/release-baseline.json
```

Release 工作流默认读取上述路径；复用 Verify 工作流可通过 `soak_baseline` 输入指定同一源提交内的其他基线文件。手动 Soak 工作流使用 `baseline` 输入。CI 在开始 release 长跑前检查文件存在，缺失时直接阻断。

提供基线后，heap 与宿主 RSS 都必须能从至少两个不同轮次的有限采样值计算斜率；任何已开始采样的宿主样本不足也失败，不能由另一宿主的有效斜率掩盖。
