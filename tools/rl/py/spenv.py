"""Python side of the Stronghold RL environment (plan §8): drives tools/rl/server.mjs processes over stdin/stdout."""
import json, os, selectors, struct, subprocess
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, '..', 'server.mjs')


class Batch:
    __slots__ = ('n', 'ids', 'kinds', 'rew', 'obs', 'mask', 'term_ids', 'term_rew', 'term_info', 'matches', 'errors', 'rejected', 'violations')

    @staticmethod
    def parse(p):
        h = np.frombuffer(p, dtype='<i4', count=8)
        n, t, D, A, matches, errors, rejected, violations = (int(x) for x in h[:8])
        b, o = Batch(), 32
        b.n, b.matches, b.errors, b.rejected, b.violations = n, matches, errors, rejected, violations
        b.ids = np.frombuffer(p, '<i4', n, o); o += 4 * n
        b.kinds = np.frombuffer(p, '<i4', n, o); o += 4 * n
        b.rew = np.frombuffer(p, '<f4', n, o); o += 4 * n
        b.obs = np.frombuffer(p, '<f4', n * D, o).reshape(n, D); o += 4 * n * D
        b.mask = np.frombuffer(p, np.uint8, n * A, o).reshape(n, A).astype(bool); o += (n * A + 3) & ~3
        b.term_ids = np.frombuffer(p, '<i4', t, o); o += 4 * t
        b.term_rew = np.frombuffer(p, '<f4', t, o); o += 4 * t
        # win, round, lp, config, Final Assault share, round-term total, LP-term total, bond-shaping total, seed − INIT seed
        b.term_info = np.frombuffer(p, '<f4', 9 * t, o).reshape(t, 9)
        return b


class NodeEnv:
    """One Node process with `envs` matches. step_async/wait let a caller overlap several processes."""

    def __init__(self, opts, node='node', server=SERVER):
        self.p = subprocess.Popen([node, server], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
        self._send(1, json.dumps(opts).encode())
        t, payload = self._recv()
        assert t == 1, t
        self.spec = json.loads(payload)

    def _send(self, t, payload=b''):
        self.p.stdin.write(struct.pack('<IB', len(payload) + 1, t) + payload)

    def _read(self, n):
        buf = bytearray(n)
        view, got = memoryview(buf), 0
        while got < n:
            k = self.p.stdout.readinto(view[got:])
            if not k:
                raise EOFError('environment process exited')
            got += k
        return bytes(buf)

    def _recv(self):
        (length,) = struct.unpack('<I', self._read(4))
        data = self._read(length)
        return data[0], data[1:]

    def reset_async(self):
        self._send(2)

    def step_async(self, actions):
        self._send(4, np.ascontiguousarray(actions, dtype='<i4').tobytes())

    def wait(self):
        t, payload = self._recv()
        assert t == 3, t
        return Batch.parse(payload)

    def set_configs(self, configs=None, seeds=None):
        msg = {}
        if configs is not None:
            msg['configs'] = configs
        if seeds:
            msg['seeds'] = [int(x) for x in seeds]  # S3: seeds of the next matches (level replay)
        self._send(6, json.dumps(msg).encode())
        assert self._recv()[0] == 7

    def stats(self):
        self._send(8)
        t, payload = self._recv()
        return json.loads(payload)

    def describe(self):
        """Readable states of the last batch's describeSeats rows (env.describe()), aligned with the batch rows."""
        self._send(12)
        t, payload = self._recv()
        assert t == 13, t
        return json.loads(payload)

    def close(self):
        try:
            self._send(5)
        except BrokenPipeError:
            pass
        self.p.wait(timeout=10)


def masked_random(mask, rng):
    """One uniformly random legal action per row."""
    scores = rng.random(mask.shape)
    scores[~mask] = -1.0
    return scores.argmax(axis=1).astype(np.int32)


class AsyncPool:
    """Several NodeEnv processes, each stepped as soon as its batch is in (no lockstep: one process simulating a whole
    battle does not hold the others). poll() yields (index, batch) for every process whose batch has arrived."""

    def __init__(self, envs):
        self.envs = envs
        self.sel = selectors.DefaultSelector()
        for i, e in enumerate(envs):
            self.sel.register(e.p.stdout, selectors.EVENT_READ, i)

    def reset(self):
        for e in self.envs:
            e.reset_async()

    def poll(self, timeout=None):
        for key, _ in self.sel.select(timeout):
            i = key.data
            yield i, self.envs[i].wait()

    def step(self, i, actions):
        self.envs[i].step_async(actions)

    def close(self):
        for e in self.envs:
            e.close()
