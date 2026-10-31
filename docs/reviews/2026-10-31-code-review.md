# 2026-10-31 项目代码复审

基线：`21714c9`（1.0.22）。检查范围包括前端搜索、详情重试、人物分页、导航与异步取消、评分与海报身份、资源状态合并、Worker 上游请求和正文限制、缓存、Cookie/CORS/限流边界，以及锁定依赖、构建与 CI 配置。复审开始时工作区干净。

## 已修复问题

| 问题 | 复现证据与处理 |
|---|---|
| Quark 点路径被改写为另一个分享 | `/s/old/../rewritten` 和 `/s/old/%2e%2e/rewritten` 在 URL 解析后变为 `/s/rewritten`，原实现错误返回新地址。新增反例先失败，修复为解析前后核对完整原始路径；正常链接与密码继续保留。 |
| TMDB 电影/剧集字段混用 | 请求 movie/42 却收到同 ID、只有 `name` 的 TV 数据时，原实现返回 200 并缓存；同时带两类字段的 TV 数据会采用电影标题与年份。现在详情校验要求对应类型的标题字段；搜索排名、归一化、详情和备用海报均使用对应媒体类型的标题、原名与日期。反例先失败，修复后通过。 |
| HTML 数字实体截断 Unicode | `&#x20bb7;` 被 `fromCharCode` 截断，搜索“𠮷祥”时正确 WPZY 帖子被过滤。现按完整 Unicode 码点解码，非法码点替换为 U+FFFD；扩展汉字、十进制 emoji 与公开资源链接的回归通过。 |
| ESLint 间接依赖存在中危公告 | 初次 npm audit 报告 minimatch 公告及四项传播记录，共五项中危。按[维护者公告 GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)将 minimatch override 到修复版 11.0.1，保留当前 ESLint；重新安装、lint 和审计通过。 |

资源缓存升至 v14，海报聚合缓存升至 v5；旧的错误类型 TMDB 原始详情由已有缓存校验和淘汰机制重新获取。发布元数据和生成入口同步为 1.0.23。

## 验证

- `npm test`：278/278，ESLint、CSS 和 JavaScript 构建通过。
- `npm run test:runtime`：32 项原生 Worker 检查通过。
- `npm run test:browser:ci`：44 条流程通过，覆盖手机与桌面，无未捕获应用异常。
- `npm run deploy:worker:dry-run`：strict 打包通过，生产限流 bindings 保留。
- `npm audit --json`：217 项锁定依赖，0 个已知漏洞。
- `git diff --check`：通过。

本地浏览器和原生 Worker 测试使用模拟上游；依赖审计反映检查时的公告数据。线上发布结果以对应 PR、部署状态和 `test:live` 的实际结果为准。
