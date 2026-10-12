/**
 * secret-shapes.mjs — the credential FORMATS this repository knows how to
 * recognise, defined once.
 *
 * Two consumers read this table:
 *   - `export-gate.mjs` scans what would be published and STOPS on a hit;
 *   - `redact-secrets.mjs` masks what the session journal is about to write
 *     into a vault.
 * They used to be one consumer. Keeping the list here means a format added
 * for the gate is masked in the journal too, instead of drifting apart.
 *
 * High-confidence credential shapes. Each is a *format* with a checkable
 * prefix and length — not a guess — so a hit is worth stopping a release for.
 *
 * The regexes carry the `g` flag. Never run one of these objects directly with
 * `exec` in a loop: clone it (`new RegExp(re.source, re.flags)`) so two callers
 * cannot share a `lastIndex`.
 */
export const SECRET_RULES = Object.freeze([
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}/g },
  { id: 'openai-api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // A token starts where a run of token characters starts (not after `-`,
  // `_` or a letter). With `\b`, a run like `-eyJ-eyJ…` offered a start at
  // every `eyJ`, each reading to the end of the run before failing — time
  // growing with the square of the text (400 KB: killed after 10 s). Bounding
  // the header instead missed real tokens whose header carries a certificate
  // chain (several KB).
  { id: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    // Blank runs are bounded for the same reason: `authorization:` followed by
    // a long run of blanks made the three optional runs retry each other.
    id: 'authorization-header',
    re: /\bauthorization["'\s]{0,16}[:=]\s{0,16}["'`]?\s{0,16}(?:Bearer|Basic|Token)\s{1,16}([A-Za-z0-9._~+/=-]{12,})/gi,
    valueGroup: 1,
  },
]);
