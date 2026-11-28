import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { restoreAppState, STATE_FORMAT, type StateTarget } from '../../src/state/index.ts';
import { replaceKeys } from '../../src/state/android.ts';
import { keychainItems } from '../../src/state/ios.ts';
import { unpackFiles } from '../../src/state/host.ts';
import { insertRow, Rows, SecureStore } from '../../src/state/rows.ts';

const target: StateTarget = { platform: 'ios', deviceId: '00000000-0000-0000-0000-000000000000', app: 'com.example.app' };
const signal = new AbortController().signal;
const state = (data: unknown, version = 1, format = STATE_FORMAT) => ({ format, version, data });
const files = gzipSync(Buffer.alloc(1024)).toString('base64');


// Each refusal comes before any device command: the target's simulator does not exist.
describe('restoreAppState', () => {
  it('refuses another format or version', async () => {
    await expect(restoreAppState(target, state({}, 1, 'web-storage-state'), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(restoreAppState(target, state({}, 2), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses a state saved for another app or platform', async () => {
    await expect(restoreAppState(target, state({ platform: 'ios', app: 'com.example.other', files }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(restoreAppState(target, state({ platform: 'android', app: target.app, files }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses a keychain value that is not a SQL literal, or a column that is not an identifier', async () => {
    const withRow = (table: string, row: Record<string, string>) =>
      state({ platform: 'ios', app: target.app, files, keychain: { metadatakeys: [], genp: [], inet: [], cert: [], keys: [], [table]: [row] } });
    // The NUL: the sqlite3 shell cuts a line there, so the closing quote would go and the next value would run as statements.
    for (const literal of ["'a'); drop table genp; --", "x' or '1'='1", 'randomblob(9)', "'unterminated", "'a\0'"]) {
      await expect(restoreAppState(target, withRow('genp', { acct: literal }), signal), literal).rejects.toMatchObject({ code: 'INVALID_STATE' });
    }
    await expect(restoreAppState(target, withRow('genp', { 'acct) values (1); --': 'NULL' }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses a state without the platform\'s own shape', async () => {
    await expect(restoreAppState(target, state({ platform: 'ios', app: target.app, files }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(restoreAppState({ ...target, platform: 'android' }, state({ platform: 'android', app: target.app, files: 7 }), signal)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses app data that is not gzip, or that inflates past the cap', async () => {
    await expect(unpackFiles(Buffer.from('not gzip').toString('base64'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(unpackFiles(gzipSync(Buffer.alloc(257 * 1024 * 1024)).toString('base64'))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await unpackFiles(files)).toEqual(Buffer.alloc(1024));
  });

  it('refuses an app named by anything but a bundle id or package', async () => {
    await expect(restoreAppState({ ...target, app: 'My App; rm -rf /' }, state({}), signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});

describe('secure store rows', () => {
  const accepts = (literal: string) => Rows.safeParse([{ column: literal }]).success;

  it('takes every form quote() prints', () => {
    for (const literal of ["''", "'it''s'", "''''", "'two\nlines; .shell id'", "X''", "X'00ff'", 'NULL', '0', '-9223372036854775808', '1.0e+100', '-1.5e-05', '9.0e+999', `'${'A'.repeat(9_000_000)}'`]) {
      expect(accepts(literal), literal.slice(0, 40)).toBe(true);
    }
  });

  it('takes nothing else', () => {
    for (const literal of ["'", "'''", "'a''", "'a'b'", "'a\0'", "X'0'", "X'zz'", 'Inf', '0x10', '1;', '1 ', 'randomblob(9)', '(select 1)', '']) {
      expect(accepts(literal), literal).toBe(false);
    }
    expect(Rows.safeParse([{ 'acct) values (1); --': 'NULL' }]).success).toBe(false);
  });

  const schema = new Map([['genp', ['acct', 'data', 'cdat', 'n']]]);
  const storeAnswering = (answer: (sql: string) => string) => {
    const statements: string[] = [];
    const store = new SecureStore('keychain', (_step, sql) => {
      statements.push(sql);
      return Promise.resolve(Buffer.from(answer(sql)));
    }, ['rowid']);
    return { store, statements };
  };

  it('reads every column but the ones the store assigns, as the literal quote() gives it', async () => {
    const { store, statements } = storeAnswering((sql) =>
      sql.startsWith('pragma') ? '0|rowid|INTEGER|0||1\n1|acct|BLOB|0||0\n2|data|BLOB|0||0\n' : `[{"acct":"'it''s'","data":"X'00ff'"}]`,
    );
    expect(await store.rows('genp', '1')).toEqual([{ acct: "'it''s'", data: "X'00ff'" }]);
    expect(statements.at(-1)).toBe("select coalesce(json_group_array(json_object('acct', quote(acct), 'data', quote(data))), '[]') from genp where 1;");
    expect(await store.schema(['genp'])).toEqual(new Map([['genp', ['acct', 'data']]]));
  });

  it('fails on output that is not rows, without quoting it', async () => {
    const { store } = storeAnswering((sql) => (sql.startsWith('pragma') ? '0|acct|BLOB|0||0\n' : 'Error: secret'));
    await expect(store.rows('genp', '1')).rejects.toThrow(/^reading the keychain: the device returned rows this engine cannot read$/);
  });

  it('writes its statements as one transaction', async () => {
    const { store, statements } = storeAnswering(() => '');
    await store.write(['delete from genp where 1;', insertRow('genp', { acct: "'it''s'", data: "X'00ff'", cdat: 'NULL', n: '-1.5e+3' }, schema)]);
    expect(statements).toEqual(["begin immediate;\ndelete from genp where 1;\ninsert into genp (acct, data, cdat, n) values ('it''s', X'00ff', NULL, -1.5e+3);\ncommit;"]);
  });

  it('refuses a row with a column the device does not have: another OS version wrote it', () => {
    expect(() => insertRow('genp', { acct: 'NULL', newer: 'NULL' }, schema)).toThrow(/no newer column/);
  });
});

describe('keychain items', () => {
  const key = { keyclass: '6', actualKeyclass: '6', data: "X'aa'" };
  const item = { agrp: "'TEAM.com.example.app'", acct: "'ada'" };
  const saved = { metadatakeys: [key], genp: [item], inet: [], cert: [], keys: [] };
  const OWNED = "instr(agrp, '.') > 1 and substr(agrp, instr(agrp, '.') + 1) = 'com.example.app'";
  /** A simulator's keychain that holds `deviceKeys` and has the columns the rows above use. */
  const keychainHolding = (deviceKeys: object[]) =>
    new SecureStore('keychain', (_step, sql) => {
      if (sql.startsWith('pragma')) return Promise.resolve(Buffer.from(sql.includes('metadatakeys') ? '0|keyclass|\n1|actualKeyclass|\n2|data|\n' : '0|agrp|\n1|acct|\n'));
      return Promise.resolve(Buffer.from(JSON.stringify(deviceKeys)));
    });

  it("swaps the app's items alone on a simulator that holds the snapshot's keys", async () => {
    const plan = await keychainItems(target, keychainHolding([key]), saved);
    expect(plan.foreign).toBe(false);
    expect(plan.statements).toEqual([
      `delete from genp where ${OWNED};`,
      "insert into genp (agrp, acct) values ('TEAM.com.example.app', 'ada');",
      `delete from inet where ${OWNED};`,
      `delete from cert where ${OWNED};`,
      `delete from keys where ${OWNED};`,
    ]);
  });

  it('brings its keys to a simulator that holds others, and every item written under those goes', async () => {
    const plan = await keychainItems(target, keychainHolding([{ ...key, data: "X'bb'" }]), saved);
    expect(plan.foreign).toBe(true);
    expect(plan.statements.slice(0, 3)).toEqual([
      'delete from metadatakeys;',
      "insert into metadatakeys (keyclass, actualKeyclass, data) values (6, 6, X'aa');",
      'delete from genp where 1;',
    ]);
  });

  it("refuses an item in another app's access group", async () => {
    for (const agrp of ["'TEAM.com.example.other'", "'com.example.app'", "'.com.example.app'", "'TEAM.x.com.example.app'", 'NULL']) {
      await expect(keychainItems(target, keychainHolding([key]), { ...saved, genp: [{ ...item, agrp }] }), agrp).rejects.toMatchObject({ code: 'INVALID_STATE' });
    }
  });
});

describe('keystore keys', () => {
  const schema = new Map([
    ['keyentry', ['id', 'domain', 'namespace', 'alias']],
    ['blobentry', ['id', 'keyentryid', 'blob']],
    ['blobmetadata', ['id', 'blobentryid', 'tag']],
    ['keyparameter', ['keyentryid', 'tag']],
    ['keymetadata', ['keyentryid', 'tag']],
  ]);
  const saved = {
    keyentry: [{ id: '7', domain: '0', namespace: '10111', alias: "'k'" }],
    blobentry: [{ id: '3', keyentryid: '7', blob: "X'01'" }],
    blobmetadata: [{ id: '9', blobentryid: '3', tag: '1' }],
    keyparameter: [{ keyentryid: '7', tag: '2' }],
    keymetadata: [{ keyentryid: '7', tag: '3' }],
  };

  it("puts the saved keys under this device's uid, with blob ids the device assigns", () => {
    const statements = replaceKeys(saved, '10222', schema);
    expect(statements.slice(5)).toEqual([
      'delete from keyentry where domain = 0 and namespace = 10222;',
      "insert into keyentry (id, domain, namespace, alias) values (7, 0, 10222, 'k');",
      "insert into blobentry (keyentryid, blob) values (7, X'01');",
      'insert into blobmetadata (blobentryid, tag) values ((select max(id) from blobentry), 1);',
      'insert into keyparameter (keyentryid, tag) values (7, 2);',
      'insert into keymetadata (keyentryid, tag) values (7, 3);',
    ]);
  });

  it("keeps a snapshot out of another domain and off another app's keys", () => {
    expect(replaceKeys({ ...saved, keyentry: [{ ...saved.keyentry[0]!, domain: '2' }] }, '10222', schema)[6]).toContain('values (7, 0, 10222,');
    for (const stray of [{ keyparameter: [{ keyentryid: '8', tag: '2' }] }, { blobentry: [{ id: '3', keyentryid: '8', blob: "X'01'" }] }, { blobmetadata: [{ id: '9', blobentryid: '4', tag: '1' }] }]) {
      expect(() => replaceKeys({ ...saved, ...stray }, '10222', schema)).toThrow(/belong to no key/);
    }
  });
});
