# 鱼趣知识库鸿蒙播放验证工程

本目录是 Stage 模型的 ArkTS/ArkUI 工程，已包含本地与网络音频、媒体会话、后台播放、邮箱登录、安全存储、RSS/音频/BV 链接导入及跨端进度同步。已增加文稿分页、当前位置附近查看和 AI 问答、历史、引用、取消/重试。认证主流程已用本地测试邮件验证，SMTP 测试邮件已由用户确认收到；两端真实验证码登录仍待验收。最新模拟器与真实服务结果见 ../../docs/verification/transcripts-chat-video.md。

## 当前验证状态

- 已提供工程配置、入口、页面、应用级播放器服务和资源。
- **已通过真实 ArkTS/Hvigor 编译和 HarmonyOS 7 模拟器运行**，生成并安装未签名 debug HAP；已验证基本控制、十分钟后台循环、20 秒灭屏播放和锁屏媒体卡片暂停/继续。真机后台播放仍待验收，详见[验证记录](../../docs/verification/harmony-build-emulator.md)。
- 用户设备报告为 HarmonyOS 7，当前不能通过 USB 连接，先进行桌面模拟器验证。工程兼容下限现设为 API 26.0.0，与已测试的 HarmonyOS 7 对齐；网络请求禁止重定向使用新 SDK 能力，旧系统兼容性另行验证后再降低下限。

## 工具链与打开方式

1. 新环境优先安装华为官方 DevEco Studio **26.0.0 Release**，截至 2026-11-16 正式版补丁为 **26.0.0.865**，使用集成的 HarmonyOS **26.0.0 Release SDK**。原始 26.0.0.821 发布说明列出的配套工具为 Hvigor **6.26.4**、ohpm **26.0.0.630** 和 Node.js **24.14.1**；安装后记录实际补丁及工具版本。本机已安装版本见下一项，无需为本次验证重装。用 DevEco 打开本目录，模拟器镜像另行下载。
2. 当前本机实际安装的是 **26.0.1.290 / SDK 26.0.1.120 Beta1 / Hvigor 6.26.20**，已用于本次编译。本工程 `modelVersion`、`targetSdkVersion`、`compatibleSdkVersion` 均为 `"26.0.0"`，使用 DevEco 配套 Hvigor 插件；不写死 `compileSdkVersion`，由当前 IDE 内置 SDK 决定。当前最低版本限定为已测试的 API 26，不声称支持早期系统，发布前须用确定的正式工具链复核。
3. 在仓库根目录执行 `npm run fixtures:generate`，生成 `entry/src/main/resources/rawfile/playback-check.wav`。它是 120 秒受控 WAV，未就绪时播放器会显示错误而不会伪造播放状态。
4. 同步工程依赖，选择 `entry/default` 和可用的手机模拟器，执行构建后运行。仓库根目录也可执行 `npm run harmony:build`，无需全局 `hvigorw`；`npm run harmony:build -- --clean` 会清理模块产物并重新编译。产物为 `entry/build/default/outputs/default/entry-default-unsigned.hap`。
5. `signingConfigs` 保持空。模拟器签名要求按实际设备类型和 DevEco 提示处理；真机调试时在本机配置调试签名，勿提交证书、Profile、私钥或包含密码的签名配置。

包名暂用 `com.yuqu.library`，正式创建应用、配置签名和发布前需确认归属及唯一性。

## 播放与生命周期

- `EntryAbility` 初始化并持有 `PlaybackService` 单例；页面只订阅快照，页面消失或进入后台不会释放播放器。
- rawfile 通过 `getRawFd` 的 `fd/offset/length` 播放；释放播放器后关闭描述符。
- 用户音频从同源 `/api/media/[id]` 加载，MediaSource 携带 Bearer 请求头，令牌不放 URL。切换音频先取消旧加载、释放旧资源，并以媒体标识和生命周期隔离晚到回调。`setMediaSource` 返回值使用 `Promise.resolve` 同时兼容返回 void 和 Promise 的系统实现；就绪只由实际播放器事件确认。
- 资料与导入默认折叠，支持音频链接、RSS 预览后选集、任务状态与失败重试。选择资料才接管播放；跟随另一设备切集时只更新标题和云端进度，不自动加载或出声。每集位置、倍率、循环状态独立保存。
- 支持播放、暂停、前后 15 秒、滑动定位、1/1.25/1.5/2 倍速及循环。
- 注册媒体会话的播放、暂停、定位和倍速指令；同步真实位置、状态与倍率。
- 播放成功后申请 AUDIO_PLAYBACK 后台任务；失败时暂停并显示错误。暂停、完成和释放时取消，任务操作通过同一命令队列串行执行。
- 耳机断开或音频被打断时保守暂停。即使收到恢复提示也等待手动继续，避免意外外放。DUCK/UNDUCK 由系统处理。
- 应用退出时清理播放器、会话与后台任务。进程被系统强制终止时不保证异步清理函数执行，最终仍由系统回收。
- 最近 18 条事件仅存在内存，用于观察状态，没有上传。

