/**
 * Count the form responses held by the Tangerine server under test.
 *
 * Reads them out of the server's own CouchDB, which Tangerine proxies at
 * `<server>/db/` (the same endpoint the Editor's admin UI uses). Deriving the
 * URL from SERVER_URL keeps this an oracle for exactly the server the app
 * uploaded to — never a different instance.
 *
 * Injected globals (via the calling flow's `runScript.env`):
 *   SERVER_URL, GROUP_DB, COUCH_USER, COUCH_PASSWORD, FORM_ID (optional)
 *
 * Outputs:
 *   output.responses — total response docs in the group
 *   output.forForm   — those belonging to FORM_ID (or all, when FORM_ID is empty)
 *
 * Optional EXPECTED: when supplied, the count must equal it or the script throws
 * (so the flow fails with a precise message rather than a bare assertion).
 */
function basicAuth(user, password) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const src = `${user}:${password}`;
  let out = '';
  for (let i = 0; i < src.length; i += 3) {
    const c1 = src.charCodeAt(i);
    const c2 = src.charCodeAt(i + 1);
    const c3 = src.charCodeAt(i + 2);
    const has2 = !isNaN(c2);
    const has3 = !isNaN(c3);
    out += chars[c1 >> 2];
    out += chars[((c1 & 3) << 4) | (has2 ? c2 >> 4 : 0)];
    out += has2 ? chars[((c2 & 15) << 2) | (has3 ? c3 >> 6 : 0)] : '=';
    out += has3 ? chars[c3 & 63] : '=';
  }
  return 'Basic ' + out;
}

const base = String(SERVER_URL).replace(/\/+$/, '');
if (!GROUP_DB) {
  throw new Error('GROUP_DB is required (the group database name, e.g. group-<uuid>)');
}

const dbUrl = `${base}/db/${GROUP_DB}/_all_docs?include_docs=true&limit=2000`;
const res = http.get(dbUrl, {
  headers: { Authorization: basicAuth(COUCH_USER, COUCH_PASSWORD) },
});

if (!res || res.status !== 200) {
  throw new Error(
    `Could not read responses from ${dbUrl} (status=${res && res.status}). ` +
      'Check GROUP_DB and the CouchDB credentials supplied via -e.'
  );
}

const rows = JSON.parse(res.body).rows || [];
const responses = rows
  .map((row) => row.doc)
  .filter((doc) => doc && doc.type === 'response');

output.responses = responses.length;
output.forForm = FORM_ID
  ? responses.filter((doc) => doc.formId === FORM_ID).length
  : responses.length;

if (typeof EXPECTED !== 'undefined' && EXPECTED !== null && String(EXPECTED) !== '') {
  if (Number(output.forForm) !== Number(EXPECTED)) {
    throw new Error(
      `Server response count mismatch for ${FORM_ID || GROUP_DB}: ` +
        `expected ${EXPECTED}, found ${output.forForm}`
    );
  }
}
