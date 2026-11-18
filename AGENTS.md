# 鱼趣知识库项目约定

- 项目处于 V1 的多端播放、整期转写与文稿问答联调阶段；范围以 `docs/requirements.md` 和 `docs/development-plan.md` 为准。
- Node.js 使用 24，根目录 npm workspaces；安装用 `npm ci`，检查用 `npm run check`。
- 鸿蒙项目在 `apps/harmony`，使用 DevEco Studio 配套工具链；`npm run check` 不包含 ArkTS 编译或真机验证。
- 鸿蒙环境检查用 `npm run harmony:doctor`，实际 HAP 构建用 `npm run harmony:build`；需要清理模块产物时加 `-- --clean`。优先读取 `DEVECO_STUDIO_HOME`，也支持 `DEVECO_COMMAND_LINE_TOOLS_HOME` 配合 `JAVA_HOME`（JDK 21），或已忽略的 `.local/tooling/harmony-toolchain.json` 本机绝对路径；只为子进程设置配套工具路径。
- AppTest 准备使用 `npm run harmony:build -- --app` 生成 Release `.app`；未签名产物仍需 DevEco Testing Only 云签名、平台检测与测试分发，不等于手机可安装。`sign-config.json5` 和证书不提交；后台上传及邀请只在明确授权后操作。
- 网页开发用 `npm run dev`，默认仅监听 `127.0.0.1:3000`。原生端联调另行显式开放局域网。
- `npm run fixtures:generate` 生成两端共用的受控音频。生成文件、签名和凭据不提交。
- 修改 JSON/JSON5 后运行 `npm run check:config`。不要把静态配置检查当成 Hvigor 构建成功。
- 真实数据库测试用 `npm run test:integration`，仅可配置独立的 `_test` 数据库；该测试会重建其中的 `yuqu` schema，禁止指向开发或生产库。
- 本地测试邮件通过 `npm run mail:inbox` 查看；`MAIL_MODE=local` 不发送真实邮件，生产模式禁止使用。
- 音频下载需同时运行 `npm run worker:ingestion`；`MEDIA_STORAGE_DIR` 使用绝对路径且不可公开静态托管。导入链接必须通过公网地址校验和固定 IP 连接，不得为测试放行内网/代理 fake-IP。
- 下载默认单集最多 100 MiB/4 小时、5 分钟总时限；RSS 最多 2 MiB/100 个候选。新样本验证应记录实际失败和重试，不绕过来源限制。
- 整期转写运行 `npm run worker:transcription`，先迁移数据库并配置四个 `YUQU_ASR_*` 绝对路径（含 FFmpeg）。下载完成原子入队，30 秒核心段带上下文，保存后 ACK，旧租约禁止提交；不得用伪时间戳或源站时长替代实际解析。
- 本机接生产队列用 `npm run worker:transcription:remote`，独立 `.local/production/asr.env` 只需 ASR 专用凭据和模型/缓存路径，不配置生产数据库、SMTP 或 Bridge 凭据；开发和生产 Worker 共用模型锁，不可并行加载同一模型。
- 生产本机转写使用 `npm run asr:service -- install-autostart/start/stop/status` 中对应的单个动作。Windows 计划任务在用户登录后运行；先检查现有托管状态，不并行启动直接 Worker。模型子进程登记和父管道握手必须先于加载；临时目录仅按有效归属标记回收，未知目录保留。
- 清理音频保留文稿与聊天，整期删除须处理播放代次、关联任务及持久回收队列；不得先删文件再提交数据库。用户额度包含已用、下载预留、待回收字节，回收完成后才能释放；生产删除验证只使用本轮新建的受控样本。
- 文稿与聊天使用独立分页轮询，不复用播放 SSE 修订号。引用必须绑定提问时冻结的文稿，支持单编号和连续范围；展开去重后最多 32 个编号，范围中每个编号均须存在。聊天历史持久化于业务数据库。
- 引用回听显式绑定聊天媒体与引用起点，先接管并定位再播放，不改原问题快照；接管幂等身份包含 positionMs。归档音频拒绝回听，文稿与对话继续可读。
- B 站支持完整 BV 和 HTTPS b23.tv 短链接的公开普通视频音轨，预览分 P 后导入。短链逐跳仅允许 b23.tv 或合法 BV 目标，归一后去重；固定 Referer 仅可发送到已验证 CDN，逐跳 DNS/IP 校验仍必须执行。不支持登录和付费内容。
- 鱼趣 Bridge 使用独立项目凭据与 `yuqu` adapter，源码在独立 CodexBridge 仓库；不得为问答开启工具或复制 Cat 凭据。
- 本机阿里模型验证用 `npm run asr:transcribe -- --audio <绝对路径> --output <绝对路径>`，仅处理 60 秒/20 MB 以内样本；Python 环境和模型在项目外，路径通过 `YUQU_ASR_*` 配置。此 CLI 仅为短样本诊断；整期任务使用独立 episode.py。完整验证边界见 docs/verification/transcripts-chat-video.md。
- 第一阶段诊断接口只在开发模式且 `ENABLE_PLAYBACK_PROBE=1` 时开启，不承载用户数据。
- 不因参考 Cat_Island 而读取、复制其凭据或使用其生产数据库。
- 模拟器、真机、服务器和外部服务验证分开记录；未执行项保持待验证。