## 运行验证记录

2026-11-16 使用 DevEco 26.0.1.290 / SDK 26.0.1.120 Beta1 / HarmonyOS 7.0.0.107 手机模拟器完成下列观察，证据见上述记录。状态、位置、倍率和系统控制通过不等于人工听音通过；本轮没有录制或人工试听输出音频。

| 场景 | 预期 | 状态 |
| --- | --- | --- |
| 本地加载与播放 | 时长约 120 秒，音频可听，位置持续更新 | 模拟器时长与位置通过；听音待测 |
| 暂停和继续 | 音频与位置暂停；继续后恢复，后台任务申请状态一致 | 模拟器状态、位置及任务日志通过；听音待测 |
| 拖动及前后跳转 | seekDone 后实际位置对应目标，没有越界 | 模拟器通过 |
| 四档倍速 | 实际声音、计时和系统会话倍率一致 | 模拟器 UI 与媒体会话倍率通过；声音及各档连续计时待测 |
| 循环持续播放 | 到达末尾继续，开启循环后可持续观察 10 分钟 | 模拟器通过，后台 600 秒、15 个系统样本 |
| 切换应用 | 播放继续，回到页面仍显示真实位置 | 模拟器 Home 后返回通过；其他音频 App 竞争待测 |
| 锁屏和媒体控制 | 锁屏持续播放，系统播放/暂停/定位指令生效 | 模拟器 20 秒灭屏及系统卡片暂停/继续通过；系统定位与真机待测 |
| 耳机断开 | 保守暂停，无自动外放 | 未测试，需真机 |
| 来电或其他音频中断 | 播放暂停，UI 与媒体会话一致，恢复需手动操作 | 未测试，需真机 |
| 重新加载与退出 | 没有叠加音频或残留后台任务，可重新运行 | 模拟器重新加载通过，媒体会话唯一；应用退出清理及听音待测 |
| 错误处理 | 样本缺失或后台任务申请失败可见，不显示伪成功 | 未主动注入；初始化错误曾实际显示，修复后通过 |

后续已加入 `EventStream`、`AccountSync` 与 `SessionVault`：HTTP 流分片解析、恢复游标、有界重连；邮箱验证码和可撤销令牌；AssetStoreKit 的 SECRET、设备范围、不云同步存储。登录与进程重启默认跟随，主动接管才播放。播放时后台保留同步，暂停、跳转、倍率立即上报，播放期间约每 3 秒上报一次。

已完成真实模拟器登录、安全存储跨进程恢复、手机灭屏同步网页、网页接管暂停手机，以及双向回听/倍速同步，详见[本轮验证](../../docs/verification/accounts-playback.md)。调试时使用 `hdc -t <实际模拟器地址> rport tcp:3000 tcp:3000`，客户端服务地址填 `http://127.0.0.1:3000`。真实服务必须使用 HTTPS。

公开网络 MP3 已追加实际验证：从 185 秒续播、前后跳转、灭屏 30 秒持续上报、网页切集暂停手机，以及切回原集恢复原位置。资料、下载与跨端切集证据见[导入阶段验证](../../docs/verification/library-imports.md)。模拟器通过不能替代真实手机、耳机与来电验证。

## 官方依据

- [使用 AVPlayer 播放音频](https://developer.huawei.com/consumer/en/doc/doccenter-capabilities/using-avplayer-for-playback/)
- [后台播放接入](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/avsession-background-scene/)
- [媒体会话与系统播控](https://developer.huawei.com/consumer/en/doc/doccenter-capabilities/avsession-access-scene/)
- [后台任务 API](https://developer.huawei.com/consumer/en/doc/doccenter-references/api/js-apis-resourceschedule-backgroundtaskmanager/)
- [音频中断后的状态一致性](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/audio-kit-troubleshooting-0003)
- [DevEco Studio 26.0.0 配套版本](https://developer.huawei.com/consumer/en/doc/doccenter-release-notes/deveco-studio-new-features-2600/)
- [26.0.0 正式版补丁列表](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/overview-2600/)
- [工程级 SDK 版本配置](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-hvigor-build-profile-app/)
- [HarmonyOS 7 升级说明](https://developer.huawei.com/consumer/en/doc/doccenter-release-notes/upgrade-adaptation/)
