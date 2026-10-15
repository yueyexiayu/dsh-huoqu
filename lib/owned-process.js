import { execFile } from 'node:child_process';
// Capture-local numeric identities only: no command-name matching or global owner registry.
async function snapshot() {
  return new Promise((resolve, reject) => execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
    if (error) return reject(error);
    try {
      const rows = stdout.trim().split('\n').filter(Boolean).map(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) throw new Error('Invalid owned Chrome process snapshot');
        return { pid: +match[1], ppid: +match[2], pgid: +match[3], birth: match[4] };
      });
      resolve(new Map(rows.map(row => [row.pid, row])));
    } catch (failure) { reject(failure); }
  }));
}
export async function observeOwnedChrome(record) {
  if (!record.pid || !record.groupId) return new Map();
  const rows = await snapshot(), root = rows.get(record.pid);
  if (root && (root.pgid !== record.groupId || (record.birth && root.birth !== record.birth) || (!record.birth && root.ppid !== record.parentPid))) throw new Error('Owned Chrome process identity changed');
  if (root) record.birth ||= root.birth;
  record.processes ||= new Map();
  const owned = new Set([...(root ? [root.pid] : []), ...[...record.processes.values()].filter(item => rows.get(item.pid)?.birth === item.birth).map(item => item.pid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows.values()) if (!owned.has(row.pid) && (row.pgid === record.groupId || owned.has(row.ppid))) { owned.add(row.pid); changed = true; }
  }
  for (const pid of owned) if (pid !== record.pid) record.processes.set(pid, rows.get(pid));
  return rows;
}
export async function settleKnownChromeEscapes(record) {
  if (!record.pid || !record.groupId) return;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    let rows = await observeOwnedChrome(record);
    const escaped = [...record.processes.values()].filter(item => rows.get(item.pid)?.birth === item.birth && rows.get(item.pid).pgid !== record.groupId);
    for (const item of escaped) {
      rows = await observeOwnedChrome(record);
      if (rows.get(item.pid)?.birth !== item.birth) continue;
      try { process.kill(item.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    for (let turn = 0; turn < 20; turn++) {
      rows = await observeOwnedChrome(record);
      if (![...record.processes.values()].some(item => rows.get(item.pid)?.birth === item.birth && rows.get(item.pid).pgid !== record.groupId)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw Object.assign(new Error(`Known owned Chrome descendants did not settle; retain ${record.profile}`), { code: 'BROWSER_CLEANUP_TIMEOUT', profile: record.profile });
}
