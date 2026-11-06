-- migrate:up

-- Provider usage comes in fractional units (Retell reports cost per product in US cents,
-- such as 8.25). numeric is exact decimal, not a float; our own money stays integer pence.
ALTER TABLE call_costs ALTER COLUMN units TYPE numeric(14, 4);

-- migrate:down

ALTER TABLE call_costs ALTER COLUMN units TYPE bigint USING round(units);
