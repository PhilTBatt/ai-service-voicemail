-- migrate:up

-- VAT invoices (core/invoice.ts), for once Brockersby is VAT registered. HMRC wants each to
-- carry the customer's address and a sequential number (VAT Notice 700/21 section 4.1).
--
-- The business's address for its invoices: what it gives on its Account page. Personal data for
-- a sole trader, so deleting a business's data clears it (an invoice already issued keeps its
-- copy, as HMRC requires copies of invoices kept).
ALTER TABLE tenants ADD COLUMN billing_address text
  CHECK (char_length(billing_address) BETWEEN 1 AND 300);

-- A month charged with VAT: its invoice number, and the invoice exactly as issued (who from, who
-- to, each line, the totals), so a later change of address or price never rewrites it.
ALTER TABLE billing_charges ADD COLUMN invoice_number integer UNIQUE CHECK (invoice_number > 0);
ALTER TABLE billing_charges ADD COLUMN invoice jsonb;

-- The last number used. One row, one series: each number is taken in the same transaction as the
-- charge it's for, so a charge that rolls back gives its number back and there are no gaps. Not
-- tenant data, so no row-level security, like system_settings.
CREATE TABLE invoice_numbers (
  series text PRIMARY KEY,
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);
INSERT INTO invoice_numbers (series) VALUES ('vat');

GRANT SELECT, UPDATE ON invoice_numbers TO callmate_app;
GRANT SELECT ON invoice_numbers TO callmate_admin;

-- migrate:down

DROP TABLE invoice_numbers;
ALTER TABLE billing_charges DROP COLUMN invoice;
ALTER TABLE billing_charges DROP COLUMN invoice_number;
ALTER TABLE tenants DROP COLUMN billing_address;
