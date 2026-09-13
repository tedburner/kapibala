import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.kapibala',
  '.turbo',
  '.tsup',
  '.workbuddy',
]);

const ALLOWED_PLACEHOLDERS = [
  'sk-***',
  'sk-xxx',
  'sk-...',
  'sk-your-key',
  'sk-placeholder',
  'sk-test',
  'sk-********************',
  'sk-xxxxxxxx',
];

// 常见大模型 API Key 正则特征 (例如 sk- 后面跟随超过 20 位字母数字下划线/横杠)
const SECRET_PATTERNS = [
  {
    name: 'OpenAI/DeepSeek API Key',
    regex: /sk-[a-zA-Z0-9_-]{20,}/g,
  },
  {
    name: 'Anthropic API Key',
    regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  },
  {
    name: 'Google Gemini API Key',
    regex: /AIza[0-9A-Za-z-_]{35}/g,
  },
];

function isPlaceholder(matched: string): boolean {
  return ALLOWED_PLACEHOLDERS.some(
    (p) =>
      matched.includes(p) ||
      p.includes(matched) ||
      matched.startsWith('sk-***') ||
      matched.startsWith('sk-xxx'),
  );
}

function scanDirectory(dir: string): { file: string; line: number; match: string; name: string }[] {
  const violations: { file: string; line: number; match: string; name: string }[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      violations.push(...scanDirectory(fullPath));
    } else if (entry.isFile()) {
      // 忽略图片和二进制文件
      const ext = path.extname(entry.name).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.lock'].includes(ext)) {
        continue;
      }

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          for (const pattern of SECRET_PATTERNS) {
            pattern.regex.lastIndex = 0;
            const matches = line.match(pattern.regex);
            if (matches) {
              for (const m of matches) {
                if (!isPlaceholder(m)) {
                  violations.push({
                    file: fullPath,
                    line: i + 1,
                    match: `${m.slice(0, 7)}***${m.slice(-4)}`,
                    name: pattern.name,
                  });
                }
              }
            }
          }
        }
      } catch {
        // 二进制读取失败跳过
      }
    }
  }

  return violations;
}

const rootDir = process.cwd();
const leaks = scanDirectory(rootDir);

if (leaks.length > 0) {
  console.error(
    '\n\x1b[31m⛔ [安全检查失败] 检测到疑似真实 API Key，严禁提交包含凭据的代码！\x1b[0m\n',
  );
  for (const leak of leaks) {
    console.error(`  ❌ 文件: ${leak.file}:${leak.line}`);
    console.error(`     类型: ${leak.name}`);
    console.error(`     脱敏内容: ${leak.match}\n`);
  }
  console.error(
    '请使用环境变量 (如 DEEPSEEK_API_KEY) 或占位符 (sk-placeholder / sk-***)，切勿在代码或配置文件中硬编码真实 Key。\n',
  );
  process.exit(1);
} else {
  console.log('\x1b[32m✔ [Security] 代码库安全扫描完成，未发现任何泄露的 API Key。\x1b[0m');
}
