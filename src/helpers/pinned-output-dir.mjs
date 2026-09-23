/**
 * pinned-output-dir — write files into a directory that cannot be swapped from
 * under the writer, and never through a link sitting at the destination name.
 *
 * ── The defect class this closes ─────────────────────────────────────────
 *
 * The two asset writers (`pptx_extract_assets`, `download_page_assets`) are
 * gated on WHERE their output directory is — which vault contains it, what
 * that vault's write tier is. The gate judged a PATH, and the writes then went
 * through that path again. Between the two, a local process able to rename
 * entries in the output tree could put a link where the directory (or one of
 * its ancestors) was, and the write landed wherever the link pointed: a vault
 * declared read-only, or anywhere else (Codex review of pptx_extract_assets,
 * rounds 1 and 3 — four P1 findings, one class).
 *
 * A second, non-racy member of the class was MEASURED while fixing it
 * (Windows 11, NTFS, Node 24.13.0): an exclusive create (`wx`) FOLLOWS a
 * dangling symlink or junction planted at the destination name and creates
 * the link's target. So "create exclusively" was not "create here".
 *
 * ── What this module does instead ────────────────────────────────────────
 *
 * 1. PIN the directory, prove WHERE the pinned object is, authorise THAT
 *    path, and only then create or write anything:
 *      - win32 — the probe. In the directory, a fresh `.router-pin-<hex>`
 *        directory P is created and held with share mode 0 and
 *        delete-on-close (libuv's UV_FS_O_EXLOCK 0x10000000 and
 *        UV_FS_O_TEMPORARY 0x40, which Node does not export). Measured
 *        (Windows 11, NTFS): while P is held, no other process can rename or
 *        delete it, nor rename the directory or any ancestor; the directory
 *        itself stays listable (Obsidian), and P vanishes on close. Then
 *        Windows is asked, FROM THE HANDLE, where P is (see
 *        `loadWindowsNativeHelper`): it must be `<dir>\P`, on an NTFS volume
 *        (the only filesystem these guarantees were measured on; any other is
 *        refused). The handle's own answer
 *        cannot be counterfeited; every path-based answer could — a first
 *        version asked "same object?" then "same path?" as two lookups (a
 *        swap and a swap back between them passed both), a second relied on a
 *        secret file name that a process watching the swapped tree could learn
 *        (Codex rounds P1 and P2). It needs no exclusive access to the
 *        directory itself, so a vault ROOT Obsidian keeps open, the temp
 *        directory and a process's working directory can all be pinned.
 *        Missing levels are created one at a time, each under the pin of its
 *        parent, then pinned in turn. Without the native helper, nothing is
 *        written.
 *      - linux — every operation goes through `/proc/self/fd/<fd>/<name>`,
 *        the kernel's handle-relative path; the directory is authorised on the
 *        name the kernel gives its descriptor, lexically.
 *      - other platforms (macOS, the BSDs): no primitive Node exposes can pin
 *        a directory. The directory is verified once and written by path: the
 *        directory-swap race stays OPEN there, stated rather than hidden.
 * 2. PLACE every file through a temporary file with an unguessable name in
 *    the pinned directory, never by opening the destination name:
 *      - create-only: `link(tmp, name)` — measured on NTFS: EEXIST on an
 *        existing file, a live or dangling junction and a dangling file
 *        symlink, and it creates nothing where a link points;
 *      - replace: `rename(tmp, name)` — measured: replaces a symlink ITSELF,
 *        its target keeps its bytes; a directory at the name is refused.
 *    A filesystem that refuses the hard link falls back, for create-only, to
 *    an exclusive create AT the name, then checks that what was created is
 *    the regular file at that name before writing a byte. Nothing is ever
 *    overwritten; on a filesystem that has links but no hard links (ReFS), a
 *    dangling link at the name can still get an EMPTY file created where it
 *    points — detected, refused, and no bytes written there.
 *
 * WHAT THE GUARANTEE IS ABOUT: where the BYTES land — inside the directory
 * that was authorised, never written through a link, never elsewhere. Two
 * EMPTY creations can still happen outside it, both disclosed above: a probe
 * directory where an active swap pointed, and — in the no-hard-link fallback
 * only — an empty file where a dangling link at the name points. On Windows
 * it also assumes a trusted filesystem stack: the gate is "the volume
 * answers NTFS", and a driver can answer NTFS without being Microsoft's
 * (Codex, round P5). It is not about
 * the integrity of files INSIDE that directory against another program that
 * can write there: such a program can replace a temporary of ours before it
 * is placed (then our cleanup removes its file, at our random name), or write
 * any file under any name there directly — nothing it did not already have
 * (Codex, round P4, argued rather than fixed: closing it needs handle-level
 * link/rename, which Node does not offer).
 *
 * What pinning does NOT stop: the pinned directory itself being MOVED on
 * linux (the writes follow it). Moving it into a protected tree needs write
 * access to that tree, which is the access the attack was trying to borrow —
 * so it is not an escalation. On Windows, an attack that swaps an ancestor
 * during the probe can leave an EMPTY `.router-pin-<hex>` directory where the
 * swap pointed (the probe is then refused, and nothing else is created). A
 * crash can leave `.router-tmp-*` dot-files behind; Obsidian does not index
 * dot-files.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { realPathWithMissingTail } from './real-path.mjs';
import { stripExtendedPathPrefix } from './vault-path-identity.mjs';

/** libuv's UV_FS_O_EXLOCK on Windows (share mode 0). Node does not export it. */
const WIN_EXCLUSIVE_OPEN = 0x10000000;
/** libuv's UV_FS_O_TEMPORARY on Windows (FILE_FLAG_DELETE_ON_CLOSE). Not exported either. */
const WIN_DELETE_ON_CLOSE = 0x0040;

