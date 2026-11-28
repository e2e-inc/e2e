const REVYL_API_KEY = 'REVYL_API_KEY';
const REVYL_API_URL = 'REVYL_API_URL';

/** What the Revyl plugin's daemon reads: the API key, and the backend URL when the run overrides it. */
export interface RevylCredentials {
  readonly apiKey: string;
  readonly apiUrl?: string | undefined;
}

/** `REVYL_API_KEY`, and `REVYL_API_URL` when set, from the run's environment; throws when the key is unset or blank, or when the URL would carry the key in the clear. */
export function revylCredentials(env: Readonly<Record<string, string | undefined>>): RevylCredentials {
  const apiKey = envValue(env, REVYL_API_KEY);
  if (apiKey === undefined) {
    throw new Error(`${REVYL_API_KEY} is not set; set it to a Revyl API key in the environment \`e2e run\` starts in`);
  }
  const apiUrl = envValue(env, REVYL_API_URL);
  if (apiUrl === undefined) return { apiKey };
  const url = URL.parse(apiUrl);
  if (url === null) throw new Error(`${REVYL_API_URL} is not a URL`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error(`${REVYL_API_URL} must use https; plain http is allowed only to localhost`);
  }
  return { apiKey, apiUrl };
}

/** The credentials as the variables the plugin reads, set on the daemon's environment. */
export function credentialsEnv({ apiKey, apiUrl }: RevylCredentials): Record<string, string> {
  return apiUrl === undefined ? { [REVYL_API_KEY]: apiKey } : { [REVYL_API_KEY]: apiKey, [REVYL_API_URL]: apiUrl };
}

/** A non-empty variable from the run's environment, trimmed, or `undefined`. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}
