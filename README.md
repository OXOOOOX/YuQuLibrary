# 鱼趣知识库

鱼趣知识库让用户在鸿蒙手机或网页中收听内容，并随时向 AI 提问。播放位置、文稿和聊天记录由云端保存，两端可以继续同一段收听和对话。

网页主界面保持简洁：**一个标题、一条进度、一个对话区**，外观接近普通 AI 聊天窗。手机端支持后台收听和边听边问。

## 当前状态

2026-11-18 本地完善已实现固定提问位置、选段与追问、全文关键词搜索、轻量收藏／备注、回听恢复、AI 章节导航、长节目检索问答，以及分段与整期总结。本轮总结升级为约 5 分钟分段、每段最多 12 个要点，再按主题保留全部已生成叶要点，按需分页阅读并展开冻结原文；旧结果可显式重新整理且保留原依据。主题分组的完整性由服务端校验，叶要点是否遗漏原文主题、每点引用是否完整支持陈述仍须内容审计。本轮固定长教程 12 个主题全部覆盖，141 个叶要点完整归组；此前短样本漏引与补充／纠正回归通过，网页及鸿蒙模拟器主题分页、实际回听均完成。仍保留 ASR 歧义和多人自然内容待验边界，尚未部署。详见[开发计划](docs/development-plan.md)、[主题覆盖与引用完整性验证](docs/verification/summary-coverage.md)、[上一轮真实内容复验](docs/verification/summary-quality.md)和[候选发布流程](docs/release-candidate.md)。

已上线网页与鸿蒙引用回听：展开原文保持播放不变，点击按钮才在当前设备从引用起点播放，草稿与原问题位置保留。真实生产鸿蒙引用 9.280 秒的起播事件已核对。首轮固定公开标注转写质量评测已完成，仍发现漏词、同音字及短重复，不能宣布准确率达标。见[本轮验证](docs/verification/citation-replay-signing.md)与[质量基线](docs/verification/asr-quality-baseline.md)。测试分发 Release `.app` 已构建，隐私页已上线，应用身份与测试资料草稿已在华为后台创建，尚未云签名、上传或发布；用户已建立仅含本人的外部测试群组，见[分发准备](docs/harmony-apptest-preparation.md)、[填报资料](docs/apptest-submission-materials.md)和[验证记录](docs/verification/apptest-preparation.md)。

已完成转写登录自启动、崩溃恢复和资料容量管理：网页与鸿蒙均可“清理音频”保留文稿聊天，或确认后删除整期资料；支持独立阅读与提问，默认每账号 1 GiB 音频额度。真实生产样本从已保存的 30 秒自动续写完成，鸿蒙清理后问答、整期删除和文件回收均已验证。见[本轮验证](docs/verification/asr-service-storage.md)。

已上线 B 站 `b23.tv` 短链接解析，短长链接按视频和分 P 去重；鸿蒙导入状态自动刷新、AI 连续引用编号展开均已修复。正式服务和鸿蒙模拟器完成短链导入、自动转写及真实范围引用问答验证，见[本次验证](docs/verification/bilibili-short-links-citations.md)。

