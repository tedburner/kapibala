import { type ModelErrorInfo, sanitizeModelErrorMessage } from '@kiturone/kapibala';

const labels: Record<ModelErrorInfo['category'], string> = {
  authentication: '鉴权或权限失败',
  quota: '余额或配额不足',
  rate_limit: '请求限流',
  context: '上下文超限',
  service: '模型服务异常',
  network: '连接中断',
  timeout: '请求超时',
  invalid_request: '请求或协议不兼容',
  invalid_response: '响应不完整或格式异常',
  unknown: '原因未确认',
};
const retryLabels: Record<ModelErrorInfo['retryPolicy'], string> = {
  never: '不自动重试',
  immediate: '可手动重试',
  backoff: '可稍后手动重试',
  after_user_action: '处理原因后手动重试',
};

/** 展示跨协议模型错误的脱敏原因和操作建议；可重试不意味着自动执行工具。 */
export function formatModelError(info: ModelErrorInfo): string {
  const identifiers = [
    info.modelId && `模型: ${info.modelId}`,
    info.status !== undefined && `HTTP ${info.status}`,
    info.providerCode && `服务端码: ${info.providerCode}`,
    info.providerType && `类型: ${info.providerType}`,
    info.transportCode && `连接码: ${info.transportCode}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const title = sanitizeModelErrorMessage(
    `❌ ${info.operation === 'summary' ? '摘要模型' : '模型'}请求失败: ${labels[info.category]}`,
  );
  return [
    title,
    ...(identifiers ? [sanitizeModelErrorMessage(identifiers)] : []),
    `重试: ${retryLabels[info.retryPolicy]}`,
    `原因: ${sanitizeModelErrorMessage(info.message)}`,
    `建议: ${sanitizeModelErrorMessage(info.suggestion)}`,
    '',
  ].join('\n');
}

/** 返回底栏简短失败摘要，详细服务端消息保留在独立错误区，避免窄终端截断原因。 */
export function formatModelFailureSummary(info: ModelErrorInfo): string {
  return sanitizeModelErrorMessage(
    `失败: ${info.operation === 'summary' ? '摘要' : '主任务'}/${info.stage ?? 'request'}/${labels[info.category]} (${info.code}${info.status === undefined ? '' : `, HTTP ${info.status}`})`,
  );
}
