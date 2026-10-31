import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const stateSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).default('light'),
    recent: z
      .array(z.object({ id: z.string(), name: z.string(), root: z.string() }).strict())
      .max(20)
      .default([]),
    width: z.number().int().min(800).max(10_000).default(1280),
    height: z.number().int().min(600).max(10_000).default(800),
  })
  .strict();
/** Main 独占的桌面偏好；不存放消息、模型密钥、权限模式或 Host 资源 ID。 */
export class Preferences {
  private state: z.infer<typeof stateSchema>;
  private readonly file: string;
  constructor(userData: string) {
    this.file = path.join(userData, 'desktop-state.json');
    try {
      if (fs.statSync(this.file).size > 1024 * 1024) throw new Error('State too large');
      this.state = stateSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      this.state = stateSchema.parse({});
    }
  }
  /** 返回独立副本，窗口或页面不能通过引用替换持久状态。 */
  read(): z.infer<typeof stateSchema> {
    return structuredClone(this.state);
  }
  /** 只提交已校验的主题偏好；system 保存用户选择，不保存当前系统计算值。 */
  theme(theme: 'light' | 'dark' | 'system'): void {
    this.save({ ...this.state, theme });
  }
  /** 只接受 Main 已确认的项目路径，最多保留 20 项，不持久化 workspaceId。 */
  recent(root: string, name: string): void {
    const known = this.state.recent.find((item) => item.root === root);
    this.save({
      ...this.state,
      recent: [
        { id: known?.id ?? randomUUID(), root, name },
        ...this.state.recent.filter((item) => item.root !== root),
      ].slice(0, 20),
    });
  }
  /** 只由真实窗口 resize 回调更新，页面没有任意状态替换接口。 */
  bounds(width: number, height: number): void {
    // 上下限都与 stateSchema 对齐：BrowserWindow 没有设上限，宽幅多显示器可拉出超过
    // schema.max 的尺寸，若只夹下限，save 的 parse 会抛 ZodError 并在 resize 防抖回调里反复触发。
    this.save({
      ...this.state,
      width: Math.min(10_000, Math.max(800, width)),
      height: Math.min(10_000, Math.max(600, height)),
    });
  }
  private save(state: z.infer<typeof stateSchema>): void {
    state = stateSchema.parse(state);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    this.state = state;
  }
}
