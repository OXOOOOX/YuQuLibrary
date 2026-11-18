# 鱼趣知识库：AppTest 真机分发准备

## 2026-11-19 发布候选

鱼趣知识库已用配套的 DevEco Command Line Tools 26.0.0.865 和 SDK 26.0.0.105 Release 重新构建。应用为 `com.yuqu.library`，沿用 `0.1.0 / 1000000`，APP ID 为 `6917622039742660061`。本次交付到本地未签名包阶段。

| 交付项 | 位置或核对结果 |
| --- | --- |
| DevEco 上传时选择的工程产物 | `apps/harmony/build/outputs/default/harmony-default-unsigned.app` |
| 本机留档 | `out/apptest/2026-11-19-697c8dc/`，含 APP、配套符号表、两个尺寸的图标、校验清单和检查日志 |
| 未签名 APP | 335,496 字节，SHA-256 `0ce97ed583055e22f1f53d3900f3005ec1ede453d4a5dfe6491410aeeb3acddc` |
| 包内核验 | 外层和内层均声明正式 Release API。内层 `module.json` 为 `buildMode=release`、`debug=false`、编译 SDK `26.0.0.105`。手机和平板最低及目标 API 均为 26 |
| 项目检查 | 42 个配置解析通过、类型检查通过、183 项测试通过、网页生产构建通过。默认检查跳过 72 项测试；鸿蒙另行执行了实际 Release APP 构建 |
| 正式服务 | 从公网匿名访问，健康接口返回 200，隐私页返回 200 且存在反馈邮箱与数据权利章节，资料列表返回 401 |

### 从候选包到手机安装

