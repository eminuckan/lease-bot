const DEFAULT_RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND"
]);

function toError(input) {
  if (input instanceof Error) {
    return input;
  }
  return new Error(String(input));
}

export function isRetryableError(error) {
  const normalized = toError(error);
  const status = normalized.status || normalized.statusCode;

  if (normalized.retryable === true) {
    return true;
  }

  if (typeof status === "number" && (status === 429 || status >= 500)) {
    return true;
  }

  return DEFAULT_RETRYABLE_CODES.has(normalized.code);
}

export function calculateBackoffDelay(attempt, options = {}) {
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs || 250));
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs || 5_000));
  const factor = Math.max(1, Number(options.factor || 2));
  const jitterRatio = Math.min(1, Math.max(0, Number(options.jitterRatio || 0.15)));

  const rawDelay = Math.min(maxDelayMs, baseDelayMs * factor ** Math.max(0, attempt - 1));
  if (!options.jitter) {
    return rawDelay;
  }

  const jitter = rawDelay * jitterRatio * Math.random();
  return Math.round(rawDelay + jitter);
}

export async function withRetry(operation, options = {}) {
  const retries = Math.max(0, Number(options.retries ?? 2));
  const shouldRetry = options.shouldRetry || isRetryableError;
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  let lastError = null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = toError(error);

      const canRetry = attempt <= retries && shouldRetry(lastError, attempt);
      if (!canRetry) {
        throw lastError;
      }

      const delayMs = calculateBackoffDelay(attempt, options);
      if (typeof options.onRetry === "function") {
        options.onRetry({ attempt, delayMs, error: lastError });
      }
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("retry_failed_without_error");
}
