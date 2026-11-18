# 鱼趣本机整期转写与样本验证

整期后台任务已接入下载队列、文稿数据库和网页/鸿蒙界面。保留最多 60 秒的独立 runner 用于诊断，两者使用相同固定模型。

## 整期任务运行

配置根目录 .env 的 YUQU_ASR_PYTHON、YUQU_ASR_MODEL_DIR、YUQU_ASR_ALIGNER_DIR、YUQU_ASR_FFMPEG 四个绝对路径，先执行 npm run db:migrate，再运行 npm run worker:transcription。模型仍在项目外。数据库 advisory lock 限制同一库仅一个 GPU 转写进程。

episode.py 解码完整媒体（最多 100 MiB、4 小时），每 30 秒核心段加入前后 5 秒上下文，按字词中点消除重叠归属，保留 ForcedAligner 时间。每段等待数据库提交 ACK，进程中断后从 completed_ms 恢复；重试不会重复已提交片段。模型身份变更不能混入已有文稿。连续三次失败后显示手动重试。

整期流水线新增 `yuqu-qwen3-episode-v3`：保留同一次 ASR 原文的标点与空格，按句末标点、长句中的逗号和真实停顿分句；不再按 8 秒截断。真实零时长对齐词保留为模型给出的时间点，文字并入相邻句，不人为补造时长。匹配原文与对齐字符失败时明确报 `TEXT_ALIGNMENT_MISMATCH`，不猜测或悄悄删字。30 秒检查点仍不可变；首片段的 `continuesPrevious` / `joinWithSpace` 让服务端把跨块句子拼成共享阅读与问答视图。

任务领取响应显式携带 `pipeline: semantic-v3` 才启用新版。旧服务器未提供该字段时继续 v2；已有 v2 任务仍用旧指纹和旧处理路径恢复。先确保本机 Worker 已支持 v3，再发布服务端；旧 Worker 不能续跑已经保存的 v3 任务。不得清空模型身份混接版本。已完成的旧文稿不会自动重排或重写。

