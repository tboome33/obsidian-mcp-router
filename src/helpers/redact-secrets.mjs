/**
 * redact-secrets.mjs — mask credentials in free text before the session
 * journal writes it into a vault.
 *
 * WHY THIS EXISTS
 * ---------------
 * `hooks/session-auto-journal.mjs` records each user prompt and a summary of
 * each write-flavoured tool call, including Bash commands. It used to copy
 * them verbatim, on the assumption that a vault is a local folder nobody else
 * reads. That stopped being true: vaults are now served from a server and
 * shared over the network. On 2026-10-04 a vault session note was found to
 * hold a sudo password, captured from a command of the form
 * "echo <password> | sudo -S ...".
 *
 * WHAT IT DOES
 * ------------
 * `redactSecrets(text)` runs an ordered table of rules (`REDACTION_RULES`)
 * and replaces each secret VALUE with `«redacted»`, keeping the surrounding
 * text so the journal still says what was done:
 *
 *   - a password fed to `sudo -S`: the `echo` / `printf` arguments piped into
 *     it — directly, or into `ssh` / `plink` whose remote command runs it —
 *     and a here-string;
 *   - credential flags (`--password`, `--token`, `-pw`, …), `mysql -p<value>`,
 *     `sshpass -p`, `docker login -p`, `redis-cli -a`, openssl `pass:`
 *     sources, `curl -u user:<password>`, `curl -b`, a password inside a URL,
 *     PowerShell `ConvertTo-SecureString '<value>'`;
 *   - Authorization headers (a known scheme is kept), credential-named headers
 *     (`X-Api-Key`, `Cookie`, …);
 *   - assignments and key/value pairs whose NAME is a credential name
 *     (`DB_PASSWORD=…`, `"apiKey": "…"`, `\"password\":\"…\"`, `password: …`,
 *     `?access_token=…`);
 *   - the credential FORMATS the export gate knows (`secret-shapes.mjs`),
 *     wherever they appear, and private key blocks.
 *
 * A command continued over several lines with backslashes is read as one.
 * Values that only REFER to a secret are kept: `$VAR`, `${VAR}`, `$(cmd)` that
 * prints no literal, `<placeholder>`, `***`, and text already masked.
 *
 * A value is always masked WHOLE. A rule that masked the first N characters of
 * a long value would leave its end in clear, and a token format could no
 * longer recognise what remains.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It recognises shapes and names, not intent. A password passed as a plain
 * positional argument to an arbitrary program (`tool login alice hunter`),
 * sent to `sudo -S` through a multi-line heredoc, or typed in prose without a
 * credential word next to it, is not recognised. The journal is a navigation
 * aid; the opt-out (OBSIDIAN_ROUTER_NO_SESSION_JOURNAL) remains the answer
 * for a session that handles secrets on purpose.
 *
 * A text longer than CHECK_MAX_CHARS is not read: it comes back as a notice.
 * Callers must mask BEFORE truncating: a cut can split the pattern that
 * identifies a secret (`echo '<start of password>…`) and leave the start of
 * the value in clear.
 *
 * Note for maintainers: never quote a sample credential in a comment here.
 * The export gate scans this file and would stop on it.
 */

import { SECRET_RULES } from './secret-shapes.mjs';

export const REDACTED = '«redacted»';

/**
 * The longest text the masking reads. A longer one is replaced whole by a
 * notice: reading it would cost too much on every prompt and tool call, and
 * passing it through unread would publish whatever it holds. The journal keeps
 * 100 000 characters of a prompt and 200 of a command, so a text this long is
 * a paste or a generated blob, never something a person wants to re-read there.
 */
export const CHECK_MAX_CHARS = 512 * 1024;

/**
 * Masking a token can make the text next to it recognisable: in
 * `mysql --comment <long JWT> -p<password>`, the `-p` lies too far from
 * `mysql` until the JWT is masked. The table is applied again while it
 * changes something, at most this many times.
 */
const MAX_PASSES = 3;

// ---------------------------------------------------------------------------
// Credential names
// ---------------------------------------------------------------------------

