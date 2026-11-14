import {
  APPROVAL_RESPONSE_SCHEMA,
  type EVENT_PAYLOAD_SCHEMAS,
  type REQUEST_SCHEMAS,
  type WireSchema,
} from './schema.js';
import type {
  EventPayloads,
  NegotiatedProtocol,
  PendingApproval,
  RequestParams,
  SessionControl,
  ValidationResult,
  WireEvent,
  WireMethod,
} from './types.js';
import { isJsonData, matchesSchema, validateEvent } from './validate.js';
import { DEFAULT_LIMITS } from './version.js';

/** 握手预算逐项为正整数，产品升级不能放宽客户端本地硬上限。 */
export type ProtocolLimits = { readonly [K in keyof typeof DEFAULT_LIMITS]: number };
/** 公开历史块只保留现有投影字段，不能携带 Provider 私有状态或工具原始参数。 */
export type PublicHistoryBlock = {
  kind: 'text' | 'thinking' | 'tool_result' | 'tool_use';
  text: string;
};
/** 可重建展示消息；不承担 canonical 存储或授权恢复职责。 */
export type PublicHistoryMessage = {
  id: string;
  role: string;
  state: string;
  blocks: PublicHistoryBlock[];
};
/** 快照身份和水位；观察者 controlEpoch 为空，空流 seq 为零。 */
export type SnapshotMetadata = {
  sessionId: string;
  streamEpoch: string;
  controlEpoch: string;
  serverInstanceId: string;
  seq: number;
  conversationId: string;
  runId: string | null;
  pendingApprovals: PendingApproval[];
  openSessions: number;
  maxOpenSessions: number;
};
/** 后续页只含字符串片段与游标，不能单独解析为完整正文。 */
export type SnapshotPage = { chunk: string; cursor: string | null };
/** 首块沿用 wire 1.0 的元数据加分块形状。 */
export type WireSnapshot = SnapshotMetadata & SnapshotPage;
/** 完整逻辑正文仍来自 canonical 公开投影及同水位的活动事件。 */
export type SnapshotBody = { history: PublicHistoryMessage[]; live: WireEvent[] };
/** Node 客户端完成重组后的结果；保留原有空 chunk 和 null cursor 以兼容正常调用。 */
export type ClientSnapshot = SnapshotMetadata & SnapshotBody & { chunk: ''; cursor: null };
/** 每个方法的成功结果；snapshot 的参数相关变体由 WireResult 进一步收窄。 */
export interface RequestResults {
  initialize: NegotiatedProtocol & {
    serverInstanceId: string;
    clientId: string;
    limits: ProtocolLimits;
  };
  ping: { alive: true; serverInstanceId: string };
  'session/list': { items: { conversationId: string; title: string }[]; cursor: string | null };
  'session/create': { sessionId: string; conversationId: string };
  'session/open': { sessionId: string; conversationId: string };
  'session/attach': WireSnapshot;
  'session/snapshot': WireSnapshot | SnapshotPage;
  'session/detach': { detached: true };
  'session/close': { closed: true };
  'run/start': { runId: string; accepted: true };
  'run/cancel': { cancellationRequested: true };
  'approval/request': { choice: import('./types.js').ApprovalChoice };
  'host/shutdown': { stopped: true };
}
/** 根据原请求参数区分首块与续块，不能只凭方法或响应形状判断。 */
export type WireResult<
  M extends WireMethod,
  P extends RequestParams[M] = RequestParams[M],
> = M extends 'session/snapshot' ? SnapshotResult<P, WireSnapshot> : RequestResults[M];
type SnapshotResult<P, First> = P extends { cursor: string }
  ? SnapshotPage
  : 'cursor' extends keyof P
    ? P extends { cursor?: undefined }
      ? First
      : First | SnapshotPage
    : First;
/** 首块由 Node 客户端重组，显式 cursor 只返回原始续块。 */
export type ClientResult<
  M extends WireMethod,
  P extends RequestParams[M],
> = M extends 'session/attach'
  ? ClientSnapshot
  : M extends 'session/snapshot'
    ? SnapshotResult<P, ClientSnapshot>
    : RequestResults[M];

