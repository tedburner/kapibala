import { main } from './index.js';

main().catch((err) => {
  console.error('\x1b[31mFatal Error:\x1b[0m', err);
  process.exit(1);
});