/** Words that make a name a credential name, wherever they sit in it. */
const CREDENTIAL_WORDS = new Set([
  'password', 'passwords', 'passwd', 'pass', 'pwd', 'pw', 'passphrase',
  'secret', 'secrets', 'token', 'tokens', 'credential', 'credentials',
  'cookie', 'cookies', 'auth', 'bearer', 'sig', 'signature',
  // The same ideas written as one word (ALL-CAPS or lower case, no separator).
  'apikey', 'apitoken', 'apisecret', 'accesskey', 'accesstoken', 'authtoken',
  'refreshtoken', 'privatekey', 'secretkey', 'clientsecret', 'pgpass', 'sshpass',
]);

/**
 * A word ENDING with one of these is a credential word too: `pgpassword`,
 * `mysecret`. Not `pass`: `bypass` and `compass` end with it.
 */
const CREDENTIAL_SUFFIXES = ['password', 'passwd', 'token', 'secret', 'apikey'];

/** Two-word names whose words are harmless alone (`key`, `api`, `client`). */
const CREDENTIAL_PAIRS = new Set([
  'api key', 'access key', 'private key', 'secret key', 'signing key', 'encryption key',
  'client key',
]);

/**
 * A name that ENDS with one of these points AT a secret — a file, a URL, a
 * length rule — instead of holding one: `PASSWORD_FILE`, `TOKEN_URL`.
 */
const POINTER_SUFFIXES = new Set([
  'file', 'files', 'path', 'dir', 'url', 'uri', 'endpoint', 'name', 'env', 'type',
  'length', 'len', 'ttl', 'expiry', 'expires', 'hint', 'policy',
]);

function nameWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isCredentialWord(w) {
  return CREDENTIAL_WORDS.has(w) || CREDENTIAL_SUFFIXES.some((s) => w.length > s.length && w.endsWith(s));
}

/**
 * True when `name` (a variable, key, flag or header name) names a credential.
 * Reads camelCase, snake_case, kebab-case and joined spellings.
 */
export function isCredentialName(name) {
  const words = nameWords(name);
  if (words.length === 0) return false;
  // `--no-password` switches something off; it holds nothing.
  if (words[0] === 'no') return false;
  if (words.length > 1 && POINTER_SUFFIXES.has(words[words.length - 1])) return false;
  if (words.some(isCredentialWord)) return true;
  for (let i = 0; i + 1 < words.length; i += 1) {
    if (CREDENTIAL_PAIRS.has(`${words[i]} ${words[i + 1].replace(/s$/, '')}`)) return true;
  }
  return false;
}

/**
 * True when a value only REFERS to a secret (or is already masked), so
 * masking it would hide useful information and protect nothing.
 */
function isReference(raw) {
  let v = String(raw ?? '').trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  // An already masked value stays as it is — quotes included.
  if (v === '' || v.includes(REDACTED)) return true;
  if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(v)) return true;
  // `$(cat /run/secrets/x)` refers to a secret kept elsewhere; `$(echo …)`,
  // `$(printf …)` or any quoted argument prints one given literally.
  const sub = /^\$\(([\s\S]*)\)$/.exec(v);
  if (sub) return !/['"]|\b(?:echo|printf)\b/.test(sub[1]);
  return /^<[^<>]*>$/.test(v) || /^\*+$/.test(v);
}

// ---------------------------------------------------------------------------
// Bounds — every rule that can FAIL after reading far reads a bounded stretch
// ---------------------------------------------------------------------------
//
// Measured 2026-10-04 before these bounds existed: a 100 KB text made of the
// word `echo` repeated kept the masking busy for more than 280 seconds, because
// each `echo` read to the end of its line looking for `| sudo -S`. The journal
// hook runs on every prompt and every tool call, so such a text would have
// frozen it. A bound is needed wherever a rule searches FORWARD for context
// that may not be there; `tests/redact-secrets.test.mjs` times a crafted
// 400 KB text for each such search.
//
// VALUES are not bounded: a value is the last thing a rule reads, so reading
// it cannot fail and be retried. Bounding it would mask its start only.

