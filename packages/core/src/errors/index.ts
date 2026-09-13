/**
 * Error Taxonomy for Kapibala Agent Harness
 */

export class KapibalaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KapibalaError';
  }
}

export class ModelError extends KapibalaError {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options?: { status?: number; retryable?: boolean }) {
    super(message);
    this.name = 'ModelError';
    this.status = options?.status;
    this.retryable =
      options?.retryable ??
      (options?.status ? [429, 500, 502, 503, 504, 529].includes(options.status) : false);
  }
}

export class TransportError extends KapibalaError {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'TransportError';
    this.retryable = retryable;
  }
}

export class ToolError extends KapibalaError {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ToolNotFound extends KapibalaError {
  readonly toolName: string;
  readonly availableTools: string[];

  constructor(toolName: string, availableTools: string[] = []) {
    super(`Tool '${toolName}' not found. Available tools: ${availableTools.join(', ') || 'none'}`);
    this.name = 'ToolNotFound';
    this.toolName = toolName;
    this.availableTools = availableTools;
  }
}

export class AbortError extends KapibalaError {
  constructor(message = 'Execution aborted by user') {
    super(message);
    this.name = 'AbortError';
  }
}

export class FatalError extends KapibalaError {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}
