"""Pre-submission gate.

Checks the three things that void a submission if wrong, mechanically, so nobody
has to remember them at 23:00 on the last day:

  1. The demo video: format, duration and size at the official limits.
  2. The design document: required chapters present, and unfilled placeholders
     called out loudly.
  3. Secrets: no credential in anything the repositories track.

Exit status is 1 when anything fails, so it can gate a release step.

Usage:
    python tools/preflight.py [--video PATH] [--docs DIR] [--no-repos]
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

# Official limits, from the competition scheme: 时长不应超过 5 分钟，
# 不得超过 150MB，文件应为 MP4 格式（不接受其他格式）.
MAX_SECONDS = 300.0
MAX_BYTES = 150 * 1024 * 1024

# Chapters the notice requires by name: 需求分析、设计思路、功能模块、工具平台介绍.
REQUIRED_CHAPTERS = {
    '需求分析': ('## §2', '需求分析'),
    '设计思路': ('## §3', '设计思路'),
    '功能模块': ('## §4', '功能模块'),
    '工具平台': ('## §7', '工具平台'),
    'AI 声明': ('## §14', 'AI 使用声明'),
    '开源清单': ('## §16', '第三方开源'),
}

# Placeholders that mean a human still has to decide something.
PLACEHOLDERS = [
    (r'_{3,}', '下划线占位'),
    (r'约\s*_+%', 'AI 写码比例未填'),
    (r'待填', '标注待填'),
]

# Key material only: a bare ``token =`` assignment is a field name far more often
# than a credential, and flagging field names buries the real finding.
SECRET_PATTERNS = [
    (r'sk-[A-Za-z0-9]{32,}', 'OpenAI 风格密钥'),
    (r'AKID[A-Za-z0-9]{16,}', '腾讯云 SecretId'),
    (r'LTAI[A-Za-z0-9]{12,}', '阿里云 AccessKey'),
    (r'(?i)(api[_-]?key|apikey|secret|access[_-]?key|password)\s*[:=]\s*["\']([A-Za-z0-9/+_\-]{32,})["\']', '硬编码密钥'),
]

# Values that look like keys but are obviously placeholders. Upstream test
# fixtures are full of these, and reporting them trains the reader to ignore the
# report — which is worse than not reporting at all.
PLACEHOLDER_HINTS = (
    'test', 'dummy', 'fake', 'example', 'sample', 'placeholder', 'redact',
    'xxxx', 'aaaa', '0000', '1234', 'your-', 'changeme', 'not-a-real',
)


def looks_like_placeholder(value: str) -> bool:
    """Report whether a matched value is a placeholder rather than a credential."""
    lowered = value.lower()
    if any(hint in lowered for hint in PLACEHOLDER_HINTS):
        return True
    # A real key has variety; a fixture often repeats one character or counts up.
    if len(set(lowered)) < 8:
        return True
    return False


# Only the parts of a checkout we own. Scanning an upstream project's whole tree
# reports its test fixtures, which are not ours to fix and not a finding.
OWNED_PATHS = (
    'apps/video-agent/',                     # the whole service belongs to this project
    'platform/dsh/packages/video/',           # only the plugin is ours in the upstream harness
)


def check_secrets(repos: list[Path]) -> None:
    print('\n[3/3] 仓库里有没有密钥')
    if not repos:
        print('  (已跳过)')
        return
    for repo in repos:
        if not (repo / '.git').exists():
            warn(f'不是 git 仓库，跳过：{repo}')
            continue
        scopes = OWNED_PATHS
        print(f'  （只扫描我们自己的路径：{", ".join(scopes)}）')
        listed = subprocess.run(['git', 'ls-files'], cwd=repo,
                                capture_output=True, text=True, shell=False)
        if listed.returncode != 0:
            warn(f'列不出文件：{repo}')
            continue
        tracked = 0
        skipped_placeholder = 0
        found = 0
        for rel in listed.stdout.splitlines():
            if not any(rel.startswith(scope) for scope in scopes):
                continue
            target = repo / rel
            if not target.is_file() or target.stat().st_size > 2_000_000:
                continue
            try:
                body = target.read_text(encoding='utf-8', errors='ignore')
            except OSError:
                continue
            tracked += 1
            for pattern, label in SECRET_PATTERNS:
                for match in re.finditer(pattern, body):
                    value = match.group(match.lastindex or 0)
                    if looks_like_placeholder(value):
                        skipped_placeholder += 1
                        continue
                    found += 1
                    bad(f'疑似密钥：{repo.name}/{rel}', f'{label} · {value[:6]}…')
        if found == 0:
            note = f'{tracked} 个受版本控制的文本文件里没有密钥特征'
            if skipped_placeholder:
                note += f'（另有 {skipped_placeholder} 处形似占位值，已忽略）'
            ok(f'{repo.name}：{note}')
        dirty = subprocess.run(['git', 'status', '--porcelain'], cwd=repo,
                               capture_output=True, text=True, shell=False).stdout
        untracked = [l for l in dirty.splitlines() if l.startswith('?? ')]
        if untracked:
            warn(f'{repo.name} 有未跟踪文件',
                 '未跟踪即不会被提交，但要确认里面没有本该提交的东西')

failures = []
warnings = []


def ok(label, detail=''):
    print(f'  \033[32mPASS\033[0m  {label}' + (f'  {detail}' if detail else ''))


def bad(label, detail=''):
    failures.append(label)
    print(f'  \033[31mFAIL\033[0m  {label}' + (f'  {detail}' if detail else ''))


def warn(label, detail=''):
    warnings.append(label)
    print(f'  \033[33mWARN\033[0m  {label}' + (f'  {detail}' if detail else ''))


def check_video(path: Path) -> None:
    print('\n[1/3] 演示视频')
    if not path.exists():
        bad('视频文件不存在', str(path))
        return
    size = path.stat().st_size
    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration,format_name',
         '-show_entries', 'stream=codec_name,width,height', '-of', 'json', str(path)],
        capture_output=True, text=True, shell=False)
    if probe.returncode != 0:
        bad('ffprobe 读不出这个文件', probe.stderr.strip()[:120])
        return
    import json
    data = json.loads(probe.stdout)
    fmt = data.get('format', {})
    duration = float(fmt.get('duration', 0))
    names = fmt.get('format_name', '')
    streams = data.get('streams', [])
    video_stream = next((s for s in streams if s.get('codec_name') not in ('aac', 'mp3')), {})

    if 'mp4' in names:
        ok('容器是 MP4', names)
    else:
        bad('容器不是 MP4', f'实际 {names} —— 官方不接受其他格式')

    if duration <= MAX_SECONDS:
        ok('时长在 5 分钟内', f'{duration:.1f}s / 上限 {MAX_SECONDS:.0f}s')
    else:
        bad('时长超 5 分钟', f'{duration:.1f}s')

    if size <= MAX_BYTES:
        ok('体积在 150MB 内', f'{size/1024/1024:.1f}MB / 上限 150MB')
    else:
        bad('体积超 150MB', f'{size/1024/1024:.1f}MB')

    mbps = size * 8 / duration / 1e6 if duration else 0
    print(f'        实际码率 {mbps:.2f} Mbps；{video_stream.get("width")}x{video_stream.get("height")}')
    if size > MAX_BYTES * 0.95:
        warn('体积余量不足 5%', '接近上限，换片源或调 CRF 后请重跑本检查')


def check_docs(docs: Path) -> None:
    print('\n[2/3] 设计文档')
    doc = docs / '09-软件创意设计文档.md'
    if not doc.exists():
        bad('设计文档不存在', str(doc))
        return
    text = doc.read_text(encoding='utf-8')
    for label, (prefix, needle) in REQUIRED_CHAPTERS.items():
        if prefix in text and needle in text:
            ok(f'章节存在：{label}')
        else:
            bad(f'缺少章节：{label}', f'找 {prefix} / {needle}')

    if '尚未套用大赛官网模板' in text:
        warn('文档仍未套用官网模板', '提交前必须套模板并导出 PDF，否则文档不合规')

    for pattern, label in PLACEHOLDERS:
        hits = re.findall(pattern, text)
        if hits:
            warn(f'仍有未填占位（{label}）', f'{len(hits)} 处')
        else:
            ok(f'无占位：{label}')

    for name in ('10-公网部署实作手册.md', '11-演示视频分镜脚本.md'):
        if (docs / name).exists():
            ok(f'配套文档存在：{name}')
        else:
            warn(f'配套文档缺失：{name}')

    shots = docs / '截图'
    images = sorted(shots.glob('*.png')) if shots.exists() else []
    if len(images) >= 3:
        ok('作品简介截图 ≥3 张', f'{len(images)} 张')
    else:
        bad('作品简介截图不足 3 张', f'实际 {len(images)} 张 —— 官方要求 3 幅核心功能截图')


def main() -> int:
    here = Path(__file__).resolve().parent.parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', default=str(here / 'demo-submit.mp4'))
    ap.add_argument('--docs', default=str(here / 'docs-参赛'))
    ap.add_argument('--no-repos', action='store_true')
    args = ap.parse_args()

    print('提交前检查（本脚本只看硬约束，不判断内容好坏）')
    check_video(Path(args.video))
    check_docs(Path(args.docs))
    repos = [] if args.no_repos else [here]
    check_secrets(repos)

    print()
    if failures:
        print(f'\033[31m{len(failures)} 项不合格 —— 修掉再来。\033[0m')
        for item in failures:
            print(f'  · {item}')
        return 1
    if warnings:
        print(f'\033[33m硬约束全部通过，但有 {len(warnings)} 项需要人确认：\033[0m')
        for item in warnings:
            print(f'  · {item}')
        return 0
    print('\033[32m全部通过。\033[0m')
    return 0


if __name__ == '__main__':
    sys.exit(main())
