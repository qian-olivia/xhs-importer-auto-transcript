# xhs-importer 自动视频文稿（macOS）

这是 [Xiaohongshu Importer Plus](https://github.com/lxl448080113/ob-Plugin) 的本地修改版。导入小红书视频后，插件自动把文稿写入**刚导出的同一篇 Obsidian 笔记**；视频和图文笔记都不附加小红书原帖的话题标签块。图片下载和个人 Frontmatter 设置仍按原插件配置运行，不需要运行 Codex。

## 工作流程

小红书链接 → `xhs-importer` 创建笔记 → 优先读取平台字幕 → 字幕不可用时临时下载视频并在本机语音识别 → 写入原笔记的 `## 视频文稿` → 删除临时视频。

字幕和视频只从小红书域名读取。视频下载到系统临时目录，正常完成或报错时都会清理；不会放进 Obsidian 库。语音识别使用本机的 `mlx-whisper`，不会把视频发给第三方转录服务。首次需要语音识别时，会下载 Whisper 模型文件并缓存在电脑上；**模型缓存不是临时视频，不会自动删除**。

## 文件

| 文件 | 用途 |
| --- | --- |
| `main.js` | 带自动视频文稿功能的插件代码 |
| `manifest.json`、`styles.css` | 原插件的清单和样式 |
| `transcribe_note.py` | 读取字幕或本机转录；视频使用临时目录 |
| `setup.sh`、`requirements.txt` | 在本机安装语音识别环境 |
| `LICENSE` | 原插件 MIT 授权声明 |

`data.json` 是个人插件设置，**不在仓库中**。覆盖插件代码时不要删除或覆盖现有的 `data.json`，这样默认笔记文件夹、图片文件夹、下载图片开关和 Frontmatter 设置会保留。

## 安装或恢复

当前安装脚本面向 **Apple Silicon Mac 的桌面版 Obsidian**。平台字幕可以由 Python 读取；无字幕时的本机语音识别依赖 Apple Silicon、Python 3 和磁盘空间。安装需要联网下载 Python 依赖；首次本机转录还需下载约 1 GB 的模型文件。

1. 在终端进入本仓库文件夹，执行 `bash setup.sh`。脚本会把 Python 环境装到 `~/Library/Application Support/xhs-importer-transcript/.venv`，不放进 Obsidian 库，也不需要运行 Codex。
2. 找到你的 Obsidian 库，将 `main.js`、`manifest.json`、`styles.css`、`transcribe_note.py` 复制到该库的 `.obsidian/plugins/xhs-importer/`。已有插件时建议先备份原 `main.js`；保留原 `data.json`。
3. 重启 Obsidian，并确认第三方插件中的 `Xiaohongshu Importer Plus` 已启用。

复制目标位于你自己 Obsidian 库内的 `.obsidian/plugins/xhs-importer/`；库的实际位置以你的 Obsidian 设置为准。

## 使用

在 Obsidian 运行 `Import Xiaohongshu note`，粘贴小红书分享链接并导入。视频笔记会先创建，随后自动出现 `## 视频文稿`；插件会提示文稿来自“小红书平台字幕”还是“本地语音转录”。没有字幕的视频需要等待下载和识别，时间取决于视频长度。图片或文字笔记不会触发转录；两类笔记都不会附加原帖话题标签块。

如果字幕、视频地址都不可用，原笔记仍会保留，Obsidian 会提示失败。小红书的签名媒体链接可能过期，遇到过期链接时请重新导入。自动语音识别可能听错专有名词，使用前请校对。

原插件更新可能覆盖这个修改版的 `main.js`。更新后如果自动文稿功能消失，可从你保存的仓库重新复制本版文件；仍要保留原有 `data.json`。

## 上传 GitHub 保存

新建一个仓库，把本文件夹中的源文件放在仓库根目录再提交。不要上传 Obsidian 库的 `data.json`、个人笔记、视频、`.venv` 或模型缓存。若要保留原插件来源，请同时保留本仓库的 `LICENSE` 和上方的原项目链接。

## 来源与授权

插件基于 [lxl448080113/ob-Plugin](https://github.com/lxl448080113/ob-Plugin) 修改；原项目采用 MIT License，版权声明见 `LICENSE`。本仓库仅保存本地扩展版本，不代表原项目官方发布。
