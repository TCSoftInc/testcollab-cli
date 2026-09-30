/**
 * redact.js
 *
 * The API token travels in the request URL (`?token=`), so a message that
 * repeats that URL must not reach the terminal or a CI log as it is. Node's
 * fetch repeats the whole URL in its error when it cannot parse it, for
 * example an --api-url without https://.
 */

const REDACTED = '***';

/**
 * `text` with every copy of the token replaced by ***. The token is looked for
 * as given and URI-encoded, the two forms the commands put in a URL.
 */
export function redactToken(text, token) {
  const message = String(text);
  if (!token) {
    return message;
  }
  return [String(token), encodeURIComponent(token)].reduce(
    (redacted, secret) => redacted.split(secret).join(REDACTED),
    message
  );
}
