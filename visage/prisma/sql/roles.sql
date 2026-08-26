-- Roles and grants for Visage.
--
-- Two roles, deliberately separated:
--
--   visage_owner  owns the tables and runs migrations. Never used by the app.
--   visage_app    the application role. Not a table owner, and crucially has
--                 NOSUPERUSER and NOBYPASSRLS, so row-level security applies
--                 to it with no escape hatch.
--
-- Every table is also marked FORCE ROW LEVEL SECURITY (see rls.sql), which
-- makes policies apply to the table owner too. Without FORCE, an owner
-- connection silently sees everything, and a dev pointing DATABASE_URL at the
-- owner role would get a green test suite that proves nothing.

-- Passwords come from the environment; this file is executed with :vars bound.
\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'visage_owner') then
    create role visage_owner login password 'owner_dev_password'
      nosuperuser nocreatedb nocreaterole noinherit;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'visage_app') then
    -- NOBYPASSRLS is the default, stated here because it is the whole point.
    create role visage_app login password 'app_dev_password'
      nosuperuser nocreatedb nocreaterole nobypassrls noinherit;
  end if;

  -- Owns exactly one SECURITY DEFINER function: the firm lookup that login
  -- needs before any tenant context exists (see rls.sql). It can bypass RLS,
  -- so it deliberately cannot log in and holds no table grants beyond the
  -- single SELECT that function requires.
  if not exists (select 1 from pg_roles where rolname = 'visage_directory') then
    create role visage_directory nologin bypassrls;
  end if;
end
$$;

-- visage_owner must be a member of visage_directory to hand it ownership of
-- that function; NOINHERIT keeps the privilege from applying implicitly, so
-- owner still cannot bypass RLS by accident.
grant visage_directory to visage_owner;

-- Nothing is reachable by default.
revoke all on schema public from public;
grant usage on schema public to visage_owner, visage_app;
grant create on schema public to visage_owner;

alter default privileges for role visage_owner in schema public
  grant select, insert, update, delete on tables to visage_app;
alter default privileges for role visage_owner in schema public
  grant usage, select on sequences to visage_app;
