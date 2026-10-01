#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
session-tools 删除审计工具

用途：查看 dsh-session-tools 插件"删除"过的内容。
原理：删除只是往会话日志尾部追加一条"墓碑"（user/message + surfaceOp: replace），
      把目标区间从**模型可见的上下文**里遮蔽掉。原始事件一个字都没改，
      所以随时可以在这里把原文读回来。

用法：
    PYTHONPATH=tools/pylibs <python> dsh-plugins/session-tools/tools/audit_deletions.py [关键词]

    不给关键词 → 列出全部墓碑的概况
    给关键词   → 筛选（匹配被删内容的预览，或所在会话名）
    加 --full  → 连被遮蔽的原文一起打印（可能很长）
"""
import sys, os, json, glob, subprocess

SESSIONS = os.path.expanduser("~/.dsh/sessions")
PRODUCER = "session-tools"


def load_events(path):
    """解压并解析 .jsonl.zstd"""
    try:
        raw = subprocess.run(["zstd", "-dc", path], capture_output=True, timeout=120).stdout
    except Exception as e:
        return []
    out = []
    for line in raw.split(b"\n"):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def text_of(event):
    """把一条事件的可见文字抠出来"""
    d = event.get("data") or {}
    blocks = []
    if event.get("type") == "user/message":
        blocks = d.get("content") or []
    elif event.get("type") == "assistant/message":
        blocks = ((d.get("message") or {}).get("content")) or []
    elif event.get("type") == "tool/result":
        return "[工具结果]"
    parts = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text" and b.get("text"):
            parts.append(b["text"])
        elif b.get("type") == "reasoning" and b.get("text"):
            parts.append("[思考] " + b["text"][:200])
    return "\n".join(parts).strip()


def main():
    keyword = None
    show_full = "--full" in sys.argv
    for a in sys.argv[1:]:
        if not a.startswith("--"):
            keyword = a
    pattern = os.path.join(SESSIONS, "*", "*", "session.v4.jsonl.zstd")
    files = sorted(glob.glob(pattern))
    if not files:
        print("没找到会话日志，路径：", pattern)
        return
    total_tombs = 0
    for path in files:
        events = load_events(path)
        if not events:
            continue
        tombs = [
            e for e in events
            if e.get("type") == "user/message"
            and ((e.get("data") or {}).get("source") or {}).get("producer") == PRODUCER
        ]
        if not tombs:
            continue
        sid = os.path.basename(os.path.dirname(path))
        by_seq = {e["seq"]: e for e in events if isinstance(e.get("seq"), int)}
        rows = []
        for t in tombs:
            src = (t.get("data") or {}).get("source") or {}
            preview = src.get("preview", "")
            if keyword and keyword not in preview and keyword not in sid:
                continue
            rows.append((t, src))
        if not rows:
            continue
        print(f"\n{'='*78}")
        print(f"会话 {sid}")
        print(f"  共 {len(tombs)} 条墓碑" + (f"，匹配「{keyword}」的 {len(rows)} 条" if keyword else ""))
        print(f"{'='*78}")
        for t, src in rows:
            removed = src.get("removed") or []
            print(f"\n  墓碑 seq={t['seq']}  动作={src.get('action')}  遮蔽 {len(removed)} 个事件")
            print(f"  被删内容预览：{src.get('preview','(无)')[:70]!r}")
            if show_full:
                print("  ---- 以下为原始内容（模型已看不到，日志里仍在）----")
                for s in removed:
                    e = by_seq.get(s)
                    if not e:
                        print(f"    seq={s}  (日志中已无此事件)")
                        continue
                    txt = text_of(e)
                    if txt:
                        print(f"    seq={s} [{e['type']}]")
                        for line in txt.split("\n"):
                            print(f"      {line}")
                print("  " + "-" * 60)
            total_tombs += 1
    print(f"\n扫描完成：{len(files)} 个会话文件，命中 {total_tombs} 条墓碑。")
    if not show_full:
        print("（想看被遮蔽的原文，加 --full；想筛选，加关键词）")


if __name__ == "__main__":
    main()
