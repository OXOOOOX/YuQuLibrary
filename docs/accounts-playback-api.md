# 邮箱登录与播放同步接口

日期：2026-11-16。支持用户导入的音频和公共受控样本 `yuqu-playback-check-v1` / `fixture-pcm-v1`。导入音频的时长由服务端解析实际文件取得。网页与鸿蒙共用下列 Node.js / PostgreSQL 接口，类型见 `packages/contracts/src/playback.ts`。

## 登录

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| POST `/api/auth/request-code` | `{ email }` | `{ challengeId, expiresIn:600, retryAfter:60, delivery }` |
| POST `/api/auth/verify-code` | `{ email, challengeId, code, client, deviceName }` | `{ user, session }`；harmony 额外返回 `token` |
| GET `/api/auth/me` | 设备鉴权 | `{ user:{id,email}, session:{id,client,deviceName,expiresAt} }` |
| POST `/api/auth/logout` | `{}`，设备鉴权 | `{ ok:true }` |

`client` 是 `web` 或 `harmony`，`delivery` 是 `local` 或 `smtp`。邮箱去除首尾空格并统一小写。验证码只保存绑定邮箱和 challengeId 的 HMAC，发送成功后才允许验证；失败次数、单次消费和创建账号/会话在数据库中处理。发信在事务外完成。

网页验证只设置 HttpOnly、SameSite=Lax Cookie，生产追加 Secure，不在 JSON 返回令牌。原生端使用 Authorization Bearer，不把令牌放 URL。设备令牌随机生成 32 字节，数据库只保存 SHA-256 摘要；会话有效期 30 天，可单独撤销。所有 Cookie 写入要求匹配配置的 Origin；原生允许无 Origin，存在但不匹配的 Origin 仍拒绝。无效 Bearer 不会回退到 Cookie。

客户端对同浏览器标签页的登录/退出做串行协调并通知其他页面；后台用户身份仍以每次请求的服务端鉴权结果为准。

## 播放

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| GET `/api/playback` | 设备鉴权 | `{ snapshot }` |
| POST `/api/playback/takeover` | `{ requestId:UUID, expectedGeneration, mediaVersionId?, positionMs? }` | `{ snapshot, accepted }` |
| POST `/api/playback/report` | 见下方 | `{ snapshot, accepted }` |
| GET `/api/events` | 设备鉴权，可带 Last-Event-ID | SSE |

上报字段：`generation`、`playbackSessionId`、`sequence`、`contentId`、`mediaVersionId`、`positionMs`、`speed`、`state`、`looping`。所有位置均为整数毫秒；倍率只支持 1、1.25、1.5、2；状态为 playing、paused、buffering、ended。客户端不能指定可信 userId 或 owner。

快照额外包含 `title`、`durationMs`、`revision`、`ownerSessionId`、`updatedAt`。接管使用用户快照行锁和预期代次比较，成功时 generation 与 revision 增加、sequence 清零、分配新的 playbackSessionId，承接已保存位置并先标暂停。指定 `mediaVersionId` 时先校验资料归属；切集保存旧节目的历史位置、倍率和循环状态，并恢复目标节目的历史（首次播放为零）。

引用回听可传 `positionMs`，必须同时显式指定 `mediaVersionId`，位置为大于等于零且小于该音频实际时长的整数毫秒。接管事务直接把目标内容和引用起点发布为暂停快照，客户端完成加载和定位后才开始播放；不先播历史位置。清理过音频的资料拒绝回听。

requestId 的幂等记录绑定用户、发起设备、预期代次、目标媒体及显式起点（新增迁移 0009）。重复请求只有在原接管仍有效时 accepted=true，不会再次抢回播放，也不会把已前进的进度倒回原引用。复用标识却修改起点会冲突。上报只接受当前 owner、代次、媒体版本和递增 sequence；重复或乱序序号返回 accepted=false，不新增事件。位置可以减小，用于主动回听。快照、每集历史与事件同事务提交。

客户端只在确认本次接管成功后播放，不依据 Cookie 或“上次是 owner”自动出声。同一浏览器的多个标签页共享登录，但各自保存本次激活的 generation；另一标签接管也会使旧标签失去控制。

## 资料与导入

