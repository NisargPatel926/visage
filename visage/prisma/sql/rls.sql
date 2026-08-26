-- Row-level security policies for Visage.
--
-- This file is the primary tenant-isolation control. Application-layer
-- filtering is a convenience on top of it, not the thing standing between one
-- firm's clients and another's.
--
-- Request context is set per transaction by withTenant() in
-- src/server/db/tenant.ts:
--
--   select set_config('app.firm_id', $1, true);   -- true = transaction-scoped
--   select set_config('app.user_id', $2, true);
--   select set_config('app.role',    $3, true);
--
-- Because these are LOCAL, a connection returned to the pool carries nothing.
-- Because the helpers below return NULL when unset, an unscoped query matches
-- no rows: the failure mode is an empty result set, never a leak.
--
-- Honest limit: RLS defends against a missing WHERE clause, not against SQL
-- injection that can issue its own set_config. Injection defense is Prisma's
-- parameterized queries plus the repository boundary.

\set ON_ERROR_STOP on

create schema if not exists app;
grant usage on schema app to visage_app, visage_owner;
-- CREATE, not just USAGE: ALTER FUNCTION ... OWNER TO requires the incoming
-- owner to hold CREATE on the schema the function lives in.
grant usage, create on schema app to visage_directory;

-- ------------------------------------------------------------- helpers ----

create or replace function app.current_firm_id() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.firm_id', true), '')::uuid $$;

create or replace function app.current_user_id() returns uuid
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function app.current_actor_role() returns text
  language sql stable parallel safe
  as $$ select nullif(current_setting('app.role', true), '') $$;

create or replace function app.is_staff() returns boolean
  language sql stable parallel safe
  as $$ select coalesce(app.current_actor_role() in ('OWNER','ATTORNEY','PARALEGAL'), false) $$;

-- Staff reach every case in their firm; a client reaches only cases they are a
-- member of. Reads CaseMember (not Case), so policies on Case can call this
-- without recursing into themselves.
create or replace function app.can_access_case(p_case_id uuid) returns boolean
  language sql stable parallel safe
  as $$
    select app.is_staff() or exists (
      select 1 from "CaseMember" m
      where m."caseId" = p_case_id
        and m."userId" = app.current_user_id()
    )
  $$;

create or replace function app.can_access_document(p_doc_id uuid) returns boolean
  language sql stable parallel safe
  as $$
    select app.is_staff() or exists (
      select 1 from "Document" d
      where d.id = p_doc_id and app.can_access_case(d."caseId")
    )
  $$;

-- ------------------------------------------------------- enable + force ----

