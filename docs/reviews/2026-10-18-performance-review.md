# 性能专项审核与优化：1.0.17

基线：`b38f19c0838b259208a4248e353825de689d6e52`（1.0.16）。日期：2026-10-18。

本轮检查前端依赖加载、脚本体积、字体与样式、搜索/详情补充请求、演员分页、资源展开，以及 Worker 抓取调度、缓存和预算。落实三项有明确证据的优化：单文件生产入口、演员卡片增量渲染、资源连接空闲后续发。原始测量见 [JSON 记录](2026-10-18-performance-results.json)。

## 对照结果

浏览器使用相同 Chrome、固定 API 和字体隔离。移动配置为 390×844、300ms 延迟、96 KiB/s、6 倍 CPU 降速；桌面为 1280×900、40ms、1536 KiB/s、原生 CPU。加载指标取 3 次清除 HTTP 缓存后的中位数。静态服务器未压缩文件，gzip/Brotli 大小另用同一算法离线计算。

| 指标 | 1.0.16 | 1.0.17 | 变化 |
|---|---:|---:|---:|
| JavaScript 请求数 | 9 | 1 | 消除入口后的依赖发现瀑布 |
| JavaScript 原始字节 | 143,171 | 75,282 | -47.4% |
| JavaScript gzip 字节 | 33,347 | 22,990 | -31.1% |
| JavaScript Brotli 字节 | 27,315 | 19,806 | -27.5% |
| 移动模块就绪 / DOMContentLoaded | 3.05s | 1.86s | 约 -39% |
| 桌面模块就绪 / DOMContentLoaded | 301ms | 180ms | 约 -40% |
| 加载到 288 张作品卡片的累计新建数 | 1,296 | 288 | -77.8% |
| 同一分页过程移除旧卡片数 | 1,008 | 0 | 消除重复 DOM 替换 |
| 移动分页完成并绘制的实验耗时中位数 | 117ms | 35ms | 7 次分页，含调试器等待 |
| 12 页资源聚合（固定慢上游） | 1.211s | 0.639s | 约 -47% |

资源模型共 12 页，第 1/7 页各 600ms，其余页 30ms；优化前后都完成 12 页、返回同样顺序的 12 个分享，峰值并发均不超过 6。它测量调度收益，不代表每个真实资源站都能达到相同比例。

## Web Vitals 与交互观察

| 观察项 | 基线 | 优化后 | 解读 |
|---|---:|---:|---|
| 移动 LCP 中位数 | 1.280s | 1.280s | 没有可重复的绘制收益 |
| 桌面 LCP 中位数 | 172ms | 180ms | 差异小于一帧，不计收益 |
| 移动 CLS | 0.00054 | 0.00054 | 布局偏移保持低水平 |
| 现场 INP | 未采集 | 未采集 | 单次实验点击不能代替用户分位数 |

实际浏览器输入的 Event Timing 在移动样本约 64ms，桌面样本为 48→64ms；样本数不足以稳定归因，没有计作交互指标收益。100 项资源展开也没有稳定改善，本轮保留其已有首屏 6 项策略。性能记录包含这些观察，没有只保存有利指标。

额外保留真实字体网络的单次移动检查：LCP 1.34s、模块就绪 1.92s、CLS 0.00122，观察到的字体请求均 200、没有加载失败。该环境下字体没有阻塞应用初始化，未改字体设计。上述实验均不是生产用户的 Web Vitals 分位数或 Lighthouse 得分；指标定义参见 [Web Vitals](https://web.dev/articles/vitals)。

## 实现与约束

1. **生产单文件入口**：使用已由 Wrangler 锁定的 esbuild 0.28.2，列为直接开发依赖，将 `js/main.js` 的依赖图合并压缩成 `assets/app.min.js`。源码继续按模块维护，目标为浏览器 ES2022，没有新增浏览器运行时依赖。[esbuild 官方构建说明](https://esbuild.github.io/api/#bundle)
2. **构建一致性**：`npm run build` 同时生成 CSS 和 JavaScript；CI 重建后检查两种产物无差异。页面入口带发布版本，版本契约测试与真实浏览器回归使用该压缩包；上线检查额外验证其内容与 JavaScript MIME 类型。
3. **增量演员分页**：仅为新增作品创建卡片、更新分组计数，保留旧图片状态和监听器。较晚出现的电视剧分组插入已有电影分组之前；筛选重置、失败重试和旧请求取消仍由原状态机处理。
4. **资源动态并发**：保留 6 个并发名额，读完一页后立即取下一页，所有 I/O 都在请求返回前等待完成。对同一已读页面集合，结果按选中来源顺序对账，网络完成次序不会决定密码或来源。总页数 12、WPZY 详情 6 页、分享 100 条、约 15 秒预算与 2 MiB 输出限制保持有界。

动态调度会较早启动后续页面；达到分享上限时，已经开始的请求仍会完成并参与冲突核对，实际请求数受完成时序影响。测试覆盖停止续发、未扫描页状态、乱序密码冲突和稳定输出，不承诺每种输入都减少请求数。最大并发与页面预算没有提高；平台连接约束见 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)。

## 验证

| 检查 | 结果 |
|---|---|
| `npm test` | 238/238，ESLint、CSS 与 JavaScript 构建通过 |
| `npm run test:coverage` | 238/238；Worker 行 95.89%、分支 86.01% |
| `npm run test:runtime` | 28 项通过，含真实 workerd 慢页续发、并发上限与确定排序 |
| `npm run test:browser:ci` | 38 条流程通过；移动/桌面，实际压缩包；验证旧卡片复用、后出现分组和筛选恢复 |
| `npm run deploy:worker:dry-run` | Wrangler 4.149.0 严格打包通过；gzip 30.09 KiB，生产绑定正确 |
| `npm audit --json` | 216 项锁定依赖，已知漏洞 0 |
| `git diff --check` | 通过 |

演员节点复用和资源续发均先加入行为回归、复现失败后修复。Node 覆盖率只统计实际执行的源码，不代表 DOM 或整个前端覆盖率。本轮没有使用子代理。

## 复测与发布

```bash
npm run build
PERF_OUTPUT=/tmp/mobile.json PERF_TRACE=/tmp/mobile-trace.json npm run test:performance
PERF_PROFILE=desktop PERF_OUTPUT=/tmp/desktop.json npm run test:performance
PERF_OUTPUT=/tmp/worker.json npm run test:performance:worker
```

历史对照可用 `git archive b38f19c index.html favicon.ico css js VERSION` 导出静态快照，设置 `SMOKE_SITE_ROOT` 后执行同一浏览器命令。Chrome JSON 追踪可导入 DevTools；固定 API 和临时浏览器不使用日常账号或生产凭据。

PR CI、Cloudflare 预览通过后，等待同一合并提交的 Workers Builds、GitHub Pages 与 main CI 成功，再执行严格线上烟测并确认实际生产入口运行。实际部署提交与线上提供方状态记录在对应 PR 的发布验收中。真实第三方时延、其他浏览器和现场用户分位数仍需后续实际数据验证。
