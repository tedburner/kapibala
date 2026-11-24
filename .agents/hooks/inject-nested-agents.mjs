#!/usr/bin/env node
/**
 * Antigravity PreInvocation 钩子：当工具访问子目录文件时，按需一次性注入该目录链上的嵌套 AGENTS.md。
 *
 * 前置约束：由 `.agents/hooks.json` 在 `PreInvocation` 阶段拉起，工作目录为 `.agents/`，stdin 为驼峰 JSON。
 * 失败边界：transcript 尚未落盘、JSON 非法或无新增匹配目录时静默输出 `{}` 并以 0 退出，绝不阻断主循环。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HOOK_DIR, '..', '..');

function normalizeSlashes(p) {
  return p.replace(/\\+/g, '/').replace(/\/+$/, '');
}

function collectCandidateRelDirs(rawText, repoRootNorm) {
  const dirs = new Set();
  const unescaped = rawText.replace(/[\\/]+/g, '/');
  const escapedRoot = repoRootNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const absRegex = new RegExp(`${escapedRoot}/([A-Za-z0-9_./-]+)`, 'gi');
  for (const match of unescaped.matchAll(absRegex)) {
    const rel = match[1].replace(/^\/+|["',;\s]+$/g, '');
    if (rel) dirs.add(rel);
  }
  const relRegex =
    /(?:^|["'\s:])((?:packages\/(?:core|host|desktop|cli|mcp)|scripts|assets)(?:\/[A-Za-z0-9_.-]+)*)/g;
  for (const match of unescaped.matchAll(relRegex)) {
    if (match[1]) dirs.add(match[1]);
  }
  return dirs;
}

function main() {
  let rawInput = '';
  try {
    rawInput = fs.readFileSync(0, 'utf8');
  } catch {
    process.stdout.write('{}\n');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(rawInput || '{}');
  } catch {
    process.stdout.write('{}\n');
    return;
  }

  const transcriptPath = payload.transcriptPath;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    process.stdout.write('{}\n');
    return;
  }

  let transcript = '';
  try {
    transcript = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    process.stdout.write('{}\n');
    return;
  }

  const alreadyInjected = new Set();
  for (const m of transcript.matchAll(/\[NESTED_AGENTS_INJECTED:([^\]]+)\]/g)) {
    alreadyInjected.add(m[1]);
  }

  const repoRootReal = normalizeSlashes(fs.realpathSync.native(REPO_ROOT));
  const touchedRelPaths = new Set();

  for (const line of transcript.split(/\r?\n/)) {
    if (!line.includes('"PLANNER_RESPONSE"') || !line.includes('"tool_calls"')) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (step.type !== 'PLANNER_RESPONSE' || !Array.isArray(step.tool_calls)) continue;
    for (const tc of step.tool_calls) {
      const name = String(tc?.name || '');
      if (
        !/^(read_file|view_file|edit_file|write_file|grep_search|find_by_name|list_dir)$/.test(name)
      ) {
        continue;
      }
      const args = tc.args ?? {};
      const pathValues = [
        args.Path,
        args.SearchPath,
        args.DirectoryPath,
        args.SearchDirectory,
      ].filter((v) => typeof v === 'string' && v.length > 0);
      for (const rawVal of pathValues) {
        for (const rel of collectCandidateRelDirs(rawVal, repoRootReal)) {
          if (path.posix.basename(rel).toLowerCase() === 'agents.md') continue;
          touchedRelPaths.add(rel);
        }
      }
    }
  }

  const toInject = [];
  const queued = new Set();

  for (const relTarget of touchedRelPaths) {
    const absTarget = path.resolve(REPO_ROOT, relTarget);
    let current =
      fs.existsSync(absTarget) && fs.statSync(absTarget).isDirectory()
        ? absTarget
        : path.dirname(absTarget);

    const chain = [];
    while (
      normalizeSlashes(current).toLowerCase().startsWith(`${repoRootReal.toLowerCase()}/`) &&
      normalizeSlashes(current).toLowerCase() !== repoRootReal.toLowerCase()
    ) {
      const candidate = path.join(current, 'AGENTS.md');
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const relGuide = normalizeSlashes(path.relative(REPO_ROOT, candidate));
        chain.unshift({ relGuide, candidate });
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    for (const { relGuide, candidate } of chain) {
      if (alreadyInjected.has(relGuide) || queued.has(relGuide)) continue;
      queued.add(relGuide);
      const body = fs.readFileSync(candidate, 'utf8').trim();
      toInject.push({
        systemMessage: {
          systemMessage: `[NESTED_AGENTS_INJECTED:${relGuide}]\nThe user accessed files under \`${path.posix.dirname(relGuide)}/\`. Follow these directory-scoped rules from \`${relGuide}\`:\n<RULE[${relGuide}]>\n${body}\n</RULE[${relGuide}]>`,
        },
      });
    }
  }

  if (toInject.length === 0) {
    process.stdout.write('{}\n');
    return;
  }
  process.stdout.write(`${JSON.stringify({ injectSteps: toInject })}\n`);
}

main();
