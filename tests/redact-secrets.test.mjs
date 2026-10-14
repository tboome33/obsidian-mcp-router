/**
 * Tests for src/helpers/redact-secrets.mjs — the masking applied to user
 * prompts and tool arguments before the session journal writes them into a
 * vault.
 *
 * Why it exists: the journal hook used to copy Bash commands verbatim, and a
 * vault session note ended up holding a sudo password that had been piped into
 * `sudo -S`. Vaults are no longer only local folders: several are served from
 * a server and shared over the network.
 *
 * Every credential-shaped value in this file is BUILT AT RUN TIME. The release
 * scan reads tests/ (see contracts/export-allowlist.json), so a literal token
 * here would block a release; a template interpolation splits it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  redactSecrets, redactDeep, isCredentialName,
  REDACTED, REDACTION_RULES, CHECK_MAX_CHARS,
} from '../src/helpers/redact-secrets.mjs';
import { SECRET_RULES } from '../src/helpers/secret-shapes.mjs';

const PW = ['Qx7', 'mV2', 'pL9', 'zK4'].join('');       // 12 chars, no shape
const PW2 = ['Ha8', 'wT5', 'nB3'].join('');
const DASHES = '-'.repeat(5);

/** Assert the secret is gone and the marker is present, with a readable message. */
function assertMasked(input, secret, label = input) {
  const out = String(redactSecrets(input));
  assert.ok(!out.includes(secret), `${label}\n  → still holds the secret: ${out}`);
  assert.ok(out.includes(REDACTED), `${label}\n  → no ${REDACTED} marker: ${out}`);
  return out;
}

function assertUntouched(input) {
  assert.equal(String(redactSecrets(input)), input, `should be left as is: ${input}`);
}

// ---------------------------------------------------------------------------

describe('redactSecrets — a password piped into sudo -S', () => {
  test('a single-quoted echo before sudo -S is masked, the rest of the command kept', () => {
    assert.equal(
      redactSecrets(`echo '${PW}' | sudo -S ip6tables -S 2>/dev/null`),
      `echo ${REDACTED} | sudo -S ip6tables -S 2>/dev/null`,
    );
  });

  test('double-quoted, unquoted and echo -n forms are masked', () => {
    assertMasked(`echo "${PW}" | sudo -S whoami`, PW);
    assertMasked(`echo ${PW} | sudo -S whoami`, PW);
    assertMasked(`echo -n '${PW}' | sudo -S whoami`, PW);
  });

  test('every printf argument is masked', () => {
    assertMasked(`printf '%s\\n' '${PW}' | sudo -S whoami`, PW);
  });

  test('a pipe character inside the quoted password does not stop the masking', () => {
    assertMasked(`echo 'ab|${PW}' | sudo -S whoami`, PW);
  });

  test('combined flags (-kS) and flags before -S (-p, -u user) are recognised', () => {
    assertMasked(`echo '${PW}' | sudo -kS whoami`, PW);
    assertMasked(`echo '${PW}' | sudo -p '' -S whoami`, PW);
    assertMasked(`echo '${PW}' | sudo -u root -S whoami`, PW);
    assertMasked(`echo '${PW}' | sudo --stdin whoami`, PW);
  });

  test('the form found in a real session note (inside a quoted ssh argument) is masked twice', () => {
    const cmd = `plink -batch host "echo '${PW}' | sudo -S ip6tables -S; echo ===NAT===; echo '${PW}' | sudo -S ip6tables -t nat -S"`;
    const out = assertMasked(cmd, PW);
    assert.equal(out.split(REDACTED).length - 1, 2, out);
  });

  test('a here-string fed to sudo -S is masked', () => {
    assertMasked(`sudo -S whoami <<< '${PW}'`, PW);
  });

  test('echo piped to sudo WITHOUT -S is not a password and is kept', () => {
    assertUntouched(`echo '10.0.0.1 host' | sudo tee -a /etc/hosts`);
    assertUntouched(`echo 'x' | sudo pacman -S pkg`);
  });
});

