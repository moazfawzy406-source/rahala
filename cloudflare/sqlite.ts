export class SqliteAdapter {
  open = true;
  constructor(private storage: any) {}
  exec(sql: string) { this.storage.sql.exec(sql).toArray(); }
  pragma(_sql: string) { return []; }
  close() { this.open = false; }
  prepare(sql: string) {
    const execute = (args: any[]) => this.storage.sql.exec(sql, ...args.map(v => Buffer.isBuffer(v) ? new Uint8Array(v) : v));
    const normalize = (row: any) => row && Object.fromEntries(Object.entries(row).map(([k,v])=>[k, v instanceof ArrayBuffer ? Buffer.from(v) : v]));
    return {
      all: (...args: any[]) => execute(args).toArray().map(normalize),
      get: (...args: any[]) => normalize(execute(args).toArray()[0]),
      run: (...args: any[]) => { const cursor = execute(args); cursor.toArray(); const r = this.storage.sql.exec('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').one(); return r; },
    };
  }
  transaction(fn: (...args: any[])=>any) { return (...args: any[]) => this.storage.transactionSync(()=>fn(...args)); }
}
