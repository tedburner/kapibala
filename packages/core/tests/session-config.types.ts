import type { SessionConfig } from '../src/context/session/index.js';
import type { ModelProfile, ModelProvider } from '../src/models/index.js';

declare const model: { defaultProfile: ModelProfile; defaultProvider: ModelProvider };
const explicit: SessionConfig = { ...model, workspaceRoot: '/workspace' };
const legacy: SessionConfig = { ...model, rootDir: '/workspace' };
const both: SessionConfig = { ...model, workspaceRoot: '/workspace', rootDir: '/workspace' };
// @ts-expect-error 工作区身份不能在类型层隐式缺省。
const missing: SessionConfig = { ...model };
// @ts-expect-error 根字段为联合 type，interface 不能再直接 extends。
interface ExtendedConfig extends SessionConfig {
  tenant: string;
}
/** 迁移写法：交集 type 保留根字段联合与非根选项。 */
type ComposedConfig = SessionConfig & { tenant: string };
const composed: ComposedConfig = { ...model, workspaceRoot: '/workspace', tenant: 'acme' };
void [explicit, legacy, both, missing, composed];
type _ConfigSurface = [ExtendedConfig, ComposedConfig];
void (null as unknown as _ConfigSurface);
