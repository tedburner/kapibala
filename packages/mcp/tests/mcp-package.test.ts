import { describe, expect, it } from 'vitest';
import { MCP_PACKAGE_VERSION } from '../src/index.js';

describe('@kiturone/kapibala-mcp package foundation', () => {
  it('exports MCP_PACKAGE_VERSION matching semver format', () => {
    expect(MCP_PACKAGE_VERSION).toBeDefined();
    expect(MCP_PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exports lifecycle, state machine, stdio, and plugin factory from root', async () => {
    const pkg = await import('../src/index.js');
    expect(pkg.createMcpPlugin).toBeTypeOf('function');
    expect(pkg.McpServerManager).toBeTypeOf('function');
    expect(pkg.McpClientSession).toBeTypeOf('function');
    expect(pkg.createManagedStdioTransport).toBeTypeOf('function');
    expect(pkg.BoundedStderrBuffer).toBeTypeOf('function');
    expect(pkg.killProcessTree).toBeTypeOf('function');
    expect(pkg.isProcessAlive).toBeTypeOf('function');
    expect(pkg.isStdioConfig).toBeTypeOf('function');
    expect(pkg.isHttpConfig).toBeTypeOf('function');
  });
});