const text = { type: 'string' } as const;
const id = { type: 'string', minLength: 1, maxLength: 256 } as const;
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const positive = { ...integer, minimum: 1 } as const;
const nil = { type: 'null' } as const;
const nullable = <const S extends WireSchema>(schema: S) => ({ anyOf: [schema, nil] as const });
const array = <const S extends WireSchema>(items: S) => ({
  type: 'array' as const,
  items,
  maxItems: 100_000,
});
const object = <const P extends Record<string, WireSchema>>(properties: P) => ({
  type: 'object' as const,
  properties,
  required: Object.keys(properties) as (keyof P)[],
  additionalProperties: false as const,
});
const yes = { type: 'boolean', enum: [true] } as const;
const pending = object({ approvalId: id, toolName: id, target: text, expiresAt: integer });
const metadata = {
  sessionId: id,
  streamEpoch: id,
  controlEpoch: { ...text, maxLength: 256 },
  serverInstanceId: id,
  seq: integer,
  conversationId: id,
  runId: nullable(id),
  pendingApprovals: array(pending),
  openSessions: positive,
  maxOpenSessions: positive,
} as const;
const page = { chunk: text, cursor: nullable(id) } as const;
const limits = object(
  Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, positive])) as {
    [K in keyof ProtocolLimits]: typeof positive;
  },
);

/** 结果变体目录保留现有 wire 字段，首块和续块不能互相代替。 */
export const RESULT_SCHEMAS = {
  initialize: object({
    major: integer,
    minor: integer,
    capabilities: array(id),
    serverInstanceId: id,
    clientId: id,
    limits,
  }),
  ping: object({ alive: yes, serverInstanceId: id }),
  'session/list': object({
    items: array(object({ conversationId: id, title: text })),
    cursor: nullable(id),
  }),
  'session/create': object({ sessionId: id, conversationId: id }),
  'session/open': object({ sessionId: id, conversationId: id }),
  'snapshot:first': object({ ...metadata, ...page }),
  'snapshot:page': object(page),
  'session/detach': object({ detached: yes }),
  'session/close': object({ closed: yes }),
  'run/start': object({ runId: id, accepted: yes }),
  'run/cancel': object({ cancellationRequested: yes }),
  'approval/request': APPROVAL_RESPONSE_SCHEMA,
  'host/shutdown': object({ stopped: yes }),
} as const satisfies Record<string, WireSchema>;
const fixed =
  <const K extends keyof typeof RESULT_SCHEMAS>(key: K) =>
  (_params: unknown) =>
    key;
/** 方法覆盖和 snapshot 变体选择的唯一目录；类型推导与运行校验共用它。 */
export const RESULT_SELECTORS = {
  initialize: fixed('initialize'),
  ping: fixed('ping'),
  'session/list': fixed('session/list'),
  'session/create': fixed('session/create'),
  'session/open': fixed('session/open'),
  'session/attach': fixed('snapshot:first'),
  'session/snapshot': (params: RequestParams['session/snapshot']) =>
    params.cursor === undefined ? ('snapshot:first' as const) : ('snapshot:page' as const),
  'session/detach': fixed('session/detach'),
  'session/close': fixed('session/close'),
  'run/start': fixed('run/start'),
  'run/cancel': fixed('run/cancel'),
  'approval/request': fixed('approval/request'),
  'host/shutdown': fixed('host/shutdown'),
} satisfies { [M in WireMethod]: (params: RequestParams[M]) => keyof typeof RESULT_SCHEMAS };

/** Schema 子集的结构类型；预算/身份等跨字段约束仍由运行校验负责。 */
export type InferWireSchema<S> = S extends { anyOf: readonly (infer V)[] }
  ? InferWireSchema<V>
  : S extends { enum: readonly (infer E)[] }
    ? E
    : S extends { type: 'string' }
      ? string
      : S extends { type: 'integer' }
        ? number
        : S extends { type: 'boolean' }
          ? boolean
          : S extends { type: 'null' }
            ? null
            : S extends { type: 'array'; items: infer I }
              ? InferWireSchema<I>[]
              : S extends { type: 'object'; properties: infer P; required: readonly (infer R)[] }
                ? { [K in keyof P as K extends R ? K : never]: InferWireSchema<P[K]> } & {
                    [K in keyof P as K extends R ? never : K]?: InferWireSchema<P[K]>;
                  }
                : never;