/**
 * Waits between attempts at an exclusive open of the probe, in milliseconds
 * (about 0.8 s in all): the probe is brand new, but an antivirus or an
 * indexer may open a new directory for an instant.
 */
const EXCLUSIVE_RETRY_DELAYS_MS = Object.freeze([0, 25, 50, 100, 200, 400]);

/** Error codes from `link` after which create-only falls back to an exclusive create. */
const NO_HARD_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

const TMP_PREFIX = '.router-tmp-';
const PIN_PREFIX = '.router-pin-';

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The strategy this platform supports. */
export function defaultPinStrategy() {
  if (process.platform === 'win32') return 'win-probe';
  if (process.platform === 'linux') {
    try {
      if (fs.statSync('/proc/self/fd').isDirectory()) return 'proc-fd';
    } catch { /* no /proc: fall through */ }
  }
  return 'unpinned';
}

// EXACT, on every platform. Both sides come from the same Windows canonical
// spelling (realpath.native and the handle's final path both go through
// GetFinalPathNameByHandleW), so an honest pin matches exactly; a case-folded
// comparison accepted `OUT` for `out` in an NTFS directory with case
// sensitivity enabled, where they are two different directories (Codex,
// round P3).
const samePath = (a, b) => a === b;
const sameObject = (x, y) => x.dev === y.dev && x.ino === y.ino;
const closeQuietly = (fd) => { try { fs.closeSync(fd); } catch { /* already failing */ } };

/**
 * A single path component this module may create. Names are constructed by
 * the callers, never taken from an archive or a page; this refuses anything
 * that is not one plain component anyway — a separator, `.`/`..`, a NUL, or
 * on Windows a `:` (an alternate data stream: `a.png:x` writes INSIDE a.png).
 */
export function assertChildName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..'
    || name.length > 255 || /[/\\\0]/.test(name) || (process.platform === 'win32' && name.includes(':'))) {
    throw new Error(`output name refused (not one plain path component): ${JSON.stringify(String(name)).slice(0, 80)}`);
  }
  return name;
}

function openExclusive(p, flags) {
  let lastErr;
  for (const delay of EXCLUSIVE_RETRY_DELAYS_MS) {
    sleepSync(delay);
    try {
      return fs.openSync(p, flags | WIN_EXCLUSIVE_OPEN | WIN_DELETE_ON_CLOSE);
    } catch (err) {
      lastErr = err;
      // Only a sharing violation (libuv: EBUSY) is worth waiting for.
      if (!err || err.code !== 'EBUSY') throw err;
    }
  }
  throw new Error(`output directory cannot be pinned: ${p} stayed open in another program (${lastErr?.code})`);
}

