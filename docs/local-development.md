# 本地开发与两端联调

当前提供邮箱登录、设备会话、SSE、播放同步、RSS/Atom 与完整 BV 预览、资料库及持久下载 Worker。已接入整期转写、两端文稿和 Codex 问答，真实链路见[本轮验证](verification/transcripts-chat-video.md)。网易 SMTP 测试邮件已由用户确认收到，两端真实验证码登录仍待验收；`MAIL_MODE=local` 的测试邮件不会发送到外部邮箱。

## 网页与基础检查

使用 Node.js 24，在仓库根目录运行：

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

已有 `.env` 时不要覆盖。网页默认地址为 `http://127.0.0.1:3000`，只监听本机。开始播放前音频不会自动出声。`npm run dev` 会生成两端相同的两分钟 WAV 样本：每秒提示音，每十秒高音，循环用于持续播放检查。

```powershell
npm run check
npm run harmony:doctor
```

`check` 包含配置解析、TypeScript 检查、事件和原生服务替身测试、网页生产构建，不包含真实数据库、ArkTS 编译、模拟器或真机测试。鸿蒙源码必须由 DevEco 配套 Hvigor 编译。

## 事件传输验证

展开网页“连接验证”或鸿蒙“连接诊断”，启动事件连接，观察计数每秒增加。`/api/dev/events` 只在开发模式且 `ENABLE_PLAYBACK_PROBE=1` 时可用；每 15 秒主动轮换连接，通过 Last-Event-ID 补回最近 120 秒内的事件，超期发送 reset。

诊断接口不包含用户数据，生产返回 404。真实播放同步使用另一个需要鉴权的 `/api/events`。两端真实连接与恢复已通过本机浏览器和模拟器测试，详见[验证记录](verification/accounts-playback.md)。

本机模拟器保持网页仅监听回环地址，并使用配套 HDC 反向转发：

```powershell
$yuquHdc = 'C:\Program Files\huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
& $yuquHdc list targets
& $yuquHdc -t <实际模拟器地址> rport tcp:3000 tcp:3000
```

转发后，模拟器中的服务地址使用 `http://127.0.0.1:3000`。没有转发时，该地址只指向设备自身。原生账户客户端仅允许 HTTPS 或回环 HTTP，真实设备远程联调需配置 HTTPS。局域网诊断可显式运行 `npm run dev:lan --workspace @yuqu/web`，本轮没有修改防火墙或开放公网端口。

## 数据库迁移

先创建独立的 PostgreSQL 开发数据库，将真实本地连接填写到根目录 `.env`，再运行：

```powershell
npm run db:migrate
```

迁移建立 `yuqu` 命名空间、账号、验证码、设备会话、媒体版本、播放快照、接管幂等记录与用户事件。新增的 `0003_library_imports.sql` 建立导入任务、私有媒体归属和按媒体保存的播放历史。迁移按文件名顺序执行，使用事务和校验摘要，登记表固定为 `public.yuqu_schema_migrations`；不要修改已经执行的迁移。项目不会连接 Cat_Island 数据库。

本机已准备独立 PostgreSQL 18.7，监听 `127.0.0.1:55432`，开发库 `yuqu_development`、测试库 `yuqu_test`，非超级用户 `yuqu`。本机回环测试使用免密认证，不适合作为远程数据库配置。工具、数据及启停脚本在 `%USERPROFILE%\Documents\Codex\2026-11-16\yuqu-stage2\postgres-tools`，`start.ps1` / `stop.ps1` 只操作该实例，未注册系统服务。

```powershell
npm run test:integration
```

此命令读取 `.env` 的 `YUQU_TEST_DATABASE_URL`，**重建该测试库中的 yuqu schema**，拒绝没有 `_test` 后缀的数据库。不要指向开发库、其他项目或真实用户数据库。普通 `npm test` 未设置测试连接时会明确跳过数据库用例。

## 邮箱登录

根目录 `.env` 需要 `DATABASE_URL`、至少 32 字符的私密随机 `YUQU_AUTH_SECRET`、准确的 `YUQU_ORIGIN`。本机配置已生成，不要覆盖或提交。开发来源为 `http://127.0.0.1:3000`；正式环境填写真实 HTTPS 来源。

