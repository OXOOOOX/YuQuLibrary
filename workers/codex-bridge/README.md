# Codex bridge 工作进程

本目录保留鱼趣的接入说明，不再承载本地 Worker 实现。Bridge 已从 Cat_Island 分离，独立项目为 [OXOOOOX/CodexBridge](https://github.com/OXOOOOX/CodexBridge)（私有），本机同级目录为 `CodexBridge`；它维护运行层、Codex 执行器和项目适配器，现有 Cat 实例已切换到该项目。

独立 Bridge 已实现鱼趣任务接口适配、流式问答和结果回传；鱼趣 API 及聊天记录保存在本项目的业务数据库。它通过 `https://fish.sdspeed.com.cn` 领取生产任务，使用鱼趣专属凭据，不读取 Cat 的业务数据库或令牌。

2026-11-18 本地候选新增选段／追问来源和 `yuqu.transcript.chapters.v1` 章节任务。章节仅接受模型标题、连续原文编号与续接标志，固定 JSON 输出且维持无工具执行；时间由鱼趣服务端计算。先领取交互问答，再领取章节，每批使用独立租约；旧 Bridge 不会领取未声明支持的章节类型。迁移、两端与 Bridge 须按[候选发布流程](../../docs/release-candidate.md)共同发布，本地验证不代表共享实例已升级。

P2 另增 `yuqu.chat.retrieval.v1`：输入是服务端已冻结的相关片段及完整文稿快照 metadata，最多 32 段／24,000 字符，Bridge 不访问数据库或自行重检索。独立严格 schema 保留原 chat parser；检索回答必须有合法引用，资料不足必须说明。声明新任务类型后才能领取，交互检索仍优先于章节；原有无工具、文件／网络隔离和租约规则保持。无命中由业务服务直接完成，不派 Bridge。两次隔离真实模型验证见[检索验收](../../docs/verification/retrieval-chat.md)，共享生产实例本轮未改动。

本机开发和生产真实问答均已完成验证。2026-11-17 后续将 Cat 与鱼趣合并到 `%LOCALAPPDATA%/CodexBridge` 的一个共享实例，按项目并行分流，默认总并发 2、每项目 1。原 `%LOCALAPPDATA%/CodexBridgeYuQuProd` 已停止且项目禁用；不应再单独启动。业务令牌、任务目录和服务端数据仍各自独立，现有 Cat v1 协议保持兼容。

线上本机阿里模型文稿已供网页整期提问和鸿蒙追问，回答及原文引用保存于生产数据库并同步两端，证据见 [生产验证](../../docs/verification/production-transcription-chat.md)。统一实例沿用已有 `CodexBridge.vbs` 登录启动入口；阿里 ASR 使用独立托管服务，登录自启动和故障恢复见[转写服务记录](../../docs/verification/asr-service-storage.md)。并行实现及切换详情见独立仓库 `docs/shared-runtime.md`。
