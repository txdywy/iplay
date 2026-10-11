# 项目代码审查 — 2026-10-11

本轮修复 3 类功能问题，并处理开发依赖安全公告和发布文档偏差，归入 v1.0.13。新增浏览器与 API 用例先复现失败，再验证修复。本记录说明代码与本地验证结果；生产发布另以 PR、CI、Cloudflare/GitHub Pages 部署状态及线上验收为准。

## 范围与基线

- 基线：`20d706d`（main，v1.0.12）；工作区干净，基线 187 项测试、lint 和构建通过。
- 阅读前端全部 JavaScript、Worker 全部路由与共享基础设施，核查 HTML/CSS、Wrangler、CI 和关键回归测试。
- 检查搜索匹配、人物候选与分页、历史导航、分享恢复、详情渐进渲染、资源重试、密码归属、缓存、上游超时/大小限制、CORS、限流、凭据隔离与错误脱敏。
- 本机 Node.js v26.11.1；Node.js 22/24 的安装、构建与测试由 PR CI 矩阵验证。

## 已修复问题

| 优先级 | 触发与影响 | 修复与回归证据 |
|---|---|---|
| P2 | 演员分享链接显式提供无效或空 `person` 时，退回姓名搜索，可能打开另一个同名演员；无效影视 `id` 静默回到首页 | 显式 ID 在请求前校验并展示错误。浏览器覆盖空值、零、负数、混合字符、超长值，要求零 API 请求；保留姓名旧链接与合法 ID 去空白行为 |
| P2 | 搜索候选的片名/年份过期时，Wikipedia 和豆瓣已用旧元数据请求；早到的旧简介会在详情纠正片名后被继续保留，OMDb 海报回退也使用旧片名 | 基础候选仍立即显示，补充查询等待详情完成并读取更新后的片名、类型和年份；普通搜索详情失败仍按候选降级。浏览器用延迟详情、变更片名/年份、同名不同年豆瓣结果验证补充查询和展示 |
| P2 | TMDB 电影/剧集详情缺失 `external_ids` 或 `credits` 时被正常缓存一天，重试仍读到缺失演员和 IMDb 信息的结果 | 根据请求的附加字段要求外部 ID 对象及 cast/crew 数组；不完整响应返回 502 且不缓存，旧缓存删除并重取，合法空数组仍接受。API 覆盖两类媒体、字段缺失/错误类型和旧缓存修复；真实 workerd 验证失败后恢复 |
| P2（开发工具） | `npm audit` 报告 4 条高危依赖记录，根源为 sharp/librsvg 和 source-map-js 的两份公告 | 匹配升级 Wrangler 4.149.0 / Miniflare 5.20261006.1-alpha，带入 sharp 0.35.5；source-map-js 更新至 1.2.2。完整依赖审计降至 0。未将这些开发依赖报告描述为生产 Worker 已遭攻击 |

同时将 CI Chrome 安装 Action 固定到已核实的提交，统一 Node.js 最低版本与 `npm ci`，纠正默认本地开发自动读取生产密钥的错误说明，并记录现有 main 分支触发 Cloudflare Workers Builds 的发布路径。

## 验证

| 检查 | 结果 |
|---|---|
| `npm test` | 189/189；lint、Tailwind 构建通过 |
| `npm run test:browser:ci` | 30 条流程；390×844 / 1280×900；无未捕获的应用异常 |
| `npm run test:runtime` | 升级后的真实 workerd 21 项检查通过，含新媒体详情恢复及原生缓存、HTMLRewriter、限流 |
| `npm run deploy:worker:dry-run` | Wrangler 4.149.0 严格打包通过，生产环境及两个限流 binding 正常 |
| `npm audit --json` | 完整锁文件 0 漏洞 |
| `git diff --check`、生成 CSS 一致性 | 通过 |

## 依据与边界

TMDB 契约核对了官方 [Append To Response](https://developer.themoviedb.org/docs/append-to-response)、[Movie Credits](https://developer.themoviedb.org/reference/movie-credits)、[TV Credits](https://developer.themoviedb.org/reference/tv-series-credits) 及 [OpenAPI](https://developer.themoviedb.org/openapi/tmdb-api.json)。附加字段验证基于调用方明确请求的数据，空字段本身仍合法。

安全版本核对了 [sharp 公告](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) 与 [source-map-js 公告](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)，只升级受影响的工具链及传递依赖；Worker 兼容日期维持原值。

本地测试模拟外部上游，不能据此确认外部服务实时可用性。上线验收需等待前端与 Worker 发布完成，再运行 `LIVE_REQUIRE_WPZY=1 npm run test:live` 核对静态文件逐字匹配、发布响应头和真实 API。OMDb 未配置及 WPZY 回复/VIP 门槛应单独报告。
