# 项目代码审查 — 2026-10-08

本轮确认并修复了 5 处问题，涉及失败恢复、作品身份和上游缓存校验。新增回归测试先复现了 Worker 的 3 处失败及浏览器资源链接丢失，再验证修复。修复归入 v1.0.12，记入 `CHANGELOG.md`；本记录说明代码审查阶段的结果，线上发布另以部署后验证为准。

## 范围与基线

- 基线提交：`73d9ef7`（main，v1.0.11）；开始审查时工作区干净。
- 阅读前端全部 JavaScript 模块、Worker 全部路由及共享基础设施，并核查 HTML/CSS、Wrangler 配置、CI 工作流和关键回归测试。
- 重点检查搜索匹配、演员分页与候选选择、分享链接恢复、渐进详情、资源重试、密码归属、上游读取限制、缓存、CORS、限流、凭据隔离和错误信息脱敏。
- 基线 `npm test`：184 个测试、lint 和构建通过。本次验证环境为 Node.js v26.10.0；没有在本机重复 CI 的 Node.js 22/24 矩阵。

## 已修复问题

| 优先级 | 问题与影响 | 修复 | 回归证据 |
|---|---|---|---|
| P2 | 部分资源补全时清空已有列表；补全失败后链接和密码按钮消失，展开状态也丢失 | 请求期间保留结果，等待请求结束再启用补全按钮；失败只更新状态，保留列表与再次重试入口 | 浏览器 `resource-retry-preserves-links`：8 条展开链接、密码复制、等待状态、失败保留和再次成功恢复 |
| P2 | 已选同名演员或演员分享链接加载失败后，重试重新按姓名搜索，丢失人物 ID | 保存所选人物的恢复动作，继续请求相同 ID，并保留原来的历史导航模式；新搜索/首页重置清理旧恢复动作 | 浏览器 `selected-actor-retry`、`shared-actor-retry`：重试仅发出一次精确 ID 请求 |
| P2 | 分享链接的非法或空 `type` 被降级为未指定，可能打开其他媒体命名空间中的同 ID 条目 | 请求前拒绝非法显式类型；合法类型去除首尾空白并转为小写；缺省类型仍兼容原有链接 | 浏览器 `shared-type-validation`：`book`/空类型零 API 请求，`MOVIE` 正常归一化 |
| P2 | TMDB 人物详情缺少或错误返回 `combined_credits.cast` 时，被视为空作品列表并缓存一天 | 根据请求的附加字段验证 cast 数组；不完整上游返回 502 且不缓存；不完整旧缓存删除并重取；合法空数组仍支持 | Node 回归验证缺失、null、数组/对象类型错误、有效空列表和旧缓存修复；真实 workerd 验证上游恢复 |
| P2 | Wikipedia 同名旧版的年份仅在简介首句中时漏过校验；带英文句点的片名还会截断首句 | 同时核对标题/描述与中文首句提供的年份，保留片名中的英文句点；使用 Wiki v3 Worker 缓存和带发布版本的客户端 URL | Node 回归覆盖不同描述与 `Mr. Bean` 片名；真实 workerd 验证错误年份不污染缓存且随后可恢复 |

实现集中在 [main.js](../../js/main.js)、[api.js](../../js/api.js) 和 [_worker.js](../../worker/_worker.js)。回归位于 [review-regressions.test.js](../../tests/review-regressions.test.js)、[api.test.js](../../tests/api.test.js)、[browser-smoke.mjs](../../tests/browser-smoke.mjs) 和 [worker-runtime.mjs](../../tests/worker-runtime.mjs)。浏览器检查还要求全部流程无未捕获的应用异常。

## 最终验证

| 检查 | 结果 |
|---|---|
| `npm test` | 187/187 测试通过；ESLint 和 Tailwind 构建通过 |
| `npm run test:browser:ci` | 28 条流程通过；390×844 与 1280×900；无未捕获的应用异常 |
| `npm run test:runtime` | 真实 workerd 的 20 项检查通过，包含原生 Cache API、HTMLRewriter、限流及新增恢复场景 |
| `npm run deploy:worker:dry-run` | 严格生产打包通过；生产限流 bindings 和 ENVIRONMENT 配置识别正常 |
| `git diff --exit-code -- css/output.css` | 通过，生成样式一致 |
| `git diff --check` | 通过 |

同步更新 [API](../API.md)、[架构](../ARCHITECTURE.md)、[测试指南](../TESTING.md) 和 [变更记录](../../CHANGELOG.md)，纠正过期缓存命名空间及搜索调度描述。

## 验证边界

Worker 测试使用本地模拟上游和虚构密钥，浏览器测试使用隔离 Chrome 与模拟 API。代码审查阶段没有请求生产接口或部署线上服务，不能仅据这些测试判断可选数据源的真实可用性；发布验收需另行运行 `npm run test:live`。

Wikipedia 关联仍依赖标题、媒体类型和文本中的年份证据；没有年份的文本不表示已确认上映年份，TMDB 仍是详情主数据。Wiki v3 会在发布后重新填充缓存。

平台行为核查参考 [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) 和 [ctx.waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)：缓存写入的响应头决定缓存策略，后台写入应绑定请求生命周期。人物作品接口参考 [TMDB Combined Credits](https://developer.themoviedb.org/reference/person-combined-credits)，响应形状由本项目消费者要求与回归测试共同校验。
