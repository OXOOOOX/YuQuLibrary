# 回听返回恢复与官方视频生命周期补验

日期：2026-11-18。承接[收听与知识整理验收](listening-knowledge.md)和[鸿蒙补验](harmony-knowledge-followup.md)。本轮仅本地完成，没有部署服务、上传 AppTest、签名分发或重启生产 ASR／Bridge。

## 两端回听返回修复

原行为：从引用片段返回原位置时，只要请求失败，两端都会清掉返回点。请求可能尚未提交，也可能已经提交而响应丢失；只恢复按钮仍不够，因为失败时本地播放控制权也已撤销。

- 返回操作保存原 requestId、generation、playbackSessionId、媒体、位置、倍速、循环与播放／暂停状态。临时失败后保留入口，同一次返回使用完全相同的请求重试。
- SSE 已确认下一代而 HTTP 响应丢失时仍可重试；下一代快照只允许保留入口，必须由服务端确认原请求 accepted 才重新建立本机播放控制。
- 明确冲突、永久拒绝、其他设备／同登录标签页接管时清除旧返回；不会改用最新代次抢回播放。
- 退出、同步 reset／重新连接会退役未完成操作。旧 finally 不清除新返回点，也不会让新回听永久处于处理中。
- 新主动接管或引用回听会替换旧待确认返回。原问答及收藏的冻结来源保持不变。

服务端已有同请求幂等与严格恢复条件，本轮没有改数据库契约或迁移。

## 最终检查与测试包

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 32 个配置解析、TypeScript、162 项测试和网页生产构建通过；51 项数据库测试按默认环境跳过，失败 0 |
| 鸿蒙 library 行为场景 | 53 个通过，新增返回失败／SSE 时序／同会话接管／退出与 reset 退役／加载失败重试覆盖；是实际源码的隔离验证，不替代渲染 |
| 网页专用回归测试 | 新增 `tests/web-restore.test.mjs`，11 项通过，直接编译当前 Hook；覆盖响应丢失、SSE 前后、接管、永久拒绝、退出与 reset 后新返回点 |
| 鸿蒙 Debug HAP、Release APP | 实际 Hvigor 编译和打包通过；Debug 包已安装并完成下述模拟器验证。仍有 SDK 能力／可抛异常／SemVer／未签名警告，没有关闭检查 |

| 本轮产物 | 字节数 | SHA-256 |
| --- | --- | --- |
| 受测 Debug HAP（证据目录 `native-tested-debug.hap`） | 4,524,613 | `ec216ab370d497270fa070203b6efcfd4da049cba13c166807bffbe465054294` |
| Release APP（`apps/harmony/build/outputs/default/harmony-default-unsigned.app`） | 278,091 | `c76a2b586ebe262b3cff6cb9f979b8d520168451f8683c16ded7cd2bdb1e5432` |

Release 未签名，不等于手机可安装，也未上传或分发。

## 实际应用验证

使用独立 `yuqu_test`、受控账号、两分钟音频和 0–6 秒引用；只监听本机地址。原生请求经本机故障代理，网页直接访问测试服务。代理不改产品下载规则，不记录令牌、Cookie 或音频内容。

| 场景 | 实测结果 |
| --- | --- |
| 鸿蒙：返回请求提交前断开 | 按钮保留、失败后本机静音；重试请求体完全一致；服务端只增加一代 |
| 鸿蒙：提交后丢响应，SSE 保持 | 按钮保留；重试回到 60,000 ms，保持暂停、1.5 倍速与原循环状态；只增加一代 |
| 鸿蒙网络库自动重发 | 首次单次断开被自动重发掩盖；改为持续阻断直到手动重试前解除，才验证到失败界面。自动／手动重发均保留原请求编号 |
| 鸿蒙：短引用切后台 | Home 后在 6,134 ms 暂停；云端和系统媒体会话均已记录；回前台保持暂停 |
| 鸿蒙：后台期间网页接管 | 回前台清除旧返回、本机暂停；网页代次及会话不被覆盖 |
| Chromium：提交前失败、提交后丢响应 | 两种均保留入口、同请求重试；恢复误差小于 0.4 秒，保持暂停、1.5 倍速及循环状态；只增加一代 |
| Chromium：同 Cookie 另一标签接管 | 旧页返回入口消失、音频暂停；不再发送恢复请求；新标签保有代次 |

