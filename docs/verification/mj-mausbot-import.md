# mj-MausBot 源码交付验证

2026-11-08 在 `mj-MausBot` 新目录独立安装依赖并执行以下检查。
基线提交为 `b3a4be0`，对应 OpenMausBot 上游提交
`3f81576655ca45af91bfaaa63dc37251222828eb` 的开源快照。
基线及后续提交不含 `enterprise/`，上游自动发布工作流不在本仓库。

## 检查结果

- `pnpm install --frozen-lockfile` 通过。
- `pnpm typecheck`、`pnpm lint` 和 `pnpm i18n:check` 通过。
- `pnpm build` 和 `pnpm build:server` 通过。
- 17 组相关回归通过，245 passed、1 skipped。
- `official-regression`、`parallel-isolation`、`tool-roundtrip`、
  `background-route`、`metadata-restart`、`failure-states` 六组隔离流程通过。
- Chrome 完整应用流程通过，创建两个独立实例、手动检查、选择模型、
  发送消息和刷新恢复均有实际断言。
- 从原集成工作区复制的 66 个扩展文件逐一比较 SHA-256，内容相同。

验证脚本及重跑命令见 [独立 API 连接说明](engine-endpoints.md)。
上述服务均使用临时应用数据、合成 key、fake CLI 和 loopback HTTP，
没有向用户正在运行的应用发送变更请求，没有调用真实供应商。

## 交付范围

本次验证证明新目录能够独立构建及运行已有连接功能。
没有运行全仓 `pnpm test`，没有认证真实 DeepSeek 或 Kimi 服务，
没有生成或验证安装包，也没有进行独立跨模型代码审查。

首次启动仍保留上游官方登录推荐。第三方配置的入口在设置页，
可选择“稍后设置”后创建 API 连接。完整品牌资源替换未包含在本次交付中。
仓库和桌面构建身份已改为 mj-MausBot，内部兼容名称保留。

本仓库 CI 只执行类型、lint、语言文件和前端构建，
不自动发布安装包、镜像或部署外部服务。
