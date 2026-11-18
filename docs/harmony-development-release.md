# 鸿蒙开发测试与发布流程

核对日期：2026-11-16。鱼趣采用 ArkTS、ArkUI 和 Stage 模型开发原生鸿蒙应用。用户已具备实名认证的华为开发者账号，手机为 HarmonyOS 7，当前不能通过 USB 连接，因此先推进桌面模拟器。

## 当前电脑与工具选择

电脑为 Windows 10 Pro 64 位 Build 19045，约 32 GiB 内存，首次检查时 C 盘空闲约 201 GiB，CPU 支持硬件虚拟化。可选功能查询中 Windows Hypervisor Platform 标记未开启，但实际模拟器日志确认 WHP 加速可用，系统正常启动并完成播放测试。本机不需要为本轮测试额外修改虚拟化功能或重启；后续诊断以实际运行结果为准。

本机已安装 DevEco Studio，目录为 `C:\Program Files\huawei\DevEco Studio`，实际版本 **26.0.1.290**，集成 SDK **26.0.1.120 Beta1**、Hvigor **6.26.20**、ohpm **26.0.1.220**。已完成实际编译，生成未签名 HAP，并在 HarmonyOS 7.0.0.107 模拟器通过基本播放、十分钟后台循环、20 秒灭屏及锁屏卡片暂停/继续测试；没有修改 Windows 功能、BIOS 或执行重启。证据见[运行记录](verification/harmony-build-emulator.md)。

当前官方推荐 DevEco Studio 26.0.0 Release 与配套 SDK 26.0.0；截至核对日，Windows/macOS 正式版补丁为 26.0.0.865（2026-10-31），测试版按需使用。系统营销名称、SDK 版本和 API 级别不是同一个字段，不能把“OS 7”直接填成“API 7”。源码采用的兼容基线也不代表已经在所有对应设备上测试通过。[官方版本清单](https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/overview-2600/)

## 先在桌面模拟器运行

1. 从[华为官方下载中心](https://developer.huawei.com/consumer/cn/download/)下载 Windows 正式版 DevEco Studio，使用已有开发者账号完成所需登录。
2. 安装包已集成 SDK、Node.js、Hvigor、ohpm 和 Emulator 工具；安装后运行 IDE 环境诊断。模拟器系统镜像另行下载。安装 IDE 和编译代码不需要先启用虚拟化；启动模拟器时是否需要启用 Windows 功能，以当前诊断与官方说明为准。需要重启时先保存其他工作。[官方安装指南](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-software-install)
3. 在鱼趣仓库运行 `npm ci`、`npm run fixtures:generate`，生成鸿蒙 rawfile 测试音频。
4. 用 DevEco 打开 `apps/harmony`，完成工程同步；或者在仓库根目录执行 `npm run harmony:build`。工程已按实际 SDK 校准编译配置，后续更换工具链仍需重新构建。
5. 进入 `Tools → Device Manager`，创建本地 Phone 模拟器，选择适合目标系统的可用镜像，下载并启动。界面名称以安装版本为准。
6. 选择模拟器和 `entry` 模块，点击 Run，检查播放、暂停、跳转、倍速和媒体控制。
7. 切换到模拟器桌面或其他应用，观察声音与播放位置是否持续，记录媒体会话和后台任务状态。

普通本地模拟器 HAP 调试通常不需要配置应用调试签名，部分 Kit 另有要求；下载、注册模拟器涉及的开发者账号授权与应用签名是两回事。[自动签名文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto/)

官方 Windows 模拟器要求包括专业版等受支持系统、x64 虚拟化支持、至少 16 GB 内存及足够磁盘空间，图形支持也需要检查。IDE 与镜像下载的总体空间应单独预留。[模拟器使用环境](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-emulator-requirements/)

预览器主要用于 UI，模拟器可以验证应用运行和许多播放流程，但二者都不能证明真实设备的锁屏长时播放、蓝牙切换、来电中断及耗电表现已通过。

## 后续真机调试与安装

1. 在手机启用开发者选项和 USB 调试，连接电脑，并在手机确认调试授权。
2. DevEco 识别设备后，在 Project Structure 的 Signing Configs 配置调试签名，通常优先自动签名。
3. 使用自己的实名开发者账号完成所需签名流程。工程包名、设备和签名 Profile 必须匹配；暂定包名 `com.yuqu.library` 在正式注册前还需确认可用性。
4. 选择真机点击 Run，由 DevEco 构建并安装 HAP。也可在准备好有效签名的 HAP 后使用 hdc 安装。
5. 按验证记录执行锁屏、后台、耳机、来电和网络切换测试。

这属于开发调试安装。鸿蒙原生工程产物是 HAP，不是 Android APK；不能把任意未签名的包直接当成普通文件侧载。自动签名支持关联或未关联注册应用的路径，不要求所有本地调试都先完成正式上架应用创建。[真机调试说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-faqs/app-debugging-faq-0005/)

## 功能完成后的测试分发与上架

2026-11-17 已生成鱼趣 Release `.app`，并按手机暂不能 USB 连接的情况准备 AppTest 云签名与仅本人内部测试路线。实际产物、后台待确认项及当前 DevEco 上传操作见 [AppTest 准备](harmony-apptest-preparation.md)。目前未上传或完成真机安装，本文下列一般流程不表示已经执行。

1. 在开发者中心及 AppGallery Connect 准备应用身份。APP ID 与工程 bundleName 不同，相关配置必须对应同一应用。
2. 先进行内部测试，再按控制台开放的能力选择邀请或公开测试；测试分发不等于已经全量上架。
3. 用 Release 配置生成 `.app` 发布包，使用发布签名。当前工具支持的自管证书或云管理证书方式按安装版本与 AGC 流程选择，不复用调试签名作为正式发布配置。
4. 准备名称、图标、介绍、截图、隐私说明、权限用途、联系信息、审核测试方式，以及适用于运营主体、地区和服务内容的材料。账号与 AI 功能的实际行为需与声明一致。
5. 上传包、通过检测、提交审核，按反馈修正后选择发布。

本阶段没有操作 AGC 应用、生成发布证书或提交审核。发布细节应在功能完成后再次核对。[DevEco 发布指南](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-publish-app/)、[原生应用发布说明](https://developer.huawei.com/consumer/cn/doc/app/agc-help-release-app-0000002271695230)、[上架自检清单](https://developer.huawei.com/consumer/cn/doc/app/50170/)
