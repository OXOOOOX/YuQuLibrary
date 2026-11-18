# 文稿与问答接口

当前实现：2026-11-18。本机业务服务与 PostgreSQL 已接入；章节、检索及总结为本地新增能力，公网部署与真机验收另行记录。

## 自动转写

下载完成的同一事务创建 `transcript_jobs`，每个媒体版本只有一个任务。Worker 领取带租约的任务，校验私有文件 SHA-256，按 30 秒核心段、前后各 5 秒上下文调用本机 Qwen3-ASR 与 ForcedAligner。字词按中点归属核心段，保留真实对齐时间。

每段先写入 `transcript_chunks` 并推进 `completed_ms`，提交后才通知 Python 处理下一段。中断从已提交位置恢复；旧租约不可提交。最多三次自动尝试，失败后可手动重试并保留已有片段。完成仅在处理进度等于实际媒体时长时成立。

| 接口 | 行为 |
| --- | --- |
| `GET /api/media/{id}/transcript?after=-1` | 取最多五个连续核心段，返回任务状态、可用进度、片段和下一游标 |
| `GET /api/media/{id}/transcript?at=毫秒` | 从当前位置所在句子的起始核心段读取，使用返回的 `pageCursor` 继续轮询，不改变播放进度 |
| `POST /api/media/{id}/transcript/retry` | 重试失败任务，有 30 秒冷却 |

两端展开文稿时每五秒刷新；鸿蒙转后台暂停界面轮询。任务执行不依赖页面是否打开。文稿与播放事件采用不同状态通道，不共用播放修订号。

v3 文稿的句子可跨越 30 秒检查点；数据库片段保留不可变，服务端按首片段的 `continuesPrevious` 与原始间隔 `joinWithSpace` 形成阅读视图。句子 ID 与分页归属始终取句首所在块，跨页句只显示一次；后续块到达可延长末句。空页也可能是上一页句子的续段。旧文稿维持原样，已有问题的冻结 context/citations 不变。

当前 v3 投影在锁定任务的读事务中最多读取 480 个已提交块，保证分页和定位使用同一份完整句链；尚未进行四小时极端文稿的轮询负载测试。`near`/`until` 先还原跨块句子再按时间过滤，`until` 不会把结束晚于提问位置的整句当成已结束句。

## 聊天

| 接口 | 行为 |
| --- | --- |
| `GET /api/media/{id}/chat?before=序号` | 当前用户、当前媒体的历史；最多 20 轮并按响应字节数进一步裁剪 |
| `POST /api/media/{id}/chat` | 请求体 `requestId` UUID、`question`、`positionMs`、`scope` |
| `POST /api/chat/turns/{id}/cancel` | 取消等待或正在生成的回答，保留已收到文字 |
| `POST /api/chat/turns/{id}/retry` | 重用原问题、原播放位置和原文稿快照重新回答 |

范围 `near` 为位置之前两分钟及与当前位置相交的段落；`until` 只使用结束时间不晚于当前位置的片段；`all` 需要整期转写完成。旧范围超过 600 片段或 32,000 字符仍提示缩小范围。新增 `anchor: { kind: 'retrieval' }` 按问题检索整期完成文稿并冻结相关原文，不改变 `all` 的含义；读取新消息须声明 `capabilities=anchored-v1,retrieval-v1`，见[检索架构](architecture.md)。问题最多 2,000 字符，回答最多 24,000 字符。多级总结通过下述独立接口生成，不写成旧聊天记录。

同一请求标识重复发送返回同一问题；更换内容却复用标识会拒绝。同一对话只生成一个回答，每个用户最多三项待回答、每分钟十次提问。发送时冻结媒体、位置、范围、文稿版本和最近四轮历史。收听继续前进不会改变已发送问题的定位。