/**
 * The one question Node cannot ask on Windows: WHERE is the object this
 * descriptor holds? Answered by the operating system from the handle itself —
 * libuv's `uv_get_osfhandle`, which node.exe exports for native addons, then
 * kernel32's `GetFinalPathNameByHandleW` — through the `koffi` FFI (Roland's
 * decision, 2026-09-23). Every path-based answer could be steered: Codex
 * round P2 showed a process watching the swapped tree learning even a
 * "secret" name and planting a counterfeit where a second lookup would find
 * it. A handle's own final path cannot be counterfeited.
 *
 * The same handle also says which FILESYSTEM holds the probe
 * (`GetVolumeInformationByHandleW`): the pin's guarantees — a held handle
 * blocks renaming the directory and its ancestors, share mode 0 holds — were
 * MEASURED on NTFS only, and a single refused rename is no certificate of a
 * filesystem's semantics (Codex, round P4). So the pin requires the volume
 * to answer "NTFS": any other answer (FAT32, exFAT, ReFS and so Dev Drive, a
 * cloud-drive volume — Google Drive's answers FAT32) is refused. The answer
 * is a name, not a certificate: a third-party driver may give it (Codex,
 * round P5), which is why the guarantee assumes a trusted filesystem stack.
 *
 * Loaded on first use, on Windows only. NOT the UCRT's `_get_osfhandle`: Node
 * keeps its own descriptor table, and calling that on a Node descriptor ended
 * the process silently (measured). Unavailable = the pin refuses: no write
 * on Windows without the proof.
 *
 * Returns `{ finalPath(fd), fileSystem(fd) }`. Exported for tests only.
 */
let windowsNative = null;
export function loadWindowsNativeHelper() {
  if (windowsNative) return windowsNative;
  let koffi;
  try {
    koffi = createRequire(import.meta.url)('koffi');
  } catch (err) {
    throw new Error(`output directory cannot be pinned on Windows: the native helper (koffi) could not be loaded (${err.code ?? err.message}). Refusing to write.`);
  }
  let uvGetOsfhandle;
  let getFinalPathNameByHandleW;
  let getVolumeInformationByHandleW;
  try {
    uvGetOsfhandle = koffi.load(process.execPath).func('intptr_t uv_get_osfhandle(int fd)');
    const kernel32 = koffi.load('kernel32.dll');
    getFinalPathNameByHandleW = kernel32
      .func('__stdcall', 'GetFinalPathNameByHandleW', 'uint32_t', ['intptr_t', 'void *', 'uint32_t', 'uint32_t']);
    getVolumeInformationByHandleW = kernel32.func('__stdcall', 'GetVolumeInformationByHandleW', 'int',
      ['intptr_t', 'void *', 'uint32_t', 'void *', 'void *', 'void *', 'void *', 'uint32_t']);
  } catch (err) {
    throw new Error(`output directory cannot be pinned on Windows: this runtime (${process.execPath}) does not expose what the proof needs (${err.message}). Refusing to write.`);
  }
  const handleOf = (fd) => {
    const handle = uvGetOsfhandle(fd);
    if (!handle || handle === -1) throw new Error(`output directory refused: descriptor ${fd} has no Windows handle`);
    return handle;
  };
  const CHARS = 32768;
  const FS_NAME_CHARS = 261; // MAX_PATH + 1, the documented size
  windowsNative = {
    finalPath(fd) {
      const buf = Buffer.alloc(CHARS * 2);
      const n = getFinalPathNameByHandleW(handleOf(fd), buf, CHARS, 0);
      if (n === 0 || n >= CHARS) throw new Error('output directory refused: Windows could not say where the pinned directory is');
      return stripExtendedPathPrefix(buf.subarray(0, n * 2).toString('utf16le'));
    },
    fileSystem(fd) {
      const buf = Buffer.alloc(FS_NAME_CHARS * 2);
      if (!getVolumeInformationByHandleW(handleOf(fd), null, 0, null, null, null, buf, FS_NAME_CHARS)) {
        throw new Error('output directory refused: Windows could not say which filesystem holds the pinned directory');
      }
      const text = buf.toString('utf16le');
      const end = text.indexOf(String.fromCharCode(0));
      return end === -1 ? text : text.slice(0, end);
    },
  };
  return windowsNative;
}

/** The only filesystem the Windows pin's guarantees were measured on. */
const PINNABLE_FILESYSTEMS = new Set(['NTFS']);

