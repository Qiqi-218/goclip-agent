#!/usr/bin/env bash
#
# 安装 goclip DSH 视频剪辑助手（Linux / macOS）
#
# 与 setup.ps1 做同样三件事，只是目标平台不同：
#   1) 安装并构建 DSH 基座（platform/dsh）
#   2) 把 config/profile 装进 runtime/home/profiles/video，并把插件的 link 路径改对
#   3) 把启动器摆到 runtime/start-dsh.mjs
#
# 云主机是 Linux，没有 PowerShell，所以这一份是必需的 —— 不是等价替换的偏好问题。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

for cmd in node pnpm ffmpeg; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "缺少 $cmd —— 先按部署手册 §3.2 装依赖" >&2
    exit 1
  fi
done

# 构建基座时需要 C 编译器。
#
# 这是**实测**出来的：在一台干净的 Ubuntu 26.04 上，pnpm install 顺利跑完
# （1 分 30 秒），紧接着 pnpm run build 在编译 DSH 的原生插件时失败：
#
#     Error: spawnSync cc ENOENT
#     Error: build: build:native-system exited with 1
#
# 也就是说"装得上依赖"和"构建得出来"之间还差一个 build-essential。
# 提前报出来，比让人等完一分半的 install 再看一个 ENOENT 强。
if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then
  echo '缺少 C 编译器：构建基座要编译原生插件，没有它会在 pnpm run build 阶段失败（报 spawnSync cc ENOENT）。' >&2
  echo '  先装一个，再重新运行本脚本：' >&2
  echo '    Debian/Ubuntu:  apt-get install -y build-essential' >&2
  echo '    RHEL/CentOS:    yum groupinstall -y "Development Tools"' >&2
  exit 1
fi

# 烧字幕用的字体必须先确认存在。
#
# 这一条是**实测**出来的，不是保险起见：把字幕烧进画面时 ffmpeg 走 libass，
# FontName 指向一个没装的字体时它**不报错**，只是什么都不画 —— 退出码 0、
# 文件正常生成、时长正常，但画面里一个字都没有。我拿 `FontName=NoSuchFontZZZ`
# 和真字体各渲染一帧比对过像素：两者墨迹完全相同（都是 0 个文字像素），
# 也就是说这种情况下"成功"的成片是一份静默残缺的交付物。
#
# 默认字体是 'Microsoft YaHei'（Windows 字体），而本脚本是给 Linux 用的，
# 所以这台机器上几乎必然命中上述情况 —— 与其等发布会现场发现，
# 不如在安装阶段就停下来。装不上字体的机器本来也做不了中文烧字幕。
#
# 实现上刻意**不用管道**。第一版写的是
#     if ! fc-list | grep -qiE '…'
# 在本机真实 Linux 上它误报「缺字体」：本脚本开头是 `set -euo pipefail`，
# 而 `grep -q` 命中第一行就退出，`fc-list` 随即收到 SIGPIPE 并以 141 结束，
# pipefail 于是把整条管道判为失败。这是时序敏感的假阴性 —— 同一行命令单独
# 跑是对的，放进这个脚本就错。所以这里先把输出收进变量再匹配，
# 不存在"谁先把谁关掉"的问题。
CJK_FONT_PATTERN='Noto Sans CJK|Noto Serif CJK|Source Han|WenQuanYi|Microsoft YaHei'
FONT_LIST="$(fc-list 2>/dev/null || true)"
if ! grep -qE "$CJK_FONT_PATTERN" <<<"$FONT_LIST"; then
  echo '缺少中文字体：烧进画面的中文字幕会变成一片空白，而且 ffmpeg 不会报错。' >&2
  echo '  先装一个，再重新运行本脚本：' >&2
  echo '    Debian/Ubuntu:  apt-get install -y fonts-noto-cjk' >&2
  echo '    RHEL/CentOS:    yum install -y google-noto-sans-cjk-fonts' >&2
  echo '  装完后用 `fc-list :lang=zh` 确认能看到字体。' >&2
  echo '  若字体名与默认值不同，还要把 config/profile/cordis.patch.yml 里' >&2
  echo '  video-workspace 的 subtitleFont 改成实际字体名（例如 "Noto Sans CJK SC"）。' >&2
  exit 1
fi

echo '[1/3] 安装并构建基座'
cd "$ROOT/platform/dsh"
pnpm install
pnpm run build
cd "$ROOT"

echo '[2/3] 安装 profile'
PROFILE="$ROOT/runtime/home/profiles/video"
mkdir -p "$PROFILE"
cp -R "$ROOT/config/profile/." "$PROFILE/"

# 两个包的 link 在 config/profile 里按那个位置写着 4 层 ..；装到
# runtime/home/profiles/video 之后只该有 3 层。路径按本机的实际位置算出来，
# 这样换机器、换绝对路径也不会写死。
#
# ui-evidence 是**独立的客户端插件包**，不是 video-workspace 的一部分：
# 界面里的证据面板由它提供，客户端 bundle 的清单是服务端按 loader 行扫包名
# 得到的，所以它必须自己出现在 profile 的依赖里，不能靠 link 别的包带进来。
VIDEO_PLUGIN="$ROOT/platform/dsh/packages/video/video-workspace"
EVIDENCE_PLUGIN="$ROOT/platform/dsh/packages/client/ui-evidence"
for pair in "dsh-video-workspace:$VIDEO_PLUGIN" "@deepseek-ai/dsh-client-ui-evidence:$EVIDENCE_PLUGIN"; do
  NAME="${pair%%:*}"
  DIR="${pair#*:}"
  if [ ! -d "$DIR" ]; then
    echo "找不到插件包：$DIR" >&2
    exit 1
  fi
  REL="$(node -e 'const p=require("path");const r=process.argv[1],t=process.argv[2];let x=p.relative(r,t).split(p.sep).join("/");if(!x.startsWith("."))x="./"+x;process.stdout.write(x)' "$PROFILE" "$DIR")"
  node -e '
const fs = require("fs")
const [manifestPath, name, link] = process.argv.slice(1)
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
manifest.dependencies = manifest.dependencies || {}
manifest.dependencies[name] = "link:" + link
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
' "$PROFILE/package.json" "$NAME" "$REL"
  echo "      $NAME -> link:$REL"
done

cd "$PROFILE"
pnpm install
cd "$ROOT"

for NAME in dsh-video-workspace @deepseek-ai/dsh-client-ui-evidence; do
  if [ ! -f "$PROFILE/node_modules/$NAME/package.json" ]; then
    echo "profile 装完了但 $NAME 链接解析不到，检查 $PROFILE/package.json" >&2
    exit 1
  fi
done

echo '[3/3] 安装启动器'
cp "$ROOT/config/start-dsh.mjs" "$ROOT/runtime/start-dsh.mjs"

if [ ! -f "$ROOT/runtime/.env" ]; then
  echo '注意：还没有 runtime/.env —— 按部署手册 §3.4 填写后再启动。'
fi

echo '安装完成。配置 runtime/.env 后运行 ./start.sh'