聊天保存于业务 PostgreSQL，Bridge 中临时 Codex 会话不是历史记录来源。两端前台每两秒刷新，刷新页面或切换设备后读取同一记录。引用 `[S1]` 等必须属于本轮冻结片段，完成时保存实际时间及原文；历史回答中的旧编号从下一轮提示资料中移除。

聊天页响应包含 `audioAvailable`。两端展开引用不改变播放；点击“从这里播放”才携带该对话绑定的媒体版本和引用 `startMs` 显式接管当前设备。独立阅读模式、草稿、原问题的位置与文稿快照保持不变。音频被清理时仍展示引用，但禁用回听；未返回明确可用状态的旧服务也不启用按钮。服务端再次检查音频归属和可用性，避免陈旧列表放行。

## 分段与整期总结

新客户端在总结 GET／POST 及主题 GET 的查询参数中声明 `capabilities=summary-topics-v1`；该参数可与原 `documentId`／`after` 同时使用。

| 接口 | 行为 |
| --- | --- |
| `GET /api/media/{id}/summaries?capabilities=summary-topics-v1` | 最近文档、进度、整期目录和最多 8 个已完成分段；继续页使用 UUID `documentId` 与 `after`，分段偏移 0–127 |
| `POST /api/media/{id}/summaries?capabilities=summary-topics-v1` | `action: 'generate'` 与 UUID `requestId`；或 `action: 'retry' / 'cancel'` 与 UUID `documentId`；响应均为分段第一页 |
| `GET /api/media/{id}/summaries/topics?capabilities=summary-topics-v1&documentId=...&topicIndex=0&after=0` | 完成文档的某个主题，每页最多 20 个叶要点；topicIndex 为 0–11，after 为 0–1535 且小于该主题实际要点数，缺省为 0 |
| `GET /api/media/{id}/summaries/evidence?documentId=...&nodeId=...&pointIndex=0` | 当前用户该资料下某个已完成要点的冻结原文、时间及快照；documentId／nodeId 均为 UUID；v3 必须指向叶节点，pointIndex 为 0–11，旧格式为 0–5；此接口不要求能力参数 |

响应契约见 `packages/contracts/src/summaries.ts`。`document` 包含固定快照、status、completedParts/totalParts 和 completedTasks/totalTasks。新文档另带 `format: 'topics-v1'`，每个分段最多 12 个要点；旧文档无 format，每段仍最多 6 点。v3 完成后 `overview=null`，`topicOverview={id,title,topics:[{index,title,pointCount}]}`，主题按连续 index 编号，总数 1–12、全部 pointCount 合计最多 1,536。旧格式完成后继续返回 `overview`，不返回主题目录。未完成文档两种整期内容均为空或未提供，已完成分段可先读取。

主题页返回 `{mediaVersionId,documentId,topicIndex,title,snapshot,points,after,nextAfter,totalPoints}`。每点为 `{nodeId,pointIndex,text,evidenceCount,startMs,endMs}`，保留真实叶节点及原要点索引；页面上的展示序号不能用于取依据。非末页 `nextAfter=after+20`，末页为 null，页长与剩余要点数一致。客户端必须绑定媒体、文档、主题、快照与游标，再校验条数、总量、叶引用及时间边界，不能接纳其他主题或另一份文稿的响应。展开证据时使用该点的叶 nodeId／pointIndex，每点返回 1–16 条原始片段；冻结原文不从当前文稿补取。

首次生成要求整期文稿 ready 且完成水位等于实际时长。`canGenerate` 可在旧总结存在、源文稿或策略已变化时为 true；排队／生成中的文档不显示升级入口。显式 generate 使用新的 requestId，允许响应切换 documentId，客户端同时重置分段、主题分页和依据；丢失响应重发同一 requestId 仍返回原文档。取消／重试保留完成部分和冻结输入；同版本、水位及策略复用已有结果。

