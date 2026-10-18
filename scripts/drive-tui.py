#!/usr/bin/env python3
"""Drive a real Pi TUI through a pty and capture what it renders.

Usage: drive_pi.py <workdir> <outfile> <command> [seconds]
"""

import fcntl
import os
import pty
import struct
import termios
import select
import signal
import sys
import time

workdir, outfile, command = sys.argv[1], sys.argv[2], sys.argv[3]
commands = [part for part in command.split(";;") if part]
open_seconds = float(sys.argv[4]) if len(sys.argv) > 4 else 8.0
KEYS = {
    "RIGHT": b"\x1b[C",
    "LEFT": b"\x1b[D",
    "UP": b"\x1b[A",
    "DOWN": b"\x1b[B",
    "TAB": b"\t",
    "ENTER": b"\r",
    "ESC": b"\x1b",
}
key_script = [KEYS.get(name, name.encode()) for name in sys.argv[5:]]
# Emulate a real terminal size; the pty default is 80x24, which is far narrower
# than the terminals this panel is designed for.
COLS = int(os.environ.get("PI_DRIVE_COLS", "0") or 0)
ROWS = int(os.environ.get("PI_DRIVE_ROWS", "0") or 0)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(workdir)
    os.environ["TERM"] = "xterm-256color"
    extra = [part for part in os.environ.get("PI_DRIVE_ARGS", "").split(" ") if part]
    os.execvp("pi", ["pi", "-a", *extra])

if COLS and ROWS:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

chunks = []
start = time.time()
sent_command = False
sent_escape = False
sent_keys = 0
sent_commands = 0
killed = False

while True:
    elapsed = time.time() - start
    if elapsed > open_seconds and not sent_escape:
        os.write(fd, b"\x1b")
        sent_escape = True
    if elapsed > open_seconds + 1.5 and not killed:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        killed = True
    if elapsed > open_seconds + 2.5:
        break
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)
    # Commands separated by ";;" are sent one after another, so a scenario like
    # "continue, then open the panel" can be driven in one run.
    if sent_commands < len(commands) and elapsed > 2.5 + sent_commands * 3.5:
        os.write(fd, commands[sent_commands].encode() + b"\r")
        sent_commands += 1
        sent_command = sent_commands >= len(commands)
    # One scripted key every 1.2s, starting once the panel has had time to open.
    if sent_command and sent_keys < len(key_script):
        due = 3.0 + len(commands) * 3.5 + sent_keys * 1.2
        if elapsed > due:
            os.write(fd, key_script[sent_keys])
            sent_keys += 1

with open(outfile, "wb") as handle:
    handle.write(b"".join(chunks))
print(f"captured {sum(len(c) for c in chunks)} bytes into {outfile}")