/** Longest `$( … )` read as one value; longest user name before `:password`. */
const WORD_MAX = 512;
/** Longest stretch between a command and the option that carries the secret. */
const REACH_MAX = 256;
/** Most arguments an `echo` / `printf` may have before the pipe. */
const ECHO_ARGS_MAX = 16;
/** Most sudo options before `-S`. */
const SUDO_OPTIONS_MAX = 8;
/** Longest run of blanks between two words a rule reads. */
const BLANKS_MAX = 8;

// ---------------------------------------------------------------------------
// Shell fragments shared by several rules
// ---------------------------------------------------------------------------

/** One blank: a space, a tab, or a backslash that continues the line. */
const BL = String.raw`(?:[ \t]|\\\r?\n)`;

/** One character of the same command: not a newline, a pipe, `;` or `&`. */
const IN_COMMAND = String.raw`(?:[^\n|;&\\]|\\\r?\n|\\[^\n])`;

/**
 * One shell word, read whole whatever its length. Not bounded: a word ends at
 * a blank or at its closing quote, and the rules that read several words
 * (`echo` arguments, sudo options) read at most a fixed number of them, so
 * each word is read by a bounded number of attempts.
 */
const SHELL_WORD = String.raw`(?:'[^'\n]*'|"(?:[^"\\\n]|\\.)*"|(?:[^\s|;&'"\\]|\\[^\n])+)`;

/**
 * One sudo option placed before `-S`: a short-option cluster with an optional
 * argument (`-u root`, `-p ''`), or a long option (`--user=root`).
 */
const SUDO_OPTION = String.raw`(?:-[A-Za-z]{1,16}(?:${BL}{1,${BLANKS_MAX}}(?!-)${SHELL_WORD})?|--[A-Za-z][A-Za-z-]{0,31}(?:=${SHELL_WORD})?)`;

/**
 * `sudo` reading its password from standard input: `-S` alone or inside a
 * cluster (`-kS`), or `--stdin`, after a few options. A `-S` that comes after
 * the command word belongs to the command (`pacman -S`), not to sudo.
 */
const SUDO_READS_STDIN = String.raw`sudo(?:${BL}{1,${BLANKS_MAX}}${SUDO_OPTION}){0,${SUDO_OPTIONS_MAX}}?${BL}{1,${BLANKS_MAX}}(?:-[A-Za-z]{0,8}S[A-Za-z]{0,8}|--stdin)(?=[\s;&|"'\\]|$)`;

// ---------------------------------------------------------------------------
// The rule table — applied in this order
// ---------------------------------------------------------------------------

/** Keep `prefix`, mask `value` unless it only refers to a secret. */
function keepOrMask(whole, prefix, value, suffix = '') {
  return isReference(value) ? whole : `${prefix}${REDACTED}${suffix}`;
}

// ---------------------------------------------------------------------------
// Private key blocks
// ---------------------------------------------------------------------------
//
// A key is masked from its BEGIN line THROUGH its END line whenever that END
// line exists — whatever lies between: doubled line endings, blank lines,
// `> ` quoting, a rewrapped body. Two review rounds found a key body written
// in clear by every rule that tried to guess where a key ends from its shape.
// Only a key whose END line is missing (cut, pasted in part) falls back to a
// guess: it stops at a code fence, or at a blank line followed by something
// that is not key material, so the markdown around it survives. And a block
// never runs through a code fence or into the next BEGIN line: an END found
// beyond either belongs to another key.

const PK_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----/g;
const PK_END = /-----END ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----/g;
const PK_FENCE = /\n[ \t]*(?:```|~~~)/g;
const PK_OPEN_END = /[\s\S]*?(?=\r?\n[ \t]*\r?\n(?![ \t]*[A-Za-z0-9+/]{40,}={0,2}[ \t]*(?:\r?\n|$))|\r?\n[ \t]*(?:```|~~~)|$)/y;