describe('redactSecrets — credential flags on a command line', () => {
  test('--password=, --password <x>, --token and --api-key values are masked', () => {
    assertMasked(`mysql --password=${PW} db`, PW);
    assertMasked(`tool --password '${PW}' run`, PW);
    assertMasked(`gh auth login --with-token --token ${PW}`, PW);
    assertMasked(`cli --api-key=${PW}`, PW);
  });

  test('--password-file and --no-password keep their argument', () => {
    assertUntouched('tool --password-file /run/secrets/db run');
    assertUntouched('tool --no-password server');
  });

  test('mysql -p<x> is masked; mkdir -p and ssh -p 22 are not', () => {
    assertMasked(`mysql -uroot -p${PW} db`, PW);
    assertMasked(`mysqldump -u root -p'${PW}' db`, PW);
    assertUntouched('mkdir -p /tmp/a/b');
    assertUntouched('ssh -p 22 host');
    assertUntouched('mysql -u root -p db');
  });

  test('sshpass -p <x> is masked', () => {
    assertMasked(`sshpass -p '${PW}' ssh host`, PW);
  });

  test('openssl pass:<x> is masked, whatever the option that introduces it', () => {
    assertMasked(`openssl enc -aes-256-cbc -pass pass:${PW} -in a`, PW);
    // `-passin` is not a credential name: only the pass: source tells.
    assertMasked(`openssl rsa -passin pass:${PW} -in key.pem`, PW);
  });

  test('curl -u user:pass keeps the user and masks the password', () => {
    const out = assertMasked(`curl -u admin:${PW} https://host/api`, PW);
    assert.ok(out.includes('admin:'), out);
  });

  test('a password inside a URL keeps the user and the host', () => {
    const out = assertMasked(`git clone https://bob:${PW}@example.org/r.git`, PW);
    assert.ok(out.includes('https://bob:') && out.includes('@example.org/r.git'), out);
  });
});

describe('redactSecrets — headers', () => {
  test('Authorization values are masked, the scheme is kept', () => {
    const out = assertMasked(`curl -H "Authorization: Bearer ${PW}" https://h`, PW);
    assert.ok(out.includes('Bearer'), out);
    assertMasked(`Authorization: Basic ${PW}`, PW);
    assertMasked(`authorization: ${PW}`, PW);
  });

  test('a credential-named header such as X-Api-Key is masked', () => {
    assertMasked(`curl -H 'X-Api-Key: ${PW}' https://h`, PW);
    assertMasked(`curl --header "Private-Token: ${PW}" https://h`, PW);
  });
});

describe('redactSecrets — assignments', () => {
  test('shell and env assignments under a credential name are masked', () => {
    assertMasked(`DB_PASSWORD=${PW} node app.js`, PW);
    assertMasked(`export GITHUB_TOKEN="${PW}"`, PW);
    assertMasked(`export API_KEY='${PW}'`, PW);
    assertMasked(`MYSQL_ROOT_PASSWORD=${PW} SMTP_PASS=${PW2} docker compose up`, PW2);
  });

  test('a quoted value keeps its quotes once masked', () => {
    assert.equal(redactSecrets(`export API_KEY='${PW}'`), `export API_KEY='${REDACTED}'`);
  });

  test('a token in a URL query string is masked', () => {
    assertMasked(`curl "https://h/api?user=a&access_token=${PW}&x=1"`, PW);
  });

  test('ordinary assignments and variable references are kept', () => {
    assertUntouched('PATH=/usr/bin:/bin make');
    assertUntouched('BYPASS=1 npm test');
    assertUntouched('TOKEN=$TOKEN npm publish');
    assertUntouched('export PASSWORD="${PASSWORD}"');
    assertUntouched('export TOKEN=$(cat /run/secrets/t)');
    assertUntouched('PASSWORD_FILE=/run/secrets/db app');
    assertUntouched('API_KEY=<your-key> npm start');
    assertUntouched('PASSWORD= ./reset.sh');
    assertUntouched('password: ***');
  });

  test('a quoted value under a credential key (JSON, code) is masked', () => {
    const out = assertMasked(`{"vault":"v","apiKey":"${PW}","password":"${PW2}"}`, PW);
    assert.ok(!out.includes(PW2), out);
    assert.ok(out.includes('"vault":"v"'), out);
    assertMasked(`const clientSecret = '${PW}';`, PW);
  });

  test('an unquoted YAML line under a credential key is masked', () => {
    assertMasked(`services:\n  db:\n    environment:\n      MYSQL_PASSWORD: ${PW}\n`, PW);
    assertMasked(`- password: ${PW}`, PW);
  });

  test('isCredentialName reads camelCase, snake_case and joined names', () => {
    for (const n of ['apiKey', 'API_KEY', 'APIKEY', 'accessToken', 'ACCESSTOKEN', 'db-password', 'SMTP_PASS', 'clientSecret', 'privateKey', 'dbPassword', 'smtpPass']) {
      assert.equal(isCredentialName(n), true, n);
    }
    for (const n of ['PATH', 'BYPASS', 'SSH_KEY', 'PRIMARY_KEY', 'password_file', 'TOKEN_URL', 'no-password', 'tokenizer']) {
      assert.equal(isCredentialName(n), false, n);
    }
  });
});

