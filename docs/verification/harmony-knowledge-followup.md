# 鸿蒙收听、文稿与收藏补验

日期：2026-11-18。承接[下一阶段完善验收](listening-knowledge.md)，本次恢复配套构建环境，并完成实际 ArkTS 编译、HAP 安装和模拟器交互验证。未部署生产服务，未上传 AppTest，未做真机验收。

后续已修复两端返回原位置的网络恢复与异步退役边界，并补测后台引用停止、跨端接管和官方视频分 P／生命周期，见[恢复与生命周期补验](replay-recovery-video-lifecycle.md)。下文保留本次阶段产物，最终包以补验记录为准。

## 工具链与产物

使用本机已下载的官方 Command Line Tools 26.0.0.865，解压到仓库外独立目录；配套 SDK 26.0.0.105 Release、Hvigor 6.26.9、ohpm 26.0.0.630、Node 24.14.1。命令行包不含 JVM，复用本机 JBR 21.0.7，通过已忽略的 `.local/tooling/harmony-toolchain.json` 选择，不改变全局环境或覆盖原 IDE。

脚本同时保留 Studio 路径支持，显式 Studio 优先于显式 CLI、本地配置和默认目录；路径不完整直接报缺失。新增四项环境发现测试，覆盖路径映射、优先级、缺少 JVM 和错误配置。命令说明见[本地开发](../local-development.md)。[华为命令行构建说明](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-command-line-building-app/)

| 检查 | 本轮结果 |
| --- | --- |
| `npm run harmony:doctor` | 配套工具与 SDK 发现成功 |
| `npm run harmony:build -- --clean` | 完整 ArkTS、资源编译和 HAP 打包成功 |
| 修复后的 HAP 再构建 | `BUILD SUCCESSFUL`；实际覆盖安装、启动成功 |
| `npm run harmony:build -- --app` | Release `.app` 构建成功，仍未签名 |
| 最终 `npm run check` | 32 个配置解析、TypeScript、151 项测试和网页生产构建通过；51 项数据库测试按默认环境跳过 |
| 鸿蒙 library 行为测试 | 39 个场景通过；包含页面实际事件方法和延迟响应；不是 ArkUI 渲染的替代 |

仍有 SDK 设备能力、可抛异常、开发版本 SemVer 和未配置签名的警告；没有关闭类型检查或改写 SDK 来消除警告。模拟器沿用现有 YuQuPhone、HarmonyOS 7.0.0.107 Release 镜像，新 Emulator 26.0.0.402 成功启动；未清除原设备数据或改变 Windows 虚拟化设置。

| 最终产物 | 大小 | SHA-256 |
| --- | --- | --- |
| 实际安装测试的 Debug HAP | 4,519,398 字节 | `30f7674f06551181c2331162ee9abf0ee75430a1ef3bc5b7ce44179959399b53` |
| Release APP | 277,132 字节 | `3a69fe4bba2df09655285d4c7386b958859632f87dba573bc0c94e724db7f15b` |

已检查两者内含编译后的 `ets/modules.abc`。Release APP 位于 `apps/harmony/build/outputs/default/harmony-default-unsigned.app`；实际受测 Debug HAP 另存于本轮证据目录的 `native-tested-debug.hap`，避免后续 Release 构建覆盖同名 HAP。这些未签名产物不等于已可在手机安装。

## 修复的实际行为

- 无文稿条目的摘要允许 `null` 或省略，列表安全展示；错误摘要不会覆盖已加载列表。
- 收藏加载后续页、编辑备注时不再被每五秒的首页轮询覆盖；显式刷新仍可回到最新第一页。
- 列表读取与保存操作使用独立状态，保存途中切页仍会更新同账号缓存；旧账号返回不会污染新账号。
- 本集收藏缓存绑定实际媒体 ID，切换节目后不会把上期收藏当作本集显示。
- 删除正在编辑的收藏或其整期资料，会清理编辑状态；编辑项离开筛选后保留带来源标题的独立草稿与取消入口。编辑项仍在列表时就地编辑，第二页不会跳到屏幕外的编辑框。
- 迟到的“回到来源”请求不能覆盖用户新选的节目；退出登录也会使请求失效。
- 文稿、对话采用互斥标签，去掉点击后无法收起的误导文案。

## 真实模拟器验证

通过配套 Emulator/HDC 操作实际安装包，网页服务只监听本机回环地址，经 HDC 转发到模拟器。使用独立 `yuqu_test` 数据库、本地测试邮件、新建测试账号、受控两分钟音频与文稿。回答通过正式任务领取／完成流程注入明确的受控内容，不代表真实模型回答质量。

