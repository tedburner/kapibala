/**
 * Error Taxonomy for Kapibala Agent Harness
 */

export class KapibalaError extends Error {
  readonly code: string;
  readonly retryPolicy: 'never' | 'immediate' | 'backoff' | 'after_user_action';
  readonly safeMessage: string;

  constructor(
    message: string,
    options?: {
      code?: string;
      retryPolicy?: 'never' | 'immediate' | 'backoff' | 'after_user_action';
      safeMessage?: string;
    },
  ) {
    super(message);
    this.name = 'KapibalaError';
    this.code = options?.code ?? 'INTERNAL_ERROR';
    this.retryPolicy = options?.retryPolicy ?? 'never';
    this.safeMessage = options?.safeMessage ?? 'Operation failed';
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
    super(message, {
      code: 'TOOL_ERROR',
      retryPolicy: 'never',
      safeMessage: 'Tool execution failed',
    });
    this.name = 'ToolError';
  }
}

export class ToolNotFound extends KapibalaError {
  readonly toolName: string;
  readonly availableTools: string[];

  constructor(toolName: string, availableTools: string[] = []) {
    super(`Tool '${toolName}' not found. Available tools: ${availableTools.join(', ') || 'none'}`, {
      code: 'TOOL_NOT_FOUND',
      retryPolicy: 'never',
      safeMessage: 'Requested tool is unavailable',
    });
    this.name = 'ToolNotFound';
    this.toolName = toolName;
    this.availableTools = availableTools;
  }
}

export class AbortError extends KapibalaError {
  constructor(message = 'Execution aborted by user') {
    super(message, {
      code: 'ABORTED',
      retryPolicy: 'after_user_action',
      safeMessage: 'Operation cancelled',
    });
    this.name = 'AbortError';
  }
}

export class FatalError extends KapibalaError {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

export class SessionBusyError extends KapibalaError {
  constructor(operation: string) {
    super(`Session is already running; cannot ${operation}`);
    this.name = 'SessionBusyError';
  }
}
