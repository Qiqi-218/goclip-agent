"""Emit a video's shot boundaries as JSON on standard output.

Run with the interpreter that has PySceneDetect installed:

    python shots.py <video path>

The Go side drives this rather than reimplementing frame-difference detection,
because PySceneDetect is the maintained implementation of exactly this and
hand-rolling it would mean owning a threshold that already has a decade of
tuning. Output is a bare JSON object so the caller parses one thing:

    {"scene_count": 4, "scenes": [{"index": 1, "start_us": 0, "end_us": ...}, ...]}

Every failure exits non-zero with a reason on standard error; a caller that gets
empty output must treat it as a failure, not as a video with no cuts.
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: shots.py <video path>", file=sys.stderr)
        return 2

    try:
        from scenedetect import ContentDetector, SceneManager, open_video
    except ImportError as exc:  # the interpreter simply lacks the dependency
        print(f"PySceneDetect is not installed for this interpreter: {exc}", file=sys.stderr)
        return 3

    path = sys.argv[1]
    try:
        video = open_video(path)
    except Exception as exc:
        print(f"cannot open {path}: {exc}", file=sys.stderr)
        return 4

    manager = SceneManager()
    # ContentDetector's defaults are the library's own recommendation. A
    # deployment that needs a different threshold changes it here rather than
    # having the Go side guess at one.
    manager.add_detector(ContentDetector())
    try:
        manager.detect_scenes(video, show_progress=False)
    except Exception as exc:
        print(f"scene detection failed: {exc}", file=sys.stderr)
        return 5

    scenes = []
    for index, (start, end) in enumerate(manager.get_scene_list(), start=1):
        scenes.append({
            "index": index,
            # `seconds` is the current property; `get_seconds()` is deprecated and
            # warned on every boundary, which would fill the caller's error
            # channel with noise it might read as a failure.
            "start_us": int(start.seconds * 1_000_000),
            "end_us": int(end.seconds * 1_000_000),
        })

    json.dump({"scene_count": len(scenes), "scenes": scenes}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
