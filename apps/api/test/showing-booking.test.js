import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/lease_bot_test";
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || "test-secret-value";

const {
  routeApi,
  setRouteTestOverrides,
  resetRouteTestOverrides
} = await import("../src/server.js");

function createRequest(method, pathnameWithQuery, body = null) {
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  return {
    method,
    url: pathnameWithQuery,
    headers: {
      host: "localhost",
      "content-type": "application/json"
    },
    async *[Symbol.asyncIterator]() {
      if (payload) {
        yield payload;
      }
    }
  };
}

function createResponseCapture() {
  return {
    statusCode: null,
    body: "",
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(payload = "") {
      this.body = payload;
    }
  };
}

function parseJsonBody(res) {
  return JSON.parse(res.body || "{}");
}

function createAuditCapture() {
  const entries = [];
  return {
    entries,
    recordAuditLog: async (_client, entry) => {
      entries.push(entry);
      return { id: `audit-${entries.length}` };
    }
  };
}

async function callRoute(method, path, { role = "agent", sessionUserId = "22222222-2222-4222-8222-222222222222", body = null, overrides = {} } = {}) {
  resetRouteTestOverrides();
  setRouteTestOverrides({
    getSession: async () => ({ user: { id: sessionUserId, role } }),
    fetchUnitAgentSlotCandidates: async (_client, unitId) => {
      if (!body?.startsAt || !body?.endsAt || !body?.agentId) {
        return [];
      }

      return [
        {
          unitId,
          agentId: body.agentId,
          startsAt: body.startsAt,
          endsAt: body.endsAt
        }
      ];
    },
    ...overrides
  });

  const req = createRequest(method, path, body);
  const res = createResponseCapture();
  await routeApi(req, res, new URL(req.url, "http://localhost"));
  return { res, json: parseJsonBody(res) };
}

test("R14: booking endpoint creates showing appointment and returns created payload", async () => {
  const payload = {
    idempotencyKey: "booking-thread-1",
    platformAccountId: "11111111-1111-4111-8111-111111111111",
    conversationId: "66666666-6666-4666-8666-666666666666",
    unitId: "33333333-3333-4333-8333-333333333333",
    listingId: "44444444-4444-4444-8444-444444444444",
    agentId: "22222222-2222-4222-8222-222222222222",
    startsAt: "2026-03-01T18:00:00.000Z",
    endsAt: "2026-03-01T18:30:00.000Z",
    timezone: "America/Chicago",
    status: "confirmed"
  };

  let bookingArgs = null;
  const auditCapture = createAuditCapture();
  const response = await callRoute("POST", "/api/showing-appointments/book", {
    body: payload,
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      recordAuditLog: auditCapture.recordAuditLog,
      createShowingAppointment: async (_client, bookingPayload) => {
        bookingArgs = bookingPayload;
        return {
          appointment: {
            id: "abababab-abab-4bab-8bab-abababababab",
            idempotencyKey: bookingPayload.idempotencyKey,
            status: "confirmed"
          },
          idempotentReplay: false
        };
      }
    }
  });

  assert.equal(response.res.statusCode, 201);
  assert.equal(response.json.idempotentReplay, false);
  assert.equal(response.json.appointment.status, "confirmed");
  assert.equal(bookingArgs.idempotencyKey, payload.idempotencyKey);
  assert.equal(bookingArgs.unitId, payload.unitId);
  assert.equal(auditCapture.entries.at(-1)?.action, "showing_booking_created");
});

test("R14: booking endpoint is idempotent and replays existing appointment", async () => {
  const auditCapture = createAuditCapture();
  const response = await callRoute("POST", "/api/showing-appointments/book", {
    body: {
      idempotencyKey: "booking-thread-2",
      platformAccountId: "11111111-1111-4111-8111-111111111111",
      unitId: "33333333-3333-4333-8333-333333333333",
      agentId: "22222222-2222-4222-8222-222222222222",
      startsAt: "2026-03-02T18:00:00.000Z",
      endsAt: "2026-03-02T18:30:00.000Z",
      timezone: "America/Chicago"
    },
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      recordAuditLog: auditCapture.recordAuditLog,
      createShowingAppointment: async () => ({
        appointment: {
          id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
          status: "confirmed"
        },
        idempotentReplay: true
      })
    }
  });

  assert.equal(response.res.statusCode, 200);
  assert.equal(response.json.idempotentReplay, true);
  assert.equal(auditCapture.entries.at(-1)?.action, "showing_booking_replayed");
});

