"""A private parent pipe gates model loading and owns decoder lifetimes."""
import os
import queue
import subprocess
import sys
import threading
import time

if os.name == 'nt':
    import ctypes
    from ctypes import wintypes
    import msvcrt


class ParentPipeError(Exception):
    pass


class ParentPipe:
    def __init__(self):
        self._commands = queue.Queue(maxsize=8)
        self._lock = threading.Lock()
        self._closed = False
        self._children = set()
        self._fd = sys.stdin.fileno()
        if os.name == 'nt':
            # Parse CRLF ourselves; CRT text-mode lookahead after a partial CR
            # could otherwise turn an available-byte read into a blocking read.
            msvcrt.setmode(self._fd, os.O_BINARY)
            self._pipe_handle = msvcrt.get_osfhandle(self._fd)
            self._kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            self._peek_pipe = self._kernel.PeekNamedPipe
            self._peek_pipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD)]
            self._peek_pipe.restype = wintypes.BOOL
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read_block(self):
        if os.name != 'nt':
            return os.read(self._fd, 64)
        # A blocking CRT read holds stdin's descriptor lock. Native module loading
        # (including NumPy/OpenBLAS) can need that lock and deadlock before any
        # next ACK is possible. Poll the OS pipe, then read only available bytes.
        while not self._closed:
            available = wintypes.DWORD()
            if not self._peek_pipe(self._pipe_handle, None, 0, None, ctypes.byref(available), None):
                error = ctypes.get_last_error()
                if error in (109, 232):  # ERROR_BROKEN_PIPE / ERROR_NO_DATA
                    return b''
                raise OSError(error, 'Parent pipe is unavailable')
            if available.value:
                return os.read(self._fd, min(64, available.value))
            time.sleep(0.02)
        return b''

    def _terminate(self):
        # Spawn and registration use the same lock: EOF cannot strand a decoder
        # between Popen returning and its handle being recorded.
        with self._lock:
            if self._closed:
                return
            self._closed = True
            children = tuple(self._children)
            for child in children:
                if child.poll() is None:
                    try:
                        child.kill()
                    except OSError:
                        pass
        for child in children:
            try:
                child.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass
        # Do not wait for model inference, the next ACK, or Python finalizers.
        os._exit(1)

    def _read(self):
        pending = b''
        try:
            while True:
                # Avoid a daemon holding the buffered sys.stdin lock at shutdown.
                block = self._read_block()
                if not block:
                    break
                pending += block
                if len(pending) > 128:
                    break
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    command = line.rstrip(b'\r')
                    if command not in (b'start', b'continue'):
                        self._terminate()
                        return
                    self._commands.put_nowait(command)
        except (OSError, queue.Full):
            pass
        self._terminate()

    def expect(self, command):
        if self._commands.get() != command.encode('ascii'):
            raise ParentPipeError('ACK_REQUIRED')

    def run_decoder(self, command, *, timeout):
        with self._lock:
            if self._closed:
                raise ParentPipeError('ACK_REQUIRED')
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            self._children.add(child)
        try:
            returncode = child.wait(timeout=timeout)
            with self._lock:
                if self._closed:
                    raise ParentPipeError('ACK_REQUIRED')
            return subprocess.CompletedProcess(command, returncode)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            with self._lock:
                self._children.discard(child)

    def close(self):
        with self._lock:
            self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
