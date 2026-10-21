import type { ApprovalRequest } from '@kiturone/kapibala';
import { escapeApprovalText } from '../ui/approval.js';
import { containsSensitiveMarker, redactCommonSecrets, sanitizeDisplayText } from './redaction.js';

/** 审批提示的总长度上限；命令必须完整展示，超限拒绝而非截断。 */
const MAX_TARGET_LENGTH = 2_000;
/** 单个字段上限；命令与说明仍需完整可读，路径类字段应远小于此值。 */
const MAX_FIELD_LENGTH = 400;
/** MCP 工具输入只展示少量常见定位字段，其余参数不进入审批通道。 */
const MCP_INPUT_FIELDS = ['path', 'file', 'command', 'query', 'url', 'name', 'pattern'] as const;

type Sanitizer = (value: unknown, maximum?: number) => string | undefined;

/** 先替换已知凭据，再拒绝残留敏感词；打码后的值不足以说明副作用时整体拒绝。 */
function createSanitizer(redact?: (text: string) => string): Sanitizer {
  return (value, maximum = MAX_FIELD_LENGTH) => {
    if (typeof value !== 'string' || containsSensitiveMarker(value)) return undefined;
    const redacted = redact ? redact(value) : redactCommonSecrets(value);
    return sanitizeDisplayText(redacted, maximum);
  };
}

/** 执行身份字段必须完整且未被脱敏改写；控制字符可见转义后再检查预算。 */
function describeExecutionField(
  value: string,
  maximum: number,
  redact?: (text: string) => string,
): string | undefined {
  if (!value || containsSensitiveMarker(value)) return undefined;
  const redacted = redact ? redact(value) : redactCommonSecrets(value);
  if (redacted !== value) return undefined;
  // 先转义原有反斜线，区分字面量 \n 与真正的换行，避免显示身份混淆。
  const shown = escapeApprovalText(value.replaceAll('\\', '\\\\'));
  return shown.length <= maximum ? shown : undefined;
}

function describeMcpStart(input: Record<string, unknown>, safe: Sanitizer): string | undefined {
  const serverName = safe(input.serverName, 120);
  const source = safe(input.source, 20);
  const type = safe(input.type, 20);
  const target = safe(input.target, 400);
  const cwd = safe(input.cwd, 300);
  if (!serverName || !target) return undefined;
  const lines = [`启动 MCP 服务: ${serverName}`];
  if (source) lines.push(`来源: ${source}`);
  if (type) lines.push(`传输: ${type}`);
  lines.push(`目标: ${target}`);
  if (cwd) lines.push(`工作目录: ${cwd}`);
  // args、env 与 scriptDigest 可能夹带凭据，审批只展示可解释的身份与目标。
  return lines.join('\n');
}

/**
 * 生成跨进程审批展示文本；无法安全说明目标时返回 undefined，调用方必须拒绝。
 * 子代理与 MCP 工具只展示工具名、角色和目标摘要，不搬运完整 prompt 或参数对象。
 */
export function describeApproval(
  request: ApprovalRequest,
  redact?: (text: string) => string,
): string | undefined {
  const safe = createSanitizer(redact);
  const server = request.executionIdentity?.serverIdentity;
  if (typeof server === 'string' && server) {
    const serverName = sanitizeDisplayText(server, 120);
    const toolName = sanitizeDisplayText(request.toolName, 160);
    if (!serverName || !toolName) return undefined;
    const fields: string[] = [];
    for (const key of MCP_INPUT_FIELDS) {
      const value = request.input[key];
      if (typeof value !== 'string') continue;
      const shown = safe(value, 200);
      if (!shown) return undefined;
      fields.push(`${key}: ${shown}`);
      if (fields.length >= 4) break;
    }
    const target = [`MCP ${serverName} · ${toolName}`, ...fields].join('\n');
    return target.length <= MAX_TARGET_LENGTH ? target : undefined;
  }
  switch (request.toolName) {
    case 'write_file':
    case 'edit_file': {
      const filePath = safe(request.input.path);
      return filePath ? `${request.toolName} ${filePath}` : undefined;
    }
    case 'run_command': {
      if (!request.shell) return undefined;
      const command = describeExecutionField(request.shell.command, 800, redact);
      const cwd = describeExecutionField(request.shell.cwd, 300, redact);
      const interpreter = describeExecutionField(
        request.shell.executablePath ?? request.shell.interpreter,
        300,
        redact,
      );
      if (!command || !cwd || !interpreter) return undefined;
      const target = `解释器: ${interpreter}\n工作目录: ${cwd}\n完整命令: ${command}`;
      return target.length <= MAX_TARGET_LENGTH ? target : undefined;
    }
    case 'mcp_start':
      return describeMcpStart(request.input, safe);
    case 'spawn_agent': {
      const description = safe(request.input.description, 300);
      if (!description) return undefined;
      const role = safe(request.input.role, 40);
      const cwd = safe(request.input.cwd, 300);
      const lines = [`派生子代理${role ? `（${role}）` : ''}: ${description}`];
      if (cwd) lines.push(`工作目录: ${cwd}`);
      // prompt 是完整指令且常含业务上下文，审批只展示任务摘要。
      return lines.join('\n');
    }
    case 'wait_agent': {
      const ids = Array.isArray(request.input.agentIds) ? request.input.agentIds : [];
      if (!ids.length || ids.length > 64) return undefined;
      const shown: string[] = [];
      for (const id of ids.slice(0, 5)) {
        const value = safe(id, 128);
        if (!value) return undefined;
        shown.push(value);
      }
      const suffix = ids.length > shown.length ? ` 等 ${ids.length} 个` : '';
      return `等待子代理: ${shown.join(', ')}${suffix}`;
    }
    case 'cancel_agent': {
      const agentId = safe(request.input.agentId, 128);
      if (!agentId) return undefined;
      const reason = safe(request.input.reason, 200);
      return reason ? `取消子代理: ${agentId}\n原因: ${reason}` : `取消子代理: ${agentId}`;
    }
    case 'load_skill': {
      const name = safe(request.input.name, 128);
      return name ? `加载技能: ${name}` : undefined;
    }
    default:
      return undefined;
  }
}
