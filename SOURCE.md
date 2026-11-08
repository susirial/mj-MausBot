# 源码来源与修改

本项目由 susirial 维护，基于 Milind Soni 和 OpenMausBot contributors 的源码。

- 上游仓库：https://github.com/milind-soni/OpenMausBot
- 上游版本：0.1.148。
- 原始提交：`3f81576655ca45af91bfaaa63dc37251222828eb`。
- 本项目仓库：https://github.com/susirial/mj-MausBot

本仓库使用新的 Git 历史。首个提交是原始提交的开源源码快照，
排除 `enterprise/` 和 `.github/workflows/`。因此本仓库及其首个提交
不包含企业代码，也没有导入上游自动部署、发布和定时任务。

第二个提交添加独立 API 连接。它覆盖共享连接类型、配置校验、
CLI 隔离、Codex 和 Claude 主调用与后台调用、API、会话 revision、
设置界面、模型选择器、中英文文案及隔离验证脚本。
该提交的 Git diff 是修改文件清单。

项目 README、仓库地址、桌面应用 ID、安装包名称及更新仓库使用本项目配置。
内部包名、CLI 命令、协议、环境变量及兼容代码保留上游名称。
界面仍有上游品牌资源，完整品牌替换和安装包资格验证不在本次源码交付范围内。

`LICENSE`、`NOTICE` 和 `third_party/` 的许可证及署名保留。
上游 `LICENSING.md` 保留用于说明原始许可证边界；其中的企业目录不在本仓库。
本项目不宣称拥有上游商标或获得企业功能授权。

独立 API 连接的检查使用合成 key、fake CLI 和 loopback HTTP 服务。
它证明应用的路由、凭据隔离、模型选择、持久化及交互，
不证明真实 DeepSeek 或 Kimi 服务的模型、工具、配额或收费资格。

首次启动页仍提供官方账号登录推荐。第三方连接可通过“稍后设置”
进入设置页创建，不需要先完成官方登录。

新增 CI 只检查类型、lint、语言文件和应用构建。
发布安装包和外部服务部署需要单独配置，不由本仓库的推送自动触发。