两条流水线均允许实际解码与媒体时长相差 250 毫秒；末词先按实际音频尾部校验（最多 100 毫秒对齐量化误差），再裁剪到实际与媒体时长的较小值。普通核心段的中点归属、提交 ACK、租约限制不变。分句思路参考 [stable-ts](https://github.com/jianfch/stable-ts#regrouping-words) 和 [FunASR](https://github.com/modelscope/FunASR/blob/main/funasr/models/ct_transformer/model.py)，没有新增 Whisper 或标点模型依赖。

### 可复现质量对比

`scripts/evaluate-asr.mjs --samples <绝对路径样本清单> --output <新的绝对路径输出目录> --pipeline legacy-v2|semantic-v3` 在独立诊断中保存原始识别文本、完整对齐词、核心区选词、最终片段，以及分阶段耗时和 PyTorch 显存峰值。`--model` 与 `--manifest` 可指定待比较模型和包含 asr/aligner 的固定哈希清单；`--concatenation` 可追加原样本的拼接清单。不会读取或写入业务数据库；模型推理仍需匹配音频 SHA256、共享模型锁和父管道登记。

执行前检查托管服务空闲，再使用 `npm run asr:service -- stop` 进入维护；入口拒绝在托管服务启用时运行。执行完成后用 `npm run asr:service -- start` 恢复。只对明确选定的测试音频使用诊断输出，不将含文稿的 JSONL 写入一般日志或发往服务器。完整测量口径见[漏词修复与模型对照](../../docs/verification/asr-semantic-quality.md)。

失败日志只接受 Python 固定诊断码和白名单异常类型，不保存原始 stderr、文稿、路径或异常消息。单行最多 4 KiB、累计最多 64 KiB，无法确认时统一记为 `TRANSCRIPTION_FAILED`；正常取消记为 `ABORTED`。日志包含本次尝试耗时，用户端仍显示统一重试说明。`node --test tests/transcription-diagnostics.test.mjs` 覆盖实际子进程失败、启动异常、取消和临时目录清理；`python -B -m unittest test_episode.py` 在本目录运行纯时间边界测试。

Node 负责临时解码目录，取消会终止自己创建的推理进程树并清理临时文件，原始媒体保持只读。新建推理工作目录前会回收带有效归属标记、且 Node 与模型子进程均已退出的遗留目录；无标记、含符号链接或仍有进程存活的目录不自动删除。已用 61 分 17 秒中文音轨通过整期存储和强制中断续接，证据见[整期验证](../../docs/verification/transcripts-chat-video.md)；人工准确率、多人讲话及分段交界质量仍待评测。

以下保留短样本环境安装与诊断入口。

## 生产 HTTPS Worker

生产 Worker 读取独立的 `.local/production/asr.env`。其中配置 `YUQU_ORIGIN`、`YUQU_ASR_WORKER_ID`、`YUQU_ASR_WORKER_TOKEN`、上述四个模型路径及绝对 `MEDIA_STORAGE_DIR`。使用 ASR 专属凭据，不放入生产数据库、SMTP 或 Bridge 凭据；Python 子进程只接收必要系统环境。前台诊断可用 `npm run worker:transcription:remote`，日常运行使用下述托管入口，不与前台或开发 Worker 重复启动。

任务领取、心跳、音频下载和文稿保存均通过固定 HTTPS 源。下载验证任务记录的字节数与 SHA256；若流式响应没有 Content-Length，仍逐块限制大小并核对最终长度。拒绝跳转和压缩音频响应。完成或失败后清理本次缓存音频，文稿保存于服务器数据库。

空队列每 5 秒检查；领取响应不确定时等待 95 秒再领取。其他写入最多重试 3 次，已提交的相同片段和完成结果可重复确认，旧租约不能读取音频或提交结果。失租即取消推理，续接仍遵守模型身份校验。

开发与生产 Worker 共用本机模型锁；启动生产前须停止空闲的开发 Worker。锁位于系统临时目录的 `yuqu-asr-model-locks`，通过 SQLite 写事务协调归属检查；只有 Node 与登记的模型子进程均已退出，旧归属才可回收。模型加载前先登记子进程 PID，再打开父子通信许可；父管道 EOF 会终止模型，避免父进程崩溃后继续占用模型。SQLite 写锁会随进程退出释放；若发现旧版 `.gate` 目录仍拒绝启动，必须先核实旧进程归属，不可直接删除正在使用的锁。

### Windows 托管与登录自启动

在项目根目录执行以下命令：

| 命令 | 行为 |
| --- | --- |
| `npm run asr:service -- install-autostart` | 注册当前用户的 `YuQuTranscription` 计划任务，并启用、启动服务 |
| `npm run asr:service -- start` | 显式启用并启动，已有托管实例时不重复运行 |
| `npm run asr:service -- status` | 查看运行状态、进程与重启次数 |
| `npm run asr:service -- stop` | 停止并持久设置 `enabled=false`，计划任务不会将其自动拉起 |
| `npm run asr:service -- ensure` | 供计划任务检查；仅在服务已启用时恢复缺失实例 |

安装无需管理员权限。计划任务在当前用户登录后启动，并每分钟检查恢复；不支持开机未登录时运行。监管进程负责 Worker 异常退出后的退避重启，计划任务负责监管进程退出后的恢复。任务的已确认检查点仍由服务器保存；连续三次转写失败后，需要用户在界面手动重试，进程自恢复不会绕过任务重试上限。

本机状态、进程号、缓存及日志位于 `%LOCALAPPDATA%/YuQuASRProd`。服务日志按 2 MiB 轮转、保留 3 份，启动器日志按 1 MiB 轮转、保留 2 份。日志只输出固定 `ASR_*` 通信诊断码和受限状态，不输出原始文稿、异常或凭据。Cat/鱼趣 AI 问答仍由一个共享 Bridge 处理，与此 ASR 服务分别运行；电脑离线时新任务等待，已保存文稿与聊天仍能在线查看。

本轮已实测 Worker 崩溃自动重启、监管进程被终止后由计划任务恢复，以及手动停止后不自动复活。Windows CRT/NumPy 与阻塞管道读取的冲突经复现后改用 `PeekNamedPipe` 轮询；随后 148.968 秒样本在 30 秒检查点后被终止，自动从 30 秒续完 5 块，已保存块的摘要未变。未执行整机重启、注销/登录或鸿蒙真机验证，详见[转写服务与资料管理验证](../../docs/verification/asr-service-storage.md)。

### 资料清理与转写边界

清理音频仅允许整期文稿已完成的资料，保留文稿与聊天；未完成时需等待，或确认删除整期资料。整期删除会撤销转写与问答任务，旧租约不能继续读取音频或回传结果。当前播放被清理的资料时两端停止并重置到暂停的受控样本，独立阅读不会接管播放。

服务器媒体回收由 `ingestion` Worker 异步处理，普通删除至少延迟 30 秒，失败或过期下载的文件至少等待 6 分钟；物理文件回收前仍计入用户容量。默认每用户 1 GiB、每项待处理预留 100 MiB，配置与运维边界见[部署说明](../../docs/deployment.md#资料清理与容量)。服务端清理与本机推理缓存清理是两个独立流程，不提供恢复音频或资料回收站。

## 固定环境与模型

- Python 3.12.14；PyTorch 2.9.1+cu128；Transformers 5.23.0；Accelerate 1.12.0。
- 日语对齐补充 nagisa 0.3.2、DyNet38 2.2、Cython 3.3.1；使用官方 PyPI Windows/CPython 3.12 wheel，版本已纳入 requirements.txt。90.302 秒日语样本完整验证通过，其他未测试语言可能仍有独立依赖或质量限制。
- 官方原生 Transformers 模型：`Qwen/Qwen3-ASR-0.6B-hf` 和 `Qwen/Qwen3-ForcedAligner-0.6B-hf`，均为 Apache-2.0。模型及依赖的许可证仍以各自发行文件为准。
- `requirements.txt` 固定本次完整环境，PyTorch 使用官方 Windows x64 / CPython 3.12 / CUDA 12.8 wheel 和 SHA256；其他平台未验证，不能直接沿用该 wheel。
- `model-manifest.json` 记录官方下载仓库、每个文件的官方 ModelScope Git revision、大小和 SHA256。下载完成后逐文件校验通过。Hugging Face revision 是参考站点当时版本，实际下载来源是官方 Qwen ModelScope 镜像。
- 输出中的 `model.revision` / `aligner.revision` 是按文件路径排序后 `(Path,Sha256)` 清单的 SHA256 指纹，不是官方 Git commit；实际官方提交保留在清单及输出 `fileRevisions`。

主项目：[Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)。原生调用说明：[ASR](https://huggingface.co/Qwen/Qwen3-ASR-0.6B-hf)、[ForcedAligner](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf)。推理设置 `local_files_only=True`、`trust_remote_code=False` 和 Hugging Face offline，运行时不上传音频、不调用云 API。

## 在鱼趣项目中运行

在项目根目录的 `.env` 中设置 `YUQU_ASR_PYTHON`、`YUQU_ASR_MODEL_DIR` 和 `YUQU_ASR_ALIGNER_DIR` 三个绝对路径，分别指向独立环境的 Python、识别模型目录及对齐模型目录。本机已经配置，可直接在项目根目录执行：

```powershell
npm run asr:transcribe -- --audio C:/path/to/sample.wav --output C:/path/to/result.json
```

入口仅向推理进程传递必要的系统环境变量，不传递鱼趣的数据库、邮件或认证配置。模型权重与 Python 环境保留在仓库外；不要将它们放进 `workers/transcription`。

## 新环境复现

以下命令在项目根目录执行。先准备 Python 3.12，独立环境放到项目外：

```powershell
$yuquRepo = $PWD.Path
$yuquAsrRoot = Join-Path $env:LOCALAPPDATA 'YuQu/asr-validation'
New-Item -ItemType Directory -Force -Path $yuquAsrRoot | Out-Null
py -3.12 -m venv (Join-Path $yuquAsrRoot '.venv')
$yuquPython = Join-Path $yuquAsrRoot '.venv/Scripts/python.exe'
$env:PIP_CACHE_DIR = Join-Path $yuquAsrRoot 'pip-cache'
$env:HF_HOME = Join-Path $yuquAsrRoot 'hf-home'
$env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
& $yuquPython -m pip install -r (Join-Path $yuquRepo 'workers/transcription/requirements.txt')
```

模型目录由 CLI 指定，不写死在源码。可根据清单在官方镜像逐文件下载；以下 PowerShell 使用清单中的固定提交并检查 SHA256，网络失败后可重跑，已经校验的文件会跳过：

```powershell
$manifest = Get-Content -Raw (Join-Path $yuquRepo 'workers/transcription/model-manifest.json') | ConvertFrom-Json
foreach ($key in @('asr', 'aligner')) {
    $entry = $manifest.$key
    $targetDir = [IO.Path]::GetFullPath((Join-Path $yuquAsrRoot "models/$key"))
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    foreach ($file in $entry.files) {
        $target = [IO.Path]::GetFullPath((Join-Path $targetDir $file.Path))
        if (-not $target.StartsWith($targetDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Model file path is outside the selected model directory.'
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        if ((Test-Path -LiteralPath $target) -and
            ((Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant() -eq $file.Sha256)) { continue }
        $url = "https://modelscope.cn/api/v1/models/$($entry.repo)/repo?Revision=$($file.Revision)&FilePath=$([uri]::EscapeDataString($file.Path))"
        Invoke-WebRequest -Uri $url -OutFile "$target.part" -TimeoutSec 300
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath "$target.part").Hash.ToLowerInvariant() -ne $file.Sha256) {
            throw "Model checksum mismatch: $key/$($file.Path)"
        }
        Move-Item -LiteralPath "$target.part" -Destination $target -Force
    }
}
```

配置当前终端后，使用项目入口推理：

```powershell
$env:YUQU_ASR_PYTHON = $yuquPython
$env:YUQU_ASR_MODEL_DIR = Join-Path $yuquAsrRoot 'models/asr'
$env:YUQU_ASR_ALIGNER_DIR = Join-Path $yuquAsrRoot 'models/aligner'
npm run asr:transcribe -- --audio C:/path/to/asr_zh.wav --output C:/path/to/result-zh.json
```

`--language Chinese` / `--language English` 可固定语言，不传则由模型判断。默认 CUDA，单次子进程最长 300 秒；`--timeout-seconds` 可缩短。`--device cpu` 是显式备选入口，本次未测 CPU。音频限制 20 MB、60 秒、1–8 声道和 8–192 kHz。输入会转单声道、16 kHz。

输出路径不能覆盖输入音频、runner、模型清单或两个模型目录中的文件。结果通过独占的随机临时文件原子替换；重新使用同一结果路径会更新该结果文件。

中文样本：[官方 asr_zh.wav](https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_zh.wav)，4.204 秒；SHA256 `46dbc998c9d1d48111267c40741dd3200f2e5bcf4075f8c4c97f4451160dce50`。英文样本来自 [TWiT 实际导入音频](https://cdn.twit.tv/drops/hot/1/1.mp3)，原始 MP3 SHA256 `1b16899c58c24a911e8473d075eff2a1d900adea8ee80be1407fdfbbc4009a98`。使用以下裁剪命令，然后以同一 runner 转写：

```powershell
ffmpeg -hide_banner -loglevel error -i C:/path/to/source.mp3 -t 44.4 -ac 1 -ar 16000 -c:a pcm_s16le C:/path/to/twit-first44_4.wav
npm run asr:transcribe -- --audio C:/path/to/twit-first44_4.wav --output C:/path/to/result-twit.json
```

## 已观察到的结果和边界

- 中文输出：“甚至出现交易几乎停滞的情况。”，13 个真实字符时间段。完整原始输出见 `result-zh.json`。
- 英文 44.4 秒输出 112 个真实词时间段；模型加载 6.673 秒、识别 9.286 秒、对齐 0.235 秒。PyTorch 峰值分配显存 3,768,406,528 字节，峰值预留 4,060,086,272 字节。完整文本和词边界见 `result-twit.json`。
- 所有成功输出的时间段已检查单调且不超过实际音频时长。`segments` 采用毫秒，`words` 保留对齐器原始秒数；中文通常按字符、英文按词。没有按文稿长度均分时间戳。
- 第一次截取 45 秒时，最后一个被截断的词结束时间是 45.120 秒，超过允许的 100 毫秒尾部量化误差，因此按规则拒绝。失败保留于 `result-twit-45-boundary-rejected.json`。随后在已观测到的完整词边界 44.4 秒裁剪成功。后续长音频应加入语音边界切分及重叠处理。
- 仅对不超过 100 毫秒的尾部量化误差将输出段末端收缩到实际时长；原始 `words` 不变，更大的异常直接失败。失败 JSON 的 `ok` 为 `false`，进程非零退出。
- 耗时从模型加载前开始，不含 Python/库导入、音频读取或重采样；显存数值仅指本进程 PyTorch 分配器，不代表其他应用或驱动占用。
- 未做人工听音验收、准确率测评、说话人区分或长播客评测。英文品牌及人名等不能据此认定准确。
- 安装中官方 PyTorch 2.10.0 下载停滞，改用现存 2.9.1 CUDA wheel；其 SHA256 已与官方索引核对一致，证据在 `torch-wheel-verification.json`。Hugging Face 大文件下载也停滞，改用记录的官方 ModelScope 路径。没有修改全局环境或 GPU 驱动。
- 早期直接调用 Python 时，继承的 CUDA allocator `expandable_segments` 设置产生 Windows 不支持警告；当时仍正常运行。项目入口不继承该设置，没有修改系统变量。

以上结果文件和 `validation-results.json` 均保留于本机证据目录 `%USERPROFILE%/Documents/Codex/2026-11-16/yuqu-stage4/asr-validation`，没有随源码提交。完整硬件、版本、来源、结果、失败与限制见该汇总文件；仓库内的验证记录见 [RSS 与本机转写验证](../../docs/verification/rss-local-asr.md)。
