import {
  APPROVAL_RESPONSE_SCHEMA,
  EVENT_PAYLOAD_SCHEMAS,
  REQUEST_SCHEMAS,
  type WireSchema,
} from './schema.js';
import type {
  ValidationResult,
  WireError,
  WireEvent,
  WireMessage,
  WireMethod,
  WireRequest,
  WireResponse,
} from './types.js';

const has = (value: object, key: string): boolean => Object.hasOwn(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[cs]:[^\s]{1,254}$/.test(value);
const failure = <T>(code = -32600, message = 'Invalid message'): ValidationResult<T> => ({
  ok: false,
  error: { code, message },
});

/** 拒绝访问器、原型实例、循环、非有限数和过深输入，不运行用户 toJSON。 */
export function isJsonData(value: unknown): boolean {
  const ancestors = new Set<object>();
  let nodes = 0;
  const walk = (item: unknown, depth: number): boolean => {
    if (++nodes > 100_000 || depth > 64) return false;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) return false;
    if (Array.isArray(item) && Object.keys(descriptors).length !== item.length + 1) return false;
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = descriptors[key as string];
      if (!descriptor.enumerable || !has(descriptor, 'value') || !walk(descriptor.value, depth + 1))
        return false;
    }
    ancestors.delete(item);
    return true;
  };
  try {
    return walk(value, 0);
  } catch {
    return false;
  }
}

/** Schema 子集校验只用于已经确认为 JSON 的输入，避免 getter 与循环造成副作用。 */
export function matchesSchema(value: unknown, schema: WireSchema): boolean {
  if (schema.anyOf) return schema.anyOf.some((variant) => matchesSchema(value, variant));
  if (schema.enum && !schema.enum.some((entry) => entry === value)) return false;
  switch (schema.type) {
    case 'null':
      return value === null;
    case 'string':
      return (
        typeof value === 'string' &&
        value.length >= (schema.minLength ?? 0) &&
        value.length <= (schema.maxLength ?? Number.MAX_SAFE_INTEGER)
      );
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= (schema.minimum ?? 0) &&
        value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return (
        Array.isArray(value) &&
        value.length <= (schema.maxItems ?? 100_000) &&
        value.every((entry) => !schema.items || matchesSchema(entry, schema.items))
      );
    case 'object': {
      if (!record(value)) return false;
      const properties = schema.properties ?? {};
      return (
        (schema.required ?? []).every((key) => has(value, key)) &&
        Object.keys(value).every(
          (key) => has(properties, key) && matchesSchema(value[key], properties[key]),
        )
      );
    }
    default:
      return false;
  }
}

/** 完整验证请求后才收窄类型；错误消息不回显任何原始参数。 */
export function validateRequest(value: unknown): ValidationResult<WireRequest> {
  if (
    !isJsonData(value) ||
    !record(value) ||
    value.jsonrpc !== '2.0' ||
    !identifier(value.id) ||
    typeof value.method !== 'string' ||
    Object.keys(value).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key))
  )
    return failure();
  if (!has(REQUEST_SCHEMAS, value.method)) return failure(-32601, 'Unknown method');
  if ((value.method === 'approval/request') !== value.id.startsWith('s:')) return failure();
  const schema = REQUEST_SCHEMAS[value.method as WireMethod];
  if (!matchesSchema(value.params, schema)) return failure(-32602, 'Invalid parameters');
  return { ok: true, value: value as unknown as WireRequest };
}

/** 响应外壳与审批结果严格校验；其他成功结果由相应方法消费者继续校验。 */
export function validateResponse(
  value: unknown,
  method?: WireMethod,
): ValidationResult<WireResponse> {
  if (
    !isJsonData(value) ||
    !record(value) ||
    value.jsonrpc !== '2.0' ||
    (value.id !== null && !identifier(value.id))
  )
    return failure();
  if (
    has(value, 'result') === has(value, 'error') ||
    Object.keys(value).some((key) => !['jsonrpc', 'id', 'result', 'error'].includes(key))
  )
    return failure();
  if (has(value, 'result')) {
    if (
      value.id === null ||
      (method === 'approval/request' && !matchesSchema(value.result, APPROVAL_RESPONSE_SCHEMA))
    )
      return failure();
  } else {
    const error = value.error;
    if (
      !record(error) ||
      !Number.isSafeInteger(error.code) ||
      typeof error.message !== 'string' ||
      Object.keys(error).some((key) => !['code', 'message', 'data'].includes(key)) ||
      (has(error, 'data') &&
        (!record(error.data) ||
          typeof error.data.code !== 'string' ||
          Object.keys(error.data).length !== 1))
    )
      return failure();
  }
  return { ok: true, value: value as unknown as WireResponse };
}

/** 未知事件拒绝而非跳过，调用方不得因此推进已应用序号。 */
export function validateEvent(value: unknown): ValidationResult<WireEvent> {
  if (
    !isJsonData(value) ||
    !record(value) ||
    typeof value.type !== 'string' ||
    !has(EVENT_PAYLOAD_SCHEMAS, value.type)
  )
    return failure();
  for (const key of ['serverInstanceId', 'sessionId', 'streamEpoch']) {
    if (
      typeof value[key] !== 'string' ||
      !(value[key] as string).length ||
      (value[key] as string).length > 256
    )
      return failure();
  }
  if (
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    (has(value, 'runId') &&
      (typeof value.runId !== 'string' || !value.runId.length || value.runId.length > 256)) ||
    Object.keys(value).some(
      (key) =>
        ![
          'serverInstanceId',
          'sessionId',
          'streamEpoch',
          'seq',
          'runId',
          'type',
          'payload',
        ].includes(key),
    ) ||
    !matchesSchema(
      value.payload,
      EVENT_PAYLOAD_SCHEMAS[value.type as keyof typeof EVENT_PAYLOAD_SCHEMAS],
    )
  )
    return failure();
  return { ok: true, value: value as unknown as WireEvent };
}

/** 统一消息入口，不接受 batch、任意 notification 或 JSON 以外的数据。 */
export function validateMessage(value: unknown): ValidationResult<WireMessage> {
  if (!isJsonData(value) || !record(value)) return failure();
  if (value.method === 'session/event' && !has(value, 'id')) {
    if (value.jsonrpc !== '2.0' || Object.keys(value).length !== 3) return failure();
    const event = validateEvent(value.params);
    return event.ok
      ? { ok: true, value: { jsonrpc: '2.0', method: 'session/event', params: event.value } }
      : event;
  }
  return has(value, 'method') ? validateRequest(value) : validateResponse(value);
}

/** JSON.parse 错误不暴露输入；字节长度由传输层在解码前限制。 */
export function parseWireMessage(text: string): ValidationResult<WireMessage> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failure(-32700, 'Invalid JSON');
  }
  return validateMessage(value);
}
