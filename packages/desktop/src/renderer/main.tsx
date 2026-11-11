import { ShikiProvider } from '@cloudflare/kumo/code';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { HIGHLIGHT_LANGUAGES } from './display-budget.js';
import { FaultProbe, RendererErrorBoundary } from './error-boundary.js';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
// 平台标记在首帧前写入，驱动 macOS 红绿灯让位、拖拽区与字体回退，避免布局闪动。
document.documentElement.dataset.platform = navigator.userAgent.includes('Mac OS X')
  ? 'darwin'
  : navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'linux';
createRoot(root, {
  // 边界之外的未捕获渲染错误（如边界自身故障）至少保留结构化报告，不静默白屏。
  onUncaughtError(error) {
    console.error('[kapibala] 渲染层未捕获异常', error);
  },
}).render(
  <RendererErrorBoundary>
    <ShikiProvider
      engine="javascript"
      languages={[...HIGHLIGHT_LANGUAGES]}
      labels={{ copy: '复制代码', copied: '已复制' }}
    >
      <FaultProbe />
      <App />
    </ShikiProvider>
  </RendererErrorBoundary>,
);
