-- Run summaries, and one default thread per contact and channel.
alter table agent_runs add column summary text;

-- SMS threads have no provider thread id. Without this, two concurrent first
-- messages from the same contact could each create a thread.
create unique index threads_default_idx on threads (channel, contact_id)
  where external_thread_id is null;
