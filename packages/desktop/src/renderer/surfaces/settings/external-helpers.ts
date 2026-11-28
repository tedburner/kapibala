import type { Output } from '../../../shared/contracts.js';
import type { StatusDotState } from '../../ui/index.js';

/** `external.harnesses` 宿主输出契约。 */
export type HarnessesCatalogOutput = Output<'external.harnesses'>;

/** 单个外部代理配置与探针摘要条目。 */
export type ExternalHarnessItem = HarnessesCatalogOutput['harnesses'][number];

/** 官方 ACP 目录模板条目。 */
export type ExternalTemplateItem = HarnessesCatalogOutput['templates'][number];

/** 外部代理握手探测结果。 */
export type ExternalProbeResult = Output<'external.testHarness'>;

/** 内置外部代理路径/参数/透传环境变量覆盖草稿。 */
export interface BuiltinOverrideDraft {
  readonly id: string;
  readonly command: string;
  readonly argsText: string;
  readonly envFromText: string;
}

/** 自定义 `Local ACP Command` 编辑草稿；参数按行切分，严禁经过 Shell 拼接。 */
export interface CustomHarnessDraft {
  readonly id: string;
  readonly idLocked: boolean;
  readonly idTouched: boolean;
  readonly name: string;
  readonly command: string;
  readonly argsText: string;
  readonly envFromText: string;
  readonly registryId?: string;
  readonly enabled: boolean;
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 自定义代理唯一标识正则校验（小写字母/数字开头，允许连字符与下划线）。 */
export const HARNESS_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const PASTED_SECRET_RE =
  /^(?:sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_]{8,}|pk_[A-Za-z0-9_]{8,}|rk_[A-Za-z0-9_]{8,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{8,}|hf_[A-Za-z0-9]{12,}|gsk_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{16,}|AKIA[0-9A-Z]{12,})$/;

/**
 * 逐行拆解非空命令行参数：保留单行内部空格（如带空格路径），仅剔除空行与首尾空白。
 */
export function parseArgsLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 校验并提取环境变量名白名单：前端先行拦截 `KEY=VALUE` 键值对或疑似直接粘贴的 API 密钥明文，
 * 严守「仅登记系统变量名、零第三方密钥落盘」安全边界（015 & 017 §6.7）。
 */
export function parseEnvNames(text: string): { readonly names: string[]; readonly error?: string } {
  const raw = text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of raw) {
    if (item.includes('=')) {
      const keyPreview = item.slice(0, item.indexOf('=')).slice(0, 48) || '***';
      return {
        names: [],
        error: `环境变量名「${keyPreview}=***」不应包含 "=" 或密钥值，请仅填写变量名。`,
      };
    }
    if (PASTED_SECRET_RE.test(item)) {
      return {
        names: [],
        error: '检测到疑似直接粘贴了密钥明文，请仅填写系统环境变量名称（如 OPENAI_API_KEY）。',
      };
    }
    if (!ENV_NAME_RE.test(item)) {
      const safePreview = item.length > 24 ? `${item.slice(0, 12)}…` : item;
      return {
        names: [],
        error: `环境变量名「${safePreview}」格式不合法（需以字母或下划线开头，仅含字母、数字与下划线）。`,
      };
    }
    if (!seen.has(item)) {
      seen.add(item);
      names.push(item);
    }
  }
  return { names };
}

/**
 * 根据代理显示名派生默认 `kebab-case` 标识符，并自动跳过已占用的内置或自定义 ID。
 */