describe('redactSecrets — known credential formats', () => {
  // One sample per shaped format the export gate knows. The coverage test
  // below fails when a format is added there without a sample here.
  const SAMPLES = {
    'private-key-block': {
      text: `${DASHES}BEGIN PRIVATE KEY${DASHES}\nMIIE${'Ab3x'.repeat(10)}\n${DASHES}END PRIVATE KEY${DASHES}`,
      value: `MIIE${'Ab3x'.repeat(10)}`,
    },
    'aws-access-key-id': { value: `AKIA${'Q7ZX'.repeat(4)}` },
    'github-token': { value: `ghp_${'a1B2'.repeat(9)}` },
    'github-fine-grained-pat': { value: `github_pat_${'a1B2c'.repeat(12)}` },
    'slack-token': { value: `xox${'b'}-${'1234567890'}-${'abcdEFGH'}` },
    'anthropic-api-key': { value: `sk-ant-${'a1B2c3D4'.repeat(4)}` },
    'openai-api-key': { value: `sk-proj-${'Zz9Yy8Xx7W'.repeat(3)}` },
    'google-api-key': { value: `AIza${'Bc3d5'.repeat(7)}` },
    'jwt': { value: `eyJ${'hbGciOiJIUzI1'}.eyJ${'zdWIiOiIxMjM0'}.${'SflKxwRJSMeKKF2QT4fw'}` },
    'npm-token': { value: `npm_${'a1B2'.repeat(9)}` },
    // Folded onto a second line: the `authorization-value` rule reads one
    // line, so only the gate's format catches this one.
    'authorization-header': { text: `Authorization:\n  Bearer ${'a1B2c3D4e5F6'.repeat(2)}`, value: 'a1B2c3D4e5F6'.repeat(2) },
  };

  test('every shaped format known to the export gate has a sample here', () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), SECRET_RULES.map((r) => r.id).sort());
  });

  for (const rule of SECRET_RULES) {
    test(`format ${rule.id} is masked in free text`, () => {
      const s = SAMPLES[rule.id];
      assert.ok(s, `no sample for ${rule.id}`);
      // `value` is the part that must disappear; `text` the whole sample when
      // the format needs context around it.
      assertMasked(`before ${s.text ?? s.value} after`, s.value, rule.id);
    });
  }

  test('a private key block is masked down to its END line, body included', () => {
    const body = `MIIE${'Ab3x'.repeat(10)}\n${'Zq8w'.repeat(10)}`;
    const out = redactSecrets(`a\n${DASHES}BEGIN RSA PRIVATE KEY${DASHES}\n${body}\n${DASHES}END RSA PRIVATE KEY${DASHES}\nz`);
    assert.ok(!out.includes('Ab3x') && !out.includes('Zq8w'), out);
    assert.ok(out.startsWith('a\n') && out.endsWith('\nz'), out);
  });

  test('a JWT whose header segment is longer than 1 024 characters is still recognised', () => {
    // A header can carry a certificate chain (x5c) of several KB.
    const jwt = `eyJ${'h5'.repeat(1500)}.eyJ${'p4'.repeat(40)}.${'s3'.repeat(30)}`;
    assertMasked(`token ${jwt} end`, jwt.slice(-40), 'long JWT header');
  });

  test('a private key block cut before its END line is masked to the end of the text', () => {
    const out = redactSecrets(`${DASHES}BEGIN OPENSSH PRIVATE KEY${DASHES}\nb3Bl${'Zq8w'.repeat(12)}`);
    assert.ok(!out.includes('Zq8w'), out);
  });
});

