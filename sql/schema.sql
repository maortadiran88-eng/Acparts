-- =====================================================================
-- מרכז חלקי חילוף: מסד נתונים עם כניסה בסיסמה בלבד (בלי Supabase Authentication)
--
-- הרצה: Supabase Dashboard > SQL Editor > New query > הדבק את כל הקובץ > Run.
-- אחר כך הרץ את sql/set-passwords.sql כדי לקבוע את שתי הסיסמאות.
-- בטוח להרצה חוזרת: הסקריפט לא מוחק נתונים קיימים ולא משנה סיסמאות.
--
-- איך זה עובד:
--  * כל הטבלאות נמצאות בסכמה פרטית (sp) שה-API של Supabase לא חושף בכלל.
--  * הדרך היחידה לגשת אליהן היא פונקציות sp_* בסכמה public.
--  * כל פונקציה בודקת אסימון (token) שהתקבל בכניסה עם סיסמה נכונה, וכותבת רק למנהל.
--  * הסיסמאות נשמרות מגובבות (hash) בטבלה שאי אפשר לקרוא מבחוץ.
--  * ניחוש סיסמאות מוגבל: אחרי 8 ניסיונות כושלים נחסמת הכתובת ל-15 דקות.
-- המפתח הציבורי (publishable) לבדו לא נותן שום גישה לנתונים בלי סיסמה.
-- =====================================================================

create schema if not exists sp;
revoke all on schema sp from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1) נתונים: מותג > דגם > יחידה (מעבה/מאייד) > חלקים וסכמות
-- ---------------------------------------------------------------------
create table if not exists sp.brands (
  id      text primary key,
  name    text   not null check (length(btrim(name)) > 0),
  logo    text   not null default '',
  created bigint not null default 0
);
create unique index if not exists brands_name_uq on sp.brands (lower(btrim(name)));

create table if not exists sp.series (                -- "דגם" (עם שנתון אופציונלי)
  id         text primary key,
  brand_id   text not null references sp.brands(id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  year_label text not null default '',
  notes      text not null default ''
);
create index if not exists series_brand_idx on sp.series (brand_id);

create table if not exists sp.units (                 -- מעבה או מאייד
  id           text primary key,
  brand_id     text not null references sp.brands(id) on delete cascade,
  unit_type    text not null check (unit_type in ('evaporator', 'condenser')),
  model        text not null check (length(btrim(model)) > 0),
  product_code text not null default '',
  chart_ref    text not null default '',
  capacity     text not null default '',
  notes        text not null default '',
  series_ids   text[] not null default '{}',          -- יחידה אחת יכולה לשרת כמה דגמים
  has_img      boolean not null default false
);
create index if not exists units_brand_idx on sp.units (brand_id);
create unique index if not exists units_model_uq on sp.units (brand_id, unit_type, lower(btrim(model)));

create table if not exists sp.parts (
  id          text primary key,
  unit_id     text not null references sp.units(id) on delete cascade,
  item        text not null default '',               -- מספר פריט בסכמה
  qty         text not null default '',
  name        text not null check (length(btrim(name)) > 0),
  description text not null default '',
  t_sku       text not null default '',               -- מק"ט תדיראן (שדה מרכזי)
  m_sku       text not null default '',               -- מק"ט יצרן (אופציונלי)
  notes       text not null default '',
  has_img     boolean not null default false
);
create index if not exists parts_unit_idx on sp.parts (unit_id);
create index if not exists parts_tsku_idx on sp.parts (t_sku);
-- מק"ט תדיראן לא יכול להופיע פעמיים באותה יחידה (חלקים ללא מק"ט פטורים)
create unique index if not exists parts_unit_tsku_uq on sp.parts (unit_id, t_sku) where t_sku <> '';

create table if not exists sp.diagrams (              -- סכמות פיצוץ. הקובץ עצמו בטבלת files
  id        text primary key,
  unit_id   text not null references sp.units(id) on delete cascade,
  name      text not null check (length(btrim(name)) > 0),
  file_name text not null default '',
  mime      text not null default '',
  size      bigint not null default 0,
  hash      text not null default '',
  created   bigint not null default 0,
  source    text not null default ''
);
create index if not exists diagrams_unit_idx on sp.diagrams (unit_id);

create table if not exists sp.catalog (               -- קטלוג מק"טים כללי (לא משויך לדגם)
  t_sku text primary key,
  descr text not null default '',
  m_sku text not null default ''
);

-- קבצים (סכמות ותמונות). נשמרים במסד, כדי שגם אותם אפשר יהיה להגן בסיסמה.
create table if not exists sp.files (
  key     text primary key,
  mime    text   not null,
  size    bigint not null,
  data    bytea  not null,
  created timestamptz not null default now()
);
create table if not exists sp.file_parts (            -- העלאה בחלקים. נמחק אוטומטית אחרי ההרכבה
  key     text not null,
  idx     int  not null,
  b64     text not null,
  created timestamptz not null default now(),
  primary key (key, idx)
);

