const REQUIRED_RPA_PLATFORMS = ["spareroom", "roomies", "leasebreak", "renthop", "furnishedfinder"];

const PLATFORM_ADAPTER_DEFINITIONS = {
  spareroom: {
    platform: "spareroom",
    baseUrl: "https://www.spareroom.com",
    // US site uses /roommate/* routes (login: /roommate/logon.pl, messages: /roommate/mythreads*.pl).
    // Note: thread URL shape may differ across legacy/beta message UIs, so this is best-effort and
    // should be overridden per-account if needed.
    inboxPath: "/roommate/mythreads_beta.pl",
    threadPath: (threadId) => `/roommate/mythreads_beta.pl?thread_id=${encodeURIComponent(threadId)}`,
    authRequiredUrlPatterns: ["/roommate/logon.pl"],
    authRequiredText: [
      // SpareRoom uses this copy on protected pages when the session is missing/expired.
      "to view this content you will need to either"
    ],
    selectors: {
      challenge: ["iframe[src*='challenge']", "#challenge-form", "[data-cy='bot-check']"],
      captcha: ["iframe[title*='captcha']", "[data-sitekey]", "#g-recaptcha-response"],
      // Inbox rows are anchors with data attributes for the most recent message in the thread.
      // Note: SpareRoom sorts the list by most-recent inbound message (even if the latest message is outbound),
      // so we must ingest both thread_in and thread_out rows and preserve the page order.
      messageItems: ["a.thread_item[data-thread-id][data-message-id]"],
      messageBody: ["span.snippet"],
      messageSentAt: ["i.threadDate"],
      leadName: ["span.name"],
      threadLabel: ["span.ad-title"],
      threadMessageItems: ["li.message[id^='msg_']"],
      threadMessageBody: ["dd.message_body"],
      threadMessageSentAt: ["dd.message_date"],
      composer: "textarea[name='message']",
      submit: "button[type='submit'][name='btnSubmit']"
    }
  },
  roomies: {
    platform: "roomies",
    baseUrl: "https://www.roomies.com",
    inboxPath: "/inbox",
    threadPath: (threadId) => `/inbox/${encodeURIComponent(threadId)}`,
    authRequiredUrlPatterns: ["/login", "/register", "/users/sign_in"],
    authRequiredText: [
      "please login",
      "log in to continue",
      "sign in to continue",
      "to view this content you need to log in"
    ],
    listingSync: {
      paths: ["/my-listings", "/listings", "/rooms/manage", "/rooms"],
      pageParam: "page",
      maxPages: 25,
      managePageMarkers: ["my listings", "your listings", "manage listings", "edit listing", "deactivate", "my room"]
    },
    selectors: {
      challenge: ["#challenge-stage", "[data-testid='challenge-page']"],
      captcha: ["iframe[src*='recaptcha']", "[name='cf-turnstile-response']"],
      messageItems: ["[data-thread-id][data-message-id]", "[data-thread-id]", "[data-testid='message-row']", "a[href*='/messages/']", "a[href*='/inbox/']"],
      messageBody: ["[data-testid='message-preview']", ".message-snippet", "[class*='preview' i]", "[class*='snippet' i]"],
      messageSentAt: ["time[datetime]", "[data-testid='message-time']", ".message-time", "[class*='time' i]", "[class*='date' i]"],
      leadName: ["[data-testid='message-lead-name']", "[class*='lead-name' i]", "[class*='name' i]", "h3", "h4", "strong"],
      threadLabel: ["[data-testid='message-thread-label']", "[class*='listing' i]", "[class*='room' i]", "[class*='title' i]"],
      threadMessageItems: ["[data-message-id]", "[data-testid='thread-message']", "[class*='message-bubble' i]", "[class*='message' i]"],
      threadMessageBody: ["[data-testid='message-body']", ".message-body", "[class*='message-content' i]", "p"],
      threadMessageSentAt: ["time[datetime]", "[data-testid='message-time']", ".message-time", "[class*='time' i]", "[class*='date' i]"],
      composer: ["textarea[name='body']", "textarea[name='message']", "textarea[data-testid='message-input']", "textarea"],
      submit: ["button[data-testid='send-message']", "button[type='submit']"],
      listingItems: ["[data-listing-id]", "[data-room-id]", "[data-testid='listing-card']"],
      listingTitle: ["[data-testid='listing-title']", ".listing-title", "[class*='listing-title' i]", "[class*='room-title' i]", "h2", "h3"],
      listingLocation: ["[data-testid='listing-location']", ".listing-location", "[class*='location' i]"],
      listingPrice: ["[data-testid='listing-price']", ".listing-price", "[class*='price' i]"],
      listingStatus: ["[data-testid='listing-status']", ".listing-status", "[class*='status' i]", ".badge"],
      listingLink: ["a[href*='/rooms/']", "a[href*='/listings/']"]
    }
  },
  leasebreak: {
    platform: "leasebreak",
    baseUrl: "https://www.leasebreak.com",
    inboxPath: "/messages",
    threadPath: (threadId) => `/messages/${encodeURIComponent(threadId)}`,
    authRequiredUrlPatterns: ["/users/sign_in", "/login", "/session/new"],
    authRequiredText: [
      "log in to continue",
      "sign in to continue",
      "please sign in",
      "you need to sign in",
      "you need to log in"
    ],
    listingSync: {
      paths: ["/my/listings", "/my-listings", "/listings/my", "/account/listings", "/messages"],
      pageParam: "page",
      maxPages: 25,
      managePageMarkers: ["my listings", "manage listings", "active listings", "inactive listings", "deactivate"]
    },
    selectors: {
      challenge: ["#cf-challenge-running", ".challenge-form", "#challenge-stage", "[data-testid='challenge-page']"],
      captcha: ["iframe[src*='hcaptcha']", "iframe[src*='recaptcha']", "[name='cf-turnstile-response']", "[data-sitekey]"],
      messageItems: ["[data-thread-id][data-message-id]", "[data-thread-id]", ".message-row", "a[href*='/messages/']"],
      messageBody: [".message-preview", "[data-testid='message-body']", "[class*='preview' i]", "[class*='snippet' i]"],
      messageSentAt: ["time[datetime]", ".message-time", "[class*='time' i]", "[class*='date' i]"],
      leadName: ["[data-testid='message-lead-name']", ".message-name", "[class*='name' i]", "h3", "h4", "strong"],
      threadLabel: ["[data-testid='message-thread-label']", ".listing-title", "[class*='listing' i]", "[class*='title' i]"],
      threadMessageItems: ["[data-message-id]", "[data-testid='thread-message']", ".message", "[class*='message-bubble' i]"],
      threadMessageBody: ["[data-testid='message-body']", ".message-body", "[class*='message-content' i]", "p"],
      threadMessageSentAt: ["time[datetime]", ".message-time", "[class*='time' i]", "[class*='date' i]"],
      composer: ["textarea[name='message']", "textarea[name='body']", "textarea[data-testid='message-input']", "textarea"],
      submit: ["button[type='submit']", "button[data-testid='send-button']", "button[data-testid='thread-send']"],
      listingItems: ["[data-listing-id]", "[data-testid='listing-card']", "article[class*='listing' i]", "li[class*='listing' i]"],
      listingTitle: ["[data-testid='listing-title']", ".listing-title", "[class*='listing-title' i]", "h2", "h3"],
      listingLocation: ["[data-testid='listing-location']", ".listing-location", "[class*='location' i]"],
      listingPrice: ["[data-testid='listing-price']", ".listing-price", "[class*='price' i]"],
      listingStatus: ["[data-testid='listing-status']", ".listing-status", "[class*='status' i]", ".badge"],
      listingLink: ["a[href*='/listing/']", "a[href*='/for-rent/']", "a[href*='/listings/']"]
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
