"""Lightweight real-process tests; no model, media service, or credentials."""
import ctypes
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


SOURCE = str(Path(__file__).resolve().parent)


def wait_until(condition):
    deadline = time.monotonic() + 5
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError('Timed out waiting for controlled child')
        time.sleep(0.02)


class ObservedProcess:
    """Keep a Windows handle so exit checks cannot accidentally refer to PID reuse."""
    def __init__(self, pid):
        self.pid = pid
        self.handle = None
        if os.name == 'nt':
            from ctypes import wintypes
            self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            self.kernel.OpenProcess.restype = wintypes.HANDLE
            self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            self.kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
            self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            self.handle = self.kernel.OpenProcess(0x00100000 | 0x0001, False, pid)
            if not self.handle:
                raise OSError(ctypes.get_last_error())

    def wait(self):
        if self.handle:
            if self.kernel.WaitForSingleObject(self.handle, 5000) != 0:
                raise AssertionError('Decoder survived its parent pipe')
        else:
            def exited():
                try:
                    os.kill(self.pid, 0)
                    return False
                except ProcessLookupError:
                    return True
            wait_until(exited)

    def close(self):
        if self.handle:
            if self.kernel.WaitForSingleObject(self.handle, 0) != 0:
                self.kernel.TerminateProcess(self.handle, 1)
            self.kernel.CloseHandle(self.handle)
        else:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


class ParentPipeTests(unittest.TestCase):
    def launch(self, body):
        source = f'import sys,time\nsys.path.insert(0,{SOURCE!r})\nfrom parent_pipe import ParentPipe\n{body}'
        child = subprocess.Popen([sys.executable, '-u', '-c', source], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        def cleanup():
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()
        self.addCleanup(cleanup)
        return child

    def test_eof_before_start_exits_without_starting_work(self):
        child = self.launch("with ParentPipe() as parent:\n print('waiting',flush=True)\n parent.expect('start')\n print('started',flush=True)\n")
        self.assertEqual(child.stdout.readline().strip(), b'waiting')
        child.stdin.close()
        self.assertNotEqual(child.wait(timeout=5), 0)
        self.assertEqual(child.stdout.read(), b'')

    def test_eof_during_work_does_not_wait_for_next_ack(self):
        child = self.launch("with ParentPipe() as parent:\n parent.expect('start')\n print('started',flush=True)\n time.sleep(60)\n")
        child.stdin.write(b'start\n')
        child.stdin.flush()
        self.assertEqual(child.stdout.readline().strip(), b'started')
        child.stdin.close()
        self.assertNotEqual(child.wait(timeout=5), 0)

    def test_start_and_commit_ack_allow_clean_exit(self):
        child = self.launch("with ParentPipe() as parent:\n parent.expect('start')\n print('chunk',flush=True)\n parent.expect('continue')\n print('done',flush=True)\n")
        child.stdin.write(b'start\n')
        child.stdin.flush()
        self.assertEqual(child.stdout.readline().strip(), b'chunk')
        child.stdin.write(b'continue\n')
        child.stdin.flush()
        self.assertEqual(child.wait(timeout=5), 0)
        self.assertEqual(child.stdout.read().strip(), b'done')
        self.assertEqual(child.stderr.read(), b'')

    @unittest.skipUnless(os.name == 'nt' and importlib.util.find_spec('numpy') is not None,
                         'Windows with NumPy is required for the native-loader regression')
    def test_idle_parent_pipe_does_not_block_numpy_native_module_loading(self):
        # stdin deliberately remains open and idle while NumPy loads its DLLs.
        # A blocked os.read on Windows formerly held a CRT lock needed here.
        # The C-level timeout makes a regression fail instead of hanging tests.
        child = self.launch("import faulthandler\nfaulthandler.dump_traceback_later(10,exit=True)\n"
            "with ParentPipe() as parent:\n parent.expect('start')\n import numpy\n"
            " print('numpy-ready',flush=True)\n parent.expect('continue')\n"
            " print('done',flush=True)\nfaulthandler.cancel_dump_traceback_later()\n")
        child.stdin.write(b'start\n')
        child.stdin.flush()
        self.assertEqual(child.stdout.readline().strip(), b'numpy-ready')
        child.stdin.write(b'continue\n')
        child.stdin.flush()
        self.assertEqual(child.wait(timeout=5), 0)
        self.assertEqual(child.stdout.read().strip(), b'done')
        self.assertEqual(child.stderr.read(), b'')

    def test_fragmented_crlf_command_does_not_block_reader(self):
        child = self.launch("with ParentPipe() as parent:\n parent.expect('start')\n print('started',flush=True)\n time.sleep(60)\n")
        child.stdin.write(b'start\r')
        child.stdin.flush()
        time.sleep(0.05)
        child.stdin.write(b'\n')
        child.stdin.flush()
        self.assertEqual(child.stdout.readline().strip(), b'started')
        child.stdin.close()
        self.assertNotEqual(child.wait(timeout=5), 0)

    def test_eof_terminates_the_owned_decoder_before_python_exits(self):
        with tempfile.TemporaryDirectory(prefix='yuqu-parent-pipe-test-') as directory:
            pid_file = Path(directory) / 'decoder.pid'
            decoder = f'import os,time\nfrom pathlib import Path\nPath({str(pid_file)!r}).write_text(str(os.getpid()))\ntime.sleep(60)'
            command = [sys.executable, '-u', '-c', decoder]
            child = self.launch(f"with ParentPipe() as parent:\n parent.expect('start')\n parent.run_decoder({command!r},timeout=60)\n")
            child.stdin.write(b'start\n')
            child.stdin.flush()
            wait_until(lambda: pid_file.exists() and pid_file.stat().st_size > 0)
            decoder_process = ObservedProcess(int(pid_file.read_text()))
            try:
                child.stdin.close()
                self.assertNotEqual(child.wait(timeout=5), 0)
                decoder_process.wait()
            finally:
                decoder_process.close()


if __name__ == '__main__':
    unittest.main()
