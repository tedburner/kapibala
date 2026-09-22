#!/usr/bin/env node
/**
 * 薄壳转发：Headless Core 边界检测的真源在 packages/core/scripts/check-host-boundary.ts，
 * 由 core 包的 architecture-boundary 测试与本门禁共享同一份实现，避免 core 测试跨包
 * 引用仓库根目录破坏包封装。直接运行本文件或被检测文件本身都会执行同一入口。
 */
import { runCheckCoreBoundaryCli } from '../packages/core/scripts/check-host-boundary.js';

runCheckCoreBoundaryCli(process.argv[2]);