/** Index of the first element of a sorted array whose key is >= `pos`. */
function lowerBound(sorted, pos, key = (v) => v) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(sorted[mid]) < pos) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Linear: one pass to index END lines, fences and BEGIN lines, then a binary search per key. */
function maskPrivateKeys(text) {
  if (!text.includes('PRIVATE KEY')) return text;
  const ends = new Map();
  for (const m of text.matchAll(PK_END)) {
    if (!ends.has(m[1])) ends.set(m[1], []);
    ends.get(m[1]).push({ at: m.index, to: m.index + m[0].length });
  }
  const fences = [...text.matchAll(PK_FENCE)].map((m) => m.index);
  const begins = [...text.matchAll(PK_BEGIN)];
  let out = '';
  let last = 0;
  for (let i = 0; i < begins.length; i += 1) {
    const m = begins[i];
    if (m.index < last) continue; // inside a key already masked
    const from = m.index + m[0].length;
    const list = ends.get(m[1]) || [];
    const end = list[lowerBound(list, from, (e) => e.at)];
    const nextFence = fences[lowerBound(fences, from)];
    const nextBegin = begins[i + 1]?.index;
    let stop;
    if (end && (nextFence === undefined || nextFence > end.at) && (nextBegin === undefined || nextBegin > end.at)) {
      stop = end.to;
    } else {
      PK_OPEN_END.lastIndex = from;
      const open = PK_OPEN_END.exec(text);
      stop = from + (open ? open[0].length : 0);
    }
    out += text.slice(last, m.index) + REDACTED;
    last = stop;
  }
  return out + text.slice(last);
}

