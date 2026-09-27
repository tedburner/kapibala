import { randomBytes } from 'node:crypto';

let lastTime = 0;
let sequence = 0n;
const sequenceMask = (1n << 74n) - 1n;

/** 生成进程内单调递增的 UUIDv7；时钟回拨时沿用逻辑时间，序列耗尽才推进时间。 */
export function createMessageId(): string {
  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    sequence = BigInt(`0x${randomBytes(10).toString('hex')}`) & sequenceMask;
  } else if (sequence === sequenceMask) {
    lastTime++;
    sequence = 0n;
  } else sequence++;
  const time = BigInt(lastTime).toString(16).padStart(12, '0');
  const high = (sequence >> 62n).toString(16).padStart(3, '0');
  const low = ((sequence & ((1n << 62n) - 1n)) | (2n << 62n)).toString(16).padStart(16, '0');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${high}-${low.slice(0, 4)}-${low.slice(4)}`;
}