describe('redactDeep — tool arguments as objects', () => {
  test('a credential-named key has its string value masked at any depth', () => {
    const out = redactDeep({ vault: 'v', config: { apiKey: PW, nested: [{ password: PW2 }] } });
    assert.deepEqual(out, { vault: 'v', config: { apiKey: REDACTED, nested: [{ password: REDACTED }] } });
  });

  test('a secret inside any other string value is masked', () => {
    const out = redactDeep({ steps: [{ path: 'wiki/a.md', content: `token: ${PW}\nok` }] });
    assert.equal(out.steps[0].path, 'wiki/a.md');
    assert.ok(!out.steps[0].content.includes(PW), JSON.stringify(out));
    assert.ok(out.steps[0].content.endsWith('\nok'), JSON.stringify(out));
  });

  test('numbers, booleans and null are kept, and the input is not modified', () => {
    const input = { n: 3, b: true, z: null, token: PW };
    const out = redactDeep(input);
    assert.deepEqual(out, { n: 3, b: true, z: null, token: REDACTED });
    assert.equal(input.token, PW, 'input object left as it was');
  });

  test('an object reached twice without a cycle is masked both times', () => {
    const shared = { token: PW };
    const out = redactDeep({ a: shared, b: shared });
    assert.deepEqual(out, { a: { token: REDACTED }, b: { token: REDACTED } });
  });

  test('a cyclic object is cut instead of looping', () => {
    const a = { name: 'a' };
    a.self = a;
    const out = redactDeep(a);
    assert.equal(out.name, 'a');
    assert.equal(typeof out.self, 'string');
  });
});

describe('redactSecrets — cost stays proportional to the text', () => {
  // Measured before the bounds existed: 100 KB of `echo ` kept the masking
  // busy for more than 280 seconds (each `echo` read to the end of its line).
  // The journal hook runs on every prompt and tool call. The limit below is
  // about 50 times what the bounded rules take on a developer machine.
  //
  // Each measure runs in a CHILD process: a regex that runs away blocks its
  // own thread, so an in-process timer could never stop it. The child is
  // killed at the limit and the test reports that.
  //
  // About 400 KB each, just under CHECK_MAX_CHARS (the most the masking reads
  // at all), so that a reach left unbounded shows as minutes, not as a second
  // that a fast machine would let through. Each case is a JavaScript
  // expression evaluated in the child.
  const LIMIT_MS = 2000;
  const MODULE_URL = new URL('../src/helpers/redact-secrets.mjs', import.meta.url).href;
  const cases = {
    'the word echo repeated': "'echo '.repeat(80000)",
    'sudo -S repeated': "'sudo -S '.repeat(50000)",
    'mysql repeated': "'mysql '.repeat(66666)",
    'sshpass repeated': "'sshpass '.repeat(50000)",
    'curl repeated': "'curl '.repeat(80000)",
    'unclosed quoted assignments': "'A=\"'.repeat(133333)",
    'unclosed JSON credential values': "'\"apiKey\":\"'.repeat(40000)",
    'authorization repeated': "'authorization:'.repeat(28571)",
    // Found by review: a run of blanks after a key, after `authorization:`,
    // and a token format restarting inside its own run.
    'a key followed by blanks only': "'a: ' + ' '.repeat(400000)",
    'authorization followed by blanks only': "'authorization:' + ' '.repeat(400000)",
    'a dash and eyJ repeated': "'-eyJ'.repeat(100000)",
    'continued lines repeated': "'mysql \\\\\\n'.repeat(50000)",
    // A key header, then thousands of blank-line + key-line pairs and no END:
    // each blank line is checked against the line after it, once.
    'a private key cut into blank-separated lines':
      "'-'.repeat(5) + 'BEGIN PRIVATE KEY' + '-'.repeat(5) + ('\\n\\n' + 'A'.repeat(64)).repeat(6000)",
    'thousands of BEGIN lines and one END line far away':
      "('-'.repeat(5) + 'BEGIN PRIVATE KEY' + '-'.repeat(5) + '\\n\\n').repeat(13000) + '-'.repeat(5) + 'END PRIVATE KEY' + '-'.repeat(5)",
  };
  for (const [name, expr] of Object.entries(cases)) {
    test(`400 KB of ${name} is masked in under ${LIMIT_MS} ms`, () => {
      const script = [
        `const { redactSecrets } = await import(${JSON.stringify(MODULE_URL)});`,
        `const text = ${expr};`,
        'const t = process.hrtime.bigint();',
        'redactSecrets(text);',
        'process.stdout.write(String(Number(process.hrtime.bigint() - t) / 1e6));',
      ].join('\n');
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8', timeout: LIMIT_MS * 5,
      });
      assert.equal(r.signal, null, `${name}: still running after ${LIMIT_MS * 5} ms, killed`);
      assert.equal(r.status, 0, r.stderr);
      const ms = Number(r.stdout);
      assert.ok(ms < LIMIT_MS, `${name}: ${Math.round(ms)} ms`);
    });
  }
});

