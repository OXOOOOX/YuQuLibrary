# 资料库、导入与网络音频验证

日期：2026-11-16。范围：本机网页、独立 PostgreSQL、持久导入 Worker、公开 RSS/MP3 及 HarmonyOS 7 模拟器。项目未部署到公网，真机尚未验收。

后续更新：本文保留初轮验证及两次 RSS 下载失败的历史记录。同一 RSS 任务随后第三次下载完整并通过网页、鸿蒙播放；严格断点续传及本机阿里模型验证见[后续记录](rss-local-asr.md)。

## 本轮实现

- 登录后的资料库、音频链接导入、RSS/Atom 预览与逐集选择，任务状态及失败重试。
- 按用户保存的持久任务、规范化 URL 复用、领取租约、最多 3 次尝试和私有媒体归属。
- 下载后的格式、真实时长、字节数及摘要检查；私有绝对目录存储；鉴权 GET/HEAD/Range 媒体接口。
- 两端使用实际媒体身份和时长，切集通过原子接管完成，按媒体保存位置、倍速和循环设置。
- 旧任务租约、旧播放代次或旧媒体的迟到结果不得覆盖当前结果。

B 站下载、字幕、转写、Codex 问答与云端聊天尚未实现。`ready` 表示音频就绪，不表示文稿完成。

## 环境与运行方式

网页仍为 `http://127.0.0.1:3000`，只监听回环地址；模拟器通过 HDC 反向转发访问。数据库沿用独立 PostgreSQL 18.7 的开发库和 `_test` 测试库。新增 `0003_library_imports.sql`，Worker 通过 `npm run worker:ingestion` 独立启动，和网页读取同一数据库及 `MEDIA_STORAGE_DIR`。

媒体保存在私有绝对路径，未使用云对象存储。没有改动 Cat 的凭据、数据库或独立 Bridge 运行实例。浏览器验证使用本机 Chrome 与随附 Playwright；Browser plugin not available。鸿蒙使用已有 DevEco/API 26 工具链和 YuQuPhone 模拟器，构建成功不等同于真机签名或发布完成。

本机网络会将部分公网域名解析到 `198.18.0.0/15` 保留 fake-IP，默认防护正确拒绝这些地址。本轮网络验证显式采用 `YUQU_PUBLIC_DNS=1`，通过固定公共 DNS TLS 端点解析；结果仍逐项过滤非公网地址并固定连接 IP，没有放开保留地址。源站可达性仍有波动。

## 实际结果

| 场景 | 观察与边界 |
| --- | --- |
| 公开 MP3 导入 | `filesamples.com/samples/audio/mp3/sample4.mp3` 与 `sample3.mp3` 均经真实 Worker 下载、入库并出现于资料库；两项均在第 2 次尝试成为 `ready` |
| 文件与实际时长 | 长样本完整读取 3,912,350 字节、约 244.506 秒；短样本 1,693,405 字节、约 105.822 秒。时长来自下载文件解析 |
| 网页实际播放 | Chrome 播放导入 MP3，185 秒位置保存成功，突破此前固定 120 秒限制；`live-import-results.json` 无 pageerror |
| 真实 RSS 预览 | `https://feeds.twit.tv/hot.xml` 解析为 Hands-On Tech (Audio)，实际界面显示 21 集；选择单集后建立并持久保存任务 |
| RSS 下载边界 | 选择的 Hands-On AI 短条目两次下载均失败，任务为 failed、attempts 为 2，错误为“音频下载或解析失败”；具体原因尚未确定。`live-rss-results.json` 的 passed 仅覆盖预览、选择和排队，未通过完整下载及播放验收 |
| 鸿蒙网络音频 | 实际 AVPlayer 加载带鉴权的网络 MP3，从已保存的 185 秒继续播放；原生前后 15 秒跳转后，网页保持静音并跟随正确媒体位置 |
| 导入 MP3 灭屏同步 | Home + Power 后确认系统 INACTIVE；30 秒内 10 次观测持续 playing，位置由 193,020ms 增到 223,141ms，修订号由 22 增到 32 |
| 灭屏时网页切集 | 网页切换至短音频，手机系统媒体会话观察为 paused；短音频 7 秒位置与标题同步到手机 |
| 逐集恢复 | 再切回长音频，恢复该集的 223,141ms / 244,506ms，未混入短集 7 秒位置 |
| 鸿蒙界面导入与选集 | 实际输入 `https://filesamples.com/samples/audio/mp3/sample3.mp3?yuqu-native=20261116` 并提交，观察到新持久任务；Worker 在第 1 次尝试完成下载、状态 ready。资料列表选择短集后，实际 AVPlayer 播放并上报对应媒体 |
| 最终原生构建 | 网络媒体修复版 HAP 构建成功，17.230 秒，并已安装用于上述联调；仍有未配置签名提示 |

上述原生流程由 `live-cross-library-results.json` 记录为 5 项通过、10 个灭屏样本。本轮发现 SDK 类型声明为 Promise，而部分原生实现返回 undefined；对 `setMediaSource` 使用 `Promise.resolve` 兼容，新增 undefined 与 Promise 返回的替身覆盖后重新编译并做真实联调。