/**
 * Pin `dir` (win32): see the module header. Returns a release function.
 * Throws — leaving nothing behind but, under an active swap, an empty probe
 * directory where the swap pointed — when the probe the handle holds is not
 * in `dir`, as Windows itself reports it.
 */
function probeWindows(dir, native) {
  const probeDir = path.join(dir, `${PIN_PREFIX}${hex(8)}`);
  fs.mkdirSync(probeDir);
  let dirFd;
  try {
    dirFd = openExclusive(probeDir, fs.constants.O_RDONLY);
  } catch (err) {
    // Not held: remove it by path. Only an EMPTY directory of that random
    // name can be removed, wherever the path now leads.
    try { fs.rmdirSync(probeDir); } catch { /* reported by the throw */ }
    throw err;
  }
  try {
    // Asked of the HANDLE, not of a path: where the directory we hold is.
    const held = native.finalPath(dirFd);
    if (!samePath(held, probeDir)) {
      throw new Error(`output directory refused: ${dir} does not lead to the directory it names (the probe is held at ${held})`);
    }
    // And on which filesystem: the guarantees the pin rests on were measured
    // on NTFS only (see `loadWindowsNativeHelper`).
    const fileSystem = native.fileSystem(dirFd);
    if (!PINNABLE_FILESYSTEMS.has(fileSystem)) {
      throw new Error(`output directory cannot be pinned: ${dir} is on a ${fileSystem || 'unnamed'} volume, and the pin's guarantees were established on NTFS only. Refusing to write.`);
    }
    const fd = dirFd;
    dirFd = null;
    // Closing deletes the (empty) probe: delete-on-close.
    return () => closeQuietly(fd);
  } finally {
    if (dirFd !== null) closeQuietly(dirFd);
  }
}

/**
 * Pin `dir` (creating what is missing when `createMissing`), and return an
 * object whose methods write inside it.
 *
 * @param {string} dir absolute or resolvable path
 * @param {object} [opts]
 * @param {(realDir: string) => void} [opts.authorize] the caller's gate, asked
 *   BEFORE any missing level is created. Throws to refuse. On 'win-probe' and
 *   'proc-fd' it is asked once the nearest existing ancestor is PINNED and
 *   proven to be that path, so the path it judges is the path the files will
 *   land in; the gate should judge it as given, not resolve it again (a
 *   second resolution, unpinned, could be answered through a swap — Codex,
 *   round P1). On 'unpinned' (macOS, the BSDs) nothing is pinned: the path is
 *   the one resolved at the start, and the directory-swap race is open there
 *   (see the module header).
 * @param {boolean} [opts.createMissing=true]
 * @param {'win-probe'|'proc-fd'|'unpinned'} [opts.strategy] tests only —
 *   no MCP argument reaches it.
 * @param {((fd: number) => string)|null} [opts.nativeHelper] tests only: the
 *   Windows "where is this handle" answer, or null for "unavailable".
 */
export function openPinnedOutputDir(dir, { authorize = null, createMissing = true, strategy = defaultPinStrategy(), nativeHelper = undefined } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') throw new Error('output directory must be a non-empty string');
  const expected = realPathWithMissingTail(dir);

  // The nearest existing ancestor, and the components still to create.
  const tail = [];
  let existing = expected;
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`output directory has no existing ancestor: ${expected}`);
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  if (tail.length && !createMissing) throw new Error(`output directory does not exist: ${expected}`);

  const gate = authorize ?? (() => {});
  if (strategy === 'win-probe') return pinWindows(existing, tail, expected, gate, nativeHelper);
  if (strategy === 'proc-fd') return pinProcFd(existing, tail, expected, gate);
  if (strategy === 'unpinned') return pinNothing(existing, tail, expected, gate);
  throw new Error(`unknown pin strategy: ${strategy}`);
}

