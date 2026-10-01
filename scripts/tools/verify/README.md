# 验收复现工具

这些脚本不是产品的一部分，而是**验收用的驱动脚本**：它们通过浏览器 DevTools 协议
驱动**真实界面**（点真实按钮、读真实 DOM、收真实网络响应），所以「验收通过」这句话
可以随时重跑复核，而不是只留一句结论。

留在源码里，是因为提交前需要**再跑一遍**，而且评审若质疑「这些数字怎么来的」，
这些脚本就是答案。

## 前置

```powershell
# 1) 两个进程都要在跑
pwsh -File E:\huabei\start-assistant.ps1

# 2) 一个开了调试端口的浏览器（无头即可，脚本不依赖窗口）
#    端口用 9222；下面的脚本默认连它
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
   --headless=new --remote-debugging-port=9222 `
   --user-data-dir="$env:TEMP\dsh-verify" about:blank
```

## 脚本

| 脚本 | 作用 | 用法 |
| --- | --- | --- |
| `cdp_final.py` | 总体巡检：会话数、按钮/图片/播放器就绪、曲线柱数与无障碍标签、页面错误；并截图 | `python cdp_final.py <token>` |
| `cdp_demo.py` | 切到指定项目并测量四列，截图 | `python cdp_demo.py <token> proj-demo` |
| `cdp_clean.py` | 新建会话后截图（演示用干净画面） | `python cdp_clean.py <token>` |
| `cdp_model.py` | **核对界面显示的模型名**是否与实际调用的模型一致 | `python cdp_model.py <token>` |
| `cdp_turn.py` | 发一轮真实提问，确认助手**真的调用工具** | `python cdp_turn.py <token> "现在有哪些项目？"` |
| `cdp_media.py` | 列出面板上每个媒体 URL，确认字节可取 | `python cdp_media.py <token> proj-demo` |
| `cdp_survey.py` | 列出界面上可点控件与输入框（写分镜时要确认控件真实存在） | `python cdp_survey.py <token>` |
| `drive_record.py` | 驱动界面并用 `Page.startScreencast` 收帧，产出无声画面母版 | `python drive_record.py 9333` |

`<token>` 取 `dsh web` 启动时打印的 `?token=...`。

## 两个注意事项

1. **`cdp_turn.py` 会真的发一条消息**，会写进会话历史。别在要拿去录演示的会话里跑它。
2. **`drive_record.py` 需要连一个非无头窗口**（端口 9333），因为要录可见画面。
   它与验收用的 9222 无头实例互不影响。

## 为什么不用 `ffmpeg gdigrab` 录屏

实测过：`gdigrab` 按窗口标题能匹配到 Chrome 窗口，但**整帧全黑** ——
Chrome 用 GPU 合成，GDI 的 BitBlt 读不到合成层。
`drive_record.py` 走 `Page.startScreencast`，与合成方式无关。
详见 `docs-参赛/11-演示视频分镜脚本.md` 的「一个已实测的坑」。