type Equivalent<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type RequireTrue<T extends true> = T;
type _ResultEquivalence = RequireTrue<
  false extends {
    [M in WireMethod]: Equivalent<
      InferWireSchema<(typeof RESULT_SCHEMAS)[ReturnType<(typeof RESULT_SELECTORS)[M]>]>,
      RequestResults[M]
    >;
  }[WireMethod]
    ? false
    : true
>;
type _EventEquivalence = RequireTrue<
  false extends {
    [E in keyof EventPayloads]: Equivalent<
      InferWireSchema<(typeof EVENT_PAYLOAD_SCHEMAS)[E]>,
      EventPayloads[E]
    >;
  }[keyof EventPayloads]
    ? false
    : true
>;
type _RequestEquivalence = RequireTrue<
  false extends {
    [M in WireMethod]: Equivalent<InferWireSchema<(typeof REQUEST_SCHEMAS)[M]>, RequestParams[M]>;
  }[WireMethod]
    ? false
    : true
>;

/** 先验证 JSON，再根据原请求选择结果；错误不回显对端数据。 */
export function validateMethodResult<M extends WireMethod, P extends RequestParams[M]>(
  method: M,
  params: P,
  value: unknown,
): ValidationResult<WireResult<M, P>> {
  const key = RESULT_SELECTORS[method](params as RequestParams['session/snapshot']);
  if (!isJsonData(value) || !matchesSchema(value, RESULT_SCHEMAS[key]))
    return { ok: false, error: { code: -32600, message: 'Invalid method result' } };
  return { ok: true, value: value as WireResult<M, P> };
}
const messageSchema = object({
  id,
  role: text,
  state: text,
  blocks: array(
    object({
      kind: { type: 'string', enum: ['text', 'thinking', 'tool_result', 'tool_use'] },
      text,
    }),
  ),
});
/** 只读取连续数组的自有数据属性；拒绝稀疏、额外属性和访问器，不执行对端代码。 */
function snapshotArray(
  value: unknown,
  check: (entry: unknown) => boolean,
  maxItems = Number.MAX_SAFE_INTEGER,
): boolean {
  if (!Array.isArray(value)) return false;
  const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
  if (length > maxItems || Reflect.ownKeys(value).length !== length + 1) return false;
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, index);
    if (!entry?.enumerable || !Object.hasOwn(entry, 'value') || !check(entry.value)) return false;
  }
  return true;
}

/**
 * 快照已按总字节预算重组，不能再套单帧节点数上限；按固定浅层 Schema 逐项校验。
 * 容器只读取属性描述符，叶子复用 Schema 校验，仍拒绝访问器、实例和非 JSON 值。
 */
function matchesSnapshotSchema(value: unknown, schema: WireSchema): boolean {
  if (schema.type === 'array')
    return snapshotArray(
      value,
      (entry) => !!schema.items && matchesSnapshotSchema(entry, schema.items),
      schema.maxItems ?? 100_000,
    );
  if (schema.type !== 'object') return matchesSchema(value, schema);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const properties = schema.properties ?? {};
  return (
    (schema.required ?? []).every((key) => Object.hasOwn(descriptors, key)) &&
    Reflect.ownKeys(descriptors).every((key) => {
      if (typeof key !== 'string' || !Object.hasOwn(properties, key)) return false;
      const field = descriptors[key];
      return (
        field.enumerable &&
        Object.hasOwn(field, 'value') &&
        matchesSnapshotSchema(field.value, properties[key])
      );
    })
  );
}

/** 正文按消息结构校验，不复用单帧节点预算；活动事件仍逐帧验证，字节总预算由客户端负责。 */
export function validateSnapshotBody(value: unknown): value is SnapshotBody {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(fields).length !== 2 ||
      !fields.history?.enumerable ||
      !Object.hasOwn(fields.history, 'value') ||
      !fields.live?.enumerable ||
      !Object.hasOwn(fields.live, 'value')
    )
      return false;
    return (
      snapshotArray(fields.history.value, (message) =>
        matchesSnapshotSchema(message, messageSchema),
      ) && snapshotArray(fields.live.value, (event) => validateEvent(event).ok)
    );
  } catch {
    return false;
  }
}