-- ---------------------------------------------------------------------
-- 2) סיסמאות, כניסות, והגבלת ניחושים
-- ---------------------------------------------------------------------
create table if not exists sp.app_config (
  role    text primary key check (role in ('admin', 'viewer')),
  salt    text not null,
  pw_hash text not null,
  updated timestamptz not null default now()
);
create table if not exists sp.app_sessions (
  token_hash text primary key,
  role       text not null check (role in ('admin', 'viewer')),
  expires    timestamptz not null
);
create table if not exists sp.login_attempts (
  k            text primary key,
  fails        int not null default 0,
  first_fail   timestamptz not null default now(),
  locked_until timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['brands','series','units','parts','diagrams','catalog','files','file_parts','app_config','app_sessions','login_attempts'] loop
    execute format('alter table sp.%I enable row level security', t);
    execute format('revoke all on sp.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- גיבוב סיסמה: SHA-256 עם מלח וחזרות (מקשה על ניחוש אם מישהו אי פעם יראה את הגיבוב)
create or replace function sp.hash_pw(pw text, salt text) returns text
language plpgsql immutable set search_path = ''
as $$
declare h bytea := convert_to(salt || ':' || pw, 'UTF8'); p bytea := convert_to(pw, 'UTF8'); i int;
begin
  for i in 1..100000 loop h := sha256(h || p); end loop;
  return encode(h, 'hex');
end $$;

-- קביעת הסיסמאות. אפשר להריץ רק מתוך ה-SQL Editor (לא נגיש ל-API).
create or replace function sp.set_passwords(admin_pw text, viewer_pw text) returns text
language plpgsql set search_path = ''
as $$
declare s text;
begin
  if admin_pw is null or length(admin_pw) < 10 then raise exception 'סיסמת המנהל חייבת להכיל לפחות 10 תווים'; end if;
  if viewer_pw is null or length(viewer_pw) < 4 then raise exception 'סיסמת הצפייה חייבת להכיל לפחות 4 תווים'; end if;
  if admin_pw = viewer_pw then raise exception 'שתי הסיסמאות חייבות להיות שונות'; end if;
  s := replace(gen_random_uuid()::text, '-', '');
  insert into sp.app_config (role, salt, pw_hash) values ('admin', s, sp.hash_pw(admin_pw, s))
    on conflict (role) do update set salt = excluded.salt, pw_hash = excluded.pw_hash, updated = now();
  s := replace(gen_random_uuid()::text, '-', '');
  insert into sp.app_config (role, salt, pw_hash) values ('viewer', s, sp.hash_pw(viewer_pw, s))
    on conflict (role) do update set salt = excluded.salt, pw_hash = excluded.pw_hash, updated = now();
  delete from sp.app_sessions;                          -- כולם נכנסים מחדש עם הסיסמה החדשה
  delete from sp.login_attempts;
  return 'הסיסמאות עודכנו. כל המשתמשים המחוברים יתבקשו להיכנס מחדש.';
end $$;
revoke all on function sp.hash_pw(text, text), sp.set_passwords(text, text) from public, anon, authenticated;

-- מי מחובר: מחזיר 'admin' / 'viewer' / null
create or replace function sp.role_of(t text) returns text
language sql stable security definer set search_path = ''
as $$
  select s.role from sp.app_sessions s
  where s.token_hash = encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') and s.expires > now()
$$;
revoke all on function sp.role_of(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3) ה-API (הדרך היחידה לגשת לנתונים). נקראות כ-RPC מהאתר.
-- ---------------------------------------------------------------------
create or replace function public.sp_login(pw text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  hdr jsonb; ip_key text; a sp.login_attempts; r record; got text := null; tok text; ttl interval; gfails int;
begin
  begin hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then hdr := null; end;
  ip_key := coalesce(nullif(btrim(hdr ->> 'cf-connecting-ip'), ''), nullif(btrim(hdr ->> 'x-real-ip'), ''),
                nullif(btrim(split_part(coalesce(hdr ->> 'x-forwarded-for', ''), ',', 1)), ''), 'unknown');
  delete from sp.app_sessions where expires < now();
  delete from sp.login_attempts where coalesce(locked_until, first_fail + interval '15 minutes') < now() - interval '1 hour';
  if not exists (select 1 from sp.app_config where role = 'admin') then return jsonb_build_object('ok', false, 'reason', 'setup'); end if;

  select * into a from sp.login_attempts where login_attempts.k = ip_key;
  if found and a.locked_until is not null and a.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'wait', ceil(extract(epoch from (a.locked_until - now())))::int);
  end if;
  select coalesce(sum(fails), 0) into gfails from sp.login_attempts where first_fail > now() - interval '1 hour';
  if gfails >= 400 then return jsonb_build_object('ok', false, 'reason', 'locked', 'wait', 300); end if;   -- הגנה מפני ניחוש מבוזר

  if pw is not null and length(pw) between 1 and 200 then
    for r in select role, salt, pw_hash from sp.app_config order by role loop
      if sp.hash_pw(pw, r.salt) = r.pw_hash then got := r.role; exit; end if;
    end loop;
  end if;

  if got is null then
    insert into sp.login_attempts (k, fails, first_fail) values (ip_key, 1, now())
      on conflict (k) do update set
        fails = case when sp.login_attempts.first_fail < now() - interval '15 minutes' then 1 else sp.login_attempts.fails + 1 end,
        first_fail = case when sp.login_attempts.first_fail < now() - interval '15 minutes' then now() else sp.login_attempts.first_fail end,
        locked_until = null;
    update sp.login_attempts set locked_until = now() + interval '15 minutes' where login_attempts.k = ip_key and fails >= 8;
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'reason', 'wrong');
  end if;

  delete from sp.login_attempts where login_attempts.k = ip_key;
  tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  ttl := case got when 'admin' then interval '12 hours' else interval '30 days' end;
  insert into sp.app_sessions (token_hash, role, expires) values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), got, now() + ttl);
  return jsonb_build_object('ok', true, 'role', got, 'token', tok, 'expires_in', extract(epoch from ttl)::int);
