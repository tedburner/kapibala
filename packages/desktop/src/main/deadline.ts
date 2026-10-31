/**
 * 退出清理的有界等待：清理确认在期限内完成则沿用原结果，
 * 超时以 SHUTDOWN_TIMEOUT 拒绝——超时只是「无法确认清理完成」，绝不能当作清理成功。
 * 定时器总被清除，不向事件循环泄漏；等待中的失败原因原样传播。
 */
export async function withShutdownDeadline(wait: Promise<void>, timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Shutdown deadline must be a positive safe integer');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('SHUTDOWN_TIMEOUT')), timeoutMs);
  });
  try {
    await Promise.race([wait, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