test("R10: idempotency replay resolves before slot validation false negatives", async () => {
  let candidateChecks = 0;
  let createCalled = false;
  const auditCapture = createAuditCapture();

  const response = await callRoute("POST", "/api/showing-appointments/book", {
    body: {
      idempotencyKey: "booking-thread-r10-priority",
      platformAccountId: "11111111-1111-4111-8111-111111111111",
      unitId: "33333333-3333-4333-8333-333333333333",
      agentId: "22222222-2222-4222-8222-222222222222",
      startsAt: "2026-03-02T18:00:00.000Z",
      endsAt: "2026-03-02T18:30:00.000Z",
      timezone: "America/Chicago"
    },
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      recordAuditLog: auditCapture.recordAuditLog,
      resolveShowingBookingIdempotency: async () => ({
        appointment: {
          id: "acacacac-acac-4cac-8cac-acacacacacac",
          status: "confirmed"
        },
        idempotentReplay: true
      }),
      fetchUnitAgentSlotCandidates: async () => {
        candidateChecks += 1;
        return [];
      },
      createShowingAppointment: async () => {
        createCalled = true;
        return {
          appointment: { id: "never-called", status: "confirmed" },
          idempotentReplay: false
        };
      }
    }
  });

  assert.equal(response.res.statusCode, 200);
  assert.equal(response.json.idempotentReplay, true);
  assert.equal(candidateChecks, 0);
  assert.equal(createCalled, false);
  assert.equal(auditCapture.entries.at(-1)?.action, "showing_booking_replayed");
});

test("R14: idempotency mismatch returns explicit 409 conflict payload", async () => {
  const auditCapture = createAuditCapture();
  const response = await callRoute("POST", "/api/showing-appointments/book", {
    body: {
      idempotencyKey: "booking-thread-2-mismatch",
      platformAccountId: "11111111-1111-4111-8111-111111111111",
      unitId: "33333333-3333-4333-8333-333333333333",
      agentId: "22222222-2222-4222-8222-222222222222",
      startsAt: "2026-03-02T18:00:00.000Z",
      endsAt: "2026-03-02T18:30:00.000Z",
      timezone: "America/Chicago"
    },
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      recordAuditLog: auditCapture.recordAuditLog,
      createShowingAppointment: async () => ({
        error: "idempotency_payload_mismatch",
        appointment: {
          id: "fefefefe-fefe-4efe-8efe-fefefefefefe",
          idempotencyKey: "booking-thread-2-mismatch"
        }
      })
    }
  });

  assert.equal(response.res.statusCode, 409);
  assert.equal(response.json.error, "idempotency_conflict");
  assert.equal(response.json.adminReviewRequired, true);
  assert.equal(response.json.existingAppointment.id, "fefefefe-fefe-4efe-8efe-fefefefefefe");
  assert.equal(auditCapture.entries.at(-1)?.action, "showing_booking_idempotency_conflict");
});

test("R14: agent cannot book for another agent", async () => {
  let createCalled = false;
  const response = await callRoute("POST", "/api/showing-appointments/book", {
    role: "agent",
    sessionUserId: "22222222-2222-4222-8222-222222222222",
    body: {
      idempotencyKey: "booking-thread-scope",
      platformAccountId: "11111111-1111-4111-8111-111111111111",
      unitId: "33333333-3333-4333-8333-333333333333",
      agentId: "99999999-9999-4999-8999-999999999999",
      startsAt: "2026-03-04T18:00:00.000Z",
      endsAt: "2026-03-04T18:30:00.000Z",
      timezone: "America/Chicago"
    },
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      createShowingAppointment: async () => {
        createCalled = true;
        return { appointment: { id: "never-called" }, idempotentReplay: false };
      }
    }
  });

  assert.equal(response.res.statusCode, 403);
  assert.equal(response.json.error, "forbidden");
  assert.equal(createCalled, false);
});

