-- Actions carry the contact whose event caused them (tools are scoped to it when
-- the action runs later, after approval) and the one-line summary shown to the owner.
alter table actions
  add column scope_contact_id uuid references contacts (id),
  add column summary text not null default '';
