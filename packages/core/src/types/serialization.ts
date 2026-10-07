/** 对对象 key 确定性排序，保证摘要、工具 schema 与 fingerprint 不受插入顺序影响。 */
export function stableSerialize(value: unknown): string {
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, val]) => val !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, visit(val)]),
      );
    return v;
  };
  return JSON.stringify(visit(value));
}
