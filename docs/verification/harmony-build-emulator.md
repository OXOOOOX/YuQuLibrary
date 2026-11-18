# 鸿蒙实际编译与模拟器验证

更新：2026-11-16。用户安装 DevEco 后继续执行，覆盖环境检测、实际 ArkTS 编译、HAP 检查及模拟器运行。已生成开发测试包，并在 HarmonyOS 7 模拟器通过基本播放、十分钟后台循环、灭屏持续播放和锁屏媒体卡片暂停/继续验证；编译成功、模拟器运行和真机验证分别记录。

## 实际安装环境

| 项目 | 实测值 |
| --- | --- |
| DevEco Studio | `C:\Program Files\huawei\DevEco Studio`，26.0.1.290 |
| 集成 SDK | `sdk/default`，HarmonyOS 26.0.1，26.0.1.120 Beta1，API 26 |
| Hvigor / 插件 | 6.26.20 / 6.26.20 |
| ohpm | 26.0.1.220 |
| IDE 内置 Node | 24.14.1 |
| IDE 内置 Java | JBR 25.0.2 |
| Emulator 工具 | 26.0.1.100 Beta1 |
| 系统 | Windows 10 Pro 64 位，Build 19045 |
| 虚拟化功能 | VirtualMachinePlatform 开启；HypervisorPlatform、Microsoft-Hyper-V-All 未开启；HypervisorPresent=true |

这是用户实际安装的 Beta 工具链，不能沿用此前文档的 26.0.0 正式版版本号。没有修改全局 PATH、Node/Java 配置或 Windows 功能，没有重启电脑。

尽管可选功能查询报告部分功能未开启，实际启动日志显示 `Windows Hypervisor Platform accelerator is operational`，且系统已正常开机、HDC 可连接。因此本机无需为了当前测试启用额外功能或重启；实际运行证据优先于仅凭功能标记推断。

## 构建结果：通过

已实际执行：

```powershell
npm run harmony:doctor
npm run harmony:build -- --clean
npm run harmony:build
```

构建命令自动生成两端测试音频，使用 IDE 内置 Node、ohpm 和 Hvigor，完成资源编译、ArkTS 编译和 HAP 打包；另行核对包内容。清理构建及运行时修复后的再次构建均返回 `BUILD SUCCESSFUL`，没有跳过 ArkTS 检查。

本轮修复：

- 移除写死的 `compileSdkVersion: "26.0.0"`，使用当前 DevEco 集成 SDK，解决配置错误 00303313。目标 SDK 仍为 26.0.0，兼容下限仍为 5.0.0(12)，后者尚未做实际设备兼容性测试。
- 异常重新抛出时明确转为 `Error`，满足 ArkTS 的 `arkts-limited-throw` 限制。
- 后台任务申请失败时复用暂停与清理逻辑，解决编译器对异步播放前后状态的错误窄化判断，保持失败后暂停的行为。
- 模拟器首次运行暴露 `audioInterruptMode` 设置时机错误：该属性只能在 prepared/playing/paused/completed 状态设置。已移到 `prepare()` 完成后，并在中断模式设置完成后才结束初始化。重新编译、覆盖安装后成功进入 prepared 和 playing。
- 环境检查现在能发现 IDE 集成工具；新增可重复的 `harmony:build` 命令，只对构建子进程设置环境。

产物：`apps/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`。

| 包检查 | 结果 |
| --- | --- |
| 大小 | 3,943,427 字节 |
| 包名 / 版本 | `com.yuqu.library` / `0.1.0` |
| SHA-256 | `37B23D78B5FA7C078C86D8DD0EAFE7C9B10853EB4F2786E7F0020B9AB4F9BE73` |
| 编译代码 | `ets/modules.abc`，65,772 字节 |
| 测试音频 | `resources/rawfile/playback-check.wav`，3,840,044 字节 |
| 设备类型 | phone、tablet |
| 签名 | 未配置；当前是未签名开发包，非正式发布包，真机安装需调试签名 |

配置解析通过，7 项现有事件解析测试通过。构建日志和包结构记录保存在本机 `%USERPROFILE%\Documents\Codex\2026-11-16\yuqu-stage1\harmony-build.log` 与 `harmony-package.json`。

## 构建警告的边界

- 当前 Hvigor 对模块版本使用主版本必须大于 0 的规则，因此合法的 `0.1.0` 也会触发 SemVer 警告；保留真实开发版本。
- 当前 Beta SDK 的 media/audio namespace 能力注释附有 `[since 12]`，检查器把后缀一并查表，产生 15 条设备能力警告。用 SDK 自带解析器核对，实际 Media.Core、Audio.Core、AVPlayer 能力均列在 phone/tablet 能力表中。未修改 SDK 或扩大权限；实际播放能力仍以设备测试为准。
- 两条可抛异常提示来自 `prepare()` 和 `pause()`；调用链已有 Promise 捕获或统一命令错误处理。正常加载与暂停已在模拟器运行通过，样本缺失及后台任务拒绝等故障尚未主动注入。
- `No signingConfig found` 与当前未签名产物一致，没有将构建成功视为签名完成。

