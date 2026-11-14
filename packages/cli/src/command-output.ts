/** 命令原始片段的目标流；错误流与普通结果流不能在接入界面时静默合并。 */
export type CommandOutputStream = 'stdout' | 'stderr';

/**
 * 命令层唯一结果输出端口；宿主决定写文本流还是展示通知、列表或诊断面板。
 * 只传可公开的结果文字，不传秘密输入；文本可含既有样式，图形/终端界面宿主须按自身策略处理控制字符。
 */
export interface CommandOutput {
  /** 输出普通结果的一行；文本适配保持 console.log 的换行语义。 */
  log(message: string): void;
  /** 输出诊断的一行；文本适配保持 console.error 的 stderr 与换行语义。 */
  error(message: string): void;
  /** 写入原始片段，不补换行；省略流时使用 stdout。 */
  write(text: string, stream?: CommandOutputStream): void;
}

const textOutput: CommandOutput = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  write: (text, stream = 'stdout') => {
    if (stream === 'stderr') process.stderr.write(text);
    else process.stdout.write(text);
  },
};

/**
 * 优先使用宿主注入的输出；未提供时维持既有文本命令的 console 与进程流行为。
 * 不替换全局对象，不捕获秘密输入，也不把输出端口当成执行或权限能力。
 */
export function resolveCommandOutput(context: { readonly output?: CommandOutput }): CommandOutput {
  return context.output ?? textOutput;
}
