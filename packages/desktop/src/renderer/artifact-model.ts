import type { ViewArtifact, ViewMessage } from '@kiturone/kapibala-host/view-model';
import { IMAGE_PREVIEW_LIMIT } from '../shared/preview.js';

/** 已识别产物；key 由会话、调用与路径组成，用作自动预览的去重基线。 */
export interface DetectedArtifact {
  readonly key: string;
  readonly callId: string;
  readonly artifact: ViewArtifact;
}

/** 文件名只取最后一段，Windows 与 POSIX 分隔符都按目录边界处理。 */
export function artifactFileName(value: string): string {
  return value.split(/[\\/]/).pop() || value;
}

/**
 * 是否超过图片预览通道上限。
 *
 * 判定与主进程读取共用 `IMAGE_PREVIEW_LIMIT`；超限的产物仍保留在投影里，
 * 但面板只展示文件名与提示，不发起必然失败的读取。
 */
export function isArtifactTooLarge(size: number | undefined): boolean {
  return size !== undefined && size > IMAGE_PREVIEW_LIMIT;
}

/**
 * 从当前投影消息中收集已成功工具调用的产物。
 *
 * 只认 `succeeded` 终态：失败与中断的工具即使宿主保留了旧投影也不触发自动预览。
 * 顺序保持消息与块的原顺序，同一 key 只保留首次出现，供「基线之外首个新产物」选择。
 */
export function collectViewArtifacts(
  messages: readonly ViewMessage[],
  scope: string,
): DetectedArtifact[] {
  const found = new Map<string, DetectedArtifact>();
  for (const message of messages) {
    for (const block of message.blocks) {
      const tool = block.tool;
      if (!tool || tool.status !== 'succeeded') continue;
      for (const artifact of tool.artifacts ?? []) {
        const key = `${scope}|${tool.callId}|${artifact.path}`;
        if (!found.has(key)) found.set(key, { key, callId: tool.callId, artifact });
      }
    }
  }
  return [...found.values()];
}
