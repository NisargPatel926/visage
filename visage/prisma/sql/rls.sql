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
declare t text;
begin
  foreach t in array array[
    'Firm','User','Session','Invitation','Case','CaseMember','Intake',
    'Requirement','Document','DocumentPage','Extraction','ExtractedField',
    'ProfileField','ProfileFieldHistory','FormInstance','Thread','Message',
    'Annotation','Package','AuditEvent'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
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

-- Readable by staff only, and append-only: the INSERT/SELECT grant below is
-- the enforcement, since a policy cannot stop an UPDATE the role may perform.
create policy tenant_isolation on "AuditEvent"
  for all
  using      ("firmId" = app.current_firm_id() and app.is_staff())
  with check ("firmId" = app.current_firm_id());

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
grant select on "Firm" to visage_directory;

create or replace function app.resolve_firm(p_slug text)
  returns table (id uuid, name text, slug text)
  language sql stable
  security definer
  set search_path = public, pg_temp
  as $$ select f.id, f.name, f.slug from "Firm" f where f.slug = p_slug $$;

-- Order matters: grants must be issued while visage_owner still owns the
-- function. After the ownership transfer below it no longer can, and psql
-- reports that only as a WARNING — leaving EXECUTE on PUBLIC, which is the
-- opposite of what this block is for.
revoke all on function app.resolve_firm(text) from public;
grant execute on function app.resolve_firm(text) to visage_app;

alter function app.resolve_firm(text) owner to visage_directory;
