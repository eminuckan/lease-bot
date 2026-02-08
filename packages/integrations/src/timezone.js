class LocalTimeValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "LocalTimeValidationError";
    this.code = "NONEXISTENT_LOCAL_TIME";
    this.details = details;
  }
}

function readDateTimeParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}

function formatInTimezone(instant, timezone) {
  const value = instant instanceof Date ? instant : new Date(instant);
  const parts = readDateTimeParts(value, timezone);
  const two = (n) => String(n).padStart(2, "0");
  return `${parts.year}-${two(parts.month)}-${two(parts.day)}T${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)}`;
}

function resolveZonedCandidates(dateString, timeString, timezone) {
  const [year, month, day] = dateString.split("-").map(Number);
  const [hour, minute, secondRaw] = timeString.split(":").map(Number);
  const second = Number.isFinite(secondRaw) ? secondRaw : 0;

  const target = { year, month, day, hour, minute, second };
  const instants = [];
  const seen = new Set();

  for (let offsetMinutes = -12 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const utcMillis =
      Date.UTC(year, month - 1, day, hour, minute, second, 0) - (offsetMinutes * 60 * 1000);
    const zoned = readDateTimeParts(new Date(utcMillis), timezone);
    const matched =
      zoned.year === target.year
      && zoned.month === target.month
      && zoned.day === target.day
      && zoned.hour === target.hour
      && zoned.minute === target.minute
      && zoned.second === target.second;

    if (matched && !seen.has(utcMillis)) {
      seen.add(utcMillis);
      instants.push(utcMillis);
    }
  }

  instants.sort((a, b) => a - b);
  return instants;
}

function zonedTimeToUtc(dateString, timeString, timezone, { disambiguation = "earlier" } = {}) {
  const candidates = resolveZonedCandidates(dateString, timeString, timezone);

  if (candidates.length === 0) {
    throw new LocalTimeValidationError("Local time does not exist in the provided timezone", {
      date: dateString,
      time: timeString,
      timezone
    });
  }

  if (candidates.length === 1 || disambiguation === "earlier") {
    return new Date(candidates[0]);
  }

  return new Date(candidates[candidates.length - 1]);
}

export {
  LocalTimeValidationError,
  formatInTimezone,
  zonedTimeToUtc
};