export function suggestHarnessId(name: string, occupiedIds?: ReadonlySet<string>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const base = slug || 'custom-acp';
  if (!occupiedIds || !occupiedIds.has(base)) return base;
  let suffix = 2;
  while (occupiedIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** 构造空白自定义 ACP 代理草稿。 */
export function createBlankCustomHarnessDraft(): CustomHarnessDraft {
  return {
    id: '',
    idLocked: false,
    idTouched: false,
    name: '',
    command: '',
    argsText: 'acp',
    envFromText: '',
    enabled: true,
  };
}

/** 从官方 ACP 目录模板生成表单回填草稿。 */
export function draftFromTemplate(
  template: ExternalTemplateItem,
  customHarnesses: readonly ExternalHarnessItem[],
): CustomHarnessDraft {
  const existing = customHarnesses.find((item) => item.id === template.registryId);
  return {
    id: existing ? `${template.registryId}-custom` : template.registryId,
    idLocked: false,
    idTouched: true,
    name: template.name,
    command: template.command,
    argsText: template.args.join('\n'),
    envFromText: (template.envFrom ?? []).join(', '),
    registryId: template.registryId,
    enabled: true,
  };
}

/** 从已存自定义代理生成锁定 ID 的编辑草稿。 */
export function draftFromCustomHarness(item: ExternalHarnessItem): CustomHarnessDraft {
  return {
    id: item.id,
    idLocked: true,
    idTouched: true,
    name: item.name,
    command: item.command,
    argsText: item.args.join('\n'),
    envFromText: item.envFrom.join(', '),
    registryId: item.registryId,
    enabled: item.enabled,
  };
}

/** 校验待保存自定义 ACP 代理草稿并返回规范化载荷或可读中文错误。 */
export function validateCustomHarnessDraft(
  draft: CustomHarnessDraft,
  builtinHarnesses: readonly ExternalHarnessItem[],
  customHarnesses: readonly ExternalHarnessItem[],
  allHarnessIds: ReadonlySet<string>,
):
  | {
      readonly ok: true;
      readonly payload: {
        readonly id: string;
        readonly builtin: false;
        readonly name: string;
        readonly command: string;
        readonly args: string[];
        readonly envFrom: string[];
        readonly registryId?: string;
        readonly enabled: boolean;
      };
    }
  | { readonly ok: false; readonly error: string } {
  const name = draft.name.trim();
  const id = (draft.id.trim() || suggestHarnessId(name, allHarnessIds)).toLowerCase();
  const command = draft.command.trim();
  if (!name) return { ok: false, error: '请填写自定义代理的显示名称。' };
  if (!HARNESS_ID_RE.test(id)) {
    return {
      ok: false,
      error: '代理标识 ID 需以小写字母或数字开头，仅含小写字母、数字、连字符或下划线。',
    };
  }
  if (builtinHarnesses.some((item) => item.id === id)) {
    return { ok: false, error: `标识「${id}」与内置代理冲突，请更换其它 ID。` };
  }
  if (!draft.idLocked && customHarnesses.some((item) => item.id === id)) {
    return { ok: false, error: `标识「${id}」已被现有自定义代理占用，请更换其它 ID。` };
  }
  if (!command) return { ok: false, error: '请填写可执行命令或绝对路径。' };
  const parsedEnv = parseEnvNames(draft.envFromText);
  if (parsedEnv.error) return { ok: false, error: parsedEnv.error };
  return {
    ok: true,
    payload: {
      id,
      builtin: false,
      name,
      command,
      args: parseArgsLines(draft.argsText),
      envFrom: parsedEnv.names,
      registryId: draft.registryId,
      enabled: draft.enabled,
    },
  };
}

/** 将底层传输协议枚举转换为设置行胶囊文案。 */
export function transportBadgeText(transport: ExternalHarnessItem['transport']): string {
  if (transport === 'acp') return '原生 ACP';
  if (transport === 'claude-cli') return '原生 CLI 直连';
  if (transport === 'pi-rpc') return 'Pi 原生直连';
  return '原生 App-Server';
}

function formatCacheUpdatedAt(updatedAt: number): string {
  const date = new Date(updatedAt);
  const now = new Date();
  const pad = (num: number) => String(num).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return hhmm;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`;
}

/** 汇总外部代理本地模型/推理档位缓存状态文案（对齐 E2E `模型缓存：已缓存 N 个模型` 断言）。 */
export function describeHarnessCache(item: ExternalHarnessItem): {
  readonly cached: boolean;
  readonly modelCount: number;
  readonly summary: string;
} {
  const options = item.cachedConfigOptions;
  if (!options || options.length === 0) {
    return {
      cached: false,
      modelCount: 0,
      summary: '模型缓存：尚未缓存，首次选用或点击右侧「拉取缓存」后写入本地',
    };
  }
  const modelCount = options.find((opt) => opt.category === 'model')?.options.length ?? 0;
  const thoughtCount = options.find((opt) => opt.category === 'thought_level')?.options.length ?? 0;
  const modeCount = options.find((opt) => opt.category === 'mode')?.options.length ?? 0;
  const parts: string[] = [
    modelCount > 0 ? `已缓存 ${modelCount} 个模型` : '已缓存运行参数',
    ...(thoughtCount > 0 ? [`推理 ${thoughtCount} 档`] : []),
    ...(modeCount > 0 ? [`模式 ${modeCount} 项`] : []),
    ...(item.cachedConfigUpdatedAt !== undefined
      ? [`更新于 ${formatCacheUpdatedAt(item.cachedConfigUpdatedAt)}`]
      : []),
  ];
  return {
    cached: true,
    modelCount,
    summary: `模型缓存：${parts.join(' · ')}`,
  };
}

/** 将探针握手结果映射为 `StatusDot` 状态枚举与可读文本（绝不仅靠颜色表达状态）。 */
export function probeStatusPresentation(probe?: ExternalProbeResult): {
  readonly dotState: StatusDotState;
  readonly label: string;
} {
  if (!probe) return { dotState: 'offline', label: '未检测' };
  if (probe.status === 'ready') {
    return { dotState: 'success', label: probe.version ? `就绪 · ${probe.version}` : '就绪' };
  }
  if (probe.status === 'needs_login') return { dotState: 'warning', label: '需登录' };
  if (probe.status === 'auth_unverified') return { dotState: 'warning', label: '认证未核验' };
  if (probe.status === 'not_installed') return { dotState: 'offline', label: '未安装' };
  if (probe.status === 'invalid_shim') return { dotState: 'danger', label: '垫片异常' };
  return { dotState: 'danger', label: '握手失败' };
}
