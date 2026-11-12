"""Interval estimates for the same-seed evaluations (review B4: rliable-style IQM / bootstrap, Wilson, McNemar)."""
import math
import numpy as np


def wilson(k, n, z=1.96):
    """95 % Wilson interval of a rate k / n."""
    if n == 0:
        return (float('nan'), float('nan'))
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def mcnemar_p(only_a, only_b):
    """Exact two-sided McNemar p on the discordant pairs."""
    n = only_a + only_b
    if n == 0:
        return 1.0
    k = min(only_a, only_b)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def iqm(x):
    """Interquartile mean: the mean of the middle 50 %."""
    x = np.sort(np.asarray(x, dtype=np.float64)); n = len(x)
    if n == 0:
        return float('nan')
    lo, hi = int(math.floor(0.25 * n)), int(math.ceil(0.75 * n))
    return float(x[lo:hi].mean()) if hi > lo else float(x.mean())


def paired_bootstrap(d, reps=2000, seed=0, stat=np.mean):
    """95 % percentile bootstrap interval of stat(d) for per-seed paired differences d."""
    d = np.asarray(d, dtype=np.float64)
    if len(d) == 0:
        return (float('nan'), float('nan'))
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(reps, len(d)))
    v = np.array([stat(d[i]) for i in idx]) if stat is not np.mean else d[idx].mean(1)
    return (float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5)))
