import { sanitizeModelErrorMessage } from '@kiturone/kapibala';
import { main } from './index.js';

main().catch((err) => {
  const label = process.stderr.isTTY ? '\x1b[31mFatal Error:\x1b[0m' : 'Fatal Error:';
  console.error(label, sanitizeModelErrorMessage(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
