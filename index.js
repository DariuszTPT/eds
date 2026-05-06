/*
 * Adobe Document Authoring — TransPerfect GlobalLink Enterprise (GLE) Connector
 *
 * Drop this file into your DA project at:
 *   /nx/blocks/loc/globallink/index.js
 *
 * Authentication: Username + Password (JSON body → Bearer token)
 *
 * Before deploying, fill in the two values marked TODO in CONFIG below.
 * Everything else is wired to the real GlobalLink Enterprise REST API.
 *
 * Required DA exports:
 *   isConnected()      — checks if the user is authenticated
 *   connect()          — prompts for username/password, exchanges for token
 *   getItems()         — retrieves existing GLE submissions
 *   sendAllLanguages() — runs the 3-step GLE submission flow
 *   getStatusAll()     — polls job statuses from GLE
 *
 * GlobalLink Enterprise API base:  https://connect.translations.com
 * API version used:                v2
 */

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const CONFIG = {
  // Base URL of your GlobalLink Enterprise instance.
  // For the TransPerfect cloud this is always the value below.
  // If your org runs a self-hosted GLE instance, replace with your internal URL.
  BASE_URL: 'https://connect.translations.com',

  // GLE login endpoint — exchanges username + password for a Bearer token.
  // TODO: Replace with the login URL provided by TransPerfect for your org.
  // Typically: https://<your-instance>.translations.com/api/v2/login
  LOGIN_URL: 'https://dev-connect-gle.transperfect.com/PD/api/v2/login',

  // Your GlobalLink project shortcode — found in the GLE admin dashboard
  // under Projects. Required when creating a submission.
  // TODO: Replace with your actual project shortcode.
  PROJECT_SHORTCODE: 'ADI000012',

  // GLE REST API v2 paths — do not change these.
  PATHS: {
    CONFIG:      '/api/v2/connectors/config', // GET  — fetch project/language config
    CONTENT:     '/api/v2/content/file',      // POST — upload one HTML file → content_id
    SUBMISSIONS: '/api/v2/submissions',       // POST — create submission | GET — list submissions
    JOBS:        '/api/v2/jobs',              // GET/POST — list/filter jobs by status
    JOB_TASKS:   '/api/v2/jobs/task',         // GET  — get tasks for a specific job
  },

  // localStorage keys — safe to leave as-is.
  STORAGE: {
    TOKEN:        'gle-da-access-token',
    TOKEN_EXPIRY: 'gle-da-token-expiry',
    USERNAME:     'gle-da-username',
    PASSWORD:     'gle-da-password',
  },
};

// ---------------------------------------------------------------------------
// TOKEN MANAGEMENT
// ---------------------------------------------------------------------------

/**
 * Returns a valid Bearer token, auto-refreshing if expired.
 *
 * GLE username/password login flow:
 *   POST /api/v2/login
 *   Body: { "username": "...", "password": "..." }
 *   Response: { "access_token": "...", "expires_in": 3600 }
 *
 * Credentials and tokens are persisted in localStorage between sessions.
 */
