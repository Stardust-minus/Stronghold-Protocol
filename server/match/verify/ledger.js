// server/match/verify/ledger.js — the reputation ledger of the consensus checks (the consensus design §2.6, the owner's
// decisions of 2026-11-11), KEPT ONLY in phase 1: nothing here changes who verifies, whose result counts or any record.
//
// A record is one proven wrong result: an owner's or a verifier's result hash that differs from the server's own result
// of the same battle (a timeout, a drop or a whole browser engine that disagrees is no record — the hub only records
// clients whose replicas agreed with the server before). Records carry the account (the seat's player id), the device
// (the page's own random id, localStorage) and the time; a person's count is the records of the last 7 days that name
// their account OR their device — a new session on the same device, or the same session on another device, keeps the
// count. The rules the count would drive (phase 2 and later):
//   1–2  the server's result replaces the wrong one, nothing else (two chances: a stale cached page, a browser bug)
//   3+   their results are no longer accepted (the server runs their fields) and they verify no one else
//   4+   their teammates may vote them out of the match; their match does not count for them, and with them staying
//        it counts for nobody; their own fields are no longer checked in that match
// `note()` answers the level so the hub can log what WOULD happen, and flags the match (`shadowFlags`).

export const LEDGER_WINDOW_MS = 7 * 24 * 3600_000;
/** Records kept at most (the oldest go first): a long-lived process with many bad pages stays bounded. */
export const LEDGER_MAX_RECORDS = 20_000;

/** The level a count of records means (above). */
export const ledgerLevel = (n) => (n >= 4 ? 4 : n >= 3 ? 3 : n);

export class ReputationLedger {
  constructor({ windowMs = LEDGER_WINDOW_MS, maxRecords = LEDGER_MAX_RECORDS, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.maxRecords = maxRecords;
    this.now = now;
    /** @type {{ at: number, account: string | null, device: string | null, role: string, kind: string, eng: string }[]} oldest first */
    this.records = [];
  }

  _prune(t = this.now()) {
    let i = 0;
    while (i < this.records.length && t - this.records[i].at > this.windowMs) i++; // loop-cap: bounded by the records
    if (i) this.records.splice(0, i);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
  }

  /** Records of the window naming this account or this device. */
  count({ account = null, device = null } = {}) {
    this._prune();
    let n = 0;
    for (const r of this.records) if ((account && r.account === account) || (device && r.device === device)) n++;
    return n;
  }

  /** The level of this identity now (0–4). */
  level(identity) { return ledgerLevel(this.count(identity)); }

  /** Add one record; returns the identity's count and level after it. */
  note({ account = null, device = null, role = 'verifier', kind = 'normal', eng = 'other' } = {}) {
    const at = this.now();
    this._prune(at);
    this.records.push({ at, account, device, role, kind, eng });
    const n = this.count({ account, device });
    return { count: n, level: ledgerLevel(n) };
  }

  stats() {
    this._prune();
    const levels = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const accounts = new Map();
    for (const r of this.records) if (r.account) accounts.set(r.account, (accounts.get(r.account) || 0) + 1);
    for (const n of accounts.values()) levels[ledgerLevel(n)]++;
    return { records: this.records.length, accounts: accounts.size, level1: levels[1], level2: levels[2], level3: levels[3], level4: levels[4] };
  }
}
