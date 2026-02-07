const REQUIRED_RPA_PLATFORMS = ["spareroom", "roomies", "leasebreak", "renthop", "furnishedfinder"];

const PLATFORM_ADAPTER_DEFINITIONS = {
  spareroom: {
    platform: "spareroom",
    baseUrl: "https://www.spareroom.com",
    // US site uses /roommate/* routes (login: /roommate/logon.pl, messages: /roommate/mythreads*.pl).
    // Note: thread URL shape may differ across legacy/beta message UIs, so this is best-effort and
    // should be overridden per-account if needed.
    inboxPath: "/roommate/mythreads.pl",
    threadPath: (threadId) => `/roommate/messages.pl?thread_id=${encodeURIComponent(threadId)}`,
    selectors: {
      challenge: ["iframe[src*='challenge']", "#challenge-form", "[data-cy='bot-check']"],
      captcha: ["iframe[title*='captcha']", "[data-sitekey]", "#g-recaptcha-response"],
      messageItems: ["[data-thread-id][data-message-id]", ".message-card"],
      messageBody: ["[data-role='message-body']", ".message__body"],
      composer: "textarea[name='message']",
      submit: "button[type='submit']"
    }
  },
  roomies: {
    platform: "roomies",
    baseUrl: "https://www.roomies.com",
    inboxPath: "/messages",
    threadPath: (threadId) => `/messages/${encodeURIComponent(threadId)}`,
    selectors: {
      challenge: ["#challenge-stage", "[data-testid='challenge-page']"],
      captcha: ["iframe[src*='recaptcha']", "[name='cf-turnstile-response']"],
      messageItems: ["[data-thread-id][data-message-id]", "[data-testid='message-row']"],
      messageBody: ["[data-testid='message-preview']", ".message-snippet"],
      composer: "textarea[name='body']",
      submit: "button[data-testid='send-message']"
    }
  },
  leasebreak: {
    platform: "leasebreak",
    baseUrl: "https://www.leasebreak.com",
    inboxPath: "/messages",
    threadPath: (threadId) => `/messages/${encodeURIComponent(threadId)}`,
    selectors: {
      challenge: ["#cf-challenge-running", ".challenge-form"],
      captcha: ["iframe[src*='hcaptcha']", "[data-testid='captcha-container']"],
      messageItems: ["[data-thread-id][data-message-id]", ".message-row"],
      messageBody: [".message-preview", "[data-testid='message-body']"],
      composer: "textarea[name='message']",
      submit: "button[type='submit']"
    }
  },
  renthop: {
    platform: "renthop",
    baseUrl: "https://www.renthop.com",
    inboxPath: "/account/messages",
    threadPath: (threadId) => `/account/messages/${encodeURIComponent(threadId)}`,
    selectors: {
      challenge: ["#challenge-form", "[data-testid='challenge-screen']"],
      captcha: ["iframe[src*='recaptcha']", "[name='cf-turnstile-response']"],
      messageItems: ["[data-thread-id][data-message-id]", "[data-testid='message-item']"],
      messageBody: ["[data-testid='message-snippet']", ".message-text"],
      composer: "textarea[name='message']",
      submit: "button[data-testid='send-button']"
    }
  },
  furnishedfinder: {
    platform: "furnishedfinder",
    baseUrl: "https://www.furnishedfinder.com",
    inboxPath: "/messaging/inbox",
    threadPath: (threadId) => `/messaging/thread/${encodeURIComponent(threadId)}`,
    selectors: {
      challenge: ["#challenge-stage", "[data-testid='bot-challenge']"],
      captcha: ["iframe[src*='captcha']", "[data-testid='captcha-frame']"],
      messageItems: ["[data-thread-id][data-message-id]", ".thread-row"],
      messageBody: ["[data-testid='thread-preview']", ".thread-preview"],
      composer: "textarea[name='messageBody']",
      submit: "button[data-testid='thread-send']"
    }
  }
};

function createAbsoluteUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

function buildAdapter(definition) {
  return {
    ...definition,
    inboxUrl: createAbsoluteUrl(definition.baseUrl, definition.inboxPath),
    threadUrl(threadId) {
      return createAbsoluteUrl(definition.baseUrl, definition.threadPath(threadId));
    }
  };
}

export function createPlatformAdapterRegistry(overrides = {}) {
  const registry = new Map();
  for (const platform of REQUIRED_RPA_PLATFORMS) {
    const baseDefinition = PLATFORM_ADAPTER_DEFINITIONS[platform];
    const mergedDefinition = {
      ...baseDefinition,
      ...(overrides[platform] || {}),
      selectors: {
        ...(baseDefinition.selectors || {}),
        ...((overrides[platform] || {}).selectors || {})
      }
    };
    registry.set(platform, buildAdapter(mergedDefinition));
  }

  return {
    supportedPlatforms: [...REQUIRED_RPA_PLATFORMS],
    get(platform) {
      return registry.get(platform) || null;
    }
  };
}

export function isRequiredRpaPlatform(platform) {
  return REQUIRED_RPA_PLATFORMS.includes(platform);
}

export { REQUIRED_RPA_PLATFORMS };
