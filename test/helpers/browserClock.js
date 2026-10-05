// Small deterministic timeout clock for browser controllers; advance, then flush promise continuations.
export class BrowserClock {
  time = 0;
  next = 1;
  jobs = new Map();
  now = () => this.time;
  setTimeout = (fn, ms) => {
    const id = this.next++;
    this.jobs.set(id, { fn, at: this.time + Math.max(0, Number(ms) || 0) });
    return id;
  };
  clearTimeout = (id) => { this.jobs.delete(id); };
  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, job] = next;
      this.time = job.at;
      this.jobs.delete(id);
      job.fn();
    }
    this.time = end;
  }
}
export const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
