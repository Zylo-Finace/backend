-- =============================================================================
--  Phase 4 — WhatsApp: constraints and indexes Prisma cannot express.
-- =============================================================================

-- -----------------------------------------------------------------------------
--  Phone numbers
-- -----------------------------------------------------------------------------

-- Display numbers follow the same E.164 rule as customer numbers, so the two are
-- comparable without normalising at query time.
ALTER TABLE "whatsapp_phone_numbers"
  ADD CONSTRAINT "whatsapp_numbers_display_is_e164"
  CHECK ("displayPhoneNumber" ~ '^\+[1-9][0-9]{6,14}$');

-- At most one default number per tenant. Prisma cannot express a partial unique
-- index, and without it two rows can claim `isDefault` and `resolveNumber()`
-- silently picks whichever the planner returns first — meaning messages go out
-- from an unpredictable number.
CREATE UNIQUE INDEX "whatsapp_numbers_one_default_per_tenant"
  ON "whatsapp_phone_numbers" ("tenantId")
  WHERE "isDefault" = true AND "deletedAt" IS NULL;

-- -----------------------------------------------------------------------------
--  Conversations
-- -----------------------------------------------------------------------------

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_contact_is_e164"
  CHECK ("contactPhoneE164" ~ '^\+[1-9][0-9]{6,14}$');

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_unread_non_negative"
  CHECK ("unreadCount" >= 0);

-- The agent inbox: open threads, most recently active first. Partial because
-- resolved and archived threads are the large majority over time.
CREATE INDEX "conversations_open_inbox_idx"
  ON "conversations" ("tenantId", "lastMessageAt" DESC)
  WHERE "status" IN ('OPEN', 'PENDING') AND "deletedAt" IS NULL;

-- Finds threads still inside the 24-hour service window — the audience that can
-- be reached without a template.
CREATE INDEX "conversations_service_window_idx"
  ON "conversations" ("tenantId", "lastInboundAt" DESC)
  WHERE "lastInboundAt" IS NOT NULL AND "deletedAt" IS NULL;

-- -----------------------------------------------------------------------------
--  Messages
-- -----------------------------------------------------------------------------

-- An inbound message always carries Meta's id; that is what makes redelivery
-- detectable. Outbound messages have none until Meta accepts them.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_inbound_requires_wamid"
  CHECK ("direction" <> 'INBOUND' OR "wamid" IS NOT NULL);

-- A message reported as sent must record when.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_sent_has_timestamp"
  CHECK ("status" NOT IN ('SENT', 'DELIVERED', 'READ') OR "sentAt" IS NOT NULL);

-- The retry/reconciliation sweep looks for outbound messages stuck before Meta
-- accepted them. A tiny slice of the table, so a partial index keeps it cheap
-- as messages grow into the millions.
CREATE INDEX "messages_stuck_outbound_idx"
  ON "messages" ("tenantId", "createdAt")
  WHERE "direction" = 'OUTBOUND' AND "status" = 'PENDING';

-- Failure triage by Meta error code.
CREATE INDEX "messages_failed_idx"
  ON "messages" ("tenantId", "errorCode", "createdAt" DESC)
  WHERE "status" = 'FAILED';

-- -----------------------------------------------------------------------------
--  Templates
-- -----------------------------------------------------------------------------

ALTER TABLE "message_templates"
  ADD CONSTRAINT "templates_variable_count_non_negative"
  CHECK ("bodyVariableCount" >= 0);

-- Meta's naming rule: lowercase alphanumerics and underscores only. Enforced
-- here so a template that could never be approved is rejected at write time.
ALTER TABLE "message_templates"
  ADD CONSTRAINT "templates_name_format"
  CHECK ("name" ~ '^[a-z0-9_]{1,512}$');

-- Send-time lookup only ever considers approved templates.
CREATE INDEX "templates_approved_idx"
  ON "message_templates" ("phoneNumberId", "name", "language")
  WHERE "status" = 'APPROVED' AND "deletedAt" IS NULL;
