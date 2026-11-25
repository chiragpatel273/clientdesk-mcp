-- v2 phase 1: a read-only staff member for the public "Try the demo" sign-in.
-- Read-only is enforced on the server (the /api router and runTool), not only hidden in the dashboard.
alter table staff add column read_only boolean not null default false;
