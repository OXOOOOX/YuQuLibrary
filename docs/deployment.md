# 鱼趣知识库部署与验证记录

## 从 main 自动更新网站

推送到 `main` 会触发 GitHub Actions 的 [Deploy production](https://github.com/OXOOOOX/YuQuLibrary/actions/workflows/deploy-production.yml)。CI 使用 Node 24 执行 `npm ci`、`npm run check` 和独立 PostgreSQL 18 测试库的全量集成测试。通过后，独立的部署任务才可使用 GitHub 的 `production` 环境。该环境只允许 `main` 分支。

部署私钥保存在环境 Secret `YUQU_DEPLOY_KEY`。环境 Secret `YUQU_SSH_KNOWN_HOSTS` 保存经管理员连接确认的服务器公钥，别名为 `yuqu-production`；环境变量 `YUQU_DEPLOY_HOST` 指定 SSH 主机。生产数据库、邮件、问答和转写凭据保存在原有运行环境。

服务器的专用账号 `yuqu-deploy` 只接受 `deploy <完整提交 SHA>`。服务器取得发布锁，通过 GitHub API 确认 `main`，按提交下载官方源码归档，逐个核对构建文件的 Git 摘要，再构建镜像并核对应用和下载 Worker 的运行镜像。被更新提交取代的请求会跳过。公网 [健康接口](https://fish.sdspeed.com.cn/api/health) 的 `revision` 应与成功运行的提交一致。

出现新迁移时，先等待在途租约结束、停写并备份，在隔离库恢复并演练后才迁移生产库。普通应用切换失败会恢复旧镜像。生产迁移已开始后如遇异常，保留停写状态和备份，先检查迁移账本与故障记录再恢复写入。数据库、同机其他站点及独立运行的 Bridge、ASR 均由原服务管理。

可在 GitHub Actions 重跑失败任务。生产管理员可按运行日志中的编号检查 `/opt/yuqu/deployment-runs/<编号>/log`。部署入口、迁移工具或 Compose 权限需要调整时，管理员从已审阅的工作树执行 `sudo bash deploy/automation/install.sh <专用公钥文件>` 更新宿主机副本。鸿蒙签名和 AppTest 分发另行办理。

## 2026-11-19 生产升级

[鱼趣知识库](https://fish.sdspeed.com.cn/) 的网页与 API 已升级至 `20261118-1efca90acbb08846`。发布用的 122 个服务器文件与 Git 提交 `697c8dc` 逐文件一致。GitHub 保存源码，此次生产发布通过独立的服务器升级流程完成。

- 对停写时的数据库、私有媒体与配置完成备份。先把数据库和媒体恢复到隔离位置，逐文件校验媒体，并在恢复库排练五份新增迁移。生产库随后从 9 份迁移升级到 14 份。
- 用一段约 149 秒的受控音频走通生产下载、整期转写、搜索、选段提问、追问、整期检索、收藏备注和引用回听。该样本生成 4 个章节和 6 个总结主题；已核对主题要点的冻结原文、取消后继续整理及音频归档后的阅读。
- 首选短样本下载失败，改用上述音频完成验收。清理测试账号时遇到仍在处理的媒体回收任务，等待其结束后只清理本次测试数据；复核 12 张原有业务表，原记录数和旧字段摘要一致。
- 桌面和手机宽度的真实浏览器均能打开公网首页和隐私页，登录表单可操作，未出现横向溢出或未捕获的脚本错误。项目检查通过，独立 PostgreSQL 上的 72 个集成测试全部通过。
- 鸿蒙端验证覆盖 API 26 模拟器的输入法、引用、资料导航与深浅色。本次未分发真机安装包。

## 2026-11-17 及此前的部署记录

当时已上线网页、API、独立数据库、音频下载与语义分句。转写仍使用 0.6B，新任务启用 v3，旧文稿保留。详见[语义分句上线验证](verification/asr-semantic-release.md)。

### 当时的版本与部署布局

当前已发布资料管理、容量控制和引用回听，并执行 `0007_storage_management`、`0008_import_storage_backoff`、`0009_playback_target_position`，数据库共 9 个迁移。当前发布编号以 `/opt/yuqu/current` 及发布目录内的摘要清单为准；最新验证见[引用回听与签名准备](verification/citation-replay-signing.md)，此前资料管理证据见[转写服务与资料管理记录](verification/asr-service-storage.md)。B 站短链接、连续引用解析和鸿蒙导入状态刷新的证据保留于[短链与引用验证](verification/bilibili-short-links-citations.md)。生产页面继续隐藏开发诊断入口，网页标题为“鱼趣知识库”。

| 项目 | 位置或方式 |
| --- | --- |
| 发布目录 | `/opt/yuqu/releases/<发布编号>`；`/opt/yuqu/current` 指向当前版本 |
| Web / PostgreSQL | `127.0.0.1:4210` → 容器 3000；`127.0.0.1:55433` → 容器 5432 |
| 数据库 | 独立 PostgreSQL 18.1，最近生产记录为 9 个迁移；`/opt/yuqu/shared/postgres`，属主 `999:999`、权限 `0700` |
| 私有媒体 | `/opt/yuqu/shared/media`，属主 `1000:1000`、权限 `0700`；不对外静态托管 |
| 外置配置 | `/opt/yuqu/shared/runtime.env`、`postgres.env`，Compose `format: raw` 加载，不进镜像或源码包 |
| 发布参数 | 发布目录内 `release.env`、`deployed-image-id.txt` 记录镜像引用与 ID |
| 网关 | `/opt/site-gateway/Caddyfile` 将鱼趣域名转发到 `127.0.0.1:4210` |

Node 使用官方 `24.22.1-bookworm-slim` Linux amd64 镜像转存，校验传输包摘要和加载后的镜像 ID；PostgreSQL 使用固定 digest。构建取得 `/opt/rdb/shared/build.lock`，鱼趣发布另有 `/opt/yuqu/shared/release.lock`。`deploy/release.sh` **仅支持首次部署**，已有 `current` 就会退出；后续更新须使用含备份及回退处理的发布流程。

通过 SSH 将 Bash 发布脚本从标准输入传入时，迁移用的 `docker compose run` 必须加 `-T` 并以 `</dev/null` 隔离标准输入。本轮首次脚本执行中，迁移容器消耗了后续脚本输入，导致流程在迁移后提前结束；随后补充启动脚本恢复，网页与下载 Worker 已启动并通过健康检查，未回滚数据。这不是一次全程无中断的升级，过程详见本轮验证记录。

## 已验证结果

| 项目 | 实际结果 |
| --- | --- |
| 公网入口 | HTTPS 已上线；Let's Encrypt 证书有效期为 2026-11-16 至 2027-02-14；HTTP 308 跳转 HTTPS |
| 页面与诊断保护 | 应用返回 200；`/api/dev/events`、`/.env`、`/.git/HEAD` 均为 404 |
| 页面复查 | Chrome 1280×900 与 390×844 均完成截图检查，手机版无横向溢出；最终刷新后无浏览器应用错误，开发诊断入口不存在 |
| 真实邮箱登录 | 受控测试邮箱分别在网页与鸿蒙 OS 7 模拟器通过真实邮件验证码登录；网页 Cookie 为 Secure、HttpOnly、SameSite=Lax |
| 上轮退出隔离 | 测试网页退出后 Cookie 被清除，`/api/auth/me` 返回 401；鸿蒙账号仍保持登录。上轮测试浏览器已关闭，临时保存的网页登录状态文件已删除；本轮用新验证码重新登录网页 |
| 双端播放同步 | 验证音频完成播放、暂停、快进 15 秒、接管；两端同时显示 1:00。网页刷新保留进度；鸿蒙强制停止后重启恢复账号与 1:28 进度，未自动出声 |
| SSE 恢复 | 至少 3 次连接返回 200，相邻约 56 秒，自动重连正常 |
| 公开音频下载 | `https://cdn.twit.tv/drops/hot/1/1.mp3` 首次下载即 ready；2,563,438 字节、148.968 秒；两端播放并同步切换节目 |
| 媒体访问 | Range `0-1023` 返回 206、1024 字节；越界范围返回 416；匿名访问返回 401 |
| 发布重启后 | 原有真实登录仍有效；私有音频仍返回 206 和正确长度，进度保留在节目结尾 |
| 模拟器后台 | 返回 Home 后继续播放至结尾；此项是模拟器结果，不是真机锁屏或省电策略验证 |
| 生产自动转写 | 服务器排队样本由本机 Qwen3-ASR 和 ForcedAligner 完成；148.968 秒音频用时 83.489 秒，保存 5 块、20 个文稿片段，两端查看首段和当前附近尾段一致 |
| 生产真实问答 | 网页整期总结和鸿蒙追问均经独立 Bridge 首次执行完成，分别保存 14/1 条引用；手机问题同步网页，网页刷新后两轮记录不变 |
| 原有网站 | 4 个网站分别返回 200 / 200 / 200 / 302，回归通过；未修改 Cat |

同邮箱新验证码会使旧码失效，复测时先完成一端登录，再等待至少 60 秒申请另一端验证码。文档与日志不保存验证码。

## 运行查看

在服务器 root shell 中执行：

```bash
cd /opt/yuqu/current
readlink -f /opt/yuqu/current
docker compose --env-file release.env -f deploy/compose.yaml ps
docker compose --env-file release.env -f deploy/compose.yaml logs --tail 100 app ingestion postgres
curl --fail --silent https://fish.sdspeed.com.cn/api/health
docker logs --tail 100 site-gateway-gateway-1
```

`/api/health` 只证明 HTTP 进程存活，不代表邮件、同步、ASR 或问答可用。配置检查用 Compose `config --quiet`，不要输出完整展开配置；不要用 shell `source` 加载两份 raw 运行配置。共享网关修改须先备份、加锁、validate 后 reload；普通应用更新不修改网关。

## 备份与更新边界

初始备份及更新前备份均完成隔离恢复测试。收尾更新先停止鱼趣 app 和 ingestion，再保存数据库、媒体及私有配置至 `/opt/yuqu/backups/20261117-before-ui-cleanup`。该 dump 恢复后核对到 1 个真实用户、2 个设备会话、2 条媒体记录和 6 个迁移；媒体归档包含下载音频，测试临时库已删除。备份仅管理员可读。

后续更新保留旧源码、镜像 ID、配置版本与 `/opt/yuqu/backups/<UTC时间>`。暂停 app、ingestion 及其他写入方，保留 PostgreSQL 运行；用 `pg_dump -Fc` 备份数据库，并归档同一恢复点的 media，检查退出码、摘要和恢复结果。不要复制运行中的 PostgreSQL 数据目录充当一致备份。

此前 ASR HTTPS 接入的发布前备份在 `/opt/yuqu/backups/20261117-before-remote-asr`，包含停写后的数据库 dump、媒体和旧运行配置；文件非空、媒体归档可读。该轮未再次执行隔离恢复，前述恢复结果属于更早备份验证，当时版本未改变 schema。

资料管理发布前另有 `/opt/yuqu/backups/20261117-before-storage`，已核对目录存在及清单；本轮没有重新执行隔离恢复或人为制造发布失败。此轮新增迁移 0007/0008，回滚前必须核对旧代码与新 schema 的兼容性；若需恢复旧数据，应停写并共同恢复数据库和媒体。仅修改 `current` 链接不会切换已运行容器，也不会撤销迁移。用户的资料删除不提供回收站，管理员备份不等于应用内恢复功能。

## 本机生产工作进程

ASR 使用项目内忽略提交的 `.local/production/asr.env`；本机状态、缓存和日志在 `%LOCALAPPDATA%/YuQuASRProd`。配置仅含 ASR 专用身份、正式 HTTPS 地址和模型/缓存路径，不含生产数据库、邮件或 Bridge 凭据。生产常驻进程由以下入口托管，在项目根目录运行：

```powershell
npm run asr:service -- install-autostart
npm run asr:service -- status
```

`install-autostart` 注册当前用户的 `YuQuTranscription` 计划任务并启动服务，无需管理员权限。任务在该用户登录后启动，每分钟检查恢复；它不是开机未登录即可运行的系统服务。`npm run asr:service -- start` 显式启用并启动，`npm run asr:service -- stop` 停止并持久记录 `enabled=false`，后续计划任务不会把手动停止的服务拉起；`npm run asr:service -- ensure` 只在已启用时检查并恢复。前台诊断入口 `npm run worker:transcription:remote` 仍保留，不要与托管实例重复启动。

服务日志按 2 MiB 保留 3 份，启动器日志按 1 MiB 保留 2 份，记录固定诊断码而不保存原始文稿或凭据。实际已验证 Worker 崩溃重启、监管进程被终止后的任务恢复，以及手动停止后不复活；148.968 秒真实样本在 30 秒检查点中断后续完 5 块，原有块摘要不变。整机重启及注销后的自动启动尚未实测。模型互斥、缓存回收与命令详情见[转写说明](../workers/transcription/README.md#生产-https-worker)。

2026-11-17 后续按用户要求将 Cat 和鱼趣合并到 `%LOCALAPPDATA%/CodexBridge` 的一个共享 Bridge 实例，默认总并发 2、每项目 1。原 `CodexBridgeYuQuProd` 已停止且项目禁用；业务令牌、任务目录和服务端数据保持独立。统一实例沿用现有 `CodexBridge.vbs` 登录启动入口。ASR 仍在独立转写进程运行；电脑离线时新转写和回答等待本机恢复，已有文稿与聊天可在线查看。

## 资料清理与容量

资料列表提供两种确认后执行的操作：**清理音频**仅允许整期转写已完成的资料，保留文稿和聊天；**删除整期资料**同时移除文稿、聊天、关联任务和播放历史，并使旧 ASR/Bridge 执行失效。清理正在播放的资料时，播放状态重置为暂停的受控样本，两端停止该音频。两端的独立阅读模式可以查看文稿和提问，不接管另一端播放；清理后的音频不能继续播放，也没有恢复音频按钮。

排队和失败的导入任务可直接移除，下载中的任务需等待下载结束。默认每用户容量为 **1 GiB**，可用服务端 `YUQU_USER_STORAGE_LIMIT_BYTES` 配置字节数；每项待处理导入预留 **100 MiB**，仍保留每用户 50 条导入及 5 项待处理限制。配额按已用、预留、待回收三者合计检查，新增与重试原子校验；已有超额资料保留，仅限制继续导入。

删除先撤销访问并写入持久回收队列，`ingestion` Worker 在至少 30 秒后尝试删除没有媒体引用的文件，失败后退避重试。失败或租约过期的下载文件等待 6 分钟再回收，避免旧下载进程仍在写入。成功确认文件删除前，待回收空间继续计入占用；因此点击删除不等于容量立即释放。必须保持下载 Worker 运行，排障时核对待回收状态，不能直接删除仍被资料引用的文件。

## 尚未完成

- **整机启动与长期运行**：ASR 登录自启动、每分钟恢复与手动停止保护已配置并做进程故障实测，但本轮未注销或重启电脑验证。Cat/鱼趣共享 Bridge 沿用原登录启动入口；不要恢复旧鱼趣实例造成重复领取。
- **生产负载与转写质量**：配额与清理已实现，本轮恢复验证使用 2 分 29 秒公开样本。生产小时级负载、断网续接和人工准确率尚待验收；此前一小时中断续接证据属于本机环境。
- **鸿蒙真机**：目前完成 OS 7 模拟器验证，真机锁屏、长时间后台及系统省电策略仍待测试。

## 本轮验证材料

本机材料目录：`%USERPROFILE%/Documents/Codex/2026-11-17/yuqu-stage7`。包含源码摘要、官方镜像完整性报告、发布日志、网页最终截图、SSE/媒体证据和鸿蒙界面记录。实际执行了 `npm run check`（73 项通过，28 项数据库测试在此命令中跳过）、`npm run test:integration`（28 项通过）、鸿蒙 HAP 编译与安装；收尾 UI 改动另通过类型检查、服务器生产构建和真实浏览器检查。数据库测试始终使用独立 `_test` 库，未指向生产。

浏览器验证使用现有 Playwright 和 Chrome（本会话没有 Browser 插件）。本轮为手动发布，未配置 GitHub 自动部署；线上源码以发布目录内的逐文件摘要清单核对。

生产转写与问答的后续材料在 `%USERPROFILE%/Documents/Codex/2026-11-17/yuqu-stage8`，包括发布日志、接口/模型进度、两端文稿和对话证据。完整范围、实际失败与修复、测试数量见 [生产文稿与问答验证](verification/production-transcription-chat.md)。

最新转写托管与资料管理验证见[本轮记录](verification/asr-service-storage.md)：独立 `_test` 数据库 41 项测试通过，网页桌面/手机界面检查与鸿蒙 HAP 构建通过。生产鸿蒙模拟器完成清理音频、保留文稿继续提问（真实回答含 7 条引用）、重装 HAP 后查看文稿和删除整期资料；服务器复核测试资料的媒体、文稿、分块、聊天及导入记录全部移除，物理音频已不存在且待回收队列为空，原有 3 期资料及 12,282,507 字节音频保留。具体操作链路及仍未验证的场景以该记录为准，不将模拟器或构建通过当作鸿蒙真机验收。

