/**
 * NexTool v1.1.0 §4/§13 — real behavior tests for the file-editing tools.
 * Run: bun scripts/test-fs-edit-tools.ts
 */
import { fsApplyEdits, fsAppendText, fsFindReplace, fsInsertText } from '../src/lib/nexool/tools/fs-edit-tools';
import { openGlobalVfs } from '../src/lib/nexool/tools/vfs';
import { ToolFailure } from '../src/lib/nexool/tools/handler';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}
async function expectFailure(name: string, code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    fail++;
    console.error(`  ✗ ${name} — expected ToolFailure ${code}, got success`);
  } catch (err) {
    if (err instanceof ToolFailure && err.code === code) {
      pass++;
      console.log(`  ✓ ${name} (${code})`);
    } else {
      fail++;
      console.error(`  ✗ ${name} — expected ${code}, got`, err instanceof Error ? `${err.name}:${(err as { code?: string }).code} ${err.message}` : err);
    }
  }
}

const T = '/edit-test/multiline.txt';

async function main(): Promise<void> {
  const vfs = openGlobalVfs();
  try { vfs.rm('/edit-test', { recursive: true, force: true }); } catch { /* fresh */ }
  vfs.mkdir('/edit-test', { recursive: true });

  // ---------- fs.writefile baseline via VFS ----------
  vfs.writeFile(T, 'alpha\nbeta\ngamma\ndelta\n');
  console.log('\n— fs.apply_edits —');
  let r = (await fsApplyEdits({
    path: T,
    edits: [
      { op: 'replace_range', startLine: 2, endLine: 2, text: 'BETA-2' },
      { op: 'insert_at', line: 1, column: 0, text: '#\n' },
      { op: 'remove_range', startLine: 4, endLine: 4 },
    ],
  }, { executionId: 't1' })) as Record<string, unknown>;
  ok('multi-edit applied', r.changed === true && r.editCount === 3);
  // line 2 replaced in place; line 1 got a "#\n" prefix; line 4's CONTENT was
  // removed (remove_range without endColumn stops at end-of-line content, the
  // newline itself stays) — the trailing empty line of the original remains.
  ok('result content exact', vfs.readFile(T, 'utf8') === '#\nalpha\nBETA-2\ngamma\n\n', JSON.stringify(vfs.readFile(T, 'utf8')));
  ok('structured result fields', typeof r.beforeSize === 'number' && typeof r.afterSize === 'number' && Array.isArray(r.applied));

  // Unicode + newline preservation
  vfs.writeFile('/edit-test/uni.txt', 'héllo 🌍\nπ ≈ 3.14\n');
  r = (await fsApplyEdits({ path: '/edit-test/uni.txt', edits: [{ op: 'replace_range', startLine: 1, endLine: 1, text: 'héllo 🚀' }] }, { executionId: 't2' })) as Record<string, unknown>;
  ok('unicode preserved', vfs.readFile('/edit-test/uni.txt', 'utf8') === 'héllo 🚀\nπ ≈ 3.14\n');

  // empty file edit (insert at line 1)
  vfs.writeFile('/edit-test/empty.txt', '');
  r = (await fsApplyEdits({ path: '/edit-test/empty.txt', edits: [{ op: 'insert_at', line: 1, column: 0, text: 'first line\n' }] }, { executionId: 't3' })) as Record<string, unknown>;
  ok('empty-file insert', vfs.readFile('/edit-test/empty.txt', 'utf8') === 'first line\n');

  // offset unit
  vfs.writeFile('/edit-test/off.txt', 'abcdef');
  r = (await fsApplyEdits({ path: '/edit-test/off.txt', edits: [{ op: 'replace_range', unit: 'offset', offset: 2, length: 3, text: 'XY' }] }, { executionId: 't4' })) as Record<string, unknown>;
  ok('offset replace', vfs.readFile('/edit-test/off.txt', 'utf8') === 'abXYf');

  await expectFailure('overlap rejected', 'FS_EDITS_OVERLAP', () =>
    fsApplyEdits({ path: T, edits: [
      { op: 'replace_range', startLine: 1, endLine: 2, text: 'x' },
      { op: 'replace_range', startLine: 2, endLine: 3, text: 'y' },
    ] }, { executionId: 't5' }));
  await expectFailure('nonexistent file', 'FS_NOT_FOUND', () =>
    fsApplyEdits({ path: '/edit-test/missing.txt', edits: [{ op: 'insert_at', line: 1, text: 'x' }] }, { executionId: 't6' }));
  await expectFailure('invalid line', 'FS_EDITS_INVALID', () =>
    fsApplyEdits({ path: T, edits: [{ op: 'replace_range', startLine: 0, endLine: 1, text: 'x' }] }, { executionId: 't7' }));
  await expectFailure('malformed edit rejected', 'FS_EDITS_INVALID', () =>
    fsApplyEdits({ path: T, edits: [{ op: 'explode', startLine: 1 }] }, { executionId: 't8' }));

  console.log('\n— fs.find_replace —');
  vfs.writeFile('/edit-test/fr.txt', 'foo bar FOO Bar foo\nsecond foo line\n');
  r = (await fsFindReplace({ path: '/edit-test/fr.txt', find: 'foo', replace: 'baz' }, { executionId: 't9' })) as Record<string, unknown>;
  ok('literal case-sensitive', r.matchCount === 3 && r.replacementCount === 3 && vfs.readFile('/edit-test/fr.txt', 'utf8') === 'baz bar FOO Bar baz\nsecond baz line\n');
  r = (await fsFindReplace({ path: '/edit-test/fr.txt', find: 'BAZ', replace: 'X', caseSensitive: false }, { executionId: 't10' })) as Record<string, unknown>;
  ok('case-insensitive literal', r.matchCount === 3);
  r = (await fsFindReplace({ path: '/edit-test/fr.txt', find: '\\bline\\b', replace: 'LINE', regex: true }, { executionId: 't11' })) as Record<string, unknown>;
  ok('regex mode', r.replacementCount === 1 && vfs.readFile('/edit-test/fr.txt', 'utf8')!.includes('second X LINE'));
  r = (await fsFindReplace({ path: '/edit-test/fr.txt', find: 'does-not-exist-xyz', replace: 'Q' }, { executionId: 't12' })) as Record<string, unknown>;
  ok('zero-match honest result', r.changed === false && r.matchCount === 0 && typeof r.message === 'string');
  vfs.writeFile('/edit-test/max.txt', 'aaaa');
  r = (await fsFindReplace({ path: '/edit-test/max.txt', find: 'a', replace: 'b', maxReplacements: 2 }, { executionId: 't13' })) as Record<string, unknown>;
  ok('maxReplacements cap', r.matchCount === 4 && r.replacementCount === 2 && vfs.readFile('/edit-test/max.txt', 'utf8') === 'bbaa');
  // region-limited replace
  vfs.writeFile('/edit-test/region.txt', 'one two\nthree two\nfour two\n');
  r = (await fsFindReplace({ path: '/edit-test/region.txt', find: 'two', replace: 'TWO', region: { startLine: 2, endLine: 2 } }, { executionId: 't14' })) as Record<string, unknown>;
  ok('region replace', vfs.readFile('/edit-test/region.txt', 'utf8') === 'one two\nthree TWO\nfour two\n');
  await expectFailure('invalid regex rejected', 'REGEX_INVALID', () =>
    fsFindReplace({ path: '/edit-test/fr.txt', find: '([unclosed', replace: 'x', regex: true }, { executionId: 't15' }));
  await expectFailure('zero-match file untouched does not throw but path missing errors', 'FS_NOT_FOUND', () =>
    fsFindReplace({ path: '/edit-test/nope.txt', find: 'x', replace: 'y' }, { executionId: 't16' }));

  console.log('\n— fs.insert_text —');
  vfs.writeFile('/edit-test/ins.txt', 'first\nthird\n');
  r = (await fsInsertText({ path: '/edit-test/ins.txt', at: { line: 2, column: 0 }, text: 'second\n' }, { executionId: 't17' })) as Record<string, unknown>;
  ok('insert at line', vfs.readFile('/edit-test/ins.txt', 'utf8') === 'first\nsecond\nthird\n');
  r = (await fsInsertText({ path: '/edit-test/ins.txt', anchor: { find: 'third', position: 'after' }, text: ' (end)' }, { executionId: 't18' })) as Record<string, unknown>;
  ok('insert after anchor', vfs.readFile('/edit-test/ins.txt', 'utf8') === 'first\nsecond\nthird (end)\n');
  r = (await fsInsertText({ path: '/edit-test/ins.txt', anchor: { find: 'second', position: 'before' }, text: '[before]' }, { executionId: 't19' })) as Record<string, unknown>;
  ok('insert before anchor', vfs.readFile('/edit-test/ins.txt', 'utf8') === 'first\n[before]second\nthird (end)\n');
  // occurrence selection
  vfs.writeFile('/edit-test/occ.txt', 'a X b X c\n');
  r = (await fsInsertText({ path: '/edit-test/occ.txt', anchor: { find: 'X', occurrence: 2, position: 'before' }, text: '!' }, { executionId: 't20' })) as Record<string, unknown>;
  ok('anchor occurrence 2', vfs.readFile('/edit-test/occ.txt', 'utf8') === 'a X b !X c\n');
  await expectFailure('invalid anchor', 'FS_ANCHOR_NOT_FOUND', () =>
    fsInsertText({ path: '/edit-test/ins.txt', anchor: { find: 'not-present-xyz' }, text: 'x' }, { executionId: 't21' }));
  await expectFailure('both at+anchor rejected', 'INVALID_PARAMS', () =>
    fsInsertText({ path: '/edit-test/ins.txt', at: { line: 1 }, anchor: { find: 'x' }, text: 'x' }, { executionId: 't22' }));
  await expectFailure('line beyond EOF', 'FS_EDITS_INVALID', () =>
    fsInsertText({ path: '/edit-test/ins.txt', at: { line: 99 }, text: 'x' }, { executionId: 't23' }));
  await expectFailure('nonexistent file insert', 'FS_NOT_FOUND', () =>
    fsInsertText({ path: '/edit-test/nope2.txt', at: { line: 1 }, text: 'x' }, { executionId: 't24' }));

  console.log('\n— fs.append_text —');
  vfs.writeFile('/edit-test/app.txt', 'line1');
  r = (await fsAppendText({ path: '/edit-test/app.txt', text: 'line2' }, { executionId: 't25' })) as Record<string, unknown>;
  ok('append with newline fixup', vfs.readFile('/edit-test/app.txt', 'utf8') === 'line1\nline2');
  r = (await fsAppendText({ path: '/edit-test/app.txt', text: 'line3', ensureNewline: false }, { executionId: 't26' })) as Record<string, unknown>;
  ok('append without newline fixup', vfs.readFile('/edit-test/app.txt', 'utf8') === 'line1\nline2line3');
  vfs.writeFile('/edit-test/app-empty.txt', '');
  r = (await fsAppendText({ path: '/edit-test/app-empty.txt', text: 'fresh' }, { executionId: 't27' })) as Record<string, unknown>;
  ok('append to empty file (no leading newline)', vfs.readFile('/edit-test/app-empty.txt', 'utf8') === 'fresh');
  r = (await fsAppendText({ path: '/edit-test/created.txt', text: 'born', createIfMissing: true }, { executionId: 't28' })) as Record<string, unknown>;
  ok('createIfMissing', r.created === true && vfs.readFile('/edit-test/created.txt', 'utf8') === 'born');
  await expectFailure('append to missing file', 'FS_NOT_FOUND', () =>
    fsAppendText({ path: '/edit-test/nope3.txt', text: 'x' }, { executionId: 't29' }));

  console.log('\n— boundary sanity —');
  await expectFailure('path traversal refused', 'FS_ACCESS', () =>
    fsApplyEdits({ path: '/../../etc/passwd', edits: [{ op: 'insert_at', line: 1, text: 'x' }] }, { executionId: 't30' }));

  // cleanup
  try { vfs.rm('/edit-test', { recursive: true, force: true }); } catch { /* keep */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