本地使用 `MAIL_MODE=local` 和绝对目录 `MAIL_OUTBOX_DIR`，邮件只写入本机，查看方式：

```powershell
npm run mail:inbox
```

网页展开邮箱登录，手机填相同邮箱；两端各自发送并消费自己的验证码。验证码有效 10 分钟、发送冷却 60 秒、同邮箱每小时最多 6 次，全局每小时最多 120 次；错误验证最多 5 次。不要重复使用另一端已消费的验证码。

正式发信改为 `MAIL_MODE=smtp`，配置 `SMTP_HOST/PORT/FROM/USER/PASSWORD`，支持 465 隐式 TLS 或 587/2525 STARTTLS，并要求证书验证。生产模式禁止本地测试投递。2026-11-16 本机已配置网易邮箱客户端授权码，连接认证及独立测试邮件实际收件通过；两端真实验证码登录仍需验证。修改根目录 `.env` 后重启 `npm run dev`。SMTP 模式的验证码不会写入本地测试收件箱。[SMTP 配置依据](https://nodemailer.com/smtp)

网页使用 HttpOnly Cookie，鸿蒙使用系统安全存储中的设备令牌。退出只撤销当前设备会话；同邮箱另一设备可以继续使用。会话有效期为 30 天，到期需要重新登录。

网页登录和退出使用浏览器 Web Locks 协调多个标签页；不支持的浏览器会提示升级。使用本机回环地址或 HTTPS，退出排队期间若另一标签页已换会话，会恢复新会话而不误撤销它。

## 播放同步

登录后默认跟随进度，音频保持暂停；点击“在此设备播放”才接管并出声。另一端收到新接管后暂停。播放中约每 3 秒上报，暂停、跳转、倍速变化立即上报；断网时显示连接/过期状态，恢复后校对服务器状态，旧设备不能自动抢回播放。

现在可选择公共两分钟样本或本人导入完成的媒体。切集使用带目标媒体身份的原子接管，按媒体保存上次位置、倍速与循环设置；旧媒体或旧代次的上报不能覆盖新内容。网页实际导入音频的 185 秒位置已保存；鸿蒙模拟器已通过鉴权网络 MP3 续播、30 秒灭屏持续上报、网页切集后暂停及逐集位置恢复。进度、文稿和问答均存入真实 PostgreSQL，服务仍在本机。

## 资料库、RSS 与音频导入

在根目录已有的 `.env` 中配置私有绝对目录；目录应位于网页 `public` 和受版本控制源码之外。例如：

```dotenv
MEDIA_STORAGE_DIR=C:/Users/your-name/yuqu-local/media
YUQU_PUBLIC_DNS=0
```

网页服务与 Worker 必须读取同一数据库和同一个目录。当前实现使用本机文件存储，尚未接入云对象存储或多主机文件共享。文件只通过需要登录的 `/api/media/[id]` 提供，支持 GET、HEAD 和单段 Range；不要将媒体目录直接映射为静态公开目录。

先运行迁移，再分别启动网页和 Worker：

```powershell
npm run db:migrate
npm run dev
# 在第二个终端、仓库根目录运行：
npm run worker:ingestion
# 只尝试领取并处理一项任务后退出：
npm run worker:ingestion -- --once
```

登录后展开“资料库与导入”。音频链接可填写可选标题；RSS 使用“查看节目”，再逐集点击“导入”。解析 RSS 不会自动下载全部节目。任务区分排队、下载中、可播放和失败；失败且尝试次数未达上限时可点击重试。没有运行 Worker 时，任务保持排队。

同一账号重复导入同一规范化 URL 会复用任务；不同账号的资料和媒体访问分别校验。当前每用户最多保留 50 条导入记录，包括失败记录，尚未提供删除与配额回收；排队和下载中合计最多 5 项。

| 限制 | 当前实现 |
| --- | --- |
| 音频格式 | 可识别实际时长的 MP3、M4A、AAC、WAV |
| 文件大小 | 最多 100 MiB（104,857,600 字节；界面简写为 100 MB），同时检查声明长度和实际流量 |
| 单集时长 | 最长 4 小时 |
| 下载期限 | 一次最多 5 分钟；远端连接另有空闲超时 |
| RSS/Atom | 最多 2 MiB、20 秒；扫描前 300 条记录，最多展示 100 个有效音频地址 |
| RSS 解析频率 | 每用户间隔至少 5 秒 |
| 下载尝试 | 每任务合计最多 3 次，包含首次尝试；普通下载失败需显式重试 |
| 中断恢复 | 租约 90 秒、每 15 秒续租；过期任务可被重新领取，仍计入 3 次上限 |
| 同次下载续传 | 最多 3 轮请求，每轮至多 5 次重定向；仅同一强 ETag、最终 URL 与精确字节范围可续传 |
| 连接期限 | 每轮 DNS、建连及响应头总计 30 秒，已连接后空闲 15 秒；所有续传共用原 5 分钟总期限 |

只允许公开 HTTP/HTTPS 的标准端口，拒绝链接内账号密码、本机和非公网地址；每次跳转都重新解析校验，并将连接固定到批准的 IP。RSS 禁止 DTD/实体声明，媒体按下载后的真实格式和时长检查。失败不会被标为可播放。

若本机代理将公网域名解析为 `198.18.0.0/15` 等 fake-IP，默认校验会拒绝该地址。可显式设置 `YUQU_PUBLIC_DNS=1`，将查询交给固定的 `dns.google` TLS 端点及固定解析器地址；得到结果后仍过滤非公网地址、验证 TLS 并固定实际连接 IP。该开关只适用于需要这一网络适配的环境，默认关闭。它不能保证源站可达；本轮部分源站在已返回响应头或部分正文后仍中断。

可复测的公开 MP3：`https://filesamples.com/samples/audio/mp3/sample4.mp3`（本次识别约 244.506 秒）及 `sample3.mp3`（约 105.822 秒）。鸿蒙界面输入短样本链接、提交新任务、Worker 下载就绪及资料列表选集播放已实测通过。真实 RSS `https://feeds.twit.tv/hot.xml` 所选音频前两次失败，第三次完整下载成功，实际时长 148.968 秒，网页保存 60 秒位置后鸿蒙成功接着播放。另在公开源上人为中断正文后，以 HTTP 206 续传得到相同 SHA-256 文件。旧失败原因不据此推断，网络波动仍可能出现。

Worker 日志仅记录任务 ID、存储/下载/解析/发布阶段、耗时、字节数、请求次数与固定错误码，不打印来源 URL、查询参数、凭据或原始异常文本。无强 ETag、来源内容变化或不支持正确 Range 时不会拼接文件；进程强杀后的临时文件不跨租约续传。

## 本机开源转写验证

本机使用独立 Python 环境和阿里 Qwen3-ASR 模型，权重不提交到仓库。配置 `YUQU_ASR_PYTHON`、`YUQU_ASR_MODEL_DIR`、`YUQU_ASR_ALIGNER_DIR` 三个绝对路径后，可执行：

```powershell
npm run asr:transcribe -- --audio C:/path/to/short-audio.wav --output C:/path/to/transcript.json --language Chinese
```

当前入口限 60 秒、20 MB 的短音频，使用真实 ForcedAligner 生成字词时间戳，推理只加载本地文件。它是独立诊断入口。整期任务另需 YUQU_ASR_FFMPEG，并运行 npm run worker:transcription；下载完成自动入队，按段持久化，两端可查看文稿。说话人区分仍待实现。安装与模型版本见[转写说明](../workers/transcription/README.md)，实际结果见[验证记录](verification/rss-local-asr.md)。

## 鸿蒙工程

支持完整 DevEco Studio 或独立官方 Command Line Tools，使用以下命令检查及构建：

```powershell
npm run harmony:doctor
npm run harmony:build
# 需要清理模块产物并重新编译时：
npm run harmony:build -- --clean
```

自定义 IDE 路径可设置当前终端的 `DEVECO_STUDIO_HOME`。独立工具包设置 `DEVECO_COMMAND_LINE_TOOLS_HOME`（指向含 `hvigor`、`ohpm`、`tool/node`、`sdk` 的目录），另配置 `JAVA_HOME` 指向 JDK 21。单独 SDK 可设置 `DEVECO_SDK_HOME`，通常应沿用同一工具包配套 SDK。

也可在已忽略的 `.local/tooling/harmony-toolchain.json` 写入本机绝对路径，避免每次设置终端环境：

```json
{
  "commandLineToolsHome": "C:/path/to/command-line-tools",
  "javaHome": "C:/path/to/jdk-21"
}
```

选择顺序为显式 `DEVECO_STUDIO_HOME`、显式 `DEVECO_COMMAND_LINE_TOOLS_HOME`、本地配置、标准 IDE 目录；显式路径不完整时直接报缺失，不悄悄换成其他版本。IDE 使用自身 JBR；独立工具包使用显式 `JAVA_HOME` 或本地 `javaHome`。构建只为子进程设置配套工具路径，不要求提前加入全局 PATH。`harmony:doctor -- --devices` 可额外枚举目标数量，不输出序列号；模拟器是设备验证的可选工具，缺少它不阻止编译。

构建命令自动生成音频、执行 `ohpm install --all`，再用 Hvigor 编译 debug HAP。产物位于 `apps/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`，当前没有配置签名，不能当作真机可直接安装或正式发布的包。

也可先运行 `npm run fixtures:generate`，再用 DevEco Studio 打开 `apps/harmony`。工程结构、播放器生命周期与配置见[鸿蒙工程说明](../apps/harmony/README.md)。

用户当前设备为 HarmonyOS 7，已有实名认证开发者账号，暂不能连接真机。桌面模拟器已通过本地播放与后台测试；下一步按[鸿蒙开发与发布流程](harmony-development-release.md)补真机验证。[最新记录](verification/harmony-build-emulator.md)区分构建、模拟器和真机证据。

本机已创建 `YuQuPhone`（HarmonyOS 7.0.0 / 4 GiB 内存 / 8 GiB 数据分区），镜像和设备目录在项目外。需要显示模拟器窗口时可运行：

```powershell
$yuquStudio = 'C:\Program Files\huawei\DevEco Studio'
$yuquEmulatorRoot = Join-Path $env:LOCALAPPDATA 'Huawei\YuQuEmulator'
& "$yuquStudio\tools\emulator\Emulator.exe" -start YuQuPhone -imageRoot "$yuquEmulatorRoot\images" -instancePath "$yuquEmulatorRoot\instances"
```

本次验证已向该模拟器安装测试应用，可从桌面打开鱼趣知识库。后续覆盖安装时先用配套 `hdc list targets` 确认目标是该模拟器，再使用 `hdc -t <模拟器地址> install -r <HAP路径>`，避免向其他连接设备安装。本次地址为 `127.0.0.1:5555`，以后以实际枚举为准。


## 本地问答 Bridge

先迁移 0005_chat.sql；业务 .env 配置 YUQU_BRIDGE_PROJECT_ID、YUQU_BRIDGE_AGENT_ID、YUQU_BRIDGE_TOKEN。独立 CodexBridge 的运行目录 config.json 使用相同三项身份，adapter 为 yuqu，serverUrl 为当前鱼趣源站。凭据不放进命令行、不提交仓库。配置结构与协议见[文稿与问答接口](transcripts-chat-api.md)。

本机鱼趣单独使用 %LOCALAPPDATA%/CodexBridgeYuQu。可在 Bridge 的独立终端设置 CODEX_BRIDGE_HOME 指向该目录，CODEX_BRIDGE_CODEX_HOME 指向已有独立 Bridge 的 codex-home，然后运行 node --import tsx src/cli.ts run。后一变量仅选择已有登录目录，不复制凭据；缺省仍使用自己运行目录的 codex-home。Cat 的配置、进程和队列不需要改变。当前测试进程未安装系统自动启动，电脑重启后按上述步骤运行。

新配置写入后重启鱼趣网页进程使环境变量生效。网页打开资料库选择内容，再在主界面提问；手机使用“问 AI”。文稿未完成的范围会提示等待，不会用缺失资料生成整期答案。
