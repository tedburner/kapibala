"""用 POSIX 真实 PTY 验证准入 fixture；不替代 Core 工具事务或桌面 IME 实测。"""
import argparse
import json
import os
import pty
import select
import signal
import subprocess
import termios
import time
import fcntl
import struct


def scenario(node, root, admission, action):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    before = termios.tcgetattr(slave)
    script = "v0.0.8-editor-admission.mjs" if action == "editor" else "v0.0.8-terminal-fixture.mjs"
    command = [node, os.path.join(root, "scripts", script), admission]
    if action == "editor":
        command.append("--interactive")
    proc = subprocess.Popen(
        command,
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        env={**os.environ, "TERM": "xterm-256color", "CI": "false"},
    )
    captured = bytearray()
    cursor = 0

    def expect(text, timeout=15):
        nonlocal cursor
        target = text.encode()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            index = captured.find(target, cursor)
            if index >= 0:
                cursor = index + len(target)
                return
            if select.select([master], [], [], 0.05)[0]:
                try:
                    captured.extend(os.read(master, 65536))
                except OSError:
                    break
        raise AssertionError(f"missing {text!r}: {captured[-3000:]!r}")

    try:
        if action == "editor":
            expect("ready=true")
            os.write(master, "中文e\u0301".encode())
            expect("中文e\u0301")
            os.write(master, b"\x1b[13;2u")
            os.write(master, b"\x1b[200~F:\\Project\\kapibala\r\n/exit\x1b[201~")
            expect("F:\\Project\\kapibala")
            expect("/exit")
            for rows, columns in ((8, 20), (70, 80), (6, 12), (24, 80)):
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
                os.kill(proc.pid, signal.SIGWINCH)
                time.sleep(0.1)
            os.write(master, b"\x1b[5~")
            expect("scroll=5")
            os.write(master, b"\x03")
            expect("EDITOR_ADMISSION_CLOSED")
            code = proc.wait(timeout=10)
            assert code == 0, code
            expect('"logicalLines":3')
            expect('"columns":80')
        else:
            expect("phase=idle paste=0")
        if action == "fatal":
            os.write(master, b"f")
            expect("ADMISSION_FATAL")
            code = proc.wait(timeout=10)
            assert code != 0, code
            assert b"ADMISSION_CLOSED" not in captured
        elif action != "editor":
            os.write(master, b"r")
            expect("phase=running")
            if action == "sigint":
                os.kill(proc.pid, signal.SIGINT)
            else:
                os.write(master, b"\x03")
            expect("phase=cancelling")
            expect("phase=idle")
            assert b"\x1b[?1049l" not in captured, "cancel must retain alternate screen"
            os.write(master, b"\x1b[200~qrf\r\n\x03\x1b[201~")
            expect("paste=1")
            os.write(master, b"r")
            expect("phase=running")
            os.write(master, b"q")
            expect("ADMISSION_CLOSED")
            code = proc.wait(timeout=10)
            assert code == 0, code
        assert b"\x1b[?1049h" in captured
        assert b"\x1b[?1049l" in captured
        assert b"\x1b[?2004l" in captured
        assert before == termios.tcgetattr(slave), "original terminal attributes not restored"
        return {"scenario": action, "exitCode": code, "terminalRestored": True}
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        os.close(master)
        os.close(slave)


parser = argparse.ArgumentParser()
parser.add_argument("node")
parser.add_argument("root")
parser.add_argument("admission")
parser.add_argument("--editor", action="store_true")
args = parser.parse_args()
results = [scenario(args.node, args.root, args.admission, action)
           for action in (("editor",) if args.editor else ("ctrl-c", "sigint", "fatal"))]
print(json.dumps({"platform": os.uname().sysname, "scenarios": results}, indent=2))