async function getToken() {
  const expiry = localStorage.getItem(CONFIG.STORAGE.TOKEN_EXPIRY);
  const token  = localStorage.getItem(CONFIG.STORAGE.TOKEN);

  // Return cached token if still valid (60-second safety buffer).
  if (token && expiry && Date.now() < parseInt(expiry, 10) - 60_000) {
    return token;
  }

  const username = localStorage.getItem(CONFIG.STORAGE.USERNAME);
  const password = localStorage.getItem(CONFIG.STORAGE.PASSWORD);

  if (!username || !password) {
    throw new Error('GlobalLink credentials not found. Please connect first.');
  }

  // POST credentials as JSON to the GLE login endpoint.
  const resp = await fetch(CONFIG.LOGIN_URL, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
    body: JSON.stringify({ username, password }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GLE login failed (${resp.status}): ${err}`);
  }

  const data        = await resp.json();
  const accessToken = data.access_token || data.token;
  const expiresIn   = data.expires_in   || 3600; // default 1 hour

  if (!accessToken) {
    throw new Error('GLE login response did not contain an access token.');
  }

  localStorage.setItem(CONFIG.STORAGE.TOKEN,        accessToken);
  localStorage.setItem(CONFIG.STORAGE.TOKEN_EXPIRY, String(Date.now() + expiresIn * 1000));

  return accessToken;
}

/**
 * Returns standard JSON headers required by every GLE API call.
 * Uses the Bearer token obtained from username/password login.
 */
async function gleHeaders(extra = {}) {
  const token = await getToken();
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
    'Cache-Control': 'no-cache',
    ...extra,
  };
}

/**
 * Thin fetch wrapper with GLE auth headers baked in.
 * Throws a descriptive error on any non-2xx response.
 */
async function gleFetch(path, options = {}) {
  const headers = await gleHeaders(options.headers || {});
  const resp = await fetch(`${CONFIG.BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`GLE API error ${resp.status} on ${path}: ${body}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// GLE SUBMISSION WORKFLOW HELPERS
// ---------------------------------------------------------------------------

/**
 * STEP 1 — Upload a single HTML file to GLE.
 *
 * GLE requires each piece of content to be uploaded individually before
 * a submission can be created. Returns the content_id for use in step 2.
 *
 * @param {string} name — short file name shown in the GLE dashboard
 * @param {string} html — raw HTML content of the DA page
 * @param {string} url  — original DA page URL (used as unique_identifier)
 * @returns {Promise<string>} content_id
 */
async function uploadContentFile(name, html, url) {
  const blob     = new Blob([html], { type: 'text/html' });
  const formData = new FormData();
  formData.append('name',                  name);
  formData.append('file_type',             'html');
  formData.append('unique_identifier',     url);
  // change_detection_data lets GLE detect if content changed since last submit.
  formData.append('change_detection_data', String(Date.now()));
  formData.append('file',                  blob, `${name}.html`);

  // IMPORTANT: Do NOT set Content-Type manually for FormData —
  // the browser sets it automatically with the correct multipart boundary.
  const token = await getToken();
  const resp  = await fetch(`${CONFIG.BASE_URL}${CONFIG.PATHS.CONTENT}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Cache-Control': 'no-cache',
    },
    body: formData,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GLE content upload failed for "${name}" (${resp.status}): ${err}`);
  }

  const data = await resp.json();
  // GLE returns: { content_id: "abc123", ... }
  return data.content_id;
}

/**
 * STEP 2 — Create a GLE submission referencing uploaded content_ids.
 *
 * @param {string}   submissionName — label shown in the GLE dashboard
 * @param {string[]} contentIds     — array of content_ids from step 1
 * @param {string[]} languages      — target locale codes e.g. ['fr-FR', 'de-DE']
 * @param {string}   dueDate        — ISO 8601 due date e.g. '2026-05-01T00:00:00Z'
 */
async function createSubmission(submissionName, contentIds, languages, dueDate) {
  const payload = {
    name:              submissionName,
    project_shortcode: CONFIG.PROJECT_SHORTCODE,
    due_date:          dueDate,
    target_locales:    languages,
    content_ids:       contentIds,
    // Uncomment to add instructions for the GLE translation team:
    // instructions: 'Please preserve all HTML tags and attributes.',
  };

  return gleFetch(CONFIG.PATHS.SUBMISSIONS, {
    method: 'POST',
    body:   JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// REQUIRED DA CONNECTOR EXPORTS
// ---------------------------------------------------------------------------

/**
 * isConnected()
 *
 * DA calls this on page load to decide whether to show the Connect button.
 * Returns true only if stored credentials can produce a valid GLE Bearer token.
 */
export async function isConnected() {
  try {
    const token = await getToken();
    return !!token;
  } catch {
    return false;
  }
}

/**
 * connect()
 *
 * DA calls this when the user clicks "Connect" in the translation UI.
 * Prompts for GLE username and password, then validates them by
 * exchanging credentials for a real Bearer token.
 */
export async function connect() {
  const username = prompt(
    'GlobalLink Enterprise\n\nEnter your GLE Username:\n'
    + '(The same username you use to log in to the GLE dashboard)',
  );
  if (!username) throw new Error('Username is required to connect to GlobalLink.');

  const password = prompt('GlobalLink Enterprise\n\nEnter your GLE Password:');
  if (!password) throw new Error('Password is required to connect to GlobalLink.');

  // Persist credentials for this and future sessions.
  localStorage.setItem(CONFIG.STORAGE.USERNAME, username);
  localStorage.setItem(CONFIG.STORAGE.PASSWORD, password);

  // Validate by actually logging in — throws if credentials are wrong.
  await getToken();
}

/**
 * getItems()
 *
 * DA calls this to populate the submission list in the translation UI.
 * Returns all GLE submissions for this project, normalised for DA.
 */
export async function getItems() {
  const data = await gleFetch(CONFIG.PATHS.SUBMISSIONS);

  // GLE returns: { submissions: [ { submission_id, name, status, due_date, ... } ] }
  const submissions = data.submissions || data || [];

  return submissions.map((s) => ({
    id:      s.submission_id || s.id,
    name:    s.name,
    status:  s.status,
    dueDate: s.due_date,
    created: s.created_at,
  }));
}

/**
 * sendAllLanguages(urls, languages)
 *
 * DA calls this when the user clicks "Send all for translation".
 * Implements the full 3-step GlobalLink Enterprise submission flow:
 *
 *   Step 1 — Fetch HTML from each DA page URL
 *   Step 2 — Upload each HTML file to GLE via POST /api/v2/content/file
 *             → receive a content_id per file
 *   Step 3 — Create a GLE submission via POST /api/v2/submissions
 *             referencing all content_ids + target languages
 *
 * @param {string[]} urls       — DA page URLs to translate
 * @param {string[]} languages  — target locale codes e.g. ['fr-FR', 'de-DE']
 */
export async function sendAllLanguages(urls, languages) {
  // ── Step 1: Fetch the HTML content of each DA page URL ──────────────────
  console.log(`[GLE Connector] Fetching HTML for ${urls.length} page(s)...`);

  const pages = await Promise.all(
    urls.map(async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch DA page (${resp.status}): ${url}`);
      const html = await resp.text();
      // Derive a short file name from the last segment of the URL path.
      const name = url.split('/').filter(Boolean).pop() || 'page';
      return { url, html, name };
    }),
  );

  // ── Step 2: Upload each HTML file to GLE, collect content_ids ───────────
  console.log(`[GLE Connector] Uploading ${pages.length} HTML file(s) to GlobalLink...`);

  const contentIds = await Promise.all(
    pages.map(({ name, html, url }) => uploadContentFile(name, html, url)),
  );

  console.log('[GLE Connector] Uploaded files, content_ids:', contentIds);

  // ── Step 3: Create the GLE submission ───────────────────────────────────
  // Auto-generate a submission name with today's date and page count.
  const submissionName = `DA-${new Date().toISOString().slice(0, 10)}-${pages.length}page(s)`;

  // Default due date: 7 days from now. Adjust as needed.
  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  console.log(`[GLE Connector] Creating submission "${submissionName}" for languages: ${languages.join(', ')}`);

  const result = await createSubmission(submissionName, contentIds, languages, dueDate);

  console.log('[GLE Connector] Submission created successfully:', result);
  return result;
}

/**
 * getStatusAll()
 *
 * DA calls this on a polling interval to update the translation progress UI.
 * Fetches both in-progress and recently completed jobs from GLE and returns
 * them in a normalised shape.
 */
export async function getStatusAll() {
  // Fetch in-progress jobs (no status filter) and completed jobs in parallel.
  const [inProgressData, completedData] = await Promise.all([
    gleFetch(CONFIG.PATHS.JOBS),
    gleFetch(CONFIG.PATHS.JOBS, {
      method: 'POST',
      body:   JSON.stringify({ status: 'completed' }),
    }),
  ]);

  const allJobs = [
    ...(inProgressData.jobs || []),
    ...(completedData.jobs  || []),
  ];

  // Normalise to a consistent shape for DA's status display.
  return allJobs.map((job) => ({
    id:           job.job_id   || job.id,
    name:         job.job_name || job.name,
    status:       job.status,
    language:     job.target_locale || job.language,
    submissionId: job.submission_id,
    dueDate:      job.due_date,
    // Derive a 0–100 progress % from word counts where available.
    progress: job.status === 'completed'
      ? 100
      : (job.total_word_count && job.translated_word_count)
        ? Math.round((job.translated_word_count / job.total_word_count) * 100)
        : null,
  }));
}