-- FORCE matters as much as ENABLE: without it the table owner bypasses every
-- policy below, and any test run as the owner would pass vacuously.
do $$
declare t text; p text;
begin
  foreach t in array array[
    'Firm','User','Session','Invitation','Case','CaseMember','Intake',
    'Requirement','Document','DocumentPage','Extraction','ExtractedField',
    'ProfileField','ProfileFieldHistory','FormInstance','Thread','Message',
    'Annotation','Package','AuditEvent'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    -- Drop every existing policy, not just one known name: this file gets
    -- re-applied after each `prisma db push`, and a renamed policy left behind
    -- would silently widen access.
    for p in select polname from pg_policy where polrelid = format('%I', t)::regclass loop
      execute format('drop policy %I on %I', p, t);
    end loop;
  end loop;
end
$$;

-- --------------------------------------------------- case-scoped tables ----

-- Uniform shape: right firm, and the actor can reach the case. Written as a
-- loop because eighteen hand-copied policies is eighteen chances to typo the
-- one that matters.
do $$
declare t text;
begin
  foreach t in array array[
    'Intake','Requirement','Document','ProfileField','ProfileFieldHistory',
    'FormInstance','Thread','Package'
  ] loop
    execute format($f$
      create policy tenant_isolation on %I
        for all
        using      ("firmId" = app.current_firm_id() and app.can_access_case("caseId"))
        with check ("firmId" = app.current_firm_id() and app.can_access_case("caseId"))
    $f$, t);
  end loop;
end
$$;

-- ------------------------------------------------------- firm-scoped ----

create policy tenant_isolation on "Firm"
  for all
  using      (id = app.current_firm_id())
  with check (id = app.current_firm_id());

-- Staff see everyone in the firm; a client sees only themselves.
create policy tenant_isolation on "User"
  for all
  using      ("firmId" = app.current_firm_id() and (app.is_staff() or id = app.current_user_id()))
  with check ("firmId" = app.current_firm_id());

create policy tenant_isolation on "Session"
  for all
  using      ("firmId" = app.current_firm_id() and (app.is_staff() or "userId" = app.current_user_id()))
  with check ("firmId" = app.current_firm_id() and "userId" = app.current_user_id());

-- Invitations are a staff instrument; clients never enumerate them.
create policy tenant_isolation on "Invitation"
  for all
  using      ("firmId" = app.current_firm_id() and app.is_staff())
  with check ("firmId" = app.current_firm_id() and app.is_staff());

-- ------------------------------------------------------------ case ----

create policy tenant_isolation on "Case"
  for all
  using      ("firmId" = app.current_firm_id() and app.can_access_case(id))
  with check ("firmId" = app.current_firm_id());

-- Cannot call can_access_case here: that helper reads this table.
create policy tenant_isolation on "CaseMember"
  for all
  using      ("firmId" = app.current_firm_id() and (app.is_staff() or "userId" = app.current_user_id()))
  with check ("firmId" = app.current_firm_id() and app.is_staff());

-- ------------------------------------------------ document-scoped ----

create policy tenant_isolation on "DocumentPage"
  for all
  using      ("firmId" = app.current_firm_id() and app.can_access_document("documentId"))
  with check ("firmId" = app.current_firm_id() and app.can_access_document("documentId"));

create policy tenant_isolation on "Extraction"
  for all
  using      ("firmId" = app.current_firm_id() and app.can_access_document("documentId"))
  with check ("firmId" = app.current_firm_id() and app.can_access_document("documentId"));

create policy tenant_isolation on "Annotation"
  for all
  using      ("firmId" = app.current_firm_id() and app.can_access_document("documentId"))
  with check ("firmId" = app.current_firm_id() and app.can_access_document("documentId"));

create policy tenant_isolation on "ExtractedField"
  for all
  using ("firmId" = app.current_firm_id() and exists (
    select 1 from "Extraction" e
    where e.id = "ExtractedField"."extractionId" and app.can_access_document(e."documentId")))
  with check ("firmId" = app.current_firm_id() and exists (
    select 1 from "Extraction" e
    where e.id = "ExtractedField"."extractionId" and app.can_access_document(e."documentId")));

create policy tenant_isolation on "Message"
  for all
  using ("firmId" = app.current_firm_id() and exists (
    select 1 from "Thread" t
    where t.id = "Message"."threadId" and app.can_access_case(t."caseId")))
  with check ("firmId" = app.current_firm_id() and exists (
    select 1 from "Thread" t
    where t.id = "Message"."threadId" and app.can_access_case(t."caseId")));

-- ----------------------------------------------------------- audit ----

-- Split deliberately, because writing and reading the audit log are different
-- privileges. A client uploading a document must generate an audit row; a
-- client must never be able to read the log. A single FOR ALL policy cannot
-- express that: PostgreSQL applies the SELECT policy to any INSERT carrying a
-- RETURNING clause, so a staff-only USING clause silently blocks clients from
-- writing at all. (Prisma's create() always uses RETURNING — see audit() in
-- src/server/audit/log.ts, which issues a bare INSERT for this reason.)
create policy audit_append on "AuditEvent"
  for insert
  with check ("firmId" = app.current_firm_id());

create policy audit_read on "AuditEvent"
  for select
  using ("firmId" = app.current_firm_id() and app.is_staff());

-- No UPDATE or DELETE policy exists, so those commands match no rows even
-- before the revoked grants below are considered.

-- ----------------------------------------------------------- grants ----

grant select, insert, update, delete on all tables in schema public to visage_app;

-- The audit log is the exception. Revoking UPDATE and DELETE is what makes
-- "append-only" a property of the database rather than a convention.
revoke update, delete on "AuditEvent" from visage_app;
revoke update, delete on "ProfileFieldHistory" from visage_app;

-- --------------------------------------------- login bootstrap escape ----

-- Login is a chicken-and-egg problem: we must resolve a firm before we have a
-- firm context to scope the query with. Rather than weaken the Firm policy
-- (which would let an unscoped connection enumerate every firm row, kmsKeyId
-- included), we cut one narrow, auditable hole.
--
-- visage_directory (created in roles.sql) exists only to own the function
-- below. It can bypass RLS, so it is never a login role and holds no table
-- grants — the only thing reachable through it is three non-sensitive columns
-- for one slug.
grant usage on schema public to visage_directory;

-- Exactly what the SECURITY DEFINER auth functions below need, and nothing
-- more. visage_directory can bypass RLS, so every grant here widens what those
-- functions could reach; it holds no privilege on any case, document, or
-- message table.
grant select on "Firm" to visage_directory;
grant select on "User" to visage_directory;
grant select, insert, update on "Session" to visage_directory;

-- Created *as* visage_directory via SET ROLE, rather than created by
-- visage_owner and handed over afterwards. Ownership transfer worked once and
-- then made this file non-idempotent: on the second run visage_owner no longer
-- owns the function, so CREATE OR REPLACE fails with "must be owner of
-- function". Since `prisma db push` drops policies and this file must be
-- re-applied after every schema change, re-runnability is not optional.
set role visage_directory;

create or replace function app.resolve_firm(p_slug text)
  returns table (id uuid, name text, slug text)
  language sql stable
  security definer
  set search_path = public, pg_temp
  as $$ select f.id, f.name, f.slug from "Firm" f where f.slug = p_slug $$;

-- Issued while visage_directory owns the function, so they actually apply;
-- a grant from a non-owner is only a WARNING and would silently leave EXECUTE
-- on PUBLIC.
revoke all on function app.resolve_firm(text) from public;
grant execute on function app.resolve_firm(text) to visage_app;

reset role;

-- ------------------------------------------------ authentication surface ----

-- Authentication is inherently pre-tenant: we must find a user before we know
-- which tenant to scope to, and we must read a session before we know who is
-- asking. RLS correctly refuses all of that, so these four functions are the
-- complete, enumerable set of privileged reads the auth path needs.
--
-- Each is narrow: exact-match lookups returning at most one row, no filtering
-- the caller controls beyond the key itself. They are owned by
-- visage_directory (BYPASSRLS, NOLOGIN) and executable only by visage_app.
-- Everything after login goes through withTenant like any other query.
set role visage_directory;

-- Exact (firm, email). Returns the password hash because that is what
-- authenticating means; login reports one generic failure for every outcome,
-- so this is not a membership oracle.
create or replace function app.auth_find_user(p_firm_id uuid, p_email text)
  returns table (id uuid, firm_id uuid, role "Role", status "UserStatus",
                 password_hash text, mfa_secret text)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select u.id, u."firmId", u.role, u.status, u."passwordHash", u."mfaSecret"
    from "User" u
    where u."firmId" = p_firm_id and lower(u.email) = lower(p_email)
  $$;

create or replace function app.auth_create_session(
  p_firm_id uuid, p_user_id uuid, p_token_hash text,
  p_expires timestamptz, p_ip text, p_user_agent text)
  returns void
  language sql volatile security definer set search_path = public, pg_temp
  as $$
    insert into "Session" (id, "firmId", "userId", "tokenHash", "expiresAt",
                           "createdAt", "lastSeen", ip, "userAgent")
    values (gen_random_uuid(), p_firm_id, p_user_id, p_token_hash, p_expires,
            now(), now(), p_ip, p_user_agent)
  $$;

-- Lookup by token hash only. The token is 32 bytes of entropy, so possession
-- is the authorisation; there is nothing to enumerate.
create or replace function app.auth_find_session(p_token_hash text)
  returns table (user_id uuid, firm_id uuid, role "Role", status "UserStatus",
                 expires_at timestamptz, last_seen timestamptz, revoked_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select u.id, u."firmId", u.role, u.status, s."expiresAt", s."lastSeen", s."revokedAt"
    from "Session" s join "User" u on u.id = s."userId"
    where s."tokenHash" = p_token_hash
  $$;

create or replace function app.auth_touch_session(p_token_hash text)
  returns void
  language sql volatile security definer set search_path = public, pg_temp
  as $$ update "Session" set "lastSeen" = now() where "tokenHash" = p_token_hash $$;

create or replace function app.auth_revoke_session(p_token_hash text)
  returns void
  language sql volatile security definer set search_path = public, pg_temp
  as $$ update "Session" set "revokedAt" = now() where "tokenHash" = p_token_hash $$;

revoke all on function app.auth_find_user(uuid, text) from public;
revoke all on function app.auth_create_session(uuid, uuid, text, timestamptz, text, text) from public;
revoke all on function app.auth_find_session(text) from public;
revoke all on function app.auth_touch_session(text) from public;
revoke all on function app.auth_revoke_session(text) from public;

grant execute on function app.auth_find_user(uuid, text) to visage_app;
grant execute on function app.auth_create_session(uuid, uuid, text, timestamptz, text, text) to visage_app;
grant execute on function app.auth_find_session(text) to visage_app;
grant execute on function app.auth_touch_session(text) to visage_app;
grant execute on function app.auth_revoke_session(text) to visage_app;

reset role;
