import { describe, expect, it } from 'vitest';
import {
  buildStdioProcessEnv,
  detectCredentialAlerts,
  interpolateEnvString,
  isSensitiveEnvVarName,
  resolveHttpHeaders,
} from '../src/env.js';

describe('MCP Environment Isolation, Interpolation & Credential Alert (Task 3.4)', () => {
  // =========================================================================
  // 环境变量插值
  // =========================================================================
  describe('interpolateEnvString', () => {
    it('interpolates standard ${NAME} variables correctly', () => {
      const mockEnv = {
        REPO_NAME: 'kapibala',
        PORT: '3000',
      };
      const result = interpolateEnvString('Server for ${REPO_NAME} on ${PORT}', mockEnv);
      expect(result.value).toBe('Server for kapibala on 3000');
      expect(result.missingVars).toHaveLength(0);
      expect(result.referencedVars).toEqual(['REPO_NAME', 'PORT']);
    });

    it('refuses to use empty string fallback when referenced variable is missing', () => {
      const mockEnv = {
        PRESENT_VAR: 'exists',
      };
      const result = interpolateEnvString('prefix/${PRESENT_VAR}/${MISSING_VAR}', mockEnv);
      expect(result.value).toBeUndefined(); // 缺变量严格拒绝
      expect(result.missingVars).toEqual(['MISSING_VAR']);
    });

    it('does NOT execute command substitutions or template injection', () => {
      const mockEnv = {
        SAFE_NAME: 'test',
      };
      const input = 'hello $(whoami) `id` !cat ${SAFE_NAME}';
      const result = interpolateEnvString(input, mockEnv);
      expect(result.value).toBe('hello $(whoami) `id` !cat test');
      expect(result.referencedVars).toEqual(['SAFE_NAME']);
    });
  });

  // =========================================================================
  // 敏感环境变量模式识别与 Credential Alert
  // =========================================================================
  describe('Sensitive environment variables & Credential Alert', () => {
    it('identifies sensitive credential variable names', () => {
      expect(isSensitiveEnvVarName('OPENAI_API_KEY')).toBe(true);
      expect(isSensitiveEnvVarName('ANTHROPIC_AUTH_TOKEN')).toBe(true);
      expect(isSensitiveEnvVarName('GITHUB_TOKEN')).toBe(true);
      expect(isSensitiveEnvVarName('AWS_SECRET_ACCESS_KEY')).toBe(true);
      expect(isSensitiveEnvVarName('DB_PASSWORD')).toBe(true);
      expect(isSensitiveEnvVarName('SERVICE_SECRET')).toBe(true);

      // 非敏感普通变量
      expect(isSensitiveEnvVarName('PATH')).toBe(false);
      expect(isSensitiveEnvVarName('NODE_ENV')).toBe(false);
      expect(isSensitiveEnvVarName('PORT')).toBe(false);
      expect(isSensitiveEnvVarName('APP_DATA_DIR')).toBe(false);
    });

    it('triggers Credential Alert when project-level config references sensitive host variables', () => {
      const referenced = ['PORT', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'PATH'];
      const alert = detectCredentialAlerts(referenced, 'project');

      expect(alert.hasAlert).toBe(true);
      expect(alert.sensitiveVars).toEqual(['OPENAI_API_KEY', 'GITHUB_TOKEN']);
    });

    it('does NOT trigger Credential Alert for global-level config or non-sensitive vars', () => {
      const referenced = ['OPENAI_API_KEY', 'GITHUB_TOKEN'];
      const globalAlert = detectCredentialAlerts(referenced, 'global');
      expect(globalAlert.hasAlert).toBe(false);
      expect(globalAlert.sensitiveVars).toHaveLength(0);

      const harmlessProjectAlert = detectCredentialAlerts(['PORT', 'DEBUG'], 'project');
      expect(harmlessProjectAlert.hasAlert).toBe(false);
      expect(harmlessProjectAlert.sensitiveVars).toHaveLength(0);
    });
  });

  // =========================================================================
  // Stdio 环境变量隔离与基础白名单继承
  // =========================================================================
  describe('buildStdioProcessEnv', () => {
    it('inherits platform base whitelist and excludes unconfigured host secrets', () => {
      const mockHostEnv = {
        PATH: 'C:\\Windows\\System32;/usr/bin',
        TEMP: 'C:\\Temp',
        HOME: '/home/user',
        SECRET_UNCONFIGURED_KEY: 'top_secret_token_12345',
        DATABASE_PASSWORD: 'super_secret_db_pass',
        OPENAI_API_KEY: 'mock-secret-host-key',
      };

      const result = buildStdioProcessEnv({
        configuredEnv: {
          SAFE_PARAM: 'literal_val',
        },
        hostEnv: mockHostEnv,
        source: 'project',
      });

      expect(result.error).toBeUndefined();
      expect(result.env).toBeDefined();

      // 验证显式配置的值正常注入
      expect(result.env?.SAFE_PARAM).toBe('literal_val');

      // 验证白名单基础变量被继承
      if (process.platform === 'win32') {
        expect(result.env?.PATH).toBe(mockHostEnv.PATH);
        expect(result.env?.TEMP).toBe(mockHostEnv.TEMP);
      } else {
        expect(result.env?.PATH).toBe(mockHostEnv.PATH);
        expect(result.env?.HOME).toBe(mockHostEnv.HOME);
      }

      // 关键断言：未在配置中显式声明的无关敏感凭据绝对不被继承泄露！
      expect(result.env?.SECRET_UNCONFIGURED_KEY).toBeUndefined();
      expect(result.env?.DATABASE_PASSWORD).toBeUndefined();
      expect(result.env?.OPENAI_API_KEY).toBeUndefined();
    });

    it('reports error and missingVars when configured env references absent host variable', () => {
      const mockHostEnv = {
        PATH: '/bin',
      };

      const result = buildStdioProcessEnv({
        configuredEnv: {
          AUTH: 'Bearer ${MY_REMOTE_KEY}',
        },
        hostEnv: mockHostEnv,
        source: 'project',
      });

      expect(result.env).toBeUndefined();
      expect(result.error).toMatch(/Missing required environment variables/i);
      expect(result.missingVars).toEqual(['MY_REMOTE_KEY']);
    });
  });

  // =========================================================================
  // HTTP Header 凭据解析
  // =========================================================================
  describe('resolveHttpHeaders', () => {
    it('interpolates headers and surfaces Credential Alert without exposing plain values in alerts', () => {
      const mockHostEnv = {
        AUTH_TOKEN: 'token_secret_xyz',
      };

      const result = resolveHttpHeaders(
        {
          Authorization: 'Bearer ${AUTH_TOKEN}',
          'Content-Type': 'application/json',
        },
        'project',
        mockHostEnv,
      );

      expect(result.error).toBeUndefined();
      expect(result.headers?.Authorization).toBe('Bearer token_secret_xyz');
      expect(result.headers?.['Content-Type']).toBe('application/json');

      // 告警仅包含变量名，不包含真实值
      expect(result.credentialAlert.hasAlert).toBe(true);
      expect(result.credentialAlert.sensitiveVars).toEqual(['AUTH_TOKEN']);
    });
  });
});
