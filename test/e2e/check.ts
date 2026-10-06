export interface Tally {
  failed: number;
  check: (name: string, ok: boolean, detail?: string) => void;
}

export function tally(): Tally {
  const t: Tally = {
    failed: 0,
    check(name, ok, detail = '') {
      if (!ok) t.failed++;
      console.log(ok ? 'PASS' : 'FAIL', name, detail);
    },
  };
  return t;
}