describe('redactSecrets — long values are masked whole', () => {
  // A value is read to its end: masking only its start would leave the rest
  // in clear, and a token format can no longer recognise what remains.
  const LONG = `${PW}${'x9'.repeat(1500)}`;
  const JWT = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(900)}.${'c'.repeat(43)}`;

  for (const [name, text, secret] of [
    // Spaces around `=`: only `quoted-assignment` reads this form.
    ['a quoted assignment', `const apiKey = "${LONG}";`, LONG],
    ['a quoted JSON value', `{"apiKey":"${LONG}"}`, LONG],
    ['an Authorization value', `Authorization: Bearer ${LONG}`, LONG],
    ['a credential-named header', `curl -H "X-Api-Key: ${LONG}" https://h`, LONG],
    ['a bare assignment', `TOKEN=${LONG} run`, LONG],
    ['a credential flag', `tool --password=${LONG} run`, LONG],
    ['a credential flag followed by its value', `tool --password ${LONG} run`, LONG],
    ['a JWT given to a flag', `kubectl --token=${JWT} get pods`, JWT],
    ['an openssl pass: source', `openssl rsa -passin pass:${LONG} -in k`, LONG],
    ['a glued mysql -p', `mysql -u root -p${LONG} db`, LONG],
    ['an sshpass -p', `sshpass -p ${LONG} ssh h`, LONG],
    ['a curl -u password', `curl -u bob:${LONG} https://h`, LONG],
    ['a here-string to sudo -S', `sudo -S whoami <<< ${LONG}`, LONG],
    ['a URL password', `git clone https://bob:${LONG}@example.org/r.git`, LONG],
  ]) {
    test(`${name} of ${secret.length} characters leaves nothing of the secret`, () => {
      const out = redactSecrets(text);
      const head = secret.slice(0, 12);
      const tail = secret.slice(-40);
      assert.ok(!out.includes(head) && !out.includes(tail), `${name}: ${out.slice(0, 60)}…${out.slice(-60)}`);
    });
  }
});