浏览器插件不可用，使用已有 Playwright／Chromium，无新增依赖。核对标题、有效内容、框架错误层和运行时错误，三个恢复场景无未处理页面错误；丢弃请求属于受控故障。鸿蒙采用实际 ArkTS/HAP 编译、安装、Emulator/HDC UI 和系统媒体状态，截图已目视检查。

这些证据不替代手机无线网络切换、长时间后台、锁屏／耳机、自然播客准确率或真实模型质量验收。媒体加载途中被接管目前仍由隔离行为测试覆盖，未另做原生解码器延迟实测。本轮不重建 schema；前次 51 项独立数据库测试记录保留。

## 官方 B 站播放器分 P 与生命周期

仓库外独立 `com.yuqu.videoprobe` 承载[官方播放器](https://player.bilibili.com/)，使用标准 video 属性及 [WebviewController](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-webview-webviewcontroller/)。不使用私有播放器对象、猜测消息协议、原生网页桥或业务账号。

样本 [BV1bK411W797](https://www.bilibili.com/video/BV1bK411W797/) 的 P2/CID `191559297`、P3/CID `191559859` 公开元数据均标 98 秒；实际 duration 为 **97.941111 秒**、**97.05898 秒**。仅验证了“标注时长相同”，没有完成“实际时长完全相同”的身份检验。

| 观察 | 结果与限制 |
| --- | --- |
| P2 播放、暂停、恢复 | 推进至约 5.12 秒；系统 pause 停在 7.202864 秒；resume 后推进至 11.104207 秒 |
| P2 跳到末尾 | ended=true，停在 97.941111 秒；之后约 20 秒仍暂停，ended 计数为 1，未观察到自动切 P。不能推断所有视频都不连播 |
| 宿主切 P3 | 先停止并移除旧 Web，再建新实例；新页可播放。requestedCID／URL 参数只是请求身份，仍不能认证播放器内部内容 |
| 播放中进入后台 | 退役实例、停止采样、移除 Web；回前台 UI 无 Web、无新有效采样，需要显式重建 |
| 显式重建／停止 | 新实例初始 0 秒且 paused=true；手动播放后才推进；停止并移除后 UI 无 Web |
| 异步采样 | 记录请求起止、页面／实例／video 元素代次和标准事件。143 条记录没有触发迟到丢弃分支；该分支仍只有隔离验证 |

移除后没有有效媒体采样，不能把此前最后的 playing 样本当作后台当前状态，也不据此宣布解码资源已完全回收。仍有未定位资源错误 `-2`。渲染进程退出、播放器内部换 P／元素复用后的身份与真机均未覆盖。

鸿蒙进度读取与控制继续获得实测支持；**当前 CID 认证与内部换集检测仍未满足发布条件**。鱼趣视频入口继续关闭，网页跨源进度能力也不因鸿蒙实验而自动通过。

## 证据目录

`%USERPROFILE%/Documents/Codex/2026-11-18/yuqu-runtime-followup/`

- `harmony-library-results.json`：实际服务源码的隔离行为场景。
- `native-restore-results.json`、`native-peer-results.json`、`proxy-events.json`：原生故障恢复与跨端实测。
- `native-background-media.txt`、`native-restore-*-retry.md`、`native-peer.md` 和截图：实际 UI／系统媒体。
- `web-restore-results.json`、`web-restore-final.png`：实际 Chromium 故障与同 Cookie 接管。
- `video-runtime.log`、`video-analysis.json`、`video-marks.json`、`video-*.md`：官方播放器采样、操作及截图时间点。
- `harmony-build.log`、`harmony-release.log`、`native-tested-debug.hap`：构建与实际受测包。
- `check-final.log`、`native-final-packages.json`：最终根检查与产物哈希。

工具链、探针、故障代理、媒体、截图和二进制留在仓库外或忽略目录，不提交产品仓库。

验收结束已移除本轮独立视频探针、停止本轮模拟器、故障代理、本地网页服务和独立测试数据库；保留测试数据及证据，没有停止生产转写或 Bridge。
