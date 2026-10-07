import os from 'node:os';
import type { InstructionSource } from '../instructions/index.js';
import type { Tool } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface PromptAssemblerOptions {
  /** 提供时才生成 L2 工具清单段；缺省表示本次运行不向模型展示任何工具。 */
  tools?: ToolRegistry;
  /** L3 环境段展示的工作区根目录；文件工具的沙箱边界与其保持一致。 */
  rootDir: string;
  agentName?: string;
  /** 宿主自定义提示词，插在环境段与 L4 指令之间；纯空白视为未提供。 */
  customInstructions?: string;
  /** L4 项目指令段的内容，来自 loadInstructions 快照；为空时整段省略。 */
  instructionSources?: readonly InstructionSource[];
  /** 覆盖 tools.list() 作为 L2 清单来源；通常传入按权限过滤后的可见工具。 */
  visibleTools?: readonly Tool[];
}

/**
 * 把行为规则（L1）、工具清单（L2）、环境（L3）与项目指令（L4）拼装为系统提示词。
 * 各段之间以 `\n\n---\n\n` 分隔；不提供的内容整段跳过，不做占位填充。
 */
export class PromptAssembler {
  private readonly tools?: ToolRegistry;
  private readonly rootDir: string;
  private readonly agentName: string;
  private readonly customInstructions?: string;
  private readonly instructionSources: readonly InstructionSource[];
  private readonly visibleTools?: readonly Tool[];

  constructor(options: PromptAssemblerOptions) {
    this.tools = options.tools;
    this.rootDir = options.rootDir;
    this.agentName = options.agentName ?? 'Kapibala';
    this.customInstructions = options.customInstructions;
    this.instructionSources = options.instructionSources ?? [];
    this.visibleTools = options.visibleTools;
  }

  /** 按固定层级拼装系统提示词；同一选项集总是产出相同文本，便于审计与缓存。 */
  assemble(): string {
    const sections: string[] = [];

    // L1: 行为层
    sections.push(this.getL1Behavior());

    // L2: 工具清单层
    if (this.tools) {
      sections.push(this.getL2Tools());
    }

    // L3: 环境层
    sections.push(this.getL3Environment());

    // 自定义提示词
    if (this.customInstructions?.trim()) {
      sections.push(this.customInstructions.trim());
    }

    if (this.instructionSources.length > 0) {
      sections.push(
        `# L4 Project Instructions\n${this.instructionSources
          .map((source, index) => `## ${index + 1}. ${source.path}\n${source.content}`)
          .join('\n\n')}`,
      );
    }

    return sections.filter(Boolean).join('\n\n---\n\n');
  }

  private getL1Behavior(): string {
    return `You are ${this.agentName}, an intelligent and dependable AI software engineering assistant.
Your goal is to solve tasks efficiently and accurately by reasoning step-by-step and calling available tools when needed.
Follow these key behavioral rules:
1. Ground your answers in reality by inspecting files before making assumptions.
2. When calling tools, ensure parameters conform strictly to the schema.
3. When the user provides an exact file path, read it directly instead of searching for it first.
4. Do not broaden a successful exact lookup with wildcard searches or duplicate read-only calls.
5. Stop calling tools once you have enough evidence to answer the user's request.
6. If a tool call fails, analyze the error before self-correcting. Do not repeat an identical failed tool call.
7. Keep answers concise, clear, and focused on user requirements. Do not add unrelated analysis unless requested.`;
  }

  private getL2Tools(): string {
    if (!this.tools) return '';
    const tools = this.visibleTools ?? this.tools.list();
    if (tools.length === 0) return '';

    const lines: string[] = ['# Available Tools:'];
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description}`);
    }
    return lines.join('\n');
  }

  private getL3Environment(): string {
    const platform = os.platform();
    return `# Environment Context:
- Current Working Directory (Workspace Root): ${this.rootDir}
- Operating System: ${platform}`;
  }
}
