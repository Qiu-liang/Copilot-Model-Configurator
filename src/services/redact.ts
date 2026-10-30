const LONG_TOKEN = /\b(sk-|ak-|xox[baprs]-)[A-Za-z0-9._-]{8,}/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const QUERY_SECRET = /([?&](?:api[-_]?key|apikey|key|token|access_token|auth|sig|signature)=)[^&\s"']+/gi;
const HEADER_SECRET = /(authorization|x-api-key|api-key)(["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi;
const URL_WITH_QUERY = /https?:\/\/[^\s"'<>]+/gi;

/** 移除文本中的密钥、Bearer token 与常见敏感参数。 */
export function redactText(text: string, secrets: readonly (string | undefined)[] = []): string {
  let result = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (value && value.length >= 4) {
      result = result.split(value).join('***');
    }
  }
  return result
    .replace(QUERY_SECRET, '$1***')
    .replace(BEARER, 'Bearer ***')
    .replace(LONG_TOKEN, '$1***')
    .replace(HEADER_SECRET, '$1$2***');
}

/** 日志中不保留完整 URL（可能含查询参数与私有主机名）。 */
export function redactForLog(text: string, secrets: readonly (string | undefined)[] = []): string {
  return redactText(text, secrets).replace(URL_WITH_QUERY, (match) => {
    const withoutQuery = match.split('?')[0]?.split('#')[0] ?? match;
    return withoutQuery.length > 120 ? `${withoutQuery.slice(0, 117)}…` : withoutQuery;
  });
}

/** 仅保留 origin 与 path，供错误提示引用。 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return redactText(value);
  }
}
