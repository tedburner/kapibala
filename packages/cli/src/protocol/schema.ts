/** 支持的 JSON Schema 子集；纯数据，可供外部客户端生成文档和边界校验。 */
export interface WireSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'boolean' | 'null';
  anyOf?: readonly WireSchema[];
  properties?: Readonly<Record<string, WireSchema>>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: WireSchema;
  enum?: readonly (string | number | boolean | null)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
}

const string = { type: 'string', minLength: 1, maxLength: 1_048_576 } as const;
const id = { ...string, maxLength: 256 } as const;
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const boolean = { type: 'boolean' } as const;
const enumeration = <const Values extends readonly string[]>(...values: Values) => ({
  type: 'string' as const,
  enum: values,
});
const object = <
  const P extends Record<string, WireSchema>,
  const O extends readonly (keyof P & string)[] = readonly [],
>(
  properties: P,
  optional?: O,
) => ({
  type: 'object' as const,
  properties,
  required: Object.keys(properties).filter((key) => !optional?.includes(key)) as Exclude<
    keyof P,
    O[number]
  >[],
  additionalProperties: false as const,
});
const control = { sessionId: id, streamEpoch: id, controlEpoch: id };
const empty = object({});

/** 初始化和方法参数 Schema 为协议单一白名单；额外参数不作隐式忽略。 */
export const REQUEST_SCHEMAS = {
  initialize: object(
    {
      major: integer,
      minMinor: integer,
      maxMinor: integer,
      clientName: id,
      capabilities: { type: 'array', items: id, maxItems: 64 },
      token: { ...id, maxLength: 512 },
    },
    ['token'],
  ),
  ping: empty,
  'session/list': object(
    { workspaceRoot: string, cursor: id, limit: { ...integer, minimum: 1, maximum: 50 } },
    ['cursor', 'limit'],
  ),
  'session/create': object({ workspaceRoot: string }),
  'session/open': object({ workspaceRoot: string, conversationId: id }),
  'session/attach': object(
    { sessionId: id, mode: enumeration('control', 'observe'), serverInstanceId: id },
    ['serverInstanceId'],
  ),
  'session/detach': object({ sessionId: id }),
  'session/close': object(control),
  'session/snapshot': object({ sessionId: id, cursor: id }, ['cursor']),
  'run/start': object({ ...control, clientOperationId: id, input: string }),
  'run/cancel': object({ ...control, runId: id }),
  'approval/request': object({
    ...control,
    approvalId: id,
    runId: id,
    toolName: id,
    target: string,
    sessionAllowed: boolean,
    expiresAt: integer,
  }),
  'host/shutdown': empty,
} as const satisfies Record<string, WireSchema>;

/** 审批响应拒绝额外字段，阻止客户端借回复改写实际工具参数。 */
export const APPROVAL_RESPONSE_SCHEMA = object({
  choice: enumeration('allow_once', 'allow_session', 'deny_once', 'deny_session', 'cancel'),
});

/** 只有公开、稳定的事件数据允许跨进程，Provider signature 等私有字段不在目录。 */
export const EVENT_PAYLOAD_SCHEMAS = {
  text_delta: object({ text: { type: 'string', maxLength: 1_048_576 } }),
  thinking_delta: object({ text: { type: 'string', maxLength: 1_048_576 }, blockId: id }, [
    'blockId',
  ]),
  tool_start: object({ toolId: id, toolName: id, target: string }),
  tool_progress: object({
    toolId: id,
    toolName: id,
    elapsedMs: integer,
    outputBytes: integer,
  }),
  tool_finish: object({
    toolId: id,
    result: { type: 'string', maxLength: 1_048_576 },
    isError: boolean,
    truncated: boolean,
  }),
  run_started: object({ clientOperationId: id }),
  run_settled: object({ outcome: enumeration('completed', 'failed', 'cancelled') }),
  approval_closed: object({ approvalId: id }),
  diagnostic: object({ code: id, message: string }),
} as const satisfies Record<string, WireSchema>;
