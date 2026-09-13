import os from 'node:os';
import type { ToolRegistry } from '../tools/registry.js';

export interface PromptAssemblerOptions {
  tools?: ToolRegistry;
  rootDir: string;
  agentName?: string;
  customInstructions?: string;
}

export class PromptAssembler {
  private readonly tools?: ToolRegistry;
  private readonly rootDir: string;
  private readonly agentName: string;
  private readonly customInstructions?: string;

  constructor(options: PromptAssemblerOptions) {
    this.tools = options.tools;
    this.rootDir = options.rootDir;
    this.agentName = options.agentName ?? 'Kapibala';
    this.customInstructions = options.customInstructions;
  }

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

    return sections.filter(Boolean).join('\n\n---\n\n');
  }

  private getL1Behavior(): string {
    return `You are ${this.agentName}, an intelligent and dependable AI software engineering assistant.
Your goal is to solve tasks efficiently and accurately by reasoning step-by-step and calling available tools when needed.
Follow these key behavioral rules:
1. Ground your answers in reality by inspecting files before making assumptions.
2. When calling tools, ensure parameters conform strictly to the schema.
3. If a tool call fails or produces an error, analyze the error message and attempt self-correction.
4. Keep answers concise, clear, and focused on user requirements.`;
  }

  private getL2Tools(): string {
    if (!this.tools) return '';
    const tools = this.tools.list();
    if (tools.length === 0) return '';

    const lines: string[] = ['# Available Tools:'];
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description}`);
    }
    return lines.join('\n');
  }

  private getL3Environment(): string {
    const now = new Date().toISOString();
    const platform = os.platform();
    return `# Environment Context:
- Current Working Directory (Workspace Root): ${this.rootDir}
- Operating System: ${platform}
- Current Date/Time: ${now}`;
  }
}