describe('redactSecrets — forms found missing by review', () => {
  test('plink -pw is masked as well as the sudo password it carries', () => {
    assertMasked(`plink -batch -ssh -P 22 admin@192.0.2.11 -pw '${PW}' "echo '${PW}' | sudo -S docker ps"`, PW);
  });

  test('a password piped into ssh or plink whose remote command runs sudo -S is masked', () => {
    assertMasked(`echo '${PW}' | ssh admin@host 'sudo -S apt-get update'`, PW);
    assertMasked(`echo '${PW}' | plink -batch host "sudo -S ls"`, PW);
  });

  test('echo whose output goes elsewhere is kept, even when sudo -S follows', () => {
    assertUntouched("echo 'hello' | grep h; sudo -S ls");
    assertUntouched("echo 'hello' | grep h && sudo -S ls");
  });

  test('a command continued over several lines with backslashes is still recognised', () => {
    assertMasked(`mysql -h db.internal -u root \\\n  -p${PW} appdb`, PW);
    assertMasked(`echo '${PW}' \\\n  | sudo -S whoami`, PW);
    assertMasked(`curl https://h \\\n  -u admin:${PW}`, PW);
    assertMasked(`sshpass \\\n  -p ${PW} ssh h`, PW);
  });

  test('an Authorization value with any scheme, or built by a command, is masked', () => {
    const out = assertMasked(`curl -H "Authorization: SSWS ${PW}" https://h`, PW);
    assert.ok(out.endsWith('" https://h'), `the closing quote and the rest stay: ${out}`);
    assertMasked(`Authorization: ApiKey ${PW}`, PW);
    assertMasked(`curl -H "Authorization: Basic $(echo -n bob:${PW} | base64)" https://h`, PW);
  });

  test('a command substitution that prints a literal is not a reference', () => {
    assertMasked(`TOKEN=$(echo -n "bob:${PW}" | base64) curl h`, PW);
    assertMasked(`export TOKEN=$(printf '%s' '${PW}')`, PW);
  });

  test('credential names written as one word are recognised, ordinary words are not', () => {
    assertMasked(`PGPASSWORD=${PW} psql -h db`, PW);
    assertMasked(`SSHPASS=${PW} sshpass -e ssh h`, PW);
    assertMasked(`REDISCLI_AUTH=${PW} redis-cli ping`, PW);
    for (const n of ['PGPASSWORD', 'SSHPASS', 'REDISCLI_AUTH', 'pw', 'newPw']) assert.equal(isCredentialName(n), true, n);
    for (const n of ['BYPASS', 'COMPASS', 'PW_LEN']) assert.equal(isCredentialName(n), false, n);
  });

  test('cookies are masked', () => {
    assertMasked(`curl -H 'Cookie: session=${PW}' https://h`, PW);
    assertMasked(`curl -b 'session=${PW}' https://h`, PW);
    assertMasked(`curl --cookie "sid=${PW}" https://h`, PW);
    assertMasked(`Set-Cookie: sid=${PW}; Path=/`, PW);
  });

  test('a credential inside escaped JSON (a Windows command line) is masked, the rest kept', () => {
    const out = assertMasked(`curl -d "{\\"password\\":\\"${PW}\\",\\"user\\":\\"bob\\"}" https://h`, PW);
    assert.ok(out.includes('\\"user\\":\\"bob\\"'), out);
  });

  test('registry and database clients with a short password option are masked', () => {
    assertMasked(`docker login -u bob -p ${PW} registry.example.org`, PW);
    assertMasked(`podman login -u bob -p ${PW} quay.io`, PW);
    assertMasked(`redis-cli -h cache -a ${PW} ping`, PW);
  });

  test('bearer, auth, npm registry, SAS and kubeconfig forms are masked', () => {
    assertMasked(`curl --oauth2-bearer ${PW} https://h`, PW);
    assertMasked(`http --auth bob:${PW} https://h`, PW);
    assertMasked(`//gitlab.example.com/api/v4/packages/npm/:_authToken=${PW}`, PW);
    assertMasked(`azcopy copy "https://acct.blob.core.windows.net/c?sv=2022-11-02&sig=${PW}" .`, PW);
    assertMasked(`$headers = @{ "X-Api-Key" = "${PW}" }`, PW);
    assertMasked(`    client-key-data: ${PW}`, PW);
  });

  test('an echo argument longer than 512 characters is still read before sudo -S', () => {
    const LONG = `${PW}${'x9'.repeat(1500)}`;
    assertMasked(`echo '${LONG}' | sudo -S whoami`, PW);
  });

  test('a PowerShell plain-text SecureString is masked', () => {
    assertMasked(`$s = ConvertTo-SecureString '${PW}' -AsPlainText -Force`, PW);
    assertMasked(`ConvertTo-SecureString -String "${PW}" -AsPlainText`, PW);
  });
});

describe('redactSecrets — one call is enough', () => {
  test('a secret that only becomes recognisable once a token next to it is masked is masked in one call', () => {
    // The -p lies more than 256 characters after `mysql` until the JWT is masked.
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(400)}.${'c'.repeat(43)}`;
    assertMasked(`mysql --comment ${jwt} -p${PW} db`, PW);
  });

  test('masking twice gives the same text as masking once, over a varied set', () => {
    const LONG = `${PW}${'x9'.repeat(1500)}`;
    for (const input of [
      `echo '${PW}' | sudo -S x; DB_PASSWORD=${PW} y; curl -H "Authorization: Bearer ${PW}"`,
      `mysql --comment eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(900)}.${'c'.repeat(43)} -p${PW}`,
      `export API_KEY='${PW}'`,
      `{"apiKey":"${LONG}","n":1}`,
      `curl -H "Authorization: SSWS ${PW}" -b 'sid=${PW}' https://bob:${PW}@h`,
    ]) {
      const once = redactSecrets(input);
      assert.equal(redactSecrets(once), once, `not stable: ${once.slice(0, 120)}`);
    }
  });
});

