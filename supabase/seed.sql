-- Local development seed. Everything here is fictional: 555-01xx phone numbers
-- and example.com addresses are reserved for that purpose. Dates are fixed so
-- tests and evals are reproducible.

-- Owner login (magic link in Phase 4). No password is set.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new)
values (
  '00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'owner@example.com', '', '2025-10-01T00:00:00Z',
  '{"provider":"email","providers":["email"]}', '{}', '2025-10-01T00:00:00Z', '2025-10-01T00:00:00Z',
  '', '', '', '');

insert into app_owner (user_id, phone, email, verified_at) values
  ('00000000-0000-4000-8000-000000000001', '+14085550100', 'owner@example.com', '2025-10-01T00:00:00Z');

insert into contacts (id, kind, display_name, first_name, phone, email, preferred_channel, preferred_language, is_allowlisted) values
  ('00000000-0000-4000-8000-000000000010', 'owner',  'Sam Owner',              'Sam',   '+14085550100', 'owner@example.com',           'sms', 'en', true),
  ('00000000-0000-4000-8000-000000000011', 'tenant', 'Maria Alvarez',          'Maria', '+14085550111', 'maria.alvarez@example.com',   'sms', 'es', true),
  ('00000000-0000-4000-8000-000000000021', 'vendor', 'Bayline Plumbing',       'Dev',   '+14085550121', 'dispatch@bayline.example.com', 'sms', 'en', true),
  ('00000000-0000-4000-8000-000000000022', 'vendor', 'Okafor Electric',        'Chidi', '+14085550122', 'chidi@okafor.example.com',     'sms', 'en', true),
  ('00000000-0000-4000-8000-000000000023', 'vendor', 'Valley Heating & Repair', 'Linh', '+14085550123', 'linh@valleyhr.example.com',    'email', 'en', true);

insert into properties (id, nickname, address, county, jurisdiction_flags) values
  ('00000000-0000-4000-8000-000000000100', 'Maple House', '100 Example Maple Ct, San Jose, CA 95100',
   'Santa Clara', '{"state":"CA","local_rent_ordinance":"verify"}');

insert into tenants (id, contact_id, property_id, status) values
  ('00000000-0000-4000-8000-000000000200', '00000000-0000-4000-8000-000000000011',
   '00000000-0000-4000-8000-000000000100', 'active');

insert into leases (id, property_id, start_date, end_date, monthly_rent_cents, due_day, grace_days, deposit_cents, status) values
  ('00000000-0000-4000-8000-000000000300', '00000000-0000-4000-8000-000000000100',
   '2025-11-01', '2026-10-31', 320000, 1, 5, 320000, 'active');

insert into lease_tenants (lease_id, tenant_id) values
  ('00000000-0000-4000-8000-000000000300', '00000000-0000-4000-8000-000000000200');

insert into vendors (id, contact_id, trades, preapproved, auto_spend_limit_cents, rating, notes) values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000021', '{plumbing}',          true,  25000, 5, 'Fast on weekdays. Texts a photo when done.'),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000022', '{electrical}',        true,  0,     4, 'Licensed. Always quote first.'),
  ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000023', '{hvac,general}',      false, 0,     4, 'Prefers email. Two day lead time.');

-- Ledger: deposit, then 12 months (2025-11 .. 2026-10) of rent charges and payments.
insert into ledger_entries (lease_id, kind, amount_cents, period, effective_date, method, note) values
  ('00000000-0000-4000-8000-000000000300', 'deposit', 320000, '2025-11', '2025-10-25', 'check', 'Security deposit');

insert into ledger_entries (lease_id, kind, amount_cents, period, effective_date, created_by)
select '00000000-0000-4000-8000-000000000300', 'rent_charge', 320000, to_char(m, 'YYYY-MM'), m::date, 'system'
from generate_series('2025-11-01'::date, '2026-10-01'::date, interval '1 month') as m;

-- On time every month except March 2026, which was paid on the 9th (grace ended on the 6th).
insert into ledger_entries (lease_id, kind, amount_cents, period, effective_date, method)
select '00000000-0000-4000-8000-000000000300', 'payment', -320000, to_char(m, 'YYYY-MM'),
       (m + ((extract(month from m)::int % 3) * interval '1 day'))::date, 'zelle'
from generate_series('2025-11-01'::date, '2026-10-01'::date, interval '1 month') as m
where to_char(m, 'YYYY-MM') <> '2026-03';

insert into ledger_entries (lease_id, kind, amount_cents, period, effective_date, method, note, created_by) values
  ('00000000-0000-4000-8000-000000000300', 'late_fee', 7500,    '2026-03', '2026-03-07', null,    'Flat late fee after grace period', 'system'),
  ('00000000-0000-4000-8000-000000000300', 'payment',  -327500, '2026-03', '2026-03-09', 'zelle', 'Rent plus late fee',               'owner');

-- Four past maintenance requests, all closed.
insert into maintenance_requests (id, property_id, tenant_id, title, category, urgency, urgency_reason, status, vendor_id, quote_cents, scheduled_start, created_at, closed_at) values
  ('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000200',
   'Kitchen faucet dripping', 'plumbing', 'routine', 'Slow drip, no water damage',
   'closed', '00000000-0000-4000-8000-000000000401', 18500, '2025-12-11T18:00:00Z', '2025-12-08T17:20:00Z', '2025-12-12T01:00:00Z'),
  ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000200',
   'Furnace not turning on', 'hvac', 'urgent', 'No heat in January',
   'closed', '00000000-0000-4000-8000-000000000403', 42000, '2026-01-15T17:00:00Z', '2026-01-14T04:05:00Z', '2026-01-16T00:30:00Z'),
  ('00000000-0000-4000-8000-000000000503', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000200',
   'Bathroom outlet sparking', 'electrical', 'emergency', 'Sparks reported from an outlet',
   'closed', '00000000-0000-4000-8000-000000000402', 26000, '2026-04-22T16:00:00Z', '2026-04-22T02:40:00Z', '2026-04-22T22:00:00Z'),
  ('00000000-0000-4000-8000-000000000504', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000200',
   'Cabinet door hinge loose', 'general', 'cosmetic', 'Cosmetic, door still closes',
   'closed', '00000000-0000-4000-8000-000000000403', 9500, '2026-07-20T17:00:00Z', '2026-07-13T19:15:00Z', '2026-07-21T00:00:00Z');

insert into request_history (request_id, from_status, to_status, actor, at)
select r.id, s.from_status, s.to_status, s.actor,
       r.created_at + (r.closed_at - r.created_at) * s.frac
from maintenance_requests r
cross join (values
  (null,               'new',              'system', 0.0),
  ('new',              'vendor_requested', 'owner',  0.1),
  ('vendor_requested', 'quoted',           'owner',  0.3),
  ('quoted',           'scheduled',        'owner',  0.4),
  ('scheduled',        'done',             'owner',  0.9),
  ('done',             'closed',           'owner',  1.0)
) as s (from_status, to_status, actor, frac);

insert into expenses (property_id, request_id, vendor_id, category, amount_cents, incurred_on)
select property_id, id, vendor_id, category, quote_cents, closed_at::date from maintenance_requests;

insert into memory_facts (scope, subject_id, category, fact, status, owner_edited) values
  ('tenant',   '00000000-0000-4000-8000-000000000200', 'contact_pref', 'Prefers text messages in Spanish. Works nights, so mornings are best for visits.', 'active', true),
  ('property', '00000000-0000-4000-8000-000000000100', 'access_notes', 'Side gate sticks. Water shutoff is on the left side of the house by the hose bib.', 'active', true);
