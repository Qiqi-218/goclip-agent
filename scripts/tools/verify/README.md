# 验收复现工具

这些脚本不是产品的一部分，而是**验收用的驱动脚本**。分两类：

- `probe-*.mjs` **确定性检查**：直接加载编译后的插件运行时，用网络桩件拦截 OSS 与
  模型调用，因此不碰真实数据、不需要模型额度。一次跑完全部：
  ```powershell
  cd E:\huabei\goclip-agentv2\platform\dsh
  pwsh -File ..\..\scripts\tools\verify\run-all.ps1
  ```
- `cdp_*.py` **真实界面驱动**：通过浏览器 DevTools 协议驱动真实界面（点真实按钮、
  读真实 DOM、收真实网络响应），所以「验收通过」这句话可以随时重跑复核。

留在源码里，是因为提交前需要**再跑一遍**，而且评审若质疑「这些数字怎么来的」，
这些脚本就是答案。

## 前置

v2 是**单进程**：剪辑工具全部在 DSH 里跑，没有 Go 服务、没有 :8090。

```powershell
# 1) 启动 DSH（自动带上 goclip profile）
cd E:\huabei\goclip-agentv2
node runtime/start-dsh.mjs --host 127.0.0.1 --port 8098 --no-open

# 2) 一个开了调试端口的浏览器；下面的脚本默认连 9222
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
   --headless=new --remote-debugging-port=9222 `
   --user-data-dir="$env:TEMP\dsh-verify" about:blank
```

`<token>` 取启动时打印的 `?token=...`（每次重启都会变）。

## 确定性检查（probe-*）

| 脚本 | 覆盖 |
| --- | --- |
| `probe-runtime` | 项目/素材/时间线的基本读写与校验 |
| `probe-schema` | 表结构与约束（级联、CHECK、版本冲突） |
| `probe-roundtrip` | 关掉再打开后数据仍在 |
| `probe-evidence` | 声学/镜头/时序三维，用**结构已知**的合成素材核对数字 |
| `probe-evidence-view` | 证据总览：六维汇总到同一条时间轴、字段名、缺项如实上报 |
| `probe-multi` | 多素材拼接、导出、校验 |
| `probe-find` | 统一检索的条件组合与证据引用 |
| `probe-plan` | 方案（proposal）的版本与落地 |
| `probe-cloud-evidence` | 云端三维（转写/屏文字/画面描述）与吸附 |
| `probe-precision` | 区间吸附到镜头/语音边界的精度 |

`probe-evidence-view` 里有一条断言值得单独说：它断的是**字段名**（`start_us` 而不是
`startUs`）。时序证据的 payload 用 camelCase，面板读 snake_case，读错时每个停顿都变成
`null` 而 `counts` 仍报 1 —— 看上去像有数据。断言只比对数值时不会发现这种错。

## 在 Linux 上验证安装与启动（WSL2）

`setup.sh` / `start.sh` 是给云主机用的。**本机已经装好 WSL2 + Ubuntu 26.04 LTS**，
可以直接在真 Linux 上验，不必用桩件猜：

```powershell
# 发行版：Ubuntu-26.04（内核 6.18）。已装 node v24 / pnpm 11 / ffmpeg / build-essential / fonts-noto-cjk
wsl -d Ubuntu-26.04 -u root
```

```bash
# 仓库副本在 /root/app（rsync 进去的，走 Linux 文件系统，不经 /mnt）
cd /root/app
bash setup.sh                       # 依赖齐备时约 21 秒
cat > runtime/.env <<'EOF'          # 占位值即可，只为验证能启动
AUTOCLIP_TEXT_BASE_URL=https://example.invalid/compatible-mode/v1
AUTOCLIP_TEXT_MODEL=qwen3.8-omni-flash
AUTOCLIP_TEXT_API_KEY=placeholder
GOCLIP_OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com
GOCLIP_OSS_BUCKET=placeholder
GOCLIP_OSS_ACCESS_KEY_ID=placeholder
GOCLIP_OSS_ACCESS_KEY_SECRET=placeholder
EOF
setsid ./start.sh --host 127.0.0.1 --port 6006 --no-open > /tmp/goclip.log 2>&1 < /dev/null &
```

四个**只有在真 Linux 上才会踩到**的点：

1. **`build-essential` 是必需的。** 没有它 `pnpm install` 照样成功（1 分半），
   `pnpm run build` 才失败：`spawnSync cc ENOENT`。不能靠 install 的结果推断。
2. **后台要用 `setsid`，`nohup ... &` 不够。** 实测：`nohup` 起的进程在下一条
   `wsl.exe` 命令里就没了；`setsid` 才能真正脱离。
3. **只能绑 `127.0.0.1`。** DSH 的 CLI 拒绝 `0.0.0.0`，而 `webserver` 的配置类型是
   `127.0.0.1 | 0.0.0.0`，传容器地址会被配置校验拒绝。要让外面访问得加转发器：
   ```bash
   socat TCP-LISTEN:6006,bind=$(hostname -I | awk '{print $1}'),fork,reuseaddr TCP:127.0.0.1:6006
   ```
4. **`/?token=…` 是 303 + cookie。** 用 curl 验界面时必须 `-L -c jar -b jar`，
   否则拿到 0 字节，看起来像服务坏了。

```bash
# 验界面是否真的带上了证据面板
curl -sL -c /tmp/j -b /tmp/j "http://127.0.0.1:6006/?token=$TOKEN" \
  | grep -o '"id":"[^"]*"' | grep ui-evidence
