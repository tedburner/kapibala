/** 跨增量保留可能匹配凭证的后缀；不把原始凭证前缀提前发往 wire/replay。 */
export class StreamingRedactor {
  private pending = '';
  private readonly secrets: string[];
  constructor(secrets: readonly string[]) {
    this.secrets = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  }

  /** 一旦完整匹配就替换；不匹配的普通文本立即输出，剩余内存不超过最长凭证。 */
  push(text: string): string {
    const source = this.pending + text;
    this.pending = '';
    let output = '';
    let offset = 0;
    while (offset < source.length) {
      const full = this.secrets.find((secret) => source.startsWith(secret, offset));
      if (full) {
        output += '[REDACTED]';
        offset += full.length;
        continue;
      }
      const remainder = source.slice(offset);
      if (this.secrets.some((secret) => secret.startsWith(remainder))) {
        this.pending = remainder;
        break;
      }
      output += source[offset++];
    }
    return output;
  }

  /** 消息结束后剩余只是未完成的匹配前缀，可作为普通用户内容返回。 */
  flush(): string {
    const remaining = this.pending;
    this.pending = '';
    return remaining;
  }
}

/** 带键名的凭据赋值，覆盖命令行 `--token=x`、HTTP 头与 env 风格；保留 Bearer 等认证方案名。 */
const CREDENTIAL_KEY_VALUE =
  /\b(authorization|proxy-authorization|x-auth[a-z0-9-]*|api[_-]?key|access[_-]?key|client[_-]?secret|token|password|passwd|secret)\b(\s*[:=]\s*)(?:(bearer|basic|token)\s+)?("[^"]*"|'[^']*'|[^\s,;"']+)/gi;
/** Bearer 后的定长随机串；过短的值不替换，避免误伤普通单词。 */
const CREDENTIAL_BEARER = /\b(bearer\s+)[a-z0-9._~+/=-]{8,}/gi;
/** 常见令牌前缀；只覆盖可识别格式，不承诺发现任意无标签随机串。 */
const CREDENTIAL_PREFIX =
  /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs]|AKIA)[_-][a-z0-9_-]{8,}\b/gi;
/** URL userinfo 中的口令；保留协议与主机，替换整个身份段。 */
const CREDENTIAL_URL_USERINFO = /(:\/\/)[^/\s:@]+:[^/\s@]+@/g;

/** 常见凭据形态的结构化替换；无标签秘密仍需调用方自行避免进入展示文本。 */
export function redactCommonSecrets(text: string): string {
  return text
    .replace(
      CREDENTIAL_KEY_VALUE,
      (_match, key: string, separator: string, scheme?: string) =>
        `${key}${separator}${scheme ? `${scheme} ` : ''}[REDACTED]`,
    )
    .replace(CREDENTIAL_BEARER, '$1[REDACTED]')
    .replace(CREDENTIAL_PREFIX, '[REDACTED]')
    .replace(CREDENTIAL_URL_USERINFO, '$1[REDACTED]@');
}

/** 精确替换已知凭证值；短于 4 字符的值不参与，避免把普通文本整体替换。 */
export function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of [...new Set(secrets)]
    .filter((secret) => secret.length >= 4)
    .sort((a, b) => b.length - a.length))
    output = output.split(secret).join('[REDACTED]');
  return output;
}

/** 所有文本出口统一走这里：先替换可识别凭据，再替换当前配置的模型密钥。 */
export function redactText(text: string, secrets: readonly string[]): string {
  return redactKnownSecrets(redactCommonSecrets(text), secrets);
}

/** 判定输入是否触碰敏感词；命中时审批直接拒绝，不把打码后的值当作可授权目标。 */
export function containsSensitiveMarker(text: string): boolean {
  return /\b(?:authorization|proxy-authorization|bearer|x-auth[a-z0-9-]*|api[_-]?key|access[_-]?key|client[_-]?secret|token|password|passwd|secret)\b/i.test(
    text,
  );
}

/** 单行化并限制长度；控制字符替换为空格，防止伪造多行展示或超长提示。 */
export function sanitizeDisplayText(value: string, maximum = 2_000): string | undefined {
  const cleaned = value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length <= maximum ? cleaned : `${cleaned.slice(0, Math.max(0, maximum - 1))}…`;
}