describe('redactSecrets — private keys and markdown', () => {
  test('a private key without its END line stops at the closing fence, which stays', () => {
    const input = `\`\`\`\n${DASHES}BEGIN OPENSSH PRIVATE KEY${DASHES}\nb3Bl${'Zq8w'.repeat(12)}\n\`\`\`\nWhy does this fail?`;
    const out = redactSecrets(input);
    assert.ok(!out.includes('Zq8w'), out);
    assert.ok(out.endsWith('\n```\nWhy does this fail?'), `the fence and the text after it stay: ${JSON.stringify(out)}`);
  });

  // Found by the second review: an encrypted PEM key has a blank line between
  // its Proc-Type / DEK-Info headers and its body. Stopping at ANY blank line
  // masked the headers and wrote the body in clear.
  const BODY = Array.from({ length: 4 }, (_, i) => `${'Qk9E'.repeat(15)}${String(i).repeat(4)}`).join('\n');
  const ENCRYPTED_HEAD = `${DASHES}BEGIN RSA PRIVATE KEY${DASHES}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCD\n\n`;

  test('an encrypted PEM key, whose headers are followed by a blank line, is masked whole', () => {
    const out = redactSecrets(`before\n${ENCRYPTED_HEAD}${BODY}\n${DASHES}END RSA PRIVATE KEY${DASHES}\nafter`);
    assert.ok(!out.includes('Qk9E'), `the key body is masked: ${JSON.stringify(out)}`);
    assert.equal(out, `before\n${REDACTED}\nafter`);
  });

  test('an encrypted PEM key cut before its END line is masked to the end of its body', () => {
    const out = redactSecrets(`${ENCRYPTED_HEAD}${BODY}`);
    assert.ok(!out.includes('Qk9E'), `the key body is masked: ${JSON.stringify(out)}`);
  });

  // Found by the third review: four ways a key gets pasted that put a blank
  // line before a line the blank-line rule cannot recognise as key material.
  // With the END line present, the key is masked through it in every case.
  const END_RSA = `${DASHES}END RSA PRIVATE KEY${DASHES}`;
  for (const [name, text] of [
    ['doubled line endings (a blank line between every line)', `${ENCRYPTED_HEAD}${BODY}\n${END_RSA}`.replace(/\n/g, '\n\n')],
    ['two blank lines before the body', `${ENCRYPTED_HEAD}\n${BODY}\n${END_RSA}`],
    ['a quoted reply whose blank line is empty', [
      `> ${DASHES}BEGIN RSA PRIVATE KEY${DASHES}`, '> Proc-Type: 4,ENCRYPTED', '> DEK-Info: AES-128-CBC,ABCD', '',
      BODY.replace(/^/gm, '> '), `> ${END_RSA}`,
    ].join('\n')],
    ['a body rewrapped with a short first line', `${ENCRYPTED_HEAD}Qk9E\n${BODY}\n${END_RSA}`],
  ]) {
    test(`an encrypted PEM key pasted with ${name} is masked through its END line`, () => {
      const out = redactSecrets(`before\n${text}\nafter`);
      assert.ok(!out.includes('Qk9E'), `the key body is masked: ${JSON.stringify(out)}`);
      assert.ok(out.startsWith('before\n') && out.endsWith('\nafter'), `the text around stays: ${JSON.stringify(out)}`);
    });
  }

  test('a key cut before its END line, followed by a complete key, does not swallow the text between them', () => {
    const cut = `${DASHES}BEGIN RSA PRIVATE KEY${DASHES}\nMIIE${'Ab3x'.repeat(10)}`;
    const full = `${DASHES}BEGIN RSA PRIVATE KEY${DASHES}\n${'Zq8w'.repeat(10)}\n${END_RSA}`;
    const out = redactSecrets(`${cut}\n\nThe paragraph between.\n\n${full}\nafter`);
    assert.ok(!out.includes('Ab3x') && !out.includes('Zq8w'), `both keys are masked: ${JSON.stringify(out)}`);
    assert.ok(out.includes('\n\nThe paragraph between.\n\n'), `the paragraph between stays: ${JSON.stringify(out)}`);
  });

  test('a key cut before its END line does not run through a code fence to an END line beyond it', () => {
    const cut = `\`\`\`\n${DASHES}BEGIN RSA PRIVATE KEY${DASHES}\nMIIE${'Ab3x'.repeat(10)}\n\`\`\``;
    const tail = `\`\`\`\n${'Zq8w'.repeat(10)}\n${END_RSA}\n\`\`\``;
    const out = redactSecrets(`${cut}\nThe end of the key was:\n${tail}`);
    assert.ok(!out.includes('Ab3x'), `the cut key is masked: ${JSON.stringify(out)}`);
    assert.ok(out.includes('\n```\nThe end of the key was:\n```\n'), `the fences and the text between stay: ${JSON.stringify(out)}`);
  });

  test('a private key without its END line stops at a blank line', () => {
    const out = redactSecrets(`${DASHES}BEGIN PRIVATE KEY${DASHES}\nMIIE${'Ab3x'.repeat(10)}\n\nNext paragraph.`);
    assert.ok(!out.includes('Ab3x'), `the key body is masked: ${JSON.stringify(out)}`);
    assert.ok(out.endsWith('\n\nNext paragraph.'), `the paragraph after the blank line stays: ${JSON.stringify(out)}`);
  });
});