```

## 在没有 Linux 的机器上验证 Linux 安装脚本（旧路，已不必要）

> WSL2 装好之后这一段基本用不上了，留着是因为它证明了「脚本自身逻辑」可以
> 脱离真实构建单独验。`.shim/` 把 `pnpm` 与 `ffmpeg` 换成记录型桩件：

```bash
# 在 Git Bash 里（不要设 MSYS_NO_PATHCONV，否则 Windows 版 node 读不懂 /e/... 路径）
SHIM=/e/huabei/goclip-agentv2/scripts/tools/verify/.shim
PATH="$SHIM:$PATH" bash /e/huabei/goclip-agentv2/setup.sh
```

桩件在**同一次运行里**同时负责两件事：拦掉基座的构建，以及在 profile 目录里
按 manifest 的 `link:` 项真的建出符号链接 —— 否则脚本最后那两句
「链接解析到了吗」的检查就检查了个空。

`pnpm` 桩件只在「当前目录同时有 `package.json` 和 `pnpm-workspace.yaml`」时动手，
也就是 profile；基座那两步直接放过。

## 读会话日志（多帧 zstd）

`~/.dsh/sessions/**/session.v4.jsonl.zstd` 是**一帧一次追加**写的，
`zstdDecompressSync` 只解第一帧，直接读会得到 250 字节的假象。

| 脚本 | 作用 | 用法 |
| --- | --- | --- |
| `read-session-log.mjs` | 逐帧解压并列出含关键词的事件 | `node read-session-log.mjs <log> [关键词] [截断长度]` |
| `dump-event.mjs` | 按事件类型导出（如 `tool/result`） | `node dump-event.mjs <log> tool/result <名称过滤> <截断长度>` |

排查「工具结果里的元数据到底存了什么」时用得上：`tool/result` 的 `data.meta`
就是界面卡片读的那份 `presentationMeta`。

## 界面驱动（cdp_*）

| 脚本 | 作用 | 用法 |
| --- | --- | --- |
| `cdp_final.py` | 总体巡检：会话数、按钮/图片/播放器就绪、曲线柱数与无障碍标签、页面错误；并截图 | `python cdp_final.py <token>` |
| `cdp_demo.py` | 切到指定项目并测量四列，截图 | `python cdp_demo.py <token> proj-demo` |
| `cdp_clean.py` | 新建会话后截图（演示用干净画面） | `python cdp_clean.py <token>` |
| `cdp_model.py` | **核对界面显示的模型名**是否与实际调用的模型一致 | `python cdp_model.py <token>` |
| `cdp_turn.py` | 发一轮真实提问，确认助手**真的调用工具** | `python cdp_turn.py <token> "现在有哪些项目？"` |
| `cdp_turn_port.py` | 同上，但指定端口（v2 用 8098） | `python cdp_turn_port.py 8098 <token> "…"` |
| `cdp_media.py` | 列出面板上每个媒体 URL，确认字节可取 | `python cdp_media.py <token> proj-demo` |
| `cdp_survey.py` | 列出界面上可点控件与输入框（写分镜时要确认控件真实存在） | `python cdp_survey.py <token>` |
| `cdp_send.py` | 往输入框发一条消息（**不等待**，用来自己控制等待节奏） | `python cdp_send.py 8098 <token> "…"` |
| `cdp_panel.py` | 读**最新一条** `video_evidence_view` 卡片渲染出的内容，并做「真的画出来了吗」的命中测试 | `python cdp_panel.py 8098 <token>` |
| `drive_record.py` | 驱动界面并用 `Page.startScreencast` 收帧，产出无声画面母版 | `python drive_record.py 9333` |

## 三个注意事项

1. **`cdp_turn*.py` / `cdp_send.py` 会真的发一条消息**，会写进会话历史，而且**消耗模型额度**。
   别在要拿去录演示的会话里跑它。
2. 往 Lexical 输入框里塞文字要用 CDP 的 `Input.insertText`。
   `document.execCommand('insertText')` 在它上面**静默失败**：`innerText` 仍是空的，
   回车提交的是空消息。
3. **`drive_record.py` 需要连一个非无头窗口**（端口 9333），因为要录可见画面。
   它与验收用的 9222 无头实例互不影响。

## 读界面时容易骗过自己的两件事

写 `cdp_panel.py` 时踩到的，都记在这里，免得下次再踩：

1. **同一次会话里会有多张同款卡片**。`document.querySelector` 拿到的是**第一条**，
   也就是最早那次调用的结果 —— 修复之后仍然会照着旧数据报「没问题」。
   要读最新的那条，取 `querySelectorAll(...)` 的**最后一个**。
2. **`getBoundingClientRect()` 返回了盒子，不等于它被画出来了**。
   工具行默认收在可折叠分组里，祖先带 `hidden` 属性时盒子照样有尺寸和坐标。
   所以截图前先用 `elementFromPoint` 在盒子上采样，确认采样点真的落在卡片内部；
   采样不通过就不要截图，否则截到的是同一坐标上的其它内容（这个坑我踩了两次）。

## 为什么不用 `ffmpeg gdigrab` 录屏

实测过：`gdigrab` 按窗口标题能匹配到 Chrome 窗口，但**整帧全黑** ——
Chrome 用 GPU 合成，GDI 的 BitBlt 读不到合成层。
`drive_record.py` 走 `Page.startScreencast`，与合成方式无关。
详见 `docs-参赛/11-演示视频分镜脚本.md` 的「一个已实测的坑」。