## 模拟器准备与运行

官方 CLI 在线查询最高可用的 Phone Release 镜像为 **HarmonyOS 7.0.0(26.0.0)**，软件版本 **7.0.0.107**；未发现可通过该 CLI 下载的 26.0.1 Beta 镜像。首次查询没有已安装镜像或已有实例。

镜像及虚拟设备放在项目外的 `%USERPROFILE%\AppData\Local\Huawei\YuQuEmulator`，不提交到代码仓库。官方 CLI 两次下载未成功，分别停在 61.8% 与 99.3%；退出码为 0，但没有可识别镜像。随后按已安装 SDK 的官方清单取得同一镜像的官方 CDN 地址，使用 HTTP Range 分段续传完成下载，完整 SHA-256 与官方清单一致后解压；保留 ZIP 自带的 `sdk-pkg.json` 和镜像签名文件，没有自造清单或修改镜像。

| 镜像核验 | 结果 |
| --- | --- |
| ZIP 长度 | 2,090,038,765 字节 |
| 官方及实际 SHA-256 | `1604337b4808b4249c888e87d6aec4654240480177960d17685176020e356458` |
| 安装后 CLI 识别 | `downloaded: true`，7.0.0.107，Release |
| 虚拟设备 | YuQuPhone，Phone / x86_64，4 GiB 内存，8 GiB 数据分区 |
| 启动 | 成功，WHP 加速可用，镜像签名检查通过，HDC 可连接 |
| HAP 安装与启动 | `install bundle successfully`、`start ability successfully` |

公开下载元数据证据为本机 `yuqu-stage1/official-image-metadata.json`；下载文件已按 SHA-256 验证，不依赖网站账号凭据。

## 播放运行结果

| 检查 | 当前结果 |
| --- | --- |
| 初始化及重新加载 | 通过，真实时长 120 秒，播放器 prepared，无初始化错误 |
| 播放及暂停 | 通过，UI 时间与系统媒体位置推进；暂停后时间停止、后台任务显示已取消 |
| 前后 15 秒 | 通过，暂停状态下位置增减符合预期 |
| 四档倍速 | 通过，1 / 1.25 / 1.5 / 2 的 UI 与系统媒体会话倍率一致 |
| 滑动跳转、末尾循环 | 通过，跳转到末尾附近后继续播放并回到开头，状态仍为 playing |
| 系统媒体会话 | 已检查到本应用的唯一活动会话及 120 秒元数据；播放位置更新正常 |
| 十分钟后台观察 | 通过，按 Home 离开应用后观察 600,011 ms，15 个系统媒体会话样本均保持 playing、位置与更新时间推进，跨越多次循环；返回应用状态正常 |
| 灭屏持续播放 | 通过，20 秒观察期间播放器保持 playing、位置继续推进；独立 PowerManager 记录确认实际处于 INACTIVE，唤醒后恢复 AWAKE |
| 锁屏媒体卡片暂停/继续 | 通过，直接操作系统卡片后会话变为 paused，约 13 秒内位置保持 112,187 ms；继续后恢复 playing，跨循环推进到 9,772 ms。返回应用可见后台任务取消及重新申请成功记录 |
| 系统媒体卡片定位、耳机、来电 | 未测试；应用内跳转已验证，不能替代系统卡片定位或真实配件/来电场景 |

使用官方 Emulator 的 UI 树、点击和截图命令，以及 HDC/系统媒体会话读取验证。截图和原始观察记录保存在本机 `%USERPROFILE%\Documents\Codex\2026-11-16\yuqu-stage1\native-check`：`results.json` 记录主测试通过，`power-observation.json` 记录实际电源状态，`lockscreen-*.txt` / `lockscreen-*.md` 记录系统卡片操作及返回页面状态。后台任务申请/取消的依据为 API 完成后的应用状态与事件日志，系统任务列表命令在该镜像未返回详细条目；未将空输出作为通过证据。没有人工听音或录制输出音频。

补充核验 `lockscreen-controls-result.json` 比较系统卡片暂停/继续前后的媒体会话快照：暂停位置不变，恢复后约 17 秒内位置按循环时长连续推进。文档本地链接检查通过，共 30 条；19 个配置可解析，7 项现有事件解析测试通过。

测试结束已暂停播放，页面显示后台任务已取消，并正常停止本次启动的 YuQuPhone 模拟器。镜像、设备实例及已安装应用保留，可按[本地开发说明](../local-development.md)再次启动。

后续运行应检查实际设备状态，而不是只看 CLI 退出码。蓝牙耳机、来电、真实设备的锁屏长时播放和耗电最终仍需真机；当前没有执行这些真机场景。

## 官方资料

- [模拟器命令行](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-emulator-command-line/)
- [模拟器问题处理](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-emulator-faqs/)
- [开发与发布流程](../harmony-development-release.md)