| 流程 | 可观察结果 |
| --- | --- |
| 登录与资料库 | 本地验证码登录成功；有文稿与 `transcript:null` 的条目均正常渲染 |
| 独立阅读 | 打开来源文稿保持原收听进度，标签可切换 |
| 全文搜索与提问 | 搜索命中、收藏搜索片段、从结果提问成功；数据库确认 `scope=selection`，冻结原文恰好 1 段 |
| 回答与引用 | 受控回答显示、引用原文展开、收藏回答成功 |
| 引用回听 | 从约 0 秒回听至约 6 秒自动暂停；返回原 1:00，保持暂停与 1.5 倍速；系统媒体会话与界面状态相符 |
| 收藏分页 | 20 条第一页继续加载到 23 条，超过一个轮询周期仍保持 23 条 |
| 第二页备注 | 编辑框在对应卡片内；保存后仍保留 23 条，切换资料库再回来仍显示新备注 |
| 应用重启 | 结束并重启应用，恢复测试登录；重新加载两页后仍显示已保存备注与 23 条收藏 |

已目视检查实际截图。模拟器不能代替手机的前后台、锁屏、网络切换、耳机和长时间播放验证；本轮也没有重测生产服务、真实邮件、真实 ASR 或 Codex 模型质量。前次独立数据库 51 项通过记录保留，本次未改服务端／迁移，因此未重新重建测试 schema。

## B 站官方视频：实际鸿蒙容器探针

在仓库外创建独立 `com.yuqu.videoprobe` 工程，只有 Internet 权限，无业务账号、原生网页桥、私有播放器接口或猜测消息协议。实际编译、安装后，直接以 Web 承载[官方嵌入播放器](https://player.bilibili.com/)，固定公开样本 `BV1B7411m7LV` / CID `168325345`。观察使用 [WebviewController](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-webview-webviewcontroller/) 与标准 HTML video 属性／方法；不是浏览器自动化跨域读取 iframe。

| 实际观察 | 结果 |
| --- | --- |
| 加载路径 | 默认移动端环境跳转到 `https://www.bilibili.com/blackboard/webplayer/mbplayer.html` |
| 就绪时序 | `onPageEnd` 时首次 `videoCount=0`，随后为 1、`readyState=4`；页面结束加载不等于媒体就绪 |
| 起播与采样 | 点击官方页面播放按钮后，从约 15 秒开始；每秒可读取推进的位置、暂停状态，实际 duration 为 589.6745 秒 |
| 标准跳转 | 设置 30 秒后，后续采样为 30.0 秒、`seeking=false`、`readyState=4`，而不是只检查赋值成功 |
| 整页暂停 | `pauseAllMedia` 将正在播放的视频停在 33.658134 秒；后续采样为暂停 |
| 整页停止 | 另一次启动，从实际 playing 状态调用 `stopAllMedia`，停在 30.760312 秒；61 个后续样本、约 59 秒位置不变 |
| 资源错误 | 观察到资源错误 `-2`，但 video 的媒体错误为空并可播放；未定位到具体资源，因此不宣称页面完全无错误 |

这证明**鸿蒙直接承载官方页面有实际可行的进度读取和控制路径**，不再因网页 iframe 跨域限制或缺工具链否定它。此次只测试一个公开视频和模拟器；尚未核实同长分 P、内部换集／连播、原 video 元素复用后的内容身份、所有权切换与过期回调、前后台／渲染退出，以及真机行为。URL、时长和标准 video 元素本身不能证明当前仍是请求的 CID，视频发布门槛仍未通过。鱼趣产品内视频入口保持关闭。

探针测试结束已停止播放，移除仅本轮安装的独立探针，并关闭本轮启动的模拟器；源码和证据保留在仓库外。

## 本机证据

目录：`%USERPROFILE%/Documents/Codex/2026-11-18/yuqu-next-stage/`。

- `harmony-recovery-build.log`、`harmony-final-debug.log`、`harmony-final-release.log`：实际编译与打包。
- `check-final-after-native-ui.log`：最终根检查。
- `native-final-packages.json`：最终产物、内容与哈希。
- `native-chat-source-check.json`：实际原生请求的冻结选段。
- `native-followup-ui-results.json`、`native-relaunch-results.json`：分页、备注和重启实测断言。
- `native-final-note.md`、`Screenshot_2026-11-18T154544.png`：真实收藏页面与备注。
- `native-video-probe/runtime-results.json`、`runtime-stream.log`、`seek-30.md`、`pause-all.md`、`stop-from-playing.md`：真实官方视频容器采样和控制证据；该目录还包含独立探针源码、构建结果与截图。

证据、工具链、测试数据和本机配置均不提交仓库。