当前新能力对应 `topic-complete-summary-v3`。未声明新能力的生成请求继续使用 `time-bounded-summary-v2`；读取或操作 v3 文档时缺少能力声明返回 `409 CLIENT_UPGRADE_REQUIRED`，主题端点始终要求该声明。`hierarchical-summary-v1` 与 `time-bounded-summary-v2` 的文档和冻结依据仍可按 documentId 读取，新端兼容两种格式。本轮增加接口与字段，无数据库迁移。权限与媒体归属一致，归档音频可读但不可回听；主题切换和分页不自动播放，迟到主题／依据不得跨收起、退出、媒体或文档切换写入。

## Bridge 协议

鱼趣使用独立 `YUQU_BRIDGE_PROJECT_ID`、`YUQU_BRIDGE_AGENT_ID`、`YUQU_BRIDGE_TOKEN`。用户登录令牌不能调用 Bridge。令牌为至少 32、至多 128 位 URL-safe 随机字符，保存在仓库外。

| 接口 | 请求/结果 |
| --- | --- |
| `GET /api/bridge/v1/health` | 协议 `1.0` 与项目身份 |
| `POST /api/bridge/v1/jobs/claim` | `acceptedTaskTypes` 声明支持的任务类型；在加租约前筛选，没有匹配任务为 204 |
| `POST /api/bridge/v1/jobs/{id}/heartbeat` | `leaseId`，有效租约延长 120 秒 |
| `POST /api/bridge/v1/jobs/{id}/events` | 聊天支持 `leaseId`、连续递增 `sequence`、累计 `text`；章节与总结不接受流式事件 |
| `POST /api/bridge/v1/jobs/{id}/complete` | `leaseId` 与对应任务的 `result`；聊天为 `{answer}`；旧总结及新叶任务为 `{title,points:[{text,citationIds}]}`，新父任务为 `{title,topics:[{title,itemIds}]}` |
| `POST /api/bridge/v1/jobs/{id}/fail` | `leaseId`；保存固定失败提示 |

独立 CodexBridge 的 `yuqu` 适配器每十秒续租，丢失租约或回传失败便停止本次生成；累计文本只允许前缀追加，同序号同文字可重复提交。任务取消后、旧租约或错误 agent 的输出均被拒绝。完成可幂等重发。

当前任务类型保留 `yuqu.chat.answer.v1`、`yuqu.chat.retrieval.v1`、`yuqu.transcript.chapters.v1`、`yuqu.transcript.summary.part.v1` 与 `yuqu.transcript.summary.overview.v1`，新增 `yuqu.transcript.summary.part.v2` 与 `yuqu.transcript.summary.overview.v2`。旧两类总结仍使用最多 6 点、每点 1–2 个局部编号的原协议；旧 Worker 不会领取未声明的新任务，领取优先级仍为聊天、章节、总结。

新叶输入仍为 segments，但 S 编号指向冻结连续上下文单元；输出 1–12 点，每点引用 1–4 个已有 S 编号，由服务端还原至最多 16 条原句。Bridge 对叶任务先生成 draft，再在新的无工具会话中用同一冻结原文和草稿独立复核，只提交通过解析的复核结果；复核取消、失败或格式无效均不能回退提交 draft。完整提示最多 100,000 字符，输出最多 24,000 字符，两次调用分别执行既有取消与超时边界。

新父任务输入为最多 96 个 items 与连续 P 编号，输出 1–12 个主题及 itemIds。Bridge 与业务服务均校验全部输入 P 编号恰好出现一次，不接受遗漏、重复或发明编号；父任务只分组，服务端保留完整叶正文和冻结依据。专用 summaries 模式要求只输出 JSON，原有工具限制保持。具体预算及历史兼容见[总结架构](architecture.md#分段与整期总结)。

Codex 使用一次性空工作目录和临时 app-server 会话，资料被视为不可信引用；启用文本任务专用权限，关闭工具和网络能力，核验有效配置，拒绝额外权限、MCP 或工具事件。Cat 仍由原适配器处理，鱼趣凭据与任务独立。