function pinWindows(existing, tail, expected, authorize, nativeHelper) {
  // Before anything is created: without the proof, nothing is written.
  const native = nativeHelper === undefined ? loadWindowsNativeHelper() : nativeHelper;
  if (!native || typeof native.finalPath !== 'function' || typeof native.fileSystem !== 'function') {
    throw new Error('output directory cannot be pinned on Windows: no native helper. Refusing to write.');
  }
  const st = fs.lstatSync(existing);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`output directory refused: ${existing} is not a plain directory`);
  let release = probeWindows(existing, native);
  try {
    // `existing` is pinned and link-free, and the tail does not exist yet:
    // the path judged here is the path the files will land in.
    authorize(expected);
    let current = existing;
    for (const component of tail) {
      const next = path.join(current, component);
      // Under the pin of `current`. A link someone plants at this name is
      // not followed by mkdir (EEXIST), and the probe of `next` refuses it.
      try { fs.mkdirSync(next); } catch (err) { if (!err || err.code !== 'EEXIST') throw err; }
      const nextRelease = probeWindows(next, native);
      release();
      release = nextRelease;
      current = next;
    }
    const pinned = release;
    release = null;
    return makePinned({
      realPath: expected,
      strategy: 'win-probe',
      childPath: (name) => path.join(expected, assertChildName(name)),
      release: pinned,
    });
  } finally {
    if (release) release();
  }
}

function pinProcFd(existing, tail, expected, authorize) {
  const { O_RDONLY, O_DIRECTORY = 0, O_NOFOLLOW = 0 } = fs.constants;
  let fd = fs.openSync(existing, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const at = (name) => `/proc/self/fd/${fd}/${name}`;
    const kernelName = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (kernelName !== existing) {
      throw new Error(`output directory refused: ${existing} is ${kernelName} once opened`);
    }
    // The descriptor, not the path, is what the files will go through; the
    // name the kernel gives it is what is judged, as given.
    authorize(tail.length ? path.join(kernelName, ...tail) : kernelName);
    for (const component of tail) {
      try { fs.mkdirSync(at(component)); } catch (err) { if (!err || err.code !== 'EEXIST') throw err; }
      const next = fs.openSync(at(component), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      // Ownership moves to `next` BEFORE the previous descriptor is closed,
      // and that close is never retried: a close that fails may still have
      // released the number, which another open may then reuse (Codex, round P4).
      const previous = fd;
      fd = next;
      closeQuietly(previous);
    }
    const pinnedName = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (pinnedName !== expected) throw new Error(`output directory refused: pinned ${pinnedName}, expected ${expected}`);
    const heldFd = fd;
    fd = null;
    return makePinned({
      realPath: expected,
      strategy: 'proc-fd',
      childPath: (name) => `/proc/self/fd/${heldFd}/${assertChildName(name)}`,
      release: () => fs.closeSync(heldFd),
    });
  } finally {
    if (fd !== null) closeQuietly(fd);
  }
}

function pinNothing(existing, tail, expected, authorize) {
  authorize(expected);
  let current = existing;
  for (const component of tail) {
    current = path.join(current, component);
    try { fs.mkdirSync(current); } catch (err) { if (!err || err.code !== 'EEXIST') throw err; }
  }
  const st = fs.lstatSync(current);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`output directory refused: ${current} is not a plain directory`);
  const real = fs.realpathSync.native(current);
  if (!samePath(real, expected)) throw new Error(`output directory refused: ${current} resolves to ${real}, expected ${expected}`);
  return makePinned({
    realPath: expected,
    strategy: 'unpinned',
    childPath: (name) => path.join(expected, assertChildName(name)),
    release: () => {},
  });
}

