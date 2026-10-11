"""用 POSIX 标准库 PTY 验收真实 CLI，不连接外部模型或读取真实凭据。"""

import codecs
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

node, root = sys.argv[1:3]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 120, 0, 0))
child = subprocess.Popen(
    [node, os.path.join(root, 'scripts/v0.0.5-terminal-check.mjs'), root],
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
)
os.close(slave)
decoder = codecs.getincrementaldecoder('utf-8')('replace')
captured = ''
cursor = 0


def receive_until(needle, timeout=15):
    """只从上次观测之后寻找边界，防止将旧提示符误当成当前任务完成。"""
    global captured, cursor
    deadline = time.monotonic() + timeout
    while needle not in captured[cursor:]:
        if time.monotonic() >= deadline:
            raise AssertionError('PTY boundary timeout: ' + needle + '\n' + captured[-2000:])
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                chunk = b''
            if not chunk:
                raise AssertionError('PTY ended before boundary: ' + needle)
            captured += decoder.decode(chunk)
    end = captured.index(needle, cursor) + len(needle)
    observed = captured[cursor:end]
    cursor = end
    return observed


def send(value):
    os.write(master, value.encode('utf-8'))


try:
    receive_until(' ❯ ')
    send('/skill g')
    receive_until('/skill g')
    send('\t')
    receive_until('uide')
    send(' task "a  b"\r\x0f')
    receive_until('TTY_THOUGHT_0')
    # 真正改变终端尺寸并通知整个会话进程组，后续工具/底栏不能使用旧宽度锚点。
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 52, 0, 0))
    os.killpg(child.pid, signal.SIGWINCH)
    receive_until('选择: ')
    before = captured.count('本轮过程详情快照')
    send('\x0f1\r')
    receive_until('TTY_TASK_DONE')
    receive_until(' ❯ ')
    assert captured.count('本轮过程详情快照') == before, 'modal Ctrl+O must not toggle'
    assert 'TTY_RESOURCE_SAFE' in captured
    assert 'already_present' in captured
    assert 'TTY_INTERMEDIATE_ANSWER' in captured
    send('/model key terminal\r')
    receive_until('新 API Key: ')
    send('\x0fLOCAL_TEST_VALUE\r')
    receive_until(' ❯ ')
    assert 'LOCAL_TEST_VALUE' not in captured, 'secret must never echo'
    send('/skill guide cancel task\r\x0f\x03')
    receive_until('已请求中止')
    receive_until(' ❯ ')
    send('\x04')
    receive_until('"approvedFile":true')
    assert child.wait(timeout=10) == 0
    result = {
        'platform': 'posix-pty', 'passed': True,
        'checks': ['metadata-tab-completion', 'Ctrl+O-toggle', 'resize-52-columns',
                   'approval-Ctrl+O-blocked', 'approval-answer-clean', 'secret-no-echo',
                   'Ctrl+C-cleanup', 'EOF-clean-exit', 'approved-file-effect'],
    }
    print(json.dumps(result))
finally:
    os.close(master)
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=10)