以下接口均需设备鉴权，资料按用户隔离，只有公共测试样本共享。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| GET `/api/library` | 无 | `{ items:[{mediaVersionId,contentId,title,durationMs,createdAt,byteSize,audioAvailable,deletable}], usage }` |
| POST `/api/library/:id/remove` | `{ mode: "audio" 或 "all" }` | `{ removed:true, mode }`，两端确认后提交 |
| POST `/api/imports/:id/remove` | `{}` | `{ removed:true }`，仅等待或失败任务 |
| GET `/api/imports` | 无 | `{ jobs }`，当前用户最近 50 项 |
| POST `/api/imports/preview` | `{ url }`，RSS/Atom 地址 | `{ title, episodes:[{url,title}] }` |
| POST `/api/imports` | `{ url, title? }`，直接音频地址或选定的 enclosure | `{ job }`；同用户同来源复用原任务 |
| POST `/api/imports/[id]/retry` | `{}` | `{ job }`；失败任务可重排，最多总计 3 次尝试 |
| GET/HEAD `/api/media/[id]` | Cookie/Bearer，可带单段 Range | 私有音频流；200/206/416 |

任务字段为 `id/title/sourceUrl/status/attempts/error/mediaVersionId/createdAt`；状态依次为 `queued`、`downloading`、`ready` 或 `failed`。下载 worker 独立运行，文件完整且时长解析通过后才创建可播放媒体。两端展开资料列表时轮询任务；导入状态暂未加入 SSE。

每用户最多 50 项任务、同时 5 项等待或下载，失败项和保留文稿的归档项也计入总额。默认音频额度 1 GiB，可用 `YUQU_USER_STORAGE_LIMIT_BYTES` 配置；`usage` 含 `usedBytes/reservedBytes/reclaimingBytes/limitBytes/itemCount/itemLimit`。每个等待或下载任务预留 100 MiB，物理清理完成后才释放待回收额度。RSS 预览冷却 5 秒，最多读取 2 MiB、展示 100 集，不自动下载全订阅。单集最多 100 MiB、4 小时，下载总时限 5 分钟。只允许公网 HTTP/HTTPS 标准端口，每次重定向重新校验并将连接固定到已验证的公网 IP；禁止内网、保留地址和 XML 外部实体。

`audio` 要求整期转写完成，保留文稿、聊天及资料条目，停止回听；`all` 删除音频、文稿、聊天、导入及转写任务。公共样本不允许删除。正在下载的导入返回 409，等待完成或失败后处理。删除当前播放资料会暂停并切回公共样本、递增 generation/revision、撤销 owner，旧设备不能覆盖状态。删除其它资料不会打断当前播放。阅读归档文稿使用独立客户端选择，不接管播放；仍可用文稿提问。

文件回收通过持久队列执行，通常延迟 30 秒；失败或过期下载的旧产物延迟 6 分钟，超过下载截止时间后再清理。回收失败保留队列与占用，自动退避重试。新音频请求立即拒绝；已打开的媒体流每 5 秒复核授权并关闭失效流，已交付给客户端的字节不能撤回。当前没有回收站或音频恢复按钮。

媒体接口不跳转外部链接，不把设备令牌放 URL，检查文件归属后按字节范围读取本地私有存储。网页以 Cookie 读取；鸿蒙使用带 Bearer 头的 MediaSource。浏览跟随端不会自动加载或播放另一端的音频。服务端支持单段起止、开放结尾和后缀 Range，不支持多段。

## 事件与恢复

当前用户事件只有播放状态，游标使用 revision；未来加入聊天/导入事件时需要独立的用户事件序列，不复用播放资源修订号。

- 首次连接发 `event: snapshot`，数据直接为快照，`id` 为 revision。
- 之后发 `event: playback`。服务端每秒查询数据库，保留最近 1000 次修改。
- Last-Event-ID 有效时按序补发；游标过期或超前时发 `event: reset` 权威快照。客户端清理旧控制权、未确认上报和旧异步响应，允许该快照修订号降低，再建立新连接。
- 网页恢复事件连接后先读取快照；失败时按 1、2、4、5 秒重试，在恢复确认前不发送进度。
- 每 15 秒发送不推进游标的心跳注释，每 55 秒正常关闭并重连。每轮短事务重新检查会话是否有效，不长期占用数据库连接。
- 会话撤销或过期时发 `event: session-expired` 并关闭。客户端停止上报与重连，清理登录；初始鉴权失败直接返回 401。

鸿蒙处理响应体先于响应头的回调顺序、分片 UTF-8、CRLF、未完成事件与大小上限；只在消费成功后推进游标。正常轮换不增加故障退避。

## 错误与部署边界

错误结构为 `{ error:{code,message}, snapshot? }`。400 输入/游标无效；401 登录或验证码失效；403 Origin 不匹配；409 接管冲突并附当前快照；413 请求体超过 8 KiB；429 发送限流；503 服务或邮件未就绪。所有响应禁止缓存；日志不输出凭据、验证码和请求体。

当前实现不是离线协同播放器：断网的旧设备无法即时收到远程暂停，但其旧代次数据不能覆盖新 owner，恢复连接后必须服从服务器快照。客户端将超过 10 秒未更新的 playing 快照标为过期，不当成持续的真实播放证据。
