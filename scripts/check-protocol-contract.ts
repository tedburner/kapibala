import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMITS,
  EVENT_PAYLOAD_SCHEMAS,
  PROTOCOL_VERSION,
  REQUEST_SCHEMAS,
  RESULT_SCHEMAS,
  RESULT_SELECTORS,
  SERVER_CAPABILITIES,
  WIRE_ERROR_CODES,
  type WireMethod,
} from '../packages/cli/src/protocol/index.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const contractPath = path.join(
  repositoryRoot,
  'scripts/fixtures/protocol',
  `v${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}/contract.json`,
);

/** wire 契约的固定快照；类型由 typecheck 保证，这里冻结运行时可观察目录。 */
export interface ProtocolContract {
  readonly schemaVersion: 1;
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly capabilities: readonly string[];
  readonly limits: Readonly<Record<string, number>>;
  readonly errors: readonly string[];
  readonly methods: readonly string[];
  readonly requests: unknown;
  readonly results: unknown;
  readonly resultSelections: Readonly<Record<string, readonly string[]>>;
  readonly events: unknown;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/**
 * 汇总协议版本、能力、预算、错误码和三个 Schema 目录。
 * 结果选择器以方法为键记录实际变体，避免把 cursor 相关形状隐藏在函数实现里。
 */
export function collectProtocolContract(): ProtocolContract {
  const methods = Object.keys(REQUEST_SCHEMAS).sort() as WireMethod[];
  const resultSelections = Object.fromEntries(
    methods.map((method) => [
      method,
      method === 'session/snapshot'
        ? ['snapshot:first', 'snapshot:page']
        : [String(RESULT_SELECTORS[method]({} as never))],
    ]),
  );
  return canonicalJson({
    schemaVersion: 1,
    protocol: PROTOCOL_VERSION,
    capabilities: SERVER_CAPABILITIES,
    limits: DEFAULT_LIMITS,
    errors: WIRE_ERROR_CODES,
    methods,
    requests: REQUEST_SCHEMAS,
    results: RESULT_SCHEMAS,
    resultSelections,
    events: EVENT_PAYLOAD_SCHEMAS,
  }) as ProtocolContract;
}

function firstDifference(expected: unknown, actual: unknown, at = '$'): string | undefined {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return undefined;
  if (
    expected &&
    actual &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const left = expected as Record<string, unknown>;
    const right = actual as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!(key in left)) return `${at}.${key} is unexpected`;
      if (!(key in right)) return `${at}.${key} is missing`;
      const nested = firstDifference(left[key], right[key], `${at}.${key}`);
      if (nested) return nested;
    }
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length)
      return `${at} length changed from ${expected.length} to ${actual.length}`;
    for (let index = 0; index < expected.length; index += 1) {
      const nested = firstDifference(expected[index], actual[index], `${at}[${index}]`);
      if (nested) return nested;
    }
  }
  return `${at} changed`;
}

function main(): void {
  const update = process.argv.includes('--update');
  const current = `${JSON.stringify(collectProtocolContract(), null, 2)}\n`;
  if (update) {
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    fs.writeFileSync(contractPath, current);
    console.log(`Updated ${path.relative(repositoryRoot, contractPath)}`);
    return;
  }
  if (!fs.existsSync(contractPath))
    throw new Error(`Missing protocol contract: ${path.relative(repositoryRoot, contractPath)}`);
  const expected: unknown = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const actual: unknown = JSON.parse(current);
  const difference = firstDifference(expected, actual);
  if (difference) {
    console.error(`Protocol contract changed at ${difference}.`);
    console.error(
      'Run `tsx scripts/check-protocol-contract.ts --update` after reviewing the wire impact.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Protocol v${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor} contract is frozen.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
