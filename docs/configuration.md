# 配置系统

Kapibala 采用统一规范的 `.kapibala` 目录与 `settings.json` 命名。本文覆盖配置优先级、格式与内置模型目录；具体字段以 [settings.schema.json](../schemas/settings.schema.json) 为准。

## 配置文件优先级与位置

1. **运行时 Slash 指令**（最高优先级）：`/model <id>`
2. **CLI 启动参数**：`--model <id>`、`--base-url <url>`、`--api-key <key>`
3. **环境变量**：`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`OPENAI_BASE_URL` 等
4. **工作区项目级配置**：`./.kapibala/settings.json`
5. **全局用户配置**：`~/.kapibala/settings.json`（Windows 为 `%USERPROFILE%\.kapibala\settings.json`）

## 智能配置补全（`$schema`）与配置格式

配置文件首行声明 `$schema`，在 VS Code / Cursor 等编辑器中自动享有**自动补全、格式校验与字段文档悬浮提示**：

```json
{
  "$schema": "https://raw.githubusercontent.com/tedburner/kapibala/main/schemas/settings.schema.json",
  "defaultModel": "deepseek-flash",
  "modelRouting": {
    "planning": "deepseek-v4-pro",
    "execution": "deepseek-flash"
  },
  "builtinCatalogVersion": 4,
  "profiles": [
    {
      "id": "deepseek-flash",
      "name": "DeepSeek Flash (V4.1-Flash)",
      "provider": "openai-compatible",
      "baseURL": "https://api.deepseek.com/v1",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "modelName": "deepseek-flash",
      "contextWindow": 1000000,
      "supportsThinking": true
    }
  ]
}
```

> `contextWindow` 同时接受整数与带单位的字符串（如 `1000000`、`"1M"`、`"256K"`），`K/M` 按十进制换算、大小写不敏感；不接受容易与字节混淆的 `KB/MB`。旧展示接口未配置时可回退 `1M`；v0.0.3 控制请求的预算使用保守 `32K`，`/context` 会标明估算来源，展示回退不能作为实际模型容量。

> **`profiles` 只需要写你自己关心或自建的模型。** 内置清单由程序侧提供，缺哪家就在运行时从代码里补哪家；重复抄一份进配置只会得到一份会过期的快照。因此这个数组**允许为空**，`~/.kapibala/settings.json` 里通常只有你填过密钥的那几条。

## 内置模型清单与自动升级

内置清单共 **8 家厂商 / 20 个模型**，默认模型为 `deepseek-flash`：

| 厂商 | 模型 id | 上下文 |
|---|---|--:|
| **DeepSeek** | `deepseek-flash`（V4.1-Flash，默认）<br>`deepseek-v4-pro` | 1000k |
| **OpenAI** | `gpt-6-astra`<br>`gpt-5.6-sol`<br>`gpt-5.6-terra`<br>`gpt-5.6-luna` | 1050k |
| **Anthropic** | `claude-fable-5-1`<br>`claude-opus-5`<br>`claude-sonnet-5`<br>`claude-haiku-4-5` | 1000k<br>200k |
| **Google** | `gemini-3.1-pro-preview`<br>`gemini-3-flash-preview` | 1000k |
| **通义千问** | `qwen3.8-max`<br>`qwen3.8-flash`<br>`qwen3.7-plus` | 1000k |
| **Kimi** | `kimi-k3`<br>`kimi-k2.7-code` | 1000k<br>256k |
| **智谱 GLM** | `glm-5.3`<br>`glm-5.3-flash` | 1000k |
| **本地 Ollama** | `ollama`（`gpt-oss:20b`，免密钥） | 131k |

清单版本号记录在 `settings.json` 的 `builtinCatalogVersion` 字段（由程序写入，无需手改）。启动时若发现它落后于当前版本，会**自动做一次目录升级**：已退役的模型 id 被**重定向**到现役档位（密钥一并带过去），仍在内置清单里的 Profile 同步协议、端点、模型名与上下文窗口，默认和角色引用随旧 ID 重映射。目录第 4 版把内置 Claude 改为 Messages、OpenAI 改为 Responses；缺省输出预算从目录继承，用户显式预算和自建 Profile 保留。升级**不会写入任何你从未启用过的内置模型**，配置原子替换失败时保留旧文件。