const STRUCTURED_RULES = [
  { id: 'private-key-block', apply: maskPrivateKeys },
  {
    // echo / printf whose output reaches `sudo -S`: every argument is the
    // password (or the format that prints it). The pipe may go straight into
    // sudo, or into a command (`ssh host`, `plink …`) whose own command line
    // runs `sudo -S` — but not past a `;`, `&` or another pipe.
    id: 'sudo-stdin-echo',
    re: new RegExp(String.raw`\b(echo|printf)((?:${BL}{1,${BLANKS_MAX}}${SHELL_WORD}){1,${ECHO_ARGS_MAX}}?)(?=${BL}{0,${BLANKS_MAX}}\|${IN_COMMAND}{0,${REACH_MAX}}?\b${SUDO_READS_STDIN})`, 'g'),
    replace: (_m, cmd) => `${cmd} ${REDACTED}`,
  },
  {
    id: 'sudo-stdin-here-string',
    re: new RegExp(String.raw`(\b${SUDO_READS_STDIN}${IN_COMMAND}{0,${REACH_MAX}}?<<<${BL}{0,${BLANKS_MAX}})(${SHELL_WORD})`, 'g'),
    replace: (_m, pre) => `${pre}${REDACTED}`,
  },
  {
    // scheme://user:<password>@host — the user and the host stay readable.
    id: 'url-userinfo',
    re: new RegExp(String.raw`\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@'"]{1,${REACH_MAX}}:)([^\s/@'"]+)(@)`, 'gi'),
    replace: (m, pre, value, at) => keepOrMask(m, pre, value, at),
  },
  {
    // --password=<x>, --token <x>, -pw <x>: any flag whose NAME is a
    // credential name. A value starting with `-` is the next flag, not a value.
    id: 'credential-flag',
    re: new RegExp(String.raw`(^|[\s"'])(--?([A-Za-z][A-Za-z0-9-]{0,63}))(=|${BL}{1,${BLANKS_MAX}})(?!-)(${SHELL_WORD})`, 'g'),
    replace: (m, lead, flag, name, sep, value) => (isCredentialName(name) ? keepOrMask(m, `${lead}${flag}${sep}`, value) : m),
  },
  {
    // openssl password sources: `-pass pass:<x>`, `-passin pass:<x>`.
    id: 'openssl-pass-source',
    re: new RegExp(String.raw`(\bpass:)(${SHELL_WORD})`, 'g'),
    replace: (m, pre, value) => keepOrMask(m, pre, value),
  },
  {
    // mysql-family clients take the password glued to -p (`-p<x>`); `-p`
    // followed by a space only asks for a prompt and is left alone.
    id: 'mysql-glued-password',
    re: new RegExp(String.raw`(\b(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mariadb|mariadb-dump|mariadb-admin)\b${IN_COMMAND}{0,${REACH_MAX}}?${BL}-p)(${SHELL_WORD})`, 'g'),
    replace: (m, pre, value) => keepOrMask(m, pre, value),
  },
  {
    id: 'sshpass-password',
    re: new RegExp(String.raw`(\bsshpass\b${IN_COMMAND}{0,${REACH_MAX}}?${BL}-p${BL}{0,${BLANKS_MAX}})(${SHELL_WORD})`, 'g'),
    replace: (m, pre, value) => keepOrMask(m, pre, value),
  },
  {
    // Registry and database clients whose `-p` is the password.
    id: 'client-p-password',
    re: new RegExp(String.raw`(\b(?:(?:docker|podman|nerdctl|buildah|skopeo)${BL}{1,${BLANKS_MAX}}login|mongo|mongosh)\b${IN_COMMAND}{0,${REACH_MAX}}?${BL}-p${BL}{1,${BLANKS_MAX}})(${SHELL_WORD})`, 'g'),
    replace: (m, pre, value) => keepOrMask(m, pre, value),
  },
  {
    // redis-cli: `-a` is the password (`-p` is the port).
    id: 'redis-cli-auth',
    re: new RegExp(String.raw`(\bredis-cli\b${IN_COMMAND}{0,${REACH_MAX}}?${BL}-a${BL}{1,${BLANKS_MAX}})(${SHELL_WORD})`, 'g'),
    replace: (m, pre, value) => keepOrMask(m, pre, value),
  },
  {
    // curl/wget `-u user:<password>`: the user stays readable.
    id: 'http-client-user-password',
    re: new RegExp(String.raw`(\b(?:curl|wget)\b${IN_COMMAND}{0,${REACH_MAX}}?${BL}(?:-u|--user)(?:=|${BL}{1,${BLANKS_MAX}})(['"]?)[^:\s'"]{1,${WORD_MAX}}:)([^\s'"]+)(\2)`, 'g'),
    replace: (m, pre, _quote, value, endQuote) => keepOrMask(m, pre, value, endQuote),
  },
  {
    // curl `-b <cookies>` (`--cookie` is a credential flag above).
    id: 'curl-cookie',
    re: new RegExp(String.raw`(\bcurl\b${IN_COMMAND}{0,${REACH_MAX}}?${BL}-b(?:=|${BL}{1,${BLANKS_MAX}}))(${SHELL_WORD})`, 'g'),
    replace: (m, pre, value) => keepOrMask(m, pre, value),
  },
  {
    // PowerShell: a SecureString built from plain text holds the secret.
    id: 'powershell-securestring',
    re: new RegExp(String.raw`(\bConvertTo-SecureString\b(?:${BL}{1,${BLANKS_MAX}}-String)?${BL}{1,${BLANKS_MAX}})(?!-)(${SHELL_WORD})`, 'gi'),
    replace: (m, pre, value) => keepOrMask(m, pre, value),
  },
  {
    // Authorization / Proxy-Authorization, any notation (header, JSON, YAML).
    // The value runs to its closing quote or the end of the line, so a scheme
    // this rule does not know (`SSWS`, `ApiKey`) is masked with its token. A
    // known scheme (Bearer, Basic…) is kept: it says what kind it was.
    id: 'authorization-value',
    re: new RegExp(String.raw`(\b(?:proxy-)?authorization["']?${BL}{0,${BLANKS_MAX}}[:=]${BL}{0,${BLANKS_MAX}}["']?${BL}{0,${BLANKS_MAX}})((?:Bearer|Basic|Token|Bot|Digest)[ \t]{1,${BLANKS_MAX}})?([^'"\n]*[^\s'"])`, 'gi'),
    replace: (m, pre, scheme = '', value) => keepOrMask(m, `${pre}${scheme}`, value),
  },
  {
    // -H 'X-Api-Key: <x>' / --header "Cookie: <x>".
    id: 'credential-header',
    re: new RegExp(String.raw`((?:-H|--header)(?:=|${BL}{0,${BLANKS_MAX}})(['"]))([A-Za-z][A-Za-z0-9-]{0,63})(${BL}{0,${BLANKS_MAX}}:${BL}{0,${BLANKS_MAX}})([^'"\n]*)(\2)`, 'g'),
    replace: (m, pre, _quote, name, colon, value, endQuote) => (
      isCredentialName(name) ? keepOrMask(m, `${pre}${name}${colon}`, value, endQuote) : m),
  },
  {
    // \"password\":\"<x>\" — JSON escaped inside a double-quoted argument, the
    // usual form on a Windows command line.
    id: 'escaped-json-value',
    re: new RegExp(String.raw`(\\")([A-Za-z_][A-Za-z0-9_.-]{0,63})\\"([ \t]{0,${BLANKS_MAX}}:[ \t]{0,${BLANKS_MAX}})\\"((?:[^"\\\n]|\\(?!")[^\n])*)\\"`, 'g'),
    replace: (m, q, name, colon, value) => (
      isCredentialName(name) ? keepOrMask(m, `${q}${name}${q}${colon}${q}`, value, q) : m),
  },
  {
    // "apiKey": "<x>" — JSON, and any quoted key with a quoted value. A quoted
    // value ends at the next quote of its kind, which is also where the next
    // attempt starts: the scans cannot overlap.
    id: 'quoted-key-value',
    re: new RegExp(String.raw`(["'])([A-Za-z_][A-Za-z0-9_.-]{0,63})\1([ \t]{0,${BLANKS_MAX}}[:=][ \t]{0,${BLANKS_MAX}})(["'])((?:(?!\4)[^\\\n]|\\.)*)\4`, 'g'),
    replace: (m, q, name, colon, vq, value) => (
      isCredentialName(name) ? keepOrMask(m, `${q}${name}${q}${colon}${vq}`, value, vq) : m),
  },
  {
    // apiKey = "<x>", TOKEN: '<x>', export API_KEY='<x>' — unquoted name,
    // quoted value, `=` or `:` with optional spaces.
    id: 'quoted-assignment',
    re: new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]{0,63})([ \t]{0,${BLANKS_MAX}}[:=][ \t]{0,${BLANKS_MAX}})(["'${'`'}])((?:(?!\3)[^\\\n]|\\.)*)\3`, 'g'),
    replace: (m, name, op, q, value) => (isCredentialName(name) ? keepOrMask(m, `${name}${op}${q}`, value, q) : m),
  },
  {
    // DB_PASSWORD=<x> in a shell, ?access_token=<x> in a URL. A command
    // substitution is read whole, so `$(cat /run/secrets/x)` stays a
    // reference and `$(echo …)` is masked whole. A new attempt needs a
    // separator, a name and `=`, so attempts never overlap a value.
    id: 'bare-assignment',
    re: new RegExp(String.raw`(^|[\s;&|(?"':])([A-Za-z_][A-Za-z0-9_]{0,63})=((?:\$\([^)\n]{0,${WORD_MAX}}\)|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s;&|)'"${'`'}]*))`, 'g'),
    replace: (m, lead, name, value) => (isCredentialName(name) ? keepOrMask(m, `${lead}${name}=`, value) : m),
  },
  {
    // `password: <x>` at the start of a line (YAML, .env-like notes, headers
    // pasted in a prompt). The rest of the line is the value: a password may
    // contain `#`, so a trailing comment is masked with it rather than risk
    // leaving the end of a password in clear. The value must START with a
    // non-blank, so a run of blanks is read once, not once per blank.
    id: 'line-key-value',
    re: /^([ \t]*(?:-[ \t]+)?)([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*:[ \t]+)(\S(?:[^\n]*\S)?)/gm,
    replace: (m, lead, name, colon, value) => (isCredentialName(name) ? keepOrMask(m, `${lead}${name}${colon}`, value) : m),
  },
];

/**
 * The credential formats the export gate knows, applied last so the rules
 * above keep their context (a scheme, a user name) when they apply.
 *
 * `private-key-block` is left out: the gate only needs the BEGIN line to stop
 * a release, but masking only that line would leave the key body in clear.
 * The `private-key-block` rule above masks the whole block instead.
 */
const SHAPE_RULES = SECRET_RULES.filter((rule) => rule.id !== 'private-key-block').map((rule) => ({
  id: `shape:${rule.id}`,
  re: rule.re,
  replace: rule.valueGroup
    ? (m, ...groups) => m.replace(groups[rule.valueGroup - 1], REDACTED)
    : () => REDACTED,
}));

export const REDACTION_RULES = Object.freeze([...STRUCTURED_RULES, ...SHAPE_RULES]);

// ---------------------------------------------------------------------------

function applyRules(text) {
  let out = text;
  for (const rule of REDACTION_RULES) {
    if (rule.apply) { out = rule.apply(out); continue; }
    // Every rule regex is global, and `String.prototype.replace` with a global
    // regex starts at index 0 and leaves `lastIndex` at 0: the shared objects
    // carry no state from one call to the next.
    out = out.replace(rule.re, (...args) => {
      // (match, ...captures, offset, input[, namedGroups])
      const named = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
      const captures = args.slice(1, named ? -3 : -2);
      return rule.replace(args[0], ...captures);
    });
  }
  return out;
}

/**
 * Mask every secret `REDACTION_RULES` recognises in `text`.
 * Returns a string; `null` / `undefined` give `''`. A text longer than
 * CHECK_MAX_CHARS comes back as a notice. Idempotent.
 */
export function redactSecrets(text) {
  if (text == null) return '';
  let out = String(text);
  if (out.length > CHECK_MAX_CHARS) return `«redacted: ${out.length} characters, too long to check»`;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = applyRules(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Mask a structured value (a tool's arguments) before it is serialised.
 *
 * - Under a credential-named key, any non-null value is replaced whole: a
 *   number, an array of tokens, a nested map of keys.
 * - Every other string goes through `redactSecrets`.
 *
 * Masking the OBJECT, not its JSON text, matters: once serialised, a secret
 * inside a string value (`"content":"token: …"`) is wrapped in JSON quoting
 * that the text rules are not written for.
 *
 * `budget`: when the caller keeps only the first `budget` characters of
 * `JSON.stringify(result)`, strings that start past that point are replaced
 * by `…` without being read. The kept characters are the same as without a
 * budget: positions are counted from below, so a string is dropped only when
 * it certainly starts past the cut. Returns a copy; the input is not modified.
 */
export function redactDeep(value, { budget = Infinity } = {}) {
  return walk(value, { used: 0, budget }, new WeakSet());
}

function walk(value, st, seen) {
  if (typeof value === 'string') {
    if (st.used >= st.budget) return '…';
    const out = redactSecrets(value);
    st.used += out.length + 2;
    return out;
  }
  if (value === null || typeof value !== 'object') {
    st.used += value === undefined ? 0 : String(value).length;
    return value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  st.used += 1; // `{` or `[`
  let out;
  if (Array.isArray(value)) {
    out = value.map((v, i) => {
      if (i > 0) st.used += 1;
      return walk(v, st, seen);
    });
  } else {
    out = Object.fromEntries(Object.entries(value).map(([k, v], i) => {
      st.used += (i > 0 ? 1 : 0) + k.length + 3; // `,"k":`
      if (v !== null && v !== undefined && isCredentialName(k) && !(typeof v === 'string' && isReference(v))) {
        st.used += REDACTED.length + 2;
        return [k, REDACTED];
      }
      return [k, walk(v, st, seen)];
    }));
  }
  st.used += 1; // `}` or `]`
  seen.delete(value);
  return out;
}