function makePinned({ realPath, strategy, childPath, release }) {
  let closed = false;
  const live = () => { if (closed) throw new Error('output directory already released'); };
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = fs.constants;
  const dropTemp = (name) => { try { fs.unlinkSync(childPath(name)); } catch { /* gone already */ } };

  const writeAll = (fd, bytes) => {
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
  };

  /** Write `bytes` to a fresh, unguessable name; returns that name. */
  const writeTemp = (bytes) => {
    const name = `${TMP_PREFIX}${hex(16)}`;
    const fd = fs.openSync(childPath(name), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW);
    try {
      writeAll(fd, bytes);
    } catch (err) {
      closeQuietly(fd);
      dropTemp(name);
      throw err;
    }
    try {
      fs.closeSync(fd);
    } catch (err) {
      // A close that fails leaves the temporary to us too (Codex, round P1).
      dropTemp(name);
      throw err;
    }
    return name;
  };

  /**
   * The fallback when the filesystem refuses the hard link: create AT the
   * name, exclusively — never overwrites — then prove that what was created
   * is the regular file at that name before a single byte is written.
   */
  const createInPlace = (name, bytes) => {
    let fd;
    try {
      fd = fs.openSync(childPath(name), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW);
    } catch (err) {
      if (err && err.code === 'EEXIST') return 'exists';
      throw err;
    }
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      const seen = fs.lstatSync(childPath(name), { bigint: true });
      if (seen.isSymbolicLink() || !seen.isFile() || !sameObject(opened, seen)) {
        throw new Error(`output name refused: ${name} is a link, and the file just created is not at that name — nothing was written, but an EMPTY file may remain where the link points`);
      }
    } catch (err) {
      closeQuietly(fd);
      throw err;
    }
    try {
      writeAll(fd, bytes);
    } catch (err) {
      // A write that fails half-way must not leave half an image under the
      // final name, where a retry would find it "taken" (Codex, round P2).
      // Emptied through OUR descriptor — still ours here — and never unlinked
      // by name: an unlink by name could remove a file someone else put there.
      let emptied = false;
      try { fs.ftruncateSync(fd, 0); emptied = true; } catch { /* said below */ }
      closeQuietly(fd);
      err.message = `${err.message} — the write of ${name} failed; ${emptied ? 'an EMPTY' : 'a PARTIAL'} file may remain under that name`;
      throw err;
    }
    // A failed close is NOT retried, and nothing is done to the descriptor
    // after it: its number may already belong to another file (Codex, round
    // P3). The bytes were all written; the error says so.
    try {
      fs.closeSync(fd);
    } catch (err) {
      err.message = `${err.message} — ${name} was written in full, but closing it failed`;
      throw err;
    }
    return 'created';
  };

  return {
    /** The directory's real path, as authorised and pinned. */
    path: realPath,
    strategy,
    /**
     * Place `bytes` at `name` only if nothing is there — a file, a directory
     * or a link, dangling or not. Returns 'created' or 'exists'. Never
     * overwrites.
     */
    createNoReplace(name, bytes) {
      live();
      assertChildName(name);
      const tmp = writeTemp(bytes);
      let fallback = false;
      try {
        fs.linkSync(childPath(tmp), childPath(name));
        return 'created';
      } catch (err) {
        if (err && err.code === 'EEXIST') return 'exists';
        if (!err || !NO_HARD_LINK.has(err.code)) throw err;
        fallback = true;
      } finally {
        dropTemp(tmp);
      }
      return fallback ? createInPlace(name, bytes) : 'exists';
    },
    /**
     * Place `bytes` at `name`, replacing a file or a link that is there — the
     * link itself, never its target. A directory at `name` is refused.
     */
    replace(name, bytes) {
      live();
      assertChildName(name);
      const tmp = writeTemp(bytes);
      try {
        fs.renameSync(childPath(tmp), childPath(name));
      } catch (err) {
        dropTemp(tmp);
        throw err;
      }
    },
    /**
     * Does `name` hold exactly `bytes`, as a regular file? The object opened
     * must be the object `lstat` saw: a file swapped for ANOTHER file (or a
     * link to another file) between the two is not a match, on Windows too,
     * where no O_NOFOLLOW exists. A link swapped in that leads back to the
     * very same file object reads as that object — same bytes, same file.
     */
    holdsSameBytes(name, bytes) {
      live();
      const p = childPath(name);
      let seen;
      try { seen = fs.lstatSync(p, { bigint: true }); } catch { return false; }
      if (!seen.isFile() || seen.size !== BigInt(bytes.length)) return false;
      const { O_RDONLY, O_NONBLOCK = 0 } = fs.constants;
      let fd;
      try { fd = fs.openSync(p, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch { return false; }
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || !sameObject(opened, seen) || opened.size !== BigInt(bytes.length)) return false;
        const buf = Buffer.alloc(bytes.length);
        let off = 0;
        while (off < buf.length) {
          const n = fs.readSync(fd, buf, off, buf.length - off, off);
          if (n === 0) return false;
          off += n;
        }
        return buf.equals(bytes);
      } catch {
        return false;
      } finally {
        closeQuietly(fd);
      }
    },
    /** Release the pin. Idempotent. */
    close() {
      if (closed) return;
      closed = true;
      release();
    },
  };
}
