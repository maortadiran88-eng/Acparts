-- =====================================================================
-- מרכז חלקי חילוף: מסד נתונים, הרשאות ואחסון קבצים (Supabase / PostgreSQL)
--
-- הרצה: Supabase Dashboard > SQL Editor > New query > הדבק את כל הקובץ > Run.
-- בטוח להרצה חוזרת: הסקריפט לא מוחק נתונים קיימים.
--
-- לפני ההרצה: אם שינית את כתובות המייל של שני המשתמשים ב-js/config.js,
-- שנה אותן גם בפונקציה app_role() למטה. הן חייבות להיות זהות.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) מי רשאי מה. ההרשאות נאכפות כאן, במסד, ולא רק בממשק.
--    admin = קריאה וכתיבה, viewer = קריאה בלבד, כל השאר = אין גישה.
-- ---------------------------------------------------------------------
create or replace function public.app_role() returns text
language sql stable set search_path = ''
as $$
  select case lower(coalesce(auth.jwt() ->> 'email', ''))
    when 'admin@parts.example.com'  then 'admin'
    when 'viewer@parts.example.com' then 'viewer'
  end
$$;
revoke execute on function public.app_role() from public, anon;
grant  execute on function public.app_role() to authenticated;

-- ---------------------------------------------------------------------
-- 2) טבלאות: מותג > דגם > יחידה (מעבה/מאייד) > חלקים וסכמות
-- ---------------------------------------------------------------------
create table if not exists public.brands (
  id      text primary key,
  name    text   not null check (length(btrim(name)) > 0),
  logo    text   not null default '',
  created bigint not null default 0
);
create unique index if not exists brands_name_uq on public.brands (lower(btrim(name)));

create table if not exists public.series (            -- "דגם" (עם שנתון אופציונלי)
  id         text primary key,
  brand_id   text not null references public.brands(id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  year_label text not null default '',
  notes      text not null default ''
);
create index if not exists series_brand_idx on public.series (brand_id);

create table if not exists public.units (             -- מעבה או מאייד
  id           text primary key,
  brand_id     text not null references public.brands(id) on delete cascade,
  unit_type    text not null check (unit_type in ('evaporator', 'condenser')),
  model        text not null check (length(btrim(model)) > 0),
  product_code text not null default '',
  chart_ref    text not null default '',
  capacity     text not null default '',
  notes        text not null default '',
  series_ids   text[] not null default '{}',          -- יחידה אחת יכולה לשרת כמה דגמים
  has_img      boolean not null default false
);
create index if not exists units_brand_idx on public.units (brand_id);
create unique index if not exists units_model_uq on public.units (brand_id, unit_type, lower(btrim(model)));

create table if not exists public.parts (
  id          text primary key,
  unit_id     text not null references public.units(id) on delete cascade,
  item        text not null default '',               -- מספר פריט בסכמה
  qty         text not null default '',
  name        text not null check (length(btrim(name)) > 0),
  description text not null default '',
  t_sku       text not null default '',               -- מק"ט תדיראן (שדה מרכזי)
  m_sku       text not null default '',               -- מק"ט יצרן (אופציונלי)
  notes       text not null default '',
  has_img     boolean not null default false
);
create index if not exists parts_unit_idx on public.parts (unit_id);
create index if not exists parts_tsku_idx on public.parts (t_sku);
-- מק"ט תדיראן לא יכול להופיע פעמיים באותה יחידה (חלקים ללא מק"ט פטורים)
create unique index if not exists parts_unit_tsku_uq on public.parts (unit_id, t_sku) where t_sku <> '';

create table if not exists public.diagrams (          -- סכמות פיצוץ. הקובץ עצמו נשמר ב-Storage
  id        text primary key,
  unit_id   text not null references public.units(id) on delete cascade,
  name      text not null check (length(btrim(name)) > 0),
  file_name text not null default '',
  mime      text not null default '',
  size      bigint not null default 0,
  hash      text not null default '',
  created   bigint not null default 0,
  source    text not null default ''
);
create index if not exists diagrams_unit_idx on public.diagrams (unit_id);

create table if not exists public.catalog (           -- קטלוג מק"טים כללי (לא משויך לדגם)
  t_sku text primary key,
  descr text not null default '',
  m_sku text not null default ''
);

-- ---------------------------------------------------------------------
-- 3) הרשאות גישה לטבלאות (RLS): רק משתמשים מורשים, וכתיבה רק למנהל
-- ---------------------------------------------------------------------
revoke all on public.brands, public.series, public.units, public.parts, public.diagrams, public.catalog from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete
  on public.brands, public.series, public.units, public.parts, public.diagrams, public.catalog to authenticated;

do $$
declare t text;
begin
  foreach t in array array['brands', 'series', 'units', 'parts', 'diagrams', 'catalog'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read',   t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.app_role()) in (''admin'', ''viewer''))', t || '_read', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.app_role()) = ''admin'')', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select public.app_role()) = ''admin'') with check ((select public.app_role()) = ''admin'')', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.app_role()) = ''admin'')', t || '_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4) אחסון קבצים (סכמות ותמונות): bucket פרטי, עד 50MB, PDF/JPG/PNG בלבד
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('parts-files', 'parts-files', false, 52428800,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists parts_files_read   on storage.objects;
drop policy if exists parts_files_insert on storage.objects;
drop policy if exists parts_files_update on storage.objects;
drop policy if exists parts_files_delete on storage.objects;
create policy parts_files_read   on storage.objects for select to authenticated
  using (bucket_id = 'parts-files' and (select public.app_role()) in ('admin', 'viewer'));
create policy parts_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'parts-files' and (select public.app_role()) = 'admin');
create policy parts_files_update on storage.objects for update to authenticated
  using (bucket_id = 'parts-files' and (select public.app_role()) = 'admin')
  with check (bucket_id = 'parts-files' and (select public.app_role()) = 'admin');
create policy parts_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'parts-files' and (select public.app_role()) = 'admin');

-- ---------------------------------------------------------------------
-- 5) פונקציית "דופק" שמשימת GitHub Actions קוראת לה, כדי שהפרויקט
--    החינמי לא יעצור אחרי תקופה ללא פעילות. לא חושפת שום נתון.
-- ---------------------------------------------------------------------
create or replace function public.ping() returns text
language sql stable set search_path = ''
as $$ select 'ok'::text $$;
grant execute on function public.ping() to anon, authenticated;