end $$;

create or replace function public.sp_logout(t text) returns jsonb
language sql security definer set search_path = ''
as $$
  with d as (delete from sp.app_sessions where token_hash = encode(sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex') returning 1)
  select jsonb_build_object('ok', true)
$$;

create or replace function public.sp_ping() returns text
language sql stable set search_path = ''
as $$ select 'ok'::text $$;

create or replace function public.sp_read(t text, tbl text, off int, lim int) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare pk text; total bigint; rows jsonb;
begin
  if sp.role_of(t) is null then raise exception 'sp_auth'; end if;
  if tbl not in ('brands', 'series', 'units', 'parts', 'diagrams', 'catalog') then raise exception 'sp_bad_table'; end if;
  pk := case tbl when 'catalog' then 't_sku' else 'id' end;
  execute format('select count(*) from sp.%I', tbl) into total;
  execute format('select coalesce(jsonb_agg(to_jsonb(x) order by x.%I), ''[]''::jsonb) from (select * from sp.%I order by %I offset %s limit %s) x',
                 pk, tbl, pk, greatest(coalesce(off, 0), 0), least(greatest(coalesce(lim, 1000), 1), 1000)) into rows;
  return jsonb_build_object('total', total, 'rows', rows);
end $$;

create or replace function public.sp_upsert(t text, tbl text, rows jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare pk text; cols text; sets text; n int;
begin
  if sp.role_of(t) is null then raise exception 'sp_auth'; end if;
  if sp.role_of(t) <> 'admin' then raise exception 'sp_denied'; end if;
  if tbl not in ('brands', 'series', 'units', 'parts', 'diagrams', 'catalog') then raise exception 'sp_bad_table'; end if;
  if jsonb_typeof(rows) <> 'array' then raise exception 'sp_bad_input'; end if;
  n := jsonb_array_length(rows);
  if n = 0 then return jsonb_build_object('ok', true, 'n', 0); end if;
  if n > 2000 then raise exception 'sp_too_many'; end if;
  pk := case tbl when 'catalog' then 't_sku' else 'id' end;
  select string_agg(quote_ident(a.attname), ',' order by a.attnum),
         string_agg(format('%1$I = excluded.%1$I', a.attname), ',' order by a.attnum) filter (where a.attname <> pk)
    into cols, sets
    from pg_catalog.pg_attribute a
   where a.attrelid = format('sp.%I', tbl)::regclass and a.attnum > 0 and not a.attisdropped
     and a.attname in (select jsonb_object_keys(rows -> 0));
  if cols is null or position(quote_ident(pk) in cols) = 0 then raise exception 'sp_bad_input'; end if;
  execute format('insert into sp.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::sp.%1$I, $1) on conflict (%3$I) do %4$s',
                 tbl, cols, pk, case when sets is null then 'nothing' else 'update set ' || sets end) using rows;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

create or replace function public.sp_delete(t text, tbl text, ids jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare pk text; n int;
begin
  if sp.role_of(t) is null then raise exception 'sp_auth'; end if;
  if sp.role_of(t) <> 'admin' then raise exception 'sp_denied'; end if;
  if tbl not in ('brands', 'series', 'units', 'parts', 'diagrams', 'catalog') then raise exception 'sp_bad_table'; end if;
  if jsonb_typeof(ids) <> 'array' then raise exception 'sp_bad_input'; end if;
  pk := case tbl when 'catalog' then 't_sku' else 'id' end;
  execute format('delete from sp.%I where %I = any(array(select jsonb_array_elements_text($1)))', tbl, pk) using ids;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;

-- קבצים: העלאה והורדה בחלקים של 384KB, כדי לא לחרוג ממגבלות גודל בקשה
create or replace function public.sp_file_put(t text, key text, mime text, idx int, total int, b64 text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare d bytea; head bytea; ok boolean; cnt int;
begin
  if sp.role_of(t) is null then raise exception 'sp_auth'; end if;
  if sp.role_of(t) <> 'admin' then raise exception 'sp_denied'; end if;
  if key !~ '^(dg|ui|pi)/[A-Za-z0-9_-]{1,64}$' or mime not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')
     or total < 1 or total > 60 or idx < 0 or idx >= total or length(b64) > 600000 then raise exception 'sp_bad_file'; end if;
  delete from sp.file_parts where created < now() - interval '1 day';
  if idx = 0 then delete from sp.file_parts where file_parts.key = sp_file_put.key; end if;
  insert into sp.file_parts (key, idx, b64) values (key, idx, b64)
    on conflict on constraint file_parts_pkey do update set b64 = excluded.b64, created = now();
  if idx < total - 1 then return jsonb_build_object('ok', true, 'done', false); end if;

  select count(*) into cnt from sp.file_parts where file_parts.key = sp_file_put.key and file_parts.idx < total;
  if cnt <> total then raise exception 'sp_bad_file'; end if;
  select decode(string_agg(p.b64, '' order by p.idx), 'base64') into d from sp.file_parts p where p.key = sp_file_put.key and p.idx < total;
  delete from sp.file_parts where file_parts.key = sp_file_put.key;
  head := substring(d from 1 for 12);
  ok := case mime
    when 'application/pdf' then substring(head from 1 for 4) = '\x25504446'::bytea
    when 'image/png'       then substring(head from 1 for 4) = '\x89504e47'::bytea
    when 'image/jpeg'      then substring(head from 1 for 3) = '\xffd8ff'::bytea
    when 'image/webp'      then substring(head from 1 for 4) = '\x52494646'::bytea and substring(head from 9 for 4) = '\x57454250'::bytea
  end;
  if not coalesce(ok, false) then raise exception 'sp_bad_file'; end if;      -- התוכן חייב להתאים לסוג הקובץ
  if length(d) > 22 * 1048576 then raise exception 'sp_too_big'; end if;
  insert into sp.files (key, mime, size, data) values (key, mime, length(d), d)
    on conflict on constraint files_pkey do update set mime = excluded.mime, size = excluded.size, data = excluded.data, created = now();
  return jsonb_build_object('ok', true, 'done', true, 'size', length(d));
end $$;

create or replace function public.sp_file_get(t text, key text, idx int) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare f sp.files; n constant int := 393216;
begin
  if sp.role_of(t) is null then raise exception 'sp_auth'; end if;
  select * into f from sp.files where files.key = sp_file_get.key;
  if not found then return null; end if;
  return jsonb_build_object('mime', f.mime, 'size', f.size, 'total', greatest(ceil(f.size::numeric / n)::int, 1), 'idx', idx,
                            'b64', encode(substring(f.data from coalesce(idx, 0) * n + 1 for n), 'base64'));
end $$;

create or replace function public.sp_file_del(t text, key text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if sp.role_of(t) is null then raise exception 'sp_auth'; end if;
  if sp.role_of(t) <> 'admin' then raise exception 'sp_denied'; end if;
  delete from sp.files where files.key = sp_file_del.key;
  delete from sp.file_parts where file_parts.key = sp_file_del.key;
  return jsonb_build_object('ok', true);
end $$;

-- הרשאות הרצה: ה-API הציבורי (anon) יכול לקרוא רק לפונקציות sp_* שלמעלה
revoke all on function public.sp_login(text), public.sp_logout(text), public.sp_ping(), public.sp_read(text, text, int, int),
  public.sp_upsert(text, text, jsonb), public.sp_delete(text, text, jsonb), public.sp_file_put(text, text, text, int, int, text),
  public.sp_file_get(text, text, int), public.sp_file_del(text, text) from public;
grant execute on function public.sp_login(text), public.sp_logout(text), public.sp_ping(), public.sp_read(text, text, int, int),
  public.sp_upsert(text, text, jsonb), public.sp_delete(text, text, jsonb), public.sp_file_put(text, text, text, int, int, text),
  public.sp_file_get(text, text, int), public.sp_file_del(text, text) to anon, authenticated;