网页已上线 [fish.sdspeed.com.cn](https://fish.sdspeed.com.cn)。生产环境的真实邮箱登录、网页与 HarmonyOS 7 模拟器播放同步、设备接管、重启恢复及公开音频下载已通过；数据库、媒体备份已完成隔离恢复测试。服务器转写任务已通过专用 HTTPS 接口接到本机阿里模型：148.968 秒公开样本生成 20 个文稿片段，两端可查看；独立 Bridge 已完成网页提问、手机追问及引用同步，详见[生产文稿与问答验证](docs/verification/production-transcription-chat.md)。Cat 与鱼趣现共用一个 Bridge 实例，按项目并行处理，并沿用已有登录启动入口；本机 ASR 使用独立受托管服务，Windows 登录后自动运行，电脑仍需在线且未休眠。

在本机开发环境中，邮箱会话、RSS/音频导入、私有媒体播放及逐集进度同步已经接入。下载完成会自动创建整期转写任务，按段保存、失败续接，网页和鸿蒙均可展开文稿、定位当前附近。真实 TWiT 148.968 秒整集已经由导入队列自动转写，20 个片段在网页及 HarmonyOS 7 模拟器显示一致。

问答已接入独立 CodexBridge：发送时保存播放位置和文稿范围，回答逐步回传并存入 PostgreSQL，引用可展开原文。B 站完整 BV 链接可预览分 P、下载公开独立音轨；242.927 秒中文 Python 教程已自动转写，两端文稿、真实 AI 问答和双向追问通过。刷新网页、重开鸿蒙应用后记录仍在。完整证据见[本轮验证](docs/verification/transcripts-chat-video.md)。

已补小时级实测：61 分 17 秒中文教程自动转写为 544 个文稿片段，进程强制中断后从已保存的 4:30 继续，原有 9 块不变；网页与鸿蒙均能查看末尾文稿、提问及读取整期总结。网页拖到末尾后倒回造成的结束状态残留已修复。文稿仍可能有错字和分段边界重复，未完成人工准确率评测。

鸿蒙真机、耳机/来电和小时级音频质量仍待验收。V2 继续按计划验证嵌入 B 站官方播放器。

## 本地运行

使用 Node.js 24，在仓库根目录执行：

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

已有 `.env` 时不要覆盖。登录需要独立 PostgreSQL、随机认证密钥和邮件配置；导入还需要私有绝对路径 `MEDIA_STORAGE_DIR`。按[本地开发](docs/local-development.md)执行迁移后，在另一个终端分别运行 `npm run worker:ingestion` 与 `npm run worker:transcription`，网页和 Worker 使用同一数据库及媒体目录。访问 `http://127.0.0.1:3000`。`npm run check` 检查配置、类型、自动化行为及网页构建；`npm run test:integration` 另行运行真实数据库测试；`npm run harmony:build` 实际编译鸿蒙工程。

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [功能需求与版本范围](docs/requirements.md) | 已确认需求、建议交互、首版验收和后续版本边界 |
| [技术架构](docs/architecture.md) | 客户端、云端、转写、Codex bridge、数据与同步设计 |
| [第一版开发步骤](docs/development-plan.md) | 开发依赖、阶段交付、验证方式和实施前待定事项 |
| [本地开发](docs/local-development.md) | 安装、启动、测试音频、开发事件接口和数据库迁移 |
| [生产部署与验证](docs/deployment.md) | 正式域名、真实邮箱与双端同步、备份恢复及生产待办 |
| [鸿蒙开发与发布](docs/harmony-development-release.md) | 桌面模拟器、真机签名安装和应用发布流程 |
| [鸿蒙验证工程](apps/harmony/README.md) | 播放器实现、工具链及手动测试清单 |
| [第一阶段验证记录](docs/verification/stage-1.md) | 初次工程与网页验证记录，原生后续结果见下一项 |
| [鸿蒙编译与模拟器记录](docs/verification/harmony-build-emulator.md) | 实际工具版本、构建与模拟器结果及剩余真机事项 |
| [事件、登录与进度同步记录](docs/verification/accounts-playback.md) | 本轮实际数据库、浏览器、模拟器跨端验证与限制 |
| [登录与播放接口](docs/accounts-playback-api.md) | 两端共用的请求、事件和并发处理规则 |
| [资料库与导入验证](docs/verification/library-imports.md) | 公开 MP3、真实 RSS、下载限制、检查结果与待复测项 |
| [RSS 与本机转写验证](docs/verification/rss-local-asr.md) | RSS 完整播放、真实断点续传与阿里模型的本机结果 |
| [本机转写运行说明](workers/transcription/README.md) | 整期 Worker、隔离环境、固定模型与短样本 CLI |
| [文稿与问答接口](docs/transcripts-chat-api.md) | 文稿分页、提问范围、持久历史与 Bridge 协议 |
| [整期转写、问答与视频验证](docs/verification/transcripts-chat-video.md) | 本轮真实链路、修复和未验证范围 |

## 版本安排

- **V1 第一版**：支持 RSS、音频链接和 Bilibili 链接导入，在鱼趣自己的播放器中播放；服务端下载处理、转写，手机与网页均可提问，进度和聊天云端同步。
- **V2 下一版**：在鱼趣里嵌入 B 站官方播放器。嵌入播放、获取实时进度分别验证，不预设官方播放器能提供与自有播放器相同的同步能力。
- **更后期候选**：同步鱼趣之外的 B 站网页或官方 App 播放进度，以及收藏、离线下载和视频画面理解。

文档中的“已确认”表示用户确定的产品范围；“建议”表示实施基线；“待定”表示需要在相应开发阶段验证或选择，均不代表已实现。