test("R9: booking enforces assignment+availability slot selection before insert", async () => {
  let createCalled = false;
  let candidateArgs = null;
  const auditCapture = createAuditCapture();

  const response = await callRoute("POST", "/api/showing-appointments/book", {
    body: {
      idempotencyKey: "booking-thread-r9-reject",
      platformAccountId: "11111111-1111-4111-8111-111111111111",
      unitId: "33333333-3333-4333-8333-333333333333",
      agentId: "22222222-2222-4222-8222-222222222222",
      startsAt: "2026-03-06T18:00:00.000Z",
      endsAt: "2026-03-06T18:30:00.000Z",
      timezone: "America/Chicago"
    },
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      recordAuditLog: auditCapture.recordAuditLog,
      fetchUnitAgentSlotCandidates: async (_client, unitId, options) => {
        candidateArgs = { unitId, ...options };
        return [
          {
            unitId,
            agentId: "99999999-9999-4999-8999-999999999999",
            startsAt: "2026-03-06T18:00:00.000Z",
            endsAt: "2026-03-06T18:30:00.000Z"
          }
        ];
      },
      createShowingAppointment: async () => {
        createCalled = true;
        return {
          appointment: {
            id: "never-called",
            status: "confirmed"
          },
          idempotentReplay: false
        };
      }
    }
  });

  assert.equal(response.res.statusCode, 409);
  assert.equal(response.json.error, "slot_unavailable");
  assert.equal(response.json.adminReviewRequired, true);
  assert.equal(response.json.alternatives.length, 1);
  assert.equal(candidateArgs.unitId, "33333333-3333-4333-8333-333333333333");
  assert.equal(candidateArgs.fromDate, "2026-03-06");
  assert.equal(candidateArgs.includePassive, true);
  assert.equal(createCalled, false);
  assert.equal(auditCapture.entries.at(-1)?.action, "showing_booking_slot_unavailable");
});

test("R9/R10: booking accepts candidate that covers requested selection", async () => {
  let createCalled = false;
  let createdPayload = null;

  const response = await callRoute("POST", "/api/showing-appointments/book", {
    body: {
      idempotencyKey: "booking-thread-r9-allow",
      platformAccountId: "11111111-1111-4111-8111-111111111111",
      unitId: "33333333-3333-4333-8333-333333333333",
      agentId: "22222222-2222-4222-8222-222222222222",
      startsAt: "2026-03-07T18:00:00.000Z",
      endsAt: "2026-03-07T18:30:00.000Z",
      timezone: "America/Chicago"
    },
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      fetchUnitAgentSlotCandidates: async (_client, unitId) => [
        {
          unitId,
          agentId: "22222222-2222-4222-8222-222222222222",
          startsAt: "2026-03-07T17:30:00.000Z",
          endsAt: "2026-03-07T18:45:00.000Z"
        }
      ],
      createShowingAppointment: async (_client, payload) => {
        createCalled = true;
        createdPayload = payload;
        return {
          appointment: {
            id: "adadadad-adad-4dad-8dad-adadadadadad",
            idempotencyKey: payload.idempotencyKey,
            status: "confirmed"
          },
          idempotentReplay: false
        };
      }
    }
  });

  assert.equal(response.res.statusCode, 201);
  assert.equal(response.json.idempotentReplay, false);
  assert.equal(response.json.appointment.status, "confirmed");
  assert.equal(createCalled, true);
  assert.equal(createdPayload.idempotencyKey, "booking-thread-r9-allow");
});

test("R16: booking conflict returns alternatives and admin review signal", async () => {
  let candidateArgs = null;
  let candidateCallCount = 0;
  const auditCapture = createAuditCapture();
  const response = await callRoute("POST", "/api/showing-appointments/book", {
    body: {
      idempotencyKey: "booking-thread-3",
      platformAccountId: "11111111-1111-4111-8111-111111111111",
      unitId: "33333333-3333-4333-8333-333333333333",
      agentId: "22222222-2222-4222-8222-222222222222",
      startsAt: "2026-03-03T18:00:00.000Z",
      endsAt: "2026-03-03T18:30:00.000Z",
      timezone: "America/Chicago"
    },
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      recordAuditLog: auditCapture.recordAuditLog,
      createShowingAppointment: async () => {
        const error = new Error("double booking");
        error.code = "23P01";
        throw error;
      },
      fetchUnitAgentSlotCandidates: async (_client, unitId, options) => {
        candidateCallCount += 1;
        candidateArgs = { unitId, ...options };
        if (candidateCallCount === 1) {
          return [
            {
              unitId,
              agentId: "22222222-2222-4222-8222-222222222222",
              startsAt: "2026-03-03T18:00:00.000Z",
              endsAt: "2026-03-03T18:30:00.000Z"
            }
          ];
        }

        return [{ unitId, agentId: "33333333-3333-4333-8333-333333333333" }];
      }
    }
  });

  assert.equal(response.res.statusCode, 409);
  assert.equal(response.json.error, "booking_conflict");
  assert.equal(response.json.adminReviewRequired, true);
  assert.equal(response.json.alternatives.length, 1);
  assert.equal(candidateArgs.fromDate, "2026-03-03");
  assert.equal(candidateArgs.includePassive, true);
  assert.equal(auditCapture.entries.at(-1)?.action, "showing_booking_conflict");
});