describe('redactDeep — credential keys and output budget', () => {
  test('anything under a credential key is masked, not only strings', () => {
    assert.deepEqual(
      redactDeep({ password: 12345678, tokens: ['a', 'b'], apiKeys: { github: PW }, secret: null, user: 'bob' }),
      { password: REDACTED, tokens: REDACTED, apiKeys: REDACTED, secret: null, user: 'bob' },
    );
  });

  test('with a budget, the start of the serialised result is the same as without, and the rest is dropped unread', () => {
    const big = `token: ${PW}\n${'z'.repeat(5000)}`;
    const input = { vault: 'v', steps: Array.from({ length: 30 }, (_, i) => ({ path: `wiki/${i}.md`, content: big })) };
    const full = JSON.stringify(redactDeep(input));
    const budgeted = JSON.stringify(redactDeep(input, { budget: 200 }));
    assert.equal(budgeted.slice(0, 200), full.slice(0, 200));
    assert.ok(budgeted.length < 15_000, `the later contents were not kept (${budgeted.length} characters)`);
    assert.ok(!budgeted.includes(PW), 'nothing unmasked');
  });
});

describe('redactSecrets — text too long to check', () => {
  test('a text longer than CHECK_MAX_CHARS is withheld whole, not passed through', () => {
    const out = redactSecrets(`${'x'.repeat(CHECK_MAX_CHARS)} ${PW}`);
    assert.ok(!out.includes(PW) && !out.includes('xxxx'), out.slice(0, 80));
    assert.match(out, /too long to check/);
    assert.ok(out.length < 200, `a short notice, not the text (${out.length})`);
  });

  test('a text of exactly CHECK_MAX_CHARS is checked normally', () => {
    const text = `DB_PASSWORD=${PW} ${'x'.repeat(CHECK_MAX_CHARS - 30)}`;
    assert.equal(text.length <= CHECK_MAX_CHARS, true, 'fixture');
    const out = redactSecrets(text);
    assert.ok(out.startsWith(`DB_PASSWORD=${REDACTED} xxx`), out.slice(0, 60));
  });
});

describe('redactSecrets — general behaviour', () => {
  test('null and undefined give an empty string', () => {
    assert.equal(redactSecrets(null), '');
    assert.equal(redactSecrets(undefined), '');
  });

  test('ordinary commands and prose are left untouched', () => {
    for (const s of [
      'npm test',
      'git commit -m "fix: password reset flow"',
      'docker compose --dry-run up -d',
      'Peux-tu vérifier le mot de passe de la page de connexion ?',
      'grep -rn "token" src/',
    ]) assertUntouched(s);
  });

  test('redaction rules carry unique names', () => {
    // The names are what the mutation bench and a reader refer to; two rules
    // sharing one would make a report about "the rule" ambiguous.
    const ids = REDACTION_RULES.map((r) => r.id);
    assert.ok(ids.length > 0, 'the rule table is empty');
    assert.equal(new Set(ids).size, ids.length, `duplicate rule ids in ${ids.join(', ')}`);
  });
});
