// 首个样式计算前只消费 Main 写入的枚举主题，不读取用户配置或执行任意页面值。
document.documentElement.dataset.mode = window.kapibala.initialTheme();