test("R8: booking failure emits showing_booking_failed audit action", async () => {
  const auditCapture = createAuditCapture();

  await assert.rejects(
    callRoute("POST", "/api/showing-appointments/book", {
      body: {
        idempotencyKey: "booking-thread-4",
        platformAccountId: "11111111-1111-4111-8111-111111111111",
        unitId: "33333333-3333-4333-8333-333333333333",
        agentId: "22222222-2222-4222-8222-222222222222",
        startsAt: "2026-03-05T18:00:00.000Z",
        endsAt: "2026-03-05T18:30:00.000Z",
        timezone: "America/Chicago"
      },
      overrides: {
        withClient: async (task) => task({ id: "client-1" }),
        recordAuditLog: auditCapture.recordAuditLog,
        createShowingAppointment: async () => {
          throw new Error("database unavailable");
        }
      }
    }),
    /database unavailable/
  );

  assert.equal(auditCapture.entries.at(-1)?.action, "showing_booking_failed");
});

test("R15: showing appointments list validates filters and returns scoped items", async () => {
  const badResponse = await callRoute("GET", "/api/showing-appointments?status=bad");
  assert.equal(badResponse.res.statusCode, 400);

  let filterArgs = null;
  const goodResponse = await callRoute(
    "GET",
    "/api/showing-appointments?status=confirmed&unitId=33333333-3333-4333-8333-333333333333&fromDate=2026-03-01&toDate=2026-03-31&timezone=America%2FChicago",
    {
      overrides: {
        withClient: async (task) => task({ id: "client-1" }),
        fetchShowingAppointments: async (_client, filters) => {
          filterArgs = filters;
          return [
            {
              id: "efefefef-efef-4fef-8fef-efefefefefef",
              status: "confirmed",
              unit: "Atlas Apartments 4B"
            }
          ];
        }
      }
    }
  );

  assert.equal(goodResponse.res.statusCode, 200);
  assert.equal(goodResponse.json.items.length, 1);
  assert.equal(filterArgs.status, "confirmed");
  assert.equal(filterArgs.unitId, "33333333-3333-4333-8333-333333333333");
  assert.equal(filterArgs.fromDate, "2026-03-01");
});

test("R15: agent cannot query showing appointments for another agent", async () => {
  let fetchCalled = false;
  const response = await callRoute(
    "GET",
    "/api/showing-appointments?agentId=99999999-9999-4999-8999-999999999999",
    {
      role: "agent",
      sessionUserId: "22222222-2222-4222-8222-222222222222",
      overrides: {
        withClient: async (task) => task({ id: "client-1" }),
        fetchShowingAppointments: async () => {
          fetchCalled = true;
          return [];
        }
      }
    }
  );

  assert.equal(response.res.statusCode, 403);
  assert.equal(response.json.error, "forbidden");
  assert.equal(fetchCalled, false);
});

test("R15: agent listing endpoint hard-scopes queries to session agent id", async () => {
  let filterArgs = null;
  const response = await callRoute("GET", "/api/showing-appointments", {
    role: "agent",
    sessionUserId: "22222222-2222-4222-8222-222222222222",
    overrides: {
      withClient: async (task) => task({ id: "client-1" }),
      fetchShowingAppointments: async (_client, filters) => {
        filterArgs = filters;
        return [];
      }
    }
  });

  assert.equal(response.res.statusCode, 200);
  assert.equal(filterArgs.agentId, "22222222-2222-4222-8222-222222222222");
});

test("R14/R16: migration declares idempotency and anti-double-booking constraints", async () => {
  const migration = await readFile(new URL("../../../packages/db/migrations/004_showing_appointments.sql", import.meta.url), "utf8");

  assert.match(migration, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(migration, /EXCLUDE USING GIST/);
  assert.match(migration, /status IN \('pending', 'confirmed'\)/);
  assert.match(migration, /idx_showing_appointments_external_booking_ref/);
});

test.after(() => {
  resetRouteTestOverrides();
});