1. 登录华为开发者中心，选择上述鱼趣 APP ID，核对已发布版本、可用邀请渠道及群组成员。11 月 17 日最后一次后台实查中，旧 AppGallery 草稿绑定了 Beta 包 `build 1`，仅含本人，提交时触发 Beta API 提示后仍为“准备提交”。11 月 19 日打开开发者中心时要求重新登录，当前 AppTest 开通情况与后台版本待复核。[历史后台记录](verification/apptest-preparation.md#云签名上传后实际提交)
2. 在正式版 DevEco Studio 打开 `apps/harmony`，依次选择 **Build → Upload Product → Testing Only**，选取上表工程产物，核对团队、包名后云签名上传。本机已验证正式版命令行工具链，并已找到华为签名有效的同版 Windows IDE 安装程序。上传向导只列工程 `build/outputs` 下的软件包。重签后记录实际构建号、上传时间和检测结果，再选新包。[华为构建与云签名说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-publish-app/)
3. 按本轮目标使用 **AppTest 客户端**。如果鱼趣已切换到 AppTest，在该渠道新建邀请测试版本并核对仅本人参与，旧 AppGallery 草稿中的文案和素材可供填写。若入口仍未开放，可使用已备好的开通申请；既有 AppGallery 草稿继续保留。11 月 17 日草稿测试期为 11 月 18 日至 12 月 2 日，新建时按实际提交日设置有效时间。[AppTest 开通与流程](https://developer.huawei.com/consumer/cn/doc/app/agc-help-apptest-invite-test-guide-0000002258174270/) · [切换测试渠道的要求](https://developer.huawei.com/consumer/cn/doc/app/agc-help-invite-test-faq-0000002363660365/) · [填报资料及工单备稿](apptest-submission-materials.md)
4. 发布生效且到达测试时间后，在 API 26 或更高版本的手机上使用受邀华为账号打开 AppTest 安装。先验证邮箱登录、手机与网页同步、引用回听，再验证锁屏、切网、来电及耳机断开。新版包的平台检测、测试分发和真机体验均待验证。

<details>
<summary>2026-11-17 首次准备过程（历史 Beta 包）</summary>

核对日期：2026-11-17。目标：手机暂时不能连接 USB 时，通过邀请测试安装鱼趣测试版。当前沿用 AppGallery 外部群组，仅邀请本人；AppTest 开通工单暂缓。

AppTest 可以让手机通过测试邀请安装应用，不必走 USB 安装流程。本轮已创建鱼趣应用身份并保存邀请测试资料草稿；当前后台仅显示外部测试群组，没有 AppTest 内部测试入口。用户已建立仅含本人的外部群组，可先走 AppGallery 邀请测试；证书、软件包上传及测试发布尚未完成。实际后台状态及可复制文本见[填报资料](apptest-submission-materials.md)。[华为 AppTest 流程](https://developer.huawei.com/consumer/cn/doc/App/agc-help-apptest-invite-test-guide-0000002258174270/)

## 当前已准备与待完成项

| 项目 | 当前结果 |
| --- | --- |
| 开发者账号 | 已登录后台，主账号显示已认证；新版协议由用户本人同意 |
| 本机工具 | DevEco Studio 26.0.1.290，SDK 26.0.1.120 Beta1，环境检查通过 |
| 工程 | `%USERPROFILE%/Documents/GitHub/YuQuLibrary/apps/harmony` |
| 应用信息 | 名称“鱼趣知识库”；包名 `com.yuqu.library`；当前版本 `0.1.0`，版本号 `1000000` |
| 当前连接设备 | 仅 API 26 模拟器，没有真机；真机系统 API 尚未核对 |
| 签名 | 项目尚无签名配置；模拟器未签名 HAP 不作为 AppTest 分发包 |
| 应用身份与测试入口 | APP ID `6917622039742660061` 已创建；包名匹配；当前 AppGallery 外部群组仅本人，AppTest 内部入口未开放不阻断当前路线 |
| Release 包 | 已执行 `npm run harmony:build -- --app`，项目级 Release `assembleApp` 成功；包内包含 `entry-default.hap`、`pack.info`、`pac.json`，仍未签名 |
| 待实际执行 | DevEco 云签名上传、关联现有外部群组、提交邀请测试、手机安装及回归 |
| 待平台处理 | 上传包需通过平台检测；测试版本按当前 AppGallery 流程审核；不等待 AppTest 开通 |
| 正式地址与隐私 | 鸿蒙新会话默认正式 HTTPS 域名；Release 隐藏服务地址及诊断入口；网页和鸿蒙均可打开已上线的 `/privacy` |
| 测试资料 | 图标、文本、隐私网址和 11 月 18 日至 12 月 2 日测试时间已保存，负责人实名及手机验证已由本人完成。应用基础信息已保存；“下一步”当前仅提示软件包缺失，登录方式仍待最终审核 |

## 最短操作路线

### 1. 登录后台，确认应用身份和 AppTest 入口

在 HarmonyOS 开发者中心的“开发者管理 → ID、证书和 Profile → APP ID”查看是否已有鱼趣。若需新建，类型选择 HarmonyOS 应用，包名必须与工程的 `com.yuqu.library` 完全一致，应用分类为“应用”，本次先面向手机，语言选择简体中文。包名创建后不能修改，先核对可用性。[创建 HarmonyOS 应用](https://developer.huawei.com/consumer/cn/doc/App/agc-help-create-app-0000002247955506/)

再进入“应用管理”，切换到鱼趣，查看“分发 → 应用测试 → 测试用户／测试版本列表”。当前已有 AppGallery 邀请测试草稿和本人外部群组，直接沿用。若将来改用 AppTest，再按官方开通说明联系支持；当前不发送工单，也不把 AppTest 开通作为前提。[AppTest 开通说明](https://developer.huawei.com/consumer/cn/doc/App/agc-help-apptest-invite-test-guide-0000002258174270/)

### 2. 用现有 DevEco 的云签名上传测试包

最新包位于 `%USERPROFILE%/Documents/Codex/2026-11-17/yuqu-stage12/yuqu-0.1.0-apptest-beta-unsigned.app`；工程输出为 `apps/harmony/build/outputs/default/harmony-default-unsigned.app`。更新代码后可在仓库执行 `npm run harmony:build -- --app` 重新构建，或在 DevEco 选择 Release 后使用“Build → Build Hap(s)/APP(s) → Build APP(s)”。当前配套 SDK 为 Beta1，平台接受性、检测和真机结果仍须单独核对；本地编译成功不能作为已满足 AppTest 上传要求的结论。

之后进入“Build → Upload Product”，登录开发者账号，核对团队和鱼趣包名，选择本轮 `.app`，选择 **Testing Only**，按向导关联上一步的应用。不要把未签名 `.app` 直接当作手机安装文件。

当前 DevEco 26.0.1 支持上传时重新签名：Testing Only 使用云管理证书和 Profile，只用于测试。这里不需要先为手机制作 USB 调试签名，也不需要为了这条路线手动生成本地证书。上传成功还要核对平台的软件包检测结果；“上传完成”不等于手机已经可以安装。[DevEco 构建与上传说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-publish-app/)

本机另已安装 `@deveco/deveco-cli@1.3.0-stable`，入口为 `devecocli`。实查帮助未提供云签名上传或发布命令；官方文档说明 `signature generate` 用于调试签名，不能替代这里的 Testing Only 上传流程。未执行该命令生成调试签名，也未改工程签名配置。[CLI 命令说明](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-deveco-cli-options/)

### 3. 沿用仅本人参与的外部群组

在“分发 → 应用测试 → 测试用户”核对“测试用户群组-1”。本轮已确认外部群组只有本人 1 位用户，无需新建群组或扩大应用后台访问权限。

打开现有“鱼趣首轮手机与网页同步测试”草稿，选取刚上传的软件包，再选择上述外部群组。负责人实名和手机验证、图标、说明、隐私网址、测试时间以及应用基础信息均已补齐保存。鱼趣采用邮箱验证码登录，备注已说明实际登录方法；用户取消了需要账号密码的审核登录勾选，当前“下一步”仅提示软件包缺失，最终审核接受性尚未验证。不能填写不存在的密码或加入万能验证码。[AppGallery 测试版本配置](https://developer.huawei.com/consumer/cn/doc/App/agc-help-appgallery-release-testapp-0000002258174266/)

当前走 AppGallery 外部邀请测试，应按平台流程提交审核，待版本通过并生效后分享给本人。尚未提交审核、发布版本或发送邀请，不套用 AppTest 内部测试免人工审核的规则。

### 4. 手机接收邀请并安装

当前 AppGallery 测试版本审核通过并生效后，通过分享链接进入华为应用市场“应用尝鲜”，手机使用已加入群组的华为账号获取鱼趣。这个流程不要求 USB 连接。若将来切换 AppTest，才使用 AppTest 客户端，并按官方要求重新创建对应测试版本。[AppGallery 发布与分享](https://developer.huawei.com/consumer/cn/doc/App/agc-help-appgallery-release-testapp-0000002258174266/)

安装后先验证：真实邮箱登录、引用回听、锁屏收听、网页进度跟随、切网恢复、耳机断开和来电中断。工程当前兼容下限 API 26；手机若低于此版本，需要先评估代码兼容性，不能仅改配置数字。

## 内部与外部测试怎么选

| 路线 | 适用对象 | 本项目现在的选择 |
| --- | --- | --- |
| AppGallery 外部邀请测试 | 已加入所选外部群组的用户 | 当前路线，仅本人 1 位用户，从应用市场“应用尝鲜”安装 |
| AppTest 内部测试 | 有该 APP 后台权限的开发者账号；最多 100 位内部用户 | 当前未开通，不阻断上述路线 |
| AppTest 外部测试 | 无需拥有应用后台权限，可通过外部群组和邮件／公开链接邀请 | 首个构建需全面审核，后续构建通常基本审核；暂不创建公开链接或邀请其他人 |

内部与外部群组是不同的分发范围。外部用户可使用邮箱格式的华为账号，或通过群组公开链接加入；无需为了外部测试给对方应用后台权限。公开链接可被转发，本轮不启用。[外部群组](https://developer.huawei.com/consumer/cn/doc/app/agc-help-apptest-create-externalgroup-0000002486414168/)、[测试方式比较](https://developer.huawei.com/consumer/cn/doc/app/agc-help-public-test-overview-0000002259136294/)

## 三种签名不是同一件事

| 方式 | 用途 | 是否需自己保管签名私钥 |
| --- | --- | --- |
| DevEco 自动调试签名 | 将调试包安装到登记的真机；需要匹配调试设备 | 本地产生调试签名文件；不作为这次 AppTest 路线前置条件 |
| DevEco 上传时自动管理签名／云管理证书 | `.app` 上传 AGC 测试或发布时重新签名；本次选 Testing Only | 私钥由华为云端管理，开发者不能直接读取；无需手动保管 `.p12` 私钥 |
| 手动管理发布签名 | 使用自己创建或导入的发布证书及 Profile 签名 | 需要自行保管密钥、密码、证书和有效期；本次没有采用此路线 |

云签名是签名管理方式，不会自动替代 AppTest 开通、应用身份确认、版本检测或外部测试审核。[云管理证书与传统证书比较](https://developer.huawei.com/consumer/cn/doc/app/agc-help-cloud-cert-0000002572233173/)、[自动调试签名](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing-auto/)

用户现已创建外部群组并加入本人，可以沿用 AppGallery 邀请测试，经发布后从应用市场“应用尝鲜”安装。下一步完成签名上传、关联群组与测试提交；AppTest 工单暂缓。当前未通过平台软件包检测，未在真机运行。最新实际状态以[填报资料](apptest-submission-materials.md)为准。

</details>
