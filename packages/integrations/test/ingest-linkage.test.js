import assert from "node:assert/strict";
import test from "node:test";

import { createPostgresQueueAdapter } from "../src/index.js";

function createMockClient({ linkageRow = null, conversationListingId = null, messageInserted = true } = {}) {
  const state = {
    conversationInserts: [],
    linkageQueries: [],
    auditInserts: []
  };

  return {
    state,
    async query(sql, params = []) {
      if (sql.includes("FROM \"PlatformAccounts\"") && sql.includes("WHERE is_active = TRUE")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "acc-1",
              platform: "spareroom",
              account_external_id: "ext-acc-1",
              credentials: {}
            }
          ]
        };
      }

      if (sql.includes("FROM \"Listings\" l") && sql.includes("ORDER BY score DESC")) {
        state.linkageQueries.push(params);
        if (!linkageRow) {
          return { rowCount: 0, rows: [] };
        }
        return {
          rowCount: 1,
          rows: [
            {
              listing_id: linkageRow.listingId,
              unit_id: linkageRow.unitId,
              strategy: linkageRow.strategy || "listing_external_id"
            }
          ]
        };
      }

      if (sql.includes("INSERT INTO \"Conversations\"")) {
        state.conversationInserts.push(params);
        return {
          rowCount: 1,
          rows: [
            {
              id: "conv-1",
              listing_id: conversationListingId || params[1] || null
            }
          ]
        };
      }

      if (sql.includes("INSERT INTO \"Messages\"")) {
        return {
          rowCount: messageInserted ? 1 : 0,
          rows: []
        };
      }

      if (sql.includes("INSERT INTO \"AuditLogs\"")) {
        state.auditInserts.push(params);
        return {
          rowCount: 1,
          rows: []
        };
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    }
  };
}

test("R5/R10 ingest linkage: resolved listing context is persisted and audited", async () => {
  const client = createMockClient({
    linkageRow: {
      listingId: "11111111-1111-4111-8111-111111111111",
      unitId: "22222222-2222-4222-8222-222222222222",
      strategy: "listing_external_id"
    }
  });

  const adapter = createPostgresQueueAdapter(client, {
    connectorRegistry: {
      async ingestMessagesForAccount() {
        return [
          {
            externalThreadId: "thread-1",
            externalMessageId: "msg-1",
            channel: "in_app",
            body: "Is this still available?",
            sentAt: "2026-02-07T10:00:00.000Z",
            metadata: {
              listingExternalId: "listing-ext-1"
            }
          }
        ];
      }
    }
  });

  const result = await adapter.ingestInboundMessages();

  assert.equal(result.scanned, 1);
  assert.equal(result.ingested, 1);
  assert.equal(client.state.conversationInserts.length, 1);
  assert.equal(client.state.conversationInserts[0][1], "11111111-1111-4111-8111-111111111111");

  assert.equal(client.state.auditInserts.length, 1);
  assert.equal(client.state.auditInserts[0][1], "ingest_conversation_linkage_resolved");
  const auditDetails = JSON.parse(client.state.auditInserts[0][2]);
  assert.equal(auditDetails.linkage.resolved, true);
  assert.equal(auditDetails.linkage.strategy, "listing_external_id");
  assert.equal(auditDetails.linkage.matchedListingId, "11111111-1111-4111-8111-111111111111");
  assert.equal(auditDetails.linkage.matchedUnitId, "22222222-2222-4222-8222-222222222222");
});

test("R5 ingest linkage: unresolved context is audited without forcing linkage", async () => {
  const client = createMockClient({ linkageRow: null });

  const adapter = createPostgresQueueAdapter(client, {
    connectorRegistry: {
      async ingestMessagesForAccount() {
        return [
          {
            externalThreadId: "thread-2",
            externalMessageId: "msg-2",
            channel: "in_app",
            body: "Hello",
            sentAt: "2026-02-07T10:01:00.000Z",
            metadata: {}
          }
        ];
      }
    }
  });

  const result = await adapter.ingestInboundMessages();
  assert.equal(result.scanned, 1);
  assert.equal(result.ingested, 1);
  assert.equal(client.state.conversationInserts[0][1], null);

  assert.equal(client.state.auditInserts.length, 1);
  assert.equal(client.state.auditInserts[0][1], "ingest_conversation_linkage_unresolved");
  const auditDetails = JSON.parse(client.state.auditInserts[0][2]);
  assert.equal(auditDetails.linkage.resolved, false);
  assert.equal(auditDetails.linkage.strategy, "none");
  assert.equal(auditDetails.linkage.appliedListingId, null);
});