另以 `native-library-live-results.json` 记录手机界面真实导入及选集播放两项通过。该次流程重新启动应用并恢复安全存储中的登录状态，再输入链接、收起软键盘后操作。早期脚本受到模拟器文本填充方式和软键盘遮挡影响，调整验证脚本后通过，未据此认定产品故障。

此前受控 WAV 的十分钟后台循环、锁屏控制及阶段二事件恢复结果保留在[账户与播放同步记录](accounts-playback.md)和[鸿蒙记录](harmony-build-emulator.md)。本轮新增网络 MP3 的结论以上表为准，不把 30 秒测试扩大为长时间、省电策略、耳机来电或真机保证，也没有人工试听验收。

## 限制与安全检查

| 项目 | 当前上限或规则 |
| --- | --- |
| 音频 | 100 MiB、4 小时、一次下载最多 5 分钟；MP3/M4A/AAC/WAV |
| RSS/Atom | 2 MiB、20 秒；扫描前 300 条记录、最多列出 100 个有效音频地址 |
| 预览频率 | 每用户间隔至少 5 秒 |
| 任务配额 | 每用户最多 50 条导入记录、同时排队或下载最多 5 项 |
| 重试 | 每任务合计最多 3 次尝试；普通失败显式重试，中断后过期租约可重新领取 |
| 租约 | 90 秒，每 15 秒续租；旧令牌或过期租约不得写结果 |
| 访问范围 | 公开 HTTP/HTTPS 标准端口；每次重定向重新校验，禁止内网、环回、保留地址和 URL 用户名密码 |
| 文件访问 | 账号及用户归属校验；同源鉴权媒体端点、单段 Range，路径不由客户端传入 |

下载流按真实字节限额；RSS 拒绝 DTD/实体声明。复核修复了 DNS 取消等待、预取消 Promise 拒绝、重定向后相对 enclosure 基址，以及 XML 数字实体导致 URL 截断的问题。提交结果不确定时保留可能已被引用的媒体文件，避免误删；自动孤立文件清理、删除和配额回收尚未实现。

来源检查中，Security Now 的某条音频返回 200 但声明 151,308,329 字节，因超过上限停止，未下载正文。其他公开来源出现响应后中断，或 RSS 超过 2 MiB；这些结果被保留为失败，未当作导入成功。

## 自动化、构建与证据边界

- `npm run check`：记录 38 个测试入口，21 通过、17 个数据库用例跳过、0 失败；另完成配置解析、类型检查和网页生产构建。普通 check 不加载专用数据库连接。
- `npm run test:integration`：独立 PostgreSQL 17/17 通过、零跳过。新增覆盖用户隔离/重复导入、租约并发与迟到写入、三次尝试及待处理配额、按集接管与历史恢复、鉴权 Range/HEAD/撤销。
- 原生服务替身覆盖加载代际、媒体切换及 Promise/undefined 返回；这些测试不代替实际 AVPlayer 行为，上表已单列模拟器结果。
- 本轮最终网络播放修复版 HAP 构建日志为 `harmony-network-fix-build.log`，并有安装后的真实联调证据。

真实测试邮件此前已由用户确认收到；两端使用外部邮箱完成申请、收码、验证码消费的完整流程仍待验收。没有在本轮新增发送邮件。

## 证据位置与待办

本机证据目录：`%USERPROFILE%\Documents\Codex\2026-11-16\yuqu-stage3`。

| 文件 | 说明 |
| --- | --- |
| `live-import-results.json` | 两条公开音频真实下载、入库、网页实际播放与 185 秒持久化 |
| `live-rss-results.json` | 真实 RSS 21 集预览、单集选择与持久排队；不包含最终下载成功证明 |
| `live-cross-library-results.json` | 鸿蒙网络 MP3、30 秒灭屏同步、网页切集暂停与逐集恢复 |
| `native-library-live-results.json` | 鸿蒙实际输入链接建立持久任务、资料列表选集后的 AVPlayer 播放及上报 |
| `full-check-final.log` | 最终网页生产构建、配置、类型与测试汇总 |
| `integration-final.log` | 最终独立 PostgreSQL 17/17 测试结果 |
| `harmony-network-fix-build.log` | 修复版原生构建 |
| `review/public-mp3-probes.json`、`review/additional-sample-probes.json` | 独立公开样本的完整读取、字节数及元数据结果 |
| `review/short-podcast-probe.json`、`review/short-enclosure-probe.json` | RSS 来源检查和未完整下载的独立网络证据 |

尚未完成：所选真实 RSS 音频完整下载/播放、导入媒体断网恢复与长期后台、M4A/AAC 等新增真实格式样本、真机与人工听音、两端真实验证码登录、公网 HTTPS/对象存储及生产运行、B 站下载、转写、AI 与聊天同步。`fish.sdspeed.com.cn` 尚未部署。
