-- CreateTable
CREATE TABLE "zylo_ramp_contacts" (
    "id" SERIAL NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "alias" VARCHAR(40) NOT NULL,
    "address" VARCHAR(72) NOT NULL,
    "label" VARCHAR(80),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zylo_ramp_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zylo_ramp_contacts_phone_idx" ON "zylo_ramp_contacts"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "zylo_ramp_contacts_phone_alias_key" ON "zylo_ramp_contacts"("phone", "alias");
